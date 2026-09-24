/**
 * Plan the one-way ledger migration: opening lots, IBKR trade dates and FX
 * rates on every trade, and brokerage where it is missing.
 *
 * ## Why
 *
 * The account pre-dates the ledger. Its earlier purchases were never
 * recorded, so every sale of those shares had no cost base, and the
 * "accepted drift" baseline existed only to paper over the gap. IBKR's
 * `/pa/transactions` has the full history with a per-trade AUD rate, so the
 * gap can be filled from the broker's own record rather than estimated.
 *
 * ## What the plan contains
 *
 *   - `opening`: IBKR trades from BEFORE the ledger began, as `source:
 *     "opening"` records — buys and any pre-ledger sells, because a sell
 *     consumes parcels too. Keyed conid:date:qty:price, so a re-run finds them
 *     and writes nothing.
 *   - `patches`: for ledger trades IBKR's history matches, the trade date,
 *     `audPerUsd` (fxSource "ibkr") and conid; for a recovered orphan with an
 *     inferred price, the real price. Only fields that differ, so a re-run
 *     patches nothing.
 *   - brokerage for ledger trades with none: IBKR's execution commission when
 *     the session still has it, else max(1, 0.005·qty) USD, flagged
 *     `commissionEstimated`.
 *   - verification: ledger-implied shares after the migration against IBKR's
 *     positions, symbol by symbol, and no sale left without a parcel. `ok` is
 *     false on any mismatch — the caller must refuse to write.
 *
 * `/pa/transactions` carries no commission, so an opening lot's is estimated:
 * where the position is a single purchase, IBKR's avgCost minus the price
 * (avgCost includes brokerage); otherwise max(1, 0.005·qty). Both flagged.
 *
 * Pure: the script does the I/O and the one-transaction write.
 */
import type { TradeRecord } from '../state/store.js';
import type { PaHistory, PaTrade } from '../connection/ibkr-history.js';
import type { Execution } from '../connection/gateway.js';
import { daysBetween, tradeDateOf, type IsoDate } from '../tax/au-dates.js';
import { runLotEngine } from '../tax/lots.js';

export interface LedgerRow {
  id: number;
  trade: TradeRecord;
}

export interface BrokerPositionIn {
  symbol: string;
  conid?: number;
  qty: number;
  avgCost?: number;
}

export interface MigrationInput {
  ledger: LedgerRow[];
  positions: BrokerPositionIn[];
  /** `/pa/transactions` per conid. */
  history: Map<number, PaHistory>;
  /** Symbol for each conid fetched. */
  symbolByConid: Map<number, string>;
  /** Session executions, for real commissions where IBKR still has them. */
  executions?: Execution[];
  /** Also write IBKR trades from AFTER the ledger began that the ledger lacks. */
  includePostLedger?: boolean;
  /** Days either side a ledger trade may sit from IBKR's date and still match. */
  matchWindowDays?: number;
}

export interface Patch {
  id: number;
  symbol: string;
  set: Partial<TradeRecord>;
  unset?: Array<keyof TradeRecord>;
  why: string[];
}

export interface PositionCheck {
  symbol: string;
  ledgerBefore: number;
  ledgerAfter: number;
  broker: number;
}

export interface MigrationPlan {
  opening: TradeRecord[];
  /** IBKR trades after the ledger began that it lacks (written only with includePostLedger). */
  postLedger: TradeRecord[];
  patches: Patch[];
  positions: PositionCheck[];
  /** Ledger trades IBKR's history did not match (informational). */
  unmatchedLedger: Array<{ id: number; symbol: string; action: string; qty: number; date?: string }>;
  warnings: string[];
  /** Reasons the plan must not be written. Empty ⇔ ok. */
  refusals: string[];
  ok: boolean;
}

/** IBKR fixed-rate US share brokerage estimate: USD 0.005/share, minimum USD 1. */
export function estimateCommissionUsd(qty: number): number {
  return Math.max(1, 0.005 * Math.abs(qty));
}

export function openingKey(conid: number, t: Pick<PaTrade, 'rawDate' | 'qty' | 'price' | 'action'>): string {
  return `${conid}:${t.rawDate}:${t.action === 'SELL' ? -t.qty : t.qty}:${t.price}`;
}

const EPS = 1e-6;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

function impliedShares(trades: TradeRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of trades) out.set(t.symbol, r6((out.get(t.symbol) ?? 0) + (t.action === 'BUY' ? t.qty : -t.qty)));
  return out;
}

export function planLedgerMigration(input: MigrationInput): MigrationPlan {
  const window = input.matchWindowDays ?? 3;
  const warnings: string[] = [];
  const refusals: string[] = [];
  const patches = new Map<number, Patch>();
  const patch = (row: LedgerRow, set: Partial<TradeRecord>, why: string, unset?: Array<keyof TradeRecord>) => {
    const p = patches.get(row.id) ?? { id: row.id, symbol: row.trade.symbol, set: {}, why: [] };
    Object.assign(p.set, set);
    if (unset) p.unset = [...(p.unset ?? []), ...unset];
    p.why.push(why);
    patches.set(row.id, p);
  };

  const conidBySymbol = new Map<string, number>();
  for (const [conid, sym] of input.symbolByConid) conidBySymbol.set(sym, conid);

  const existingOpening = new Set(input.ledger.map((r) => r.trade.openingKey).filter(Boolean) as string[]);
  const live = input.ledger.filter((r) => r.trade.source !== 'opening');
  const liveDates = live.map((r) => tradeDateOf(r.trade)).filter((d): d is IsoDate => !!d).sort();
  const ledgerStart: IsoDate | undefined = liveDates[0];

  // Remaining unmatched quantity per live ledger row, consumed by IBKR trades.
  const remaining = new Map<number, number>(live.map((r) => [r.id, r.trade.qty]));
  const matchedTo = new Map<number, PaTrade[]>();

  const opening: TradeRecord[] = [];
  const postLedger: TradeRecord[] = [];

  for (const [conid, hist] of input.history) {
    const symbol = input.symbolByConid.get(conid);
    if (!symbol) {
      refusals.push(`history for conid ${conid} has no symbol`);
      continue;
    }
    for (const x of hist.trades) {
      if (x.currency !== 'USD') {
        refusals.push(`${symbol} ${x.date}: trade in ${x.currency} — only USD trades are supported`);
      }
    }
    const trades = [...hist.trades].sort((a, b) => a.date.localeCompare(b.date));
    const candidates = live.filter((r) => r.trade.symbol === symbol);

    for (const x of trades) {
      const key = openingKey(conid, x);
      if (existingOpening.has(key)) continue; // written by an earlier run

      // Consume ledger quantity of the same side, nearest date first.
      let need = x.qty;
      const near = candidates
        .map((r) => ({ r, d: tradeDateOf(r.trade) }))
        .filter(({ r, d }) => r.trade.action === x.action && d && Math.abs(daysBetween(x.date, d)) <= window
          && (remaining.get(r.id) ?? 0) > EPS)
        .sort((a, b) => Math.abs(daysBetween(x.date, a.d!)) - Math.abs(daysBetween(x.date, b.d!)) || a.r.id - b.r.id);
      const took: Array<{ r: LedgerRow; q: number }> = [];
      for (const { r } of near) {
        if (need <= EPS) break;
        const q = Math.min(need, remaining.get(r.id) ?? 0);
        took.push({ r, q });
        need = r6(need - q);
      }
      if (need <= EPS && took.length > 0) {
        for (const { r, q } of took) {
          remaining.set(r.id, r6((remaining.get(r.id) ?? 0) - q));
          matchedTo.set(r.id, [...(matchedTo.get(r.id) ?? []), x]);
        }
        continue;
      }

      // Unmatched: pre-ledger history, or a gap in the ledger.
      const rec: TradeRecord = {
        timestamp: `${x.date}T20:00:00.000Z`,
        tradeDate: x.date,
        symbol,
        action: x.action,
        qty: x.qty,
        estimatedValue: r6(x.qty * x.price),
        fillPrice: x.price,
        orderId: 0,
        status: 'filled',
        conid,
        audPerUsd: x.audPerUnit,
        fxSource: 'ibkr',
        commissionCurrency: 'USD',
        commissionEstimated: true,
        commission: estimateCommissionUsd(x.qty),
        openingKey: key,
        reason: '',
      };
      if (!ledgerStart || x.date < ledgerStart) {
        rec.source = 'opening';
        rec.reason = 'opening lot from IBKR /pa/transactions (pre-dates the ledger)';
        opening.push(rec);
      } else {
        rec.source = 'reconciled';
        rec.reason = 'backfilled from IBKR /pa/transactions (missing from the ledger)';
        postLedger.push(rec);
      }
    }
  }

  // Single-purchase positions: IBKR's avgCost includes the brokerage.
  for (const rec of opening) {
    if (rec.action !== 'BUY') continue;
    const all = [...(input.history.get(rec.conid!)?.trades ?? [])];
    const pos = input.positions.find((p) => p.symbol === rec.symbol);
    const ledgerHas = input.ledger.some((r) => r.trade.symbol === rec.symbol && r.trade.source !== 'opening');
    if (all.length === 1 && !ledgerHas && pos && Math.abs(pos.qty - rec.qty) < EPS && pos.avgCost && pos.avgCost > 0) {
      const c = r6((pos.avgCost - rec.fillPrice!) * rec.qty);
      if (c >= 0 && c <= 0.01 * rec.estimatedValue + 1) rec.commission = c;
      else warnings.push(`${rec.symbol}: avgCost-implied brokerage ${c} is implausible — used the formula estimate`);
    }
  }

  // Patches for matched ledger rows: IBKR's date, rate and contract id.
  for (const row of live) {
    const hits = matchedTo.get(row.id);
    if (!hits || hits.length === 0) continue;
    const x = hits[0];
    const t = row.trade;
    const rates = new Set(hits.map((h) => h.audPerUnit));
    if (rates.size > 1) warnings.push(`ledger #${row.id} ${t.symbol}: matched IBKR trades on different rates — used ${x.audPerUnit}`);
    if (t.tradeDate !== x.date) patch(row, { tradeDate: x.date }, `trade date ${x.date} (IBKR)`);
    if (t.audPerUsd !== x.audPerUnit || t.fxSource !== 'ibkr') patch(row, { audPerUsd: x.audPerUnit, fxSource: 'ibkr' }, `AUD rate ${x.audPerUnit} (IBKR)`);
    const conid = conidBySymbol.get(t.symbol);
    if (conid != null && t.conid !== conid) patch(row, { conid }, 'conid');
    if (t.priceInferred && hits.length === 1 && Math.abs(hits[0].qty - t.qty) < EPS) {
      patch(row, { fillPrice: x.price, estimatedValue: r6(x.price * t.qty) }, `price ${x.price} (IBKR; was inferred)`, ['priceInferred']);
    }
    const p = x.price;
    const lp = t.fillPrice;
    if (!t.priceInferred && lp && Math.abs(lp - p) / p > 0.02) {
      warnings.push(`ledger #${row.id} ${t.action} ${t.qty} ${t.symbol} on ${x.date}: ledger price ${lp} vs IBKR ${p}`);
    }
  }

  // Brokerage where none was recorded (D8).
  const execs = input.executions ?? [];
  for (const row of live) {
    const t = row.trade;
    if (t.commission != null) continue;
    let fromExec: number | undefined;
    const byId = t.execId ? execs.filter((e) => e.execId === t.execId) : [];
    const byOrder = !t.execId && t.orderId
      ? execs.filter((e) => e.orderId === t.orderId && e.action === t.action && e.symbol === t.symbol)
      : [];
    const src = byId.length ? byId : byOrder;
    const covered = src.reduce((s, e) => s + e.qty, 0);
    if (src.length && Math.abs(covered - t.qty) < EPS && src.every((e) => e.commission != null)) {
      fromExec = src.reduce((s, e) => s + Math.abs(e.commission!), 0);
    }
    if (fromExec != null) patch(row, { commission: r6(fromExec), commissionCurrency: 'USD' }, 'commission from IBKR executions');
    else patch(row, { commission: estimateCommissionUsd(t.qty), commissionEstimated: true, commissionCurrency: 'USD' }, 'commission estimated');
  }

  // Ledger trades IBKR did not match — not fatal (today's fills may not be in
  // the Portfolio Analyst feed yet), but they get no IBKR rate.
  const unmatchedLedger = live
    .filter((r) => (remaining.get(r.id) ?? 0) > EPS)
    .map((r) => ({ id: r.id, symbol: r.trade.symbol, action: r.trade.action, qty: r6(remaining.get(r.id)!), date: tradeDateOf(r.trade) }));
  for (const u of unmatchedLedger) {
    warnings.push(`ledger #${u.id} ${u.action} ${u.qty} ${u.symbol} (${u.date}) not found in IBKR history — no IBKR rate`);
  }
  if (postLedger.length > 0 && !input.includePostLedger) {
    refusals.push(
      `${postLedger.length} IBKR trade(s) after the ledger began are missing from it: ` +
        postLedger.map((t) => `${t.action} ${t.qty} ${t.symbol} ${t.tradeDate}`).join(', ') +
        ' — reconcile them first, or re-run with --include-post-ledger',
    );
  }

  // Verification against the broker.
  const before = impliedShares(input.ledger.map((r) => r.trade));
  const afterTrades = [
    ...input.ledger.map((r) => applyPatch(r.trade, patches.get(r.id))),
    ...opening,
    ...(input.includePostLedger ? postLedger : []),
  ];
  const after = impliedShares(afterTrades);
  const broker = new Map<string, number>();
  for (const p of input.positions) if (p.qty) broker.set(p.symbol, r6((broker.get(p.symbol) ?? 0) + p.qty));
  const symbols = [...new Set([...before.keys(), ...after.keys(), ...broker.keys()])].sort();
  const positions: PositionCheck[] = symbols.map((s) => ({
    symbol: s,
    ledgerBefore: before.get(s) ?? 0,
    ledgerAfter: after.get(s) ?? 0,
    broker: broker.get(s) ?? 0,
  }));
  for (const p of positions) {
    if (Math.abs(p.ledgerAfter - p.broker) > EPS) {
      refusals.push(`${p.symbol}: ledger would imply ${p.ledgerAfter}, IBKR holds ${p.broker}`);
    }
  }
  for (const s of symbols) {
    if (!input.symbolByConid.size || conidBySymbol.has(s)) continue;
    refusals.push(`${s}: no IBKR history fetched`);
  }
  const engine = runLotEngine(afterTrades);
  for (const u of engine.unmatched) {
    refusals.push(`${u.symbol}: sale of ${u.qty} on ${u.sellDate} would still have no parcel`);
  }

  return {
    opening,
    postLedger,
    patches: [...patches.values()].sort((a, b) => a.id - b.id),
    positions,
    unmatchedLedger,
    warnings,
    refusals: [...new Set(refusals)],
    ok: refusals.length === 0,
  };
}

export function applyPatch(t: TradeRecord, p: Patch | undefined): TradeRecord {
  if (!p) return t;
  const out: TradeRecord = { ...t, ...p.set };
  for (const k of p.unset ?? []) delete (out as unknown as Record<string, unknown>)[k];
  return out;
}
