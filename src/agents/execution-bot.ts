/**
 * Execution Bot
 * Executes pending orders using IBKR algo order types (Adaptive, TWAP, VWAP).
 *
 * The staged-execution orchestration (validation-first, confirm-gated,
 * halt-on-uncertainty, cash-gated buys) lives in execution/executor.ts
 * where it is unit-tested with fake collaborators. This agent owns the
 * environment: the state file, the trading-window gate, the gateway
 * connection, and how each execution strategy maps onto CPAPI order
 * placement.
 */
import {
  connect,
  disconnect,
  getUsdBalances,
  cancelOrder,
  getLiveOrders,
  getExecutions,
  getAccountSummary,
  placeMarketOrder,
  placeAdaptiveOrder,
  placeMidpriceOrder,
  type TradeResult,
  type AdaptivePriority,
} from '../connection/gateway.js';
import { executeQueue, type ExecutorDeps } from '../execution/executor.js';
import { reconcileExecutions } from '../execution/reconcile.js';
import type { StagedOrder } from '../execution/staging.js';
import type { AlgoPriority, ExecutionPlan as AlgoPlan } from '../execution/algo-orders.js';
import { isExecutionWindow, describeWindow, EXECUTION_WINDOW } from '../strategy/market-hours.js';
import { confirmFill } from '../observability/fill-confirmer.js';
import { loadState, mergeState, appendTrade, loadTradeHistory } from '../state/store.js';
import type { WashSaleEntry } from '../tax/harvesting.js';
import { alert } from '../notify/slack.js';
import { config } from '../config.js';
import { log, logError } from '../log.js';

const AGENT = 'ExecutionBot';

/**
 * Risk data older than this means the risk-manager hasn't run / has errored;
 * execution refuses to trade ungated rather than trust a stale drawdown level.
 * Set above the risk-manager's ~4h heartbeat cadence (+1h margin) so it only
 * trips when risk-manager has genuinely missed a cycle, not in the normal gap
 * between runs. The drawdown level is slow-moving and the intraday WS
 * enrichment catches sharp intraday drops, so ≤5h-old risk data is safe.
 */
const RISK_STALE_MS = 5 * 60 * 60 * 1000;

/**
 * A run holds the queue in memory and only writes back at the end, so two
 * overlapping runs would double-place. Paperclip already serialises heartbeat
 * runs per agent; this state-file lock is defence-in-depth against a manual
 * invocation overlapping a scheduled run. Considered stale after this long
 * (longer than the worst-case run of 10 Patient confirmations).
 */
const RUN_LOCK_STALE_MS = 35 * 60 * 1000;

interface RunLock {
  at: string;
  pid: number;
}

async function placeOrder(
  order: StagedOrder,
  strategy: AlgoPlan['strategy'],
  urgency: AlgoPriority,
): Promise<TradeResult> {
  // Wire the execution strategy. CPAPI passthrough doesn't have a tested
  // TWAP/VWAP path, so those route to Adaptive(Patient) which gives a
  // similar slippage profile for retail-size orders. MIDPRICE is currently
  // unused by selectExecutionStrategy but available for future tuning when
  // we want to be very passive.
  switch (strategy) {
    case 'adaptive':
      return placeAdaptiveOrder(order.symbol, order.action, order.qty, urgency as AdaptivePriority);
    case 'twap':
    case 'vwap':
      log(`${strategy.toUpperCase()} not yet wired in CPAPI passthrough — using Adaptive(Patient) instead`, AGENT);
      return placeAdaptiveOrder(order.symbol, order.action, order.qty, 'Patient');
    case 'limit':
      return placeMidpriceOrder(order.symbol, order.action, order.qty);
    case 'market':
    default:
      return placeMarketOrder(order.symbol, order.action, order.qty);
  }
}

async function run(): Promise<void> {
  log('Execution check starting', AGENT);

  const state = loadState();
  const pendingOrders = (state.pendingOrders || []) as StagedOrder[];

  if (pendingOrders.length === 0) {
    log('No pending orders', AGENT);
    return;
  }

  // Trading window: skip the first 30 min after open (high volatility, wide
  // spreads, overnight-gap risk) and last 15 min before close (close-auction
  // MOC flow distorts price). 10:00 AM – 3:45 PM ET, weekdays — the slippage
  // sweet spot for retail-size orders. Outside this window, bail without
  // touching the queue; orders carry to the next session.
  if (!isExecutionWindow()) {
    log(
      `${pendingOrders.length} pending order(s) but outside execution window ` +
        `(${describeWindow(EXECUTION_WINDOW)}) — deferring to next session`,
      AGENT,
    );
    return;
  }

  // Defence-in-depth run lock: refuse to start if another run is holding the
  // lock and it isn't stale.
  const existingLock = state.executionRunLock as RunLock | undefined;
  if (existingLock && Date.now() - new Date(existingLock.at).getTime() < RUN_LOCK_STALE_MS) {
    log(
      `Another execution run holds the lock (pid ${existingLock.pid}, since ${existingLock.at}) — skipping to avoid double-execution`,
      AGENT,
    );
    return;
  }
  mergeState({ executionRunLock: { at: new Date().toISOString(), pid: process.pid } satisfies RunLock });

  // Floor for fill-confirmation event matching: only consider order events
  // at/after the cursor the observer has already reached, so a recycled
  // orderId can't match stale history from a previous session.
  const ordersCursorFloor =
    (state.observerCursors as { orders?: { cursor?: number } } | undefined)?.orders?.cursor ?? 0;

  log(`${pendingOrders.length} pending order(s)`, AGENT);

  // connect() is INSIDE the try so a connect failure still hits the finally
  // and releases the run lock — otherwise a transient connect throw would
  // leak the lock and wedge all execution for RUN_LOCK_STALE_MS.
  let connected = false;
  try {
    await connect();
    connected = true;

    // Reconcile the ledger against IBKR's authoritative executions BEFORE
    // executing — captures any fill the WS stream missed on a prior run so
    // FIFO cost basis / wash-sale windows don't silently diverge, and so
    // positions reflect it. Best-effort: a reconcile failure must not block
    // trading.
    try {
      const execs = await getExecutions();
      const backfill = reconcileExecutions(loadTradeHistory(), execs);
      for (const t of backfill) appendTrade(t);
      if (backfill.length > 0) {
        log(`Reconciled ${backfill.length} IBKR execution(s) missing from the ledger: ${backfill.map(t => `${t.action} ${t.qty} ${t.symbol}`).join(', ')}`, AGENT);
        await alert(`IBKR fund: reconciled ${backfill.length} missing fill(s) from IBKR into the ledger`);
      }
    } catch (err) {
      logError('Execution reconciliation failed (continuing)', err, AGENT);
    }

    // Enforce the risk-manager's drawdown level — FAIL SAFE. If risk data is
    // missing or stale (risk-manager hasn't run / errored), do NOT trade
    // ungated; block and alert. On a hard stop, block AND clear the pending
    // queue so a pre-drawdown queue can't fire when the level later relaxes.
    const drawdownLevel = state.drawdownLevel as string | undefined;
    const lastRiskAt = state.lastRiskAt as string | undefined;
    const riskStale = !lastRiskAt || Date.now() - new Date(lastRiskAt).getTime() > RISK_STALE_MS;
    if (!drawdownLevel || riskStale) {
      log(`BLOCKED: risk data missing/stale (level=${drawdownLevel ?? 'unset'}, lastRiskAt=${lastRiskAt ?? 'never'}) — refusing to execute ungated`, AGENT);
      await alert(`IBKR fund: execution blocked — risk assessment missing/stale (${lastRiskAt ?? 'never'}); not trading ungated`);
      return;
    }
    if (drawdownLevel === 'stopped') {
      log('BLOCKED: Drawdown level is STOPPED — clearing pending queue, refusing to execute', AGENT);
      // Clear before alerting: a throw in the notifier must not leave a
      // pre-drawdown queue intact to fire once the level relaxes.
      mergeState({ pendingOrders: [] });
      await alert('🚨 IBKR fund: drawdown STOPPED — execution blocked, pending queue cleared for manual review');
      return;
    }

    const validated = Boolean(state.liveExecutionValidatedAt);

    // USD balances: the account is AUD-base, but US-stock orders are USD, so
    // gate and size against USD figures (see getUsdBalances / risk register).
    const startBalances = await getUsdBalances();

    const deps: ExecutorDeps = {
      placeOrder,
      confirmFill: (orderId, opts) => confirmFill(orderId, opts),
      // Fresh USD cash each call — invoked after the sells so their (unsettled)
      // proceeds are counted.
      getUsdCash: async () => (await getUsdBalances()).usdCash,
      cancelOrder: (orderId) => cancelOrder(orderId),
      // Idempotency source: never place a duplicate for a symbol+side already
      // working at IBKR.
      getLiveOrders: () => getLiveOrders(),
      // Authoritative executions — verifies a fill the WS stream missed so it's
      // never lost. Avg costs — fallback cost basis for sells with no FIFO lot.
      getExecutions: () => getExecutions(),
      getAvgCosts: async () => new Map((await getAccountSummary()).positions.map(p => [p.symbol, p.avgCost])),
      // Incremental queue persistence: shrink pendingOrders on disk as each
      // order completes, so a crash mid-run can't replay filled orders.
      persistRemaining: (orders) => mergeState({ pendingOrders: orders }),
      loadTradeHistory,
      appendTrade,
      isWindowOpen: isExecutionWindow,
      log: (msg) => log(msg, AGENT),
      logError: (msg, err) => logError(msg, err, AGENT),
    };

    const outcome = await executeQueue(
      pendingOrders,
      {
        validated,
        nav: startBalances.usdNav || 100000,
        regime: (state.regime as { composite: string } | null)?.composite || 'neutral',
        // Fill confirmation via the WS event stream is the default — the
        // synchronous response only proves acceptance, not fills. Set
        // FILL_CONFIRMATION_ENABLED=0 to trust acceptance (never during
        // validation, which the executor forces on).
        fillConfirmationEnabled: (process.env.FILL_CONFIRMATION_ENABLED ?? '1') !== '0',
        cashHeadroomPct: config.execution.cashHeadroomPct,
        ordersCursorFloor,
        caps: {
          maxOrderNotionalUsd: config.execution.maxOrderNotionalUsd,
          maxOrderPctNav: config.execution.maxOrderPctNav,
          maxRunNotionalUsd: config.execution.maxRunNotionalUsd,
        },
      },
      deps,
    );

    const updates: Record<string, unknown> = {
      lastExecutionAt: new Date().toISOString(),
    };

    // The executor persisted `remaining` incrementally as it went (via
    // persistRemaining), and that queue NEVER contains an order it executed,
    // so it is authoritative — even against a strategist that regenerated the
    // queue mid-run. Write it once more to settle the final state. A duplicate
    // from a stale strategist queue is caught next run by the idempotency
    // guard (working orders) and by positions reflecting the fills.
    updates.pendingOrders = outcome.requeue;
    if (!validated && outcome.confirmedFill) {
      updates.liveExecutionValidatedAt = new Date().toISOString();
      updates.lastValidationFailure = null;
      log('Live execution VALIDATED — full queue unlocks from the next run', AGENT);
    } else if (outcome.validationFailed) {
      updates.lastValidationFailure = {
        at: new Date().toISOString(),
        reason: outcome.haltReason || 'no confirmed fill observed',
      };
      log(`Validation NOT passed (${outcome.haltReason || 'no confirmed fill'}) — queue stays locked`, AGENT);
      await alert(`⚠️ IBKR fund: validation trade did NOT pass (${outcome.haltReason || 'no confirmed fill'}). Queue stays locked.`);
    }
    // Alert on any early halt (rejection, cap breach, timeout, guard failure) —
    // a real-money run that stopped abnormally should not be silent.
    if (outcome.halted && !outcome.validationFailed) {
      await alert(`⚠️ IBKR fund: execution run halted early — ${outcome.haltReason}. ${outcome.executed.length} order(s) executed, ${outcome.requeue.length} queued.`);
    }
    if (outcome.shortfalls.length > 0) {
      updates.shortfallMetrics = outcome.shortfalls;
    }
    if (outcome.washSales.length > 0) {
      const prior = (state.washSales as WashSaleEntry[] | undefined) ?? [];
      const now = new Date();
      const stillActive = prior.filter(w => new Date(w.expiresAt) > now);
      const merged = new Map<string, WashSaleEntry>();
      for (const w of [...stillActive, ...outcome.washSales]) {
        const existing = merged.get(w.symbol);
        if (!existing || new Date(w.expiresAt) > new Date(existing.expiresAt)) {
          merged.set(w.symbol, w);
        }
      }
      updates.washSales = Array.from(merged.values());
    }
    mergeState(updates);
    log('Execution complete', AGENT);

  } finally {
    if (connected) disconnect();
    // Always release the run lock — even if connect() threw — so the next
    // scheduled run can proceed.
    mergeState({ executionRunLock: null });
  }
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}
