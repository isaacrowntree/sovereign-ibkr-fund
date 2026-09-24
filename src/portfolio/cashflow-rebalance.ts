/**
 * Cash-flow rebalancing: allocate deposits to underweight positions
 */

export interface CashFlowOrder {
  symbol: string;
  action: 'BUY';
  amountUsd: number;
  shares: number;
}

/**
 * Names the strategy itself sold within the rebuy-guard window, for
 * `allocateCashFlow`'s `excludeSymbols`. Pure so it is trivially testable;
 * the caller feeds it the trade ledger.
 */
export function recentlySoldSymbols(
  trades: ReadonlyArray<{ symbol: string; action: 'BUY' | 'SELL'; timestamp: string }>,
  guardDays: number,
  nowMs: number = Date.now(),
): Set<string> {
  const out = new Set<string>();
  if (guardDays <= 0) return out;
  const cutoff = nowMs - guardDays * 24 * 60 * 60 * 1000;
  for (const t of trades) {
    if (t.action !== 'SELL') continue;
    const ts = new Date(t.timestamp).getTime();
    if (Number.isFinite(ts) && ts >= cutoff && ts <= nowMs) out.add(t.symbol);
  }
  return out;
}

/**
 * Target the strategy sold a name DOWN TO, read back from the sale's reason:
 *   legacy  "rebalance: 9.1% → 7.0% (static)…"          → 7.0
 *   bands   "bands: 9.1% → 7.5% (target 7.0%, band…)"  → 7.0
 * null when the reason is not one the strategist writes (manual, reconciled).
 */
export function saleTargetPct(reason: string | undefined): number | null {
  if (!reason) return null;
  const bands = /^bands[^:]*:.*\(target (\d+(?:\.\d+)?)%/.exec(reason);
  if (bands) return parseFloat(bands[1]);
  const legacy = /^rebalance: [\d.]+% → (\d+(?:\.\d+)?)%/.exec(reason);
  return legacy ? parseFloat(legacy[1]) : null;
}

/**
 * Target-aware rebuy guard (2026-09-24 review, F3; DRIFT_GATE=bands).
 *
 * The guard exists so a sale the strategy made is not undone by the buy-only
 * cash-flow path days later. But it excluded the name for the whole window
 * even when the MODEL had since changed its mind — a reweight that raises a
 * target left the name stuck underweight for up to 30 days for no reason. Now
 * a recent sale excludes its name only while it still agrees with the current
 * target: the target has not been raised above what the sale aimed at
 * (0.25pp tolerance for rounding in the logged reason). A sale whose reason
 * cannot be read keeps the old, conservative behaviour.
 */
export function rebuyGuardExclusions(
  trades: ReadonlyArray<{ symbol: string; action: 'BUY' | 'SELL'; timestamp: string; reason?: string }>,
  guardDays: number,
  currentTargetPct: ReadonlyMap<string, number>,
  nowMs: number = Date.now(),
): { excluded: Set<string>; lifted: Array<{ symbol: string; soldTo: number; targetNow: number }> } {
  const excluded = new Set<string>();
  const lifted: Array<{ symbol: string; soldTo: number; targetNow: number }> = [];
  if (guardDays <= 0) return { excluded, lifted };
  const cutoff = nowMs - guardDays * 24 * 60 * 60 * 1000;
  // Latest qualifying sale per name decides.
  const latest = new Map<string, { ts: number; reason?: string }>();
  for (const t of trades) {
    if (t.action !== 'SELL') continue;
    const ts = new Date(t.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < cutoff || ts > nowMs) continue;
    const prev = latest.get(t.symbol);
    if (!prev || ts > prev.ts) latest.set(t.symbol, { ts, reason: t.reason });
  }
  for (const [symbol, sale] of latest) {
    const soldTo = saleTargetPct(sale.reason);
    const targetNow = currentTargetPct.get(symbol);
    if (soldTo !== null && targetNow !== undefined && targetNow > soldTo + 0.25) {
      lifted.push({ symbol, soldTo, targetNow });
      continue;
    }
    excluded.add(symbol);
  }
  return { excluded, lifted };
}

/**
 * Allocate a cash deposit across holdings to move toward target weights.
 * Only buys underweight assets; never sells.
 */
export function allocateCashFlow(
  holdings: { symbol: string; currentValue: number; targetPct: number }[],
  depositUsd: number,
  minTradeUsd: number,
  prices: Map<string, number>,
  /**
   * Rebuy guard (2026-08-29 churn study): names the strategy itself SOLD
   * recently. Cash-flow deployment is buy-only, so without this it completes
   * a round trip the day the gate returns to within-threshold: a rebalance
   * (band trim or regime downgrade) sells, the freed cash rebuys the same
   * name days later — measured at 70% of all cash-flow fills, median gap 5
   * days, every leg a short-term disposal. Excluded names' share of the
   * deposit stays in cash; it is NOT redistributed to other names, which
   * would overweight them against target.
   */
  excludeSymbols?: ReadonlySet<string>,
  /**
   * How to spread the deposit across deficits.
   *
   * `'proportional'` (default, and what production has always run) gives each
   * deficit its pro-rata slice. That silently strands cash whenever a slice
   * lands below the price of a single share: with $790 spread across names
   * priced $337-$1,147, EVERY allocation floors to zero shares and the
   * function returns no orders at all. It is not a rounding loss — the cash
   * never deploys, on any cycle, until the deficits or the balance change.
   *
   * `'greedy'` fills the largest remaining deficit one share at a time,
   * recomputing after each. It is the same principle as
   * `generateRebalanceOrders`'s greedy fillMode (which production already
   * runs) and it deploys everything down to the cheapest buyable share.
   *
   * Default is `'proportional'` so that merging this changes no live
   * behaviour; enabling greedy is a deliberate operator decision.
   */
  fillMode: 'proportional' | 'greedy' = 'proportional',
  /**
   * Greedy only (F4, DRIFT_GATE=bands): buy a share of a name only while its
   * remaining deficit is at least this fraction of the share price. 0 (legacy)
   * lets a $10 deficit buy a $1,000 share — a $990 overweight the next band
   * check may trim. 0.5 rounds to the nearest share instead of always up.
   */
  minDeficitShareFraction = 0,
): CashFlowOrder[] {
  if (depositUsd < 0) {
    throw new Error('Deposit must be non-negative');
  }

  const totalPortfolio = holdings.reduce((s, h) => s + h.currentValue, 0) + depositUsd;

  // Compute deficit for each asset (only positive deficits)
  const deficits: { symbol: string; deficit: number }[] = [];
  let totalDeficit = 0;

  for (const h of holdings) {
    if (excludeSymbols?.has(h.symbol)) continue;
    const targetValue = totalPortfolio * (h.targetPct / 100);
    const deficit = targetValue - h.currentValue;
    if (deficit > 0) {
      deficits.push({ symbol: h.symbol, deficit });
      totalDeficit += deficit;
    }
  }

  if (totalDeficit <= 0) return [];

  // With the rebuy guard active, an excluded name's share of the deposit
  // stays in cash: deployment is capped at the remaining names' total
  // deficit, instead of proportionally over-filling them past target.
  const deployable = excludeSymbols && excludeSymbols.size > 0
    ? Math.min(depositUsd, totalDeficit)
    : depositUsd;

  if (fillMode === 'greedy') return greedyFill(deficits, deployable, prices, minDeficitShareFraction);

  // Allocate deposit proportionally to deficits
  const orders: CashFlowOrder[] = [];
  for (const { symbol, deficit } of deficits) {
    const allocation = (deficit / totalDeficit) * deployable;
    if (allocation < minTradeUsd) continue;

    const price = prices.get(symbol);
    if (!price || price <= 0) continue;

    const shares = Math.floor(allocation / price);
    if (shares <= 0) continue;

    orders.push({
      symbol,
      action: 'BUY',
      amountUsd: Math.round(allocation * 100) / 100,
      shares,
    });
  }

  return orders;
}

/**
 * Fill the largest remaining deficit one share at a time.
 *
 * One-share steps rather than a computed batch because the ranking changes as
 * we buy: filling the biggest gap can make another name the biggest. It
 * terminates because every step spends at least the cheapest price and only
 * names whose price still fits the remaining budget are eligible.
 *
 * `minTradeUsd` is deliberately NOT applied here. It exists to stop the
 * proportional path emitting dust orders; greedy only ever buys whole shares of
 * the name that most needs them, so the floor would just re-strand the cash
 * this mode exists to deploy.
 */
function greedyFill(
  deficits: { symbol: string; deficit: number }[],
  budgetUsd: number,
  prices: Map<string, number>,
  minDeficitShareFraction = 0,
): CashFlowOrder[] {
  const remaining = new Map(deficits.map((d) => [d.symbol, d.deficit]));
  const shares = new Map<string, number>();
  let budget = budgetUsd;

  for (;;) {
    let best: string | null = null;
    let bestDeficit = 0;
    for (const [symbol, deficit] of remaining) {
      const price = prices.get(symbol);
      if (!price || price <= 0) continue;
      if (deficit > 0 && deficit >= price * minDeficitShareFraction && price <= budget && deficit > bestDeficit) {
        bestDeficit = deficit;
        best = symbol;
      }
    }
    if (best === null) break;
    const price = prices.get(best)!;
    shares.set(best, (shares.get(best) ?? 0) + 1);
    remaining.set(best, remaining.get(best)! - price);
    budget -= price;
  }

  return [...shares.entries()].map(([symbol, qty]) => ({
    symbol,
    action: 'BUY' as const,
    amountUsd: Math.round(qty * prices.get(symbol)! * 100) / 100,
    shares: qty,
  }));
}
