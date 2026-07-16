/**
 * Fund state store, backed by SQLite (Node's built-in `node:sqlite`).
 *
 * Replaces the previous single-JSON-blob + advisory-lock design. With ~8
 * agents running as separate processes mutating shared state, a whole-file
 * read-modify-write was a lost-update (and duplicate-trade) hazard. SQLite
 * gives us ACID transactions and per-key updates so:
 *   - `mergeState` upserts only the keys it changes — an agent bumping a
 *     cursor never collides with the executor shrinking `pendingOrders`;
 *   - trade history is an append-only table, not a rewritten JSON array;
 *   - concurrent processes are serialised by SQLite's own WAL locking, not a
 *     bolted-on lockfile that could time out.
 *
 * The public API (loadState / saveState / mergeState / appendTrade /
 * loadTradeHistory) is unchanged, so callers don't move. On first open the
 * store imports any legacy `bot-state.json` / `trade-history.json` and retires
 * them (renamed `*.migrated`), exactly once.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const STATE_DIR = process.env.STATE_DIR || '.';
const DB_FILE = resolve(STATE_DIR, 'bot-state.db');
const LEGACY_STATE_FILE = resolve(STATE_DIR, 'bot-state.json');
const LEGACY_TRADES_FILE = resolve(STATE_DIR, 'trade-history.json');

export interface FundState {
  lastSnapshot?: unknown;
  lastRisk?: unknown;
  lastPrices?: unknown;
  pendingOrders?: unknown[];
  lastCheckAt?: string;
  lastRebalanceAt?: string;
  lastResearchAt?: string;
  /**
   * Per-topic cursors for the observability event poller. Map keys are
   * topic strings (`"orders"`, `"pnl"`, `"gap"`, or
   * `"marketdata:<conid>"`). Persisted across runs so the observer can
   * resume mid-stream.
   */
  observerCursors?: Record<string, ObserverCursor>;
  /**
   * Ring of recently observed events from bezant-server. Capped at
   * OBSERVER_BUFFER_SIZE (default 5000); oldest fall off when the cap
   * is reached. This is forensic detail — strategy decisions don't
   * read from here, but execution-bot's fill-confirmation and
   * risk-manager's intraday-DD code do.
   */
  observedEvents?: ObservedEventState[];
  [key: string]: unknown;
}

export interface ObserverCursor {
  cursor: number;
  resetEpoch: number;
  lastPolledAt?: string;
}

export interface ObservedEventState {
  cursor: number;
  topic: string;
  receivedAt: string;
  resetEpoch: number;
  payload: unknown;
  /** When the observer agent appended it (vs receivedAt = bezant-server's clock). */
  observedAt: string;
}

export interface TradeRecord {
  timestamp: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  qty: number;
  estimatedValue: number;
  fillPrice?: number;
  orderId: number;
  status: string;
  reason: string;
  /** Commission paid on this trade. */
  commission?: number;
  /** Currency the commission was charged in. */
  commissionCurrency?: string;
  /**
   * For SELL trades: matched BUY trade timestamp (FIFO).
   * @deprecated superseded by `matchedLots` (quantity-aware). Retained so
   * legacy history still parses and its whole-lot consumption is honoured.
   */
  matchedBuyTimestamp?: string;
  /**
   * For SELL trades: the BUY parcels this sale consumed, oldest first, with
   * per-parcel quantity/price. Drives quantity-aware FIFO cost basis.
   */
  matchedLots?: Array<{ buyTimestamp: string; qty: number; buyPrice: number; longTerm: boolean }>;
  /** For SELL trades: weighted cost basis per unit across matched parcels. */
  costBasisPrice?: number;
  /** For SELL trades: realised P&L in USD. */
  realisedPnlUsd?: number;
  /** For SELL trades: whether the sale was fully held >12 months (AU CGT). */
  longTermHolding?: boolean;
  /** For SELL trades: quantity eligible for the AU CGT >12-month discount. */
  longTermQty?: number;
  /**
   * IBKR's authoritative execution id, when known. Present on records
   * backfilled by execution reconciliation; the dedupe key that stops the
   * same fill being recorded twice.
   */
  execId?: string;
}

let _db: DatabaseSync | null = null;

/**
 * SQLITE_BUSY (5) / SQLITE_LOCKED (6) — the two primary codes worth retrying an
 * open for.
 *
 * node:sqlite surfaces EXTENDED result codes, so the raw errcode is often not 5:
 * SQLITE_BUSY_RECOVERY is 261 (5 | 1<<8), _SNAPSHOT 517, _TIMEOUT 773. Comparing
 * against 5 directly silently fails to retry — observed as a real
 * `errcode 261 database is locked` escaping under an 8-process open. Mask to the
 * low byte to get the primary code.
 */
const BUSY_PRIMARY_CODES = new Set([5, 6]);
const isBusy = (code: unknown): boolean =>
  typeof code === 'number' && BUSY_PRIMARY_CODES.has(code & 0xff);
const OPEN_ATTEMPTS = 10;

function openDb(): DatabaseSync {
  const d = new DatabaseSync(DB_FILE);
  // busy_timeout FIRST. It arms the busy handler, and everything below can
  // need the write lock — including `journal_mode = WAL` itself. Setting it
  // after (as this used to) leaves the riskiest statement unprotected: SQLite
  // does not invoke the busy handler on the journal_mode path, so a concurrent
  // open threw SQLITE_BUSY outright. With agents running as separate processes
  // that meant an agent could die on startup; for risk-manager, dying means the
  // drawdown gate is never written and the hard stop silently doesn't fire.
  d.exec('PRAGMA busy_timeout = 5000');
  // Only set WAL when it isn't already — journal_mode is persistent, so on an
  // existing db this is a no-op read instead of a lock acquisition.
  const mode = d.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
  if (String(mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
    d.exec('PRAGMA journal_mode = WAL');
  }
  // FULL (not NORMAL): this is a real-money trade ledger on a Pi with no
  // guaranteed UPS. FULL fsyncs on commit so a power loss can't roll back a
  // recently recorded trade. Writes are low-frequency here, so the cost is
  // negligible and correctness wins.
  d.exec('PRAGMA synchronous = FULL');
  d.exec('CREATE TABLE IF NOT EXISTS state_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  d.exec('CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, data TEXT NOT NULL)');
  d.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  return d;
}

function db(): DatabaseSync {
  if (_db) return _db;
  const dir = dirname(DB_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Retry the whole open on BUSY/LOCKED. busy_timeout covers contention *within*
  // an open connection, but the first-ever open of a fresh db still races other
  // processes creating the WAL, and that window is not covered by the handler.
  let lastErr: unknown;
  for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
    try {
      const d = openDb();
      _db = d;
      migrateLegacy(d);
      return d;
    } catch (err) {
      lastErr = err;
      if (!isBusy((err as { errcode?: number }).errcode)) throw err;
      // Jittered backoff — unjittered retries from N processes just re-collide.
      const until = Date.now() + 20 + Math.floor(Math.random() * 60);
      while (Date.now() < until) { /* sync spin: DatabaseSync gives us no async seam */ }
    }
  }
  throw lastErr;
}

function tx(d: DatabaseSync, fn: () => void): void {
  d.exec('BEGIN IMMEDIATE');
  try {
    fn();
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * One-time import of the legacy JSON files. Guarded by a `meta` flag inside a
 * write transaction, so concurrent agent processes can't double-import.
 */
function migrateLegacy(d: DatabaseSync): void {
  const already = d.prepare("SELECT v FROM meta WHERE k = 'legacy_migrated'").get();
  if (already) return;

  const hasState = existsSync(LEGACY_STATE_FILE);
  const hasTrades = existsSync(LEGACY_TRADES_FILE);

  try {
    tx(d, () => {
      // Re-check inside the transaction (another process may have won the race).
      if (d.prepare("SELECT v FROM meta WHERE k = 'legacy_migrated'").get()) return;

      if (hasState) {
        const raw = JSON.parse(readFileSync(LEGACY_STATE_FILE, 'utf8')) as Record<string, unknown>;
        const put = d.prepare(
          'INSERT INTO state_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        );
        for (const [k, v] of Object.entries(raw)) {
          if (v !== undefined) put.run(k, JSON.stringify(v));
        }
      }
      if (hasTrades) {
        const arr = JSON.parse(readFileSync(LEGACY_TRADES_FILE, 'utf8')) as TradeRecord[];
        const ins = d.prepare('INSERT INTO trades (ts, data) VALUES (?, ?)');
        for (const t of Array.isArray(arr) ? arr : []) ins.run(t.timestamp ?? null, JSON.stringify(t));
      }
      d.prepare("INSERT INTO meta (k, v) VALUES ('legacy_migrated', ?)").run(new Date().toISOString());
    });

    // Retire the legacy files so they are never re-imported (kept as backup).
    if (hasState) try { renameSync(LEGACY_STATE_FILE, LEGACY_STATE_FILE + '.migrated'); } catch { /* raced */ }
    if (hasTrades) try { renameSync(LEGACY_TRADES_FILE, LEGACY_TRADES_FILE + '.migrated'); } catch { /* raced */ }
  } catch {
    // A corrupt legacy file must not brick the store — leave it in place for
    // manual inspection and start with an empty db.
  }
}

export function loadState(): FundState {
  const rows = db().prepare('SELECT key, value FROM state_kv').all() as Array<{ key: string; value: string }>;
  const out: FundState = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* skip unparseable row */ }
  }
  return out;
}

export function saveState(state: FundState): void {
  const d = db();
  tx(d, () => {
    d.exec('DELETE FROM state_kv');
    const put = d.prepare('INSERT INTO state_kv (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(state)) {
      if (v !== undefined) put.run(k, JSON.stringify(v));
    }
  });
}

/**
 * Apply only the given keys, atomically and per-key — keys not in `updates`
 * are untouched, so concurrent agents writing different keys never clobber
 * each other. A value of `undefined` deletes its key (matching the old
 * object-spread semantics); `null` is stored as JSON null.
 */
export function mergeState(updates: Partial<FundState>): void {
  const d = db();
  tx(d, () => {
    const put = d.prepare(
      'INSERT INTO state_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const del = d.prepare('DELETE FROM state_kv WHERE key = ?');
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined) del.run(k);
      else put.run(k, JSON.stringify(v));
    }
  });
}

/**
 * Append a trade — IDEMPOTENT. The same fill can be surfaced twice (once by
 * the WS confirmation path with no execId, once by the executions-reconcile
 * path with an execId), so the store itself guarantees a fill is recorded at
 * most once. Keyed by IBKR's `execId` when present, else by the natural fill
 * signature (orderId + action + symbol + qty). A duplicate is silently
 * dropped, so callers never need their own dedup.
 */
export function appendTrade(trade: TradeRecord): void {
  const d = db();
  if (trade.execId) {
    const dup = d.prepare("SELECT 1 FROM trades WHERE json_extract(data,'$.execId') = ? LIMIT 1").get(trade.execId);
    if (dup) return;
  }
  if (trade.orderId) {
    const dup = d.prepare(
      "SELECT 1 FROM trades WHERE json_extract(data,'$.orderId') = ? AND json_extract(data,'$.action') = ? " +
        "AND json_extract(data,'$.symbol') = ? AND json_extract(data,'$.qty') = ? LIMIT 1",
    ).get(trade.orderId, trade.action, trade.symbol, trade.qty);
    if (dup) return;
  }
  d.prepare('INSERT INTO trades (ts, data) VALUES (?, ?)').run(trade.timestamp ?? null, JSON.stringify(trade));
}

export function loadTradeHistory(): TradeRecord[] {
  const rows = db().prepare('SELECT data FROM trades ORDER BY id').all() as Array<{ data: string }>;
  const out: TradeRecord[] = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.data) as TradeRecord); } catch { /* skip */ }
  }
  return out;
}

/** Close the underlying connection (graceful shutdown / test isolation). */
export function closeDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
    _db = null;
  }
}
