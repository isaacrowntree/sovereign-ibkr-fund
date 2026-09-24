/**
 * The decisions check.mjs makes, pulled out so they can be tested without a
 * Postgres. Plain .mjs for the same reason as check.mjs: it runs as bare
 * `node` inside the paperclip container.
 */

/**
 * Split agent rows into the fund's and everyone else's.
 *
 * Paperclip hosts more than the fund — the crypto SwingTrader lives in another
 * company on the same instance — and counting it in with the fund made "3 of 9
 * failing" mean nothing: the fund could be perfectly healthy while the headline
 * said otherwise, or be missing an agent the total hid. The fund is one
 * company, named in AGENT_HEALTH_FUND_COMPANY.
 *
 * @template {{ company?: string | null }} R
 * @param {R[]} rows
 * @param {string} fundCompany
 * @returns {{ fund: R[], others: R[] }}
 */
export function splitByCompany(rows, fundCompany) {
  const fund = [];
  const others = [];
  for (const r of rows) (r.company === fundCompany ? fund : others).push(r);
  return { fund, others };
}

/** YYYY-MM-DD in New York for an instant. `en-CA` is ISO-ordered. */
export function etDate(now) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Holiday dates from the NYSE calendar file, whichever shape it has: a list of
 * dates, or a date → name map. Null when the file gave us nothing usable.
 *
 * @param {unknown} cal
 * @returns {{ holidays: Set<string>, validThrough: string | null } | null}
 */
export function readCalendar(cal) {
  if (!cal || typeof cal !== 'object') return null;
  const h = /** @type {any} */ (cal).holidays;
  const list = Array.isArray(h) ? h : h && typeof h === 'object' ? Object.keys(h) : null;
  if (!list) return null;
  const holidays = new Set(list.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))));
  // An explicit end if the file states one; else the last year it lists.
  const stated = /** @type {any} */ (cal).validThrough;
  const lastYear = [...holidays].sort().at(-1)?.slice(0, 4);
  const validThrough = typeof stated === 'string' ? stated : lastYear ? `${lastYear}-12-31` : null;
  return { holidays, validThrough };
}

/**
 * Is `date` (YYYY-MM-DD, New York) an NYSE trading day?
 *
 * FAILS OPEN — a missing calendar, or a date past the end of its table, counts
 * every weekday as a trading day. The cost of that is one spurious "not
 * trading" push on a holiday; the cost of failing closed is silence on a real
 * stall, which is the thing this exists to end. `known` says which it was.
 *
 * @returns {{ trading: boolean, known: boolean }}
 */
export function isTradingDay(date, calendar) {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return { trading: false, known: true };
  if (!calendar || (calendar.validThrough && date > calendar.validThrough)) {
    return { trading: true, known: false };
  }
  return { trading: !calendar.holidays.has(date), known: true };
}

/**
 * The "fund isn't trading" verdict.
 *
 * agent-health's FAILING and SILENT catch an agent that errors or never runs.
 * Neither catches a fund whose agents run and "succeed" on paper while the
 * trading pair has stopped completing — no successful Strategist run means no
 * new orders are planned, no successful Execution Bot run means nothing that
 * was planned is placed. On a trading day that is worth a phone buzz.
 *
 * @param {{ date: string, calendar: ReturnType<typeof readCalendar>,
 *           lastOk: Record<string, number | null>,
 *           limits: Record<string, number> }} input
 *   lastOk: agent name → seconds since its last successful run (null = never).
 *   limits: agent name → the most seconds allowed.
 * @returns {{ key: string, title: string, detail: string, calendarKnown: boolean } | null}
 */
export function tradingStall({ date, calendar, lastOk, limits }) {
  const day = isTradingDay(date, calendar);
  if (!day.trading) return null;
  const stalled = Object.entries(limits)
    .filter(([name, max]) => {
      const age = lastOk[name];
      return age === null || age === undefined || age > max;
    })
    .map(([name]) => name)
    .sort();
  if (!stalled.length) return null;
  const hrs = (s) => (s === null || s === undefined ? 'never' : `${(s / 3600).toFixed(0)}h ago`);
  return {
    key: stalled.join(','),
    title: `Fund isn't trading — no successful ${stalled.join(' or ')} run`,
    detail:
      stalled.map((n) => `${n}: last success ${hrs(lastOk[n])} (limit ${(limits[n] / 3600).toFixed(0)}h)`).join('; ') +
      (day.known ? '' : ' — calendar unavailable or ended, so a weekday was assumed to be a trading day'),
    calendarKnown: day.known,
  };
}

/**
 * Once per New York day. `prev` is what the last attempt recorded; a push
 * that did not go out that day is still due.
 *
 * @param {{ date?: string, pushed?: boolean } | null} prev
 * @param {string} date
 */
export function pushDue(prev, date) {
  return !prev || prev.date !== date || prev.pushed === false;
}
