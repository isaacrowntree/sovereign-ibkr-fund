import type { HoldingTarget } from '../portfolios/types.js';

/**
 * Does the book still look like the model portfolio?
 *
 * Everything built after the 2026-08-18 incident watches the MACHINERY — market
 * data freshness, ledger liveness, agent heartbeats, backup integrity. None of it
 * would have noticed what actually happened: the allocation being quietly
 * retargeted away from the deliberate book by an optimizer running on bad data,
 * while every component reported healthy. A human noticed. This is the check that
 * should have.
 *
 * It compares against the MODEL (`TARGET_PORTFOLIO`), deliberately, not against
 * whatever the strategist currently intends. Comparing to the strategist's own
 * target would have agreed enthusiastically with the incident — the whole problem
 * was that its target had moved.
 */

export interface ConformanceOptions {
  /** Alert when any single holding deviates from model by more than this (pp). */
  maxNameDeviationPct: number;
  /** Alert when a sleeve's total deviates by more than this (pp). */
  maxSleeveDeviationPct: number;
}

export interface ConformanceBreach {
  kind: 'name' | 'sleeve' | 'unknown' | 'empty';
  key: string;
  actualPct: number;
  targetPct: number;
  deviationPct: number;
}

export interface ConformanceResult {
  conforms: boolean;
  breaches: ConformanceBreach[];
  /** Stable across magnitude changes; varies with WHICH things breached. */
  fingerprint: string;
  /** Largest single deviation seen anywhere, for the alert body. */
  maxDeviationPct: number;
  /** Worst per-name and per-sleeve deviations, each against its OWN limit. */
  worstNamePct: number;
  worstSleevePct: number;
}

/**
 * @param actualWeights symbol -> fraction of NAV currently held.
 * @param model the target portfolio.
 */
export function assessModelConformance(
  actualWeights: Map<string, number>,
  model: HoldingTarget[],
  opts: ConformanceOptions,
): ConformanceResult {
  const breaches: ConformanceBreach[] = [];
  // Tracked across EVERY comparison, not just the ones that breached. Reducing
  // over breaches reports 0.0pp for a conforming book, which reads as "identical
  // to the model" when it may be sitting a hair under the threshold — observed
  // live, logging 0.0pp while a sleeve was ~14pp light against a 15pp limit.
  let worstName = 0;
  let worstSleeve = 0;

  const investedTotal = [...actualWeights.values()].reduce((s, w) => s + w, 0);

  // An empty book has zero deviation on every name under a naive comparison, so
  // it would sail through as conforming. It is the opposite of conforming.
  if (investedTotal <= 0) {
    return {
      conforms: false,
      breaches: [{ kind: 'empty', key: '(book)', actualPct: 0, targetPct: 100, deviationPct: 100 }],
      fingerprint: 'empty',
      maxDeviationPct: 100,
      worstNamePct: 100,
      worstSleevePct: 100,
    };
  }

  // Normalise by what is actually invested. The regime overlay legitimately holds
  // the book at, say, 85% exposure; comparing raw weights would then report every
  // position as 15% light on every run — an alert that is always firing is an
  // alert nobody reads.
  const norm = (w: number): number => (w / investedTotal) * 100;

  const modelTotal = model.reduce((s, t) => s + t.pct, 0) || 100;
  const targetOf = (pct: number): number => (pct / modelTotal) * 100;

  const known = new Set(model.map(t => t.symbol));

  for (const t of model) {
    const actual = norm(actualWeights.get(t.symbol) ?? 0);
    const target = targetOf(t.pct);
    const dev = Math.abs(actual - target);
    worstName = Math.max(worstName, dev);
    if (dev > opts.maxNameDeviationPct) {
      breaches.push({ kind: 'name', key: t.symbol, actualPct: actual, targetPct: target, deviationPct: dev });
    }
  }

  // Sleeve level catches the shape of the incident: no single name looked
  // extreme, but a whole sleeve had been halved and the proceeds moved.
  const sleeveActual = new Map<string, number>();
  const sleeveTarget = new Map<string, number>();
  for (const t of model) {
    sleeveTarget.set(t.sleeve, (sleeveTarget.get(t.sleeve) ?? 0) + targetOf(t.pct));
    sleeveActual.set(t.sleeve, (sleeveActual.get(t.sleeve) ?? 0) + norm(actualWeights.get(t.symbol) ?? 0));
  }
  for (const [sleeve, target] of sleeveTarget) {
    const actual = sleeveActual.get(sleeve) ?? 0;
    const dev = Math.abs(actual - target);
    worstSleeve = Math.max(worstSleeve, dev);
    if (dev > opts.maxSleeveDeviationPct) {
      breaches.push({ kind: 'sleeve', key: sleeve, actualPct: actual, targetPct: target, deviationPct: dev });
    }
  }

  // A symbol the model never authorised is not drift — it is the book holding
  // something nobody chose. Report it at any size.
  for (const [symbol, w] of actualWeights) {
    if (!known.has(symbol) && w > 0) {
      breaches.push({ kind: 'unknown', key: symbol, actualPct: norm(w), targetPct: 0, deviationPct: norm(w) });
    }
  }

  // Fingerprint on WHICH things breached, never on how far. Weights move every
  // run, so a magnitude-based fingerprint would never match and dedupe would fail
  // — alerting every 4h cycle instead of re-nagging on its ttl.
  const fingerprint = breaches.length === 0
    ? 'ok'
    : breaches.map(b => `${b.kind}:${b.key}`).sort().join(',');

  return {
    conforms: breaches.length === 0,
    breaches,
    fingerprint,
    maxDeviationPct: Math.max(worstName, worstSleeve),
    worstNamePct: worstName,
    worstSleevePct: worstSleeve,
  };
}
