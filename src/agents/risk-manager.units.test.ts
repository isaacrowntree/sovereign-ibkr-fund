import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * F6 wiring: RISK_NAV_SOURCE decides whether the ladder sees a withdrawal as a
 * drawdown. The book: 100k AUD, half withdrawn (recorded as a capital flow),
 * the rest flat. Raw NAV says −50% (hard stop); the unit index says 0%.
 */

const merged: Record<string, unknown>[] = [];
let ledgerFails = false;

vi.mock('../connection/gateway.js', () => ({
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(() => {}),
  requestDelayedData: vi.fn(() => {}),
  getAccountSummary: vi.fn(async () => ({ netLiquidation: 50_000, totalCashValue: 1_000 })),
  getMarketPrices: vi.fn(async () => new Map<string, number>()),
  getUsdBalances: vi.fn(async () => {
    if (ledgerFails) throw new Error('ledger 503');
    return { usdNav: 50_000 / 1.5, usdCash: 0, usdSettledCash: 0, baseRatePerUsd: 1.5, nonUsdCashBase: 5_000 };
  }),
}));

vi.mock('../state/store.js', () => ({
  loadState: vi.fn(() => ({
    navHistory: [100_000, 100_000],
    navHistoryDates: ['2026-09-21', '2026-09-22'],
    navSamples: [
      { date: '2026-09-21', navAud: 100_000, navUsd: 100_000 / 1.5, audPerUsd: 1.5, source: 'close' },
      { date: '2026-09-22', navAud: 100_000, navUsd: 100_000 / 1.5, audPerUsd: 1.5, source: 'close' },
    ],
    capitalFlows: [{ id: 'w-2026-09-23', date: '2026-09-23', amountAud: -50_000, note: 'withdrawal' }],
  })),
  loadObservedEvents: vi.fn(() => []),
  mergeState: vi.fn((u: Record<string, unknown>) => { merged.push(u); }),
}));

vi.mock('../notify/store-hooks.js', () => ({ storeHooks: { claim: () => true, release: () => {} } }));
vi.mock('../notify/slack.js', () => ({ notify: vi.fn(async () => {}) }));

const gate = () => merged.find(u => 'drawdownLevel' in u)!;

describe('risk-manager: RISK_NAV_SOURCE', () => {
  beforeEach(() => {
    merged.length = 0;
    ledgerFails = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T22:00:00Z')); // 18:00 ET, after the close
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('legacy (default): the withdrawal reads as a drawdown, as it always has', async () => {
    const { run } = await import('./risk-manager.js');
    await run();
    expect(gate().drawdownLevel).toBe('stopped');
    // …while the unit index is recorded beside it, not gating.
    expect(gate().unitNav).toMatchObject({ source: 'legacy', series: 'USD', level: 'normal' });
  });

  it('units: a recorded withdrawal is not a drawdown', async () => {
    vi.stubEnv('RISK_NAV_SOURCE', 'units');
    const { run } = await import('./risk-manager.js');
    await run();
    expect(gate().drawdownLevel).toBe('normal');
    const u = gate().unitNav as { unitPriceUsd: number; drawdownPct: number; usdExposurePct: number };
    expect(u.unitPriceUsd).toBeCloseTo(1, 9);
    expect(u.drawdownPct).toBeCloseTo(0, 9);
    expect(u.usdExposurePct).toBeCloseTo(90, 9);
  });

  it('records the post-close sample once, with both currencies', async () => {
    const { run } = await import('./risk-manager.js');
    await run();
    const samples = gate().navSamples as Array<{ date: string; navAud: number; navUsd: number; source: string }>;
    expect(samples.map(s => s.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
    expect(samples[2]).toMatchObject({ navAud: 50_000, source: 'close' });
    expect(samples[2].navUsd).toBeCloseTo(50_000 / 1.5, 6);
  });

  it('keeps the legacy history intact under units (no phantom reset)', async () => {
    vi.stubEnv('RISK_NAV_SOURCE', 'units');
    const { run } = await import('./risk-manager.js');
    await run();
    expect((gate().navHistory as number[]).slice(0, 2)).toEqual([100_000, 100_000]);
  });

  it('units fails closed on a ledger error; legacy carries on', async () => {
    ledgerFails = true;
    const legacy = await import('./risk-manager.js');
    await legacy.run();
    expect(gate().drawdownLevel).toBe('stopped');

    merged.length = 0;
    vi.resetModules();
    vi.stubEnv('RISK_NAV_SOURCE', 'units');
    const units = await import('./risk-manager.js');
    await expect(units.run()).rejects.toThrow('ledger 503');
    expect(merged.find(u => 'drawdownLevel' in u)).toBeUndefined();
  });
});
