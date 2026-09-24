/**
 * The NYSE regular session as UTC instants, DST-correct.
 *
 * risk-manager anchored its intraday window at a hard-coded 13:30Z, which is
 * 09:30 ET only while New York is on EDT; for the EST half of the year it began
 * an hour early and swept pre-market frames into the "session" (2026-09-24
 * review, C′3). This computes open and close from the America/New_York wall
 * clock via the runtime's tz database.
 *
 * Holidays and early closes are the calendar module's job (WS-A0, I1). Until
 * that lands this defaults to "every weekday, 16:00 close"; callers can inject
 * the calendar's answer through `closeMinutesFor` (return null for a day the
 * exchange does not open), which is how the calendar is wired in on merge.
 */

const ET = 'America/New_York';
const OPEN_MINUTES = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTES = 16 * 60;

/** Offset of New York from UTC at `instant`, in minutes (EDT = -240, EST = -300). */
function etOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (t: string): number => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The UTC instant at which New York's wall clock reads `date` + `minutes`. */
export function etWallClockToUtc(date: string, minutes: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // Two passes settle the offset even when the guess lands across a DST switch.
  let t = naive - etOffsetMinutes(new Date(naive)) * 60_000;
  t = naive - etOffsetMinutes(new Date(t)) * 60_000;
  return new Date(t);
}

/** The ET calendar date (YYYY-MM-DD) of `instant`. */
export function etDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(instant);
}

/** Default calendar: weekdays open, regular close. The WS-A0 calendar replaces it. */
export function weekdayClose(date: string): number | null {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6 ? null : REGULAR_CLOSE_MINUTES;
}

export interface SessionWindow {
  /** ET trading date of the session. */
  date: string;
  start: Date;
  end: Date;
  /** True when `now` is inside [start, end). */
  inProgress: boolean;
}

/**
 * The most recent regular session that has OPENED as of `now` — today's if the
 * bell has rung, otherwise the previous trading day's (looking back up to ten
 * days, which spans any holiday cluster).
 */
export function latestSession(
  now: Date,
  closeMinutesFor: (date: string) => number | null = weekdayClose,
): SessionWindow | null {
  let cursor = now;
  for (let i = 0; i < 10; i++) {
    const date = etDate(cursor);
    const close = closeMinutesFor(date);
    if (close !== null) {
      const start = etWallClockToUtc(date, OPEN_MINUTES);
      if (start.getTime() <= now.getTime()) {
        const end = etWallClockToUtc(date, close);
        return { date, start, end, inProgress: now.getTime() < end.getTime() };
      }
    }
    // Step back into the previous ET day: noon ET the day before is always safe.
    const [y, m, d] = date.split('-').map(Number);
    cursor = etWallClockToUtc(new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10), 12 * 60);
  }
  return null;
}
