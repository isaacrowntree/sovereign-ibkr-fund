import { describe, expect, it } from 'vitest';
import { appendToBuffer, formatEvent, judgeStream, observedToState, planStreamAlert, reconcileStaleness, type StreamMemory } from './observer.js';
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

  it('pending is silence, not evidence — CPAPI says nothing on a subscribe it honoured with no orders to snapshot', () => {
    expect(judgeStream({ connected: true, subscriptions: { orders: 'pending', pnl: 'subscribed' } }, 0)).toBeNull();
  });

  it('a bezant that predates the field is judged on the old signals only', () => {
    expect(judgeStream({ connected: true }, 0)).toBeNull();
    expect(judgeStream({ connected: true }, 1)?.reason).toBe('gaps');
  });

  it('disconnected outranks everything', () => {
    expect(judgeStream({ connected: false, subscriptions: { orders: 'refused' } }, 2)?.reason).toBe('disconnected');
  });

  it('a gap is recorded, not pushed — every reconnect leaves one and nobody can act on it', () => {
    expect(judgeStream({ connected: true, subscriptions: { orders: 'subscribed' } }, 1)?.channel).toBe('ops');
  });

  it('disconnected and refused still interrupt', () => {
    expect(judgeStream({ connected: false }, 0)?.channel).toBe('slack');
    expect(judgeStream({ connected: true, subscriptions: { orders: 'refused' } }, 0)?.channel).toBe('slack');
  });

  it('subscribed, connected, no gaps: nothing to say', () => {
    expect(judgeStream({ connected: true, subscriptions: { orders: 'subscribed', pnl: 'subscribed' } }, 0)).toBeNull();
  });
});

describe('planStreamAlert — a blip is a record, an outage is a page', () => {
  const MIN = 60_000;
  const BLIP = 10 * MIN;
  const t0 = new Date('2026-09-24T10:00:00Z');
  const at = (m: number) => new Date(t0.getTime() + m * MIN);
  const down = judgeStream({ connected: false }, 0);
  const up = judgeStream({ connected: true, subscriptions: { orders: 'subscribed' } }, 0);
  const gap = judgeStream({ connected: true, subscriptions: { orders: 'subscribed' } }, 1);

  it('first sight of an outage is recorded, not paged', () => {
    const r = planStreamAlert({}, down, t0, BLIP);
    expect(r.action).toEqual({ kind: 'record', reason: 'disconnected' });
    expect(r.next.streamOutage).toEqual({ since: t0.toISOString(), reason: 'disconnected', paged: false });
  });

  it('a blip that clears inside the threshold never pages, and its recovery is a record', () => {
    let mem: StreamMemory = planStreamAlert({}, down, t0, BLIP).next;
    const still = planStreamAlert(mem, down, at(5), BLIP);
    expect(still.action).toBeNull(); // recorded once per outage, not per poll
    mem = still.next;
    const over = planStreamAlert(mem, up, at(8), BLIP);
    expect(over.action).toEqual({ kind: 'recover-record', minutes: 8 });
    expect(over.next.streamOutage).toBeUndefined();
    expect(over.next.lastStreamOutageEndedAt).toBe(at(8).toISOString());
  });

  it('an outage that outlasts the threshold pages once, then leaves re-nags to the dedupe ttl', () => {
    let mem = planStreamAlert({}, down, t0, BLIP).next;
    const page = planStreamAlert(mem, down, at(10), BLIP);
    expect(page.action).toEqual({ kind: 'page', reason: 'disconnected', slack: true });
    mem = page.next;
    expect(planStreamAlert(mem, down, at(15), BLIP).action).toBeNull();
    expect(planStreamAlert(mem, up, at(20), BLIP).action).toEqual({ kind: 'recover-page', minutes: 20, slack: true });
  });

  it('a SECOND outage within 24h pages at once, however short', () => {
    const mem: StreamMemory = { lastStreamOutageEndedAt: at(-60 * 23).toISOString() };
    expect(planStreamAlert(mem, down, t0, BLIP).action).toEqual({ kind: 'page', reason: 'disconnected', slack: true });
  });

  it('…but one a day later is a fresh first outage', () => {
    const mem: StreamMemory = { lastStreamOutageEndedAt: at(-60 * 25).toISOString() };
    expect(planStreamAlert(mem, down, t0, BLIP).action?.kind).toBe('record');
  });

  it('a refused orders subscription is an outage too — escalated on the feed, never Slack (policy 2026-09-24)', () => {
    const refused = judgeStream({ connected: true, subscriptions: { orders: 'refused' } }, 0);
    const r = planStreamAlert({}, refused, t0, 0);
    expect(r.action).toEqual({ kind: 'page', reason: 'orders-refused', slack: false });
    // …and its recovery is not a Slack message either: nothing paged to pair it with.
    expect(planStreamAlert(r.next, up, at(30), 0).action).toEqual({ kind: 'recover-page', minutes: 30, slack: false });
  });

  it('an orders-refused outage that becomes a DISCONNECT escalates again, to Slack this time', () => {
    const refused = judgeStream({ connected: true, subscriptions: { orders: 'refused' } }, 0);
    const first = planStreamAlert({}, refused, t0, 0);
    const worse = planStreamAlert(first.next, down, at(5), 0);
    expect(worse.action).toEqual({ kind: 'page', reason: 'disconnected', slack: true });
    expect(planStreamAlert(worse.next, down, at(10), 0).action).toBeNull();
    expect(planStreamAlert(worse.next, up, at(20), 0).action).toEqual({ kind: 'recover-page', minutes: 20, slack: true });
  });

  it('state written before the policy (no `slack` flag) pairs the recovery by reason', () => {
    const since = t0.toISOString();
    expect(planStreamAlert({ streamOutage: { since, reason: 'disconnected', paged: true } }, up, at(15), BLIP).action)
      .toEqual({ kind: 'recover-page', minutes: 15, slack: true });
    expect(planStreamAlert({ streamOutage: { since, reason: 'orders-refused', paged: true } }, up, at(15), BLIP).action)
      .toEqual({ kind: 'recover-page', minutes: 15, slack: false });
  });

  it('a gap is not an outage (it stays a record of its own)', () => {
    expect(planStreamAlert({}, gap, t0, BLIP)).toEqual({ action: null, next: {} });
  });

  it('OBSERVER_BLIP_MINUTES=0 pages on first sight, as before', () => {
    expect(planStreamAlert({}, down, t0, 0).action?.kind).toBe('page');
  });

  it('healthy and nothing remembered: nothing to do', () => {
    expect(planStreamAlert({}, up, t0, BLIP)).toEqual({ action: null, next: {} });
  });
});

describe('reconcileStaleness', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const saved = process.env.RECONCILE_STALE_HOURS;
  const restore = () => { if (saved === undefined) delete process.env.RECONCILE_STALE_HOURS; else process.env.RECONCILE_STALE_HOURS = saved; };

  it('quiet inside 14h, stale past it', () => {
    delete process.env.RECONCILE_STALE_HOURS;
    expect(reconcileStaleness('2026-09-24T00:00:00Z', now)).toBeNull(); // 12h
    expect(reconcileStaleness('2026-09-23T21:00:00Z', now)).toBeCloseTo(15);
    restore();
  });

  it('0 switches it off; a missing or unreadable stamp is not guessed at', () => {
    process.env.RECONCILE_STALE_HOURS = '0';
    expect(reconcileStaleness('2020-01-01T00:00:00Z', now)).toBeNull();
    delete process.env.RECONCILE_STALE_HOURS;
    expect(reconcileStaleness(undefined, now)).toBeNull();
    expect(reconcileStaleness('garbage', now)).toBeNull();
    restore();
  });
});
