import { describe, it, expect } from 'vitest';
import { buildHoldingsSnapshot } from './managing-partner.js';

/**
 * Regression: the snapshot mixed currencies.
 *
 * IBKR position `mktValue` comes back in the POSITION's currency (USD), but
 * `getAccountSummary().netLiquidation` is the account BASE currency — AUD here.
 * `currentPct = usdValue / audNav` therefore understated every weight by the
 * AUD/USD rate (~1.42x), making a ~95%-invested book look ~67% invested and
 * every holding chronically underweight in the daily digest.
 *
 * `portfolio-strategist.ts` already gets this right (it uses getUsdBalances()),
 * so this was a reporting-only defect — but the digest is the human-facing
 * signal, and a permanently-wrong one trains you to ignore it.
 */
describe('buildHoldingsSnapshot', () => {
  const targets = [
    { symbol: 'AAA', pct: 50, sleeve: 'x' },
    { symbol: 'BBB', pct: 50, sleeve: 'y' },
  ];

  it('computes currentPct against USD NAV, not the AUD base NAV', () => {
    const snap = buildHoldingsSnapshot({
      navUsd: 10_000,
      cashUsd: 1_000,
      positions: [
        { symbol: 'AAA', qty: 10 },
        { symbol: 'BBB', qty: 20 },
      ],
      prices: new Map([['AAA', 100], ['BBB', 150]]),
      targets,
    });

    // AAA: 10 * 100 = 1000 USD of a 10000 USD NAV => 10.0%
    // (over an AUD-denominated NAV it would have read ~7.0%)
    expect(snap.holdings[0]).toMatchObject({ symbol: 'AAA', currentValue: 1000, currentPct: 10 });
    // BBB: 20 * 150 = 3000 => 30.0%
    expect(snap.holdings[1]).toMatchObject({ symbol: 'BBB', currentValue: 3000, currentPct: 30 });
  });

  it('reports a nearly-fully-invested book as such, not ~2/3 invested', () => {
    // Shape of the production defect, with synthetic amounts. What matters is
    // the RATIO: an AUD-based NAV is ~1.42x the USD NAV, so dividing USD
    // position values by it scaled every weight down by the same factor and
    // turned a ~95%-invested book into a ~67%-invested one.
    const AUD_PER_USD = 1.42;
    const navUsd = 20_000;
    const investedUsd = 19_000; // 95% invested
    const snap = buildHoldingsSnapshot({
      navUsd,
      cashUsd: 1_000,
      positions: [{ symbol: 'AAA', qty: 1 }],
      prices: new Map([['AAA', investedUsd]]),
      targets: [{ symbol: 'AAA', pct: 95, sleeve: 'all' }],
    });
    expect(snap.holdings[0].currentPct).toBeCloseTo(95, 1);
    // What the bug produced: the same value over an AUD-denominated NAV.
    const buggyPct = (investedUsd / (navUsd * AUD_PER_USD)) * 100;
    expect(buggyPct).toBeCloseTo(66.9, 1);
  });

  it('records NAV and cash in USD so the snapshot is internally consistent', () => {
    const snap = buildHoldingsSnapshot({
      navUsd: 20_000,
      cashUsd: 1_000,
      positions: [],
      prices: new Map(),
      targets: [],
    });
    expect(snap.netLiquidation).toBe(20_000);
    expect(snap.cashValue).toBe(1_000);
  });

  it('treats a missing position as zero rather than throwing', () => {
    const snap = buildHoldingsSnapshot({
      navUsd: 10_000, cashUsd: 0,
      positions: [], prices: new Map([['AAA', 100]]), targets,
    });
    expect(snap.holdings[0]).toMatchObject({ currentValue: 0, currentPct: 0 });
  });

  it('guards against a zero/absent NAV instead of producing Infinity', () => {
    const snap = buildHoldingsSnapshot({
      navUsd: 0, cashUsd: 0,
      positions: [{ symbol: 'AAA', qty: 10 }],
      prices: new Map([['AAA', 100]]), targets,
    });
    expect(snap.holdings[0].currentPct).toBe(0);
    expect(Number.isFinite(snap.holdings[0].currentPct)).toBe(true);
  });

  it('treats a missing price as zero value, not NaN', () => {
    const snap = buildHoldingsSnapshot({
      navUsd: 10_000, cashUsd: 0,
      positions: [{ symbol: 'AAA', qty: 10 }],
      prices: new Map(), targets,
    });
    expect(snap.holdings[0].currentValue).toBe(0);
    expect(Number.isNaN(snap.holdings[0].currentPct)).toBe(false);
  });
});
