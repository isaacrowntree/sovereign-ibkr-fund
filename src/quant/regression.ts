/**
 * Factor Regression (OLS) and Return Decomposition
 */

import {
  matInverse,
  matMultiply,
  matTranspose,
  matVecMultiply,
} from '../portfolio/covariance.js';

export interface RegressionResult {
  alpha: number;
  betas: number[];
  residuals: number[];
  rSquared: number;
  adjustedRSquared: number;
  tStatistics: number[];
  standardErrors: number[];
}

export interface ReturnDecomposition {
  totalReturn: number;
  alphaContribution: number;
  factorContributions: { name: string; beta: number; contribution: number }[];
  residualContribution: number;
}

/**
 * Ordinary Least Squares regression with intercept.
 *
 * @param y  Dependent variable (n observations)
 * @param X  Independent variables (n observations x k factors, each row = one observation)
 * @param factorNames  Optional names for reporting
 */
export function olsRegression(
  y: number[],
  X: number[][],
  factorNames?: string[]
): RegressionResult {
  const n = y.length;
  if (n === 0 || X.length === 0) {
    throw new Error('Empty arrays provided');
  }
  const k = X[0].length; // number of factors (excluding intercept)

  if (n !== X.length) {
    throw new Error('y and X must have the same number of observations');
  }
  if (n <= k + 1) {
    throw new Error('Need more observations than parameters (n > k+1)');
  }

  // Build design matrix with intercept column: [1, x1, x2, ...]
  const designMatrix: number[][] = X.map((row) => [1, ...row]);
  const p = k + 1; // total parameters (intercept + k factors)

  // Normal equations: beta = (X'X)^-1 * X'y
  const Xt = matTranspose(designMatrix);
  const XtX = matMultiply(Xt, designMatrix);
  const XtXinv = matInverse(XtX); // throws if singular
  const Xty = matVecMultiply(Xt, y);
  const betaHat = matVecMultiply(XtXinv, Xty);

  // Residuals and SS
  const yHat = matVecMultiply(designMatrix, betaHat);
  const residuals = y.map((yi, i) => yi - yHat[i]);

  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const ssRes = residuals.reduce((s, v) => s + v * v, 0);

  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const adjustedRSquared =
    ssTot > 0 ? 1 - ((1 - rSquared) * (n - 1)) / (n - p) : 0;

  // Standard errors and t-statistics
  const sigma2 = ssRes / (n - p);
  const standardErrors = betaHat.map((_, i) =>
    Math.sqrt(XtXinv[i][i] * sigma2)
  );
  const tStatistics = betaHat.map((b, i) =>
    standardErrors[i] > 0 ? b / standardErrors[i] : 0
  );

  return {
    alpha: betaHat[0],
    betas: betaHat.slice(1),
    residuals,
    rSquared,
    adjustedRSquared,
    tStatistics,
    standardErrors,
  };
}

/**
 * Decompose portfolio returns into alpha, factor, and residual contributions.
 */
export function decomposeReturns(
  portfolioReturns: number[],
  factorReturns: number[][],
  factorNames: string[],
  regression: RegressionResult
): ReturnDecomposition {
  const totalReturn = portfolioReturns.reduce((s, v) => s + v, 0);
  const n = portfolioReturns.length;

  const alphaContribution = regression.alpha * n;

  const factorContributions = factorNames.map((name, i) => {
    const factorSum = factorReturns.reduce((s, row) => s + row[i], 0);
    return {
      name,
      beta: regression.betas[i],
      contribution: regression.betas[i] * factorSum,
    };
  });

  const residualContribution = regression.residuals.reduce((s, v) => s + v, 0);

  return {
    totalReturn,
    alphaContribution,
    factorContributions,
    residualContribution,
  };
}
