/**
 * Value at Risk (VaR) and Conditional VaR (Expected Shortfall)
 */

/** Historical VaR: sort returns, take the α-percentile loss */
export function historicalVaR(returns: number[], confidence: number = 0.95): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor((1 - confidence) * sorted.length);
  return -sorted[Math.max(idx, 0)];
}

/** Parametric VaR assuming normal distribution */
export function parametricVaR(mean: number, stdDev: number, confidence: number = 0.95): number {
  const z = normalInvCDF(confidence);
  return -(mean - z * stdDev);
}

/** CVaR (Expected Shortfall): average loss beyond VaR threshold */
export function conditionalVaR(returns: number[], confidence: number = 0.95): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoffIdx = Math.floor((1 - confidence) * sorted.length);
  if (cutoffIdx <= 0) return -sorted[0];
  const tail = sorted.slice(0, cutoffIdx);
  const avg = tail.reduce((s, v) => s + v, 0) / tail.length;
  return -avg;
}

/** Portfolio VaR given weights and covariance matrix */
export function portfolioVaR(
  weights: number[],
  covMatrix: number[][],
  portfolioValue: number,
  confidence: number = 0.95
): number {
  const portfolioVar = quadraticForm(weights, covMatrix);
  const portfolioStd = Math.sqrt(portfolioVar);
  const z = normalInvCDF(confidence);
  return z * portfolioStd * portfolioValue;
}

/** Standard normal inverse CDF (Rational approximation, Abramowitz & Stegun) */
export function normalInvCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2,
    -2.759285104469687e2, 1.383577518672690e2,
    -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2,
    -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1,
    -2.400758277161838e0, -2.549732539343734e0,
    4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1,
    2.445134137142996e0, 3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

/** Standard normal CDF using erf approximation (Horner form) */
export function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Error function approximation (Abramowitz & Stegun 7.1.26, max error ~1.5e-7) */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);

  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;

  const t = 1 / (1 + p * a);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  return sign * (1 - poly * Math.exp(-a * a));
}

/** w' * M * w */
export function quadraticForm(w: number[], M: number[][]): number {
  let result = 0;
  for (let i = 0; i < w.length; i++) {
    for (let j = 0; j < w.length; j++) {
      result += w[i] * M[i][j] * w[j];
    }
  }
  return result;
}
