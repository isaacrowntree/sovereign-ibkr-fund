import { describe, it, expect } from 'vitest';
import { riskContributions, riskParityWeights, minVarianceWeights } from './risk-parity';

describe('riskContributions', () => {
  it('sums to portfolio std dev', () => {
    const cov = [[0.04, 0.01], [0.01, 0.09]];
    const weights = [0.6, 0.4];
    const rc = riskContributions(weights, cov);
    const totalRC = rc.reduce((s, v) => s + v, 0);
    // Should sum to portfolio std dev
    const portVar = 0.6*0.6*0.04 + 2*0.6*0.4*0.01 + 0.4*0.4*0.09;
    expect(totalRC).toBeCloseTo(Math.sqrt(portVar), 4);
  });

  it('returns individual risk contributions that are verifiable', () => {
    const cov = [[0.04, 0.01], [0.01, 0.09]];
    const weights = [0.6, 0.4];
    const rc = riskContributions(weights, cov);

    // RC_i = w_i * (Sigma * w)_i / sqrt(w' Sigma w)
    // (Sigma * w)_0 = 0.04*0.6 + 0.01*0.4 = 0.028
    // (Sigma * w)_1 = 0.01*0.6 + 0.09*0.4 = 0.042
    // portVar = 0.6*0.028 + 0.4*0.042 = 0.0336
    // portStd = sqrt(0.0336) = 0.18330...
    // RC_0 = 0.6 * 0.028 / 0.18330 = 0.0168 / 0.18330 = 0.09164
    // RC_1 = 0.4 * 0.042 / 0.18330 = 0.0168 / 0.18330 = 0.09164
    const portStd = Math.sqrt(0.0336);
    expect(rc[0]).toBeCloseTo(0.6 * 0.028 / portStd, 6);
    expect(rc[1]).toBeCloseTo(0.4 * 0.042 / portStd, 6);
  });
});

describe('riskParityWeights', () => {
  it('produces weights that sum to 1', () => {
    const cov = [[0.04, 0.01], [0.01, 0.09]];
    const weights = riskParityWeights(cov);
    expect(weights).toHaveLength(2);
    const sum = weights.reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 4);
  });

  it('all weights positive', () => {
    const cov = [[0.04, 0.005], [0.005, 0.09]];
    const weights = riskParityWeights(cov);
    for (const w of weights) {
      expect(w).toBeGreaterThan(0);
    }
  });

  it('lower vol asset gets higher weight', () => {
    const cov = [[0.01, 0], [0, 0.25]];
    const weights = riskParityWeights(cov);
    expect(weights[0]).toBeGreaterThan(weights[1]);
  });

  it('equal vol assets get equal weights', () => {
    const cov = [[0.04, 0], [0, 0.04]];
    const weights = riskParityWeights(cov);
    expect(weights[0]).toBeCloseTo(weights[1], 2);
  });

  it('achieves equal risk contributions for diagonal covariance', () => {
    // CRITICAL: verify the optimizer actually produces equal risk contributions
    const cov = [[0.04, 0], [0, 0.09]];
    const weights = riskParityWeights(cov);
    const rc = riskContributions(weights, cov);

    // For diagonal cov, risk parity should converge to exactly equal RC
    expect(rc[0]).toBeCloseTo(rc[1], 4);
    // Verify the exact weights: w_0 = 0.6, w_1 = 0.4 for this case
    expect(weights[0]).toBeCloseTo(0.6, 2);
    expect(weights[1]).toBeCloseTo(0.4, 2);
  });

  it('achieves approximately equal risk contributions for 3-asset diagonal', () => {
    const cov = [
      [0.04, 0, 0],
      [0, 0.09, 0],
      [0, 0, 0.16],
    ];
    const weights = riskParityWeights(cov);
    const rc = riskContributions(weights, cov);

    // All three risk contributions should be approximately equal
    expect(rc[0]).toBeCloseTo(rc[1], 3);
    expect(rc[1]).toBeCloseTo(rc[2], 3);
  });
});

describe('minVarianceWeights', () => {
  it('produces weights that sum to 1', () => {
    const cov = [[0.04, 0.01], [0.01, 0.09]];
    const weights = minVarianceWeights(cov);
    const sum = weights.reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('overweights low-variance asset', () => {
    const cov = [[0.01, 0], [0, 0.25]];
    const weights = minVarianceWeights(cov);
    expect(weights[0]).toBeGreaterThan(weights[1]);
  });
});
