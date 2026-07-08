/**
 * Hedger
 * Manages options overlay: covered calls, protective puts, collars, tail risk.
 */
import { connect, disconnect, getAccountSummary, getMarketPrices , requestDelayedData } from '../connection/gateway.js';
import { TARGET_PORTFOLIO } from '../config.js';
import { generateCoveredCall, generateProtectivePut, tailRiskPutBudget, CoveredCallParams } from '../hedging/options.js';
import { loadState, mergeState } from '../state/store.js';
import { log, logError } from '../log.js';

const AGENT = 'Hedger';
const IMPLIED_VOL = 0.20; // default, would come from options chain data

async function run(): Promise<void> {
  log('Hedge analysis starting', AGENT);
  await connect();
  requestDelayedData();

  try {
    const account = await getAccountSummary();
    const symbols = TARGET_PORTFOLIO.map(t => t.symbol);
    const prices = await getMarketPrices(symbols);

    log(`NAV: $${account.netLiquidation.toFixed(2)}`, AGENT);

    const state = loadState();
    const regime = state.regime as { composite: string } | null;
    const hedgeActions: unknown[] = [];

    // Covered call opportunities (income generation in neutral/risk-on regimes)
    if (!regime || regime.composite === 'risk_on' || regime.composite === 'neutral') {
      for (const pos of account.positions) {
        if (pos.qty >= 100) {
          const price = prices.get(pos.symbol) || pos.marketPrice;
          const cc = generateCoveredCall({
            symbol: pos.symbol, sharesHeld: pos.qty, currentPrice: price,
            targetDelta: 0.25, minDTE: 30, maxDTE: 45, coveragePct: 0.5,
          }, IMPLIED_VOL);

          if (cc) {
            log(`Covered call: SELL ${cc.qty} ${cc.symbol} ${cc.strike} call exp ${cc.expiry}`, AGENT);
            hedgeActions.push({ hedgeType: 'covered_call', ...cc });
          }
        }
      }
    }

    // Protective puts in risk-off/crisis regimes
    if (regime && (regime.composite === 'risk_off' || regime.composite === 'crisis')) {
      const budget = tailRiskPutBudget(account.netLiquidation, 0.01);
      log(`Tail risk budget: $${budget.toFixed(2)}`, AGENT);

      for (const pos of account.positions) {
        if (pos.qty >= 100) {
          const price = prices.get(pos.symbol) || pos.marketPrice;
          const pp = generateProtectivePut({
            symbol: pos.symbol, sharesHeld: pos.qty, currentPrice: price,
            targetDelta: -0.25, maxCostPct: 0.01, minDTE: 60, maxDTE: 90,
          }, IMPLIED_VOL);

          if (pp) {
            log(`Protective put: BUY ${pp.qty} ${pp.symbol} ${pp.strike} put exp ${pp.expiry}`, AGENT);
            hedgeActions.push({ hedgeType: 'protective_put', ...pp });
          }
        }
      }
    }

    if (hedgeActions.length === 0) {
      log('No hedge actions required', AGENT);
    }

    mergeState({
      hedgeActions,
      lastHedgeAt: new Date().toISOString(),
    });

  } finally {
    disconnect();
  }
  log('Hedge analysis complete', AGENT);
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}
