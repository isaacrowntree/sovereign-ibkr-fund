import { describe, it, expect } from 'vitest';
import { reconcileExecutions } from './reconcile.js';
import type { TradeRecord } from '../state/store.js';
import type { Execution } from '../connection/gateway.js';

const exec = (execId: string, symbol: string, action: 'BUY' | 'SELL', qty: number, price: number, orderId?: number): Execution =>
  ({ execId, symbol, action, qty, price, time: '2026-07-04T14:00:00Z', orderId });

const rec = (over: Partial<TradeRecord>): TradeRecord => ({
  timestamp: 't', symbol: 'NET', action: 'SELL', qty: 1, estimatedValue: 100,
  orderId: 1, status: 'filled', reason: 'x', ...over,
});

describe('reconcileExecutions', () => {
  it('backfills an execution missing from the ledger', () => {
    const out = reconcileExecutions([], [exec('E1', 'NET', 'SELL', 45, 242)]);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('NET');
    expect(out[0].qty).toBe(45);
    expect(out[0].fillPrice).toBe(242);
    expect(out[0].execId).toBe('E1');
    expect(out[0].reason).toBe('reconciled_from_ibkr');
  });

  it('skips an execution already recorded by execId (idempotent)', () => {
    const history = [rec({ execId: 'E1', symbol: 'NET', qty: 45 })];
    expect(reconcileExecutions(history, [exec('E1', 'NET', 'SELL', 45, 242)])).toEqual([]);
  });

  it('skips a fill the executor already recorded without an execId (legacy match)', () => {
    // Executor recorded this via confirmFill: orderId+action+symbol+qty, no execId.
    const history = [rec({ orderId: 777, action: 'SELL', symbol: 'NET', qty: 45 })];
    expect(reconcileExecutions(history, [exec('E1', 'NET', 'SELL', 45, 242, 777)])).toEqual([]);
  });

  it('backfills only the executions not yet present', () => {
    const history = [rec({ execId: 'E1', symbol: 'NET', qty: 45 })];
    const out = reconcileExecutions(history, [
      exec('E1', 'NET', 'SELL', 45, 242),   // already recorded
      exec('E2', 'TWLO', 'SELL', 14, 209),  // missing
    ]);
    expect(out.map(t => t.execId)).toEqual(['E2']);
  });

  it('does not double-add duplicate execIds within one batch', () => {
    const out = reconcileExecutions([], [
      exec('E1', 'NET', 'SELL', 45, 242),
      exec('E1', 'NET', 'SELL', 45, 242),
    ]);
    expect(out).toHaveLength(1);
  });
});
