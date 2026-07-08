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
 * Caveat: does NOT account for US market holidays (Christmas, July 4,
 * MLK Day, etc.). On a holiday during normal hours, this returns true
 * and the bot tries to trade — IBKR rejects the order. Acceptable noise
 * for retail volume; if it becomes a real problem, add a holiday-list
 * table maintained yearly.
 */

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

/**
 * True iff `now` is a US weekday and the wall-clock time in
 * America/New_York falls within `window`. Pure function; safe to call
 * with any Date including injected fakes for tests.
 */
export function isInWindow(now: Date, window: TradingWindow): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return false;

  const minutesSinceMidnight = hour * 60 + minute;
  const startMins = window.startHour * 60 + window.startMinute;
  const endMins = window.endHour * 60 + window.endMinute;

  return minutesSinceMidnight >= startMins && minutesSinceMidnight < endMins;
}

/** True during 9:30-16:00 ET on weekdays. Used by Portfolio Strategist. */
export function isStrategistWindow(now: Date = new Date()): boolean {
  return isInWindow(now, STRATEGIST_WINDOW);
}

/** True during 10:00-15:45 ET on weekdays. Used by Execution Bot. */
export function isExecutionWindow(now: Date = new Date()): boolean {
  return isInWindow(now, EXECUTION_WINDOW);
}

/** Human-readable description of a window for log messages. */
export function describeWindow(window: TradingWindow): string {
  const fmt = (h: number, m: number): string =>
    `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  return `${fmt(window.startHour, window.startMinute)}-${fmt(window.endHour, window.endMinute)} ET, weekdays`;
}
