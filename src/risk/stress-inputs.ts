/**
 * Inputs for the correlation stress test, built per name (2026-09-24 review, F5).
 *
 * The stress test used to read `historicalReturns`, which quant-analyst
 * truncates to the SHORTEST price history in the book. One recently added
 * holding therefore shortened every name's window, dropped the matrix under the
 * stress test's observation floor, and the test was skipped without a log line.
 *
 * Now: each name's returns come from its own right-anchored price history; a
 * name with fewer than `minObs` returns is EXCLUDED (and reported, with the
 * model weight it carries) instead of shortening everyone else; the covariance
 * is pairwise over overlapping windows.
 */
import { pairwiseCovMatrix } from '../portfolio/covariance.js';

export interface StressInputs {
  /** Symbols stressed, in model order. */
  included: string[];
  /** Model weights of the included names (NOT renormalised — excluded weight is simply absent). */
  weights: number[];
  cov: number[][];
  /** Names left out for want of history. */
  excluded: Array<{ symbol: string; observations: number; weight: number }>;
  /** Sum of the excluded names' model weights. */
  excludedWeight: number;
}

export type StressInputResult =
  | { ok: true; inputs: StressInputs }
  | { ok: false; reason: string };

function returnsOf(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(cur)) out.push((cur - prev) / prev);
  }
  return out;
}

export function buildStressInputs(
  symbols: string[],
  weights: number[] | null | undefined,
  priceHistory: Record<string, number[]> | null | undefined,
  minObs: number = 60,
): StressInputResult {
  if (!weights) return { ok: false, reason: 'no model weights in state (strategist has not run?)' };
  if (weights.length !== symbols.length) {
    return {
      ok: false,
      reason: `${weights.length} model weights vs ${symbols.length} holdings (model recently changed)`,
    };
  }
  if (!priceHistory) return { ok: false, reason: 'no price history in state' };

  const included: string[] = [];
  const inclWeights: number[] = [];
  const series: number[][] = [];
  const excluded: StressInputs['excluded'] = [];
  symbols.forEach((sym, i) => {
    const r = returnsOf(priceHistory[sym] ?? []);
    if (r.length < minObs) {
      excluded.push({ symbol: sym, observations: r.length, weight: weights[i] });
    } else {
      included.push(sym);
      inclWeights.push(weights[i]);
      series.push(r);
    }
  });
  if (included.length < 2) {
    return {
      ok: false,
      reason: `only ${included.length} holding(s) have >= ${minObs} daily returns`,
    };
  }
  return {
    ok: true,
    inputs: {
      included,
      weights: inclWeights,
      cov: pairwiseCovMatrix(series),
      excluded,
      excludedWeight: excluded.reduce((s, e) => s + e.weight, 0),
    },
  };
}
