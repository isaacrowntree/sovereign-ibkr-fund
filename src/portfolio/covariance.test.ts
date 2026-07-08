import { describe, it, expect } from 'vitest';
import { sampleCovMatrix, covToCorr, ledoitWolfShrinkage, matMultiply, matTranspose, matInverse, matVecMultiply } from './covariance';

describe('sampleCovMatrix', () => {
  it('computes exact 2x2 covariance matrix', () => {
    const returns = [
      [0.01, -0.01, 0.02, -0.02, 0.01],
      [0.02, -0.02, 0.01, -0.01, 0.02],
    ];
    // mean1 = 0.002, mean2 = 0.004
    // cov[0][0] = sum((r1-m1)^2)/4 = 0.00027
    // cov[0][1] = sum((r1-m1)(r2-m2))/4 = 0.00024
    // cov[1][1] = sum((r2-m2)^2)/4 = 0.00033
    const cov = sampleCovMatrix(returns);
    expect(cov).toHaveLength(2);
    expect(cov[0]).toHaveLength(2);
    expect(cov[0][0]).toBeCloseTo(0.00027, 6);
    expect(cov[0][1]).toBeCloseTo(0.00024, 6);
    expect(cov[1][0]).toBeCloseTo(0.00024, 6); // symmetric
    expect(cov[1][1]).toBeCloseTo(0.00033, 6);
  });

  it('returns empty for empty input', () => {
    expect(sampleCovMatrix([])).toEqual([]);
  });

  it('diagonal equals variance', () => {
    const returns = [[1, 2, 3, 4, 5]];
    const cov = sampleCovMatrix(returns);
    // Variance of [1,2,3,4,5] with mean 3: (4+1+0+1+4)/4 = 2.5
    expect(cov[0][0]).toBeCloseTo(2.5, 6);
  });
});

describe('covToCorr', () => {
  it('diagonal is 1.0', () => {
    const cov = [[0.04, 0.01], [0.01, 0.09]];
    const corr = covToCorr(cov);
    expect(corr[0][0]).toBeCloseTo(1.0, 6);
    expect(corr[1][1]).toBeCloseTo(1.0, 6);
  });

  it('off-diagonal between -1 and 1', () => {
    const cov = [[0.04, 0.01], [0.01, 0.09]];
    const corr = covToCorr(cov);
    expect(corr[0][1]).toBeGreaterThanOrEqual(-1);
    expect(corr[0][1]).toBeLessThanOrEqual(1);
    // corr = 0.01 / (0.2 * 0.3) = 0.1667
    expect(corr[0][1]).toBeCloseTo(0.1667, 3);
  });
});

describe('matMultiply', () => {
  it('multiplies 2x2 identity by matrix', () => {
    const I = [[1, 0], [0, 1]];
    const A = [[3, 4], [5, 6]];
    const result = matMultiply(I, A);
    expect(result).toEqual([[3, 4], [5, 6]]);
  });

  it('multiplies 2x3 by 3x2', () => {
    const A = [[1, 2, 3], [4, 5, 6]];
    const B = [[7, 8], [9, 10], [11, 12]];
    const result = matMultiply(A, B);
    // [1*7+2*9+3*11, 1*8+2*10+3*12] = [58, 64]
    // [4*7+5*9+6*11, 4*8+5*10+6*12] = [139, 154]
    expect(result).toEqual([[58, 64], [139, 154]]);
  });
});

describe('matTranspose', () => {
  it('transposes a 2x3 matrix', () => {
    const A = [[1, 2, 3], [4, 5, 6]];
    const result = matTranspose(A);
    expect(result).toEqual([[1, 4], [2, 5], [3, 6]]);
  });

  it('transpose of transpose is original', () => {
    const A = [[1, 2], [3, 4]];
    expect(matTranspose(matTranspose(A))).toEqual(A);
  });
});

describe('matInverse', () => {
  it('inverts a 2x2 matrix', () => {
    const A = [[4, 7], [2, 6]];
    const inv = matInverse(A);
    // det = 24 - 14 = 10, inv = [[0.6, -0.7], [-0.2, 0.4]]
    expect(inv[0][0]).toBeCloseTo(0.6, 6);
    expect(inv[0][1]).toBeCloseTo(-0.7, 6);
    expect(inv[1][0]).toBeCloseTo(-0.2, 6);
    expect(inv[1][1]).toBeCloseTo(0.4, 6);
  });

  it('A * A^-1 = I', () => {
    const A = [[2, 1], [5, 3]];
    const inv = matInverse(A);
    const product = matMultiply(A, inv);
    expect(product[0][0]).toBeCloseTo(1, 10);
    expect(product[0][1]).toBeCloseTo(0, 10);
    expect(product[1][0]).toBeCloseTo(0, 10);
    expect(product[1][1]).toBeCloseTo(1, 10);
  });

  it('throws for singular matrix', () => {
    const A = [[1, 2], [2, 4]];
    expect(() => matInverse(A)).toThrow('singular');
  });
});

describe('matVecMultiply', () => {
  it('multiplies identity by vector', () => {
    const I = [[1, 0], [0, 1]];
    expect(matVecMultiply(I, [3, 5])).toEqual([3, 5]);
  });

  it('multiplies 2x2 by vector', () => {
    const A = [[2, 3], [4, 5]];
    // [2*1+3*2, 4*1+5*2] = [8, 14]
    expect(matVecMultiply(A, [1, 2])).toEqual([8, 14]);
  });
});

describe('ledoitWolfShrinkage', () => {
  it('returns shrinkage intensity between 0 and 1', () => {
    const returns = [
      [0.01, -0.01, 0.02, -0.02, 0.01, 0.03, -0.01, 0.0],
      [0.02, -0.02, 0.01, -0.01, 0.02, -0.01, 0.01, 0.0],
      [-0.01, 0.01, 0.015, -0.015, 0.005, 0.02, -0.005, 0.01],
    ];
    const { shrunk, shrinkageIntensity } = ledoitWolfShrinkage(returns);
    expect(shrinkageIntensity).toBeGreaterThanOrEqual(0);
    expect(shrinkageIntensity).toBeLessThanOrEqual(1);
    expect(shrunk).toHaveLength(3);
    expect(shrunk[0]).toHaveLength(3);
  });

  it('shrunk matrix is symmetric', () => {
    const returns = [
      [0.01, -0.01, 0.02, -0.02],
      [0.02, -0.02, 0.01, -0.01],
    ];
    const { shrunk } = ledoitWolfShrinkage(returns);
    expect(shrunk[0][1]).toBeCloseTo(shrunk[1][0], 10);
  });

  it('shrunk diagonal is between sample diagonal and target (mu)', () => {
    const returns = [
      [0.01, -0.01, 0.02, -0.02],
      [0.02, -0.02, 0.01, -0.01],
    ];
    const { shrunk, shrinkageIntensity } = ledoitWolfShrinkage(returns);
    const sample = sampleCovMatrix(returns);
    const mu = (sample[0][0] + sample[1][1]) / 2;

    // shrunk[i][i] = delta * mu + (1 - delta) * sample[i][i]
    // When sample diags are equal, shrunk diag = sample diag = mu
    // For this symmetric data, both sample diags = 1/3 * 10^-3
    // mu = average of diags, so when diags are equal, shrunk = sample
    // In general: shrunk diagonal lies between sample diagonal and mu
    for (let i = 0; i < 2; i++) {
      const lo = Math.min(sample[i][i], mu);
      const hi = Math.max(sample[i][i], mu);
      // Allow small floating point tolerance
      expect(shrunk[i][i]).toBeGreaterThanOrEqual(lo - 1e-12);
      expect(shrunk[i][i]).toBeLessThanOrEqual(hi + 1e-12);
    }
  });
});
