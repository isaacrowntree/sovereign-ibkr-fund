import { describe, it, expect, vi } from 'vitest';

const merged: Record<string, unknown>[] = [];
const connect = vi.fn(async () => {});

vi.mock('../connection/gateway.js', () => ({
  connect, disconnect: vi.fn(), requestDelayedData: vi.fn(),
  getAccountSummary: vi.fn(), getMarketPrices: vi.fn(),
}));
vi.mock('../state/store.js', () => ({
  loadState: vi.fn(() => ({})),
  mergeState: vi.fn((u: Record<string, unknown>) => { merged.push(u); }),
}));

describe('hedger (retired, F7)', () => {
  it('clears its stale suggestions and touches nothing else — not even the gateway', async () => {
    const { run } = await import('./hedger.js');
    await run();
    expect(merged).toEqual([{ hedgeActions: [], lastHedgeAt: expect.any(String) }]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('is no longer in the built-in schedule', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../scheduler/index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/script: 'hedger\.js'/);
  });
});
