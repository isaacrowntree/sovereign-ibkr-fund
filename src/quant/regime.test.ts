import { describe, it, expect } from 'vitest';
import { trendSignal, trendStrengthSignal, momentumBreadthSignal, volRegimeSignal, volExpansionSignal, correlationSignal, compositeRegime, regimeExposure, type OHLCBar } from './regime';

describe('trendSignal', () => {
  it('returns 1 for strong uptrend', () => {
    const prices = Array.from({ length: 250 }, (_, i) => 100 + i);
    expect(trendSignal(prices)).toBe(1);
  });

  it('returns -1 for strong downtrend', () => {
    const prices = Array.from({ length: 250 }, (_, i) => 500 - i);
    expect(trendSignal(prices)).toBe(-1);
  });

  it('returns 0 for insufficient data', () => {
    expect(trendSignal([100, 101])).toBe(0);
  });
});

describe('trendStrengthSignal', () => {
  it('returns 1 when majority of stocks trend strongly (per-stock OHLC)', () => {
    // 3 stocks, all trending up strongly
    const stocks: OHLCBar[][] = [
      Array.from({ length: 200 }, (_, i) => ({ high: 102 + i * 2, low: 98 + i * 2, close: 100 + i * 2 })),
      Array.from({ length: 200 }, (_, i) => ({ high: 52 + i, low: 48 + i, close: 50 + i })),
      Array.from({ length: 200 }, (_, i) => ({ high: 202 + i * 3, low: 198 + i * 3, close: 200 + i * 3 })),
    ];
    expect(trendStrengthSignal(stocks)).toBe(1);
  });

  it('returns 1 when majority of close-only series trend strongly', () => {
    const stocks: number[][] = [
      Array.from({ length: 200 }, (_, i) => 100 + i * 2),
      Array.from({ length: 200 }, (_, i) => 50 + i),
      Array.from({ length: 200 }, (_, i) => 200 + i * 3),
    ];
    expect(trendStrengthSignal(stocks)).toBe(1);
  });

  it('handles single series (backward compat)', () => {
    const prices = Array.from({ length: 200 }, (_, i) => 100 + i * 2);
    expect(trendStrengthSignal(prices)).toBe(1);
  });

  it('returns 0 for insufficient data', () => {
    expect(trendStrengthSignal([100, 101, 102])).toBe(0);
  });
});

describe('momentumBreadthSignal', () => {
  it('returns 1 when >70% of stocks above 50d MA', () => {
    const stocks = [
      Array.from({ length: 100 }, (_, i) => 100 + i),     // above
      Array.from({ length: 100 }, (_, i) => 200 + i),     // above
      Array.from({ length: 100 }, (_, i) => 300 + i),     // above
      Array.from({ length: 100 }, (_, i) => 400 - i * 3), // below
    ];
    expect(momentumBreadthSignal(stocks)).toBe(1); // 3/4 = 75% above
  });

  it('returns -1 when <30% above 50d MA', () => {
    const stocks = [
      Array.from({ length: 100 }, (_, i) => 400 - i * 3), // below
      Array.from({ length: 100 }, (_, i) => 300 - i * 2), // below
      Array.from({ length: 100 }, (_, i) => 200 - i),     // below
      Array.from({ length: 100 }, (_, i) => 100 + i),     // above
    ];
    expect(momentumBreadthSignal(stocks)).toBe(-1); // 1/4 = 25% above
  });

  it('returns 0 for mixed', () => {
    const stocks = [
      Array.from({ length: 100 }, (_, i) => 100 + i),
      Array.from({ length: 100 }, (_, i) => 200 - i),
    ];
    expect(momentumBreadthSignal(stocks)).toBe(0); // 50%
  });
});

describe('volRegimeSignal', () => {
  it('returns 1 for low vol', () => {
    expect(volRegimeSignal(10)).toBe(1);
  });

  it('returns 0 for normal vol', () => {
    expect(volRegimeSignal(20)).toBe(0);
  });

  it('returns -1 for high vol', () => {
    expect(volRegimeSignal(35)).toBe(-1);
  });
});

describe('volExpansionSignal', () => {
  it('returns -1 when recent vol spikes', () => {
    const calm = Array.from({ length: 40 }, () => 0.001 * (Math.random() - 0.5));
    const spike = Array.from({ length: 20 }, () => 0.05 * (Math.random() - 0.5));
    expect(volExpansionSignal([...calm, ...spike])).toBe(-1);
  });

  it('returns 1 when vol is contracting', () => {
    const volatile = Array.from({ length: 40 }, () => 0.05 * (Math.random() - 0.5));
    const calm = Array.from({ length: 20 }, () => 0.001 * (Math.random() - 0.5));
    expect(volExpansionSignal([...volatile, ...calm])).toBe(1);
  });

  it('returns 0 for insufficient data', () => {
    expect(volExpansionSignal([0.01, 0.02])).toBe(0);
  });
});

describe('correlationSignal', () => {
  it('returns 1 for low correlation', () => {
    expect(correlationSignal([[1, 0.1], [0.1, 1]])).toBe(1);
  });

  it('returns -1 for high correlation', () => {
    expect(correlationSignal([[1, 0.8], [0.8, 1]])).toBe(-1);
  });

  it('returns 0 for moderate correlation', () => {
    expect(correlationSignal([[1, 0.45], [0.45, 1]])).toBe(0);
  });
});

describe('compositeRegime', () => {
  it('risk_on when all positive (score >= 2)', () => {
    const result = compositeRegime({ trend: 1, trendStrength: 1, momentum: 1, volatility: 1, volExpansion: 1, correlation: 1 });
    expect(result.composite).toBe('risk_on');
    expect(result.score).toBe(6);
  });

  it('crisis when all negative', () => {
    const result = compositeRegime({ trend: -1, trendStrength: -1, momentum: -1, volatility: -1, volExpansion: -1, correlation: -1 });
    expect(result.composite).toBe('crisis');
    expect(result.score).toBe(-6);
  });

  it('neutral for mixed signals', () => {
    const result = compositeRegime({ trend: 1, volatility: 0, correlation: -1 });
    expect(result.composite).toBe('neutral');
  });

  it('backward compatible with 3-signal version', () => {
    const result = compositeRegime({ trend: 1, volatility: 1, correlation: 1 });
    expect(result.composite).toBe('risk_on');
    expect(result.score).toBe(3);
  });

  it('risk_on with 2 net positive signals', () => {
    const result = compositeRegime({ trend: 1, volatility: 1, correlation: 0 });
    expect(result.composite).toBe('risk_on');
  });
});

describe('regimeExposure', () => {
  it('returns correct multipliers', () => {
    expect(regimeExposure('risk_on')).toBe(1.0);
    expect(regimeExposure('neutral')).toBe(0.85);
    expect(regimeExposure('risk_off')).toBe(0.6);
    expect(regimeExposure('crisis')).toBe(0.3);
  });
});
