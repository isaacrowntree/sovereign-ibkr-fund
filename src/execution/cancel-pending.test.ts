import { describe, it, expect } from 'vitest';
import { resolveCancelPending, type CancelPendingDeps } from './cancel-pending.js';
import { isWorkingOrder, inactiveWorkingMs } from './order-status.js';
import type { CancelRequest } from './executor.js';

const req = (orderId: number, symbol = 'NET'): CancelRequest => ({
  orderId, symbol, action: 'SELL', requestedAt: '2026-09-24T14:00:00.000Z', reason: 'test', requestOk: true,
});

function deps(live: Array<{ orderId: number; status: string; ageMs?: number }> | Error) {
  const cancelled: number[] = [];
  const d: CancelPendingDeps = {
    getLiveOrders: async () => { if (live instanceof Error) throw live; return live; },
    cancelOrder: async (id) => { cancelled.push(id); },
    log: () => {},
    logError: () => {},
  };
  return { d, cancelled };
}

describe('resolveCancelPending', () => {
  it('drops cancels whose order is gone or dead', async () => {
    const { d, cancelled } = deps([{ orderId: 2, status: 'Cancelled' }, { orderId: 3, status: 'Filled' }]);
    const r = await resolveCancelPending([req(1), req(2), req(3)], d);
    expect(r.pending).toEqual([]);
    expect(r.resolved.map(x => x.orderId)).toEqual([1, 2, 3]);
    expect(cancelled).toEqual([]);
  });

  it('re-sends the cancel for an order still working, keeps it, and reports it stuck', async () => {
    const { d, cancelled } = deps([{ orderId: 1, status: 'Submitted' }]);
    const r = await resolveCancelPending([req(1), req(2)], d);
    expect(cancelled).toEqual([1]);
    expect(r.pending.map(x => x.orderId)).toEqual([1]);
    expect(r.stuck.map(x => x.orderId)).toEqual([1]);
    expect(r.resolved.map(x => x.orderId)).toEqual([2]);
  });

  it('a failed re-send still keeps the entry', async () => {
    const { d } = deps([{ orderId: 1, status: 'PreSubmitted' }]);
    d.cancelOrder = async () => { throw new Error('503'); };
    const r = await resolveCancelPending([req(1)], d);
    expect(r.pending).toEqual([expect.objectContaining({ orderId: 1, requestOk: false })]);
  });

  it('unreadable live orders conclude nothing', async () => {
    const { d } = deps(new Error('bezant down'));
    const r = await resolveCancelPending([req(1)], d);
    expect(r).toMatchObject({ checked: false, pending: [req(1)], resolved: [], stuck: [] });
  });

  it('nothing pending → no I/O', async () => {
    const { d } = deps(new Error('should not be called'));
    expect(await resolveCancelPending([], d)).toMatchObject({ checked: true, pending: [] });
  });
});

describe('isWorkingOrder — Inactive only while young', () => {
  const H = 60 * 60 * 1000;
  it('dead states are not working; live ones are', () => {
    for (const s of ['Filled', 'Cancelled', 'Rejected']) expect(isWorkingOrder(s)).toBe(false);
    for (const s of ['Submitted', 'PreSubmitted', 'PendingSubmit', 'PendingCancel']) expect(isWorkingOrder(s)).toBe(true);
  });

  it('Inactive counts as working while younger than the limit', () => {
    expect(isWorkingOrder('Inactive', 1 * H, 6 * H)).toBe(true);
    expect(isWorkingOrder('Inactive', 7 * H, 6 * H)).toBe(false);
  });

  it('Inactive of unknown age counts as working (fail closed)', () => {
    expect(isWorkingOrder('Inactive', undefined, 6 * H)).toBe(true);
  });

  it('a limit of 0 restores the old "Inactive is terminal"', () => {
    expect(isWorkingOrder('Inactive', undefined, 0)).toBe(false);
  });

  it('INACTIVE_WORKING_HOURS defaults to 6', () => {
    expect(inactiveWorkingMs({})).toBe(6 * H);
    expect(inactiveWorkingMs({ INACTIVE_WORKING_HOURS: '2' })).toBe(2 * H);
    expect(inactiveWorkingMs({ INACTIVE_WORKING_HOURS: '0' })).toBe(0);
  });
});
