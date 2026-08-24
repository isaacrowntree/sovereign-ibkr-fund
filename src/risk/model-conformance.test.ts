import { describe, it, expect } from 'vitest';
import { assessModelConformance } from './model-conformance.js';
import type { HoldingTarget } from '../portfolios/types.js';

/**
 * Does the book still look like the model portfolio?
 *
 * Everything else built after the 2026-08-18 incident watches the MACHINERY —
 * data freshness, ledger liveness, agent health. None of it would notice the
 * thing that actually happened: the allocation being quietly retargeted away
 * from the deliberate book while every component reported healthy. That was
 * caught by a human looking at it.
 */

const MODEL: HoldingTarget[] = [
  { symbol: 'AAA', name: 'A', pct: 20, sleeve: 'tech_growth' },
  { symbol: 'BBB', name: 'B', pct: 20, sleeve: 'tech_growth' },
  { symbol: 'CCC', name: 'C', pct: 30, sleeve: 'defensive' },
  { symbol: 'DDD', name: 'D', pct: 30, sleeve: 'hedge' },
];

/** Positions expressed as a fraction of NAV, like the strategist's snapshot. */
const book = (w: Record<string, number>) => new Map(Object.entries(w));

const OPTS = { maxNameDeviationPct: 10, maxSleeveDeviationPct: 15 };

describe('assessModelConformance', () => {
  it('passes when the book matches the model', () => {
    const r = assessModelConformance(book({ AAA: 0.20, BBB: 0.20, CCC: 0.30, DDD: 0.30 }), MODEL, OPTS);
    expect(r.conforms).toBe(true);
    expect(r.breaches).toEqual([]);
  });

  it('ignores a uniform under-investment from the exposure overlay', () => {
    // At regime exposure 85% every weight is legitimately 15% light. Comparing
    // raw weights would alert on correct behaviour, every run, forever — the
    // fastest way to train someone to ignore the alert.
    const scaled = book({ AAA: 0.17, BBB: 0.17, CCC: 0.255, DDD: 0.255 });
    const r = assessModelConformance(scaled, MODEL, OPTS);
    expect(r.conforms).toBe(true);
  });

  it('catches the incident: a sleeve silently retargeted', () => {
    // The real shape of 2026-08-18 — tech_growth cut roughly in half and the
    // proceeds pushed into defensives, with no single name looking extreme.
    const r = assessModelConformance(
      book({ AAA: 0.11, BBB: 0.11, CCC: 0.42, DDD: 0.36 }), MODEL, OPTS,
    );
    expect(r.conforms).toBe(false);
    const sleeve = r.breaches.find(b => b.kind === 'sleeve' && b.key === 'tech_growth');
    expect(sleeve).toBeDefined();
    expect(sleeve!.actualPct).toBeCloseTo(22, 0);
    expect(sleeve!.targetPct).toBeCloseTo(40, 0);
  });

  it('catches a single name blown far off target', () => {
    const r = assessModelConformance(
      book({ AAA: 0.45, BBB: 0.05, CCC: 0.25, DDD: 0.25 }), MODEL, OPTS,
    );
    expect(r.conforms).toBe(false);
    expect(r.breaches.some(b => b.kind === 'name' && b.key === 'AAA')).toBe(true);
  });

  it('flags a holding that is not in the model at all', () => {
    // An unknown symbol is not drift, it is the book containing something the
    // model never authorised.
    const r = assessModelConformance(
      book({ AAA: 0.20, BBB: 0.20, CCC: 0.25, DDD: 0.25, ZZZ: 0.10 }), MODEL, OPTS,
    );
    expect(r.conforms).toBe(false);
    expect(r.breaches.some(b => b.kind === 'unknown' && b.key === 'ZZZ')).toBe(true);
  });

  it('reports an empty book as a breach rather than as conforming', () => {
    // Zero positions trivially has zero deviation under a naive comparison.
    const r = assessModelConformance(book({}), MODEL, OPTS);
    expect(r.conforms).toBe(false);
  });

  it('fingerprints on the breach SET, not the magnitudes', () => {
    // Weights move every run. A magnitude-based fingerprint never matches, so
    // dedupe fails and it alerts every cycle instead of re-nagging on its ttl.
    const a = assessModelConformance(book({ AAA: 0.11, BBB: 0.11, CCC: 0.42, DDD: 0.36 }), MODEL, OPTS);
    const b = assessModelConformance(book({ AAA: 0.12, BBB: 0.10, CCC: 0.41, DDD: 0.37 }), MODEL, OPTS);
    expect(a.fingerprint).toBe(b.fingerprint);

    const c = assessModelConformance(book({ AAA: 0.45, BBB: 0.05, CCC: 0.25, DDD: 0.25 }), MODEL, OPTS);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });
});

describe('maxDeviationPct reporting', () => {
  it('reports the true worst deviation even when nothing breaches', () => {
    // Reducing over BREACHES only makes a conforming book report 0.0pp, which
    // reads as "identical to the model" when it may be a hair under the
    // threshold. Observed live: the book logged "max deviation 0.0pp" while
    // tech_growth was ~14pp light against a 15pp limit.
    const r = assessModelConformance(
      book({ AAA: 0.14, BBB: 0.14, CCC: 0.36, DDD: 0.36 }), MODEL, OPTS,
    );
    expect(r.conforms).toBe(true);
    expect(r.maxDeviationPct).toBeGreaterThan(5);
    expect(r.maxDeviationPct).toBeCloseTo(12, 0);
  });

  it('still reports the worst deviation when something does breach', () => {
    const r = assessModelConformance(
      book({ AAA: 0.45, BBB: 0.05, CCC: 0.25, DDD: 0.25 }), MODEL, OPTS,
    );
    expect(r.conforms).toBe(false);
    expect(r.maxDeviationPct).toBeCloseTo(25, 0);
  });
});

describe('per-kind headroom', () => {
  it('separates name and sleeve worsts so each is judged against its own limit', () => {
    // A sleeve deviation compared to the per-name limit reported zero headroom
    // when the sleeve limit still had room. Both numbers are needed to say
    // anything true about how close the book is to alerting.
    const r = assessModelConformance(
      book({ AAA: 0.14, BBB: 0.14, CCC: 0.36, DDD: 0.36 }), MODEL, OPTS,
    );
    expect(r.worstSleevePct).toBeGreaterThan(r.worstNamePct);
    expect(r.maxDeviationPct).toBe(Math.max(r.worstNamePct, r.worstSleevePct));
  });
});
