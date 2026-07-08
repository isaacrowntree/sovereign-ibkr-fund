import { describe, it, expect } from 'vitest';
import { historicalVaR, parametricVaR, conditionalVaR, portfolioVaR, normalInvCDF, normalCDF, quadraticForm } from './var';

describe('VaR', () => {
  const returns = [-0.05, -0.03, -0.02, -0.01, 0.0, 0.01, 0.02, 0.03, 0.04, 0.05,
    -0.04, -0.01, 0.01, 0.02, 0.03, 0.0, -0.02, 0.01, 0.04, 0.02];

  // Sorted returns: [-0.05, -0.04, -0.03, -0.02, -0.02, -0.01, -0.01, 0.0, 0.0, 0.01,
  //   0.01, 0.01, 0.02, 0.02, 0.02, 0.03, 0.03, 0.04, 0.04, 0.05]

  it('historicalVaR returns exact 5th percentile loss', () => {
    // idx = floor(0.05 * 20) = 1, sorted[1] = -0.04, VaR = -(-0.04) = 0.04
    const var95 = historicalVaR(returns, 0.95);
    expect(var95).toBe(0.04);
  });

  it('historicalVaR at lower confidence is smaller', () => {
    const var90 = historicalVaR(returns, 0.90);
    const var95 = historicalVaR(returns, 0.95);
    expect(var90).toBeLessThanOrEqual(var95);
  });

  it('historicalVaR returns 0 for empty returns', () => {
    expect(historicalVaR([])).toBe(0);
  });

  it('conditionalVaR equals exact average of tail below VaR', () => {
    // cutoffIdx = floor(0.05 * 20) = 1, tail = sorted.slice(0, 1) = [-0.05]
    // avg = -0.05, CVaR = -(-0.05) = 0.05
    const cvar = conditionalVaR(returns, 0.95);
    expect(cvar).toBe(0.05);
  });

  it('conditionalVaR >= historicalVaR', () => {
    const cvar = conditionalVaR(returns, 0.95);
    const var95 = historicalVaR(returns, 0.95);
    expect(cvar).toBeGreaterThanOrEqual(var95);
  });

  it('conditionalVaR returns 0 for empty returns', () => {
    expect(conditionalVaR([])).toBe(0);
  });

  it('parametricVaR computes correctly', () => {
    const var95 = parametricVaR(0.001, 0.02, 0.95);
    expect(var95).toBeCloseTo(0.02 * 1.645 - 0.001, 3);
  });

  it('portfolioVaR with diagonal covariance and equal weights', () => {
    // cov = [[0.04, 0], [0, 0.04]], weights = [0.5, 0.5]
    // portVar = 0.25*0.04 + 0.25*0.04 = 0.02
    // portStd = sqrt(0.02) = 0.14142...
    // z(0.95) = 1.64485..., VaR = 1.64485 * 0.14142 * 100000 = 23261.74
    const cov = [[0.04, 0], [0, 0.04]];
    const weights = [0.5, 0.5];
    const pvar = portfolioVaR(weights, cov, 100000, 0.95);
    expect(pvar).toBeCloseTo(23261.74, 0);
  });
});

describe('normalInvCDF', () => {
  it('returns 0 for p=0.5', () => {
    expect(normalInvCDF(0.5)).toBe(0);
  });

  it('returns ~1.645 for p=0.95', () => {
    expect(normalInvCDF(0.95)).toBeCloseTo(1.645, 2);
  });

  it('returns ~-1.645 for p=0.05', () => {
    expect(normalInvCDF(0.05)).toBeCloseTo(-1.645, 2);
  });

  it('returns ~2.326 for p=0.99', () => {
    expect(normalInvCDF(0.99)).toBeCloseTo(2.326, 2);
  });

  it('returns -Infinity for p=0', () => {
    expect(normalInvCDF(0)).toBe(-Infinity);
  });

  it('returns Infinity for p=1', () => {
    expect(normalInvCDF(1)).toBe(Infinity);
  });
});

describe('normalCDF', () => {
  it('returns 0.5 for x=0', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 6);
  });

  it('returns ~0.95 for x=1.645', () => {
    expect(normalCDF(1.645)).toBeCloseTo(0.95, 2);
  });

  it('returns ~0.05 for x=-1.645', () => {
    expect(normalCDF(-1.645)).toBeCloseTo(0.05, 2);
  });
});

describe('quadraticForm', () => {
  it('computes w\'Mw correctly', () => {
    const w = [0.6, 0.4];
    const M = [[0.04, 0.01], [0.01, 0.09]];
    // 0.6*0.6*0.04 + 2*0.6*0.4*0.01 + 0.4*0.4*0.09 = 0.0144 + 0.0048 + 0.0144 = 0.0336
    expect(quadraticForm(w, M)).toBeCloseTo(0.0336, 6);
  });
});
