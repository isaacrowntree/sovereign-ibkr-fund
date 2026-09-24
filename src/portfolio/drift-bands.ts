/**
 * Tolerance-band rebalance gate (2026-09-24 review, F1; DRIFT_GATE=bands).
 *
 * WHY. The legacy gate fires on the single largest |current − target| against
 * one threshold for every name. On a book of 19 names with 2–8% targets that is
 * wrong at both ends: a 10pp threshold never fires for a 2% name (it could
 * triple and stay "within threshold") and a single 8% name moving 10pp drags a
 * whole-book rebalance behind it, selling everything that drifted a little.
 *
 * THE RULE (parameters exactly as the plan, calibrated by G6 before switch-on):
 *   band_i    = max(1.5pp, 0.25·tgt_i, 0.75·price_i/NAV)
 *               — proportional to the target, never narrower than 1.5pp, and
 *               never narrower than ¾ of one share (a band a single share can
 *               jump across would trade forever).
 *   trigger   = ½·Σ|cur_i − tgt_i| ≥ 5%   (the share of the book misplaced)
 *   urgent_i  = |dev_i| ≥ max(4pp, 0.75·tgt_i)
 *   Sells trim an out-of-band overweight to tgt + ½·band (not to target: the
 *   last half-band is left to drift back, which halves the round trips).
 *   Buys fill underweights to target from cash.
 *   The 45-day cooldown gates SELLS only; urgent names ignore it.
 *   Tax: sell loss lots first; never sell a gain lot within 60 days of its
 *   CGT discount date unless the name is urgent.
 *
 * Lots are FIFO because that is how IBKR matches them (the operator sets FIFO in
 * Client Portal, plan E11): "loss lots first" therefore orders the SELLS across
 * names by the P&L of the lots each would consume, and the 60-day guard stops a
 * trim before the first protected lot in FIFO order.
 */
import type { PortfolioSnapshot, RebalanceOrder, RebalanceTrigger } from './rebalance.js';

export interface BandParams {
  minBand: number;
  relBand: number;
  shareBand: number;
  portfolioTrigger: number;
  urgentMin: number;
  urgentRel: number;
  /** Days before a lot's CGT discount date during which a gain lot is not sold. */
  taxGuardDays: number;
}

/** The plan's parameters (F1), as fractions of NAV. */
export const PLAN_BANDS: BandParams = {
  minBand: 0.015,
  relBand: 0.25,
  shareBand: 0.75,
  portfolioTrigger: 0.05,
  urgentMin: 0.04,
  urgentRel: 0.75,
  taxGuardDays: 60,
};

const EPS = 1e-12;

export interface BandName {
  symbol: string;
  price: number;
  target: number;
  current: number;
  /** current − target, fraction of NAV. */
  dev: number;
  band: number;
  urgentBand: number;
  out: 'over' | 'under' | null;
  urgent: boolean;
}

export interface BandAssessment {
  names: BandName[];
  /** ½·Σ|cur − tgt|. */
  halfL1: number;
  triggered: boolean;
  urgent: string[];
}

export function assessBands(
  snapshot: Pick<PortfolioSnapshot, 'prices' | 'currentShares' | 'nav'>,
  targets: ReadonlyMap<string, number>,
  params: BandParams = PLAN_BANDS,
): BandAssessment {
  const names: BandName[] = [];
  let l1 = 0;
  for (const [symbol, target] of targets) {
    const price = snapshot.prices.get(symbol) ?? 0;
    const shares = snapshot.currentShares.get(symbol) ?? 0;
    const current = snapshot.nav > 0 ? (shares * price) / snapshot.nav : 0;
    const dev = current - target;
    const band = Math.max(params.minBand, params.relBand * target, snapshot.nav > 0 ? params.shareBand * price / snapshot.nav : 0);
    const urgentBand = Math.max(params.urgentMin, params.urgentRel * target);
    l1 += Math.abs(dev);
    names.push({
      symbol, price, target, current, dev, band, urgentBand,
      out: dev > band + EPS ? 'over' : dev < -band - EPS ? 'under' : null,
      // EPS: 0.06 − 0.02 is 0.039999…, which must count as a 4pp deviation.
      urgent: Math.abs(dev) >= urgentBand - EPS,
    });
  }
  const halfL1 = l1 / 2;
  return {
    names,
    halfL1,
    triggered: halfL1 >= params.portfolioTrigger - EPS,
    urgent: names.filter(n => n.urgent).map(n => n.symbol),
  };
}

/**
 * Same four outcomes as the legacy `decideRebalance`, so the strategist's
 * branches read the same:
 *   urgent           — at least one name is past its urgent band (cooldown ignored)
 *   regular          — portfolio trigger fired and the SELL cooldown has lapsed
 *   too-soon         — portfolio trigger fired inside the cooldown: buys only
 *   within-threshold — nothing to trim; cash-flow deployment as usual
 */
export function decideBands(a: BandAssessment, daysSinceLastSell: number, cooldownDays: number): RebalanceTrigger {
  if (a.urgent.length > 0) return 'urgent';
  if (a.triggered && daysSinceLastSell >= cooldownDays) return 'regular';
  if (a.triggered) return 'too-soon';
  return 'within-threshold';
}

// ─────────────────────────────────────────────────────────────────────────────
// Lots (FIFO) and the CGT discount guard
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenLot {
  /** ET trade date of the buy; null for shares the ledger cannot date (pre-ledger holdings). */
  date: string | null;
  qty: number;
  /** Per-share cost, USD; null when unknown. */
  cost: number | null;
}

/**
 * The earliest date a disposal of a lot bought on `buyDate` gets the 50% CGT
 * discount: held for at least 12 months, i.e. buy date + 1 year + 1 day
 * (conservative by a day across 29 February). Same rule as plan E3; switch to
 * the tax module's helper once WS-E lands it.
 */
export function discountDate(buyDate: string): string {
  const d = new Date(`${buyDate}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const dayMs = 86_400_000;
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);

/**
 * Open lots for `symbol`, oldest first, from the fill ledger — reconciled to
 * the broker's `heldQty`: shares the ledger cannot account for become one
 * undated lot at the FRONT (they predate the ledger, so FIFO sells them first);
 * a ledger that shows MORE than is held is trimmed from the front.
 */
export function openLotsFifo(
  trades: ReadonlyArray<{ symbol: string; action: 'BUY' | 'SELL'; qty: number; timestamp: string; fillPrice?: number; estimatedValue?: number }>,
  symbol: string,
  heldQty: number,
): OpenLot[] {
  const mine = trades
    .filter(t => t.symbol === symbol && t.qty > 0)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const lots: OpenLot[] = [];
  for (const t of mine) {
    if (t.action === 'BUY') {
      const cost = t.fillPrice ?? (t.estimatedValue !== undefined ? t.estimatedValue / t.qty : null);
      lots.push({ date: etDateOf(t.timestamp), qty: t.qty, cost });
    } else {
      let left = t.qty;
      while (left > 0 && lots.length > 0) {
        const take = Math.min(left, lots[0].qty);
        lots[0].qty -= take;
        left -= take;
        if (lots[0].qty <= 0) lots.shift();
      }
    }
  }
  const ledgerQty = lots.reduce((s, l) => s + l.qty, 0);
  if (heldQty > ledgerQty) {
    lots.unshift({ date: null, qty: heldQty - ledgerQty, cost: null });
  } else if (heldQty < ledgerQty) {
    let excess = ledgerQty - heldQty;
    while (excess > 0 && lots.length > 0) {
      const take = Math.min(excess, lots[0].qty);
      lots[0].qty -= take;
      excess -= take;
      if (lots[0].qty <= 0) lots.shift();
    }
  }
  return lots;
}

function etDateOf(ts: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ts));
}

export interface SellPlan {
  /** Shares that may be sold (≤ requested). */
  qty: number;
  /** Unrealised P&L per share of the lots consumed (for loss-first ordering). */
  pnlPerShare: number;
  /** Why the trim stopped short, if it did. */
  heldBack: string | null;
  /** Shares consumed from undated (pre-ledger) lots. */
  undatedQty: number;
}

/**
 * Consume FIFO lots for a sale of up to `wantQty`, stopping before the first
 * gain lot whose discount date is 1..`guardDays` days away (unless `urgent`).
 */
export function planSellFromLots(
  lots: readonly OpenLot[], wantQty: number, price: number, today: string, guardDays: number, urgent: boolean,
): SellPlan {
  let qty = 0;
  let pnl = 0;
  let undatedQty = 0;
  let heldBack: string | null = null;
  for (const lot of lots) {
    if (qty >= wantQty) break;
    const gain = lot.cost !== null ? price - lot.cost : 0;
    if (!urgent && lot.date !== null && gain > 0) {
      const dd = discountDate(lot.date);
      const until = daysBetween(today, dd);
      if (until > 0 && until <= guardDays) {
        heldBack = `a gain lot bought ${lot.date} reaches the CGT discount on ${dd} (${until}d)`;
        break;
      }
    }
    const take = Math.min(lot.qty, wantQty - qty);
    qty += take;
    pnl += take * gain;
    if (lot.date === null) undatedQty += take;
  }
  return { qty, pnlPerShare: qty > 0 ? pnl / qty : 0, heldBack, undatedQty };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────────────────────

export interface BandOrderOptions {
  decision: RebalanceTrigger;
  params?: BandParams;
  minTradeUsd: number;
  /** Percent of NAV held back as cash (REBALANCE_CASH_BUFFER_PCT). */
  cashBufferPct: number;
  /** Open lots per symbol; absent symbols are treated as one undated lot. */
  lots?: ReadonlyMap<string, readonly OpenLot[]>;
  /** ET date "today", for the CGT guard. */
  today: string;
  /** Names the buy side must skip (target-aware rebuy guard). */
  excludeBuys?: ReadonlySet<string>;
}

export interface BandOrders {
  orders: RebalanceOrder[];
  /** Human-readable notes: trims held back by the tax guard, names skipped. */
  notes: string[];
}

const CASH_ABSOLUTE_RESERVE_USD = 50;

/**
 * Orders for a bands decision. `urgent` trims only the urgent overweights;
 * `regular` trims every out-of-band overweight; `too-soon` and
 * `within-threshold` produce no sells (the caller routes those to the buy-only
 * cash-flow path). Every trading decision also fills underweights from the
 * cash it has, greedily by deficit, a whole share at a time while the
 * remaining deficit is at least half a share.
 */
export function generateBandOrders(
  snapshot: PortfolioSnapshot,
  assessment: BandAssessment,
  opts: BandOrderOptions,
): BandOrders {
  const p = opts.params ?? PLAN_BANDS;
  const notes: string[] = [];
  const orders: RebalanceOrder[] = [];
  const nav = snapshot.nav;
  if (!(nav > 0) || (opts.decision !== 'urgent' && opts.decision !== 'regular')) return { orders, notes };

  const sells: Array<{ order: RebalanceOrder; pnl: number }> = [];
  for (const n of assessment.names) {
    if (n.out !== 'over' || n.price <= 0) continue;
    if (opts.decision === 'urgent' && !n.urgent) continue;
    const trimTo = (n.target + n.band / 2) * nav;
    const held = snapshot.currentShares.get(n.symbol) ?? 0;
    const want = Math.min(held, Math.floor((n.current * nav - trimTo) / n.price));
    if (want <= 0) continue;
    const lots = opts.lots?.get(n.symbol) ?? [{ date: null, qty: held, cost: null }];
    const plan = planSellFromLots(lots, want, n.price, opts.today, p.taxGuardDays, n.urgent);
    if (plan.heldBack) notes.push(`${n.symbol}: trim ${plan.qty}/${want} — ${plan.heldBack}`);
    if (plan.undatedQty > 0) notes.push(`${n.symbol}: ${plan.undatedQty} share(s) from undated pre-ledger lots`);
    const value = plan.qty * n.price;
    if (plan.qty <= 0 || value < opts.minTradeUsd) continue;
    sells.push({
      pnl: plan.pnlPerShare,
      order: {
        symbol: n.symbol, action: 'SELL', shares: plan.qty, estimatedValue: value,
        reason: `bands${n.urgent ? ' URGENT' : ''}: ${(n.current * 100).toFixed(1)}% → ${((trimTo / nav) * 100).toFixed(1)}% ` +
          `(target ${(n.target * 100).toFixed(1)}%, band ±${(n.band * 100).toFixed(1)}pp)`,
      },
    });
  }
  // Loss lots first: the most-loss / least-gain sale executes earliest.
  sells.sort((a, b) => a.pnl - b.pnl);
  orders.push(...sells.map(s => s.order));
  const proceeds = sells.reduce((s, x) => s + x.order.estimatedValue, 0);

  // Buys: fill to target from cash (incl. this run's sale proceeds).
  const reserve = Math.max(CASH_ABSOLUTE_RESERVE_USD, nav * (opts.cashBufferPct / 100));
  let budget = Math.max(0, snapshot.cash + proceeds - reserve);
  const deficits = new Map<string, number>();
  for (const n of assessment.names) {
    if (n.dev >= 0 || n.price <= 0) continue;
    if (opts.excludeBuys?.has(n.symbol)) { notes.push(`${n.symbol}: buy skipped by the rebuy guard`); continue; }
    deficits.set(n.symbol, -n.dev * nav);
  }
  const bought = new Map<string, number>();
  const price = (s: string): number => snapshot.prices.get(s) ?? 0;
  for (;;) {
    let best: string | null = null;
    let bestDef = 0;
    for (const [s, d] of deficits) {
      if (d >= price(s) / 2 && price(s) <= budget && d > bestDef) { best = s; bestDef = d; }
    }
    if (best === null) break;
    bought.set(best, (bought.get(best) ?? 0) + 1);
    deficits.set(best, bestDef - price(best));
    budget -= price(best);
  }
  for (const [s, qty] of bought) {
    const value = qty * price(s);
    if (value < opts.minTradeUsd) { notes.push(`${s}: buy of $${value.toFixed(0)} under the minimum trade`); continue; }
    const n = assessment.names.find(x => x.symbol === s)!;
    orders.push({
      symbol: s, action: 'BUY', shares: qty, estimatedValue: value,
      reason: `bands: ${(n.current * 100).toFixed(1)}% → ${(((n.current * nav + value) / nav) * 100).toFixed(1)}% (target ${(n.target * 100).toFixed(1)}%)`,
    });
  }
  return { orders, notes };
}

/** One line for the strategist's shadow log. */
export function describeBands(a: BandAssessment, decision: RebalanceTrigger, o: BandOrders): string {
  const out = a.names.filter(n => n.out).map(n => `${n.symbol}${n.out === 'over' ? '+' : '−'}${(Math.abs(n.dev) * 100).toFixed(1)}pp`);
  const sells = o.orders.filter(x => x.action === 'SELL').map(x => `${x.symbol}×${x.shares}`);
  const buys = o.orders.filter(x => x.action === 'BUY').map(x => `${x.symbol}×${x.shares}`);
  return `${decision}; ½Σ|dev| ${(a.halfL1 * 100).toFixed(2)}% (trigger ${(PLAN_BANDS.portfolioTrigger * 100).toFixed(0)}%); ` +
    `out of band: ${out.length ? out.join(' ') : 'none'}; urgent: ${a.urgent.length ? a.urgent.join(' ') : 'none'}; ` +
    `sells: ${sells.length ? sells.join(' ') : 'none'}; buys: ${buys.length ? buys.join(' ') : 'none'}` +
    (o.notes.length ? `; notes: ${o.notes.join(' | ')}` : '');
}
