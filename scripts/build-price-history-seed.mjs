/**
 * Build a retroactive priceHistory seed for the fund's state store.
 *
 * WHY. A rebuild wiped priceHistory, and every risk input is gated on its depth:
 * the regime overlay needs 200 daily samples, HRP needs 60, the factor regression
 * 30. Accumulating those live takes months, during which the regime overlay is
 * absent (and reads as "unrestricted", not "unknown") and allocation falls back to
 * the static book. Seeding real history removes the blind window outright, which
 * is strictly better than choosing a fallback exposure to sit in it.
 *
 * WHAT IS SEEDED. Only `priceHistory` and `priceHistoryDates` — market data, which
 * is a matter of public record. Explicitly NOT `navHistory`: that is this account's
 * own equity curve, we already hold the real one, and inventing it would move the
 * drawdown peak that gates the hard stop.
 *
 * PRICE BASIS. Yahoo adjClose (total return: split- AND dividend-adjusted), because
 * the consumers are covariance, correlation and volatility estimates, and raw closes
 * inject a fake negative return on every ex-dividend date. Each symbol's series is
 * then multiplied by a per-symbol factor so it lands exactly on the price the live
 * gateway last observed. That matters for two reasons: `avgPrices` in the regime
 * block sums price LEVELS across symbols, and portfolio-strategist:104 uses the last
 * element as an absolute price for its live-quote sanity check — a seam discontinuity
 * there would either trip that check or hide a real one.
 *
 * Usage: node scripts/build-price-history-seed.mjs <historical.json> <anchors.json> <out.json> [maxDays]
 *   anchors.json: { lastDate: "YYYY-MM-DD", prices: { SYM: number } } from the live store.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , histPath, anchorPath, outPath, maxDaysArg] = process.argv;
if (!histPath || !anchorPath || !outPath) {
  console.error('usage: build-price-history-seed.mjs <historical.json> <anchors.json> <out.json> [maxDays]');
  process.exit(1);
}
const MAX_DAYS = parseInt(maxDaysArg || '500', 10); // matches the store's cap

const hist = JSON.parse(readFileSync(histPath, 'utf8'));
const { lastDate, prices: anchors } = JSON.parse(readFileSync(anchorPath, 'utf8'));
const symbols = Object.keys(anchors);

const fail = (m) => { console.error(`FATAL: ${m}`); process.exit(1); };

// Every symbol must be present, or the seed would be partially aligned.
const missing = symbols.filter((s) => !Array.isArray(hist[s]) || hist[s].length === 0);
if (missing.length) fail(`no historical bars for ${missing.join(', ')}`);

// Use only dates every symbol shares — the right-anchored invariant requires
// index N to mean the same trading day for all of them.
const sets = symbols.map((s) => new Set(hist[s].map((b) => b.date)));
let dates = [...sets[0]].filter((d) => sets.every((x) => x.has(d))).sort();

const anchorIdx = dates.indexOf(lastDate);
if (anchorIdx === -1) fail(`anchor date ${lastDate} is not a common trading day in the dataset`);
// Drop anything after the anchor: the live store is authoritative from there on.
dates = dates.slice(0, anchorIdx + 1);
if (dates.length > MAX_DAYS) dates = dates.slice(-MAX_DAYS);

const byDate = {};
for (const s of symbols) {
  byDate[s] = new Map(hist[s].map((b) => [b.date, b]));
}

const priceHistory = {};
const report = [];
for (const s of symbols) {
  const anchorBar = byDate[s].get(lastDate);
  if (!anchorBar) fail(`${s} has no bar on the anchor date ${lastDate}`);
  const adj = anchorBar.adjClose;
  if (!(adj > 0)) fail(`${s} has a non-positive adjClose on ${lastDate}`);

  const factor = anchors[s] / adj;
  if (!Number.isFinite(factor) || factor <= 0) fail(`${s} produced a bad scale factor`);
  // A live quote and the official close should agree closely. A large gap means
  // the anchor is stale or the symbol is mismatched between the two sources.
  if (Math.abs(factor - 1) > 0.1) fail(`${s} scale factor ${factor.toFixed(4)} — live ${anchors[s]} vs close ${adj}; refusing`);

  const series = dates.map((d) => {
    const bar = byDate[s].get(d);
    if (!bar || !(bar.adjClose > 0)) fail(`${s} missing/invalid bar on ${d}`);
    return bar.adjClose * factor;
  });
  // Pin the final element to exactly what the gateway observed.
  series[series.length - 1] = anchors[s];

  // Sanity: no absurd single-day move (guards against a bad split adjustment).
  let maxMove = 0;
  for (let i = 1; i < series.length; i++) {
    maxMove = Math.max(maxMove, Math.abs((series[i] - series[i - 1]) / series[i - 1]));
  }
  if (maxMove > 0.5) fail(`${s} has a ${(maxMove * 100).toFixed(1)}% single-day move — suspect adjustment`);

  priceHistory[s] = series;
  report.push({ s, factor, maxMove, first: series[0], last: series[series.length - 1] });
}

// Final invariant check: every series is the same length as the date index.
for (const s of symbols) {
  if (priceHistory[s].length !== dates.length) fail(`${s} length ${priceHistory[s].length} != dates ${dates.length}`);
}

writeFileSync(outPath, JSON.stringify({ priceHistory, priceHistoryDates: dates }, null, 0));

console.log(`seed: ${symbols.length} symbols x ${dates.length} trading days  (${dates[0]} -> ${dates[dates.length - 1]})`);
console.log('symbol   scale     max 1d move   seeded first -> live last');
for (const r of report) {
  console.log(
    `  ${r.s.padEnd(6)} ${r.factor.toFixed(5)}   ${(r.maxMove * 100).toFixed(1).padStart(6)}%      ${r.first.toFixed(2).padStart(9)} -> ${r.last.toFixed(2)}`,
  );
}
console.log(`\nwritten to ${outPath}`);
