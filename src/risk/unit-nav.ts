/**
 * Unit NAV index (2026-09-24 review, F6; RISK_NAV_SOURCE=units).
 *
 * WHY. The drawdown ladder ran on raw net liquidation. A deposit read as a gain
 * (raising the peak) and a withdrawal as a drawdown — which is why a "phantom
 * drawdown" reset had to exist, a heuristic that wiped the history whenever the
 * peak sat 3x above NAV and would equally have wiped a real crash. A unit index
 * is the standard fix: capital flows buy or redeem units at the prevailing unit
 * price, so the price moves only with performance.
 *
 * RULES (from the plan, deliberately narrow):
 *   - Only AUD deposits and withdrawals are flows. FX conversions move money
 *     between currency buckets of the same account and dividends are return —
 *     neither changes the unit count.
 *   - Units are issued at the PRE-flow NAV per unit: a flow dated on or before a
 *     sample is assumed to be inside that sample's NAV, so
 *     price = (nav − flow) / unitsBefore, units += flow / price.
 *   - One sample per NYSE date, taken after the close (the caller's job).
 *   - Two indices from the same samples: AUD (the investor's actual result) and
 *     USD (what the drawdown ladder runs on — its only lever is selling US
 *     equities, so AUD/USD moves must not trip it). A flow enters the USD index
 *     converted at the sample's own rate.
 *
 * Everything here is pure: the index is REBUILT from `navSamples` and
 * `capitalFlows` on every run rather than advanced incrementally, so there is no
 * running state to corrupt and a corrected flow fixes history by itself.
 */

export interface NavSample {
  /** NYSE trading date, YYYY-MM-DD. */
  date: string;
  /** Net liquidation in base currency (AUD). */
  navAud: number;
  /** Net liquidation in USD; null when no rate was available (e.g. legacy backfill without FX). */
  navUsd: number | null;
  /** AUD per 1 USD at the sample; null when unknown. */
  audPerUsd: number | null;
  /** Where the sample came from. */
  source?: 'close' | 'legacy-backfill';
}

export interface CapitalFlow {
  /** Stable id, so re-recording the same flow is a no-op. */
  id: string;
  /** Date the money landed in the account (any calendar date). */
  date: string;
  /** + deposit, − withdrawal, in AUD. */
  amountAud: number;
  note?: string;
}

export interface UnitPoint {
  date: string;
  navAud: number;
  flowAud: number;
  unitsAud: number;
  unitPriceAud: number;
  navUsd: number | null;
  unitsUsd: number | null;
  unitPriceUsd: number | null;
}

export interface UnitIndex {
  points: UnitPoint[];
  /** Flows dated on or before the first sample: already inside the starting NAV. */
  flowsBeforeStart: CapitalFlow[];
  /** Flows dated after the last sample: not yet reflected. */
  flowsPending: CapitalFlow[];
  /** Human-readable problems (non-positive pre-flow NAV etc.). */
  problems: string[];
  /** AUD flows the USD index has not absorbed yet (samples without a USD NAV since). */
  pendingUsdFlowAud: number;
}

function sortedUniqueSamples(samples: readonly NavSample[]): NavSample[] {
  const byDate = new Map<string, NavSample>();
  for (const s of samples) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !(s.navAud > 0)) continue;
    if (!byDate.has(s.date)) byDate.set(s.date, s);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function uniqueFlows(flows: readonly CapitalFlow[]): CapitalFlow[] {
  const byId = new Map<string, CapitalFlow>();
  for (const f of flows) if (Number.isFinite(f.amountAud) && f.amountAud !== 0) byId.set(f.id, f);
  return [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Rebuild both indices from the raw samples and flows. */
export function buildUnitIndex(samples: readonly NavSample[], flows: readonly CapitalFlow[]): UnitIndex {
  const ss = sortedUniqueSamples(samples);
  const fs = uniqueFlows(flows);
  const problems: string[] = [];
  if (ss.length === 0) return { points: [], flowsBeforeStart: fs, flowsPending: [], problems, pendingUsdFlowAud: 0 };

  const first = ss[0];
  const flowsBeforeStart = fs.filter(f => f.date <= first.date);
  const flowsPending = fs.filter(f => f.date > ss[ss.length - 1].date);

  const points: UnitPoint[] = [];
  let unitsAud = first.navAud; // unit price 1.000 at the first sample
  let unitsUsd: number | null = null;
  let pendingUsdFlowAud = 0; // flows the USD index has not absorbed yet (gaps in navUsd)
  let prevDate = first.date;

  const startUsd = (s: NavSample): void => {
    if (unitsUsd === null && s.navUsd !== null && s.navUsd > 0) unitsUsd = s.navUsd;
  };
  startUsd(first);
  points.push({
    date: first.date, navAud: first.navAud, flowAud: 0,
    unitsAud, unitPriceAud: 1,
    navUsd: first.navUsd, unitsUsd, unitPriceUsd: unitsUsd === null ? null : 1,
  });

  for (let i = 1; i < ss.length; i++) {
    const s = ss[i];
    const flowAud = fs.filter(f => f.date > prevDate && f.date <= s.date).reduce((a, f) => a + f.amountAud, 0);
    prevDate = s.date;

    const preFlowAud = s.navAud - flowAud;
    let priceAud: number;
    if (preFlowAud > 0 && unitsAud > 0) {
      priceAud = preFlowAud / unitsAud;
      unitsAud += flowAud / priceAud;
    } else {
      problems.push(`${s.date}: pre-flow AUD NAV ${preFlowAud.toFixed(2)} is not positive — index restarted at this sample`);
      priceAud = points[points.length - 1].unitPriceAud;
      unitsAud = s.navAud / priceAud;
    }

    let priceUsd: number | null = null;
    if (unitsUsd === null) {
      startUsd(s); // the USD index begins at the first sample that has a USD NAV
      if (unitsUsd !== null) priceUsd = 1;
    } else if (s.navUsd !== null && s.navUsd > 0 && s.audPerUsd !== null && s.audPerUsd > 0) {
      const flowUsd = (flowAud + pendingUsdFlowAud) / s.audPerUsd;
      pendingUsdFlowAud = 0;
      const preFlowUsd = s.navUsd - flowUsd;
      const usdUnits: number = unitsUsd;
      if (preFlowUsd > 0 && usdUnits > 0) {
        priceUsd = preFlowUsd / usdUnits;
        unitsUsd = usdUnits + flowUsd / priceUsd;
      } else {
        problems.push(`${s.date}: pre-flow USD NAV ${preFlowUsd.toFixed(2)} is not positive — USD index restarted`);
        const lastUsd = [...points].reverse().find(p => p.unitPriceUsd !== null)?.unitPriceUsd ?? 1;
        priceUsd = lastUsd;
        unitsUsd = s.navUsd / lastUsd;
      }
    } else {
      pendingUsdFlowAud += flowAud; // no USD valuation today; carry the flow to the next one
    }

    points.push({
      date: s.date, navAud: s.navAud, flowAud,
      unitsAud, unitPriceAud: priceAud,
      navUsd: s.navUsd, unitsUsd, unitPriceUsd: priceUsd,
    });
  }
  return { points, flowsBeforeStart, flowsPending, problems, pendingUsdFlowAud };
}

export interface LiveUnitReading {
  unitPriceAud: number;
  unitPriceUsd: number | null;
  /** Highest USD unit price in the history, the live reading included. */
  peakUnitPriceUsd: number | null;
  /** Highest AUD unit price in the history, the live reading included. */
  peakUnitPriceAud: number;
}

/**
 * Value the index at a live (intraday or pre-close) reading WITHOUT storing it:
 * flows since the last stored sample are priced exactly as a sample would be.
 * With no stored history the live reading is the start (price 1).
 */
export function liveUnitReading(
  index: UnitIndex,
  live: { date: string; navAud: number; navUsd: number | null; audPerUsd: number | null },
  flows: readonly CapitalFlow[],
): LiveUnitReading {
  const last = index.points[index.points.length - 1];
  if (!last) {
    return { unitPriceAud: 1, unitPriceUsd: live.navUsd ? 1 : null, peakUnitPriceUsd: live.navUsd ? 1 : null, peakUnitPriceAud: 1 };
  }
  const flowAud = uniqueFlows(flows).filter(f => f.date > last.date && f.date <= live.date)
    .reduce((a, f) => a + f.amountAud, 0);
  const unitPriceAud = last.unitsAud > 0 ? Math.max(0, live.navAud - flowAud) / last.unitsAud : last.unitPriceAud;

  let unitPriceUsd: number | null = null;
  if (last.unitsUsd !== null && last.unitsUsd > 0 && live.navUsd !== null && live.audPerUsd) {
    const usdFlowAud = flowAud + index.pendingUsdFlowAud;
    unitPriceUsd = Math.max(0, live.navUsd - usdFlowAud / live.audPerUsd) / last.unitsUsd;
  }
  const histUsd = index.points.map(p => p.unitPriceUsd).filter((v): v is number => v !== null);
  const peakUnitPriceUsd = unitPriceUsd === null && histUsd.length === 0
    ? null
    : Math.max(...histUsd, unitPriceUsd ?? 0);
  const peakUnitPriceAud = Math.max(...index.points.map(p => p.unitPriceAud), unitPriceAud);
  return { unitPriceAud, unitPriceUsd, peakUnitPriceUsd, peakUnitPriceAud };
}

/**
 * Record the day's post-close sample: the FIRST reading taken after that
 * session's close becomes the sample and later readings do not overwrite it
 * (weekend runs would otherwise keep re-stamping Friday with FX-only moves).
 * Returns the new array, capped to `cap` samples.
 */
export function recordCloseSample(samples: readonly NavSample[], sample: NavSample, cap = 1000): NavSample[] {
  if (samples.some(s => s.date === sample.date)) return [...samples];
  const out = [...samples, sample].sort((a, b) => a.date.localeCompare(b.date));
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/**
 * FX exposure: the share of NAV held in USD assets, i.e. what an AUD/USD move
 * revalues. `nonUsdCashBase` is cash in non-USD buckets, in base currency.
 */
export function usdExposurePct(navAud: number, nonUsdCashBase: number | null): number | null {
  if (!(navAud > 0) || nonUsdCashBase === null) return null;
  return Math.max(0, Math.min(100, ((navAud - nonUsdCashBase) / navAud) * 100));
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration (explicit, idempotent — never run automatically)
// ─────────────────────────────────────────────────────────────────────────────

export interface UnitNavMigrationInput {
  navHistory?: number[];
  navHistoryDates?: string[];
  navHistory_legacy?: number[];
  navHistoryDates_legacy?: string[];
  navSamples?: NavSample[];
}

export interface UnitNavMigration {
  /** Keys to write; absent keys are left alone. */
  updates: {
    navHistory_legacy?: number[];
    navHistoryDates_legacy?: string[];
    navSamples: NavSample[];
  };
  /** What changed, for the dry-run. */
  summary: {
    legacyPreserved: boolean;
    legacyAlreadyPreserved: boolean;
    samplesBefore: number;
    samplesAdded: number;
    samplesAfter: number;
    undatedLegacyPoints: number;
    samplesWithoutUsd: number;
  };
}

/**
 * Preserve the legacy AUD history as `navHistory_legacy` (once) and backfill
 * `navSamples` from it for every dated point not already sampled. Pairs dates
 * with values from the END: navHistory may carry undated points from before
 * dates were recorded; those are counted and skipped, never guessed.
 *
 * `audPerUsdOn`, when given (e.g. from a public AUD/USD series), fills in the
 * USD NAV so the ladder's USD index has history from day one; without it the
 * USD index starts at the first live post-close sample.
 *
 * Running it twice changes nothing the second time.
 */
export function migrateToUnitNav(
  state: UnitNavMigrationInput,
  audPerUsdOn?: (date: string) => number | null,
): UnitNavMigration {
  const values = state.navHistory ?? [];
  const dates = state.navHistoryDates ?? [];
  const legacyAlreadyPreserved = Array.isArray(state.navHistory_legacy);
  const existing = state.navSamples ?? [];
  const have = new Set(existing.map(s => s.date));

  const k = Math.min(values.length, dates.length);
  const dated = Array.from({ length: k }, (_, i) => ({
    date: dates[dates.length - k + i],
    nav: values[values.length - k + i],
  }));
  const added: NavSample[] = [];
  for (const { date, nav } of dated) {
    if (have.has(date) || !(nav > 0)) continue;
    const rate = audPerUsdOn?.(date) ?? null;
    added.push({
      date,
      navAud: nav,
      navUsd: rate && rate > 0 ? nav / rate : null,
      audPerUsd: rate && rate > 0 ? rate : null,
      source: 'legacy-backfill',
    });
    have.add(date);
  }
  const navSamples = [...existing, ...added].sort((a, b) => a.date.localeCompare(b.date));

  const updates: UnitNavMigration['updates'] = { navSamples };
  if (!legacyAlreadyPreserved) {
    updates.navHistory_legacy = [...values];
    updates.navHistoryDates_legacy = [...dates];
  }
  return {
    updates,
    summary: {
      legacyPreserved: !legacyAlreadyPreserved,
      legacyAlreadyPreserved,
      samplesBefore: existing.length,
      samplesAdded: added.length,
      samplesAfter: navSamples.length,
      undatedLegacyPoints: values.length - k,
      samplesWithoutUsd: navSamples.filter(s => s.navUsd === null).length,
    },
  };
}
