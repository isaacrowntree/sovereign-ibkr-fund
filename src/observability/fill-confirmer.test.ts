import { describe, expect, it } from 'vitest';
import { confirmFill } from './fill-confirmer.js';
import type { ObservedEvent, PollResult } from './event-types.js';

interface FakeOrderEvt {
  orderId?: number;
  status?: string;
  cumFill?: number;
  avgPrice?: number;
}

function evt(cursor: number, payload: FakeOrderEvt): ObservedEvent<FakeOrderEvt> {
  return {
    cursor,
    topic: 'orders',
    receivedAt: '2026-05-06T13:30:00Z',
    resetEpoch: 1,
    payload,
  };
}

function ok(events: ObservedEvent<FakeOrderEvt>[]): PollResult<FakeOrderEvt> {
  return {
    kind: 'ok',
    events,
    nextCursor: events.at(-1)?.cursor ?? 0,
    resetEpoch: 1,
  };
}

const empty: PollResult<FakeOrderEvt> = { kind: 'empty', cursor: 0 };

function pollFnFromQueue(queue: PollResult<FakeOrderEvt>[]) {
  return async (_topic: any, _since: number, _limit?: number) => {
    return queue.shift() ?? empty;
  };
}

const inertSleep = async () => {};

describe('confirmFill', () => {
  it('treats Inactive as transient (pre-submission), then resolves to filled', async () => {
    // The real CPAPI order lifecycle: every order STARTS Inactive (pending
    // submit) before it fills. Inactive must NOT be read as a terminal cancel,
    // or the confirmer bails at the first event reporting a phantom cancel.
    const queue: PollResult<FakeOrderEvt>[] = [
      ok([
        evt(1, { orderId: 999, status: 'Inactive' }),
        evt(2, { orderId: 999, status: 'PreSubmitted' }),
        evt(3, { orderId: 999, status: 'Filled', cumFill: 5, avgPrice: 100 }),
      ]),
    ];
    const result = await confirmFill(999, {
      targetQty: 5,
      pollFn: pollFnFromQueue(queue) as any,
      sleepFn: inertSleep,
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('filled');
    expect(result.totalFilledQty).toBe(5);
    expect(result.timedOut).toBe(false);
  });

  it('treats PendingCancel as interim, never a non-timed-out terminal (no phantom fill)', async () => {
    // CPAPI's `PendingCancel` is an in-flight cancel request, not a terminal
    // state — the order can still fill. With only PendingCancel + partial
    // fills and no real terminal, confirmFill must NOT return a non-timed-out
    // result the executor could read as a completed order; it should time out
    // with the partial fills it saw.
    let calls = 0;
    const pollFn = async (_topic: any, _since: number, _limit?: number) => {
      calls += 1;
      if (calls === 1) return ok([evt(1, { orderId: 777, status: 'PendingCancel', cumFill: 4, avgPrice: 100 })]);
      return empty;
    };
    let nowMs = 1_000_000;
    const result = await confirmFill(777, {
      targetQty: 10,
      pollFn: pollFn as any,
      sleepFn: async () => { nowMs += 1_000; },
      now: () => nowMs,
      pollIntervalMs: 1_000,
      timeoutMs: 3_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.totalFilledQty).toBe(4);
    // Crucially NOT 'filled' — a phantom full fill is the failure we guard against.
    expect(result.status).not.toBe('filled');
  });

  it('resolves to cancelled with fills preserved once a real Cancelled arrives', async () => {
    const queue: PollResult<FakeOrderEvt>[] = [
      ok([
        evt(1, { orderId: 777, status: 'PendingCancel', cumFill: 4, avgPrice: 100 }),
        evt(2, { orderId: 777, status: 'Cancelled', cumFill: 4, avgPrice: 100 }),
      ]),
    ];
    const result = await confirmFill(777, {
      targetQty: 10,
      pollFn: pollFnFromQueue(queue) as any,
      sleepFn: inertSleep,
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('cancelled');
    expect(result.timedOut).toBe(false);
    expect(result.totalFilledQty).toBe(4);
  });

  it('does NOT report filled when a Filled frame carries zero fills (no phantom)', async () => {
    // A bare 'Filled' status with no cumFill must not be reported as filled —
    // that would let the executor record a phantom full-quantity trade.
    const queue: PollResult<FakeOrderEvt>[] = [
      ok([evt(1, { orderId: 555, status: 'Filled' })]), // no cumFill
    ];
    const result = await confirmFill(555, {
      targetQty: 10,
      pollFn: pollFnFromQueue(queue) as any,
      sleepFn: inertSleep,
      timeoutMs: 5_000,
    });
    expect(result.totalFilledQty).toBe(0);
    expect(result.status).not.toBe('filled');
  });

  it('resolves to filled when full quantity arrives', async () => {
    const queue: PollResult<FakeOrderEvt>[] = [
      ok([
        evt(1, { orderId: 12345, status: 'PreSubmitted' }),
        evt(2, { orderId: 12345, status: 'Filled', cumFill: 10, avgPrice: 150.25 }),
      ]),
    ];
    const result = await confirmFill(12345, {
      targetQty: 10,
      pollFn: pollFnFromQueue(queue) as any,
      sleepFn: inertSleep,
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('filled');
    expect(result.totalFilledQty).toBe(10);
    expect(result.avgFillPrice).toBe(150.25);
    expect(result.remainingQty).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('resolves to partial when timeout elapses with partial fills', async () => {
    let calls = 0;
    const pollFn = async (_topic: any, _since: number, _limit?: number) => {
      calls += 1;
      if (calls === 1) {
        return ok([evt(1, { orderId: 12345, status: 'Working', cumFill: 4, avgPrice: 150.0 })]);
      }
      return empty;
    };
    let nowMs = 1_000_000;
    const result = await confirmFill(12345, {
      targetQty: 10,
      pollFn: pollFn as any,
      sleepFn: async () => {
        nowMs += 1_000;
      },
      now: () => nowMs,
      pollIntervalMs: 1_000,
      timeoutMs: 3_000,
    });
    expect(result.status).toBe('partial');
    expect(result.totalFilledQty).toBe(4);
    expect(result.remainingQty).toBe(6);
    expect(result.timedOut).toBe(true);
  });

  it('resolves to rejected on rejection event', async () => {
    const queue: PollResult<FakeOrderEvt>[] = [
      ok([evt(1, { orderId: 99, status: 'Rejected' })]),
    ];
    const result = await confirmFill(99, {
      targetQty: 5,
      pollFn: pollFnFromQueue(queue) as any,
      sleepFn: inertSleep,
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('rejected');
    expect(result.totalFilledQty).toBe(0);
    expect(result.remainingQty).toBe(5);
  });

  it('resolves to cancelled on cancel event', async () => {
    const queue: PollResult<FakeOrderEvt>[] = [
      ok([evt(1, { orderId: 7, status: 'Cancelled' })]),
    ];
    const result = await confirmFill(7, {
      targetQty: 3,
      pollFn: pollFnFromQueue(queue) as any,
      sleepFn: inertSleep,
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('cancelled');
  });

  it('handles fills arriving across multiple poll windows', async () => {
    const queue: PollResult<FakeOrderEvt>[] = [
      ok([evt(1, { orderId: 200, status: 'Working', cumFill: 3, avgPrice: 100 })]),
      ok([evt(2, { orderId: 200, status: 'Working', cumFill: 6, avgPrice: 100.5 })]),
      ok([evt(3, { orderId: 200, status: 'Filled', cumFill: 10, avgPrice: 101 })]),
    ];
    const result = await confirmFill(200, {
      targetQty: 10,
      pollFn: pollFnFromQueue(queue) as any,
      sleepFn: inertSleep,
      timeoutMs: 10_000,
    });
    expect(result.status).toBe('filled');
    expect(result.totalFilledQty).toBe(10);
    expect(result.events.length).toBe(3);
  });

  it('resolves to pending when no events arrive within timeout', async () => {
    const pollFn = async () => empty;
    let nowMs = 1_000_000;
    const result = await confirmFill(12345, {
      targetQty: 10,
      pollFn: pollFn as any,
      sleepFn: async () => {
        nowMs += 1_000;
      },
      now: () => nowMs,
      pollIntervalMs: 1_000,
      timeoutMs: 2_000,
    });
    expect(result.status).toBe('pending');
    expect(result.totalFilledQty).toBe(0);
    expect(result.timedOut).toBe(true);
  });

  it('ignores events for other orderIds', async () => {
    const queue: PollResult<FakeOrderEvt>[] = [
      ok([
        evt(1, { orderId: 1, status: 'Filled', cumFill: 5, avgPrice: 50 }),
        evt(2, { orderId: 2, status: 'Working', cumFill: 1, avgPrice: 25 }),
      ]),
    ];
    const result = await confirmFill(2, {
      targetQty: 5,
      pollFn: pollFnFromQueue(queue) as any,
      sleepFn: inertSleep,
      timeoutMs: 1_000,
      now: () => 0,
    });
    expect(result.totalFilledQty).toBe(1);
    expect(result.events.length).toBe(1);
    expect(result.events[0].payload.orderId).toBe(2);
  });
});
