/**
 * Daily price-history accumulation.
 *
 * Every consumer of `state.priceHistory` treats the array index as a TRADING
 * DAY: portfolio-strategist's HRP gate, the `>= 200` regime window,
 * MIN_REGRESSION_OBS, and annualizeVol()'s sqrt(252). Nothing enforced that.
 * quant-analyst appended one sample per RUN, and paperclip schedules it every
 * 4h, so the series grew ~6x faster than calendar time. On 2026-08-19 that made
 * ~6 calendar days of data present itself as "37 days", clear a 20-day gate,
 * and rebalance a live account off a 6-day covariance estimate.
 *
 * THE INVARIANT IS RIGHT-ANCHORED: every series ends on the most recent trading
 * day in `priceHistoryDates`. Series may have DIFFERENT lengths — a holding
 * added last week legitimately has a shorter history than one held for a year —
 * so `slice(-n)` across symbols is aligned but `[0]` across symbols is not.
 * Consumers must take the most recent N observations, never the oldest.
 *
 * NOTHING HERE FABRICATES A PRICE. An earlier version padded short series with
 * the current price to force equal lengths. That looked tidy and was the worst
 * possible behaviour: a newly added symbol got a full-length series of identical
 * values, i.e. zero variance, and HRP weights on inverse variance — so review
 * measured the new holding taking 61% of the book (72% under risk parity) on its
 * first day. It also defeated the very gate this module exists to protect,
 * because a full-length fake series clears a minimum-observations check that a
 * short real one correctly fails.
 */

/**
 * The trading date a sample belongs to, in New York, or `null` on a weekend.
 *
 * New York rather than the host's date: the Pi runs AEST, where one US session
 * straddles two local dates and would book two "days" for a single session.
 *
 * Weekends are excluded because the agent runs every 4h all week and the gateway
 * happily returns Friday's last close on a Saturday. Accepting those appended
 * ~104 duplicate samples a year, each a synthetic zero-return day, which deflate
 * variance and dilute every correlation estimate — measured at a 15-18%
 * understatement of annualized vol, which feeds volTargetLeverage and would size
 * the live book UP.
 *
 * US market holidays are NOT handled: they need a maintained calendar, and their
 * cost is ~9 duplicate samples a year against 252, versus 104 for weekends.
 * Holiday samples are harmless-but-imperfect zero-return days.
 */
export function marketDate(now: Date = new Date()): string | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';

  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return null;

  const [y, m, d] = [get('year'), get('month'), get('day')];
  if (!y || !m || !d) return null;
  return `${y}-${m}-${d}`;
}

export interface PriceHistoryState {
  priceHistory: Record<string, number[]>;
  priceHistoryDates: string[];
  /** True when this sample opened a new trading day rather than updating today. */
  isNewDay: boolean;
  /** True when undated legacy intraday samples were discarded. */
  migrated: boolean;
  /** Symbols carried forward because the gateway did not quote them. */
  carriedForward: string[];
}

/**
 * Fold one round of quotes into the daily series.
 *
 * Appends on a new trading day, overwrites on the same day — so the stored
 * sample is the last of the session, i.e. the closest available to the US close,
 * rather than whichever intraday tick happened to land first.
 *
 * Pass `today = null` (a weekend) and the state is returned unchanged.
 */
export function recordDailySample(
  priceHistory: Record<string, number[]>,
  priceHistoryDates: string[],
  prices: Map<string, number> | Iterable<[string, number]>,
  today: string | null,
  maxDays = 500,
): PriceHistoryState {
  const history: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(priceHistory)) history[k] = [...v];
  let dates = [...priceHistoryDates];
  const quoted = new Map(prices);

  // Not a trading day — record nothing rather than duplicating Friday's close.
  if (today === null) {
    return {
      priceHistory: history, priceHistoryDates: dates,
      isNewDay: false, migrated: false, carriedForward: [],
    };
  }

  // One-time migration off the undated intraday series. Those samples are hours
  // apart with no dates attached, so they cannot be re-bucketed retroactively,
  // and leaving them would keep overstating the day count. Keep the latest price
  // per symbol as today's sample and let the series rebuild honestly.
  const migrated = dates.length === 0 && Object.keys(history).length > 0;
  if (migrated) {
    for (const sym of Object.keys(history)) {
      const ph = history[sym];
      history[sym] = ph.length > 0 ? [ph[ph.length - 1]] : [];
    }
    dates = [today];
  }

  const isNewDay = dates[dates.length - 1] !== today;
  if (isNewDay) dates.push(today);

  // Iterate every KNOWN symbol, not just the quoted ones. getMarketPrices returns
  // a partial map by design (unresolved conid, throttled feed), and a symbol that
  // is simply skipped would be left one day short — permanently misaligning it
  // against every other series under the right-anchored invariant. Review
  // measured two identical series reading as correlation 0.048 instead of 1.0
  // from exactly this.
  const carriedForward: string[] = [];
  for (const sym of new Set([...Object.keys(history), ...quoted.keys()])) {
    if (!history[sym]) history[sym] = [];
    const ph = history[sym];
    const quote = quoted.get(sym);

    if (isNewDay) {
      // Carry forward the LAST KNOWN price, never a later one. Writing today's
      // price into a missed day's slot books the whole multi-day move on the
      // wrong date and leaves a fake zero-return day after it.
      if (quote !== undefined) ph.push(quote);
      else if (ph.length > 0) { ph.push(ph[ph.length - 1]); carriedForward.push(sym); }
      // A symbol with no history and no quote stays empty — nothing to invent.
    } else if (quote !== undefined) {
      if (ph.length === 0) ph.push(quote);
      else ph[ph.length - 1] = quote;
    }

    // Cap per symbol. Trimming from the LEFT preserves the right-anchored
    // invariant: the series still ends on `today`.
    if (ph.length > maxDays) history[sym] = ph.slice(-maxDays);
  }
  if (dates.length > maxDays) dates = dates.slice(-maxDays);

  return { priceHistory: history, priceHistoryDates: dates, isNewDay, migrated, carriedForward };
}
