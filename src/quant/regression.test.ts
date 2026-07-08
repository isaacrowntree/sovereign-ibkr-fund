import { describe, it, expect } from 'vitest';
import { olsRegression, decomposeReturns } from './regression';

describe('olsRegression', () => {
  it('perfect linear y = 2*x + 1 → R²=1.0, beta=[2], alpha=1', () => {
    const y = [3, 5, 7, 9, 11]; // 1 + 2*[1,2,3,4,5]
    const X = [[1], [2], [3], [4], [5]];
    const result = olsRegression(y, X);
    expect(result.alpha).toBeCloseTo(1, 6);
    expect(result.betas[0]).toBeCloseTo(2, 6);
    expect(result.rSquared).toBeCloseTo(1.0, 6);
  });

  it('no relationship → R² low', () => {
    const y = [1, 2, 3, 4];
    const X = [[5], [3], [7], [1]];
    const result = olsRegression(y, X);
    expect(result.rSquared).toBeLessThan(0.5);
  });

  it('multi-factor: y ≈ 0.5*x1 + 0.3*x2 + 1 → recover approximate betas', () => {
    // Generate data with known relationship + no noise
    // Use independent factors (not linearly dependent with intercept)
    const x1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const x2 = [2, 4, 1, 5, 3, 8, 6, 2, 7, 9];
    const y = x1.map((v, i) => 0.5 * v + 0.3 * x2[i] + 1);
    const X = x1.map((v, i) => [v, x2[i]]);
    const result = olsRegression(y, X);
    expect(result.alpha).toBeCloseTo(1, 4);
    expect(result.betas[0]).toBeCloseTo(0.5, 4);
    expect(result.betas[1]).toBeCloseTo(0.3, 4);
    expect(result.rSquared).toBeCloseTo(1.0, 4);
  });

  it('single observation → throw (need n > k+1)', () => {
    expect(() => olsRegression([1], [[2]])).toThrow('Need more observations');
  });

  it('empty arrays → throw', () => {
    expect(() => olsRegression([], [])).toThrow('Empty arrays');
  });

  it('collinear factors → matInverse throws "singular"', () => {
    // x2 = 2 * x1 → perfectly collinear
    const y = [1, 2, 3, 4, 5];
    const X = [[1, 2], [2, 4], [3, 6], [4, 8], [5, 10]];
    expect(() => olsRegression(y, X)).toThrow('singular');
  });
});

describe('decomposeReturns', () => {
  it('decomposition sums to total return', () => {
    const y = [0.01, 0.02, -0.01, 0.03, 0.015, 0.005];
    const X = [[0.005], [0.01], [-0.005], [0.015], [0.008], [0.002]];
    const reg = olsRegression(y, X);
    const decomp = decomposeReturns(y, X, ['market'], reg);

    const sumParts =
      decomp.alphaContribution +
      decomp.factorContributions.reduce((s, f) => s + f.contribution, 0) +
      decomp.residualContribution;

    expect(sumParts).toBeCloseTo(decomp.totalReturn, 6);
  });
});
