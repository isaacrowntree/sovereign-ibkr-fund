/**
 * Tax Optimizer
 * Daily scan for tax-loss harvesting opportunities, manages wash sale restrictions.
 */
import { connect, disconnect, getAccountSummary, getMarketPrices , requestDelayedData } from '../connection/gateway.js';
import { TARGET_PORTFOLIO } from '../config.js';
import { findHarvestCandidates, createWashSaleEntry, WashSaleEntry, TaxLot } from '../tax/harvesting.js';
import { loadState, mergeState, loadTradeHistory } from '../state/store.js';
import { log, logError } from '../log.js';

const AGENT = 'TaxOptimizer';

async function run(): Promise<void> {
  log('Tax optimization scan starting', AGENT);
  await connect();
  requestDelayedData();

  try {
    const account = await getAccountSummary();
    const symbols = TARGET_PORTFOLIO.map(t => t.symbol);
    const prices = await getMarketPrices(symbols);

    const state = loadState();
    const washSales = (state.washSales || []) as WashSaleEntry[];

    // Prune expired wash sale entries
    const now = new Date();
    const activeWashSales = washSales.filter(ws => new Date(ws.expiresAt) > now);
    if (activeWashSales.length < washSales.length) {
      log(`Pruned ${washSales.length - activeWashSales.length} expired wash sale entries`, AGENT);
    }

    // Build tax lots from positions, using trade history for acquisition dates
    const tradeHistory = loadTradeHistory();
    const lots: TaxLot[] = account.positions.map(pos => {
      // Find earliest BUY for this symbol to get acquisition date (sorted FIFO)
      const earliestBuy = tradeHistory
        .filter(t => t.action === 'BUY' && t.symbol === pos.symbol)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())[0] ?? null;
      return {
        id: `${pos.symbol}-${pos.avgCost}`,
        symbol: pos.symbol,
        qty: pos.qty,
        costBasis: pos.avgCost,
        acquiredAt: earliestBuy?.timestamp ?? new Date().toISOString(),
        currentPrice: prices.get(pos.symbol) || pos.marketPrice,
      };
    });

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
