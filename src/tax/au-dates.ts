/**
 * Dates for Australian CGT on US-listed shares. One helper, used everywhere a
 * tax date is needed, so no two parts of the fund can disagree about which day
 * a trade happened on or when a parcel becomes discountable.
 *
 * ## Which day a trade happened on
 *
 * The CGT event for a sale of shares is the CONTRACT date (s104-10(3)) — the
 * day the trade was struck on the exchange — not settlement, and not the date
 * in Sydney. A US trade at 10:00 New York time on 30 June is a 30 June trade
 * even though it is already 1 July in Sydney, and that decides the financial
 * year. So a trade's date is its date in US/Eastern.
 *
 * ## When a parcel becomes discountable
 *
 * s115-25: the asset must have been acquired at least 12 months before the CGT
 * event, and the ATO counts that excluding both the acquisition day and the
 * event day. In calendar terms: a sale is discountable iff its trade date is on
 * or after (buy date + 1 year + 1 day). Bought 2024-03-15 → discountable from
 * 2025-03-16. The old code used `> 365` days, which is a day early after any
 * 29 February and a day late otherwise.
 *
 * A 29 February purchase has no anniversary; "+1 year" lands on 28 February
 * of the next year (the last day of the 12-month period), so the parcel is
 * discountable from 1 March.
 *
 * Any logic that WAITS for the discount keeps a margin (default 2 days) on top:
 * a sale booked on the boundary day in New York is easy to get wrong by one
 * day, and the cost of being early is the whole discount.
 */

/** YYYY-MM-DD, zero-padded. */
export type IsoDate = string;

const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * The exchange (US/Eastern) trade date of a timestamp.
 *
 * Accepts an ISO timestamp, a bare `YYYY-MM-DD` (taken as already being the
 * trade date) or IBKR's compact `YYYYMMDD`. Returns undefined when unparseable.
 */
export function exchangeTradeDate(ts: string | undefined | null): IsoDate | undefined {
  if (!ts) return undefined;
  const s = String(ts).trim();
  const d = s.match(DATE_ONLY);
  if (d) return s;
  const c = s.match(COMPACT);
  if (c) return `${c[1]}-${c[2]}-${c[3]}`;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return undefined;
  return ET_DATE.format(new Date(ms));
}

/** Trade date of a ledger record: its explicit `tradeDate`, else derived from `timestamp`. */
export function tradeDateOf(t: { tradeDate?: string; timestamp?: string }): IsoDate | undefined {
  return exchangeTradeDate(t.tradeDate) ?? exchangeTradeDate(t.timestamp);
}

function parts(date: IsoDate): [number, number, number] {
  const m = date.match(DATE_ONLY);
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fmt(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add whole days to a date. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Same day next year; 29 Feb clamps to 28 Feb. */
export function addOneYear(date: IsoDate): IsoDate {
  const [y, m, d] = parts(date);
  return fmt(y + 1, m, Math.min(d, daysInMonth(y + 1, m)));
}

/** Calendar days from `a` to `b` (b − a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/** First trade date on which a sale of a parcel bought on `buyDate` gets the 50% discount. */
export function discountEligibleFrom(buyDate: IsoDate): IsoDate {
  return addDays(addOneYear(buyDate), 1);
}

/** s115-25: discountable iff sold on or after buy date + 1 year + 1 day. */
export function isDiscountEligible(buyDate: IsoDate, sellDate: IsoDate): boolean {
  return sellDate >= discountEligibleFrom(buyDate);
}

/**
 * The earliest date a strategy that is WAITING for the discount should sell,
 * with a safety margin (default 2 days) past the legal boundary.
 */
export function safeDiscountDate(buyDate: IsoDate, marginDays = 2): IsoDate {
  return addDays(discountEligibleFrom(buyDate), marginDays);
}

/**
 * Australian financial year a date falls in, labelled by the year it ENDS:
 * 2025-07-01 .. 2026-06-30 is "FY2026".
 */
export function financialYearOf(date: IsoDate): string {
  const [y, m] = parts(date);
  return `FY${m >= 7 ? y + 1 : y}`;
}

/** First and last day of a financial year label ("FY2026" → 2025-07-01 .. 2026-06-30). */
export function financialYearBounds(fy: string): { start: IsoDate; end: IsoDate } {
  const m = fy.match(/^FY(\d{4})$/);
  if (!m) throw new Error(`not a financial year label: ${fy}`);
  const y = Number(m[1]);
  return { start: fmt(y - 1, 7, 1), end: fmt(y, 6, 30) };
}
