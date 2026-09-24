/**
 * US equity market trading-hour gates.
 *
 * Two windows:
 *
 *   STRATEGIST_WINDOW (9:30 AM – 4:00 PM ET)
 *     Full Regular Trading Hours. The Portfolio Strategist will only
 *     generate rebalance orders inside this window — outside it, prices
 *     reflect after-hours quotes (or are stale) and any orders queued
 *     would be either rejected by IBKR or held for the next session.
 *
 *   EXECUTION_WINDOW (10:00 AM – 3:45 PM ET)
 *     Tighter mid-day window optimised for slippage. Skips the first 30
 *     minutes (high open volatility, wide spreads, overnight-gap risk)
 *     and the last 15 minutes (close-auction MOC flow distorts price).
 *     Implementation-shortfall studies put this window at ~1/3 the
 *     slippage of edge minutes for retail-size orders.
 *
 * Implementation note: uses `Intl.DateTimeFormat` with
 * `timeZone: 'America/New_York'` so DST handling is delegated to the
 * runtime's tz database — no hardcoded EDT/EST offset to keep correct.
 *
 * Holidays and early closes come from `nyse-calendar.json`, looked up by
 * the America/New_York date (never the Sydney one the host runs in). It
 * used to ignore them: on Good Friday the bot traded into a closed market,
 * and on the day after Thanksgiving it kept placing orders for three hours
 * after the 1pm close. The JSON is plain data so the .mjs host scripts can
 * read the same table without a build step.
 *
 * The table is finite. Past `validThrough` a weekday is unknown; by default
 * it is treated as an ordinary session (fail open — the old behaviour, and
 * IBKR still rejects into a closed market) and `calendarCoverage` reports
 * it so the caller can alert. CALENDAR_FAIL_OPEN=0 closes every window
 * instead. A test fails 90 days before the table runs out.
 */
import calendar from './nyse-calendar.json';

export interface TradingWindow {
  /** Hour in ET (0-23, inclusive). */
  startHour: number;
  /** Minute in ET (0-59, inclusive). */
  startMinute: number;
  /** Hour in ET (0-23, exclusive — `endHour:endMinute` is the first minute the window is CLOSED). */
  endHour: number;
  /** Minute in ET (0-59, exclusive). */
  endMinute: number;
}

/** 9:30 AM – 4:00 PM ET, weekdays. Full RTH. */
export const STRATEGIST_WINDOW: TradingWindow = {
  startHour: 9,
  startMinute: 30,
  endHour: 16,
  endMinute: 0,
};

/** 10:00 AM – 3:45 PM ET, weekdays. Mid-day (skip open volatility + close auction). */
export const EXECUTION_WINDOW: TradingWindow = {
  startHour: 10,
  startMinute: 0,
  endHour: 15,
  endMinute: 45,
};

interface NyseCalendar {
  regularClose: string;
  validFrom: string;
  validThrough: string;
  holidays: Record<string, string>;
  earlyCloses: Record<string, { close: string; name: string }>;
}

/** The raw table, for callers that want to show or reuse it. */
export const NYSE_CALENDAR: NyseCalendar = calendar;

const hhmmToMinutes = (s: string): number => {
  const [h, m] = s.split(':').map((x) => parseInt(x, 10));
  return h * 60 + m;
};
const REGULAR_CLOSE_MINS = hhmmToMinutes(NYSE_CALENDAR.regularClose);

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Wall clock in New York: the date the exchange is trading, and minutes since midnight. */
export function etClock(now: Date): { date: string; weekday: string; minutes: number } {
  const parts = ET_FMT.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday'),
    minutes: Number.isNaN(hour) || Number.isNaN(minute) ? NaN : hour * 60 + minute,
  };
}

export type SessionKind = 'weekend' | 'holiday' | 'regular' | 'early-close' | 'unknown';

export interface NyseSession {
  kind: SessionKind;
  /** Close in minutes after midnight ET; absent when the market does not open. */
  closeMinutes?: number;
  /** Holiday / early-close name from the table. */
  name?: string;
}

const WEEKDAY_OF = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * What kind of day an ET date (`YYYY-MM-DD`) is. `unknown` is a weekday the
 * table does not cover — see the header for how the windows treat it.
 */
export function nyseSession(date: string): NyseSession {
  const dow = WEEKDAY_OF(date);
  if (dow === 0 || dow === 6) return { kind: 'weekend' };
  const holiday = NYSE_CALENDAR.holidays[date];
  if (holiday) return { kind: 'holiday', name: holiday };
  const early = NYSE_CALENDAR.earlyCloses[date];
  if (early) return { kind: 'early-close', closeMinutes: hhmmToMinutes(early.close), name: early.name };
  if (date < NYSE_CALENDAR.validFrom || date > NYSE_CALENDAR.validThrough) return { kind: 'unknown' };
  return { kind: 'regular', closeMinutes: REGULAR_CLOSE_MINS };
}

/** CALENDAR_FAIL_OPEN, default on: an uncovered weekday trades as a regular session. */
export function calendarFailOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CALENDAR_FAIL_OPEN ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Is `date` (an ET `YYYY-MM-DD`, or a Date read in ET) a day the NYSE opens?
 * An uncovered weekday follows CALENDAR_FAIL_OPEN.
 */
export function isTradingDay(date: string | Date, env: NodeJS.ProcessEnv = process.env): boolean {
  const d = typeof date === 'string' ? date : etClock(date).date;
  const s = nyseSession(d);
  if (s.kind === 'regular' || s.kind === 'early-close') return true;
  return s.kind === 'unknown' ? calendarFailOpen(env) : false;
}

export interface CalendarCoverage {
  /** Does the table cover `now`'s ET date? */
  covered: boolean;
  validThrough: string;
  /** Whole days from `now`'s ET date to the last covered date (negative once past). */
  daysLeft: number;
}

/** How much calendar is left. Callers alert on `!covered`. */
export function calendarCoverage(now: Date): CalendarCoverage {
  const { date } = etClock(now);
  const days = (Date.parse(`${NYSE_CALENDAR.validThrough}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
  return {
    covered: date >= NYSE_CALENDAR.validFrom && date <= NYSE_CALENDAR.validThrough,
    validThrough: NYSE_CALENDAR.validThrough,
    daysLeft: Math.round(days),
  };
}

/**
 * True iff the NYSE is open on `now`'s ET date and the ET wall clock falls
 * within `window`. On an early-close day the window's end moves earlier by
 * as much as the close does, so the execution window still stops 15 minutes
 * before the bell (12:45 on a 13:00 close). Pure apart from reading
 * CALENDAR_FAIL_OPEN; safe to call with any Date.
 */
export function isInWindow(now: Date, window: TradingWindow, env: NodeJS.ProcessEnv = process.env): boolean {
  const clock = etClock(now);
  if (Number.isNaN(clock.minutes)) return false;

  const session = nyseSession(clock.date);
  let closeMins: number;
  if (session.kind === 'weekend' || session.kind === 'holiday') return false;
  if (session.kind === 'unknown') {
    if (!calendarFailOpen(env)) return false;
    closeMins = REGULAR_CLOSE_MINS;
  } else {
    closeMins = session.closeMinutes ?? REGULAR_CLOSE_MINS;
  }

  const startMins = window.startHour * 60 + window.startMinute;
  const endMins = window.endHour * 60 + window.endMinute - (REGULAR_CLOSE_MINS - closeMins);

  return clock.minutes >= startMins && clock.minutes < endMins;
}

/** True during 9:30-16:00 ET on NYSE trading days. Used by Portfolio Strategist. */
export function isStrategistWindow(now: Date = new Date()): boolean {
  return isInWindow(now, STRATEGIST_WINDOW);
}

/** True during 10:00-15:45 ET on NYSE trading days. Used by Execution Bot. */
export function isExecutionWindow(now: Date = new Date()): boolean {
  return isInWindow(now, EXECUTION_WINDOW);
}

/** Human-readable description of a window for log messages. */
export function describeWindow(window: TradingWindow): string {
  const fmt = (h: number, m: number): string =>
    `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  return `${fmt(window.startHour, window.startMinute)}-${fmt(window.endHour, window.endMinute)} ET, weekdays`;
}
