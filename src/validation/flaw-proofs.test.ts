/**
 * Regression locks from the 2026-08-29 truthfulness audit.
 *
 * Four flaws were confirmed by proof tests (see this file's git history for
 * the pre-fix versions, which PASSED against the flawed engine):
 *
 *  P1 Silent window fallback — runBacktest ignored start/end dates missing
 *     from the dataset and ran the full period; the "2022 Bear Market"
 *     scenario actually ran 2024-06→2026-08 its whole life.
 *  P2 Regime parity — DEFAULT_CONFIG (lookback 180, no regimeMinHistory)
 *     computed regimes from ≤181 samples where production's quant-analyst
 *     requires ≥200 and fails OPEN (no multiplier) below that; trendSignal
 *     silently shrank its 200-day MA to fit. Measured impact on the default
 *     window: 84 sub-200-sample regime actions, 70.5% vs 83.0% return.
 *  P3 Frictionless fills — production measures implementation shortfall per
 *     fill (execution/shortfall.ts); the backtest paid zero spread/slippage.
 *  P4 Dividend blindness — returns used raw closes; TLT over the bundled
 *     window is −6.1% price-only vs +5.9% total-return, poisoning every
 *     hedge-composition conclusion.
 *
 * The locks below fail if any of those regressions come back.
 */
import { describe, it, expect } from 'vitest';
import { BACKTEST_DATA_AVAILABLE } from './data-available';
import { runBacktest, loadHistoricalData, DEFAULT_CONFIG } from './backtest-engine';

describe.skipIf(!BACKTEST_DATA_AVAILABLE)('Audit regression locks', () => {
  it('L1: a requested window outside the dataset throws, never substitutes', () => {
    expect(() =>
      runBacktest(DEFAULT_CONFIG, 30000, undefined, '2022-01-01', '2022-12-31'),
    ).toThrow(/outside the dataset/);
    expect(() =>
      runBacktest(DEFAULT_CONFIG, 30000, undefined, undefined, '2019-01-01'),
    ).toThrow(/outside the dataset/);
  });

  it('L2: DEFAULT_CONFIG mirrors the production regime gate', () => {
    // quant-analyst: >= 200 samples or the regime is null; strategist applies
    // no multiplier on null (fails open at 1.0).
    expect(DEFAULT_CONFIG.regimeMinHistory).toBe(200);
    expect(DEFAULT_CONFIG.unknownRegimeExposure).toBe(1.0);
    // The regime overlay gets its own >= 200-day window regardless of the
    // optimizer's shorter covariance lookback.
    expect(DEFAULT_CONFIG.regimeLookbackDays).toBeGreaterThanOrEqual(200);

    // And the gate actually bites: with a 200-day regime window the overlay
    // becomes active once history allows — regimes are counted, but none may
    // ever be computed from fewer than regimeMinHistory samples (asserted by
    // construction: regimeLookbackDays >= regimeMinHistory).
    const r = runBacktest({ ...DEFAULT_CONFIG, name: 'gate check' }, 30000);
    const total = Object.values(r.regimeCounts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('L3: fills pay slippage in the adverse direction', () => {
    expect(DEFAULT_CONFIG.slippagePctPerSide).toBeGreaterThan(0);
    const withSlip = runBacktest({ ...DEFAULT_CONFIG, name: 'slip' }, 30000);
    const noSlip = runBacktest({ ...DEFAULT_CONFIG, name: 'no slip', slippagePctPerSide: 0 }, 30000);
    console.log(`L3: return with 5bps/side ${withSlip.totalReturn}% vs frictionless ${noSlip.totalReturn}% (${withSlip.trades.length} trades)`);
    // Slippage can only cost money on the same trade sequence; allow equality
    // in case rounding produces an identical path.
    expect(withSlip.totalReturn).toBeLessThanOrEqual(noSlip.totalReturn);
  });

  it('L4: prices are total-return (dividend-adjusted) by default', () => {
    expect(DEFAULT_CONFIG.useTotalReturn).toBe(true);
    const data = loadHistoricalData();
    const tlt = data['TLT'];
    const adjRet = (tlt[tlt.length - 1].adjClose / tlt[0].adjClose - 1) * 100;
    const closeRet = (tlt[tlt.length - 1].close / tlt[0].close - 1) * 100;
    // The gap this fix reclaims — if it shrinks to ~0 the data file itself
    // has regressed to unadjusted-only.
    expect(adjRet - closeRet).toBeGreaterThan(5);
  });

  it('L5: quantifies survivorship in the 7-name universe vs a neutral benchmark', () => {
    // The core universe is today's holdings — names selected partly BECAUSE
    // they performed. Backtesting them is survivorship-biased by
    // construction; this cannot be fixed retroactively, only measured. QQQ
    // (in the same dataset) is the no-hindsight benchmark: the gap between
    // 7-name B&H and QQQ B&H on the identical window is the inflation any
    // absolute return figure carries.
    const seven = runBacktest({ ...DEFAULT_CONFIG, name: '7-name B&H', optimizerMethod: 'buy_and_hold' }, 30000);
    const qqq = runBacktest({ ...DEFAULT_CONFIG, name: 'QQQ B&H', symbols: ['QQQ', 'GLD'], optimizerMethod: 'buy_and_hold' }, 30000);
    console.log(`L5: 7-name B&H ${seven.totalReturn}% vs QQQ/GLD B&H ${qqq.totalReturn}% — gap ${(seven.totalReturn - qqq.totalReturn).toFixed(0)}pp is the survivorship inflation`);
    expect(seven.finalPortfolioValue).toBeGreaterThan(0);
    expect(qqq.finalPortfolioValue).toBeGreaterThan(0);
  });

  it('quantifies the honest-vs-legacy gap on the default window', () => {
    const honest = runBacktest({ ...DEFAULT_CONFIG, name: 'honest (audited defaults)' }, 30000);
    const legacy = runBacktest({
      ...DEFAULT_CONFIG,
      name: 'legacy (pre-audit behaviour)',
      slippagePctPerSide: 0,
      useTotalReturn: false,
      regimeMinHistory: 0,
      regimeLookbackDays: DEFAULT_CONFIG.lookbackDays,
      unknownRegimeExposure: undefined,
    }, 30000);
    console.log(`honest: ${honest.totalReturn}% (DD ${honest.maxDrawdownPct}%, ${honest.trades.length} trades)`);
    console.log(`legacy: ${legacy.totalReturn}% (DD ${legacy.maxDrawdownPct}%, ${legacy.trades.length} trades)`);
    expect(honest.finalPortfolioValue).toBeGreaterThan(0);
    expect(legacy.finalPortfolioValue).toBeGreaterThan(0);
  });
});
