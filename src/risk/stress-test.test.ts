import { describe, it, expect } from 'vitest';
import { shockCorrelationMatrix, correlationStressTest } from './stress-test';

describe('shockCorrelationMatrix', () => {
  it('hand-computed 2-asset stress with known vols', () => {
    // vol1=0.2, vol2=0.3, original corr=0.5
    const cov = [[0.04, 0.03], [0.03, 0.09]];
    const shocked = shockCorrelationMatrix(cov, 0.8);

    // Diagonal unchanged
    expect(shocked[0][0]).toBeCloseTo(0.04, 10);
    expect(shocked[1][1]).toBeCloseTo(0.09, 10);
    // Off-diagonal = 0.8 * 0.2 * 0.3 = 0.048
    expect(shocked[0][1]).toBeCloseTo(0.048, 10);
    expect(shocked[1][0]).toBeCloseTo(0.048, 10);
  });

  it('target corr=0 → off-diagonal=0', () => {
    const cov = [[0.04, 0.03], [0.03, 0.09]];
    const shocked = shockCorrelationMatrix(cov, 0);
    expect(shocked[0][1]).toBeCloseTo(0, 10);
    expect(shocked[1][0]).toBeCloseTo(0, 10);
    expect(shocked[0][0]).toBeCloseTo(0.04, 10);
    expect(shocked[1][1]).toBeCloseTo(0.09, 10);
  });

  it('target corr=1 → portfolio vol = weighted sum of stds', () => {
    const cov = [[0.04, 0.01], [0.01, 0.09]];
    const shocked = shockCorrelationMatrix(cov, 1.0);
    const w = [0.5, 0.5];

    // With perfect correlation, portfolio vol = w1*s1 + w2*s2
    // = 0.5*0.2 + 0.5*0.3 = 0.25
    let portfolioVar = 0;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        portfolioVar += w[i] * shocked[i][j] * w[j];
      }
    }
    const portfolioVol = Math.sqrt(portfolioVar);
    const weightedSumStds = 0.5 * 0.2 + 0.5 * 0.3;
    expect(portfolioVol).toBeCloseTo(weightedSumStds, 10);
  });
});

describe('correlationStressTest', () => {
  it('stressed vol ≥ baseline vol (for positive target corr > actual)', () => {
    // Low-correlation cov matrix
    const cov = [[0.04, 0.002], [0.002, 0.09]];
    const w = [0.5, 0.5];
    const result = correlationStressTest(w, cov, 100000, 0.9, 0.95);

    expect(result.stressedVol).toBeGreaterThanOrEqual(result.baselineVol);
    expect(result.stressedVaR).toBeGreaterThanOrEqual(result.baselineVaR);
  });

  it('single asset → no change', () => {
    const cov = [[0.04]];
    const w = [1.0];
    const result = correlationStressTest(w, cov, 100000, 0.9, 0.95);

    // Only one asset, no off-diagonal to shock
    expect(result.stressedVol).toBeCloseTo(result.baselineVol, 10);
    expect(result.stressedVaR).toBeCloseTo(result.baselineVaR, 10);
  });

  it('returns correct portfolio value', () => {
    const cov = [[0.04, 0.01], [0.01, 0.09]];
    const w = [0.6, 0.4];
    const result = correlationStressTest(w, cov, 500000);
    expect(result.portfolioValue).toBe(500000);
  });
});

describe('correlationStressTest dimension guard', () => {
  // A model reweight changes the number of holdings, but historicalReturns is
  // accumulated per-asset and lags behind. On 2026-09-07 the strategist wrote
  // 19 weights while historicalReturns still held 17 assets, and quadraticForm
  // walked off the end of the covariance: "Cannot read properties of undefined
  // (reading '0')". The risk-manager died on it every cycle, which is a bad
  // way to find out — this agent is the one that reports the fund is unwell.
  const cov = [[0.04, 0.01], [0.01, 0.09]];

  it('refuses weights longer than the covariance', () => {
    expect(() => correlationStressTest([0.3, 0.3, 0.4], cov, 10000))
      .toThrow(/3 weights.*2x2|dimension/i);
  });

  it('refuses weights shorter than the covariance', () => {
    expect(() => correlationStressTest([1.0], cov, 10000)).toThrow(/dimension|1 weights/i);
  });

  it('still runs when they agree', () => {
    expect(() => correlationStressTest([0.5, 0.5], cov, 10000)).not.toThrow();
  });
});
