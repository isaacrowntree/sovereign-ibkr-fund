/**
 * Order-queue executor: the staged-execution orchestration extracted
 * from execution-bot so every failure path is unit-testable with fake
 * collaborators. execution-bot owns the environment (state file, window
 * gate, gateway connection, logging targets) and delegates the actual
 * walk of the queue — placement, confirmation, halting, requeueing,
 * cash gating, trade/tax records — to `executeQueue`.
 *
 * Invariants the tests pin down:
 *   - SELLs place before BUYs; account cash is fetched after the sells
 *     so proceeds fund the buys (cash account).
 *   - Validation mode (`ctx.validated === false`) places exactly one
 *     probe order and demands a confirmed fill before anything else.
 *   - A rejected / cancelled order is dropped (retrying verbatim just
 *     rejects again) and halts the run.
 *   - A confirmation timeout is NOT requeued — the order may still be
 *     working at IBKR, and a requeue would double-trade. The strategist
 *     rebuilds the queue from live positions, which reconciles it.
 *   - A failed submission IS requeued (nothing reached IBKR) but still
 *     halts the run.
 *   - Once halted, no further order is placed; the untouched remainder
 *     requeues verbatim.
 */
import type { TradeResult } from '../connection/gateway.js';
import type { FillConfirmation } from '../observability/fill-confirmer.js';
import type { TradeRecord } from '../state/store.js';
import { createWashSaleEntry, type WashSaleEntry } from '../tax/harvesting.js';
import { matchSellFifo } from '../tax/fifo.js';
import { computeShortfall, type ShortfallResult } from './shortfall.js';
import { selectExecutionStrategy, selectUrgency, type AlgoPriority, type ExecutionPlan as AlgoPlan } from './algo-orders.js';
import { planExecution, gateBuysByCash, type StagedOrder } from './staging.js';
import { orderCapViolation, type NotionalCaps } from '../risk/data-sanity.js';

export interface ExecutorContext {
  /** Has a live fill ever been confirmed? False → validation mode. */
  validated: boolean;
  /** Total portfolio NAV in USD (order values are USD → keep the same unit). */
  nav: number;
  regime: string;
  /**
   * Env-level fill-confirmation switch. Ignored (forced on) in
   * validation mode — validation exists to observe a real fill.
   */
  fillConfirmationEnabled: boolean;
  /** Headroom % applied to buy estimates at the cash gate. */
  cashHeadroomPct: number;
  /**
   * Floor cursor for order-event confirmation: confirmFill only considers
   * events at/after this cursor, so a recycled orderId can't match a stale
   * event from before this run. Captured at run start.
   */
  ordersCursorFloor?: number;
  /**
   * Absolute notional caps — a last backstop against an implausibly large
   * order (bad data / mis-sized queue). When present, an order or run that
   * breaches them halts the run. Omit to disable (tests).
   */
  caps?: NotionalCaps;
}

export interface ExecutorDeps {
  /** Place the order using the given strategy/urgency; returns acceptance. */
  placeOrder(
    order: StagedOrder,
    strategy: AlgoPlan['strategy'],
    urgency: AlgoPriority,
  ): Promise<TradeResult>;
  /** Wait for the order's terminal state on the event stream. */
  confirmFill(
    orderId: number,
    opts: { targetQty: number; timeoutMs: number; fromCursor?: number },
  ): Promise<FillConfirmation>;
  /**
   * USD cash available for USD buys (incl. unsettled sale proceeds), fetched
   * after the sells so their proceeds count. NOT the base-currency total.
   */
  getUsdCash(): Promise<number>;
  /**
   * Cancel a working order whose fill state we couldn't confirm, so the
   * strategist doesn't regenerate and double it. Optional/best-effort.
   */
  cancelOrder?(orderId: number): Promise<void>;
  /**
   * IBKR's authoritative executions. Consulted when WS fill-confirmation
   * fails/times out — the fill may actually have happened (as it did when a
   * competing IBKR web login de-authed the event stream mid-order). Prevents a
   * real fill from being silently dropped/unrecorded.
   */
  getExecutions?(): Promise<Array<{ execId: string; symbol: string; action: 'BUY' | 'SELL'; qty: number; price: number; orderId?: number }>>;
  /**
   * Per-symbol average cost from IBKR positions. Fallback cost basis for a
   * SELL when the ledger has no FIFO lots (the account's opening positions
   * predate the bot's trade history).
   */
  getAvgCosts?(): Promise<Map<string, number>>;
  /**
   * Orders already working at IBKR (fetched once at run start). Used to skip
   * placing a duplicate for a symbol+side that already has a live order — the
   * central guard against cross-run duplicates. Optional: absent → no guard.
   */
  getLiveOrders?(): Promise<Array<{ symbol: string; action: 'BUY' | 'SELL'; status: string }>>;
  /**
   * Persist the still-to-do queue after every terminal order outcome, so a
   * crash/kill/exception mid-run leaves only UNEXECUTED orders on disk instead
   * of replaying already-filled ones. Optional (tests may omit).
   */
  persistRemaining?(orders: StagedOrder[]): void;
  loadTradeHistory(): TradeRecord[];
  appendTrade(trade: TradeRecord): void;
  /**
   * Is the trading window still open? Re-checked before every placement
   * so a long run (10 orders x up to 180s Patient confirmation each can
   * exceed 25 min) doesn't keep firing orders past the close. Optional:
   * when absent the window is treated as always open (tests, backfills).
   */
  isWindowOpen?(): boolean;
  log(message: string): void;
  logError(message: string, err: unknown): void;
}

export interface ExecutionOutcome {
  mode: 'validate' | 'normal';
  /** Orders that should remain in the pending queue (never includes executed ones). */
  requeue: StagedOrder[];
  /** Orders this run actually executed (qty = filled qty). For reconciliation. */
  executed: StagedOrder[];
  halted: boolean;
  haltReason: string;
  /** At least one fill was confirmed (or acceptance-trusted on opt-out). */
  confirmedFill: boolean;
  /** True when a validation run ended without a confirmed fill. */
  validationFailed: boolean;
  shortfalls: ShortfallResult[];
  washSales: WashSaleEntry[];
}

/** CPAPI order statuses that mean the order is no longer working. */
const TERMINAL_ORDER_STATUSES = new Set(['filled', 'cancelled', 'inactive', 'rejected']);

/** Is a live order still working (could still fill) vs terminal? */
function isWorkingOrder(status: string): boolean {
  const s = status.toLowerCase().replace(/[^a-z]/g, '');
  return !TERMINAL_ORDER_STATUSES.has(s);
}

export async function executeQueue(
  pending: StagedOrder[],
  ctx: ExecutorContext,
  deps: ExecutorDeps,
): Promise<ExecutionOutcome> {
  const plan = planExecution(pending, ctx.validated);
  const useFillConfirmer = plan.mode === 'validate' || ctx.fillConfirmationEnabled;

  if (plan.mode === 'validate' && plan.orders.length > 0) {
    const probe = plan.orders[0];
    deps.log(
      `First live session — validation trade only: ${probe.action} ${probe.qty} ` +
        `${probe.symbol} (~$${probe.estimatedValue.toFixed(0)}); ${plan.deferred.length} ` +
        `order(s) stay queued until a confirmed fill unlocks them`,
    );
  }

  const sells = plan.orders.filter(o => o.action === 'SELL');
  const buys = plan.orders.filter(o => o.action === 'BUY');
  const shortfalls: ShortfallResult[] = [];
  const washSales: WashSaleEntry[] = [];
  const executed: StagedOrder[] = [];
  let confirmedFill = false;
  let halted = false;
  let haltReason = '';
  let runNotional = 0; // cumulative USD notional placed this run (for the per-run cap)
  let avgCosts = new Map<string, number>(); // per-symbol avg cost, fetched at run start

  // Orders still to do (not yet terminally handled). Persisted after every
  // change, so a crash / kill / deploy / uncaught throw mid-run leaves ONLY
  // unexecuted orders on disk — the queue can no longer replay already-filled
  // orders on the next run. Starts as everything; shrinks as orders complete.
  let remaining: StagedOrder[] = [...plan.orders, ...plan.deferred];
  const persist = () => {
    try {
      deps.persistRemaining?.(remaining);
    } catch (e) {
      // A failed persist means disk is now stale — a crash would replay the
      // orders we can't shrink. Stop placing further orders; better to leave
      // the queue for the next run than to keep executing untracked.
      deps.logError('persistRemaining failed — halting to avoid replaying orders on a crash', e);
      halted = true;
      haltReason = 'persistRemaining failed';
    }
  };
  const drop = (order: StagedOrder) => {
    remaining = remaining.filter(o => o !== order);
    persist();
  };
  const replaceWith = (order: StagedOrder, repl: StagedOrder) => {
    remaining = remaining.map(o => (o === order ? repl : o));
    persist();
  };

  const halt = (reason: string) => {
    halted = true;
    haltReason = reason;
  };

  /**
   * Best-effort cancel of an order whose fill state we couldn't confirm
   * (confirmation errored / timed out). Retiring it at IBKR stops the
   * strategist from regenerating the same order and double-trading it. Never
   * throws — a failed cancel just leaves the pre-existing risk in place.
   */
  const cancelUnknown = async (orderId: number, symbol: string): Promise<void> => {
    if (!deps.cancelOrder) return;
    try {
      await deps.cancelOrder(orderId);
      deps.log(`Cancel requested for unconfirmed orderId=${orderId} (${symbol})`);
    } catch (err) {
      deps.logError(`Best-effort cancel failed for orderId=${orderId} (${symbol})`, err);
    }
  };

  /**
   * Record a trade that actually filled (fully or partially). Uses the
   * CONFIRMED filled quantity for the tax record, realised P&L, and the
   * shortfall metric — never the submitted `order.qty`, which overstates
   * both on a partial fill.
   */
  const recordFilledTrade = (
    order: StagedOrder,
    filledQty: number,
    fillPrice: number,
    status: string,
    result: TradeResult,
  ): void => {
    const decisionPrice = order.estimatedValue / order.qty;
    const commission = result.commission ?? 0;
    deps.log(`Filled: orderId=${result.orderId} status=${status} filled=${filledQty}/${order.qty} fillPrice=$${fillPrice.toFixed(2)} commission=$${commission.toFixed(4)}`);

    const tradeRecord: TradeRecord = {
      timestamp: new Date().toISOString(),
      symbol: order.symbol, action: order.action, qty: filledQty,
      estimatedValue: order.estimatedValue,
      fillPrice,
      orderId: result.orderId,
      status, reason: order.reason,
      commission: commission > 0 ? commission : undefined,
      commissionCurrency: result.commissionCurrency,
    };

    // For SELL trades: quantity-aware FIFO cost basis across BUY lots, on the
    // CONFIRMED filled quantity.
    if (order.action === 'SELL') {
      const match = matchSellFifo(deps.loadTradeHistory(), order.symbol, filledQty, fillPrice);
      if (match.matchedQty > 0) {
        tradeRecord.matchedLots = match.lots.map(l => ({
          buyTimestamp: l.buyTimestamp, qty: l.qty, buyPrice: l.buyPrice, longTerm: l.longTerm,
        }));
        tradeRecord.costBasisPrice = match.costBasisPrice;
        tradeRecord.realisedPnlUsd = match.realisedPnlUsd;
        tradeRecord.longTermQty = match.longTermQty;
        tradeRecord.longTermHolding = match.longTermQty >= match.matchedQty && match.matchedQty > 0;
        deps.log(
          `Tax: FIFO matched ${match.matchedQty}/${filledQty} across ${match.lots.length} lot(s), ` +
            `avg cost $${match.costBasisPrice.toFixed(2)}, P&L $${match.realisedPnlUsd.toFixed(2)}, ` +
            `LT qty ${match.longTermQty}`,
        );
        if (match.realisedPnlUsd < 0) {
          const entry = createWashSaleEntry(order.symbol);
          washSales.push(entry);
          deps.log(`Wash-sale window opened on ${order.symbol} until ${entry.expiresAt} (loss SELL)`);
        }
      } else if (avgCosts.has(order.symbol)) {
        // No FIFO lot (opening positions predate the ledger) — fall back to the
        // IBKR position's avg cost so realised P&L is still correct. Lot
        // acquisition date is unknown, so long-term status is left unset.
        const basis = avgCosts.get(order.symbol)!;
        tradeRecord.costBasisPrice = basis;
        tradeRecord.realisedPnlUsd = filledQty * (fillPrice - basis);
        deps.log(`Tax: no FIFO lot — using position avg cost $${basis.toFixed(2)}, P&L $${tradeRecord.realisedPnlUsd.toFixed(2)} (LT status unknown)`);
        if (tradeRecord.realisedPnlUsd < 0) {
          const entry = createWashSaleEntry(order.symbol);
          washSales.push(entry);
        }
      }
    }

    deps.appendTrade(tradeRecord);

    // Track execution quality via implementation shortfall — on the shares
    // that actually filled.
    try {
      const shortfall = computeShortfall(
        {
          symbol: order.symbol,
          decisionPrice,
          decisionTimestamp: new Date().toISOString(),
          action: order.action,
          targetQty: filledQty,
        },
        [{
          fillPrice,
          fillQty: filledQty,
          fillTimestamp: new Date().toISOString(),
          commission,
        }],
        decisionPrice,
      );
      shortfalls.push(shortfall);
      deps.log(`Shortfall: ${shortfall.totalShortfallBps.toFixed(1)} bps ($${shortfall.totalShortfallUsd.toFixed(2)})`);
    } catch (sfErr) {
      deps.log(`Shortfall calc skipped: ${sfErr instanceof Error ? sfErr.message : String(sfErr)}`);
    }
  };

  /** Record a fill without letting a bookkeeping throw unwind the run. */
  const recordExecuted = (
    order: StagedOrder,
    filledQty: number,
    fillPrice: number,
    status: string,
    result: TradeResult,
  ): void => {
    try {
      recordFilledTrade(order, filledQty, fillPrice, status, result);
    } catch (e) {
      // The fill DID happen — a failed trade-history/tax write must not
      // unwind the run (that would leave the filled order in the queue to
      // re-execute). Log and carry on; the order is still marked executed.
      deps.logError(`Bookkeeping failed for ${order.symbol} (fill occurred) — continuing`, e);
    }
    executed.push({ ...order, qty: filledQty });
  };

  // Idempotency: which symbol+side pairs already have a WORKING order at IBKR?
  // We must never place a second order for one — that is the account's own
  // source of truth against duplicates from a prior run's un-confirmed order
  // or a placement that timed out after IBKR accepted it.
  const working = new Set<string>();
  if (deps.getLiveOrders && plan.orders.length > 0) {
    try {
      const live = await deps.getLiveOrders();
      for (const lo of live) {
        if (isWorkingOrder(lo.status)) working.add(`${lo.action}:${lo.symbol}`);
      }
      if (working.size > 0) {
        deps.log(`Working orders already at IBKR (won't duplicate): ${[...working].join(', ')}`);
      }
    } catch (e) {
      // FAIL CLOSED: the idempotency guard is our only defence against
      // duplicating a prior run's un-confirmed order. If we can't read live
      // orders, placing anything risks a duplicate — so halt the run and
      // touch nothing. Better to skip a session than double-trade.
      deps.logError('getLiveOrders failed — halting run (cannot verify no duplicate)', e);
      halt('idempotency guard unavailable (getLiveOrders failed)');
      return {
        mode: plan.mode,
        requeue: remaining,
        executed,
        halted: true,
        haltReason,
        confirmedFill,
        validationFailed: plan.mode === 'validate' && !confirmedFill,
        shortfalls,
        washSales,
      };
    }
  }

  // Avg costs (fallback cost basis for sells with no FIFO lot). Best-effort.
  if (deps.getAvgCosts && plan.orders.length > 0) {
    try { avgCosts = await deps.getAvgCosts(); } catch (e) { deps.logError('getAvgCosts failed (cost basis may be incomplete)', e); }
  }

  /**
   * WS fill-confirmation failed for this order — but the fill may actually have
   * happened (a de-authed event stream, a timeout race). Consult IBKR's
   * authoritative executions: if the order filled, RECORD it (never lose a real
   * fill) and return true. Returns false if it genuinely didn't fill.
   */
  const reconcileOrderFill = async (order: StagedOrder, orderId: number): Promise<number> => {
    if (!deps.getExecutions) return 0;
    let execs;
    try {
      execs = await deps.getExecutions();
    } catch (e) {
      deps.logError(`Could not fetch executions to verify ${order.symbol} fill`, e);
      return 0;
    }
    const fills = execs.filter(e => e.orderId === orderId && e.qty > 0);
    const filledQty = fills.reduce((s, e) => s + e.qty, 0);
    if (filledQty <= 0) return 0;
    const avgPrice = fills.reduce((s, e) => s + e.qty * e.price, 0) / filledQty;
    deps.log(`RECONCILED from IBKR executions: ${order.action} ${filledQty} ${order.symbol} @ $${avgPrice.toFixed(2)} DID fill (confirmation misreported).`);
    confirmedFill = true;
    recordExecuted(order, filledQty, avgPrice, 'filled', { orderId, symbol: order.symbol, action: order.action, qty: filledQty, status: 'filled' } as TradeResult);
    return filledQty;
  };

  /**
   * Shared handler for ANY confirmation outcome that isn't a clean fill
   * (error, timeout, cancelled, rejected, zero-fill). The WS confirmer is
   * unreliable, so IBKR executions are the source of truth: reconcile the real
   * fill, then decide. If it FULLY filled, the confirmation simply misreported
   * — record it and CONTINUE the batch. If partial or nothing, drop it
   * (cancel a truly-unfilled order) and halt. Idempotent recording means a
   * double-check is harmless.
   */
  const onConfirmationFailure = async (order: StagedOrder, orderId: number, reason: string): Promise<void> => {
    const filledQty = await reconcileOrderFill(order, orderId);
    drop(order);
    if (filledQty >= order.qty) {
      deps.log(`${order.symbol}: executions confirm FULL fill (${filledQty}/${order.qty}) despite '${reason}' — continuing.`);
      return; // NOT halted — the order actually succeeded
    }
    if (filledQty === 0) {
      await cancelUnknown(orderId, order.symbol);
    } else {
      deps.log(`${order.symbol}: partial ${filledQty}/${order.qty} per executions — remainder unknown, halting.`);
    }
    halt(`${reason} (${order.symbol})`);
  };

  const executeBatch = async (batch: StagedOrder[]): Promise<void> => {
    for (const order of batch) {
      if (halted) return;

      // Re-check the trading window before every placement: a full queue of
      // Patient orders can take longer than the window is open, and we must
      // not fire into the close auction. The order stays in `remaining`.
      if (deps.isWindowOpen && !deps.isWindowOpen()) {
        deps.log(`Execution window closed mid-run before ${order.symbol} — halting; ${remaining.length} order(s) stay queued`);
        halt('execution window closed mid-run');
        return;
      }

      // Idempotency guard: an equivalent order is already working at IBKR.
      // Don't place a duplicate; drop it from our queue (IBKR owns it now).
      if (working.has(`${order.action}:${order.symbol}`)) {
        deps.log(`SKIP ${order.action} ${order.qty} ${order.symbol}: a working order already exists at IBKR — not placing a duplicate`);
        drop(order);
        continue;
      }

      // Absolute cap backstop: an implausibly large order (or run) means the
      // queue was sized against bad data — refuse and halt, don't place.
      if (ctx.caps) {
        const capViolation = orderCapViolation(order.estimatedValue, ctx.nav, runNotional, ctx.caps);
        if (capViolation) {
          deps.logError(
            `ABSOLUTE CAP breached — refusing ${order.action} ${order.qty} ${order.symbol}: ${capViolation}. ` +
              `Halting run (queue likely sized against bad data).`,
            undefined,
          );
          halt(`order cap breached (${order.symbol}): ${capViolation}`);
          return;
        }
      }

      const strategy = selectExecutionStrategy(order.estimatedValue, ctx.nav);
      const urgency = selectUrgency(false, true, ctx.regime);
      const decisionPrice = order.estimatedValue / order.qty;
      deps.log(`${order.action} ${order.qty} ${order.symbol} via ${strategy} (${urgency}) — ${order.reason}`);

      let result: TradeResult;
      try {
        result = await deps.placeOrder(order, strategy, urgency);
      } catch (err) {
        deps.logError(`Order submission failed: ${order.action} ${order.qty} ${order.symbol}`, err);
        // AMBIGUOUS: a client-side timeout / 5xx can occur AFTER IBKR accepted
        // the order (placement is non-idempotent — no client order id), so
        // requeueing verbatim risks a duplicate. Drop it and halt. Next run's
        // idempotency guard skips it if it went live; else the strategist
        // regenerates it from positions.
        drop(order);
        halt(`order submission failed (${order.symbol})`);
        continue;
      }

      // An accepted response with no usable orderId (gateway coerces a
      // missing/unparseable CPAPI order_id — e.g. a confirmation prompt — to
      // 0) means we can neither confirm nor safely retry. Drop, halt.
      if (!result.orderId || result.orderId <= 0) {
        deps.logError(
          `Order accepted with no usable orderId (${order.action} ${order.qty} ${order.symbol}) — ` +
            `cannot confirm; dropping (idempotency guard catches it if live). Halting run.`,
          undefined,
        );
        drop(order);
        halt(`no usable orderId (${order.symbol})`);
        continue;
      }

      // The order reached IBKR — count it toward the per-run notional cap.
      runNotional += order.estimatedValue;

      // The synchronous response only confirms acceptance — for actual
      // fill quantity + price we ask the WS event stream.
      let actualFillPrice = result.avgFillPrice || decisionPrice;
      let actualFilledQty = order.qty;
      let actualStatus: string = result.status;
      let remainder: StagedOrder | null = null;

      if (useFillConfirmer) {
        const timeoutMs = urgency === 'Patient' ? 180_000 : 60_000;
        let conf: FillConfirmation;
        try {
          conf = await deps.confirmFill(result.orderId, {
            targetQty: order.qty,
            timeoutMs,
            fromCursor: ctx.ordersCursorFloor,
          });
        } catch (err) {
          deps.logError(`Fill confirmation failed for orderId=${result.orderId}`, err);
          await onConfirmationFailure(order, result.orderId, 'fill confirmation errored');
          continue;
        }

        // Adopt the confirmed filled quantity independently of price (a fill
        // can be reported with a qty but a NaN price).
        if (conf.totalFilledQty > 0) {
          actualFilledQty = conf.totalFilledQty;
          if (Number.isFinite(conf.avgFillPrice)) actualFillPrice = conf.avgFillPrice;
        }
        actualStatus = conf.status;
        deps.log(
          `Confirmed: orderId=${result.orderId} status=${conf.status} ` +
            `filled=${conf.totalFilledQty}/${order.qty} avg=$${
              Number.isFinite(conf.avgFillPrice) ? conf.avgFillPrice.toFixed(2) : 'n/a'
            } timedOut=${conf.timedOut}`,
        );

        if (conf.status === 'rejected' || conf.status === 'cancelled') {
          // The WS confirmer is unreliable — it reported cancelled/rejected,
          // but the order may actually have filled (as TWLO did). Executions
          // are the truth: reconcile, and continue if it fully filled.
          deps.log(`Order reported ${conf.status}: ${order.action} ${order.qty} ${order.symbol} — verifying against executions…`);
          await onConfirmationFailure(order, result.orderId, `order ${conf.status}`);
          continue;
        }
        if (conf.timedOut && conf.totalFilledQty === 0) {
          deps.log(
            `UNCONFIRMED: orderId=${result.orderId} ${order.action} ${order.qty} ` +
              `${order.symbol} — no fill events within ${timeoutMs / 1000}s. Verifying against executions…`,
          );
          await onConfirmationFailure(order, result.orderId, 'fill confirmation timed out');
          continue;
        }
        if (conf.totalFilledQty <= 0) {
          deps.log(`Zero-fill confirmation for ${order.symbol} (status=${conf.status}) — verifying against executions…`);
          await onConfirmationFailure(order, result.orderId, 'zero-fill confirmation');
          continue;
        }
        confirmedFill = true;
        if (conf.status === 'partial' && conf.remainingQty > 0) {
          if (conf.timedOut) {
            // More fills may still come — don't requeue the remainder. Record
            // the shares that DID fill, cancel the rest, drop, halt.
            deps.log(
              `Partial ${conf.totalFilledQty}/${order.qty} ${order.symbol} with timeout — ` +
                `recording filled shares, cancelling remainder, dropping. Halting run.`,
            );
            drop(order);
            recordExecuted(order, actualFilledQty, actualFillPrice, actualStatus, result);
            await cancelUnknown(result.orderId, order.symbol);
            halt(`partial fill timed out (${order.symbol})`);
            continue;
          }
          // Terminal partial: the remainder stays queued, estimatedValue
          // scaled to the remaining shares so the next run sizes it right.
          const perShare = order.estimatedValue / order.qty;
          remainder = {
            ...order,
            qty: conf.remainingQty,
            estimatedValue: perShare * conf.remainingQty,
            reason: `partial_fill_remainder(orig=${order.qty})`,
          };
        }
      } else {
        // Explicitly opted out of confirmation — trust acceptance (validation
        // never takes this branch; useFillConfirmer is forced on there).
        confirmedFill = true;
      }

      // Persist the queue change BEFORE recording the fill: a crash in the gap
      // then leaves the order OUT of the queue (no duplicate on the next run)
      // rather than still queued. The unrecorded fill is reconcilable from
      // IBKR's authoritative execution log; a duplicate trade is not.
      if (remainder) replaceWith(order, remainder);
      else drop(order);
      recordExecuted(order, actualFilledQty, actualFillPrice, actualStatus, result);
    }
  };

  await executeBatch(sells);

  // Buys stay in `remaining` until executed/deferred, so a halt before this
  // point leaves them queued automatically.
  if (buys.length > 0 && !halted) {
    // Cash gate: fetch USD cash after the sells so their proceeds count.
    let cash: number | undefined;
    try {
      cash = await deps.getUsdCash();
    } catch (err) {
      // Sells already executed and recorded; without a cash reading we can't
      // size buys, so leave them ALL queued (already in `remaining`).
      deps.logError('USD cash fetch failed after sells — deferring all buys to next run', err);
    }
    if (cash !== undefined) {
      const gate = gateBuysByCash(buys, cash, ctx.cashHeadroomPct);
      if (gate.deferred.length > 0) {
        // Deferred buys are already in `remaining` — they persist as-is.
        deps.log(
          `Cash gate: deferring ${gate.deferred.length} BUY(s) — cash $${cash.toFixed(2)}, ` +
            `headroom ${ctx.cashHeadroomPct}%: ${gate.deferred.map(o => o.symbol).join(', ')} stay queued`,
        );
      }
      await executeBatch(gate.execute);
    }
  }

  if (halted) {
    deps.log(`Run halted early: ${haltReason} — ${remaining.length} order(s) remain queued`);
  }

  return {
    mode: plan.mode,
    requeue: remaining,
    executed,
    halted,
    haltReason,
    confirmedFill,
    validationFailed: plan.mode === 'validate' && !confirmedFill,
    shortfalls,
    washSales,
  };
}
