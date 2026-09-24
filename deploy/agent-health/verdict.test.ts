import { describe, it, expect } from 'vitest';
import { splitByCompany, etDate, readCalendar, isTradingDay, tradingStall, pushDue } from './verdict.mjs';
import calendarJson from '../../src/strategy/nyse-calendar.json';

const H = 3600;
const LIMITS = { 'Portfolio Strategist': 24 * H, 'Execution Bot': 48 * H };
const cal = readCalendar(calendarJson);

describe('splitByCompany', () => {
  it('keeps the fund apart from other companies on the same paperclip', () => {
    const rows = [
      { name: 'Execution Bot', company: 'IBKR Fund' },
      { name: 'SwingTrader', company: 'Trading' },
      { name: 'Orphan', company: null },
    ];
    const { fund, others } = splitByCompany(rows, 'IBKR Fund');
    expect(fund.map((r) => r.name)).toEqual(['Execution Bot']);
    expect(others.map((r) => r.name)).toEqual(['SwingTrader', 'Orphan']);
  });
});

describe('etDate', () => {
  it('is the New York date, not the host one', () => {
    // 2026-09-24 22:00 Sydney = 08:00 New York, same day; 06:00 Sydney the next
    // morning is still the previous evening in New York.
    expect(etDate(new Date('2026-09-24T12:00:00Z'))).toBe('2026-09-24');
    expect(etDate(new Date('2026-09-25T02:00:00Z'))).toBe('2026-09-24');
  });
});

describe('readCalendar', () => {
  it('reads the shipped calendar file', () => {
    expect(cal).not.toBeNull();
    expect(cal!.holidays.has('2026-11-26')).toBe(true);
  });

  it('accepts a date → name map as well as a list (both shapes are in flight)', () => {
    const c = readCalendar({ holidays: { '2026-12-25': 'Christmas Day' } });
    expect(c!.holidays.has('2026-12-25')).toBe(true);
    expect(c!.validThrough).toBe('2026-12-31');
  });

  it('is null for something that is not a calendar', () => {
    expect(readCalendar(null)).toBeNull();
    expect(readCalendar({ nope: 1 })).toBeNull();
  });
});

describe('isTradingDay', () => {
  it('weekends never trade', () => {
    expect(isTradingDay('2026-09-26', cal)).toEqual({ trading: false, known: true });
  });
  it('a listed holiday does not trade', () => {
    expect(isTradingDay('2026-11-26', cal)).toEqual({ trading: false, known: true });
  });
  it('an ordinary weekday trades', () => {
    expect(isTradingDay('2026-09-24', cal)).toEqual({ trading: true, known: true });
  });
  it('FAILS OPEN without a calendar, or past its end — a weekday is assumed to trade', () => {
    expect(isTradingDay('2026-11-26', null)).toEqual({ trading: true, known: false });
    expect(isTradingDay('2029-01-02', cal)).toEqual({ trading: true, known: false });
  });
});

describe('tradingStall', () => {
  const ok = { 'Portfolio Strategist': 4 * H, 'Execution Bot': 20 * H };

  it('quiet when both have succeeded recently', () => {
    expect(tradingStall({ date: '2026-09-24', calendar: cal, lastOk: ok, limits: LIMITS })).toBeNull();
  });

  it('no successful strategist run in 24h on a trading day → stall', () => {
    const s = tradingStall({ date: '2026-09-24', calendar: cal, lastOk: { ...ok, 'Portfolio Strategist': 25 * H }, limits: LIMITS });
    expect(s!.key).toBe('Portfolio Strategist');
    expect(s!.title).toContain("Fund isn't trading");
    expect(s!.detail).toContain('25h ago');
  });

  it('the executor gets 48h, and never-succeeded counts as stalled', () => {
    expect(tradingStall({ date: '2026-09-24', calendar: cal, lastOk: { ...ok, 'Execution Bot': 47 * H }, limits: LIMITS })).toBeNull();
    const s = tradingStall({ date: '2026-09-24', calendar: cal, lastOk: { ...ok, 'Execution Bot': null }, limits: LIMITS });
    expect(s!.key).toBe('Execution Bot');
    expect(s!.detail).toContain('never');
  });

  it('says nothing on a weekend or a holiday', () => {
    const dead = { 'Portfolio Strategist': null, 'Execution Bot': null };
    expect(tradingStall({ date: '2026-09-26', calendar: cal, lastOk: dead, limits: LIMITS })).toBeNull();
    expect(tradingStall({ date: '2026-11-26', calendar: cal, lastOk: dead, limits: LIMITS })).toBeNull();
  });

  it('says so when it had to assume the day trades', () => {
    const s = tradingStall({ date: '2026-09-24', calendar: null, lastOk: { ...ok, 'Execution Bot': null }, limits: LIMITS });
    expect(s!.calendarKnown).toBe(false);
    expect(s!.detail).toContain('calendar unavailable');
  });
});

describe('pushDue', () => {
  it('once per New York day', () => {
    expect(pushDue(null, '2026-09-24')).toBe(true);
    expect(pushDue({ date: '2026-09-24', pushed: true }, '2026-09-24')).toBe(false);
    expect(pushDue({ date: '2026-09-23', pushed: true }, '2026-09-24')).toBe(true);
  });
  it('a push that failed is still due the same day', () => {
    expect(pushDue({ date: '2026-09-24', pushed: false }, '2026-09-24')).toBe(true);
  });
});
