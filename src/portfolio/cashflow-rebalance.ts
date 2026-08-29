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
