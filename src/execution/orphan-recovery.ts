/**
 * Recover staged orders that already filled — self-healing for an orphaned queue.
 *
 * ## The failure this exists for (2026-09-08)
 *
 * The directed-deposit queue was XLE, NET, VST. XLE and NET filled and were
 * recorded. Then the run was killed — `executionRunLock` was left holding a
 * dead pid, so it never reached the `finally` that releases it. VST had already
 * filled at IBKR, but the fill was never written to the ledger and the order was
 * never removed from `pendingOrders`. The next execution window would have
 * bought it a second time.
 *
 * Nothing in place caught it:
 *
 * - The executor's idempotency guard asks `getLiveOrders()` for orders still
 *   WORKING at IBKR. A filled order is not working, so it is invisible there.
 * - `reconcileExecutions()` backfills the ledger from `getExecutions()`, which
 *   is `/iserver/account/trades` — and that came back `[]`, because IBKR scopes
 *   it to the session and the session had been re-established since the fill.
 *
 * Both sources are session-scoped and both had forgotten. The POSITION had not:
 * IBKR reported 4 shares of VST that our ledger could not account for. Positions
 * are the one broker fact that survives a session bounce, so that is what this
 * reconciles against.
 *
 * ## Why a baseline is required
 *
 * "Broker shares minus ledger-implied shares" is NOT zero in the steady state —
 * the account pre-dates the ledger, so there is a permanent difference
 * (AMZN:4, ARM:5, BRK-B:10, NET:50, …). Treating that as unrecorded fills would
 * retire every staged order on the first run and silently cancel real trades.
 * So the caller passes the accepted baseline and only drift BEYOND it is treated
 * as a fill we missed.
 *
 * ## The direction the uncertainty falls
 *
 * A staged order is retired only when the shares are demonstrably already there.
 * Where this is wrong, it is wrong by skipping a buy the strategist will
 * regenerate at the next rebalance — not by buying twice. Unrecoverable money
 * errors are duplicates; a missed order is a delay. The bias is deliberate.
 *
 * Pure: no I/O, no clock, no mutation of its inputs. The caller appends
 * `recovered[].trade`, persists `remaining` as the new queue, alerts on
 * `unexplained`, and stores `baseline`.
 */
import type { TradeRecord } from '../state/store.js';
import type { StagedOrder } from './staging.js';

export interface BrokerPosition {
  symbol: string;
  qty: number;
  /** Broker's average cost per share, when it reports one. */
  avgCost?: number;
}

export interface OrphanRecoveryInput {
  /** The queue as persisted in `pendingOrders`. */
  pending: StagedOrder[];
  /** The full local trade ledger. */
  history: TradeRecord[];
  /** Positions as IBKR reports them. */
  positions: BrokerPosition[];
  /**
   * Drift already accepted as normal — `state.ledgerDriftBaseline`. Undefined
   * on a never-seeded install, which is treated as "no accepted drift": the
   * queue gets first claim on the difference and whatever is left becomes the
   * baseline this call hands back.
   */
  baselineSignature?: string;
  now: Date;
}

export interface RecoveredFill {
  /** The staged order this proves already executed, at the recovered quantity. */
  order: StagedOrder;
  /** The ledger record to append for it. */
  trade: TradeRecord;
}

export interface DriftEntry {
  symbol: string;
  /** Broker shares minus ledger-implied shares, beyond the baseline. */
  delta: number;
}

export interface OrphanRecoveryResult {
  recovered: RecoveredFill[];
  /** The queue with recovered quantities removed, original order preserved. */
  remaining: StagedOrder[];
  /** Drift no staged order explains. Alert-worthy; nothing can be inferred. */
  unexplained: DriftEntry[];
  /** Drift signature to persist as the accepted baseline once `recovered` is applied. */
  baseline: string;
  /**
   * True when no baseline had been accepted yet and this call established one.
   *
   * On that run every pre-ledger share lands in `unexplained`, because without
   * a baseline nothing distinguishes "history from before the ledger existed"
   * from "a fill we missed". It is the former far more often than the latter,
   * so the caller should report the adoption rather than raise an anomaly —
   * and treat `unexplained` as critical only on later runs, when a baseline
   * really was in place for the drift to exceed.
   */
  adoptedBaseline: boolean;
}

/** Net shares per symbol implied by everything recorded in the ledger. */
export function ledgerImpliedShares(history: TradeRecord[]): Map<string, number> {
  const implied = new Map<string, number>();
  for (const t of history) {
    const delta = t.qty * (t.action === 'BUY' ? 1 : -1);
    implied.set(t.symbol, (implied.get(t.symbol) ?? 0) + delta);
  }
  return implied;
}

/**
 * Parse a drift signature (`"AMZN:4,NET:50"`) into a map.
 *
 * Tolerant by design: a corrupt or hand-edited signature must not throw and
 * take the whole execution run down with it. An unreadable entry is dropped,
 * which understates the baseline — and understating it can only make this
 * module MORE willing to call something unexplained, never more willing to
 * retire a real order.
 */
export function parseDriftSignature(sig: string | undefined | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!sig) return out;
  for (const entry of sig.split(',')) {
    const at = entry.lastIndexOf(':');
    if (at <= 0) continue;
    const symbol = entry.slice(0, at).trim();
    const n = Number(entry.slice(at + 1));
    if (!symbol || !Number.isFinite(n) || n === 0) continue;
    out.set(symbol, n);
  }
  return out;
}

/** Render a drift map back to its canonical signature: sorted, zeroes omitted. */
export function formatDriftSignature(drift: Map<string, number>): string {
  return [...drift.entries()]
    .filter(([, n]) => n !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, n]) => `${s}:${n}`)
    .join(',');
}

export function recoverOrphanedFills(input: OrphanRecoveryInput): OrphanRecoveryResult {
  const { pending, history, positions, baselineSignature, now } = input;

  const implied = ledgerImpliedShares(history);
  const actual = new Map<string, number>();
  for (const p of positions) {
    if (!p.qty) continue; // a zeroed row is a closed position, not a sale to explain
    actual.set(p.symbol, (actual.get(p.symbol) ?? 0) + p.qty);
  }
  const avgCost = new Map(
    positions.filter(p => p.avgCost != null).map(p => [p.symbol, p.avgCost as number]),
  );
  const baseline = parseDriftSignature(baselineSignature);

  // Drift beyond the baseline: shares at the broker that neither the ledger nor
  // the accepted pre-ledger difference accounts for. Positive = the broker has
  // more than we recorded (an unrecorded BUY), negative = fewer (a SELL).
  const surplus = new Map<string, number>();
  for (const symbol of new Set([...implied.keys(), ...actual.keys(), ...baseline.keys()])) {
    const d = (actual.get(symbol) ?? 0) - (implied.get(symbol) ?? 0) - (baseline.get(symbol) ?? 0);
    if (d !== 0) surplus.set(symbol, d);
  }

  const recovered: RecoveredFill[] = [];
  const remaining: StagedOrder[] = [];

  // Queue order, first claim wins: two staged orders on one symbol must not
  // both be retired by a surplus that only covers one of them.
  for (const order of pending) {
    const available = surplus.get(order.symbol) ?? 0;
    // A buy is only explained by a surplus, a sell only by a shortfall. Sign
    // agreement is what stops an unrecorded buy from retiring a pending sell.
    const signed = order.action === 'BUY' ? available : -available;
    const filled = Math.min(Math.max(signed, 0), order.qty);

    if (filled <= 0) {
      remaining.push(order);
      continue;
    }

    const unitEstimate = order.qty > 0 ? order.estimatedValue / order.qty : 0;
    const price = avgCost.get(order.symbol);
    recovered.push({
      order: { ...order, qty: filled },
      trade: {
        timestamp: now.toISOString(),
        symbol: order.symbol,
        action: order.action,
        qty: filled,
        // Prefer real money paid over our own pre-trade guess, but never drop
        // the record just because the broker withheld a cost.
        estimatedValue: price != null ? filled * price : filled * unitEstimate,
        fillPrice: price,
        orderId: 0, // the orderId died with the run that placed it
        status: 'filled',
        reason:
          `recovered_orphan: ${order.reason} — filled at IBKR but never recorded; ` +
          (price != null
            ? 'price INFERRED from broker average cost, not observed'
            : 'no fill price available'),
      },
    });

    // Consume what this order explains so the next one cannot claim it twice.
    surplus.set(order.symbol, available - (order.action === 'BUY' ? filled : -filled));

    // A partial fill leaves the unfilled remainder queued, repriced so the
    // cash gate sizes it against what is actually still to buy.
    const rest = order.qty - filled;
    if (rest > 0) {
      remaining.push({ ...order, qty: rest, estimatedValue: rest * unitEstimate });
    }
  }

  const unexplained: DriftEntry[] = [...surplus.entries()]
    .filter(([, delta]) => delta !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, delta]) => ({ symbol, delta }));

  // What the reconciler's signature will read once the backfill lands: the
  // accepted baseline plus whatever stayed unexplained. Folding the remainder
  // in is what stops the same unattributable share re-alerting every run — it
  // is reported once, in `unexplained`, and then accepted.
  const nextBaseline = new Map(baseline);
  for (const { symbol, delta } of unexplained) {
    nextBaseline.set(symbol, (nextBaseline.get(symbol) ?? 0) + delta);
  }

  return {
    recovered,
    remaining,
    unexplained,
    baseline: formatDriftSignature(nextBaseline),
    adoptedBaseline: baselineSignature == null,
  };
}
