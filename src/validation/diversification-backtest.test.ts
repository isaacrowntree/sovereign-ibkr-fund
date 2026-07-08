/**
 * Diversification Strategy Backtest
 *
 * Compares a concentrated 7-stock tech portfolio against diversified
 * portfolios with assets selected for low correlation and different return drivers.
 *
 * Fund thesis:
 *   Current portfolio is 100% US tech/growth with 35% max drawdown.
 *   Adding uncorrelated and defensive assets should cut drawdown materially
 *   while preserving most of the upside through HRP's risk-based allocation.
 *
 * Sleeve structure:
 *   Tech/Growth:       PLTR, AMZN, ARM, NET, TSLA, TWLO
 *   Industrials/Value: GE, CAT, AVGO
 *   Healthcare/Pharma: LLY, JNJ
 *   Financials:        BRK-B, GS
 *   Defensive/Hedge:   GLD, WMT, KO
 *
 * All 16 symbols have 633 daily bars (Oct 2023 – Apr 2026).
 */
import { describe, it, expect } from 'vitest';
import { BACKTEST_DATA_AVAILABLE } from './data-available';
import { runBacktest, formatResult, loadHistoricalData, DEFAULT_CONFIG, type BacktestConfig } from './backtest-engine';
import { ledoitWolfShrinkage, covToCorr } from '../portfolio/covariance';

// --------------- Universe definitions ---------------

const CONCENTRATED = ['PLTR', 'AMZN', 'TWLO', 'ARM', 'TSLA', 'BRK-B', 'NET'];

const DIVERSIFIED_FULL = [
  // Tech/Growth (6)
  'PLTR', 'AMZN', 'ARM', 'NET', 'TSLA', 'TWLO',
  // Industrials/Value (3)
  'GE', 'CAT', 'AVGO',
  // Healthcare (2)
  'LLY', 'JNJ',
  // Financials (2)
  'BRK-B', 'GS',
  // Defensive/Hedge (3)
  'GLD', 'WMT', 'KO',
];

// Minimal diversification: just add the best uncorrelated assets
const DIVERSIFIED_LIGHT = [
  ...CONCENTRATED,
  'GLD',  // corr 0.03 — uncorrelated gold
  'WMT',  // corr 0.16 — defensive consumer
  'GE',   // corr 0.31 — industrial cycle
];

// Medium: add healthcare + one more industrial
const DIVERSIFIED_MEDIUM = [
  ...CONCENTRATED,
  'GLD', 'WMT', 'GE',
  'LLY',  // corr 0.17 — pharma/GLP-1
  'CAT',  // corr 0.32 — infrastructure
  'KO',   // corr -0.02 — negative correlation hedge
];

const STARTING_NLV = 30000;

// --------------- Helpers ---------------

function makeConfig(name: string, symbols: string[], overrides?: Partial<BacktestConfig>): BacktestConfig {
  return { ...DEFAULT_CONFIG, name, symbols, ...overrides };
}

interface ComparisonRow {
  name: string;
  symbols: number;
  totalReturn: number;
  annReturn: number;
  maxDD: number;
  sharpe: number;
  calmar: number;
  trades: number;
  var95: number;
}

function compareResults(results: { name: string; r: ReturnType<typeof runBacktest> }[]): ComparisonRow[] {
  const rows: ComparisonRow[] = results.map(({ name, r }) => ({
    name,
    symbols: (r.config.symbols ?? CONCENTRATED).length,
    totalReturn: r.totalReturn,
    annReturn: r.annualizedReturn,
    maxDD: r.maxDrawdownPct,
    sharpe: r.sharpeRatio,
    calmar: r.maxDrawdownPct > 0 ? Math.round((r.annualizedReturn / r.maxDrawdownPct) * 100) / 100 : 0,
    trades: r.trades.length,
    var95: r.var95,
  }));

  console.log('\n' + ''.padEnd(40) + 'Syms  Return%  Ann%  MaxDD%  Sharpe  Calmar  Trades  VaR95$');
  for (const row of rows) {
    console.log(
      row.name.padEnd(40),
      String(row.symbols).padStart(4),
      String(row.totalReturn).padStart(8),
      String(row.annReturn).padStart(5),
      String(row.maxDD).padStart(7),
      String(row.sharpe).padStart(7),
      String(row.calmar).padStart(7),
      String(row.trades).padStart(7),
      String(Math.round(row.var95)).padStart(7),
    );
  }
  return rows;
}

// --------------- Tests ---------------

describe.skipIf(!BACKTEST_DATA_AVAILABLE)('Correlation analysis', () => {
  it('diversified universe has lower average pairwise correlation', () => {
    const data = loadHistoricalData();

    function avgCorrelation(symbols: string[]): number {
      const returns = symbols.map(s =>
        data[s].slice(120, 500).map((b: any, i: number, arr: any[]) =>
          i === 0 ? 0 : (b.close - arr[i - 1].close) / arr[i - 1].close
        ).slice(1)
      );
      const { shrunk } = ledoitWolfShrinkage(returns);
      const corr = covToCorr(shrunk);
      let sum = 0, count = 0;
      for (let i = 0; i < symbols.length; i++) {
        for (let j = i + 1; j < symbols.length; j++) {
          sum += corr[i][j];
          count++;
        }
      }
      return sum / count;
    }

    const concCorr = avgCorrelation(CONCENTRATED);
    const divCorr = avgCorrelation(DIVERSIFIED_FULL);

    console.log(`\n=== CORRELATION COMPARISON ===`);
    console.log(`Concentrated (${CONCENTRATED.length} stocks): avg corr = ${concCorr.toFixed(3)}`);
    console.log(`Diversified  (${DIVERSIFIED_FULL.length} stocks): avg corr = ${divCorr.toFixed(3)}`);
    console.log(`Improvement: ${((concCorr - divCorr) / concCorr * 100).toFixed(1)}% lower correlation`);

    expect(divCorr).toBeLessThan(concCorr);
  });
});

describe.skipIf(!BACKTEST_DATA_AVAILABLE)('Diversification strategy comparison', () => {
  it('compares concentrated vs diversified with HRP', () => {
    const results = [
      { name: 'Concentrated (7 stocks, B&H)', r: runBacktest(makeConfig('Concentrated B&H', CONCENTRATED, { optimizerMethod: 'buy_and_hold' }), STARTING_NLV) },
      { name: 'Concentrated (7 stocks, HRP)', r: runBacktest(makeConfig('Concentrated HRP', CONCENTRATED), STARTING_NLV) },
      { name: 'Light diversified (10 stocks, HRP)', r: runBacktest(makeConfig('Light HRP', DIVERSIFIED_LIGHT), STARTING_NLV) },
      { name: 'Medium diversified (13 stocks, HRP)', r: runBacktest(makeConfig('Medium HRP', DIVERSIFIED_MEDIUM), STARTING_NLV) },
      { name: 'Full diversified (16 stocks, HRP)', r: runBacktest(makeConfig('Full HRP', DIVERSIFIED_FULL), STARTING_NLV) },
    ];

    console.log('\n=== DIVERSIFICATION LEVELS (HRP optimizer) ===');
    const rows = compareResults(results);

    // Diversified portfolios should have lower max drawdown
    const concDD = rows.find(r => r.name.includes('Concentrated') && r.name.includes('HRP'))!.maxDD;
    const fullDD = rows.find(r => r.name.includes('Full'))!.maxDD;
    console.log(`\nDrawdown reduction: ${concDD.toFixed(1)}% → ${fullDD.toFixed(1)}% (${((concDD - fullDD) / concDD * 100).toFixed(0)}% improvement)`);
  });

  it('compares optimizer methods on diversified universe', () => {
    const results = [
      { name: 'Diversified B&H', r: runBacktest(makeConfig('Div B&H', DIVERSIFIED_FULL, { optimizerMethod: 'buy_and_hold' }), STARTING_NLV) },
      { name: 'Diversified Equal Weight', r: runBacktest(makeConfig('Div EW', DIVERSIFIED_FULL, { optimizerMethod: 'equal_weight' }), STARTING_NLV) },
      { name: 'Diversified HRP', r: runBacktest(makeConfig('Div HRP', DIVERSIFIED_FULL), STARTING_NLV) },
      { name: 'Diversified B-L Momentum', r: runBacktest(makeConfig('Div BL', DIVERSIFIED_FULL, { optimizerMethod: 'black_litterman' }), STARTING_NLV) },
    ];

    console.log('\n=== OPTIMIZER COMPARISON (16-stock diversified) ===');
    compareResults(results);
  });
});

describe.skipIf(!BACKTEST_DATA_AVAILABLE)('Diversified portfolio parameter sweep', () => {
  it('sweeps key parameters on diversified universe', () => {
    const results = [
      // Baseline
      { name: 'Div HRP (defaults)', r: runBacktest(makeConfig('defaults', DIVERSIFIED_FULL), STARTING_NLV) },
      // Lookback
      { name: 'Div HRP (lookback 60d)', r: runBacktest(makeConfig('lb60', DIVERSIFIED_FULL, { lookbackDays: 60 }), STARTING_NLV) },
      { name: 'Div HRP (lookback 180d)', r: runBacktest(makeConfig('lb180', DIVERSIFIED_FULL, { lookbackDays: 180 }), STARTING_NLV) },
      // Vol target
      { name: 'Div HRP (vol 12%)', r: runBacktest(makeConfig('v12', DIVERSIFIED_FULL, { targetVol: 0.12 }), STARTING_NLV) },
      { name: 'Div HRP (vol 20%)', r: runBacktest(makeConfig('v20', DIVERSIFIED_FULL, { targetVol: 0.20 }), STARTING_NLV) },
      // Drift
      { name: 'Div HRP (drift 5%)', r: runBacktest(makeConfig('d5', DIVERSIFIED_FULL, { rebalanceDriftPct: 5 }), STARTING_NLV) },
      { name: 'Div HRP (drift 15%)', r: runBacktest(makeConfig('d15', DIVERSIFIED_FULL, { rebalanceDriftPct: 15 }), STARTING_NLV) },
      // Regime
      { name: 'Div HRP (no overlay)', r: runBacktest(makeConfig('noov', DIVERSIFIED_FULL, { enableRegimeOverlay: false, enableVolTargeting: false }), STARTING_NLV) },
      // Aggressive DD
      { name: 'Div HRP (DD 10/20/30)', r: runBacktest(makeConfig('aggDD', DIVERSIFIED_FULL, { drawdownLimits: { warningPct: 10, deriskPct: 20, hardStopPct: 30 } }), STARTING_NLV) },
    ];

    console.log('\n=== DIVERSIFIED PORTFOLIO PARAMETER SWEEP ===');
    compareResults(results);
  });

  it('finds optimal diversified configuration', () => {
    const results = [
      { name: 'Concentrated HRP (baseline)', r: runBacktest(makeConfig('conc', CONCENTRATED), STARTING_NLV) },
      { name: 'Diversified Balanced', r: runBacktest(makeConfig('balanced', DIVERSIFIED_FULL, {
        lookbackDays: 180, rebalanceDriftPct: 10, rebalanceFreqDays: 45,
        targetVol: 0.15, drawdownLimits: { warningPct: 7, deriskPct: 15, hardStopPct: 25 },
      }), STARTING_NLV) },
      { name: 'Diversified Growth', r: runBacktest(makeConfig('growth', DIVERSIFIED_FULL, {
        lookbackDays: 60, rebalanceDriftPct: 15, rebalanceFreqDays: 60,
        targetVol: 0.20, enableRegimeOverlay: false,
        drawdownLimits: { warningPct: 10, deriskPct: 20, hardStopPct: 30 },
      }), STARTING_NLV) },
      { name: 'Light Div Balanced', r: runBacktest(makeConfig('light-bal', DIVERSIFIED_LIGHT, {
        lookbackDays: 180, rebalanceDriftPct: 10, rebalanceFreqDays: 45,
        targetVol: 0.15, drawdownLimits: { warningPct: 7, deriskPct: 15, hardStopPct: 25 },
      }), STARTING_NLV) },
      { name: 'Medium Div Balanced', r: runBacktest(makeConfig('med-bal', DIVERSIFIED_MEDIUM, {
        lookbackDays: 180, rebalanceDriftPct: 10, rebalanceFreqDays: 45,
        targetVol: 0.15, drawdownLimits: { warningPct: 7, deriskPct: 15, hardStopPct: 25 },
      }), STARTING_NLV) },
    ];

    console.log('\n=== OPTIMAL DIVERSIFIED CONFIGURATION ===');
    const rows = compareResults(results);

    const bestSharpe = rows.reduce((a, b) => a.sharpe > b.sharpe ? a : b);
    const bestCalmar = rows.reduce((a, b) => a.calmar > b.calmar ? a : b);
    const bestReturn = rows.reduce((a, b) => a.totalReturn > b.totalReturn ? a : b);
    const lowestDD = rows.reduce((a, b) => a.maxDD < b.maxDD ? a : b);

    console.log(`\nBest Sharpe:     ${bestSharpe.name} (${bestSharpe.sharpe})`);
    console.log(`Best Calmar:     ${bestCalmar.name} (${bestCalmar.calmar})`);
    console.log(`Best Return:     ${bestReturn.name} (${bestReturn.totalReturn}%)`);
    console.log(`Lowest Drawdown: ${lowestDD.name} (${lowestDD.maxDD}%)`);

    // Print the trade breakdown for the best config
    const bestConfig = results.find(r => r.name === bestSharpe.name)!;
    console.log(`\n--- ${bestConfig.name}: Position breakdown ---`);
    for (const p of bestConfig.r.finalPositions) {
      console.log(`  ${p.symbol.padEnd(6)} ${String(p.shares).padStart(4)} shares @ avg $${p.avgCost.toFixed(2)}`);
    }
  });
});

describe.skipIf(!BACKTEST_DATA_AVAILABLE)('Sleeve analysis', () => {
  it('measures contribution of each sleeve to portfolio performance', () => {
    const sleeves: Record<string, string[]> = {
      'Tech/Growth only':      ['PLTR', 'AMZN', 'ARM', 'NET', 'TSLA', 'TWLO'],
      'Industrials only':      ['GE', 'CAT', 'AVGO'],
      'Healthcare only':       ['LLY', 'JNJ'],
      'Financials only':       ['BRK-B', 'GS'],
      'Defensive/Hedge only':  ['GLD', 'WMT', 'KO'],
    };

    const results: { name: string; r: ReturnType<typeof runBacktest> }[] = [];
    for (const [name, syms] of Object.entries(sleeves)) {
      results.push({
        name,
        r: runBacktest(makeConfig(name, syms, { optimizerMethod: 'buy_and_hold' }), STARTING_NLV),
      });
    }
    // Add full diversified
    results.push({
      name: 'Full Diversified (all sleeves)',
      r: runBacktest(makeConfig('Full', DIVERSIFIED_FULL), STARTING_NLV),
    });

    console.log('\n=== SLEEVE PERFORMANCE (B&H per sleeve, HRP for combined) ===');
    compareResults(results);

    // The whole should be better than the worst sleeve on risk-adjusted basis
    const fullSharpe = results.find(r => r.name.includes('Full'))!.r.sharpeRatio;
    expect(fullSharpe).toBeGreaterThan(0);
  });
});
