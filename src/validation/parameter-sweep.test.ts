/**
 * Parameter Sweep — find optimal portfolio management parameters on 2.5 years of real data.
 *
 * Sweeps:
 * 1. Optimizer method (HRP vs equal weight vs Black-Litterman)
 * 2. Rebalance drift threshold (3% vs 5% vs 8% vs 10%)
 * 3. Rebalance frequency (15 vs 30 vs 60 vs 90 days)
 * 4. Regime overlay (on/off)
 * 5. Vol targeting (on/off, different target vols)
 * 6. Drawdown limits (conservative vs moderate vs aggressive)
 * 7. Lookback window (60 vs 120 vs 250 days)
 */
import { describe, it, expect } from 'vitest';
import { BACKTEST_DATA_AVAILABLE } from './data-available';
import { runBacktest, DEFAULT_CONFIG, type BacktestConfig } from './backtest-engine';

const STARTING_NLV = 30000;

interface SweepResult {
  label: string;
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  sharpe: number;
  trades: number;
  rebalances: number;
  calmar: number; // annualized return / max drawdown
}

function sweep(label: string, overrides: Partial<BacktestConfig>): SweepResult {
  const config: BacktestConfig = { ...DEFAULT_CONFIG, ...overrides, name: label };
  const r = runBacktest(config, STARTING_NLV);
  const calmar = r.maxDrawdownPct > 0 ? r.annualizedReturn / r.maxDrawdownPct : 0;
  return {
    label,
    totalReturn: r.totalReturn,
    annualizedReturn: r.annualizedReturn,
    maxDrawdown: r.maxDrawdownPct,
    sharpe: r.sharpeRatio,
    trades: r.trades.length,
    rebalances: r.rebalanceCount,
    calmar: Math.round(calmar * 100) / 100,
  };
}

function printSweep(title: string, results: SweepResult[]) {
  console.log(`\n=== ${title} ===`);
  console.log('Label'.padEnd(50), 'Return%', 'Ann%', 'MaxDD%', 'Sharpe', 'Calmar', 'Trades', 'Rebals');
  for (const r of results.sort((a, b) => b.sharpe - a.sharpe)) {
    console.log(
      r.label.padEnd(50),
      String(r.totalReturn).padStart(7),
      String(r.annualizedReturn).padStart(5),
      String(r.maxDrawdown).padStart(6),
      String(r.sharpe).padStart(6),
      String(r.calmar).padStart(6),
      String(r.trades).padStart(6),
      String(r.rebalances).padStart(6),
    );
  }
  return results;
}

describe.skipIf(!BACKTEST_DATA_AVAILABLE)('Parameter sweep', () => {
  it('Phase 1: Optimizer method comparison', () => {
    const results = printSweep('OPTIMIZER METHOD', [
      sweep('Buy & Hold', { optimizerMethod: 'buy_and_hold' }),
      sweep('Equal Weight', { optimizerMethod: 'equal_weight' }),
      sweep('HRP', { optimizerMethod: 'hrp' }),
      sweep('Black-Litterman', { optimizerMethod: 'black_litterman' }),
      // Skip risk parity — known to degenerate with this portfolio
    ]);

    // Over 5 years including 2022 crash, concentrated HRP may have negative Sharpe
    // (de-risks during crash but misses recovery). Key insight: diversification needed.
    const hrp = results.find(r => r.label === 'HRP')!;
    expect(hrp.maxDrawdown).toBeLessThan(25);
  });

  it('Phase 2: Drift threshold sweep (using HRP)', () => {
    const results = printSweep('DRIFT THRESHOLD', [
      sweep('Drift 3%', { rebalanceDriftPct: 3 }),
      sweep('Drift 5%', { rebalanceDriftPct: 5 }),
      sweep('Drift 8%', { rebalanceDriftPct: 8 }),
      sweep('Drift 10%', { rebalanceDriftPct: 10 }),
      sweep('Drift 15%', { rebalanceDriftPct: 15 }),
    ]);

    expect(results.length).toBe(5);
  });

  it('Phase 3: Rebalance frequency sweep', () => {
    const results = printSweep('REBALANCE FREQUENCY', [
      sweep('Every 7 days', { rebalanceFreqDays: 7 }),
      sweep('Every 15 days', { rebalanceFreqDays: 15 }),
      sweep('Every 30 days', { rebalanceFreqDays: 30 }),
      sweep('Every 60 days', { rebalanceFreqDays: 60 }),
      sweep('Every 90 days', { rebalanceFreqDays: 90 }),
    ]);

    expect(results.length).toBe(5);
  });

  it('Phase 4: Regime overlay & vol targeting combinations', () => {
    const results = printSweep('REGIME & VOL TARGETING', [
      sweep('No overlay', { enableRegimeOverlay: false, enableVolTargeting: false }),
      sweep('Regime only', { enableRegimeOverlay: true, enableVolTargeting: false }),
      sweep('Vol target only (15%)', { enableRegimeOverlay: false, enableVolTargeting: true, targetVol: 0.15 }),
      sweep('Both (15% vol)', { enableRegimeOverlay: true, enableVolTargeting: true, targetVol: 0.15 }),
      sweep('Both (20% vol)', { enableRegimeOverlay: true, enableVolTargeting: true, targetVol: 0.20 }),
      sweep('Both (25% vol)', { enableRegimeOverlay: true, enableVolTargeting: true, targetVol: 0.25 }),
      sweep('Both (30% vol)', { enableRegimeOverlay: true, enableVolTargeting: true, targetVol: 0.30 }),
    ]);

    expect(results.length).toBe(7);
  });

  it('Phase 5: Drawdown limit configurations', () => {
    const results = printSweep('DRAWDOWN LIMITS', [
      sweep('Conservative (3/7/12)', { drawdownLimits: { warningPct: 3, deriskPct: 7, hardStopPct: 12 } }),
      sweep('Default (5/10/15)', { drawdownLimits: { warningPct: 5, deriskPct: 10, hardStopPct: 15 } }),
      sweep('Moderate (7/15/20)', { drawdownLimits: { warningPct: 7, deriskPct: 15, hardStopPct: 20 } }),
      sweep('Aggressive (10/20/30)', { drawdownLimits: { warningPct: 10, deriskPct: 20, hardStopPct: 30 } }),
      sweep('Very aggressive (15/25/40)', { drawdownLimits: { warningPct: 15, deriskPct: 25, hardStopPct: 40 } }),
    ]);

    expect(results.length).toBe(5);
  });

  it('Phase 6: Lookback window sweep', () => {
    const results = printSweep('LOOKBACK WINDOW', [
      sweep('60 days', { lookbackDays: 60 }),
      sweep('90 days', { lookbackDays: 90 }),
      sweep('120 days', { lookbackDays: 120 }),
      sweep('180 days', { lookbackDays: 180 }),
      sweep('250 days', { lookbackDays: 250 }),
    ]);

    expect(results.length).toBe(5);
  });

  it('Phase 7: Optimal configuration (best from each phase)', () => {
    // Run with the best combo discovered from phases above
    // (these values will be filled in after analyzing phase results)
    const candidates = [
      sweep('Baseline (defaults)', {}),
      // Higher vol target + wider drift = less rebalancing, more exposure
      sweep('Growth-oriented', {
        rebalanceDriftPct: 10,
        rebalanceFreqDays: 60,
        targetVol: 0.25,
        enableRegimeOverlay: true,
        enableVolTargeting: true,
        drawdownLimits: { warningPct: 7, deriskPct: 15, hardStopPct: 25 },
      }),
      // Tighter rebalancing, lower vol target = more conservative
      sweep('Conservative', {
        rebalanceDriftPct: 3,
        rebalanceFreqDays: 15,
        targetVol: 0.12,
        enableRegimeOverlay: true,
        enableVolTargeting: true,
        drawdownLimits: { warningPct: 3, deriskPct: 7, hardStopPct: 12 },
      }),
      // Middle ground
      sweep('Balanced', {
        rebalanceDriftPct: 5,
        rebalanceFreqDays: 30,
        targetVol: 0.20,
        enableRegimeOverlay: true,
        enableVolTargeting: true,
        drawdownLimits: { warningPct: 5, deriskPct: 12, hardStopPct: 20 },
        lookbackDays: 90,
      }),
      // No overlay but aggressive rebalancing
      sweep('Pure HRP (no overlay)', {
        rebalanceDriftPct: 5,
        rebalanceFreqDays: 30,
        enableRegimeOverlay: false,
        enableVolTargeting: false,
      }),
      // B-L with momentum
      sweep('B-L Momentum', {
        optimizerMethod: 'black_litterman',
        rebalanceDriftPct: 8,
        rebalanceFreqDays: 30,
        targetVol: 0.25,
        enableRegimeOverlay: true,
        enableVolTargeting: true,
        drawdownLimits: { warningPct: 7, deriskPct: 15, hardStopPct: 25 },
      }),
    ];

    const results = printSweep('OPTIMAL CANDIDATES', candidates);

    // Find best by Sharpe
    const bestSharpe = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);
    // Find best by Calmar (return per unit of drawdown)
    const bestCalmar = results.reduce((a, b) => a.calmar > b.calmar ? a : b);
    // Find best by total return
    const bestReturn = results.reduce((a, b) => a.totalReturn > b.totalReturn ? a : b);

    console.log('\n=== OPTIMAL PICKS ===');
    console.log(`Best Sharpe:  ${bestSharpe.label} (${bestSharpe.sharpe})`);
    console.log(`Best Calmar:  ${bestCalmar.label} (${bestCalmar.calmar})`);
    console.log(`Best Return:  ${bestReturn.label} (${bestReturn.totalReturn}%)`);

    expect(bestSharpe.sharpe).toBeGreaterThan(0);
  });
});
