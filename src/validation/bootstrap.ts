/**
 * Stationary block bootstrap (Politis & Romano 1994) for the mean of a
 * dependent series — here, PAIRED daily return differences between two
 * strategies run on the same prices (2026-09-24 review, G6).
 *
 * Daily strategy returns are autocorrelated in volatility and, for two gates on
 * the same book, strongly cross-correlated; an i.i.d. bootstrap of the
 * difference would understate its variance. Resampling blocks of geometric
 * length (mean `meanBlock`) with wrap-around keeps short-range dependence and
 * stays stationary.
 */

/** mulberry32 — small, fast, deterministic. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapOptions {
  /** Mean block length in observations (geometric). */
  meanBlock: number;
  resamples: number;
  seed: number;
}

/** Bootstrap distribution of the sample mean. */
export function stationaryBootstrapMeans(x: readonly number[], opts: BootstrapOptions): number[] {
  const n = x.length;
  if (n === 0) throw new Error('empty series');
  const r = rng(opts.seed);
  const p = 1 / Math.max(1, opts.meanBlock);
  const out: number[] = [];
  for (let b = 0; b < opts.resamples; b++) {
    let sum = 0;
    let i = Math.floor(r() * n);
    for (let k = 0; k < n; k++) {
      sum += x[i];
      // With probability p start a new block at a random point, else continue.
      i = r() < p ? Math.floor(r() * n) : (i + 1) % n;
    }
    out.push(sum / n);
  }
  return out;
}

/** The q-quantile (0..1) of a sample, by linear interpolation. */
export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export interface PairedSummary {
  /** Mean daily difference × 252. */
  annualisedMean: number;
  /** One-sided lower bound at `1 − alpha`, annualised (percentile method). */
  lowerBound: number;
  /** Two-sided interval at `1 − 2·alpha`, annualised. */
  interval: [number, number];
  observations: number;
}

/** Annualised mean of paired daily differences with a stationary-bootstrap lower bound. */
export function pairedDifference(
  a: readonly number[], b: readonly number[], opts: BootstrapOptions & { alpha: number },
): PairedSummary {
  if (a.length !== b.length) throw new Error(`series differ in length: ${a.length} vs ${b.length}`);
  const d = a.map((v, i) => v - b[i]);
  const means = stationaryBootstrapMeans(d, opts);
  const mean = d.reduce((s, v) => s + v, 0) / d.length;
  return {
    annualisedMean: mean * 252,
    lowerBound: quantile(means, opts.alpha) * 252,
    interval: [quantile(means, opts.alpha) * 252, quantile(means, 1 - opts.alpha) * 252],
    observations: d.length,
  };
}
