import { describe, it, expect, vi, afterEach } from 'vitest';
import { BACKTEST_DATA_AVAILABLE } from './data-available';
import { DEFAULT_CONFIG, LIVE_CONFIG, LIVE_KNOBS, runBacktest, fxOn } from './backtest-engine';

describe('backtest configs never read ambient env (G1)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('DEFAULT_CONFIG is the same literal whatever .env says', async () => {
    vi.stubEnv('OPTIMIZER', 'static');
    vi.stubEnv('ENABLE_REGIME', 'false');
    vi.stubEnv('REBALANCE_DRIFT_THRESHOLD', '3');
    vi.stubEnv('REBALANCE_FREQ_DAYS', '7');
    vi.resetModules();
    const fresh = await import('./backtest-engine');
    expect(fresh.DEFAULT_CONFIG).toEqual(DEFAULT_CONFIG);
    expect(fresh.DEFAULT_CONFIG.optimizerMethod).toBe('hrp');
    expect(fresh.DEFAULT_CONFIG.rebalanceDriftPct).toBe(10);
    expect(fresh.LIVE_CONFIG).toEqual(LIVE_CONFIG);
  });

  it('LIVE_CONFIG carries the live knobs on top of DEFAULT_CONFIG', () => {
    expect(LIVE_CONFIG).toMatchObject({
      optimizerMethod: 'static',
      enableRegimeOverlay: false,
      rebalanceDriftPct: 10,
      rebalanceFreqDays: 45,
      urgentDriftPct: 25,
      minTradeUsd: 200,
      cashBufferPct: 1,
      fillMode: 'greedy',
      cashFlowFillMode: 'greedy',
      cashFlowReserveBase: 500,
      cashFlowRebuyGuardDays: 30,
      fxDataFile: 'fx-audusd.json',
    });
    // Everything it does not override is DEFAULT_CONFIG's.
    expect(LIVE_CONFIG.slippagePctPerSide).toBe(DEFAULT_CONFIG.slippagePctPerSide);
    expect(LIVE_CONFIG.enableVolTargeting).toBe(false);
    expect(LIVE_KNOBS.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('an AUD reserve without an FX series is refused, not guessed', () => {
    expect(() => runBacktest({ ...LIVE_CONFIG, fxDataFile: undefined }, 30000)).toThrow(/needs fxDataFile/);
  });

  it('fxOn takes the last rate on or before the date', () => {
    const s = { dates: ['2024-01-02', '2024-01-05'], rates: [1.5, 1.6] };
    expect(fxOn(s, '2024-01-01')).toBe(1.5);
    expect(fxOn(s, '2024-01-02')).toBe(1.5);
    expect(fxOn(s, '2024-01-04')).toBe(1.5);
    expect(fxOn(s, '2024-01-05')).toBe(1.6);
    expect(fxOn(s, '2030-01-01')).toBe(1.6);
  });
});

describe.skipIf(!BACKTEST_DATA_AVAILABLE)('a start inside the warm-up throws (G5)', () => {
  it('refuses instead of silently starting later', () => {
    expect(() => runBacktest(DEFAULT_CONFIG, 30000, undefined, '2023-10-02')).toThrow(/warm-up/);
  });

  it('a start after the warm-up begins on that day', () => {
    const r = runBacktest(DEFAULT_CONFIG, 30000, undefined, '2025-01-02', '2025-03-31');
    expect(r.startDate).toBe('2025-01-02');
  });
});
