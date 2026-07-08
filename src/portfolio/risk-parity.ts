/**
 * Risk Parity: Equal Risk Contribution portfolio
 * Each asset contributes equally to total portfolio risk
 */

import { quadraticForm } from '../risk/var.js';

/**
 * Compute risk contribution of each asset
 * RC_i = w_i * (Σw)_i / sqrt(w'Σw)
 */
export function riskContributions(weights: number[], covMatrix: number[][]): number[] {
  const n = weights.length;
  const portfolioVar = quadraticForm(weights, covMatrix);
  const portfolioStd = Math.sqrt(portfolioVar);
  if (portfolioStd === 0) return weights.map(() => 1 / n);

  const marginal: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      marginal[i] += covMatrix[i][j] * weights[j];
    }
  }

  return weights.map((w, i) => (w * marginal[i]) / portfolioStd);
}

/**
 * Risk Parity via iterative optimization (cyclical coordinate descent)
 * Finds weights where each asset has equal risk contribution
 */
export function riskParityWeights(
  covMatrix: number[][],
  maxIter: number = 500,
  tolerance: number = 1e-8
): number[] {
  const n = covMatrix.length;
  if (n === 0) return [];

  // Initialize with inverse-volatility weights
  let weights = covMatrix.map((_, i) => 1 / Math.sqrt(covMatrix[i][i]));
  let sum = weights.reduce((s, w) => s + w, 0);
  weights = weights.map(w => w / sum);

  for (let iter = 0; iter < maxIter; iter++) {
    const prevWeights = [...weights];

    for (let i = 0; i < n; i++) {
      // Compute partial derivative of risk contribution deviation
      let sigmaW = 0;
      for (let j = 0; j < n; j++) {
        sigmaW += covMatrix[i][j] * weights[j];
      }

      // Update weight proportional to 1/marginal_risk
      if (sigmaW > 0) {
        weights[i] = 1 / sigmaW;
      }
    }

    // Normalize
    sum = weights.reduce((s, w) => s + w, 0);
    weights = weights.map(w => w / sum);

    // Check convergence
    const diff = weights.reduce((s, w, i) => s + Math.abs(w - prevWeights[i]), 0);
    if (diff < tolerance) break;
  }

  return weights;
}

/** Minimum variance portfolio weights (analytical solution for long-only) */
export function minVarianceWeights(covMatrix: number[][]): number[] {
  const n = covMatrix.length;
  if (n === 0) return [];

  // Approximate with inverse-variance weighting (exact for diagonal cov)
  // For full solution, need quadratic programming
  const invVar = covMatrix.map((_, i) => 1 / Math.max(covMatrix[i][i], 1e-10));
  const sum = invVar.reduce((s, v) => s + v, 0);
  return invVar.map(v => v / sum);
}
