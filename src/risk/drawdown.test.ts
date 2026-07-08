import { describe, it, expect } from 'vitest';
import { assessDrawdown, maxDrawdown, drawdownExposureMultiplier, cppiExposure, DEFAULT_LIMITS } from './drawdown';

describe('assessDrawdown', () => {
  it('returns normal when no drawdown', () => {
    const state = assessDrawdown(100, 100);
    expect(state.level).toBe('normal');
    expect(state.drawdownPct).toBe(0);
  });

  it('returns warning at 5% drawdown', () => {
    const state = assessDrawdown(95, 100);
    expect(state.level).toBe('warning');
    expect(state.drawdownPct).toBe(5);
  });

  it('returns derisking at 10% drawdown', () => {
    const state = assessDrawdown(90, 100);
    expect(state.level).toBe('derisking');
    expect(state.drawdownPct).toBe(10);
  });

  it('returns stopped at 15% drawdown', () => {
    const state = assessDrawdown(85, 100);
    expect(state.level).toBe('stopped');
    expect(state.drawdownPct).toBe(15);
  });

  it('updates peak if current > previous peak', () => {
    const state = assessDrawdown(110, 100);
    expect(state.peak).toBe(110);
    expect(state.level).toBe('normal');
  });
});

describe('maxDrawdown', () => {
  it('computes max drawdown from series', () => {
    const values = [100, 110, 105, 95, 100, 90, 95];
    const dd = maxDrawdown(values);
    // Peak 110, trough 90 → (110-90)/110 = 18.18%
    expect(dd).toBeCloseTo(18.18, 1);
  });

  it('returns 0 for monotonically increasing', () => {
    expect(maxDrawdown([100, 101, 102, 103])).toBe(0);
  });

  it('returns 0 for single value', () => {
    expect(maxDrawdown([100])).toBe(0);
  });
});

describe('drawdownExposureMultiplier', () => {
  it('returns correct multipliers', () => {
    expect(drawdownExposureMultiplier('normal')).toBe(1.0);
    expect(drawdownExposureMultiplier('warning')).toBe(0.75);
    expect(drawdownExposureMultiplier('derisking')).toBe(0.5);
    expect(drawdownExposureMultiplier('stopped')).toBe(0.0);
  });
});

describe('cppiExposure', () => {
  it('gives full exposure when well above floor', () => {
    const exposure = cppiExposure(100, 80, 4);
    // cushion = 20, exposure = 80, capped at 100
    expect(exposure).toBe(80);
  });

  it('gives zero exposure at floor', () => {
    expect(cppiExposure(80, 80, 4)).toBe(0);
  });

  it('gives zero exposure below floor', () => {
    expect(cppiExposure(70, 80, 4)).toBe(0);
  });

  it('caps exposure at portfolio value', () => {
    const exposure = cppiExposure(100, 50, 10);
    // cushion = 50, 50*10 = 500, capped at 100
    expect(exposure).toBe(100);
  });
});
