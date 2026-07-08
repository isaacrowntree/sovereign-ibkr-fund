/**
 * Factor signal generation: momentum, value, quality, low-vol
 */

export interface FactorScores {
  symbol: string;
  momentum: number;
  value: number;
  quality: number;
  lowVol: number;
  composite: number;
}

/** 12-1 month momentum (skip most recent month for reversal effect) */
export function momentumScore(prices: number[]): number {
  if (prices.length < 252) return 0;
  const recent = prices[prices.length - 22]; // ~1 month ago
  const yearAgo = prices[prices.length - 252]; // ~12 months ago
  if (yearAgo <= 0) return 0;
  return (recent - yearAgo) / yearAgo;
}

/** 52-week high proximity: price / 52wk_high (George & Hwang 2004) */
export function highProximity(prices: number[]): number {
  if (prices.length < 252) return 0;
  const recent252 = prices.slice(-252);
  const high = Math.max(...recent252);
  return high > 0 ? prices[prices.length - 1] / high : 0;
}

/** Value score from P/E ratio (lower = better value, inverted) */
export function valueScore(pe: number): number {
  if (pe <= 0 || pe > 200) return 0;
  return 1 / pe; // earnings yield
}

/** Quality score from ROE */
export function qualityScore(roe: number): number {
  return Math.max(0, Math.min(1, roe / 30)); // normalized, 30% ROE = 1.0
}

/** Low volatility score (inverse of realized vol) */
export function lowVolScore(returns: number[]): number {
  if (returns.length < 20) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const vol = Math.sqrt(variance);
  return vol > 0 ? 1 / vol : 0;
}

/** Cross-sectional z-score normalization */
export function zScoreNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  if (std === 0) return values.map(() => 0);
  return values.map(v => (v - mean) / std);
}

/** Compute composite multi-factor score from individual factor z-scores */
export function compositeScore(
  momentumZ: number,
  valueZ: number,
  qualityZ: number,
  lowVolZ: number,
  weights: { momentum: number; value: number; quality: number; lowVol: number } = {
    momentum: 0.3, value: 0.25, quality: 0.25, lowVol: 0.2
  }
): number {
  return (
    momentumZ * weights.momentum +
    valueZ * weights.value +
    qualityZ * weights.quality +
    lowVolZ * weights.lowVol
  );
}
