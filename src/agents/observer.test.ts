import { describe, expect, it } from 'vitest';
import { appendToBuffer, formatEvent, judgeStream, observedToState } from './observer.js';
import type { ObservedEvent } from '../observability/event-types.js';
import type { ObservedEventState } from '../state/store.js';

describe('appendToBuffer', () => {
  it('appends in order', () => {
    const buf: ObservedEventState[] = [];
    appendToBuffer(buf, fakeEvent(1));
    appendToBuffer(buf, fakeEvent(2));
    expect(buf.map((e) => e.cursor)).toEqual([1, 2]);
  });

  it('drops oldest when cap is hit', () => {
    const buf: ObservedEventState[] = [];
    for (let i = 1; i <= 10; i += 1) appendToBuffer(buf, fakeEvent(i), 5);
    expect(buf).toHaveLength(5);
    expect(buf[0].cursor).toBe(6);
    expect(buf[4].cursor).toBe(10);
  });
});

describe('observedToState', () => {
  it('preserves cursor/topic/receivedAt/resetEpoch/payload', () => {
    const evt: ObservedEvent = {
      cursor: 42,
      topic: 'orders',
      receivedAt: '2026-05-06T00:00:00Z',
      resetEpoch: 3,
      payload: { orderId: 12345 },
    };
    const out = observedToState(evt);
    expect(out.cursor).toBe(42);
    expect(out.topic).toBe('orders');
    expect(out.receivedAt).toBe('2026-05-06T00:00:00Z');
    expect(out.resetEpoch).toBe(3);
    expect(out.payload).toEqual({ orderId: 12345 });
    // observedAt is a fresh server-side stamp.
    expect(out.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('formatEvent', () => {
  it('formats orders with id, status, side, qty', () => {
    const evt: ObservedEvent = {
      cursor: 1,
      topic: 'orders',
      receivedAt: 't',
      resetEpoch: 1,
      payload: {
        orderId: 12345,
        status: 'Filled',
        ticker: 'AAPL',
        side: 'BUY',
        totalSize: 10,
        cumFill: 10,
        avgPrice: 150.25,
      },
    };
    const out = formatEvent(evt);
    expect(out).toContain('orderId=12345');
    expect(out).toContain('status=Filled');
    expect(out).toContain('symbol=AAPL');
    expect(out).toContain('side=BUY');
    expect(out).toContain('qty=10');
    expect(out).toContain('filled=10');
    expect(out).toContain('px=150.25');
  });

  it('formats pnl with unrealized + realized', () => {
    const evt: ObservedEvent = {
      cursor: 1,
      topic: 'pnl',
      receivedAt: 't',
      resetEpoch: 1,
      payload: { unrealized: 120.5, realized: -10 },
    };
    const out = formatEvent(evt);
    expect(out).toContain('PNL');
    expect(out).toContain('unrealized=120.5');
    expect(out).toContain('realized=-10');
  });

  it('formats gap with payload', () => {
    const evt: ObservedEvent = {
      cursor: 1,
      topic: 'gap',
      receivedAt: 't',
      resetEpoch: 2,
      payload: { reason: 'reset_epoch_changed', newResetEpoch: 2 },
    };
    expect(formatEvent(evt)).toContain('GAP');
    expect(formatEvent(evt)).toContain('reset_epoch_changed');
  });

  it('formats market data with last price', () => {
    const evt: ObservedEvent = {
      cursor: 1,
      topic: 'marketdata:265598',
      receivedAt: 't',
      resetEpoch: 1,
      payload: { '31': '150.25' },
    };
    const out = formatEvent(evt);
    expect(out).toContain('marketdata:265598');
    expect(out).toContain('last=150.25');
  });

  it('falls back to JSON for unknown topics', () => {
    const evt: ObservedEvent = {
      cursor: 1,
      topic: 'mystery',
      receivedAt: 't',
      resetEpoch: 1,
      payload: { foo: 'bar' },
    };
    expect(formatEvent(evt)).toContain('mystery');
    expect(formatEvent(evt)).toContain('foo');
  });
});

function fakeEvent(cursor: number): ObservedEventState {
  return {
    cursor,
    topic: 'orders',
    receivedAt: '2026-05-06T00:00:00Z',
    resetEpoch: 1,
    payload: { id: cursor },
    observedAt: '2026-05-06T00:00:00Z',
  };
}

describe('judgeStream — is the stream telling us what we rely on it for?', () => {
  it('a connected socket whose orders subscription CPAPI refused is NOT healthy', () => {
    // The Sep 2026 condition: connected, heartbeating, no gaps — and no fill
    // could ever arrive. Every older signal said fine.
    const v = judgeStream({ connected: true, subscriptions: { orders: 'refused', pnl: 'subscribed' } }, 0)!;
    expect(v).not.toBeNull();
    expect(v.reason).toBe('orders-refused');
    expect(v.title).toContain('refused');
  });

  it('pending counts as not delivering too — a subscribe CPAPI never answered', () => {
    expect(judgeStream({ connected: true, subscriptions: { orders: 'pending' } }, 0)?.reason).toBe('orders-pending');
  });

  it('a bezant that predates the field is judged on the old signals only', () => {
    expect(judgeStream({ connected: true }, 0)).toBeNull();
    expect(judgeStream({ connected: true }, 1)?.reason).toBe('gaps');
  });

  it('disconnected outranks everything', () => {
    expect(judgeStream({ connected: false, subscriptions: { orders: 'refused' } }, 2)?.reason).toBe('disconnected');
  });

  it('subscribed, connected, no gaps: nothing to say', () => {
    expect(judgeStream({ connected: true, subscriptions: { orders: 'subscribed', pnl: 'subscribed' } }, 0)).toBeNull();
  });
});
