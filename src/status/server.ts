import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { loadState, loadTradeHistory } from '../state/store.js';
import { config, TARGET_PORTFOLIO } from '../config.js';
import { log } from '../log.js';

const startTime = Date.now();

function handler(_req: IncomingMessage, res: ServerResponse): void {
  const state = loadState();
  const trades = loadTradeHistory();

  const body = JSON.stringify({
    fund: 'IBKR Allocation Fund',
    mode: config.tradingMode,
    targets: TARGET_PORTFOLIO.map(t => ({ symbol: t.symbol, pct: t.pct, sleeve: t.sleeve })),
    portfolio: state.lastSnapshot || null,
    risk: state.lastRisk || null,
    pendingOrders: state.pendingOrders || [],
    lastCheckAt: state.lastCheckAt || null,
    lastRebalanceAt: state.lastRebalanceAt || null,
    lastResearchAt: state.lastResearchAt || null,
    recentTrades: trades.slice(-20),
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
  }, null, 2);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

export function startStatusServer(): void {
  const server = createServer(handler);
  server.listen(config.port, '0.0.0.0', () => {
    log(`Status server listening on :${config.port}`);
  });
}
