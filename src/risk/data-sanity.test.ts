import { describe, it, expect } from 'vitest';
import { navSanityViolation, priceSanityViolations, orderCapViolation , marketDataFreshness } from './data-sanity.js';

const navCfg = { minNavUsd: 1000, maxNavMovePct: 35 };

describe('navSanityViolation', () => {
  it('accepts a normal NAV', () => {
    expect(navSanityViolation(29156, 29000, navCfg)).toBeNull();
  });
  it('rejects a zeroed / non-positive NAV (the liquidation trigger)', () => {
    expect(navSanityViolation(0, 29000, navCfg)).toMatch(/non-positive/);
    expect(navSanityViolation(-5, 29000, navCfg)).toMatch(/non-positive/);
    expect(navSanityViolation(NaN, 29000, navCfg)).toMatch(/NaN/);
  });
  it('rejects NAV below the floor', () => {
    expect(navSanityViolation(500, 29000, navCfg)).toMatch(/below floor/);
  });
  it('rejects an implausible jump vs last NAV', () => {
    expect(navSanityViolation(15000, 29000, navCfg)).toMatch(/moved 48%/); // -48%
    expect(navSanityViolation(50000, 29000, navCfg)).toMatch(/moved/);     // +72%
  });
  it('allows a move within threshold, and any value on the first run', () => {
    expect(navSanityViolation(32000, 29000, navCfg)).toBeNull(); // +10%
    expect(navSanityViolation(29156, undefined, navCfg)).toBeNull();
  });
});

describe('priceSanityViolations', () => {
  const last = new Map([['NET', 242], ['TLT', 85.5], ['AVGO', 362]]);
  it('passes normal prices', () => {
    const cur = new Map([['NET', 243], ['TLT', 85.6], ['AVGO', 360]]);
    expect(priceSanityViolations(cur, last, 30)).toEqual([]);
  });
  it('flags a zero/missing price', () => {
    const cur = new Map([['NET', 0], ['TLT', 85.5]]);
    const bad = priceSanityViolations(cur, last, 30);
    expect(bad.map(b => b.symbol)).toEqual(['NET']);
  });
  it('flags the 100x-low tick (huge-qty trigger)', () => {
    const cur = new Map([['AVGO', 3.62]]); // 362 → 3.62
    const bad = priceSanityViolations(cur, last, 30);
    expect(bad[0].symbol).toBe('AVGO');
    expect(bad[0].reason).toMatch(/moved/);
  });
  it('does not flag a first-seen symbol with a positive price', () => {
    const cur = new Map([['NEW', 100]]);
    expect(priceSanityViolations(cur, last, 30)).toEqual([]);
  });
});

describe('orderCapViolation', () => {
  const caps = { maxOrderNotionalUsd: 15000, maxOrderPctNav: 50, maxRunNotionalUsd: 60000 };
  it('passes the real NET sell (~$10.9k, ~37% of $29k NAV)', () => {
    expect(orderCapViolation(10926, 29156, 0, caps)).toBeNull();
  });
  it('rejects an order over the absolute $ cap', () => {
    expect(orderCapViolation(20000, 29156, 0, caps)).toMatch(/> cap \$15000/);
  });
  it('rejects an order over the %-of-NAV cap', () => {
    expect(orderCapViolation(14000, 20000, 0, caps)).toMatch(/% of NAV/); // 70% of NAV
  });
  it('rejects when the running total would exceed the per-run cap', () => {
    expect(orderCapViolation(5000, 29156, 58000, caps)).toMatch(/would exceed/);
  });
});

describe('marketDataFreshness', () => {
  const NOW = new Date('2026-08-19T02:00:00Z');
  const base = { now: NOW, maxQuantAgeMs: 12 * 3_600_000, maxHistoryGapDays: 6 };

  it('passes on data written within the window', () => {
    const r = marketDataFreshness({
      ...base,
      lastQuantAt: '2026-08-19T01:35:00Z',
      priceHistoryDates: ['2026-08-17', '2026-08-18'],
    });
    expect(r.fresh).toBe(true);
  });

  it('blocks when quant-analyst has stopped writing', () => {
    // The failure this gate exists for: the agent dies, priceHistory freezes, and
    // the optimizer keeps sizing orders off a covariance matrix that no longer
    // describes the market.
    const r = marketDataFreshness({
      ...base,
      lastQuantAt: '2026-08-17T01:00:00Z', // ~49h
      priceHistoryDates: ['2026-08-17'],
    });
    expect(r.fresh).toBe(false);
    if (!r.fresh) {
      expect(r.reason).toBe('stale');
      expect(r.detail).toContain('49.0h old');
    }
  });

  it('blocks when the agent runs but the series stops advancing', () => {
    // lastQuantAt only proves the agent RAN. A gateway returning no quotes leaves
    // it fresh while the data underneath is weeks old.
    const r = marketDataFreshness({
      ...base,
      lastQuantAt: '2026-08-19T01:55:00Z',
      priceHistoryDates: ['2026-07-20'],
    });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.detail).toContain('2026-07-20');
  });

  it('blocks on missing or unparseable timestamps rather than assuming fine', () => {
    expect(marketDataFreshness({ ...base }).fresh).toBe(false);
    expect(marketDataFreshness({ ...base, lastQuantAt: 'not-a-date' }).fresh).toBe(false);
  });

  it('treats a future timestamp as a clock step, not as freshness', () => {
    // The Pi has no RTC and steps on NTP sync.
    const r = marketDataFreshness({ ...base, lastQuantAt: '2026-08-20T00:00:00Z' });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('clock');
  });

  it('does NOT block on thin history — only on stale history', () => {
    // Depth is a handled state: the strategist falls back to the static model
    // portfolio, which needs no price history at all. Blocking here would stop a
    // perfectly valid allocation from ever trading.
    const r = marketDataFreshness({
      ...base,
      lastQuantAt: '2026-08-19T01:55:00Z',
      priceHistoryDates: ['2026-08-18'],
    });
    expect(r.fresh).toBe(true);
  });

  it('tolerates a long weekend plus a holiday', () => {
    const r = marketDataFreshness({
      ...base,
      lastQuantAt: '2026-08-19T01:55:00Z',
      // Wed 2026-08-12 is the newest trading day; Thu+Fri closed; this run is
      // the following Mon 02:00Z — 5 days plus 2 hours. The realistic worst case.
      priceHistoryDates: ['2026-08-14'],
    });
    expect(r.fresh).toBe(true);
  });
});
