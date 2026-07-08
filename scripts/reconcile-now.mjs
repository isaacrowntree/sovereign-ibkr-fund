#!/usr/bin/env node
/**
 * One-off / manual ledger reconciliation: record any IBKR execution that the
 * bot's trade-history is missing (e.g. a fill the WS stream missed). Runs in
 * the container against the deployed dist. Idempotent by execId.
 *
 * Cost basis for SELLs: the bot's ledger has no opening lots (the account's
 * pre-existing positions were never recorded), so FIFO finds nothing. We fall
 * back to the IBKR position's avgCost for the symbol — correct for realised
 * P&L (avg cost per share is unchanged by a sale). Long-term (AU CGT) status
 * is left unset because the lot acquisition date isn't available here.
 */
import { getExecutions, getAccountSummary, connect, disconnect } from '../dist/connection/gateway.js';
import { loadTradeHistory, appendTrade, loadState, mergeState, closeDb } from '../dist/state/store.js';

await connect();
const execs = await getExecutions();
const acc = await getAccountSummary();
const avgCostBySymbol = new Map(acc.positions.map(p => [p.symbol, p.avgCost]));

const history = loadTradeHistory();
const seenExecIds = new Set(history.map(t => t.execId).filter(Boolean));

const added = [];
for (const e of execs) {
  if (e.execId && seenExecIds.has(e.execId)) continue;
  const rec = {
    timestamp: new Date().toISOString(),
    symbol: e.symbol,
    action: e.action,
    qty: e.qty,
    estimatedValue: e.qty * e.price,
    fillPrice: e.price,
    orderId: e.orderId ?? 0,
    status: 'filled',
    reason: 'reconciled_from_ibkr',
    execId: e.execId,
  };
  if (e.action === 'SELL') {
    const basis = avgCostBySymbol.get(e.symbol);
    if (basis != null) {
      rec.costBasisPrice = basis;
      rec.realisedPnlUsd = e.qty * (e.price - basis);
      // longTermHolding intentionally left unset — acquisition date unknown.
    }
  }
  appendTrade(rec);
  seenExecIds.add(e.execId);
  added.push(rec);
}

console.log(`Reconciled ${added.length} execution(s) into the ledger:`);
for (const r of added) {
  const pnl = r.realisedPnlUsd != null ? ` | cost $${r.costBasisPrice} P&L $${r.realisedPnlUsd.toFixed(2)}` : '';
  console.log(`  ${r.action} ${r.qty} ${r.symbol} @ $${r.fillPrice}${pnl} | execId ${r.execId}`);
}

// A live fill occurred, so validation is genuinely proven.
if (added.length > 0 && !loadState().liveExecutionValidatedAt) {
  mergeState({ liveExecutionValidatedAt: new Date().toISOString(), lastValidationFailure: null });
  console.log('Set liveExecutionValidatedAt (a live fill was confirmed against IBKR).');
}

console.log(`trade-history now has ${loadTradeHistory().length} record(s).`);
closeDb();
disconnect();
