import { describe, expect, it } from 'vitest';
import {
  buildPriceMapFromEvents,
  getLatestPriceFromEvents,
} from './marketdata-stream.js';
import type { ObservedEvent } from './event-types.js';

function md(conid: number, t: string, last: string | number): ObservedEvent {
  return {
    cursor: 1,
    topic: `marketdata:${conid}`,
    receivedAt: t,
    resetEpoch: 1,
    payload: { '31': last, conid },
  };
}

describe('getLatestPriceFromEvents', () => {
  const NOW = Date.parse('2026-05-06T14:00:00Z');

  it('returns the most recent in-window price', () => {
    const events: ObservedEvent[] = [
      md(265598, '2026-05-06T13:59:50Z', '150.10'),
      md(265598, '2026-05-06T13:59:55Z', '150.20'),
      md(265598, '2026-05-06T14:00:00Z', '150.25'),
    ];
    const out = getLatestPriceFromEvents(events, 265598, { now: () => NOW });
    expect(out).not.toBeNull();
    expect(out?.price).toBe(150.25);
    expect(out?.source).toBe('ws');
    expect(out?.ageMs).toBeLessThan(1000);
  });

  it('returns null when latest price is too old', () => {
    const events: ObservedEvent[] = [
      md(265598, '2026-05-06T13:50:00Z', '150.00'),
    ];
    const out = getLatestPriceFromEvents(events, 265598, {
      now: () => NOW,
      maxAgeMs: 30_000,
    });
    expect(out).toBeNull();
  });

  it('skips events for other conids', () => {
    const events: ObservedEvent[] = [
      md(99999, '2026-05-06T14:00:00Z', '999'),
      md(265598, '2026-05-06T13:59:55Z', '150.20'),
    ];
    const out = getLatestPriceFromEvents(events, 265598, { now: () => NOW });
    expect(out?.price).toBe(150.20);
  });

  it('parses status-prefixed price strings (C/H/L)', () => {
    const events: ObservedEvent[] = [
      md(265598, '2026-05-06T13:59:55Z', 'C272.05'),
    ];
    const out = getLatestPriceFromEvents(events, 265598, { now: () => NOW });
    expect(out?.price).toBe(272.05);
  });

  it('handles wrapped payloads via args', () => {
    const evt: ObservedEvent = {
      cursor: 1,
      topic: 'marketdata:265598',
      receivedAt: '2026-05-06T13:59:55Z',
      resetEpoch: 1,
      payload: {
        args: [{ '31': '150.50', conid: 265598 }],
      },
    };
    const out = getLatestPriceFromEvents([evt], 265598, { now: () => NOW });
    expect(out?.price).toBe(150.50);
  });

  it('returns null when no events match', () => {
    expect(getLatestPriceFromEvents([], 1, { now: () => NOW })).toBeNull();
  });
});

describe('buildPriceMapFromEvents', () => {
  const NOW = Date.parse('2026-05-06T14:00:00Z');

  it('returns prices for requested conids', () => {
    const events: ObservedEvent[] = [
      md(1, '2026-05-06T13:59:55Z', '10'),
      md(2, '2026-05-06T13:59:55Z', '20'),
      md(3, '2026-05-06T13:59:55Z', '30'),
    ];
    const out = buildPriceMapFromEvents(events, [1, 2, 3], { now: () => NOW });
    expect(out.size).toBe(3);
    expect(out.get(1)?.price).toBe(10);
    expect(out.get(2)?.price).toBe(20);
    expect(out.get(3)?.price).toBe(30);
  });

  it('omits conids with no events', () => {
    const events: ObservedEvent[] = [md(1, '2026-05-06T13:59:55Z', '10')];
    const out = buildPriceMapFromEvents(events, [1, 999], { now: () => NOW });
    expect(out.size).toBe(1);
    expect(out.has(1)).toBe(true);
    expect(out.has(999)).toBe(false);
  });
});
