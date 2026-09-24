import { describe, it, expect } from 'vitest';
import { stationaryBootstrapMeans, quantile, pairedDifference } from './bootstrap';

describe('stationary block bootstrap', () => {
  it('is deterministic for a seed and centred on the sample mean', () => {
    const x = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 0.01 + 0.001);
    const a = stationaryBootstrapMeans(x, { meanBlock: 20, resamples: 400, seed: 3 });
    const b = stationaryBootstrapMeans(x, { meanBlock: 20, resamples: 400, seed: 3 });
    expect(a).toEqual(b);
    const mean = x.reduce((s, v) => s + v, 0) / x.length;
    expect(quantile(a, 0.5)).toBeCloseTo(mean, 3);
  });

  it('a constant series has no uncertainty', () => {
    const m = stationaryBootstrapMeans(new Array(100).fill(0.002), { meanBlock: 20, resamples: 50, seed: 1 });
    expect(new Set(m.map(v => v.toFixed(12))).size).toBe(1);
  });

  it('blocks widen the interval on a persistent (autocorrelated) series vs block length 1', () => {
    // Regime-like series: long runs of +1/-1 → strong positive autocorrelation.
    const x = Array.from({ length: 1000 }, (_, i) => (Math.floor(i / 50) % 2 === 0 ? 0.01 : -0.01));
    const iid = stationaryBootstrapMeans(x, { meanBlock: 1, resamples: 1000, seed: 9 });
    const blk = stationaryBootstrapMeans(x, { meanBlock: 50, resamples: 1000, seed: 9 });
    const width = (m: number[]) => quantile(m, 0.95) - quantile(m, 0.05);
    expect(width(blk)).toBeGreaterThan(width(iid) * 2);
  });

  it('quantile interpolates', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.05)).toBe(5);
  });

  it('pairedDifference annualises the mean difference and its lower bound', () => {
    const a = Array.from({ length: 300 }, (_, i) => 0.0005 + (i % 7) * 1e-4);
    const b = a.map(v => v - 0.0001); // a beats b by 1bp a day
    const r = pairedDifference(a, b, { meanBlock: 20, resamples: 200, seed: 1, alpha: 0.05 });
    expect(r.annualisedMean).toBeCloseTo(0.0252, 6);
    expect(r.lowerBound).toBeCloseTo(0.0252, 6);
    expect(() => pairedDifference([1], [1, 2], { meanBlock: 1, resamples: 1, seed: 1, alpha: 0.05 })).toThrow();
  });
});
