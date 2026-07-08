import { describe, it, expect } from 'vitest';
import {
  isInWindow,
  isStrategistWindow,
  isExecutionWindow,
  describeWindow,
  STRATEGIST_WINDOW,
  EXECUTION_WINDOW,
} from './market-hours';

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
