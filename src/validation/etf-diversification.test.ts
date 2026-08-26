/**
 * ETF Diversification Backtest
 *
 * Compares the current 13-stock portfolio against variants that layer in
 * high-performing and uncorrelated ETFs (SMH, QQQ, VXUS, TLT, VNQ, XLE).
 *
 * Goal: find the universe + weight scheme with the best risk-adjusted return
 * (Sharpe/Calmar) given the user's existing single-name exposures.
 */
import { describe, it, expect } from 'vitest';
import { BACKTEST_DATA_AVAILABLE } from './data-available';
import { runBacktest, formatResult, loadHistoricalData, DEFAULT_CONFIG, type BacktestConfig } from './backtest-engine';
import { ledoitWolfShrinkage, covToCorr } from '../portfolio/covariance';

const STARTING_NLV = 30000;

const STOCKS_13 = [
  'PLTR', 'AMZN', 'ARM', 'NET', 'TSLA', 'TWLO',
  'GE', 'CAT',
  'LLY',
  'BRK-B',
  'GLD', 'WMT', 'KO',
];

const STOCKS_16 = [
  ...STOCKS_13,
  'AVGO',   // semis/growth — top 2.5y performer
  'JNJ',    // healthcare defensive
  'GS',     // financials
];

const ETFS_HEAVY = ['SMH', 'QQQ', 'VXUS', 'TLT', 'VNQ', 'XLE'];
const ETFS_TOP4 = ['SMH', 'TLT', 'VNQ', 'VXUS'];
const ETFS_LEAN = ['SMH', 'TLT'];

function cfg(name: string, symbols: string[], overrides?: Partial<BacktestConfig>): BacktestConfig {
  return {
    ...DEFAULT_CONFIG,
    name,
    symbols,
    lookbackDays: 180,
    rebalanceDriftPct: 10,
    rebalanceFreqDays: 45,
    targetVol: 0.15,
    drawdownLimits: { warningPct: 7, deriskPct: 15, hardStopPct: 25 },
    ...overrides,
  };
}

interface Row {
  name: string;
  n: number;
  totalReturn: number;
  annReturn: number;
  maxDD: number;
  sharpe: number;
  calmar: number;
  var95: number;
}

function toRow(name: string, r: ReturnType<typeof runBacktest>): Row {
  return {
    name,
    n: r.config.symbols?.length ?? 0,
    totalReturn: r.totalReturn,
    annReturn: r.annualizedReturn,
    maxDD: r.maxDrawdownPct,
    sharpe: r.sharpeRatio,
    calmar: r.maxDrawdownPct > 0 ? Math.round((r.annualizedReturn / r.maxDrawdownPct) * 100) / 100 : 0,
    var95: r.var95,
  };
}

function printTable(rows: Row[]) {
  console.log('\n' + 'Universe'.padEnd(42) + '  N  TotRet%  AnnRet%  MaxDD%   Sharpe  Calmar   VaR95$');
  console.log('-'.repeat(105));
  for (const r of rows) {
    console.log(
      r.name.padEnd(42),
      String(r.n).padStart(3),
      String(r.totalReturn).padStart(7),
      String(r.annReturn).padStart(7),
      String(r.maxDD).padStart(7),
      String(r.sharpe).padStart(7),
      String(r.calmar).padStart(7),
      String(Math.round(r.var95)).padStart(7),
    );
  }
}

describe.skipIf(!BACKTEST_DATA_AVAILABLE)('ETF diversification impact', () => {
  // 30s, not vitest's default 5s. This runs a full HRP backtest over six
  // candidate universes: ~1.5s alone, but >5s when the rest of the validation
  // suite is running in parallel, so it failed only in full-suite runs and
  // passed on every re-run in isolation. Generous enough that a genuine hang
  // still fails rather than being papered over.
  it('compares stocks-only vs ETF-augmented universes (HRP)', () => {
    const rows: Row[] = [];

    const candidates: { name: string; syms: string[] }[] = [
      { name: '13 stocks (current config)', syms: STOCKS_13 },
      { name: '16 stocks (+AVGO, JNJ, GS)', syms: STOCKS_16 },
      { name: '13 stocks + SMH', syms: [...STOCKS_13, 'SMH'] },
      { name: '13 stocks + SMH + TLT (lean ETF)', syms: [...STOCKS_13, ...ETFS_LEAN] },
      { name: '13 stocks + 4 ETFs (SMH/TLT/VNQ/VXUS)', syms: [...STOCKS_13, ...ETFS_TOP4] },
      { name: '13 stocks + 6 ETFs (all candidates)', syms: [...STOCKS_13, ...ETFS_HEAVY] },
      { name: '16 stocks + 4 ETFs', syms: [...STOCKS_16, ...ETFS_TOP4] },
      { name: '16 stocks + 6 ETFs', syms: [...STOCKS_16, ...ETFS_HEAVY] },
      { name: '16 stocks + TLT (hedge only)', syms: [...STOCKS_16, 'TLT'] },
      { name: '16 stocks + XLE (energy hedge)', syms: [...STOCKS_16, 'XLE'] },
      { name: '16 stocks + TLT + XLE', syms: [...STOCKS_16, 'TLT', 'XLE'] },
    ];

    for (const { name, syms } of candidates) {
      const r = runBacktest(cfg(name, syms), STARTING_NLV);
      rows.push(toRow(name, r));
    }

    console.log('\n=== ETF DIVERSIFICATION IMPACT (HRP optimizer, 2.5y backtest) ===');
    printTable(rows);

    const baseline = rows.find(r => r.name.startsWith('13 stocks (current'))!;
    const best = rows.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
    const lowestDD = rows.reduce((a, b) => (b.maxDD < a.maxDD ? b : a));

    console.log(`\nBaseline Sharpe:   ${baseline.sharpe} (MaxDD ${baseline.maxDD}%)`);
    console.log(`Best Sharpe:       ${best.name} → ${best.sharpe} (MaxDD ${best.maxDD}%)`);
    console.log(`Lowest MaxDD:      ${lowestDD.name} → ${lowestDD.maxDD}% (Sharpe ${lowestDD.sharpe})`);

    // ETF augmentation should at minimum not destroy risk-adjusted returns
    expect(best.sharpe).toBeGreaterThan(0);
  }, 30_000);
  it('measures correlation of each ETF vs existing portfolio', () => {
    const data = loadHistoricalData();
    const ETFS_TO_MEASURE = ['SMH', 'QQQ', 'VXUS', 'TLT', 'VNQ', 'XLE', 'AVGO', 'JNJ', 'GS'];

    function dailyReturns(bars: any[]): number[] {
      return bars.slice(1).map((b, i) => (b.close - bars[i].close) / bars[i].close);
    }

    // Use an equal-weighted synthetic return series for existing portfolio
    const stockReturnArrays = STOCKS_13.map(s => dailyReturns(data[s]));
    const minLen = Math.min(...stockReturnArrays.map(a => a.length));
    const portfolioReturns: number[] = new Array(minLen).fill(0);
    for (let t = 0; t < minLen; t++) {
      let sum = 0;
      for (const arr of stockReturnArrays) sum += arr[arr.length - minLen + t];
      portfolioReturns[t] = sum / stockReturnArrays.length;
    }

    function pearson(a: number[], b: number[]): number {
      const n = Math.min(a.length, b.length);
      const aa = a.slice(a.length - n);
      const bb = b.slice(b.length - n);
      const ma = aa.reduce((s, v) => s + v, 0) / n;
      const mb = bb.reduce((s, v) => s + v, 0) / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) {
        const x = aa[i] - ma, y = bb[i] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
      }
      return num / (Math.sqrt(da) * Math.sqrt(db) || 1);
    }

    const corrs: { symbol: string; corr: number }[] = [];
    for (const sym of ETFS_TO_MEASURE) {
      const r = dailyReturns(data[sym]);
      corrs.push({ symbol: sym, corr: pearson(r, portfolioReturns) });
    }
    corrs.sort((a, b) => a.corr - b.corr);

    console.log('\n=== CORRELATION vs 13-stock equal-weighted portfolio ===');
    console.log('(Lower correlation = better diversifier)');
    for (const { symbol, corr } of corrs) {
      const bar = '█'.repeat(Math.max(0, Math.floor(corr * 20)));
      console.log(`  ${symbol.padEnd(6)} ${corr.toFixed(3).padStart(6)}  ${bar}`);
    }
  });

  it('optimizer comparison on the best universe', () => {
    const best = [...STOCKS_13, ...ETFS_TOP4];
    const rows: Row[] = [];
    for (const opt of ['hrp', 'risk_parity', 'equal_weight', 'black_litterman'] as const) {
      const r = runBacktest(cfg(`${opt} / 13s+4ETF`, best, { optimizerMethod: opt }), STARTING_NLV);
      rows.push(toRow(`${opt.padEnd(16)}`, r));
    }
    console.log('\n=== OPTIMIZER COMPARISON (13 stocks + 4 ETFs) ===');
    printTable(rows);
  });
});
