/**
 * The lot engine: the ONE place parcels are formed and consumed.
 *
 * There used to be six — the tax report, fifo.ts, the executor's avgCost
 * fallback, reconcile-now's avgCost fallback, orphan recovery's avgCost price
 * and the tax optimizer's "earliest buy" lot builder — and they disagreed.
 * The report matched a sell against buys made AFTER it; fifo.ts ignored
 * commission and let a legacy sell of 10 shares wipe a 100-share lot; the
 * report double-listed commission; backfilled sells had no basis at all.
 *
 * The rules, all of them:
 *
 *   - Trades are replayed in time order. A sell only consumes parcels bought
 *     at or before it; a sell with nothing to consume is reported as
 *     UNMATCHED, never matched to a later buy.
 *   - Every sell consumes parcels oldest first (FIFO — set IBKR's lot matching
 *     to FIFO too, so the statements agree).
 *   - A parcel's cost base is (price × qty + buy brokerage). Sell brokerage is
 *     an incidental cost of the disposal, so it reduces the capital proceeds
 *     (s110-35). Both are apportioned per share across partial parcels.
 *   - AUD: each side converts at its own trade's rate, `audPerUsd`, which is
 *     IBKR's per-trade fxRate (one source, the one on the broker statements).
 *     Where a trade has none, an optional fallback (RBA F11) is used and
 *     flagged; failing that the AUD figures are null and the gap is reported.
 *   - The CGT event date is the exchange trade date; the discount test is
 *     au-dates.isDiscountEligible.
 *
 * Stored per-record basis fields (`costBasisPrice`, `matchedLots`,
 * `realisedPnlUsd`) are IGNORED: they were written by the older engines and
 * are only as good as those. Everything is recomputed from the fills.
 *
 * Pure: no I/O, no clock.
 */
import type { TradeRecord } from '../state/store.js';
import { financialYearOf, isDiscountEligible, discountEligibleFrom, tradeDateOf, type IsoDate } from './au-dates.js';

export type FxFallback = (date: IsoDate) => number | undefined;

export interface LotEngineOptions {
  /** AUD per USD for a date, for trades without IBKR's rate (e.g. RBA F11). */
  fxFallback?: FxFallback;
}

/** An open (or partly consumed) parcel. */
export interface Lot {
  symbol: string;
  buyTimestamp: string;
  buyDate: IsoDate;
  /** Shares still held from this parcel. */
  qty: number;
  /** Shares originally bought in this parcel. */
  qtyBought: number;
  priceUsd: number;
  /** Buy brokerage per share, USD. */
  commissionPerShareUsd: number;
  /** Cost base per share in USD, brokerage included. */
  costPerShareUsd: number;
  audPerUsd: number | null;
  /** Cost base per share in AUD, brokerage included; null without a rate. */
  costPerShareAud: number | null;
  discountEligibleFrom: IsoDate;
  record: TradeRecord;
  flags: string[];
}

/** One parcel's share of one sale — the unit a CGT schedule lists. */
export interface Disposal {
  symbol: string;
  qty: number;
  buyDate: IsoDate;
  buyTimestamp: string;
  sellDate: IsoDate;
  sellTimestamp: string;
  financialYear: string;
  discountEligible: boolean;
  costUsd: number;
  proceedsUsd: number;
  gainUsd: number;
  costAud: number | null;
  proceedsAud: number | null;
  gainAud: number | null;
  buyRecord: TradeRecord;
  sellRecord: TradeRecord;
  /** e.g. commission-estimated, price-inferred, fx-fallback, fx-missing. */
  flags: string[];
}

export interface UnmatchedSale {
  symbol: string;
  qty: number;
  sellDate: IsoDate | undefined;
  record: TradeRecord;
}

export interface LotEngineResult {
  disposals: Disposal[];
  /** Open parcels per symbol, oldest first. */
  openLots: Map<string, Lot[]>;
  /** Sold shares with no earlier parcel to consume — the ledger is missing history. */
  unmatched: UnmatchedSale[];
  /** Human-readable problems worth a look before relying on the figures. */
  issues: string[];
}

interface Normalised {
  i: number;
  t: TradeRecord;
  ms: number;
  date: IsoDate | undefined;
  priceUsd: number;
  commissionUsd: number;
  audPerUsd: number | null;
  flags: string[];
}

function unitPrice(t: TradeRecord): number {
  if (t.fillPrice != null && Number.isFinite(t.fillPrice) && t.fillPrice > 0) return t.fillPrice;
  return t.qty > 0 ? t.estimatedValue / t.qty : 0;
}

function normalise(t: TradeRecord, i: number, opts: LotEngineOptions): Normalised {
  const flags: string[] = [];
  const date = tradeDateOf(t);
  let ms = Date.parse(t.timestamp);
  if (!Number.isFinite(ms)) ms = date ? Date.parse(`${date}T20:00:00Z`) : Number.POSITIVE_INFINITY;

  if (!(t.fillPrice != null && t.fillPrice > 0)) flags.push('price-estimated');
  if (t.priceInferred) flags.push('price-inferred');

  let audPerUsd: number | null = t.audPerUsd != null && t.audPerUsd > 0 ? t.audPerUsd : null;
  if (audPerUsd != null && t.fxSource === 'rba') flags.push('fx-fallback');
  if (audPerUsd == null && date && opts.fxFallback) {
    const r = opts.fxFallback(date);
    if (r != null && r > 0) {
      audPerUsd = r;
      flags.push('fx-fallback');
    }
  }
  if (audPerUsd == null) flags.push('fx-missing');

  let commissionUsd = t.commission != null && Number.isFinite(t.commission) ? Math.abs(t.commission) : 0;
  if (t.commission == null) flags.push('commission-missing');
  if (t.commissionEstimated) flags.push('commission-estimated');
  // IBKR charges US-share brokerage in USD. If a record says AUD, convert.
  if (t.commissionCurrency === 'AUD' && commissionUsd > 0) {
    if (audPerUsd) commissionUsd /= audPerUsd;
    else flags.push('commission-currency-unconverted');
  }

  return { i, t, ms, date, priceUsd: unitPrice(t), commissionUsd, audPerUsd, flags };
}

const round = (x: number): number => Math.round(x * 1e8) / 1e8;

export function runLotEngine(trades: TradeRecord[], opts: LotEngineOptions = {}): LotEngineResult {
  const issues: string[] = [];
  const rows = trades
    .map((t, i) => normalise(t, i, opts))
    .filter((n) => {
      if (!(n.t.qty > 0)) {
        issues.push(`ignored a ${n.t.action} of ${n.t.symbol} with non-positive quantity (${n.t.qty})`);
        return false;
      }
      return true;
    })
    // Time order; on a tie a BUY comes first (a same-instant buy is available
    // to the sale), then ledger order.
    .sort((a, b) => a.ms - b.ms || (a.t.action === b.t.action ? 0 : a.t.action === 'BUY' ? -1 : 1) || a.i - b.i);

  const open = new Map<string, Lot[]>();
  const disposals: Disposal[] = [];
  const unmatched: UnmatchedSale[] = [];

  for (const n of rows) {
    const { t } = n;
    if (!n.date) issues.push(`${t.action} ${t.qty} ${t.symbol}: no usable trade date (${t.timestamp})`);

    if (t.action === 'BUY') {
      const commissionPerShareUsd = n.commissionUsd / t.qty;
      const costPerShareUsd = n.priceUsd + commissionPerShareUsd;
      const lots = open.get(t.symbol) ?? [];
      lots.push({
        symbol: t.symbol,
        buyTimestamp: t.timestamp,
        buyDate: n.date ?? '',
        qty: t.qty,
        qtyBought: t.qty,
        priceUsd: n.priceUsd,
        commissionPerShareUsd,
        costPerShareUsd,
        audPerUsd: n.audPerUsd,
        costPerShareAud: n.audPerUsd != null ? costPerShareUsd * n.audPerUsd : null,
        discountEligibleFrom: n.date ? discountEligibleFrom(n.date) : '',
        record: t,
        flags: n.flags,
      });
      open.set(t.symbol, lots);
      continue;
    }

    // SELL
    const lots = open.get(t.symbol) ?? [];
    const sellCommPerShare = n.commissionUsd / t.qty;
    const netPerShareUsd = n.priceUsd - sellCommPerShare;
    let toFill = t.qty;
    while (toFill > 1e-9 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(lot.qty, toFill);
      const costUsd = take * lot.costPerShareUsd;
      const proceedsUsd = take * netPerShareUsd;
      const costAud = lot.costPerShareAud != null ? take * lot.costPerShareAud : null;
      const proceedsAud = n.audPerUsd != null ? proceedsUsd * n.audPerUsd : null;
      const sellDate = n.date ?? '';
      disposals.push({
        symbol: t.symbol,
        qty: take,
        buyDate: lot.buyDate,
        buyTimestamp: lot.buyTimestamp,
        sellDate,
        sellTimestamp: t.timestamp,
        financialYear: sellDate ? financialYearOf(sellDate) : 'FY?',
        discountEligible: !!(lot.buyDate && sellDate && isDiscountEligible(lot.buyDate, sellDate)),
        costUsd: round(costUsd),
        proceedsUsd: round(proceedsUsd),
        gainUsd: round(proceedsUsd - costUsd),
        costAud: costAud != null ? round(costAud) : null,
        proceedsAud: proceedsAud != null ? round(proceedsAud) : null,
        gainAud: costAud != null && proceedsAud != null ? round(proceedsAud - costAud) : null,
        buyRecord: lot.record,
        sellRecord: t,
        flags: [...new Set([...lot.flags.map((f) => `buy:${f}`), ...n.flags.map((f) => `sell:${f}`)])],
      });
      lot.qty = round(lot.qty - take);
      toFill = round(toFill - take);
      if (lot.qty <= 1e-9) lots.shift();
    }
    if (toFill > 1e-9) {
      unmatched.push({ symbol: t.symbol, qty: toFill, sellDate: n.date, record: t });
      issues.push(
        `SELL ${t.qty} ${t.symbol} on ${n.date ?? t.timestamp}: ${toFill} share(s) have no earlier parcel ` +
          '(the ledger is missing their purchase — seed opening lots)',
      );
    }
  }

  for (const d of disposals) {
    if (d.flags.some((f) => f.endsWith('fx-missing'))) {
      issues.push(`${d.symbol} disposal on ${d.sellDate}: no AUD rate for one side — AUD figures omitted`);
    }
  }

  return { disposals, openLots: open, unmatched, issues: [...new Set(issues)] };
}

/** Open parcels of one symbol after replaying `history` (oldest first). */
export function openLotsFor(history: TradeRecord[], symbol: string, opts: LotEngineOptions = {}): Lot[] {
  return runLotEngine(history.filter((t) => t.symbol === symbol), opts).openLots.get(symbol) ?? [];
}

/** Net shares per symbol implied by the open parcels. */
export function heldQuantities(result: LotEngineResult): Map<string, number> {
  const out = new Map<string, number>();
  for (const [sym, lots] of result.openLots) {
    const q = round(lots.reduce((s, l) => s + l.qty, 0));
    if (q !== 0) out.set(sym, q);
  }
  return out;
}
