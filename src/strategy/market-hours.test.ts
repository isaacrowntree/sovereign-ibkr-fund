import { describe, it, expect } from 'vitest';
import {
  isInWindow,
  isStrategistWindow,
  isExecutionWindow,
  describeWindow,
  STRATEGIST_WINDOW,
  EXECUTION_WINDOW,
  nyseSession,
  isTradingDay,
  calendarCoverage,
  calendarFailOpen,
  etClock,
  NYSE_CALENDAR,
} from './market-hours';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Helper: build a Date that, when formatted in America/New_York, gives
 * the requested wall-clock time. Picks a date inside EDT (mid-May) or EST
 * (mid-January) so DST behaviour is exercised explicitly.
 *
 * Strategy: pick a UTC instant that is `targetEtHour - utcOffset` UTC.
 * EDT = UTC-4, EST = UTC-5.
 */
function etDate(year: number, month: number, day: number, hour: number, minute: number, dst: 'EDT' | 'EST'): Date {
  const offset = dst === 'EDT' ? 4 : 5;
  return new Date(Date.UTC(year, month - 1, day, hour + offset, minute));
}

describe('isInWindow — weekday handling', () => {
  it('returns true on a Tuesday during EDT mid-day', () => {
    // 2026-05-12 is a Tuesday
    const d = etDate(2026, 5, 12, 10, 30, 'EDT');
    expect(isInWindow(d, STRATEGIST_WINDOW)).toBe(true);
    expect(isInWindow(d, EXECUTION_WINDOW)).toBe(true);
  });

  it('returns false on Saturday even during normal trading hours', () => {
    // 2026-05-09 is a Saturday
    const d = etDate(2026, 5, 9, 10, 30, 'EDT');
    expect(isInWindow(d, STRATEGIST_WINDOW)).toBe(false);
    expect(isInWindow(d, EXECUTION_WINDOW)).toBe(false);
  });

  it('returns false on Sunday', () => {
    // 2026-05-10 is a Sunday
    const d = etDate(2026, 5, 10, 10, 30, 'EDT');
    expect(isInWindow(d, STRATEGIST_WINDOW)).toBe(false);
  });
});

describe('isInWindow — STRATEGIST_WINDOW boundary minutes', () => {
  // 2026-05-12 is a Tuesday in EDT
  const day = (h: number, m: number) => etDate(2026, 5, 12, h, m, 'EDT');

  it('9:29 ET is OUTSIDE (one minute before open)', () => {
    expect(isInWindow(day(9, 29), STRATEGIST_WINDOW)).toBe(false);
  });

  it('9:30 ET is INSIDE (the bell)', () => {
    expect(isInWindow(day(9, 30), STRATEGIST_WINDOW)).toBe(true);
  });

  it('15:59 ET is INSIDE (one minute before close)', () => {
    expect(isInWindow(day(15, 59), STRATEGIST_WINDOW)).toBe(true);
  });

  it('16:00 ET is OUTSIDE (the close bell — exclusive end)', () => {
    expect(isInWindow(day(16, 0), STRATEGIST_WINDOW)).toBe(false);
  });

  it('after-hours late afternoon is OUTSIDE', () => {
    expect(isInWindow(day(18, 30), STRATEGIST_WINDOW)).toBe(false);
  });

  it('pre-dawn is OUTSIDE', () => {
    expect(isInWindow(day(4, 0), STRATEGIST_WINDOW)).toBe(false);
  });
});

describe('isInWindow — EXECUTION_WINDOW boundary minutes', () => {
  const day = (h: number, m: number) => etDate(2026, 5, 12, h, m, 'EDT');

  it('9:59 ET is OUTSIDE (one minute before execution opens)', () => {
    expect(isInWindow(day(9, 59), EXECUTION_WINDOW)).toBe(false);
  });

  it('10:00 ET is INSIDE (execution window opens)', () => {
    expect(isInWindow(day(10, 0), EXECUTION_WINDOW)).toBe(true);
  });

  it('15:44 ET is INSIDE (one minute before execution closes)', () => {
    expect(isInWindow(day(15, 44), EXECUTION_WINDOW)).toBe(true);
  });

  it('15:45 ET is OUTSIDE (close-auction guard — exclusive end)', () => {
    expect(isInWindow(day(15, 45), EXECUTION_WINDOW)).toBe(false);
  });

  it('strategist-window open-volatility margin is OUTSIDE execution', () => {
    // 9:35 ET — strategist OK, execution gated
    expect(isInWindow(day(9, 35), STRATEGIST_WINDOW)).toBe(true);
    expect(isInWindow(day(9, 35), EXECUTION_WINDOW)).toBe(false);
  });

  it('strategist-window close-auction margin is OUTSIDE execution', () => {
    // 15:50 ET — strategist OK, execution gated
    expect(isInWindow(day(15, 50), STRATEGIST_WINDOW)).toBe(true);
    expect(isInWindow(day(15, 50), EXECUTION_WINDOW)).toBe(false);
  });
});

describe('isInWindow — DST handling', () => {
  it('EDT (May): 10:30 wall-clock ET is 14:30 UTC and inside window', () => {
    const d = etDate(2026, 5, 12, 10, 30, 'EDT');
    expect(d.getUTCHours()).toBe(14);
    expect(isInWindow(d, EXECUTION_WINDOW)).toBe(true);
  });

  it('EST (January): 10:30 wall-clock ET is 15:30 UTC and inside window', () => {
    // 2026-01-13 is a Tuesday in EST
    const d = etDate(2026, 1, 13, 10, 30, 'EST');
    expect(d.getUTCHours()).toBe(15);
    expect(isInWindow(d, EXECUTION_WINDOW)).toBe(true);
  });

  it('EST 4:00 AM ET (UTC 09:00) is OUTSIDE — does not collide with EDT 9:00 ET assumptions', () => {
    const d = etDate(2026, 1, 13, 4, 0, 'EST');
    expect(isInWindow(d, STRATEGIST_WINDOW)).toBe(false);
  });
});

describe('public helpers', () => {
  it('isStrategistWindow defaults to current time', () => {
    // Just confirm it returns a boolean without throwing
    expect(typeof isStrategistWindow()).toBe('boolean');
  });

  it('isExecutionWindow defaults to current time', () => {
    expect(typeof isExecutionWindow()).toBe('boolean');
  });

  it('describeWindow renders human-readable string', () => {
    expect(describeWindow(STRATEGIST_WINDOW)).toBe('09:30-16:00 ET, weekdays');
    expect(describeWindow(EXECUTION_WINDOW)).toBe('10:00-15:45 ET, weekdays');
  });
});

describe('NYSE calendar — holidays and early closes', () => {
  it('Good Friday 2026 is closed all day, both windows', () => {
    const d = etDate(2026, 4, 3, 11, 0, 'EDT');
    expect(nyseSession('2026-04-03').kind).toBe('holiday');
    expect(isInWindow(d, STRATEGIST_WINDOW)).toBe(false);
    expect(isInWindow(d, EXECUTION_WINDOW)).toBe(false);
  });

  it('observed holidays close the observed day, not the calendar one', () => {
    // July 4 2026 is a Saturday → Friday July 3 closed.
    expect(isInWindow(etDate(2026, 7, 3, 11, 0, 'EDT'), EXECUTION_WINDOW)).toBe(false);
    // Christmas 2027 is a Saturday → Friday Dec 24 closed.
    expect(nyseSession('2027-12-24').kind).toBe('holiday');
    // Juneteenth 2027 is a Saturday → Friday June 18 closed.
    expect(nyseSession('2027-06-18').kind).toBe('holiday');
  });

  it('New Year 2028 falls on a Saturday and NYSE observes no holiday for it', () => {
    expect(nyseSession('2027-12-31').kind).toBe('regular');
    expect(isInWindow(etDate(2027, 12, 31, 11, 0, 'EST'), EXECUTION_WINDOW)).toBe(true);
  });

  it('day after Thanksgiving closes at 13:00: execution stops at 12:45, strategist at 13:00', () => {
    const day = (h: number, m: number) => etDate(2026, 11, 27, h, m, 'EST');
    expect(nyseSession('2026-11-27')).toMatchObject({ kind: 'early-close', closeMinutes: 13 * 60 });
    expect(isInWindow(day(12, 44), EXECUTION_WINDOW)).toBe(true);
    expect(isInWindow(day(12, 45), EXECUTION_WINDOW)).toBe(false);
    expect(isInWindow(day(12, 59), STRATEGIST_WINDOW)).toBe(true);
    expect(isInWindow(day(13, 0), STRATEGIST_WINDOW)).toBe(false);
    expect(isInWindow(day(14, 0), EXECUTION_WINDOW)).toBe(false);
  });

  it('holidays are looked up by the New York date, not the UTC or Sydney one', () => {
    // 21:00 ET on Thursday 2026-04-02 is already Friday (Good Friday) in UTC
    // and Sydney; the ET date is still the Thursday, a regular session.
    const evening = etDate(2026, 4, 2, 21, 0, 'EDT');
    expect(evening.getUTCDate()).toBe(3);
    expect(etClock(evening).date).toBe('2026-04-02');
    expect(isTradingDay(evening)).toBe(true);
    expect(isTradingDay(etDate(2026, 4, 3, 10, 0, 'EDT'))).toBe(false);
  });

  it('every holiday and early close is a weekday, and the two lists do not overlap', () => {
    for (const d of Object.keys(NYSE_CALENDAR.holidays)) {
      expect(nyseSession(d).kind, d).toBe('holiday');
      expect([0, 6]).not.toContain(new Date(`${d}T12:00:00Z`).getUTCDay());
    }
    for (const d of Object.keys(NYSE_CALENDAR.earlyCloses)) {
      expect(NYSE_CALENDAR.holidays[d as keyof typeof NYSE_CALENDAR.holidays], d).toBeUndefined();
      expect([0, 6]).not.toContain(new Date(`${d}T12:00:00Z`).getUTCDay());
    }
  });

  it('has the ten-ish holidays NYSE publishes per year', () => {
    const perYear = (y: string) => Object.keys(NYSE_CALENDAR.holidays).filter(d => d.startsWith(y)).length;
    expect(perYear('2026')).toBe(10);
    expect(perYear('2027')).toBe(10);
    expect(perYear('2028')).toBe(9); // no New Year holiday observed in 2028
  });
});

describe('NYSE calendar — past the end of the table', () => {
  const beyond = etDate(2029, 3, 6, 11, 0, 'EST'); // a Tuesday in 2029

  it('an uncovered weekday is unknown, and trades by default (fail open)', () => {
    expect(nyseSession('2029-03-06').kind).toBe('unknown');
    expect(calendarCoverage(beyond).covered).toBe(false);
    expect(isInWindow(beyond, EXECUTION_WINDOW, {})).toBe(true);
    expect(isTradingDay('2029-03-06', {})).toBe(true);
  });

  it('CALENDAR_FAIL_OPEN=0 closes every window on an uncovered day', () => {
    const env = { CALENDAR_FAIL_OPEN: '0' };
    expect(calendarFailOpen(env)).toBe(false);
    expect(isInWindow(beyond, EXECUTION_WINDOW, env)).toBe(false);
    expect(isTradingDay('2029-03-06', env)).toBe(false);
  });

  it('weekends stay closed past the table whatever the flag says', () => {
    expect(isTradingDay('2029-03-03', {})).toBe(false);
  });

  it('the table has at least 90 days left — extend nyse-calendar.json from nyse.com when this fails', () => {
    const cov = calendarCoverage(new Date());
    expect(cov.daysLeft, `NYSE calendar runs out on ${cov.validThrough}`).toBeGreaterThanOrEqual(90);
  });
});

describe('NYSE calendar — importable without a build step', () => {
  it('is plain JSON a bare .mjs script can JSON.parse', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, 'nyse-calendar.json'), 'utf8'));
    expect(raw.validThrough).toBe(NYSE_CALENDAR.validThrough);
    expect(Object.keys(raw.holidays).length).toBeGreaterThan(20);
  });
});
