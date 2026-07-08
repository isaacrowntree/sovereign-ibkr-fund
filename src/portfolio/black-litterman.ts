/**
 * Black-Litterman model for combining market equilibrium with investor views
 */
import { matMultiply, matTranspose, matInverse, matVecMultiply, matScale, matAdd } from './covariance.js';

export interface MarketView {
  P: number[][];        // k x n pick matrix
  Q: number[];          // k-vector of expected returns
  omega?: number[][];   // k x k uncertainty (default: tau * P * Sigma * P')
  confidence?: number[];
}

export interface BlackLittermanResult {
  impliedReturns: number[];
  posteriorReturns: number[];
  posteriorCov: number[][];
  optimalWeights: number[];
}

/** Compute implied equilibrium returns: pi = delta * Sigma * w_mkt */
export function impliedReturns(
  covMatrix: number[][],
  marketWeights: number[],
  riskAversion: number,
): number[] {
  return matVecMultiply(matScale(covMatrix, riskAversion), marketWeights);
}

/**
 * Black-Litterman posterior returns and covariance
 *
 * mu_BL = [(tau*Sigma)^-1 + P'*Omega^-1*P]^-1 * [(tau*Sigma)^-1*pi + P'*Omega^-1*Q]
 * Sigma_BL = [(tau*Sigma)^-1 + P'*Omega^-1*P]^-1
 */
export function blackLitterman(
  covMatrix: number[][],
  marketWeights: number[],
  views: MarketView,
  riskAversion: number = 2.5,
  tau: number = 0.05,
): BlackLittermanResult {
  const n = covMatrix.length;
  const pi = impliedReturns(covMatrix, marketWeights, riskAversion);

  const { P, Q } = views;
  const k = P.length;

  // Compute omega if not provided
  let omega: number[][];
  if (views.omega) {
    omega = views.omega.map(row => [...row]);
  } else {
    // omega = diag(tau * P * Sigma * P')
    const PSigma = matMultiply(P, covMatrix);
    const PSigmaPt = matMultiply(PSigma, matTranspose(P));
    omega = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < k; i++) {
      omega[i][i] = tau * PSigmaPt[i][i];
    }
  }

  // Scale omega inversely by confidence if provided
  if (views.confidence) {
    for (let i = 0; i < k; i++) {
      const c = views.confidence[i];
      if (c > 0) {
        omega[i][i] = omega[i][i] / c;
      } else {
        omega[i][i] = 1e12; // effectively zero confidence
      }
    }
  }

  // tau * Sigma
  const tauSigma = matScale(covMatrix, tau);
  const tauSigmaInv = matInverse(tauSigma);
  const omegaInv = matInverse(omega);

  // P' * Omega^-1
  const Pt = matTranspose(P);
  const PtOmegaInv = matMultiply(Pt, omegaInv);

  // posteriorPrecision = (tau*Sigma)^-1 + P'*Omega^-1*P
  const PtOmegaInvP = matMultiply(PtOmegaInv, P);
  const posteriorPrecision = matAdd(tauSigmaInv, PtOmegaInvP);
  const posteriorCov = matInverse(posteriorPrecision);

  // posteriorReturns = posteriorCov * [(tau*Sigma)^-1*pi + P'*Omega^-1*Q]
  const term1 = matVecMultiply(tauSigmaInv, pi);
  const term2 = matVecMultiply(PtOmegaInv, Q);
  const combinedVec = term1.map((v, i) => v + term2[i]);
  const posteriorReturns = matVecMultiply(posteriorCov, combinedVec);

  // Optimal weights: w* = (delta * Sigma)^-1 * mu_BL
  const deltaSigmaInv = matInverse(matScale(covMatrix, riskAversion));
  const optimalWeights = matVecMultiply(deltaSigmaInv, posteriorReturns);

  return {
    impliedReturns: pi,
    posteriorReturns,
    posteriorCov,
    optimalWeights,
  };
}
