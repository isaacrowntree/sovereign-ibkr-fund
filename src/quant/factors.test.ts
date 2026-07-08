import { describe, it, expect } from 'vitest';
import { momentumScore, highProximity, valueScore, qualityScore, lowVolScore, zScoreNormalize, compositeScore } from './factors';

describe('momentumScore', () => {
  it('returns exact value for linear price series', () => {
    // prices[i] = 100 + i*0.1 for i=0..259
    // recent = prices[238] = 100 + 23.8 = 123.8
    // yearAgo = prices[8] = 100 + 0.8 = 100.8
    // momentum = (123.8 - 100.8) / 100.8 = 23/100.8 = 0.22817...
    const prices = Array.from({ length: 260 }, (_, i) => 100 + i * 0.1);
    expect(momentumScore(prices)).toBeCloseTo(23 / 100.8, 6);
  });

  it('returns positive for uptrend', () => {
    const prices = Array.from({ length: 260 }, (_, i) => 100 + i * 0.1);
    expect(momentumScore(prices)).toBeGreaterThan(0);
  });

  it('returns negative for downtrend', () => {
    const prices = Array.from({ length: 260 }, (_, i) => 200 - i * 0.1);
    expect(momentumScore(prices)).toBeLessThan(0);
  });

  it('returns 0 for insufficient data', () => {
    expect(momentumScore([100, 101, 102])).toBe(0);
  });
});

describe('highProximity', () => {
  it('returns 1.0 when price is at 52-week high', () => {
    // Monotonically increasing prices: last price IS the high
    const prices = Array.from({ length: 260 }, (_, i) => 100 + i * 0.1);
    expect(highProximity(prices)).toBeCloseTo(1.0, 6);
  });

  it('returns value less than 1 for declining prices', () => {
    // Declining: last price < 52wk high
    const prices = Array.from({ length: 260 }, (_, i) => 200 - i * 0.1);
    const result = highProximity(prices);
    expect(result).toBeLessThan(1);
    expect(result).toBeGreaterThan(0);
    // last = 200 - 259*0.1 = 174.1, last 252 from index 8: high = 200 - 0.8 = 199.2
    // proximity = 174.1 / 199.2 = 0.87399...
    expect(result).toBeCloseTo(174.1 / 199.2, 3);
  });

  it('returns 0 for insufficient data', () => {
    expect(highProximity([100, 101, 102])).toBe(0);
  });
});

describe('valueScore', () => {
  it('higher for lower P/E', () => {
    expect(valueScore(10)).toBeGreaterThan(valueScore(20));
  });

  it('returns 0 for negative P/E', () => {
    expect(valueScore(-5)).toBe(0);
  });

  it('returns 0 for extreme P/E', () => {
    expect(valueScore(300)).toBe(0);
  });
});

describe('qualityScore', () => {
  it('returns 1.0 for 30% ROE', () => {
    expect(qualityScore(30)).toBeCloseTo(1.0, 6);
  });

  it('returns 0.5 for 15% ROE', () => {
    expect(qualityScore(15)).toBeCloseTo(0.5, 6);
  });

  it('clamps to 0 for negative ROE', () => {
    expect(qualityScore(-10)).toBe(0);
  });
});

describe('lowVolScore', () => {
  it('higher for lower volatility', () => {
    const lowVol = [0.001, -0.001, 0.001, -0.001, 0.001, -0.001, 0.001, -0.001, 0.001, -0.001,
      0.001, -0.001, 0.001, -0.001, 0.001, -0.001, 0.001, -0.001, 0.001, -0.001];
    const highVol = [0.05, -0.05, 0.05, -0.05, 0.05, -0.05, 0.05, -0.05, 0.05, -0.05,
      0.05, -0.05, 0.05, -0.05, 0.05, -0.05, 0.05, -0.05, 0.05, -0.05];
    expect(lowVolScore(lowVol)).toBeGreaterThan(lowVolScore(highVol));
  });

  it('returns 0 for insufficient data', () => {
    expect(lowVolScore([0.01])).toBe(0);
  });
});

describe('zScoreNormalize', () => {
  it('produces mean ~0', () => {
    const values = [10, 20, 30, 40, 50];
    const z = zScoreNormalize(values);
    const mean = z.reduce((s, v) => s + v, 0) / z.length;
    expect(mean).toBeCloseTo(0, 6);
  });

  it('produces std ~1', () => {
    const values = [10, 20, 30, 40, 50];
    const z = zScoreNormalize(values);
    const mean = z.reduce((s, v) => s + v, 0) / z.length;
    const std = Math.sqrt(z.reduce((s, v) => s + (v - mean) ** 2, 0) / z.length);
    expect(std).toBeCloseTo(1, 6);
  });

  it('handles empty array', () => {
    expect(zScoreNormalize([])).toEqual([]);
  });

  it('handles constant values', () => {
    const z = zScoreNormalize([5, 5, 5]);
    expect(z).toEqual([0, 0, 0]);
  });
});

describe('compositeScore', () => {
  it('returns weighted sum with default weights', () => {
    const score = compositeScore(1, 1, 1, 1);
    // default weights: 0.3 + 0.25 + 0.25 + 0.2 = 1.0
    expect(score).toBeCloseTo(1.0, 6);
  });

  it('handles negative factors', () => {
    const score = compositeScore(-1, -1, -1, -1);
    expect(score).toBeCloseTo(-1.0, 6);
  });

  it('computes exact value with custom weights', () => {
    // 1.0*0.5 + 0.5*0.2 + (-0.5)*0.2 + 0.0*0.1 = 0.5 + 0.1 - 0.1 + 0 = 0.5
    const score = compositeScore(1.0, 0.5, -0.5, 0.0, {
      momentum: 0.5, value: 0.2, quality: 0.2, lowVol: 0.1,
    });
    expect(score).toBeCloseTo(0.5, 6);
  });

  it('weights factors differently with custom weights', () => {
    // momentum-only: 2.0*1.0 + 0*0 + 0*0 + 0*0 = 2.0
    const momentumOnly = compositeScore(2.0, 0.0, 0.0, 0.0, {
      momentum: 1.0, value: 0.0, quality: 0.0, lowVol: 0.0,
    });
    expect(momentumOnly).toBeCloseTo(2.0, 6);
  });
});
