import 'dotenv/config';

// Model portfolio now lives in src/portfolios (sample default, gitignored
// `local.ts` private override). Re-exported here so existing importers of
// `../config.js` keep working unchanged.
export type { HoldingTarget } from './portfolios/index.js';
export { TARGET_PORTFOLIO, validateTargets } from './portfolios/index.js';

export const config = {
  /**
   * Base URL of the `bezant-server` HTTP sidecar fronting the IBKR Client
   * Portal Gateway. Defaults to the local Docker compose URL; override with
   * `BEZANT_URL` to point at Railway / staging.
   */
  bezant: {
    url: (process.env.BEZANT_URL || 'http://localhost:8080').replace(/\/$/, ''),
    /** Optional explicit account override; defaults to the first one /accounts returns. */
    accountId: process.env.IBKR_ACCOUNT_ID || undefined,
    /** HTTP request timeout (ms) for individual bezant-server calls. */
    timeoutMs: parseInt(process.env.BEZANT_TIMEOUT_MS || '30000', 10),
    /**
     * Cloudflare Access service-token credentials for reaching a
     * bezant-server published behind a Zero Trust app (the residential-Pi
     * deploy pattern that bypasses IBKR's datacenter-IP rejection). Both
     * must be set or neither — partial config attaches no headers.
     */
    cfAccessClientId: process.env.BEZANT_CF_ACCESS_CLIENT_ID || undefined,
    cfAccessClientSecret: process.env.BEZANT_CF_ACCESS_CLIENT_SECRET || undefined,
  },
  /** Legacy TWS settings — still consumed by tooling we haven't migrated yet. */
  ib: {
    host: process.env.IB_HOST || '127.0.0.1',
    port: parseInt(process.env.IB_PORT || '4002', 10),
    clientId: parseInt(process.env.IB_CLIENT_ID || String(Math.floor(Math.random() * 900) + 100), 10),
  },
  tradingMode: (process.env.TRADING_MODE || 'paper') as 'paper' | 'live',
  rebalance: {
    driftThreshold: parseFloat(process.env.REBALANCE_DRIFT_THRESHOLD || '10'),
    /**
     * Single-name urgent rebalance threshold. If any one symbol drifts past
     * this percentage from its target, the strategist generates orders for
     * that name *now*, bypassing the regular `frequencyDays` cooldown. The
     * full-portfolio rebalance still uses `driftThreshold` + `frequencyDays`.
     */
    urgentDriftThreshold: parseFloat(process.env.REBALANCE_URGENT_DRIFT_THRESHOLD || '25'),
    minTradeUsd: parseFloat(process.env.REBALANCE_MIN_TRADE_USD || '50'),
    frequencyDays: parseInt(process.env.REBALANCE_FREQ_DAYS || '45', 10),
    /**
     * Reserve this percentage of NAV as cash, so target weights effectively
     * sum to (100 - cashBufferPct). Prevents the cash-aware buy-scaling gate
     * from firing on every cycle just because we sit at $36 of cash with
     * 100%-invested targets.
     */
    cashBufferPct: parseFloat(process.env.REBALANCE_CASH_BUFFER_PCT || '1.0'),
    /**
     * Fill mode when buy notional exceeds available cash:
     *   'greedy' — sort by drift desc, fully fill largest gaps first, drop
     *     the lowest-priority buys when cash runs out. Decisive — moves the
     *     portfolio meaningfully toward target each cycle.
     *   'proportional' — scale every buy by the same factor. Preserves
     *     relative weights but leaves the portfolio uniformly underweight.
     */
    fillMode: (process.env.REBALANCE_FILL_MODE || 'greedy') as 'greedy' | 'proportional',
  },
  execution: {
    /**
     * Headroom applied to a BUY's estimated cost at the execution-time
     * cash gate (estimates are from queue-generation time and prices
     * drift). A buy executes only if `estimatedValue * (1 + pct/100)`
     * fits in current account cash; otherwise it stays queued.
     */
    cashHeadroomPct: parseFloat(process.env.EXECUTION_CASH_HEADROOM_PCT || '2'),
    /**
     * Absolute backstop caps on order notional, independent of the
     * percentage-of-NAV sizing logic. A single order whose USD notional
     * exceeds `maxOrderNotionalUsd` OR `maxOrderPctNav`% of NAV is rejected
     * at the executor — a last "this cannot be right" gate against a bad
     * market-data tick or a mis-sized queue. Also caps total per-run notional.
     */
    maxOrderNotionalUsd: parseFloat(process.env.MAX_ORDER_NOTIONAL_USD || '15000'),
    maxOrderPctNav: parseFloat(process.env.MAX_ORDER_PCT_NAV || '50'),
    maxRunNotionalUsd: parseFloat(process.env.MAX_RUN_NOTIONAL_USD || '60000'),
  },
  /**
   * Sanity bounds on market data before the strategist will generate orders.
   * Guards against a bezant read that returns a zeroed/garbled USD NAV (which
   * would size every target to a tiny NAV and queue a full liquidation) or
   * missing/zero prices (which distort drift).
   */
  dataSanity: {
    /** Reject NAV reads at or below this (a real NAV is never ~0). */
    minNavUsd: parseFloat(process.env.MIN_NAV_USD || '1000'),
    /**
     * If NAV moved more than this % vs the last persisted NAV with no known
     * cash flow, treat the read as suspect and skip order generation.
     */
    maxNavMovePct: parseFloat(process.env.MAX_NAV_MOVE_PCT || '35'),
    /**
     * If a symbol's fetched price is ≤ 0 or moved more than this % vs its last
     * known price, the tick is suspect — skip order generation for the cycle
     * rather than size against a garbled price (guards the 100x-low tick that
     * would generate a huge share quantity).
     */
    maxPriceMovePct: parseFloat(process.env.MAX_PRICE_MOVE_PCT || '30'),
  },
  risk: {
    targetVol: parseFloat(process.env.TARGET_VOL || '0.20'),
    maxLeverage: parseFloat(process.env.MAX_LEVERAGE || '1.0'),
    drawdownWarningPct: parseFloat(process.env.DD_WARNING || '7'),
    drawdownDeriskPct: parseFloat(process.env.DD_DERISK || '15'),
    drawdownHardStopPct: parseFloat(process.env.DD_HARD_STOP || '25'),
  },
  strategy: {
    optimizer: (process.env.OPTIMIZER || 'hrp') as 'hrp' | 'black_litterman' | 'equal_weight',
    lookbackDays: parseInt(process.env.LOOKBACK_DAYS || '180', 10),
    enableRegimeOverlay: process.env.ENABLE_REGIME !== 'false',
    enableVolTargeting: process.env.ENABLE_VOL_TARGET !== 'false',
  },
  port: parseInt(process.env.PORT || '3001', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
};
