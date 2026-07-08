/**
 * Research Scout
 * Market scanning, price monitoring, significant move detection.
 */
import { connect, disconnect, getMarketPrices , requestDelayedData } from '../connection/gateway.js';
import { TARGET_PORTFOLIO } from '../config.js';
import { loadState, mergeState } from '../state/store.js';
import { log, logError } from '../log.js';

const AGENT = 'ResearchScout';
const MOVE_THRESHOLD = 2; // alert on >2% moves

interface PriceSnapshot {
  symbol: string;
  price: number;
  timestamp: string;
}

async function run(): Promise<void> {
  log('Market scan starting', AGENT);
  await connect();
  requestDelayedData();

  try {
    const symbols = TARGET_PORTFOLIO.map(t => t.symbol);
    const prices = await getMarketPrices(symbols);

    const state = loadState();
    const prevSnapshots = (state.lastPriceSnapshots || []) as PriceSnapshot[];
    const newSnapshots: PriceSnapshot[] = [];
    const alerts: string[] = [];

    for (const [sym, price] of prices) {
      const target = TARGET_PORTFOLIO.find(t => t.symbol === sym);
      const prev = prevSnapshots.find(s => s.symbol === sym);
      let changeStr = '';

      if (prev && prev.price > 0) {
        const pct = ((price - prev.price) / prev.price) * 100;
        changeStr = ` (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`;
        if (Math.abs(pct) > MOVE_THRESHOLD) {
          const alert = `${sym} moved ${pct > 0 ? '+' : ''}${pct.toFixed(2)}% — significant`;
          alerts.push(alert);
          log(`  ALERT: ${alert}`, AGENT);
        }
      }

      log(`  ${sym} [${target?.sleeve}]: $${price.toFixed(2)}${changeStr}`, AGENT);
      newSnapshots.push({ symbol: sym, price, timestamp: new Date().toISOString() });
    }

    if (alerts.length === 0) {
      log('No significant moves detected', AGENT);
    }

    mergeState({
      lastPriceSnapshots: newSnapshots,
      marketAlerts: alerts,
      lastResearchAt: new Date().toISOString(),
    });

  } finally {
    disconnect();
  }
  log('Market scan complete', AGENT);
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}
