#!/usr/bin/env node
/**
 * Australian tax report for one financial year, from the ledger. Read-only.
 *
 *   node scripts/tax-report.mjs --fy FY2026
 *        [--carried-forward "Owner name=1234.56"]   (repeatable; from the lodged return)
 *        [--fx-fallback rba-f11.csv]                (RBA F11, only where IBKR gave no rate)
 *        [--no-dividends]                           (skip fetching dividends from IBKR)
 *        [--json]
 *
 * Owners come from TAX_OWNER_SHARES / TAX_ACCOUNT_REGISTRATION (see
 * src/tax/owners.ts). Dividends are fetched from IBKR at run time, like the
 * opening lots, so no holdings data is ever stored in this repo.
 *
 * If the report says trades have no AUD rate, run
 * `node scripts/seed-opening-lots.mjs --dry-run` then without --dry-run: it is
 * idempotent and annotates new trades with IBKR's rate.
 */
import { readFileSync } from 'node:fs';
import { connect, disconnect, getAccountSummary, resolveConid } from '../dist/connection/gateway.js';
import { fetchPaHistory } from '../dist/connection/ibkr-history.js';
import { loadTradeHistory, loadFxConversions, closeDb } from '../dist/state/store.js';
import { buildAuTaxReport, renderAuTaxReport } from '../dist/tax/report.js';
import { dividendsFromPa } from '../dist/tax/dividends.js';
import { ownersFromEnv } from '../dist/tax/owners.js';
import { parseF11Csv, f11Lookup } from '../dist/tax/rba-f11.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] ?? null; };
const all = (n) => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));

const JSON_OUT = args.includes('--json');
// Agent logging (e.g. "Connected to bezant-server") goes to stdout; keep it
// off the JSON so the output stays parseable.
if (JSON_OUT) console.log = (...a) => console.error(...a);

const fy = flag('--fy');
if (!fy || !/^FY\d{4}$/.test(fy)) { console.error('usage: --fy FY2026 [...]'); process.exit(2); }

const carriedForwardLossesAud = {};
for (const spec of all('--carried-forward')) {
  const at = spec.lastIndexOf('=');
  const v = Number(spec.slice(at + 1));
  if (at <= 0 || !Number.isFinite(v) || v < 0) { console.error(`bad --carried-forward ${spec}`); process.exit(2); }
  carriedForwardLossesAud[spec.slice(0, at).trim()] = v;
}

const f11 = flag('--fx-fallback');
const fxFallback = f11 ? f11Lookup(parseF11Csv(readFileSync(f11, 'utf8'))) : undefined;
const { owners, registration } = ownersFromEnv();
const trades = loadTradeHistory();

let dividends = [];
if (!args.includes('--no-dividends')) {
  await connect();
  const symbolByConid = new Map();
  for (const t of trades) if (t.conid) symbolByConid.set(Number(t.conid), t.symbol);
  const known = new Set(symbolByConid.values());
  for (const p of (await getAccountSummary()).positions) if (p.conid && !known.has(p.symbol)) symbolByConid.set(Number(p.conid), p.symbol);
  for (const s of new Set(trades.map((t) => t.symbol))) {
    if (![...symbolByConid.values()].includes(s)) symbolByConid.set(await resolveConid(s), s);
  }
  const history = await fetchPaHistory([...symbolByConid.keys()], { delayMs: parseInt(process.env.PA_DELAY_MS || '1000', 10) });
  dividends = dividendsFromPa([...history.values()].flatMap((h) => h.dividends), { symbols: symbolByConid });
  disconnect();
}

const report = buildAuTaxReport({
  trades,
  financialYear: fy,
  dividends,
  fxConversions: loadFxConversions(),
  owners,
  registration,
  carriedForwardLossesAud,
  fxFallback,
});
closeDb();

if (JSON_OUT) {
  // Records inside disposals are the full ledger rows; keep the export lean.
  const lean = { ...report, disposals: report.disposals.map(({ buyRecord, sellRecord, ...d }) => d) };
  process.stdout.write(JSON.stringify(lean, null, 2) + '\n');
} else {
  console.log(renderAuTaxReport(report));
}
// exitCode, not exit(): a large report piped to a file must finish flushing.
process.exitCode = report.complete ? 0 : 3;
