/**
 * Maximum drawdown control and CPPI (Constant Proportion Portfolio Insurance)
 */

export interface DrawdownState {
  peak: number;
  currentValue: number;
  drawdownPct: number;
  level: 'normal' | 'warning' | 'derisking' | 'stopped';
}

export interface DrawdownLimits {
  warningPct: number;   // e.g. 5
  deriskPct: number;    // e.g. 10
  hardStopPct: number;  // e.g. 15
}

export const DEFAULT_LIMITS: DrawdownLimits = {
  warningPct: 5,
  deriskPct: 10,
  hardStopPct: 15,
};

export function assessDrawdown(
  currentValue: number,
  peak: number,
  limits: DrawdownLimits = DEFAULT_LIMITS
): DrawdownState {
  const actualPeak = Math.max(peak, currentValue);
  const dd = actualPeak > 0 ? ((actualPeak - currentValue) / actualPeak) * 100 : 0;

  let level: DrawdownState['level'] = 'normal';
  if (dd >= limits.hardStopPct) level = 'stopped';
  else if (dd >= limits.deriskPct) level = 'derisking';
  else if (dd >= limits.warningPct) level = 'warning';

  return { peak: actualPeak, currentValue, drawdownPct: dd, level };
}

/** Compute max drawdown from a series of portfolio values */
export function maxDrawdown(values: number[]): number {
  if (values.length < 2) return 0;
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD * 100;
}

/** Exposure multiplier based on drawdown level */
export function drawdownExposureMultiplier(level: DrawdownState['level']): number {
  switch (level) {
    case 'normal': return 1.0;
    case 'warning': return 0.75;
    case 'derisking': return 0.5;
    case 'stopped': return 0.0;
  }
}

/**
 * CPPI: Constant Proportion Portfolio Insurance
 * exposure = multiplier × (portfolioValue - floor)
 */
export function cppiExposure(
  portfolioValue: number,
  floor: number,
  multiplier: number = 4
): number {
  const cushion = Math.max(0, portfolioValue - floor);
  return Math.min(cushion * multiplier, portfolioValue);
}
