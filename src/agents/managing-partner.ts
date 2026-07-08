/**
 * Managing Partner (CEO)
 * Orchestrates the fund: checks portfolio, delegates to risk/strategy/execution.
 */
import { connect, disconnect, getAccountSummary, getMarketPrices, requestDelayedData } from '../connection/gateway.js';
import { TARGET_PORTFOLIO, validateTargets } from '../config.js';
import { loadState, mergeState } from '../state/store.js';
import { log, logError } from '../log.js';

const AGENT = 'ManagingPartner';

async function run(): Promise<void> {
  log('Fund oversight cycle starting', AGENT);
  validateTargets();
  await connect();
  requestDelayedData();

  try {
    const account = await getAccountSummary();
    log(`NAV: $${account.netLiquidation.toFixed(2)} | Cash: $${account.totalCashValue.toFixed(2)}`, AGENT);
    log(`Positions: ${account.positions.length}`, AGENT);

    const symbols = TARGET_PORTFOLIO.map(t => t.symbol);
    const prices = await getMarketPrices(symbols);

    for (const [sym, price] of prices) {
      log(`  ${sym}: $${price.toFixed(2)}`, AGENT);
    }

    const state = loadState();
    state.lastCheckAt = new Date().toISOString();
    state.lastNav = account.netLiquidation;
    state.lastCash = account.totalCashValue;

    // Risk status summary
    const stressTest = state.stressTest as {
      baselineVaR?: number; stressedVaR?: number; timestamp?: string;
    } | undefined;
    if (stressTest) {
      log(`Risk — Stress test (${stressTest.timestamp || 'unknown'}):`, AGENT);
      log(`  Baseline VaR: $${stressTest.baselineVaR?.toFixed(2) ?? 'N/A'} | Stressed VaR: $${stressTest.stressedVaR?.toFixed(2) ?? 'N/A'}`, AGENT);
    }

    const drawdownLevel = state.drawdownLevel as string | undefined;
    if (drawdownLevel) {
      log(`Risk — Drawdown level: ${drawdownLevel}`, AGENT);
    }

    // Factor attribution summary
    const factorRegression = state.factorRegression as {
      dependent?: string; rSquared?: number; alpha?: number; factors?: string[]; betas?: number[];
    } | undefined;
    if (factorRegression) {
      log(`Quant — Factor model R²: ${((factorRegression.rSquared ?? 0) * 100).toFixed(1)}% | Alpha: ${((factorRegression.alpha ?? 0) * 10000).toFixed(2)} bps/day`, AGENT);
    }

    // Execution quality summary
    const shortfallMetrics = state.shortfallMetrics as {
      symbol: string; totalShortfallBps: number; totalShortfallUsd: number;
    }[] | undefined;
    if (shortfallMetrics && shortfallMetrics.length > 0) {
      const avgBps = shortfallMetrics.reduce((s, m) => s + m.totalShortfallBps, 0) / shortfallMetrics.length;
      const totalUsd = shortfallMetrics.reduce((s, m) => s + m.totalShortfallUsd, 0);
      log(`Execution — Avg shortfall: ${avgBps.toFixed(1)} bps | Total cost: $${totalUsd.toFixed(2)} (${shortfallMetrics.length} fills)`, AGENT);
    }

    // Build snapshot for the dashboard
    const snapshot = {
      netLiquidation: account.netLiquidation,
      cashValue: account.totalCashValue,
      holdings: TARGET_PORTFOLIO.map(t => {
        const pos = account.positions.find((p: { symbol: string }) => p.symbol === t.symbol);
        const price = prices.get(t.symbol) || 0;
        const currentValue = pos ? pos.qty * price : 0;
        const currentPct = account.netLiquidation > 0 ? (currentValue / account.netLiquidation) * 100 : 0;
        return {
          symbol: t.symbol, sleeve: t.sleeve, targetPct: t.pct,
          currentPct: Math.round(currentPct * 10) / 10,
          currentValue: Math.round(currentValue * 100) / 100,
        };
      }),
    };

    mergeState({
      lastCheckAt: state.lastCheckAt,
      lastNav: state.lastNav,
      lastCash: state.lastCash,
      lastSnapshot: snapshot,
    });

    log('Delegating to Portfolio Strategist, Risk Manager, and Research Scout', AGENT);
  } finally {
    disconnect();
  }
  log('Fund oversight cycle complete', AGENT);
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}
