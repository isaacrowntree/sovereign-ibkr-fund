/**
 * Correlation spike stress testing
 */
import { quadraticForm, normalInvCDF } from './var.js';

export interface StressResult {
  baselineVol: number;
  stressedVol: number;
  baselineVaR: number;
  stressedVaR: number;
  portfolioValue: number;
}

/**
 * Shock a covariance matrix by setting all off-diagonal correlations to targetCorrelation.
 * Extracts standard deviations from the diagonal, builds new correlation matrix, reconstructs cov.
 */
export function shockCorrelationMatrix(
  covMatrix: number[][],
  targetCorrelation: number,
): number[][] {
  const n = covMatrix.length;
  const stds = covMatrix.map((_, i) => Math.sqrt(covMatrix[i][i]));

  const shocked: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        shocked[i][j] = stds[i] * stds[i]; // variance unchanged
      } else {
        shocked[i][j] = targetCorrelation * stds[i] * stds[j];
      }
    }
  }
  return shocked;
}

/**
 * Run correlation stress test: compute baseline and stressed VaR.
 */
export function correlationStressTest(
  weights: number[],
  covMatrix: number[][],
  portfolioValue: number,
  targetCorrelation: number = 0.9,
  confidence: number = 0.95,
): StressResult {
  const baselineVar = quadraticForm(weights, covMatrix);
  const baselineVol = Math.sqrt(baselineVar);

  const stressedCov = shockCorrelationMatrix(covMatrix, targetCorrelation);
  const stressedVar = quadraticForm(weights, stressedCov);
  const stressedVol = Math.sqrt(stressedVar);

  const z = normalInvCDF(confidence);

  return {
    baselineVol,
    stressedVol,
    baselineVaR: z * baselineVol * portfolioValue,
    stressedVaR: z * stressedVol * portfolioValue,
    portfolioValue,
  };
}
