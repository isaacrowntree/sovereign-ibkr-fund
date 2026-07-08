import { describe, expect, it } from 'vitest';
import {
  pollTopic,
  reconcileFromResult,
} from './event-poller.js';
import type {
  CursorExpired,
  EventsOk,
  NoNewEvents,
  ObserverCursor,
} from './event-types.js';

interface MockResp {
  status: number;
  body?: unknown;
}

function fetchOf(resp: MockResp) {
  return async (_url: string, _init?: RequestInit): Promise<Response> => {
    return new Response(resp.body ? JSON.stringify(resp.body) : null, {
      status: resp.status,
      headers: resp.body ? { 'content-type': 'application/json' } : undefined,
    });
  };
}

describe('pollTopic', () => {
  it('returns events with monotonic cursors on 200', async () => {
    const fetcher = fetchOf({
      status: 200,
      body: {
        events: [
          { cursor: 1, topic: 'orders', received_at: 't', reset_epoch: 1, payload: { id: 1 } },
          { cursor: 2, topic: 'orders', received_at: 't', reset_epoch: 1, payload: { id: 2 } },
        ],
        next_cursor: 2,
        reset_epoch: 1,
      },
    });
    const result = await pollTopic('orders', 0, 100, { fetcher, baseUrl: 'http://x' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.events).toHaveLength(2);
    expect(result.events[0].cursor).toBe(1);
    expect(result.events[1].cursor).toBe(2);
    expect(result.nextCursor).toBe(2);
    expect(result.resetEpoch).toBe(1);
  });

  it('returns empty on 204', async () => {
    const fetcher = fetchOf({ status: 204 });
    const result = await pollTopic('orders', 5, 100, { fetcher, baseUrl: 'http://x' });
    expect(result.kind).toBe('empty');
    if (result.kind !== 'empty') return;
    expect(result.cursor).toBe(5);
  });

  it('returns cursor_expired on 412', async () => {
    const fetcher = fetchOf({
      status: 412,
      body: {
        code: 'cursor_expired',
        head_cursor: 100,
        reset_epoch: 3,
        message: 'too old',
      },
    });
    const result = await pollTopic('orders', 1, 100, { fetcher, baseUrl: 'http://x' });
    expect(result.kind).toBe('cursor_expired');
    if (result.kind !== 'cursor_expired') return;
    expect(result.headCursor).toBe(100);
    expect(result.resetEpoch).toBe(3);
  });

  it('throws on 503', async () => {
    const fetcher = fetchOf({
      status: 503,
      body: { code: 'events_disabled', message: 'off' },
    });
    await expect(
      pollTopic('orders', 0, 100, { fetcher, baseUrl: 'http://x' }),
    ).rejects.toThrow(/disabled/);
  });

  it('throws on unexpected status', async () => {
    const fetcher = fetchOf({ status: 500, body: { code: 'oops' } });
    await expect(
      pollTopic('orders', 0, 100, { fetcher, baseUrl: 'http://x' }),
    ).rejects.toThrow(/500/);
  });
});

describe('reconcileFromResult', () => {
  const baseState: ObserverCursor = { cursor: 5, resetEpoch: 1 };

  it('advances cursor on happy-path Ok', () => {
    const ok: EventsOk = {
      kind: 'ok',
      events: [
        { cursor: 6, topic: 'orders', receivedAt: 't', resetEpoch: 1, payload: { id: 6 } },
        { cursor: 7, topic: 'orders', receivedAt: 't', resetEpoch: 1, payload: { id: 7 } },
      ],
      nextCursor: 7,
      resetEpoch: 1,
    };
    const out = reconcileFromResult(baseState, ok);
    expect(out.events).toHaveLength(2);
    expect(out.gap).toBeUndefined();
    expect(out.newCursor.cursor).toBe(7);
    expect(out.newCursor.resetEpoch).toBe(1);
  });

  it('emits gap when resetEpoch advances', () => {
    const ok: EventsOk = {
      kind: 'ok',
      events: [
        { cursor: 1, topic: 'orders', receivedAt: 't', resetEpoch: 2, payload: {} },
      ],
      nextCursor: 1,
      resetEpoch: 2,
    };
    const out = reconcileFromResult(baseState, ok);
    expect(out.gap).toBeDefined();
    if (!out.gap) return;
    expect(out.gap.payload.reason).toBe('reset_epoch_changed');
    expect(out.gap.payload.previousResetEpoch).toBe(1);
    expect(out.gap.payload.newResetEpoch).toBe(2);
    expect(out.events).toHaveLength(1);
    expect(out.newCursor.cursor).toBe(1);
    expect(out.newCursor.resetEpoch).toBe(2);
  });

  it('emits gap and resets cursor on cursor_expired', () => {
    const expired: CursorExpired = {
      kind: 'cursor_expired',
      headCursor: 50,
      resetEpoch: 1,
    };
    const out = reconcileFromResult(baseState, expired);
    expect(out.events).toHaveLength(0);
    expect(out.gap).toBeDefined();
    if (!out.gap) return;
    expect(out.gap.payload.reason).toBe('cursor_expired');
    expect(out.newCursor.cursor).toBe(49);
    expect(out.newCursor.resetEpoch).toBe(1);
  });

  it('handles empty Ok without state mutation', () => {
    const empty: NoNewEvents = { kind: 'empty', cursor: 5 };
    const out = reconcileFromResult(baseState, empty);
    expect(out.events).toHaveLength(0);
    expect(out.gap).toBeUndefined();
    expect(out.newCursor.cursor).toBe(5);
    expect(out.newCursor.resetEpoch).toBe(1);
  });

  it('first poll (epoch=0) does not emit gap', () => {
    const firstState: ObserverCursor = { cursor: 0, resetEpoch: 0 };
    const ok: EventsOk = {
      kind: 'ok',
      events: [
        { cursor: 1, topic: 'orders', receivedAt: 't', resetEpoch: 7, payload: {} },
      ],
      nextCursor: 1,
      resetEpoch: 7,
    };
    const out = reconcileFromResult(firstState, ok);
    expect(out.gap).toBeUndefined();
    expect(out.events).toHaveLength(1);
    expect(out.newCursor.resetEpoch).toBe(7);
  });

  it('headCursor=0 expired clamps newCursor to 0', () => {
    const expired: CursorExpired = {
      kind: 'cursor_expired',
      headCursor: 0,
      resetEpoch: 1,
    };
    const out = reconcileFromResult(baseState, expired);
    expect(out.newCursor.cursor).toBe(0);
  });
});
