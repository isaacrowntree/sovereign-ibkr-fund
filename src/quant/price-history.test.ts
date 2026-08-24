import { describe, it, expect } from 'vitest';
import { recordDailySample, marketDate } from './price-history.js';

const P = (prices: Record<string, number>) => new Map(Object.entries(prices));

describe('recordDailySample', () => {
  it('the regression: repeated runs on one day do NOT add days', () => {
    // The 2026-08-18 incident in one test. quant-analyst runs every 4h; the old
    // code pushed on every run, so six runs looked like six days of history.
    let ph: Record<string, number[]> = { AAA: [10], BBB: [20] };
    let dates = ['2026-08-19'];
    for (const p of [11, 12, 13, 14, 15, 16]) {
      const r = recordDailySample(ph, dates, P({ AAA: p, BBB: p * 2 }), '2026-08-19');
      ph = r.priceHistory;
      dates = r.priceHistoryDates;
    }
    expect(dates).toEqual(['2026-08-19']);
    // Last run of the day wins — the sample closest to the US close.
    expect(ph.AAA).toEqual([16]);
    expect(ph.BBB).toEqual([32]);
  });

  it('NEVER fabricates history for a newly added symbol', () => {
    // The defect this file exists to prevent. An earlier version padded a new
    // symbol up to full length with today's price, giving it a zero-variance
    // return series. HRP weights on inverse variance, so review measured the new
    // holding taking 61% of the book on its first day — and the full-length fake
    // series also cleared the minimum-observations gate that a short real series
    // correctly fails.
    let ph: Record<string, number[]> = {};
    let dates: string[] = [];
    for (let d = 1; d <= 5; d++) {
      const r = recordDailySample(ph, dates, P({ OLD: 100 + d }), `2026-08-0${d}`);
      ph = r.priceHistory;
      dates = r.priceHistoryDates;
    }
    const r = recordDailySample(ph, dates, P({ OLD: 106, NEW: 50 }), '2026-08-06');

    expect(r.priceHistory.OLD).toHaveLength(6);
    expect(r.priceHistory.NEW).toEqual([50]);
    // The short series must collapse minLen so callers fall back to static weights.
    const minLen = Math.min(...Object.values(r.priceHistory).map(a => a.length));
    expect(minLen).toBe(1);
  });

  it('carries forward the LAST KNOWN price, never a later one', () => {
    // Writing today's price into a missed day's slot books a multi-day move on
    // the wrong date and leaves a fake zero-return day after it.
    let r = recordDailySample({}, [], P({ AAA: 100, BBB: 100 }), '2026-08-03');
    r = recordDailySample(r.priceHistory, r.priceHistoryDates, P({ AAA: 101, BBB: 101 }), '2026-08-04');
    r = recordDailySample(r.priceHistory, r.priceHistoryDates, P({ AAA: 150 }), '2026-08-05');

    expect(r.carriedForward).toEqual(['BBB']);
    expect(r.priceHistory.BBB).toEqual([100, 101, 101]);
    expect(r.priceHistory.BBB).not.toContain(200);

    const back = recordDailySample(r.priceHistory, r.priceHistoryDates, P({ AAA: 160, BBB: 200 }), '2026-08-06');
    // The whole move lands on the day it was observed, not backdated.
    expect(back.priceHistory.BBB).toEqual([100, 101, 101, 200]);
  });

  it('keeps every series ending on the same date (right-anchored)', () => {
    // A symbol missing on the latest day used to be left one short, which made
    // two identical series read as correlation 0.048 instead of 1.0 through the
    // back-aligned consumers.
    let r = recordDailySample({}, [], P({ AAA: 10, BBB: 10 }), '2026-08-03');
    r = recordDailySample(r.priceHistory, r.priceHistoryDates, P({ AAA: 11 }), '2026-08-04');

    expect(r.priceHistory.AAA).toHaveLength(2);
    expect(r.priceHistory.BBB).toHaveLength(2);
    expect(r.priceHistoryDates).toHaveLength(2);
  });

  it('does not record anything on a weekend', () => {
    const r1 = recordDailySample({}, [], P({ AAA: 10 }), '2026-08-21');
    const r2 = recordDailySample(r1.priceHistory, r1.priceHistoryDates, P({ AAA: 99 }), null);

    expect(r2.priceHistoryDates).toEqual(['2026-08-21']);
    expect(r2.priceHistory.AAA).toEqual([10]);
    expect(r2.isNewDay).toBe(false);
  });

  it('discards undated legacy intraday samples exactly once', () => {
    const legacy = { AAA: [1, 2, 3, 4, 5, 6, 7], BBB: [10, 20, 30, 40, 50, 60, 70] };
    const r1 = recordDailySample(legacy, [], P({ AAA: 8, BBB: 80 }), '2026-08-19');

    expect(r1.migrated).toBe(true);
    expect(r1.priceHistory.AAA).toEqual([8]);
    expect(r1.priceHistoryDates).toEqual(['2026-08-19']);

    const r2 = recordDailySample(r1.priceHistory, r1.priceHistoryDates, P({ AAA: 9, BBB: 90 }), '2026-08-20');
    expect(r2.migrated).toBe(false);
    expect(r2.priceHistory.AAA).toEqual([8, 9]);
  });

  it('caps dates and every series together, with no permanent drift', () => {
    // The cap used to run per-symbol only for QUOTED symbols while dates were cut
    // unconditionally, so a symbol that missed one run stayed one day out of step
    // forever.
    let ph: Record<string, number[]> = {};
    let dates: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const day = `2026-01-${String(i).padStart(2, '0')}`;
      // BBB misses day 6 entirely.
      const quotes = i === 6 ? P({ AAA: i }) : P({ AAA: i, BBB: i * 10 });
      const r = recordDailySample(ph, dates, quotes, day, 5);
      ph = r.priceHistory;
      dates = r.priceHistoryDates;
    }
    expect(dates).toHaveLength(5);
    expect(ph.AAA).toHaveLength(5);
    expect(ph.BBB).toHaveLength(5);
    expect(ph.AAA).toEqual([8, 9, 10, 11, 12]);
    expect(ph.BBB).toEqual([80, 90, 100, 110, 120]);
  });

  it('does not mutate its inputs', () => {
    const ph = { AAA: [1, 2] };
    const dates = ['2026-08-03', '2026-08-04'];
    recordDailySample(ph, dates, P({ AAA: 3 }), '2026-08-05');
    expect(ph.AAA).toEqual([1, 2]);
    expect(dates).toEqual(['2026-08-03', '2026-08-04']);
  });
});

describe('marketDate', () => {
  it('uses the New York date, not the host date', () => {
    // 2026-08-20T02:00Z is already the 20th in AEST (noon) but still the 19th in
    // New York (22:00). Booking this as the 20th double-counts the session.
    expect(marketDate(new Date('2026-08-20T02:00:00Z'))).toBe('2026-08-19');
  });

  it('rolls over after New York midnight', () => {
    expect(marketDate(new Date('2026-08-20T05:00:00Z'))).toBe('2026-08-20');
  });

  it('returns null on weekends so duplicate closes are not booked as days', () => {
    // Sat 2026-08-22 and Sun 2026-08-23 in New York.
    expect(marketDate(new Date('2026-08-22T16:00:00Z'))).toBeNull();
    expect(marketDate(new Date('2026-08-23T16:00:00Z'))).toBeNull();
    expect(marketDate(new Date('2026-08-21T16:00:00Z'))).toBe('2026-08-21'); // Friday
    expect(marketDate(new Date('2026-08-24T16:00:00Z'))).toBe('2026-08-24'); // Monday
  });

  it('handles both 2026 US DST transitions', () => {
    // The transitions themselves are Sundays, so they are correctly not trading
    // days. Check the Mondays either side, and pick UTC times that only resolve
    // to the right date if the EDT(-4)/EST(-5) offset is applied properly.
    expect(marketDate(new Date('2026-03-09T12:00:00Z'))).toBe('2026-03-09'); // Mon, EDT
    expect(marketDate(new Date('2026-11-02T12:00:00Z'))).toBe('2026-11-02'); // Mon, EST

    // 03:30Z on the Monday is still Sunday evening in New York under EDT.
    expect(marketDate(new Date('2026-03-09T03:30:00Z'))).toBeNull();
    // 04:30Z on the Monday is still Sunday evening under EST.
    expect(marketDate(new Date('2026-11-02T04:30:00Z'))).toBeNull();
  });
});
