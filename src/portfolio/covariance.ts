/**
 * Covariance matrix estimation with Ledoit-Wolf shrinkage
 */

/** Sample covariance matrix from return series (each row = asset, each col = time) */
export function sampleCovMatrix(returns: number[][]): number[][] {
  const n = returns.length; // number of assets
  const t = returns[0]?.length || 0;
  if (n === 0 || t < 2) return [];

  const means = returns.map(r => r.reduce((s, v) => s + v, 0) / t);
  const cov: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < t; k++) {
        sum += (returns[i][k] - means[i]) * (returns[j][k] - means[j]);
      }
      cov[i][j] = sum / (t - 1);
      cov[j][i] = cov[i][j];
    }
  }
  return cov;
}

/** Correlation matrix from covariance matrix */
export function covToCorr(cov: number[][]): number[][] {
  const n = cov.length;
  const corr: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const stds = cov.map((_, i) => Math.sqrt(cov[i][i]));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      corr[i][j] = stds[i] > 0 && stds[j] > 0
        ? cov[i][j] / (stds[i] * stds[j])
        : i === j ? 1 : 0;
    }
  }
  return corr;
}

/**
 * Ledoit-Wolf shrinkage estimator
 * Shrinks sample covariance toward scaled identity matrix
 * Returns { shrunk, shrinkageIntensity }
 */
export function ledoitWolfShrinkage(returns: number[][]): {
  shrunk: number[][];
  shrinkageIntensity: number;
} {
  const n = returns.length;
  const t = returns[0]?.length || 0;
  if (n === 0 || t < 2) return { shrunk: [], shrinkageIntensity: 0 };

  const sample = sampleCovMatrix(returns);
  const mu = trace(sample) / n; // average variance
  const target = identityScaled(n, mu);

  // Compute optimal shrinkage intensity (simplified Ledoit-Wolf)
  const means = returns.map(r => r.reduce((s, v) => s + v, 0) / t);
  let piSum = 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let pij = 0;
      for (let k = 0; k < t; k++) {
        const xi = (returns[i][k] - means[i]) * (returns[j][k] - means[j]) - sample[i][j];
        pij += xi * xi;
      }
      piSum += pij / t;
    }
  }
  const pi = piSum;

  let gammaSum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      gammaSum += (target[i][j] - sample[i][j]) ** 2;
    }
  }

  const delta = Math.max(0, Math.min(1, (pi / t) / gammaSum));
  const shrunk = matAdd(matScale(target, delta), matScale(sample, 1 - delta));

  return { shrunk, shrinkageIntensity: delta };
}

// Matrix utilities
export function trace(m: number[][]): number {
  return m.reduce((s, row, i) => s + row[i], 0);
}

export function identityScaled(n: number, scale: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => i === j ? scale : 0)
  );
}

export function matScale(m: number[][], s: number): number[][] {
  return m.map(row => row.map(v => v * s));
}

export function matAdd(a: number[][], b: number[][]): number[][] {
  return a.map((row, i) => row.map((v, j) => v + b[i][j]));
}

/** Matrix multiplication: a (m x p) * b (p x n) → (m x n) */
export function matMultiply(a: number[][], b: number[][]): number[][] {
  const m = a.length;
  const p = b.length;
  const n = b[0]?.length || 0;
  const result: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < p; k++) {
        sum += a[i][k] * b[k][j];
      }
      result[i][j] = sum;
    }
  }
  return result;
}

/** Transpose of a matrix */
export function matTranspose(a: number[][]): number[][] {
  const m = a.length;
  const n = a[0]?.length || 0;
  const result: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      result[j][i] = a[i][j];
    }
  }
  return result;
}

/** Matrix inverse using Gauss-Jordan elimination */
export function matInverse(a: number[][]): number[][] {
  const n = a.length;
  // Build augmented matrix [A | I]
  const aug: number[][] = a.map((row, i) => [
    ...row.map(v => v),
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) {
      throw new Error('Matrix is singular or nearly singular');
    }
    if (maxRow !== col) {
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    }

    // Scale pivot row
    const pivot = aug[col][col];
    for (let j = 0; j < 2 * n; j++) {
      aug[col][j] /= pivot;
    }

    // Eliminate column
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Extract right half
  return aug.map(row => row.slice(n));
}

/** Matrix-vector multiply: m (n x p) * v (p) → (n) */
export function matVecMultiply(m: number[][], v: number[]): number[] {
  return m.map(row => row.reduce((sum, val, j) => sum + val * v[j], 0));
}
