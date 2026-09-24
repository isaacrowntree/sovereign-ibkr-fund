import { describe, expect, it } from 'vitest';
import { computeIntradayDrawdownFromEvents } from './intraday-pnl.js';
import type { ObservedEvent } from './event-types.js';

interface RawPnl {
  upnl?: number;
  rpnl?: number;
}

function pnl(t: string, payload: RawPnl): ObservedEvent<RawPnl> {
  return {
    cursor: 0,
    topic: 'pnl',
    receivedAt: t,
    resetEpoch: 1,
    payload,
  };
}

describe('computeIntradayDrawdownFromEvents', () => {
  it('returns zero drawdown on empty input', () => {
    const out = computeIntradayDrawdownFromEvents([], 100_000);
    expect(out.samples).toBe(0);
    expect(out.drawdownPct).toBe(0);
    expect(out.peakNav).toBe(100_000);
    expect(out.troughNav).toBe(100_000);
  });

  it('returns zero drawdown for invalid sessionStartNav', () => {
    const out = computeIntradayDrawdownFromEvents([pnl('2026-05-06T13:30:00Z', { upnl: 100 })], 0);
    expect(out.samples).toBe(0);
    expect(out.drawdownPct).toBe(0);
  });

  it('computes drawdown from monotonic decreasing events', () => {
    const events = [
      pnl('2026-05-06T13:30:00Z', { upnl: 100 }), // 100100
      pnl('2026-05-06T13:31:00Z', { upnl: 50 }),  // 100050
      pnl('2026-05-06T13:32:00Z', { upnl: -200 }),// 99800
    ];
    const out = computeIntradayDrawdownFromEvents(events, 100_000);
    expect(out.samples).toBe(3);
    expect(out.peakNav).toBeCloseTo(100_100, 2);
    expect(out.troughNav).toBeCloseTo(99_800, 2);
    // (100100 - 99800) / 100100 * 100 ~ 0.2998
    expect(out.drawdownPct).toBeCloseTo(0.2997, 2);
  });

  it('drawdown trough resets to peak on new peak', () => {
    const events = [
      pnl('2026-05-06T13:30:00Z', { upnl: 100 }),  // peak1 = 100100
      pnl('2026-05-06T13:31:00Z', { upnl: -100 }), // trough1 = 99900
      pnl('2026-05-06T13:32:00Z', { upnl: 500 }),  // new peak = 100500, trough resets
      pnl('2026-05-06T13:33:00Z', { upnl: 300 }),  // trough2 = 100300
    ];
    const out = computeIntradayDrawdownFromEvents(events, 100_000);
    expect(out.peakNav).toBeCloseTo(100_500, 2);
    expect(out.troughNav).toBeCloseTo(100_300, 2);
    // (100500 - 100300) / 100500 * 100 ~ 0.199%
    expect(out.drawdownPct).toBeCloseTo(0.199, 2);
  });

  it('ignores events outside session window', () => {
    const events = [
      pnl('2026-05-06T12:00:00Z', { upnl: -1_000 }), // before window
      pnl('2026-05-06T13:30:00Z', { upnl: 100 }),
      pnl('2026-05-06T13:31:00Z', { upnl: -50 }),
    ];
    const out = computeIntradayDrawdownFromEvents(events, 100_000, {
      sessionStartedAt: '2026-05-06T13:00:00Z',
    });
    expect(out.samples).toBe(2);
  });

  it('ignores non-pnl events', () => {
    const events: ObservedEvent[] = [
      {
        cursor: 1,
        topic: 'orders',
        receivedAt: '2026-05-06T13:30:00Z',
        resetEpoch: 1,
        payload: { orderId: 1 },
      },
      pnl('2026-05-06T13:31:00Z', { upnl: 0 }),
    ];
    const out = computeIntradayDrawdownFromEvents(events as any, 100_000);
    expect(out.samples).toBe(1);
  });

  it('handles per-account args envelope', () => {
    const evt: ObservedEvent<any> = {
      cursor: 1,
      topic: 'pnl',
      receivedAt: '2026-05-06T13:30:00Z',
      resetEpoch: 1,
      payload: {
        args: {
          DU123: { upnl: 50, rpnl: 0 },
          DU456: { upnl: 75, rpnl: -25 },
        },
      },
    };
    const out = computeIntradayDrawdownFromEvents([evt], 100_000);
    // 100000 + (50 + 75) + (0 + -25) = 100100
    expect(out.peakNav).toBeCloseTo(100_100, 2);
    expect(out.samples).toBe(1);
  });

  it('skips events with no recognisable PnL fields', () => {
    const evt = pnl('2026-05-06T13:30:00Z', { } as RawPnl);
    const out = computeIntradayDrawdownFromEvents([evt], 100_000);
    expect(out.samples).toBe(0);
  });
});

import { computeIntradayDrawdownFromNl, extractNl } from './intraday-pnl.js';
import frames from './fixtures/spl-frames.json';

const W = { start: new Date('2026-09-23T13:30:00Z'), end: new Date('2026-09-23T20:00:00Z') };
const nlEvt = (t: string, nl: number | undefined, extra: Record<string, number> = {}): ObservedEvent => ({
  cursor: 0, topic: 'pnl', receivedAt: t, resetEpoch: 1,
  payload: { topic: 'spl', args: { 'U1.Core': nl === undefined ? { rowType: 1, ...extra } : { rowType: 1, nl, ...extra } } },
});

describe('computeIntradayDrawdownFromNl (C′3)', () => {
  it('reads the fixture frames: skips partial and zeroed nl, measures peak → later trough', () => {
    const out = computeIntradayDrawdownFromNl(frames.events as ObservedEvent[], W);
    // 50000 → 49760 (−0.48%) → 50510 → [nl:0 ignored] → 50305 (−0.41% from 50510)
    expect(out.samples).toBe(4);
    expect(out.ignored).toBe(2); // the partial frame without nl and the nl:0 frame
    expect(out.drawdownPct).toBeCloseTo(0.48, 2);
    expect(out.peakNav).toBe(50000);
    expect(out.troughNav).toBe(49760);
    expect(out.sessionHigh).toBe(50510);
    expect(out.sessionLow).toBe(49760);
    expect(out.lastNav).toBe(50305);
  });

  it('the legacy reconstruction finds nothing in the same real-shaped frames', () => {
    // The whole reason C′3 exists: upnl/rpnl are not what CPAPI sends.
    const legacy = computeIntradayDrawdownFromEvents(frames.events as ObservedEvent<any>[], 50_000);
    expect(legacy.samples).toBe(0);
  });

  it('does not reset the trough at a new peak: an early deep dip survives a later small high', () => {
    const out = computeIntradayDrawdownFromNl([
      nlEvt('2026-09-23T13:31:00Z', 100_000),
      nlEvt('2026-09-23T14:00:00Z', 90_000), // −10%
      nlEvt('2026-09-23T15:00:00Z', 100_500), // new high
      nlEvt('2026-09-23T16:00:00Z', 100_300),
    ], W);
    expect(out.drawdownPct).toBeCloseTo(10, 6);
    expect(out.peakNav).toBe(100_000);
    expect(out.troughNav).toBe(90_000);
    // Legacy on the equivalent upnl series reports only the last, tiny fall.
    const legacy = computeIntradayDrawdownFromEvents([
      pnl('2026-09-23T13:31:00Z', { upnl: 0 }),
      pnl('2026-09-23T14:00:00Z', { upnl: -10_000 }),
      pnl('2026-09-23T15:00:00Z', { upnl: 500 }),
      pnl('2026-09-23T16:00:00Z', { upnl: 300 }),
    ], 100_000);
    expect(legacy.drawdownPct).toBeLessThan(0.3);
  });

  it('a dip BEFORE the session high is not a drawdown from that high', () => {
    const out = computeIntradayDrawdownFromNl([
      nlEvt('2026-09-23T13:31:00Z', 95_000),
      nlEvt('2026-09-23T14:00:00Z', 100_000),
    ], W);
    expect(out.drawdownPct).toBe(0);
    expect(out.sessionLow).toBe(95_000);
  });

  it('only the session window counts (pre-market and after-hours frames drop)', () => {
    const out = computeIntradayDrawdownFromNl([
      nlEvt('2026-09-23T12:00:00Z', 80_000), // pre-market
      nlEvt('2026-09-23T13:31:00Z', 100_000),
      nlEvt('2026-09-23T21:00:00Z', 70_000), // after the close
    ], W);
    expect(out.samples).toBe(1);
    expect(out.drawdownPct).toBe(0);
  });

  it('sorts by receivedAt rather than trusting row order', () => {
    const out = computeIntradayDrawdownFromNl([
      nlEvt('2026-09-23T15:00:00Z', 90_000),
      nlEvt('2026-09-23T14:00:00Z', 100_000),
    ], W);
    expect(out.drawdownPct).toBeCloseTo(10, 6);
  });

  it('no usable frames → zero samples, not a zero NAV', () => {
    const out = computeIntradayDrawdownFromNl([nlEvt('2026-09-23T14:00:00Z', undefined, { dpl: 5 })], W);
    expect(out.samples).toBe(0);
    expect(out.ignored).toBe(1);
  });

  it('extractNl accepts the frame, REST and bare shapes and sums accounts', () => {
    expect(extractNl({ topic: 'spl', args: { 'A.Core': { nl: 10 }, 'B.Core': { nl: '5' } } })).toBe(15);
    expect(extractNl({ upnl: { 'A.Core': { nl: 7 } } })).toBe(7);
    expect(extractNl({ nl: 3 })).toBe(3);
    expect(extractNl({ args: { 'A.Core': { nl: 0 } } })).toBeNaN();
    expect(extractNl(null)).toBeNaN();
  });
});
