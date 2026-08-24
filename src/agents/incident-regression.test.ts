import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { recordDailySample, marketDate } from '../quant/price-history.js';
import { assessModelConformance } from '../risk/model-conformance.js';
import { marketDataFreshness } from '../risk/data-sanity.js';
import { decideRebalance, computeDrift, type PortfolioSnapshot } from '../portfolio/rebalance.js';
import type { HoldingTarget } from '../portfolios/types.js';

/**
 * End-to-end regressions for the 2026-08-18 incident.
 *
 * The unit tests cover each piece. These chain the REAL modules in the order the
 * agents call them, because every fault that day lived in a seam rather than in a
 * function: samples counted as days between quant-analyst and the strategist, a
 * ledger written to two places because of import order, an allocation that moved
 * while every component reported healthy.
 */

const TEST_DIR = resolve(__dirname, '../../.test-incident-' + process.pid);

const MODEL: HoldingTarget[] = [
  { symbol: 'AAA', name: 'A', pct: 20, sleeve: 'tech_growth' },
  { symbol: 'BBB', name: 'B', pct: 17, sleeve: 'tech_growth' },
  { symbol: 'CCC', name: 'C', pct: 30, sleeve: 'defensive' },
  { symbol: 'DDD', name: 'D', pct: 33, sleeve: 'hedge' },
];

describe('incident regression: samples must never become days', () => {
  it('four-hourly polling for a week yields a week of history, not a month', () => {
    // THE incident. quant-analyst runs every 4h; the optimizer gate counts
    // observations. At 6 polls a day, 20 "days" of history accumulated in about
    // 3.5 calendar days and cleared a 20-day gate — then rebalanced a live book
    // off that covariance estimate.
    let ph: Record<string, number[]> = {};
    let dates: string[] = [];
    // Derived from the poll timestamps themselves, not from the day index: a 4h
    // cadence crosses New York dates, so counting one date per calendar day
    // undercounts the trading days actually touched.
    const touched = new Set<string>();
    let polls = 0;

    // 14 calendar days from a Monday, six polls each.
    const start = Date.UTC(2026, 7, 3, 14, 0, 0); // Mon 2026-08-03, 10:00 ET
    for (let day = 0; day < 14; day++) {
      for (let poll = 0; poll < 6; poll++) {
        const at = new Date(start + day * 86_400_000 + poll * 4 * 3_600_000);
        const md = marketDate(at);
        if (md !== null) touched.add(md);
        polls++;
        const r = recordDailySample(ph, dates, new Map([['AAA', 100 + day], ['BBB', 50 + day]]), md);
        ph = r.priceHistory;
        dates = r.priceHistoryDates;
      }
    }

    // 84 polls happened across ~14 calendar days. The history must count the
    // trading days they touched, not the polls.
    expect(polls).toBe(84);
    expect(dates.length).toBe(touched.size);
    expect(dates.length).toBeLessThanOrEqual(16);
    expect(dates.length).toBeLessThan(polls / 4);
    expect(ph.AAA).toHaveLength(dates.length);

    // And it must be nowhere near a 60-observation stability floor, which 84
    // polls would comfortably have cleared under the old counting.
    expect(dates.length).toBeLessThan(60);
  });

  it('a fresh symbol cannot reach the gate ahead of the book', () => {
    // The regression introduced by the FIRST fix: padding a new holding to full
    // length gave it a zero-variance series, which cleared the gate and took 61%
    // of the book under HRP.
    let ph: Record<string, number[]> = {};
    let dates: string[] = [];
    for (let d = 1; d <= 80; d++) {
      const r = recordDailySample(ph, dates, new Map([['AAA', 100 + d]]), `2026-01-${String((d % 28) + 1).padStart(2, '0')}`);
      ph = r.priceHistory; dates = r.priceHistoryDates;
    }
    const withNew = recordDailySample(ph, dates, new Map([['AAA', 180], ['NEW', 50]]), '2026-05-04');
    const minLen = Math.min(...Object.values(withNew.priceHistory).map(a => a.length));
    // minLen gates the returns matrix. A new holding must collapse it.
    expect(minLen).toBe(1);
    expect(withNew.priceHistory.NEW).toEqual([50]);
  });
});

describe('incident regression: a moved allocation is detected', () => {
  it('conformance catches the shape of the incident from broker positions', () => {
    // 2026-08-18 in miniature: tech_growth roughly halved, proceeds into
    // defensives, no single name looking extreme. Every health check that day
    // reported green; this is the one that would not have.
    const drifted = new Map([['AAA', 0.11], ['BBB', 0.10], ['CCC', 0.42], ['DDD', 0.37]]);
    const r = assessModelConformance(drifted, MODEL, { maxNameDeviationPct: 10, maxSleeveDeviationPct: 15 });
    expect(r.conforms).toBe(false);
    expect(r.breaches.some(b => b.kind === 'sleeve' && b.key === 'tech_growth')).toBe(true);
  });

  it('does not cry wolf on the book it is actually running', () => {
    // A book on target must be silent, or the alert gets ignored and the next
    // real drift goes unread.
    const onTarget = new Map([['AAA', 0.20], ['BBB', 0.17], ['CCC', 0.30], ['DDD', 0.33]]);
    const r = assessModelConformance(onTarget, MODEL, { maxNameDeviationPct: 10, maxSleeveDeviationPct: 15 });
    expect(r.conforms).toBe(true);
  });
});

describe('incident regression: stale data cannot become orders', () => {
  it('a dead quant-analyst blocks order sizing rather than freezing targets', () => {
    const now = new Date('2026-08-19T02:00:00Z');
    const stale = marketDataFreshness({
      lastQuantAt: '2026-08-16T02:00:00Z',
      priceHistoryDates: ['2026-08-15'],
      now, maxQuantAgeMs: 12 * 3_600_000, maxHistoryGapDays: 6,
    });
    expect(stale.fresh).toBe(false);

    // Thin-but-fresh must still trade: the static book needs no history at all,
    // and blocking it would stop a valid allocation from ever rebalancing.
    const thin = marketDataFreshness({
      lastQuantAt: '2026-08-19T01:55:00Z',
      priceHistoryDates: ['2026-08-18'],
      now, maxQuantAgeMs: 12 * 3_600_000, maxHistoryGapDays: 6,
    });
    expect(thin.fresh).toBe(true);
  });

  it('the cooldown is not reset by cash-flow buys', () => {
    // Cash-flow rebalancing only ever BUYS. When it bumped lastRebalanceAt it
    // reset the clock on the only mechanism that can sell an overweight, so an
    // overweight from a bad rebalance could become permanent.
    const cfg = { driftThreshold: 10, urgentDriftThreshold: 25, frequencyDays: 45 };
    expect(decideRebalance(12, 50, cfg)).toBe('regular');
    expect(decideRebalance(12, 3, cfg)).toBe('too-soon');
    // Under threshold, cash-flow territory — and it must not be called a rebalance.
    expect(decideRebalance(4, 3, cfg)).toBe('within-threshold');
  });
});

describe('incident regression: one ledger, whatever the import order', () => {
  beforeEach(() => { vi.resetModules(); mkdirSync(TEST_DIR, { recursive: true }); process.env.STATE_DIR = TEST_DIR; });
  afterEach(async () => {
    try { (await import('../state/store.js')).closeDb(); } catch { /* not opened */ }
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.STATE_DIR;
  });

  it('resolves STATE_DIR even when the store is imported before config', async () => {
    // The split-ledger bug: STATE_DIR was read at MODULE LOAD, and reaches the
    // process via dotenv inside config.js. Eight of ten agents imported dotenv
    // only transitively, so an agent that reached the store first silently opened
    // a second bot-state.db in its cwd — and the nightly backup kept snapshotting
    // the other one and reporting it healthy.
    const store = await import('../state/store.js');   // store FIRST, no config
    store.mergeState({ lastCheckAt: 'written' });
    expect(store.stateDbPath()).toBe(resolve(TEST_DIR, 'bot-state.db'));
    expect(store.loadState().lastCheckAt).toBe('written');
  });

  it('a second reader sees what the first wrote, in the same file', async () => {
    const a = await import('../state/store.js');
    a.mergeState({ lastQuantAt: 'from-agent-a' });
    a.closeDb();
    vi.resetModules();
    const b = await import('../state/store.js');
    expect(b.loadState().lastQuantAt).toBe('from-agent-a');
    expect(b.stateDbPath()).toBe(a.stateDbPath());
  });
});
