/**
 * Tax Optimizer
 * Prunes expired wash-sale entries. Tax-loss harvesting is DISABLED by
 * default (TAX_HARVESTING): it is US logic, see tax/harvesting.ts. Even when
 * on, it only reports candidates; nothing acts on them.
 */
import { connect, disconnect, getAccountSummary, getMarketPrices , requestDelayedData } from '../connection/gateway.js';
import { TARGET_PORTFOLIO } from '../config.js';
import { findHarvestCandidates, harvestingEnabled, WashSaleEntry, TaxLot } from '../tax/harvesting.js';
import { runLotEngine } from '../tax/lots.js';
import { loadState, mergeState, loadTradeHistory } from '../state/store.js';
import { log, logError } from '../log.js';

const AGENT = 'TaxOptimizer';

async function run(): Promise<void> {
  log('Tax optimization scan starting', AGENT);
  await connect();
  requestDelayedData();

  try {
    const state = loadState();
    const washSales = (state.washSales || []) as WashSaleEntry[];

    // Prune expired wash sale entries
    const now = new Date();
    const activeWashSales = washSales.filter(ws => new Date(ws.expiresAt) > now);
    if (activeWashSales.length < washSales.length) {
      log(`Pruned ${washSales.length - activeWashSales.length} expired wash sale entries`, AGENT);
    }

    if (!harvestingEnabled()) {
      log('Tax-loss harvesting is disabled (TAX_HARVESTING) — no candidates scanned', AGENT);
      mergeState({ washSales: activeWashSales, harvestCandidates: [], lastTaxScanAt: new Date().toISOString() });
      return;
    }

    const account = await getAccountSummary();
    const symbols = TARGET_PORTFOLIO.map(t => t.symbol);
    const prices = await getMarketPrices(symbols);

    // Parcels from the one lot engine: real acquisition dates and per-parcel
    // cost, not the position's blended average cost dated at its first buy.
    const engine = runLotEngine(loadTradeHistory());
    const lots: TaxLot[] = account.positions.flatMap(pos =>
      (engine.openLots.get(pos.symbol) ?? []).map(l => ({
        id: `${pos.symbol}-${l.buyTimestamp}`,
        symbol: pos.symbol,
        qty: l.qty,
        costBasis: l.costPerShareUsd,
        acquiredAt: l.buyTimestamp,
        currentPrice: prices.get(pos.symbol) || pos.marketPrice,
      })),
    );

    const candidates = findHarvestCandidates(lots, activeWashSales);

    if (candidates.length > 0) {
      log(`Found ${candidates.length} harvest candidate(s):`, AGENT);
      for (const c of candidates) {
        log(`  ${c.lot.symbol}: loss $${c.unrealizedLoss.toFixed(2)} (${c.isLongTerm ? 'LT' : 'ST'}) → swap to ${c.replacement}`, AGENT);
      }
      state.harvestCandidates = candidates.map(c => ({
        symbol: c.lot.symbol,
        loss: c.unrealizedLoss,
        replacement: c.replacement,
        isLongTerm: c.isLongTerm,
      }));
    } else {
      log('No tax-loss harvesting opportunities found', AGENT);
      state.harvestCandidates = [];
    }

    mergeState({
      washSales: activeWashSales,
      harvestCandidates: state.harvestCandidates,
      lastTaxScanAt: new Date().toISOString(),
    });

  } finally {
    disconnect();
  }
  log('Tax optimization scan complete', AGENT);
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}
