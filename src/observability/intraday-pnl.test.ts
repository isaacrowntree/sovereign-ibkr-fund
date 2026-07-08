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
