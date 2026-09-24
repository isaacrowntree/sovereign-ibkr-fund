import { describe, it, expect } from 'vitest';
import { etWallClockToUtc, etDate, latestSession, weekdayClose } from './session-window.js';

describe('etWallClockToUtc', () => {
  it('09:30 ET is 13:30Z under EDT and 14:30Z under EST', () => {
    expect(etWallClockToUtc('2026-07-15', 9 * 60 + 30).toISOString()).toBe('2026-07-15T13:30:00.000Z');
    expect(etWallClockToUtc('2026-01-15', 9 * 60 + 30).toISOString()).toBe('2026-01-15T14:30:00.000Z');
  });

  it('is right on both DST switch days', () => {
    // 2026-03-08: clocks spring forward at 02:00 ET; the open is already EDT.
    expect(etWallClockToUtc('2026-03-09', 9 * 60 + 30).toISOString()).toBe('2026-03-09T13:30:00.000Z');
    // 2026-11-01: clocks fall back; Monday 11-02 opens on EST.
    expect(etWallClockToUtc('2026-11-02', 9 * 60 + 30).toISOString()).toBe('2026-11-02T14:30:00.000Z');
    expect(etWallClockToUtc('2026-11-02', 16 * 60).toISOString()).toBe('2026-11-02T21:00:00.000Z');
  });
});

describe('latestSession', () => {
  it('during the session: today, in progress', () => {
    const s = latestSession(new Date('2026-09-24T15:00:00Z'))!;
    expect(s.date).toBe('2026-09-24');
    expect(s.start.toISOString()).toBe('2026-09-24T13:30:00.000Z');
    expect(s.end.toISOString()).toBe('2026-09-24T20:00:00.000Z');
    expect(s.inProgress).toBe(true);
  });

  it('after the close: today, finished', () => {
    const s = latestSession(new Date('2026-09-24T23:00:00Z'))!;
    expect(s.date).toBe('2026-09-24');
    expect(s.inProgress).toBe(false);
  });

  it('before the open (a Sydney-morning run): the previous session', () => {
    // 2026-09-24T12:00Z is 08:00 ET Thursday.
    expect(latestSession(new Date('2026-09-24T12:00:00Z'))!.date).toBe('2026-09-23');
  });

  it('over a weekend: Friday', () => {
    expect(latestSession(new Date('2026-09-27T15:00:00Z'))!.date).toBe('2026-09-25');
  });

  it('respects an injected calendar (holiday, early close)', () => {
    const cal = (d: string): number | null =>
      d === '2026-11-26' ? null : d === '2026-11-27' ? 13 * 60 : weekdayClose(d);
    // Thanksgiving Thursday noon ET → Wednesday's session.
    expect(latestSession(new Date('2026-11-26T17:00:00Z'), cal)!.date).toBe('2026-11-25');
    // Black Friday closes at 13:00 ET = 18:00Z.
    const bf = latestSession(new Date('2026-11-27T19:00:00Z'), cal)!;
    expect(bf.end.toISOString()).toBe('2026-11-27T18:00:00.000Z');
    expect(bf.inProgress).toBe(false);
  });

  it('etDate reads the New York date, not the host one', () => {
    // 02:00Z on the 25th is still the 24th in New York.
    expect(etDate(new Date('2026-09-25T02:00:00Z'))).toBe('2026-09-24');
  });
});
