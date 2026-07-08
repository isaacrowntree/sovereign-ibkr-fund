/**
 * Volatility targeting and estimation
 */

/** EWMA (Exponentially Weighted Moving Average) volatility, RiskMetrics λ=0.94 */
export function ewmaVolatility(returns: number[], lambda: number = 0.94): number {
  if (returns.length < 2) return 0;
  let variance = returns[0] ** 2;
  for (let i = 1; i < returns.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] ** 2;
  }
  return Math.sqrt(variance);
}

/** Simple realized volatility (standard deviation of returns) */
export function realizedVolatility(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

/** Annualize daily volatility (assumes 252 trading days) */
export function annualizeVol(dailyVol: number, periodsPerYear: number = 252): number {
  return dailyVol * Math.sqrt(periodsPerYear);
}

/**
 * Volatility targeting: compute leverage to achieve target vol
 * leverage = σ_target / σ_realized, capped at maxLeverage
 */
export function volTargetLeverage(
  realizedVol: number,
  targetVol: number,
  maxLeverage: number = 1.5,
  minLeverage: number = 0.1
): number {
  if (realizedVol <= 0) return minLeverage;
  const raw = targetVol / realizedVol;
  return Math.max(minLeverage, Math.min(maxLeverage, raw));
}

/** Kelly criterion: optimal fraction to invest */
export function kellyFraction(
  winRate: number,
  avgWin: number,
  avgLoss: number,
  fraction: number = 0.25 // quarter Kelly by default
): number {
  if (avgLoss === 0) return 0;
  const b = avgWin / Math.abs(avgLoss);
  const f = (b * winRate - (1 - winRate)) / b;
  return Math.max(0, f * fraction);
}
