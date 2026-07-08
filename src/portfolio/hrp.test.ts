import { describe, it, expect } from 'vitest';
import { correlationDistance, singleLinkageClustering, hrpWeights } from './hrp';

describe('correlationDistance', () => {
  it('returns 0 distance for perfect correlation', () => {
    const corr = [[1, 1], [1, 1]];
    const dist = correlationDistance(corr);
    expect(dist[0][1]).toBeCloseTo(0, 6);
  });

  it('returns max distance for perfect negative correlation', () => {
    const corr = [[1, -1], [-1, 1]];
    const dist = correlationDistance(corr);
    expect(dist[0][1]).toBeCloseTo(1, 6);
  });

  it('returns ~0.707 for zero correlation', () => {
    const corr = [[1, 0], [0, 1]];
    const dist = correlationDistance(corr);
    expect(dist[0][1]).toBeCloseTo(Math.sqrt(0.5), 3);
  });
});

describe('singleLinkageClustering', () => {
  it('clusters closest pair first in known distance matrix', () => {
    // dist: A-B=0.5, A-C=0.8, B-C=0.3
    // First merge: B and C (distance 0.3)
    // Then merge: A with {B,C}
    const dist = [
      [0, 0.5, 0.8],
      [0.5, 0, 0.3],
      [0.8, 0.3, 0],
    ];
    const order = singleLinkageClustering(dist);
    expect(order).toHaveLength(3);
    // All indices present
    expect(order.sort()).toEqual([0, 1, 2]);
  });

  it('handles 2x2 distance matrix', () => {
    const dist = [[0, 0.5], [0.5, 0]];
    const order = singleLinkageClustering(dist);
    expect(order).toHaveLength(2);
    expect(order.sort()).toEqual([0, 1]);
  });

  it('handles zero-distance (perfectly correlated assets)', () => {
    const dist = [[0, 0], [0, 0]];
    const order = singleLinkageClustering(dist);
    expect(order).toHaveLength(2);
    expect(order.sort()).toEqual([0, 1]);
  });
});

describe('hrpWeights', () => {
  it('produces weights that sum to 1', () => {
    const cov = [
      [0.04, 0.01, 0.005],
      [0.01, 0.09, 0.02],
      [0.005, 0.02, 0.16],
    ];
    const { weights } = hrpWeights(cov);
    expect(weights).toHaveLength(3);
    const sum = weights.reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('all weights are positive', () => {
    const cov = [
      [0.04, 0.01, 0.005],
      [0.01, 0.09, 0.02],
      [0.005, 0.02, 0.16],
    ];
    const { weights } = hrpWeights(cov);
    for (const w of weights) {
      expect(w).toBeGreaterThan(0);
    }
  });

  it('computes exact weights for 2x2 diagonal covariance', () => {
    // cov = [[0.01, 0], [0, 0.25]]
    // corr = [[1, 0], [0, 1]], dist = [[0, sqrt(0.5)], [sqrt(0.5), 0]]
    // clustering order = [0, 1]
    // recursiveBisection: vl=0.01, vr=0.25
    //   alpha = 1 - 0.01/(0.01+0.25) = 1 - 1/26 = 25/26 = 0.96154
    //   weights[0] = 25/26, weights[1] = 1/26
    const cov = [
      [0.01, 0],
      [0, 0.25],
    ];
    const { weights } = hrpWeights(cov);
    expect(weights[0]).toBeCloseTo(25 / 26, 4); // 0.96154
    expect(weights[1]).toBeCloseTo(1 / 26, 4);  // 0.03846
    expect(weights[0]).toBeGreaterThan(weights[1]);
  });

  it('handles single asset', () => {
    const { weights } = hrpWeights([[0.04]]);
    expect(weights).toEqual([1]);
  });

  it('handles perfectly correlated assets (distance=0)', () => {
    // Perfectly correlated: corr = [[1, 1], [1, 1]]
    // This means cov must have cov[0][1] = sqrt(cov[0][0]*cov[1][1])
    // e.g., cov = [[0.04, 0.06], [0.06, 0.09]] where 0.06 = sqrt(0.04*0.09) = 0.2*0.3 = 0.06
    const cov = [
      [0.04, 0.06],
      [0.06, 0.09],
    ];
    const { weights } = hrpWeights(cov);
    expect(weights).toHaveLength(2);
    const sum = weights.reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 6);
    // Lower variance asset should get more weight
    expect(weights[0]).toBeGreaterThan(weights[1]);
  });
});
