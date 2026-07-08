import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_DIR = resolve(__dirname, '../../.test-pipeline-' + process.pid);

beforeEach(() => {
  vi.resetModules();
  process.env.STATE_DIR = TEST_DIR;
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  try { (await import('../state/store')).closeDb(); } catch { /* not opened */ }
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.STATE_DIR;
});

async function getStore() {
  return await import('../state/store');
}

describe('Portfolio Strategist → Execution Bot pipeline', () => {
  it('cashFlowOrders are queued as pendingOrders in correct format', async () => {
    const { saveState, loadState } = await getStore();

    // Simulate what Portfolio Strategist produces
    const cashOrders = [
      { symbol: 'VTI', shares: 100, amountUsd: 33572, targetPct: 42 },
      { symbol: 'BND', shares: 50, amountUsd: 3688.5, targetPct: 18 },
    ];

    // Convert to pendingOrders format (same logic as portfolio-strategist.ts)
    const pendingOrders = cashOrders.map(o => ({
      symbol: o.symbol,
      action: 'BUY' as const,
      qty: o.shares,
      estimatedValue: o.amountUsd,
      reason: 'cash_flow_rebalance',
    }));

    saveState({ cashFlowOrders: cashOrders, pendingOrders, lastStrategyAt: new Date().toISOString() });
    const loaded = loadState();

    // Execution Bot reads pendingOrders
    const pending = loaded.pendingOrders as Array<{ symbol: string; action: string; qty: number; estimatedValue: number; reason: string }>;
    expect(pending).toHaveLength(2);
    expect(pending[0].symbol).toBe('VTI');
    expect(pending[0].action).toBe('BUY');
    expect(pending[0].qty).toBe(100);
    expect(pending[0].estimatedValue).toBe(33572);
    expect(pending[0].reason).toBe('cash_flow_rebalance');
    expect(pending[1].symbol).toBe('BND');
  });

  it('Execution Bot clears pendingOrders after processing', async () => {
    const { saveState, mergeState, loadState } = await getStore();

    saveState({
      pendingOrders: [{ symbol: 'VTI', action: 'BUY', qty: 100, estimatedValue: 33572, reason: 'rebalance' }],
      lastNav: 1000000,
    });

    // Simulate Execution Bot clearing orders after success
    mergeState({ pendingOrders: [], lastExecutionAt: new Date().toISOString() });

    const loaded = loadState();
    expect(loaded.pendingOrders).toEqual([]);
    expect(loaded.lastNav).toBe(1000000); // preserved by mergeState
  });
});

describe('Quant Analyst → historicalReturns pipeline', () => {
  it('builds historicalReturns matrix with correct shape for sampleCovMatrix', () => {
    const symbols = ['VTI', 'VXUS', 'BND', 'BNDX'];
    const priceHistory: Record<string, number[]> = {
      VTI: [100, 102, 101, 105, 103],
      VXUS: [50, 51, 49, 52, 50],
      BND: [75, 75.5, 74.8, 75.2, 75.1],
      BNDX: [48, 48.2, 47.9, 48.5, 48.3],
    };

    // Same logic as quant-analyst.ts: returns[asset_index][time_index]
    const minLen = Math.min(...symbols.map(s => (priceHistory[s] || []).length));
    const historicalReturns = symbols.map(s => {
      const ph = priceHistory[s];
      const returns: number[] = [];
      for (let i = 1; i < minLen; i++) {
        returns.push((ph[i] - ph[i - 1]) / ph[i - 1]);
      }
      return returns;
    });

    // Shape: 4 assets × 4 time observations (sampleCovMatrix expects row=asset, col=time)
    expect(historicalReturns).toHaveLength(4); // 4 assets (rows)
    expect(historicalReturns[0]).toHaveLength(4); // 4 return observations (cols)

    // VTI returns: 100→102 = +2%, 102→101 = -0.98%, ...
    expect(historicalReturns[0][0]).toBeCloseTo(0.02, 5);
    expect(historicalReturns[0][1]).toBeCloseTo(-0.0098, 4);
    // VXUS returns: 50→51 = +2%
    expect(historicalReturns[1][0]).toBeCloseTo(0.02, 5);
  });

  it('returns undefined when insufficient price history', () => {
    const symbols = ['VTI', 'VXUS'];
    const priceHistory: Record<string, number[]> = {
      VTI: [100, 102],
      VXUS: [50],
    };

    const minLen = Math.min(...symbols.map(s => (priceHistory[s] || []).length));
    let historicalReturns: number[][] | undefined;
    if (minLen >= 3) {
      historicalReturns = symbols.map(s => {
        const ph = priceHistory[s];
        const returns: number[] = [];
        for (let i = 1; i < minLen; i++) {
          returns.push((ph[i] - ph[i - 1]) / ph[i - 1]);
        }
        return returns;
      });
    }

    expect(historicalReturns).toBeUndefined();
  });
});

describe('Managing Partner snapshot for dashboard', () => {
  it('produces lastSnapshot with holdings for TradingWidgets', async () => {
    const { saveState, loadState } = await getStore();

    // Simulate Managing Partner output
    const snapshot = {
      netLiquidation: 500000.00,
      cashValue: 499000.00,
      holdings: [
        { symbol: 'AMZN', sleeve: 'tech_growth', targetPct: 42, currentPct: 0, currentValue: 0 },
        { symbol: 'GE', sleeve: 'industrials', targetPct: 28, currentPct: 0, currentValue: 0 },
        { symbol: 'GLD', sleeve: 'defensive', targetPct: 18, currentPct: 0, currentValue: 0 },
        { symbol: 'BRK-B', sleeve: 'financials', targetPct: 12, currentPct: 0, currentValue: 0 },
      ],
    };

    saveState({ lastNav: 500000.00, lastCash: 499000.00, lastSnapshot: snapshot });
    const loaded = loadState();

    // Dashboard reads these fields
    const snap = loaded.lastSnapshot as typeof snapshot;
    expect(snap.netLiquidation).toBe(500000.00);
    expect(snap.holdings).toHaveLength(4);
    expect(snap.holdings[0].symbol).toBe('AMZN');
    expect(snap.holdings[0].sleeve).toBe('tech_growth');
  });
});

describe('Execution Bot FIFO cost basis matching', () => {
  it('matches SELL to earliest BUY by timestamp (FIFO)', async () => {
    const { appendTrade, loadTradeHistory } = await getStore();

    // Seed trade history via the store API (storage-agnostic) — two BUYs,
    // FIFO should match the earliest.
    appendTrade({ timestamp: '2026-01-01T00:00:00Z', symbol: 'VTI', action: 'BUY', qty: 100, estimatedValue: 28000, fillPrice: 280, orderId: 1, status: 'Filled', reason: 'rebalance' });
    appendTrade({ timestamp: '2026-02-01T00:00:00Z', symbol: 'VTI', action: 'BUY', qty: 100, estimatedValue: 32000, fillPrice: 320, orderId: 2, status: 'Filled', reason: 'rebalance' });

    // Simulate FIFO matching logic (same as execution-bot.ts)
    const history = loadTradeHistory();
    const matchedSellTimestamps = new Set(
      history.filter((t: any) => t.action === 'SELL' && t.matchedBuyTimestamp).map((t: any) => t.matchedBuyTimestamp)
    );
    const matchedBuy = history
      .filter((t: any) => t.action === 'BUY' && t.symbol === 'VTI' && !matchedSellTimestamps.has(t.timestamp))
      .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())[0] ?? null;

    expect(matchedBuy).not.toBeNull();
    expect(matchedBuy.timestamp).toBe('2026-01-01T00:00:00Z'); // earliest
    expect(matchedBuy.fillPrice).toBe(280); // not 320
  });
});

describe('concurrent agent merge safety', () => {
  it('simulates 3 agents writing different fields concurrently', async () => {
    const { saveState, mergeState, loadState } = await getStore();

    // Initial state
    saveState({ lastNav: 100000 });

    // Agent 1: Risk Manager writes risk metrics
    mergeState({ riskMetrics: { var95: 2.5 }, drawdownLevel: 'normal', lastRiskAt: 'T1' });

    // Agent 2: Research Scout writes prices (doesn't see Risk Manager's write with saveState, but does with mergeState)
    mergeState({ lastPriceSnapshots: [{ symbol: 'VTI', price: 335.72 }], lastResearchAt: 'T2' });

    // Agent 3: Quant Analyst writes regime
    mergeState({ regime: { composite: 'risk_on', score: 0.7 }, lastQuantAt: 'T3' });

    const final = loadState();
    // All three agent writes are present
    expect(final.lastNav).toBe(100000);
    expect((final.riskMetrics as any).var95).toBe(2.5);
    expect(final.drawdownLevel).toBe('normal');
    expect((final.lastPriceSnapshots as any)[0].symbol).toBe('VTI');
    expect((final.regime as any).composite).toBe('risk_on');
    expect(final.lastRiskAt).toBe('T1');
    expect(final.lastResearchAt).toBe('T2');
    expect(final.lastQuantAt).toBe('T3');
  });
});
