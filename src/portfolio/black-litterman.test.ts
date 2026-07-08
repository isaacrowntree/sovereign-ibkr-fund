import { describe, it, expect } from 'vitest';
import { impliedReturns, blackLitterman } from './black-litterman';

describe('impliedReturns', () => {
  it('equal weights + identity cov → all equal', () => {
    const cov = [[1, 0], [0, 1]];
    const w = [0.5, 0.5];
    const pi = impliedReturns(cov, w, 2.5);
    expect(pi[0]).toBeCloseTo(1.25, 10);
    expect(pi[1]).toBeCloseTo(1.25, 10);
  });

  it('hand-computed 2-asset case', () => {
    const Sigma = [[0.04, 0.01], [0.01, 0.09]];
    const w = [0.6, 0.4];
    const delta = 2.5;
    // pi = 2.5 * Sigma * w
    // pi[0] = 2.5 * (0.04*0.6 + 0.01*0.4) = 2.5 * 0.028 = 0.07
    // pi[1] = 2.5 * (0.01*0.6 + 0.09*0.4) = 2.5 * 0.042 = 0.105
    const pi = impliedReturns(Sigma, w, delta);
    expect(pi[0]).toBeCloseTo(0.07, 10);
    expect(pi[1]).toBeCloseTo(0.105, 10);
  });
});

describe('blackLitterman', () => {
  const Sigma = [[0.04, 0.01], [0.01, 0.09]];
  const w = [0.6, 0.4];
  const delta = 2.5;
  const tau = 0.05;

  it('no views → posterior ≈ implied returns', () => {
    // With a near-zero view (identity P, Q = pi, huge omega), posterior should be close to pi
    const pi = impliedReturns(Sigma, w, delta);
    const result = blackLitterman(Sigma, w, {
      P: [[1, 0], [0, 1]],
      Q: pi,
      omega: [[1e10, 0], [0, 1e10]], // very uncertain views = no information
    }, delta, tau);

    expect(result.posteriorReturns[0]).toBeCloseTo(pi[0], 3);
    expect(result.posteriorReturns[1]).toBeCloseTo(pi[1], 3);
  });

  it('absolute view tilts weights toward that asset', () => {
    // View: asset 0 will return 15% (higher than implied ~7%)
    const result = blackLitterman(Sigma, w, {
      P: [[1, 0]],
      Q: [0.15],
    }, delta, tau);

    // Optimal weight for asset 0 should be higher than market weight 0.6
    expect(result.optimalWeights[0]).toBeGreaterThan(0.6);
  });

  it('relative view (asset A outperforms B by 2%)', () => {
    // View: asset 0 outperforms asset 1 by 2%
    const result = blackLitterman(Sigma, w, {
      P: [[1, -1]],
      Q: [0.02],
    }, delta, tau);

    // Posterior return difference should reflect the view
    const pi = impliedReturns(Sigma, w, delta);
    const priorDiff = pi[0] - pi[1];
    const posteriorDiff = result.posteriorReturns[0] - result.posteriorReturns[1];
    // The view says 2% outperformance; prior diff is 0.07-0.105 = -0.035
    // Posterior diff should be pulled toward +0.02 (i.e. higher than prior diff)
    expect(posteriorDiff).toBeGreaterThan(priorDiff);
  });

  it('confidence=0 → view ignored (posterior ≈ implied)', () => {
    const pi = impliedReturns(Sigma, w, delta);
    const result = blackLitterman(Sigma, w, {
      P: [[1, 0]],
      Q: [0.50], // extreme view
      confidence: [0], // zero confidence
    }, delta, tau);

    expect(result.posteriorReturns[0]).toBeCloseTo(pi[0], 2);
    expect(result.posteriorReturns[1]).toBeCloseTo(pi[1], 2);
  });

  it('impliedReturns are returned in the result', () => {
    const result = blackLitterman(Sigma, w, {
      P: [[1, 0]],
      Q: [0.10],
    }, delta, tau);

    expect(result.impliedReturns[0]).toBeCloseTo(0.07, 10);
    expect(result.impliedReturns[1]).toBeCloseTo(0.105, 10);
  });
});
