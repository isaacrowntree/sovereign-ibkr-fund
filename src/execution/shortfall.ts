/**
 * Implementation Shortfall Tracking
 *
 * Measures execution quality by decomposing the gap between the
 * decision price and actual fill prices into slippage, timing cost,
 * and commission components (all in basis points).
 */

export interface DecisionPoint {
  symbol: string;
  decisionPrice: number;
  decisionTimestamp: string;
  action: 'BUY' | 'SELL';
  targetQty: number;
}

export interface ExecutionRecord {
  fillPrice: number;
  fillQty: number;
  fillTimestamp: string;
  commission: number;
}

export interface ShortfallResult {
  symbol: string;
  arrivalPrice: number;
  avgFillPrice: number;
  slippageBps: number;
  timingCostBps: number;
  commissionBps: number;
  totalShortfallBps: number;
  totalShortfallUsd: number;
}

export function computeShortfall(
  decision: DecisionPoint,
  executions: ExecutionRecord[],
  benchmarkClosePrice: number
): ShortfallResult {
  if (executions.length === 0) {
    throw new Error('No executions provided');
  }

  const totalQty = executions.reduce((s, e) => s + e.fillQty, 0);
  if (totalQty === 0) {
    throw new Error('Total fill quantity is zero');
  }

  const totalCommission = executions.reduce((s, e) => s + e.commission, 0);
  const avgFillPrice =
    executions.reduce((s, e) => s + e.fillPrice * e.fillQty, 0) / totalQty;

  const arrivalPrice = decision.decisionPrice;

  // Slippage: positive means worse execution
  let slippageBps: number;
  if (decision.action === 'BUY') {
    slippageBps = ((avgFillPrice - arrivalPrice) / arrivalPrice) * 10000;
  } else {
    slippageBps = ((arrivalPrice - avgFillPrice) / arrivalPrice) * 10000;
  }

  // Timing cost: market moved against you between decision and close
  let timingCostBps: number;
  if (decision.action === 'BUY') {
    timingCostBps = ((benchmarkClosePrice - arrivalPrice) / arrivalPrice) * 10000;
  } else {
    timingCostBps = ((arrivalPrice - benchmarkClosePrice) / arrivalPrice) * 10000;
  }

  // Commission in bps
  const commissionBps = (totalCommission / (avgFillPrice * totalQty)) * 10000;

  // Total shortfall = slippage + commission
  const totalShortfallBps = slippageBps + commissionBps;
  const totalShortfallUsd = (totalShortfallBps / 10000) * avgFillPrice * totalQty;

  return {
    symbol: decision.symbol,
    arrivalPrice,
    avgFillPrice,
    slippageBps,
    timingCostBps,
    commissionBps,
    totalShortfallBps,
    totalShortfallUsd,
  };
}
