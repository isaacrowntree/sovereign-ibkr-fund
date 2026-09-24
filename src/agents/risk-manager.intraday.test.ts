import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * C′3 wiring: INTRADAY_DD_SOURCE decides which intraday figure gates.
 * Frames are CPAPI-shaped (nl/upl/dpl), which the legacy reconstruction cannot
 * read — so under legacy/shadow the level stays at the snapshot's, and only
 * `nl` escalates.
 */

const merged: Record<string, unknown>[] = [];

const frame = (t: string, nl: number) => ({
  cursor: 1, topic: 'pnl', receivedAt: t, resetEpoch: 1,
  payload: { topic: 'spl', args: { 'U1.Core': { rowType: 1, nl, upl: 0, dpl: 0 } } },
});

vi.mock('../connection/gateway.js', () => ({
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(() => {}),
  requestDelayedData: vi.fn(() => {}),
  getAccountSummary: vi.fn(async () => ({ netLiquidation: 99_000, totalCashValue: 1_000 })),
  getMarketPrices: vi.fn(async () => new Map<string, number>()),
  getUsdBalances: vi.fn(async () => ({ usdNav: 66_000, usdCash: 500, usdSettledCash: 500, baseRatePerUsd: 1.5 })),
}));

vi.mock('../state/store.js', () => ({
  loadState: vi.fn(() => ({ navHistory: [100_000], navHistoryDates: ['2026-09-22'] })),
  // A session that fell 30% from its open, then partly recovered.
  loadObservedEvents: vi.fn(() => [
    frame('2026-09-23T13:35:00Z', 100_000),
    frame('2026-09-23T15:00:00Z', 70_000),
    frame('2026-09-23T17:00:00Z', 99_000),
  ]),
  mergeState: vi.fn((u: Record<string, unknown>) => { merged.push(u); }),
}));

vi.mock('../notify/store-hooks.js', () => ({ storeHooks: { claim: () => true, release: () => {} } }));
vi.mock('../notify/slack.js', () => ({ notify: vi.fn(async () => {}) }));

const gate = () => merged.find(u => 'drawdownLevel' in u)!;
const nlShadow = () => merged.find(u => 'intradayDrawdownNl' in u)?.intradayDrawdownNl as
  { mode: string; level: string; drawdownPct: number } | undefined;

describe('risk-manager: INTRADAY_DD_SOURCE', () => {
  beforeEach(() => {
    merged.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T18:00:00Z')); // 14:00 ET, in session
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('default (shadow): the nl figure is computed and recorded, but legacy gates', async () => {
    const { run } = await import('./risk-manager.js');
    await run();
    expect(nlShadow()).toMatchObject({ mode: 'shadow', level: 'stopped' });
    expect(nlShadow()!.drawdownPct).toBeCloseTo(30, 6);
    expect(gate().drawdownLevel).toBe('normal'); // snapshot 1% — legacy sees no usable frames
  });

  it('nl: the session low escalates the ladder', async () => {
    vi.stubEnv('INTRADAY_DD_SOURCE', 'nl');
    const { run } = await import('./risk-manager.js');
    await run();
    expect(nlShadow()).toMatchObject({ mode: 'gating', level: 'stopped' });
    expect(gate().drawdownLevel).toBe('stopped');
  });

  it('legacy: the nl block does not run at all', async () => {
    vi.stubEnv('INTRADAY_DD_SOURCE', 'legacy');
    const { run } = await import('./risk-manager.js');
    await run();
    expect(nlShadow()).toBeUndefined();
    expect(gate().drawdownLevel).toBe('normal');
  });
});
