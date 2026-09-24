import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * DRIFT_GATE wiring (F1/F3/F4/F8). The book is the SAMPLE portfolio at $100 a
 * share with GLD 6pp over its 10% target and QQQ 6pp under its 20%: the legacy
 * gate (max drift 6% < 10%) does nothing, the band gate (GLD band 2.5pp,
 * ½Σ|dev| = 6% ≥ 5%) trims GLD to 11.25% and buys QQQ with the proceeds.
 */

const merged: Record<string, unknown>[] = [];
const logs: string[] = [];
const notified: Array<{ title: string }> = [];
let stateOverrides: Record<string, unknown> = {};
let nonUsdCashBase = 0;

const HOLD: Record<string, number> = { QQQ: 140, XLI: 100, XLV: 100, XLF: 100, VIG: 150, VDC: 100, TLT: 150, GLD: 160 };
const SYMS = Object.keys(HOLD);

vi.mock('../log.js', () => ({
  log: vi.fn((m: string) => { logs.push(m); }),
  logError: vi.fn(),
}));

vi.mock('../connection/gateway.js', () => ({
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(() => {}),
  requestDelayedData: vi.fn(() => {}),
  getAccountSummary: vi.fn(async () => ({
    netLiquidation: 150_000,
    totalCashValue: 0,
    positions: SYMS.map(s => ({ symbol: s, qty: HOLD[s], avgCost: 90, marketPrice: 100 })),
  })),
  getMarketPrices: vi.fn(async (syms: string[]) => new Map(syms.map(s => [s, 100]))),
  getUsdBalances: vi.fn(async () => ({
    usdNav: 100_000, usdCash: 0, usdSettledCash: 0, baseRatePerUsd: 1.5, nonUsdCashBase,
  })),
}));

vi.mock('../state/store.js', () => ({
  loadState: vi.fn(() => ({
    lastQuantAt: new Date(Date.now() - 3_600_000).toISOString(),
    priceHistoryDates: ['2026-09-22', '2026-09-23'],
    priceHistory: Object.fromEntries(SYMS.map(s => [s, [100, 100]])),
    ...stateOverrides,
  })),
  mergeState: vi.fn((u: Record<string, unknown>) => { merged.push(u); }),
  loadTradeHistory: vi.fn(() => []),
  // I1's stale-queue sweep (D7) reads and writes the queue in one step.
  updateStateKey: vi.fn(<T,>(key: string, fn: (cur: T | undefined) => T | undefined) => {
    const cur = ({ ...stateOverrides } as Record<string, unknown>)[key] as T | undefined;
    const next = fn(cur);
    if (next !== undefined) merged.push({ [key]: next });
  }),
}));

vi.mock('../portfolio/deposit-policy-file.js', () => ({ loadDepositPolicy: vi.fn(() => null) }));
vi.mock('../notify/store-hooks.js', () => ({ storeHooks: { claim: () => true, release: () => {} } }));
vi.mock('../notify/slack.js', () => ({ notify: vi.fn(async (e: { title: string }) => { notified.push(e); }) }));

const final = () => merged[merged.length - 1];

describe('portfolio-strategist: DRIFT_GATE', () => {
  beforeEach(() => {
    merged.length = 0;
    logs.length = 0;
    notified.length = 0;
    stateOverrides = {};
    nonUsdCashBase = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T15:00:00Z')); // 11:00 ET Thursday
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('legacy (default): trades as before, but logs and records what the band gate would do', async () => {
    const { run } = await import('./portfolio-strategist.js');
    await run();
    const line = logs.find(l => l.startsWith('bands gate would: '))!;
    expect(line).toMatch(/^bands gate would: regular; ½Σ\|dev\| 6\.00%.*sells: GLD×47; buys: QQQ×37.*\[legacy gate: within-threshold; shadow\]/);
    expect(final().pendingOrders).toBeUndefined(); // legacy: nothing to do
    expect(final().lastRebalanceAt).toBeUndefined();
    const shadow = final().bandsShadow as Array<{ decision: string; legacyDecision: string; active: boolean }>;
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toMatchObject({ decision: 'regular', legacyDecision: 'within-threshold', active: false });
  });

  it('bands: the band orders are queued and the sell restarts the cooldown', async () => {
    vi.stubEnv('DRIFT_GATE', 'bands');
    const { run } = await import('./portfolio-strategist.js');
    await run();
    const q = final().pendingOrders as Array<{ symbol: string; action: string; qty: number }>;
    expect(q.map(o => `${o.action} ${o.symbol} ${o.qty}`)).toEqual(['SELL GLD 47', 'BUY QQQ 37']);
    expect(final().lastRebalanceAt).toEqual(expect.any(String));
  });

  it('bands inside the sell cooldown: buy-only cash flow on settled cash, overweights excluded', async () => {
    vi.stubEnv('DRIFT_GATE', 'bands');
    stateOverrides = { lastRebalanceAt: new Date(Date.now() - 10 * 86_400_000).toISOString() };
    const { run } = await import('./portfolio-strategist.js');
    await run();
    expect(logs.some(l => l.includes('buy-only cash flow, overweights excluded'))).toBe(true);
    expect(final().pendingOrders).toBeUndefined(); // no settled cash above the reserve
    expect(final().lastRebalanceAt).toBeUndefined();
  });

  it('never replaces a queued directed deposit', async () => {
    vi.stubEnv('DRIFT_GATE', 'bands');
    stateOverrides = { pendingOrders: [{ symbol: 'TLT', action: 'BUY', qty: 3, estimatedValue: 300, reason: 'directed_deposit' }] };
    const { run } = await import('./portfolio-strategist.js');
    await run();
    expect(final().pendingOrders).toBeUndefined();
    expect(logs.some(l => l.includes('Queue holds a directed deposit'))).toBe(true);
  });

  it('F8 under bands: skips when quant has not run since the previous strategist run', async () => {
    vi.stubEnv('DRIFT_GATE', 'bands');
    stateOverrides = { lastStrategyAt: new Date(Date.now() - 60_000).toISOString() };
    const { run } = await import('./portfolio-strategist.js');
    await run();
    expect(notified.some(n => n.title.includes('market data is stale'))).toBe(true);
    expect(merged.some(u => 'bandsShadow' in u)).toBe(false);
  });

  it('F8 under legacy: only logs that it would have skipped', async () => {
    stateOverrides = { lastStrategyAt: new Date(Date.now() - 60_000).toISOString() };
    const { run } = await import('./portfolio-strategist.js');
    await run();
    expect(logs.some(l => l.includes('would skip under DRIFT_GATE=bands'))).toBe(true);
    expect(merged.some(u => 'bandsShadow' in u)).toBe(true);
  });

  it('alerts (once per condition) on unconverted AUD above the tolerance', async () => {
    nonUsdCashBase = 5_000;
    const { run } = await import('./portfolio-strategist.js');
    await run();
    expect(notified.map(n => n.title)).toContain('Unconverted AUD is sitting idle');
  });
});
