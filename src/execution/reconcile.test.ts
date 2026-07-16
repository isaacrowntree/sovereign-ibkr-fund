import { describe, it, expect } from 'vitest';
import { reconcileExecutions } from './reconcile.js';
import type { TradeRecord } from '../state/store.js';
import type { Execution } from '../connection/gateway.js';

const exec = (execId: string, symbol: string, action: 'BUY' | 'SELL', qty: number, price: number, orderId?: number, time = '2026-07-04T14:00:00Z'): Execution =>
  ({ execId, symbol, action, qty, price, time, orderId });

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

/**
 * Partial fills — the grain mismatch.
 *
 * The ledger's grain is per-ORDER: the executor calls recordFilledTrade once
 * with conf.totalFilledQty, producing a single aggregate record with NO execId
 * (CPAPI's WS order frames don't carry one — see fill-confirmer's
 * RawOrderEvent). IBKR's executions endpoint has per-EXECUTION grain: one row
 * per partial.
 *
 * So the legacy fallback key (orderId+action+symbol+qty) compares an aggregate
 * against individual rows and never matches, and every partial gets backfilled
 * on top of the aggregate. 100 real shares become 200 in the ledger — which
 * then corrupts FIFO cost basis, realised P&L, wash-sale windows and the AU CGT
 * report.
 *
 * Every pre-existing test above uses one execution per order, which is why this
 * survived: a single-fill order reconciles correctly.
 */
describe('reconcileExecutions: partial fills (per-order ledger vs per-execution IBKR)', () => {
  /** What the executor writes for an order that filled 30 + 30 + 40. */
  const aggregate = rec({ orderId: 1042, action: 'BUY', symbol: 'VTI', qty: 100 });
  const partials = [
    exec('e1', 'VTI', 'BUY', 30, 250, 1042, '2026-07-04T14:00:01Z'),
    exec('e2', 'VTI', 'BUY', 30, 250, 1042, '2026-07-04T14:00:02Z'),
    exec('e3', 'VTI', 'BUY', 40, 250, 1042, '2026-07-04T14:00:03Z'),
  ];

  it('does not backfill partials already covered by the executor’s aggregate record', () => {
    expect(reconcileExecutions([aggregate], partials)).toEqual([]);
  });

  it('never inflates the ledger: 100 real shares stay 100', () => {
    const backfill = reconcileExecutions([aggregate], partials);
    const total = [aggregate, ...backfill].reduce((s, t) => s + t.qty, 0);
    expect(total, 'ledger qty must equal the shares that actually moved').toBe(100);
  });

  it('still backfills everything when the ledger missed the order entirely', () => {
    const out = reconcileExecutions([], partials);
    expect(out.map(t => t.execId)).toEqual(['e1', 'e2', 'e3']);
    expect(out.reduce((s, t) => s + t.qty, 0)).toBe(100);
  });

  it('backfills only the shortfall when a later partial arrived after the executor snapshot', () => {
    // Executor saw 100; IBKR later shows a 4th partial of 50.
    const late = [...partials, exec('e4', 'VTI', 'BUY', 50, 250, 1042, '2026-07-04T14:00:04Z')];
    const out = reconcileExecutions([aggregate], late);
    expect(out.map(t => t.execId), 'the aggregate covers e1-e3; only e4 is new').toEqual(['e4']);
    const total = [aggregate, ...out].reduce((s, t) => s + t.qty, 0);
    expect(total).toBe(150);
  });

  it('credits the aggregate in time order, not arbitrary order', () => {
    const shuffled = [partials[2], partials[0], partials[1]];
    expect(reconcileExecutions([aggregate], shuffled)).toEqual([]);
  });

  it('keeps orders independent — one order’s aggregate cannot cover another’s', () => {
    const other = exec('x1', 'BND', 'BUY', 25, 70, 2001);
    const out = reconcileExecutions([aggregate], [...partials, other]);
    expect(out.map(t => t.execId)).toEqual(['x1']);
  });

  it('keeps sides independent — a BUY aggregate cannot cover a SELL', () => {
    const sell = exec('s1', 'VTI', 'SELL', 30, 250, 1042);
    const out = reconcileExecutions([aggregate], [sell]);
    expect(out.map(t => t.execId)).toEqual(['s1']);
  });

  it('handles a mix: some partials already reconciled by execId, rest covered by the aggregate', () => {
    // e1 was backfilled on a previous run; the aggregate covers the other 70.
    const history = [aggregate, rec({ execId: 'e1', orderId: 1042, action: 'BUY', symbol: 'VTI', qty: 30 })];
    expect(reconcileExecutions(history, partials)).toEqual([]);
  });

  it('does not let an aggregate for one symbol cover a different symbol on the same order', () => {
    const otherSym = exec('y1', 'NET', 'BUY', 10, 58, 1042);
    const out = reconcileExecutions([aggregate], [otherSym]);
    expect(out.map(t => t.execId)).toEqual(['y1']);
  });

  it('tolerates executions with no orderId (cannot be credited to an aggregate)', () => {
    const orphan = exec('o1', 'VTI', 'BUY', 10, 250, undefined);
    const out = reconcileExecutions([aggregate], [orphan]);
    expect(out.map(t => t.execId)).toEqual(['o1']);
  });
});
