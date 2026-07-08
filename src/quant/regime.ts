/**
 * Market regime detection
 *
 * Signals:
 * - Trend:         50/200 MA crossover on portfolio average (direction)
 * - Trend strength: Per-stock ADX aggregated by breadth (strength)
 * - Momentum:      % of stocks above their 50-day MA (breadth)
 * - Volatility:    Annualized vol levels
 * - Vol expansion: 20d/60d vol ratio (catches spikes early)
 * - Correlation:   Average pairwise correlation
 *
 * Composite score: -6 to +6, mapped to 4 regime states.
 */

export type RegimeState = 'risk_on' | 'neutral' | 'risk_off' | 'crisis';

export interface OHLCBar {
  high: number;
  low: number;
  close: number;
}

export interface RegimeSignals {
  trend: 1 | 0 | -1;
  trendStrength: 1 | 0 | -1;
  momentum: 1 | 0 | -1;
  volatility: 1 | 0 | -1;
  volExpansion: 1 | 0 | -1;
  correlation: 1 | 0 | -1;
  composite: RegimeState;
  score: number;
}

/** Trend regime: price relative to 200-day MA */
export function trendSignal(prices: number[], shortWindow: number = 50, longWindow: number = 200): 1 | 0 | -1 {
  if (prices.length < longWindow) return 0;
  const shortMA = sma(prices.slice(-shortWindow));
  const longMA = sma(prices.slice(-longWindow));
  const current = prices[prices.length - 1];

  if (current > longMA && shortMA > longMA) return 1;  // bullish
  if (current < longMA && shortMA < longMA) return -1;  // bearish
  return 0; // mixed
}

/**
 * Trend strength via per-stock ADX breadth.
 *
 * Computes ADX for each stock individually, then aggregates:
 *   >50% have ADX > 25 → strong trending (+1)
 *   >50% have ADX < 15 → mostly ranging (-1)
 *   Otherwise → moderate (0)
 *
 * Accepts either per-stock OHLC bars or per-stock close arrays.
 */
export function trendStrengthSignal(data: OHLCBar[][] | number[][] | OHLCBar[] | number[], period: number = 14): 1 | 0 | -1 {
  // Single series (backward compat) — wrap in array
  if (data.length === 0) return 0;
  const first = data[0];
  const isMulti = Array.isArray(first);
  const series: (OHLCBar[] | number[])[] = isMulti ? data as any : [data as any];

  let strong = 0;
  let ranging = 0;
  let total = 0;

  for (const s of series) {
    const adx = typeof s[0] === 'number'
      ? computeADXFromCloses(s as number[], period)
      : computeADX(s as OHLCBar[], period);
    if (adx === null) continue;
    total++;
    if (adx > 25) strong++;
    else if (adx < 15) ranging++;
  }

  if (total === 0) return 0;
  if (strong / total > 0.5) return 1;   // majority trending strongly
  if (ranging / total > 0.5) return -1; // majority ranging
  return 0;
}

/**
 * Momentum breadth: % of stocks above their 50-day MA.
 *
 *   > 70% above → bullish (+1)
 *   < 30% above → bearish (-1)
 *   Otherwise → neutral (0)
 */
export function momentumBreadthSignal(priceArrays: number[][]): 1 | 0 | -1 {
  if (priceArrays.length === 0) return 0;
  let above = 0;
  let total = 0;

  for (const prices of priceArrays) {
    if (prices.length < 50) continue;
    total++;
    const ma50 = sma(prices.slice(-50));
    if (prices[prices.length - 1] > ma50) above++;
  }

  if (total === 0) return 0;
  const pct = above / total;
  if (pct > 0.7) return 1;   // broad strength
  if (pct < 0.3) return -1;  // broad weakness
  return 0;
}

/**
 * Proper ADX using OHLC data with Wilder's True Range.
 */
function computeADX(bars: OHLCBar[], period: number = 14): number | null {
  if (bars.length < period * 3) return null;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const curr = bars[i];
    const prev = bars[i - 1];
    tr.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  return smoothADX(plusDM, minusDM, tr, period);
}

/** Fallback ADX from close-only prices */
function computeADXFromCloses(prices: number[], period: number = 14): number | null {
  if (prices.length < period * 3) return null;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const upMove = prices[i] - prices[i - 1];
    const downMove = prices[i - 1] - prices[i];
    plusDM.push(upMove > 0 && upMove > downMove ? upMove : 0);
    minusDM.push(downMove > 0 && downMove > upMove ? downMove : 0);
    tr.push(Math.abs(prices[i] - prices[i - 1]));
  }

  return smoothADX(plusDM, minusDM, tr, period);
}

/** Wilder smoothing of DM/TR into ADX */
function smoothADX(plusDM: number[], minusDM: number[], tr: number[], period: number): number | null {
  let smoothPDM = sma(plusDM.slice(0, period));
  let smoothNDM = sma(minusDM.slice(0, period));
  let smoothTR = sma(tr.slice(0, period));

  const dx: number[] = [];
  for (let i = period; i < plusDM.length; i++) {
    smoothPDM = (smoothPDM * (period - 1) + plusDM[i]) / period;
    smoothNDM = (smoothNDM * (period - 1) + minusDM[i]) / period;
    smoothTR = (smoothTR * (period - 1) + tr[i]) / period;

    const plusDI = smoothTR > 0 ? (smoothPDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothNDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    dx.push(diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0);
  }

  if (dx.length < period) return null;

  let adx = sma(dx.slice(0, period));
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  return adx;
}

/** Volatility regime based on annualized vol levels */
export function volRegimeSignal(annualizedVol: number): 1 | 0 | -1 {
  if (annualizedVol < 15) return 1;   // low vol = risk on
  if (annualizedVol > 30) return -1;  // high vol = risk off
  return 0; // normal
}

/**
 * Volatility expansion: ratio of recent vol (20d) to trailing vol (60d).
 * Ratio > 1.5 = expanding (risk off), ratio < 0.7 = contracting (risk on).
 */
export function volExpansionSignal(returns: number[]): 1 | 0 | -1 {
  if (returns.length < 60) return 0;
  const recentVol = stdDev(returns.slice(-20));
  const trailingVol = stdDev(returns.slice(-60));
  if (trailingVol === 0) return 0;
  const ratio = recentVol / trailingVol;
  if (ratio > 1.5) return -1;
  if (ratio < 0.7) return 1;
  return 0;
}

/** Correlation regime: average pairwise correlation */
export function correlationSignal(corrMatrix: number[][]): 1 | 0 | -1 {
  const n = corrMatrix.length;
  if (n < 2) return 0;

  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sum += corrMatrix[i][j];
      count++;
    }
  }
  const avgCorr = count > 0 ? sum / count : 0;

  if (avgCorr < 0.3) return 1;
  if (avgCorr > 0.6) return -1;
  return 0;
}

/** Composite regime from all signals */
export function compositeRegime(signals: {
  trend: 1 | 0 | -1;
  trendStrength?: 1 | 0 | -1;
  momentum?: 1 | 0 | -1;
  volatility: 1 | 0 | -1;
  volExpansion?: 1 | 0 | -1;
  correlation: 1 | 0 | -1;
}): RegimeSignals {
  const ts = signals.trendStrength ?? 0;
  const mom = signals.momentum ?? 0;
  const ve = signals.volExpansion ?? 0;
  const score = signals.trend + ts + mom + signals.volatility + ve + signals.correlation;

  // Thresholds: 6 signals, range -6 to +6
  //   >= 2: risk_on   (at least 2 net positive signals)
  //   >= 0: neutral
  //   >= -2: risk_off
  //   < -2: crisis
  let composite: RegimeState;
  if (score >= 2) composite = 'risk_on';
  else if (score >= 0) composite = 'neutral';
  else if (score >= -2) composite = 'risk_off';
  else composite = 'crisis';

  return {
    trend: signals.trend,
    trendStrength: ts,
    momentum: mom,
    volatility: signals.volatility,
    volExpansion: ve,
    correlation: signals.correlation,
    composite,
    score,
  };
}

/** Regime-based exposure multiplier */
export function regimeExposure(regime: RegimeState): number {
  switch (regime) {
    case 'risk_on': return 1.0;
    case 'neutral': return 0.85;
    case 'risk_off': return 0.6;
    case 'crisis': return 0.3;
  }
}

function sma(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}
