import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Regression guard for the hard-stop bypass.
 *
 * The drawdown gate is enforced by execution-bot reading `drawdownLevel` /
 * `lastRiskAt` out of state. risk-manager's `run()` body has no catch, so if a
 * notification throws before the gate is persisted, the whole risk run is
 * discarded — and because RISK_STALE_MS (5h) exceeds the agent cadence,
 * execution-bot's staleness fail-safe does NOT fire. It reads the previous
 * cycle's `normal` and trades a drawdown book.
 *
 * So: the gate write must happen BEFORE any alert. These tests fail against the
 * old ordering (alert first, mergeState second).
 *
 * This is the only place in the repo that mocks modules — justified because the
 * invariant under test is precisely the *order of two side effects* inside an
 * un-exported-until-now agent body, which cannot be observed any other way.
 */

const calls: string[] = [];
const merged: Record<string, unknown>[] = [];

vi.mock('../connection/gateway.js', () => ({
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(() => {}),
  requestDelayedData: vi.fn(() => {}),
  // 30% below the 100_000 peak seeded in state → 'stopped' (hard stop is 25%).
  getAccountSummary: vi.fn(async () => ({ netLiquidation: 70_000, totalCashValue: 5_000 })),
  getMarketPrices: vi.fn(async () => new Map<string, number>()),
}));

vi.mock('../state/store.js', () => ({
  loadState: vi.fn(() => ({ navHistory: [100_000] })),
  mergeState: vi.fn((u: Record<string, unknown>) => { calls.push('mergeState'); merged.push(u); }),
}));

vi.mock('../notify/slack.js', () => ({
  alert: vi.fn(async () => {
    calls.push('alert');
    throw new Error('slack exploded');
  }),
}));

describe('risk-manager: hard-stop gate is persisted before notifying', () => {
  beforeEach(() => {
    calls.length = 0;
    merged.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('persists drawdownLevel=stopped even when the alert throws', async () => {
    const { run } = await import('./risk-manager.js');

    // The throw still propagates (agents exit 1 on a fatal) — that is fine and
    // intended. What must NOT happen is losing the gate write.
    await expect(run()).rejects.toThrow('slack exploded');

    const gate = merged.find((u) => 'drawdownLevel' in u);
    expect(gate, 'gate state was never persisted — execution-bot would read a stale level').toBeDefined();
    expect(gate!.drawdownLevel).toBe('stopped');
    expect(gate!.lastRiskAt).toEqual(expect.any(String));
  });

  it('writes the gate before it alerts, not after', async () => {
    const { run } = await import('./risk-manager.js');

    await expect(run()).rejects.toThrow();

    expect(calls).toContain('mergeState');
    expect(calls).toContain('alert');
    expect(
      calls.indexOf('mergeState'),
      `expected mergeState before alert, got: ${calls.join(' → ')}`,
    ).toBeLessThan(calls.indexOf('alert'));
  });
});
