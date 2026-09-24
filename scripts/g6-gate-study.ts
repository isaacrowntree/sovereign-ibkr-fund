/**
 * G6: legacy drift gate vs the F1 band gate — the pre-registered comparison.
 *
 *   npx tsx scripts/g6-gate-study.ts [--targets targets.json] [--out result.json]
 *
 * targets.json: [{ "symbol", "pct", "sleeve"? }]. Without it the active model
 * portfolio is used (the private override when present, else the sample). Needs
 * the gitignored study data (historical-energy.json, fx-audusd.json,
 * dividends.json — see src/validation/fetch-data.ts). Prints the decision rule
 * FIRST, then the results and the verdict. Prints no account figure: capital
 * is a synthetic USD 30,000.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { LIVE_CONFIG, type BacktestConfig } from '../src/validation/backtest-engine';
import {
  DECISION_RULE, WINDOWS, STUDY_DATA, STUDY_DIVIDENDS, buildStartBook, evaluateRun, runBacktest,
  type StudyTarget, type StudyMetrics,
} from '../src/validation/gate-study';
import { pairedDifference } from '../src/validation/bootstrap';
import { PLAN_BANDS } from '../src/portfolio/drift-bands';
import { TARGET_PORTFOLIO } from '../src/config';

const args = process.argv.slice(2);
const flag = (n: string): string | null => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] ?? null; };
const targets: StudyTarget[] = flag('--targets')
  ? JSON.parse(readFileSync(flag('--targets')!, 'utf8'))
  : TARGET_PORTFOLIO.map(t => ({ symbol: t.symbol, pct: t.pct, sleeve: t.sleeve }));
const CAPITAL = 30_000;
const SLIPPAGE = LIVE_CONFIG.slippagePctPerSide;
const symbols = targets.map(t => t.symbol);
const tot = targets.reduce((s, t) => s + t.pct, 0);
const staticWeights = targets.map(t => t.pct / tot);

console.log('=== G6 decision rule (registered ' + DECISION_RULE.registered + ', fixed before the runs) ===');
for (const l of DECISION_RULE.text) console.log(l);
console.log(`\nBook: ${symbols.length} names, targets ${Math.min(...targets.map(t => t.pct))}–${Math.max(...targets.map(t => t.pct))}%, ` +
  `synthetic USD ${CAPITAL.toLocaleString()}, growth sleeve 40% under target at the start, 1% cash.\n`);

const semiAnnualDeposits = (from: string, to: string): Array<{ date: string; amountAud: number }> => {
  const out: Array<{ date: string; amountAud: number }> = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const md of ['-01-02', '-07-01']) {
      const d = `${y}${md}`;
      if (d > from && d <= to) out.push({ date: d, amountAud: 5_000 });
    }
  }
  return out;
};

type Arm = { key: string; label: string; cfg: (w: { from: string; to: string }) => Partial<BacktestConfig> };
const ARMS: Arm[] = [
  { key: 'legacy', label: 'Legacy gate (live knobs)', cfg: () => ({}) },
  { key: 'bands', label: 'Band gate (plan F1)', cfg: () => ({ gate: 'bands' }) },
  { key: 'bands-noguard', label: 'Band gate, no CGT guard', cfg: () => ({ gate: 'bands', bandParams: { ...PLAN_BANDS, taxGuardDays: 0 } }) },
  { key: 'legacy-d5', label: 'Legacy gate, drift 5%', cfg: () => ({ rebalanceDriftPct: 5 }) },
  { key: 'legacy-dep', label: 'Legacy + AUD 5k deposits / 6 mo', cfg: w => ({ deposits: semiAnnualDeposits(w.from, w.to) }) },
  { key: 'bands-dep', label: 'Bands + AUD 5k deposits / 6 mo', cfg: w => ({ gate: 'bands', deposits: semiAnnualDeposits(w.from, w.to) }) },
  { key: 'legacy-miss', label: 'Legacy, 20% missed runs', cfg: () => ({ missedRunRate: 0.2 }) },
  { key: 'bands-miss', label: 'Bands, 20% missed runs', cfg: () => ({ gate: 'bands', missedRunRate: 0.2 }) },
];

const results: Record<string, Record<string, StudyMetrics>> = {};
for (const [wk, w] of Object.entries(WINDOWS)) {
  const book = buildStartBook(targets, w.from, CAPITAL, { residueSleeve: 'tech_growth' });
  results[wk] = {};
  for (const arm of ARMS) {
    const cfg: BacktestConfig = {
      ...LIVE_CONFIG,
      name: arm.label,
      dataFile: STUDY_DATA,
      symbols,
      staticWeights,
      lookbackDays: 60,
      useTotalReturn: false,
      dividendsFile: STUDY_DIVIDENDS,
      commissionModel: 'ibkr-fixed',
      missedRunRate: 0.05,
      missedRunSeed: 2026,
      initialLots: book.lots,
      ...arm.cfg(w),
    };
    const r = runBacktest(cfg, CAPITAL, undefined, w.from, w.to);
    results[wk][arm.key] = evaluateRun(r, book.lots, {
      marginalRate: DECISION_RULE.marginalRate, sensitivityRate: DECISION_RULE.sensitivityRate, slippage: SLIPPAGE,
    });
  }
}

const f = (n: number, d = 1): string => (n >= 0 ? ' ' : '') + n.toFixed(d);
for (const [wk, w] of Object.entries(WINDOWS)) {
  console.log(`\n--- ${wk}: ${w.label} ---`);
  console.log('| arm | after-tax % (47) | after-tax % (32) | pre-tax % | max DD % | trades | sells | turnover %/window | <12m disposals | ≥12m disposals |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const arm of ARMS) {
    const m = results[wk][arm.key];
    console.log(`| ${arm.label} | ${f(m.afterTaxReturnPct)} | ${f(m.afterTaxReturnPctSensitivity)} | ${f(m.preTaxReturnPct)} | ` +
      `${m.maxDrawdownPct.toFixed(1)} | ${m.trades} | ${m.sells} | ${m.turnoverPct.toFixed(0)} | ${m.nonDiscountDisposals} | ${m.discountDisposals} |`);
  }
}

const pair = (wk: string, a: string, b: string) => {
  const A = results[wk][a];
  const B = results[wk][b];
  const boot = pairedDifference(A.unitReturns, B.unitReturns, DECISION_RULE.bootstrap);
  return {
    m1Diff: A.afterTaxReturnPct - B.afterTaxReturnPct,
    m1DiffSensitivity: A.afterTaxReturnPctSensitivity - B.afterTaxReturnPctSensitivity,
    m2Diff: A.maxDrawdownPct - B.maxDrawdownPct,
    boot,
  };
};
const pairs = {
  W1: pair('W1', 'bands', 'legacy'),
  W2: pair('W2', 'bands', 'legacy'),
  W3: pair('W3', 'bands', 'legacy'),
  'W1 deposits': pair('W1', 'bands-dep', 'legacy-dep'),
  'W1 missed 20%': pair('W1', 'bands-miss', 'legacy-miss'),
  'W1 guard ablation (bands − bands no guard)': pair('W1', 'bands', 'bands-noguard'),
};
console.log('\n--- Paired: first arm − second arm ---');
console.log('| pair | ΔM1 after-tax pp (47) | ΔM1 (32) | ΔM2 max DD pp | Δ annualised (bootstrap mean) | one-sided 95% lower bound |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const [k, p] of Object.entries(pairs)) {
  console.log(`| ${k} | ${f(p.m1Diff, 2)} | ${f(p.m1DiffSensitivity, 2)} | ${f(p.m2Diff, 2)} | ` +
    `${f(p.boot.annualisedMean * 100, 2)}%/yr | ${f(p.boot.lowerBound * 100, 2)}%/yr |`);
}

const R = DECISION_RULE;
const checks = [
  { c: '(1) W1 ΔM1 ≥ −1.0pp', ok: pairs.W1.m1Diff >= R.afterTaxMarginPp },
  { c: '(2) W1 bootstrap lower bound ≥ −1.0%/yr', ok: pairs.W1.boot.lowerBound >= R.bootstrapMarginPerYear },
  { c: '(3) W1 ΔM2 ≤ +2.0pp', ok: pairs.W1.m2Diff <= R.maxDrawdownMarginPp },
  { c: '(4) W2 ΔM1 ≥ −1.0pp and ΔM2 ≤ +2.0pp', ok: pairs.W2.m1Diff >= R.afterTaxMarginPp && pairs.W2.m2Diff <= R.maxDrawdownMarginPp },
];
console.log('\n--- Verdict ---');
for (const k of checks) console.log(`${k.ok ? 'PASS' : 'FAIL'}  ${k.c}`);
const nonInferior = checks.every(k => k.ok);
console.log(nonInferior
  ? 'Band gate is NON-INFERIOR under the registered rule: switch-on supported, subject to the live shadow record.'
  : 'Band gate is NOT shown non-inferior under the registered rule: do not switch on.');

const out = flag('--out');
if (out) {
  const slim = Object.fromEntries(Object.entries(results).map(([wk, arms]) => [wk, Object.fromEntries(
    Object.entries(arms).map(([k, m]) => [k, { ...m, unitReturns: undefined, dates: undefined }]))]));
  writeFileSync(out, JSON.stringify({ rule: DECISION_RULE, results: slim, pairs, checks, nonInferior }, null, 2));
}
