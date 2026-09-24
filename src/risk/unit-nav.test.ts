import { describe, it, expect } from 'vitest';
import {
  buildUnitIndex, liveUnitReading, recordCloseSample, migrateToUnitNav, usdExposurePct,
  type NavSample, type CapitalFlow,
} from './unit-nav.js';

const S = (date: string, navAud: number, audPerUsd: number | null = 1.5): NavSample => ({
  date, navAud, navUsd: audPerUsd ? navAud / audPerUsd : null, audPerUsd,
});
const F = (id: string, date: string, amountAud: number): CapitalFlow => ({ id, date, amountAud });

describe('buildUnitIndex', () => {
  it('without flows the unit price is NAV relative to the start', () => {
    const idx = buildUnitIndex([S('2026-01-02', 10_000), S('2026-01-05', 11_000), S('2026-01-06', 9_900)], []);
    expect(idx.points.map(p => p.unitPriceAud)).toEqual([1, 1.1, 0.99]);
    expect(idx.points.map(p => +p.unitPriceUsd!.toFixed(10))).toEqual([1, 1.1, 0.99]);
  });

  it('a deposit is not a gain: units are issued at the PRE-flow price', () => {
    // Day 2: market +10% on 10k (→ 11k), plus a 5k deposit lands → NAV 16k.
    const idx = buildUnitIndex(
      [S('2026-01-02', 10_000), S('2026-01-05', 16_000), S('2026-01-06', 16_000)],
      [F('d1', '2026-01-03', 5_000)],
    );
    const [, d2, d3] = idx.points;
    expect(d2.flowAud).toBe(5_000);
    expect(d2.unitPriceAud).toBeCloseTo(1.1, 12);
    expect(d2.unitsAud).toBeCloseTo(10_000 + 5_000 / 1.1, 9);
    // Flat NAV afterwards → flat price.
    expect(d3.unitPriceAud).toBeCloseTo(1.1, 12);
  });

  it('a withdrawal is not a drawdown (the case the phantom reset guessed at)', () => {
    const idx = buildUnitIndex(
      [S('2026-01-02', 100_000), S('2026-01-05', 20_000)],
      [F('w1', '2026-01-05', -80_000)],
    );
    expect(idx.points[1].unitPriceAud).toBeCloseTo(1, 12);
    expect(idx.points[1].unitPriceUsd!).toBeCloseTo(1, 12);
  });

  it('the USD index converts the flow at the sample\'s own rate and ignores AUD/USD moves', () => {
    // USD NAV unchanged at 10k, AUD falls from 1.5 to 1.6 per USD: the AUD
    // index rises (investor's result), the USD index does not.
    const idx = buildUnitIndex([
      { date: '2026-01-02', navAud: 15_000, navUsd: 10_000, audPerUsd: 1.5 },
      { date: '2026-01-05', navAud: 16_000, navUsd: 10_000, audPerUsd: 1.6 },
    ], []);
    expect(idx.points[1].unitPriceAud).toBeCloseTo(16 / 15, 12);
    expect(idx.points[1].unitPriceUsd!).toBeCloseTo(1, 12);
  });

  it('flows before the first sample are inside the starting NAV; later ones are pending', () => {
    const idx = buildUnitIndex([S('2026-01-05', 10_000)], [F('a', '2026-01-01', 1), F('b', '2026-02-01', 2)]);
    expect(idx.flowsBeforeStart.map(f => f.id)).toEqual(['a']);
    expect(idx.flowsPending.map(f => f.id)).toEqual(['b']);
  });

  it('dedupes samples by date and flows by id, and ignores junk', () => {
    const idx = buildUnitIndex(
      [S('2026-01-02', 10_000), S('2026-01-02', 99_999), S('bad', 1), S('2026-01-05', 0), S('2026-01-06', 12_000)],
      [F('x', '2026-01-03', 1_000), F('x', '2026-01-03', 1_000)],
    );
    expect(idx.points.map(p => p.date)).toEqual(['2026-01-02', '2026-01-06']);
    expect(idx.points[1].flowAud).toBe(1_000);
  });

  it('the USD index starts at the first sample with a USD NAV and carries flows across USD gaps', () => {
    const idx = buildUnitIndex([
      S('2026-01-02', 10_000, null),
      S('2026-01-05', 10_000, 1.25), // USD index starts here: 8k USD
      S('2026-01-06', 12_000, null), // 2k deposit lands, no USD valuation today
      S('2026-01-07', 12_000, 1.25), // USD: 9.6k, of which 1.6k is the deposit
    ], [F('d', '2026-01-06', 2_000)]);
    expect(idx.points[0].unitPriceUsd).toBeNull();
    expect(idx.points[1].unitPriceUsd).toBe(1);
    expect(idx.points[2].unitPriceUsd).toBeNull();
    expect(idx.points[3].unitPriceUsd!).toBeCloseTo(1, 12);
  });

  it('reports a non-positive pre-flow NAV instead of producing a negative price', () => {
    const idx = buildUnitIndex([S('2026-01-02', 10_000), S('2026-01-05', 5_000)], [F('w', '2026-01-05', 20_000)]);
    expect(idx.problems[0]).toContain('not positive');
    expect(idx.points[1].unitPriceAud).toBeGreaterThan(0);
  });
});

describe('liveUnitReading', () => {
  it('prices a live reading, including a flow since the last close, without storing it', () => {
    const flows = [F('d', '2026-01-06', 3_000)];
    const idx = buildUnitIndex([S('2026-01-02', 10_000), S('2026-01-05', 11_000)], flows);
    const live = liveUnitReading(idx, { date: '2026-01-06', navAud: 12_900, navUsd: 8_600, audPerUsd: 1.5 }, flows);
    // Pre-flow AUD NAV 9,900 on 10,000 units.
    expect(live.unitPriceAud).toBeCloseTo(0.99, 12);
    expect(live.unitPriceUsd!).toBeCloseTo(0.99, 12);
    expect(live.peakUnitPriceUsd!).toBeCloseTo(1.1, 12);
    expect(live.peakUnitPriceAud).toBeCloseTo(1.1, 12);
  });

  it('with no history, the live reading is the start', () => {
    const live = liveUnitReading(buildUnitIndex([], []), { date: '2026-01-02', navAud: 1, navUsd: 1, audPerUsd: 1 }, []);
    expect(live).toEqual({ unitPriceAud: 1, unitPriceUsd: 1, peakUnitPriceUsd: 1, peakUnitPriceAud: 1 });
  });
});

describe('recordCloseSample', () => {
  it('keeps the FIRST post-close reading of a date and caps the series', () => {
    let s = recordCloseSample([], S('2026-01-02', 10_000));
    s = recordCloseSample(s, S('2026-01-02', 10_500)); // a weekend re-run
    expect(s).toHaveLength(1);
    expect(s[0].navAud).toBe(10_000);
    s = recordCloseSample(s, S('2026-01-05', 1), 1);
    expect(s.map(x => x.date)).toEqual(['2026-01-05']);
  });
});

describe('usdExposurePct', () => {
  it('is the share of NAV not held as non-USD cash', () => {
    expect(usdExposurePct(10_000, 1_000)).toBe(90);
    expect(usdExposurePct(10_000, null)).toBeNull();
    expect(usdExposurePct(0, 0)).toBeNull();
  });
});

describe('migrateToUnitNav (explicit, idempotent)', () => {
  const legacy = {
    navHistory: [9_000, 10_000, 11_000, 12_000], // the first point predates dated history
    navHistoryDates: ['2026-01-02', '2026-01-05', '2026-01-06'],
  };

  it('preserves the legacy history once and backfills samples from its dated tail', () => {
    const m = migrateToUnitNav(legacy, d => (d === '2026-01-05' ? 1.6 : 1.5));
    expect(m.updates.navHistory_legacy).toEqual(legacy.navHistory);
    expect(m.updates.navHistoryDates_legacy).toEqual(legacy.navHistoryDates);
    expect(m.updates.navSamples.map(s => [s.date, s.navAud])).toEqual([
      ['2026-01-02', 10_000], ['2026-01-05', 11_000], ['2026-01-06', 12_000],
    ]);
    expect(m.updates.navSamples[1].navUsd).toBeCloseTo(11_000 / 1.6, 9);
    expect(m.summary).toMatchObject({ samplesAdded: 3, undatedLegacyPoints: 1, samplesWithoutUsd: 0 });
  });

  it('running it again changes nothing', () => {
    const first = migrateToUnitNav(legacy);
    const second = migrateToUnitNav({ ...legacy, ...first.updates });
    expect(second.updates.navHistory_legacy).toBeUndefined();
    expect(second.updates.navSamples).toEqual(first.updates.navSamples);
    expect(second.summary).toMatchObject({ samplesAdded: 0, legacyAlreadyPreserved: true });
  });

  it('never overwrites a real post-close sample with a backfilled one', () => {
    const real: NavSample = { date: '2026-01-05', navAud: 11_111, navUsd: 7_000, audPerUsd: 1.587, source: 'close' };
    const m = migrateToUnitNav({ ...legacy, navSamples: [real] });
    expect(m.updates.navSamples.find(s => s.date === '2026-01-05')).toEqual(real);
    expect(m.summary.samplesAdded).toBe(2);
  });

  it('without FX the backfilled samples carry no USD NAV', () => {
    expect(migrateToUnitNav(legacy).summary.samplesWithoutUsd).toBe(3);
  });
});
