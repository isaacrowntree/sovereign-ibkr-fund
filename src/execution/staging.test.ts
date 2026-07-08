import { describe, it, expect } from 'vitest';
import { planExecution, gateBuysByCash, type StagedOrder } from './staging.js';

const order = (
  symbol: string,
  action: 'BUY' | 'SELL',
  estimatedValue: number,
  qty = 1,
): StagedOrder => ({ symbol, action, qty, estimatedValue, reason: 'test' });

// Mirrors the real queue from 2026-07-01 so the tests document the
// actual first staged rebalance.
const REAL_QUEUE: StagedOrder[] = [
  order('BRK-B', 'SELL', 1502.76, 3),
  order('TWLO', 'SELL', 2278.1, 11),
  order('TSLA', 'SELL', 2137.25, 5),
  order('NET', 'SELL', 10799.45, 43),
  order('AVGO', 'BUY', 3359.16, 9),
  order('GE', 'BUY', 3371.31, 9),
  order('TLT', 'BUY', 3345.03, 39),
  order('CAT', 'BUY', 2038.24, 2),
  order('LLY', 'BUY', 2380.08, 2),
  order('GLD', 'BUY', 1503.68, 4),
];

describe('planExecution', () => {
  it('unvalidated: picks the single smallest SELL and defers the rest', () => {
    const plan = planExecution(REAL_QUEUE, false);
    expect(plan.mode).toBe('validate');
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].symbol).toBe('BRK-B');
    expect(plan.deferred).toHaveLength(9);
    expect(plan.deferred).not.toContainEqual(plan.orders[0]);
  });

  it('unvalidated: probe is excluded from deferred by identity even when it is NOT queue index 0', () => {
    // Strategist emits sells loss-first, so the smallest-value sell (the
    // probe) is frequently mid-queue. deferred must be "everything except
    // the probe" — never "everything except index 0", which would drop the
    // real index-0 order and re-queue the probe that just executed.
    const queue: StagedOrder[] = [
      order('NET', 'SELL', 10799.45, 43),  // index 0, biggest loss first
      order('BRK-B', 'SELL', 1502.76, 3),  // smallest → the probe
      order('AVGO', 'BUY', 3359.16, 9),
    ];
    const plan = planExecution(queue, false);
    expect(plan.orders[0].symbol).toBe('BRK-B');
    // The probe is NOT in deferred; the index-0 order (NET) IS.
    expect(plan.deferred.map(o => o.symbol)).toEqual(['NET', 'AVGO']);
    expect(plan.deferred.some(o => o === plan.orders[0])).toBe(false);
  });

  it('unvalidated with buys only: probes with the smallest BUY', () => {
    const buysOnly = REAL_QUEUE.filter(o => o.action === 'BUY');
    const plan = planExecution(buysOnly, false);
    expect(plan.mode).toBe('validate');
    expect(plan.orders[0].symbol).toBe('GLD');
  });

  it('validated: full queue, sells before buys, nothing deferred', () => {
    const plan = planExecution(REAL_QUEUE, true);
    expect(plan.mode).toBe('normal');
    expect(plan.orders).toHaveLength(10);
    expect(plan.orders.slice(0, 4).every(o => o.action === 'SELL')).toBe(true);
    expect(plan.orders.slice(4).every(o => o.action === 'BUY')).toBe(true);
    expect(plan.deferred).toHaveLength(0);
  });

  it('empty queue: normal mode, nothing to do', () => {
    const plan = planExecution([], false);
    expect(plan.mode).toBe('normal');
    expect(plan.orders).toHaveLength(0);
  });

  it('does not mutate the input queue order', () => {
    const copy = [...REAL_QUEUE];
    planExecution(REAL_QUEUE, false);
    planExecution(REAL_QUEUE, true);
    expect(REAL_QUEUE).toEqual(copy);
  });
});

describe('gateBuysByCash', () => {
  const buys = REAL_QUEUE.filter(o => o.action === 'BUY');
  const totalBuys = buys.reduce((s, b) => s + b.estimatedValue, 0);

  it('admits everything when cash comfortably covers the queue', () => {
    const { execute, deferred } = gateBuysByCash(buys, totalBuys * 1.1, 2);
    expect(execute).toHaveLength(6);
    expect(deferred).toHaveLength(0);
  });

  it('defers everything at ~zero cash', () => {
    const { execute, deferred } = gateBuysByCash(buys, 36.29, 2);
    expect(execute).toHaveLength(0);
    expect(deferred).toHaveLength(6);
  });

  it('skips an unaffordable buy but still admits later smaller ones', () => {
    // Cash covers AVGO+GE with $2,500 left: TLT ($3,412 w/ headroom)
    // doesn't fit, but CAT ($2,079) after it does.
    const cash = (3359.16 + 3371.31) * 1.02 + 2500;
    const { execute, deferred } = gateBuysByCash(buys, cash, 2);
    expect(execute.map(o => o.symbol)).toEqual(['AVGO', 'GE', 'CAT']);
    expect(deferred.map(o => o.symbol)).toEqual(['TLT', 'LLY', 'GLD']);
  });

  it('headroom inflates the cost used for gating', () => {
    const single = [order('TLT', 'BUY', 1000)];
    expect(gateBuysByCash(single, 1010, 2).execute).toHaveLength(0);
    expect(gateBuysByCash(single, 1021, 2).execute).toHaveLength(1);
    expect(gateBuysByCash(single, 1010, 0).execute).toHaveLength(1);
  });

  it('preserves queue order (strategist greedy priority) among admitted buys', () => {
    const { execute } = gateBuysByCash(buys, totalBuys * 1.1, 2);
    expect(execute.map(o => o.symbol)).toEqual(['AVGO', 'GE', 'TLT', 'CAT', 'LLY', 'GLD']);
  });
});
