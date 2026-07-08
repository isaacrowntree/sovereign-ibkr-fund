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
): CashFlowOrder[] {
  if (depositUsd < 0) {
    throw new Error('Deposit must be non-negative');
  }

  const totalPortfolio = holdings.reduce((s, h) => s + h.currentValue, 0) + depositUsd;

  // Compute deficit for each asset (only positive deficits)
  const deficits: { symbol: string; deficit: number }[] = [];
  let totalDeficit = 0;

  for (const h of holdings) {
    const targetValue = totalPortfolio * (h.targetPct / 100);
    const deficit = targetValue - h.currentValue;
    if (deficit > 0) {
      deficits.push({ symbol: h.symbol, deficit });
      totalDeficit += deficit;
    }
  }

  if (totalDeficit <= 0) return [];

  // Allocate deposit proportionally to deficits
  const orders: CashFlowOrder[] = [];
  for (const { symbol, deficit } of deficits) {
    const allocation = (deficit / totalDeficit) * depositUsd;
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
