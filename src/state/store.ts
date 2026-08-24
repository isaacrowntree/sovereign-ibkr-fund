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

/**
 * STATE_DIR is resolved LAZILY, on first use, not at module load.
 *
 * It used to be read at import time, which made the ledger's location depend on
 * MODULE IMPORT ORDER: `STATE_DIR` reaches the process via `dotenv/config` (a
 * side-effect import in ../config.js), so any agent that reached this module
 * before config.js silently got `'.'` and opened a fresh bot-state.db in its cwd.
 * Eight of ten agent entrypoints only imported dotenv TRANSITIVELY via
 * connection/gateway.js -> config.js; execution-bot.js required state/store.js at
 * import position 5 and config.js at position 9, and was correct only because
 * gateway.js happened to come first. Reordering one import line would have
 * silently split the ledger in two — which is exactly the failure that hit this
 * fund on 2026-08-11 and went unnoticed for eight days because the nightly backup
 * kept snapshotting the abandoned half and reporting it healthy.
 *
 * Resolving on first call means dotenv has always run by then, whatever the
 * import graph looks like.
 */
let _paths: { db: string; legacyState: string; legacyTrades: string } | null = null;
function paths(): { db: string; legacyState: string; legacyTrades: string } {
  if (_paths === null) {
    const dir = process.env.STATE_DIR || '.';
    _paths = {
      db: resolve(dir, 'bot-state.db'),
      legacyState: resolve(dir, 'bot-state.json'),
      legacyTrades: resolve(dir, 'trade-history.json'),
    };
  }
  return _paths;
}

/** Absolute path of the ledger this process will use. Exported for diagnostics. */
export function stateDbPath(): string {
  return paths().db;
}

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

/**
 * Retry budgets, in wall-clock ms, on top of what busy_timeout absorbs inside
 * each attempt. Both are deadlines rather than attempt counts: an attempt count
 * silently encodes a duration via whatever backoff it happens to use, and that
 * duration was far too short here.
 *
 * OPEN matters as much as TX because openDb() issues DDL (`CREATE TABLE IF NOT
 * EXISTS`), which takes the write lock. A fixed 10 attempts at 20-80ms gave up
 * after roughly 800ms — less than one observer poll spends rewriting its blob
 * under `synchronous = FULL`. So an agent starting while the observer held the
 * lock died on open, which for risk-manager means the drawdown gate is never
 * written and the hard stop silently does not fire.
 */
const OPEN_RETRY_BUDGET_MS = parseInt(process.env.STATE_OPEN_RETRY_MS || '15000', 10);

/** Jittered backoff. Unjittered retries from N processes just re-collide. */
function backoff(attempt: number): void {
  const base = Math.min(50 * 2 ** Math.min(attempt, 5), 800);
  const until = Date.now() + base + Math.floor(Math.random() * base);
  while (Date.now() < until) { /* sync spin: DatabaseSync gives us no async seam */ }
}

function openDb(): DatabaseSync {
  const d = new DatabaseSync(paths().db);
  // busy_timeout FIRST. It arms the busy handler, and everything below can
  // need the write lock — including `journal_mode = WAL` itself. Setting it
  // after (as this used to) leaves the riskiest statement unprotected: SQLite
  // does not invoke the busy handler on the journal_mode path, so a concurrent
  // open threw SQLITE_BUSY outright. With agents running as separate processes
  // that meant an agent could die on startup; for risk-manager, dying means the
  // drawdown gate is never written and the hard stop silently doesn't fire.
  // Tunable so contention behaviour is testable without a multi-second hold,
  // and so a slow disk can be given more headroom without a code change.
  const busyMs = parseInt(process.env.STATE_BUSY_TIMEOUT_MS || '5000', 10);
  d.exec(`PRAGMA busy_timeout = ${Number.isFinite(busyMs) && busyMs > 0 ? busyMs : 5000}`);
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
  // Alert dedupe. Deliberately its own table rather than a state_kv key: it is
  // invisible to loadState()'s SELECT *, and a dedicated row per key means the
  // claim below is a real compare-and-set instead of a read-modify-write that
  // two agent processes could interleave.
  //   expires_at NULL ≡ never expires (a once-ever alert).
  // Never bind Infinity here — SQLite silently stores it and reads back null.
  // Observed events as ROWS, not one JSON blob in state_kv.
  //
  // As a blob it was a 5000-entry array around 1.3MB that the observer had to
  // load, mutate and rewrite IN FULL to append a single event — every five
  // minutes, under `synchronous = FULL`, holding the database-wide write lock on
  // a file now shared with the trading agents. Skipping unchanged writes removed
  // the idle cost, but a real event burst still rewrote the entire history to add
  // a handful of entries. As rows an append costs the size of the append.
  //
  // The (topic, id) index serves the only query shape the readers use: the most
  // recent N of one topic (risk-manager wants 'pnl' for intraday drawdown).
  d.exec(
    'CREATE TABLE IF NOT EXISTS observed_events (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, cursor INTEGER NOT NULL, ' +
      'reset_epoch INTEGER NOT NULL, received_at TEXT NOT NULL, observed_at TEXT NOT NULL, ' +
      'payload TEXT NOT NULL)',
  );
  d.exec('CREATE INDEX IF NOT EXISTS observed_events_topic_id_idx ON observed_events (topic, id)');
  d.exec(
    'CREATE TABLE IF NOT EXISTS notify_dedupe (' +
      'key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, sent_at INTEGER NOT NULL, expires_at INTEGER)',
  );
  return d;
}

function db(): DatabaseSync {
  if (_db) return _db;
  const dir = dirname(paths().db);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Retry the whole open on BUSY/LOCKED. busy_timeout covers contention *within*
  // an open connection, but the first-ever open of a fresh db still races other
  // processes creating the WAL, and that window is not covered by the handler.
  const deadline = Date.now() + (Number.isFinite(OPEN_RETRY_BUDGET_MS) ? OPEN_RETRY_BUDGET_MS : 15000);
  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      const d = openDb();
      _db = d;
      migrateLegacy(d);
      // Fold any pre-rows observedEvents blob across on first open after upgrade.
      // Cheap after the first run: a single indexed lookup that finds nothing.
      migrateObservedEventsOn(d);
      return d;
    } catch (err) {
      lastErr = err;
      if (!isBusy((err as { errcode?: number }).errcode)) throw err;
      if (Date.now() >= deadline) break;
      backoff(attempt);
    }
  }
  throw lastErr;
}

/**
 * Total wall-clock budget for retrying a busy transaction, on top of whatever
 * busy_timeout already absorbs inside each attempt.
 *
 * db() retried the OPEN on busy; nothing retried the TRANSACTION. Since the
 * observer and the trading agents were merged onto one ledger they contend for
 * the same write lock, and the observer holds it while rewriting a large blob
 * under `synchronous = FULL`. A BEGIN IMMEDIATE that waits out busy_timeout
 * throws, and an agent dying is not neutral: risk-manager dying means the
 * drawdown gate is never written and the hard stop silently does not fire.
 */
const TX_RETRY_BUDGET_MS = parseInt(process.env.STATE_TX_RETRY_MS || '15000', 10);

function tx(d: DatabaseSync, fn: () => void): void {
  const deadline = Date.now() + (Number.isFinite(TX_RETRY_BUDGET_MS) ? TX_RETRY_BUDGET_MS : 15000);
  let attempt = 0;
  for (;;) {
    try {
      d.exec('BEGIN IMMEDIATE');
    } catch (e) {
      // Nothing was opened, so there is nothing to roll back. Retry while the
      // budget lasts; a lock held beyond it is a real fault worth surfacing.
      if (!isBusy((e as { errcode?: number }).errcode) || Date.now() >= deadline) throw e;
      backoff(attempt++);
      continue;
    }
    try {
      fn();
      d.exec('COMMIT');
      return;
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch { /* ignore */ }
      // A COMMIT can also lose the race in WAL mode.
      if (!isBusy((e as { errcode?: number }).errcode) || Date.now() >= deadline) throw e;
      backoff(attempt++);
    }
  }
}


/**
 * One-time import of the legacy JSON files. Guarded by a `meta` flag inside a
 * write transaction, so concurrent agent processes can't double-import.
 */
function migrateLegacy(d: DatabaseSync): void {
  const already = d.prepare("SELECT v FROM meta WHERE k = 'legacy_migrated'").get();
  if (already) return;

  const { legacyState: LEGACY_STATE_FILE, legacyTrades: LEGACY_TRADES_FILE } = paths();
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
export interface MergeStateResult {
  /** Keys whose stored value actually changed (or were deleted). */
  written: number;
  /** Keys skipped because the serialised value was byte-identical. */
  skipped: number;
}

/**
 * Upsert state keys, skipping any whose serialised value is unchanged.
 *
 * The skip is not a micro-optimisation. The observer runs every 5 minutes and
 * usually finds nothing — its own logs read `events=0` — yet it rewrote
 * `observedEvents`, a JSON array at a 5000-entry cap around 1.3MB, on every one
 * of those polls. Under `synchronous = FULL` each rewrite is an fsync holding
 * the database-wide write lock, ~288 times a day, on an SD-backed Pi, now
 * contending with the trading agents that share this file since the two ledgers
 * were merged. Comparing first turns the common case into a read.
 *
 * Returns counts so the behaviour is observable — it is otherwise invisible,
 * which is exactly how the write amplification survived unnoticed.
 */
export function mergeState(updates: Partial<FundState>): MergeStateResult {
  const d = db();
  let written = 0;
  let skipped = 0;
  tx(d, () => {
    const get = d.prepare('SELECT value FROM state_kv WHERE key = ?');
    const put = d.prepare(
      'INSERT INTO state_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const del = d.prepare('DELETE FROM state_kv WHERE key = ?');
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined) {
        // Only counts as a write if the row was actually there.
        const existing = get.get(k) as { value?: string } | undefined;
        if (existing === undefined) { skipped++; continue; }
        del.run(k);
        written++;
        continue;
      }
      const next = JSON.stringify(v);
      const existing = get.get(k) as { value?: string } | undefined;
      // Byte comparison of the serialised form: JSON.stringify is deterministic
      // for a given object shape, so an unchanged value serialises identically.
      if (existing !== undefined && existing.value === next) { skipped++; continue; }
      put.run(k, next);
      written++;
    }
  });
  return { written, skipped };
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
  // The dup-check and the insert MUST share one transaction. Left as bare
  // autocommitting statements, two processes both saw no dup and both inserted
  // — the guarantee documented above simply didn't hold. Reproduced at 8-out-of-8
  // duplicates when 8 processes append the same fill through a barrier, i.e. a
  // 100-share fill recorded as 800. tx()'s BEGIN IMMEDIATE takes the write lock
  // on the first statement, so the check-and-insert can't interleave.
  //
  // Callers must NOT already hold a transaction (nested BEGIN IMMEDIATE throws).
  tx(d, () => {
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
  });
}

export function loadTradeHistory(): TradeRecord[] {
  const rows = db().prepare('SELECT data FROM trades ORDER BY id').all() as Array<{ data: string }>;
  const out: TradeRecord[] = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.data) as TradeRecord); } catch { /* skip */ }
  }
  return out;
}

/** Prune expired dedupe rows on ~1 claim in 64 — see claimAlert. */
const PRUNE_ODDS = 64;

/**
 * Claim the right to send one alert — ATOMIC across processes.
 *
 * Mirrors appendTrade's philosophy: the store guarantees at-most-once, so
 * callers never need their own dedup and stay one-liners.
 *
 * Returns true (caller should send) when:
 *   - the key has never been alerted, OR
 *   - `fingerprint` CHANGED — a state transition (warning → derisking), OR
 *   - the previous claim has expired — a re-nag on a stuck condition.
 *
 * `ttlMs` of Infinity means never expire: a once-ever alert. It is stored as
 * NULL rather than a number, because binding Infinity to a SQLite column
 * silently succeeds and reads back as null — a trap worth closing at the edge.
 *
 * The SELECT and the upsert both run inside tx()'s BEGIN IMMEDIATE, which takes
 * the write lock on the first statement, so the check-and-set cannot interleave
 * with another process. Callers must NOT hold their own transaction.
 */
export function claimAlert(key: string, fingerprint: string, ttlMs: number): boolean {
  const d = db();
  const now = Date.now();
  let claimed = false;

  tx(d, () => {
    const row = d
      .prepare('SELECT fingerprint, sent_at, expires_at FROM notify_dedupe WHERE key = ?')
      .get(key) as { fingerprint: string; sent_at: number; expires_at: number | null } | undefined;

    if (row && row.fingerprint === fingerprint) {
      // A backwards clock step (the Pi has no RTC and steps on NTP sync) would
      // otherwise make a re-nag unreachable. Treat it as elapsed: a duplicate
      // alert is cheap, a silently suppressed one is not.
      const clockWentBackwards = now < row.sent_at;
      const live = row.expires_at === null || now < row.expires_at;
      if (live && !clockWentBackwards) return; // suppressed
    }

    const expiresAt = Number.isFinite(ttlMs) ? now + ttlMs : null;
    d.prepare(
      'INSERT INTO notify_dedupe (key, fingerprint, sent_at, expires_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint, ' +
        'sent_at = excluded.sent_at, expires_at = excluded.expires_at',
    ).run(key, fingerprint, now, expiresAt);

    // Opportunistic prune. Dropping an EXPIRED row is semantically free — a
    // missing row and an expired row both mean "send" — so this can never
    // resurrect an old alert. NULL (never-expires) rows are left alone by the
    // IS NOT NULL guard; those are the once-ever keys and must persist.
    // Probabilistic so the write lock isn't lengthened on every claim.
    if (Math.floor(Math.random() * PRUNE_ODDS) === 0) {
      d.prepare('DELETE FROM notify_dedupe WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
    }

    claimed = true;
  });

  return claimed;
}

/**
 * Give back a claim, so the next attempt re-sends.
 *
 * Called when delivery FAILED. Without this, claim-then-send silently loses any
 * once-ever alert (a fill, the digest) on a single transient Slack 5xx — the
 * row persists, never expires, and the alert is never retried. Releasing only
 * on a failed send means no duplicate was ever delivered.
 */
export function releaseAlert(key: string): void {
  db().prepare('DELETE FROM notify_dedupe WHERE key = ?').run(key);
}

/** Close the underlying connection (graceful shutdown / test isolation). */
export function closeDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
    _db = null;
  }
}

// ---------- Observed events ----------

/** Default ring size; mirrors OBSERVER_BUFFER_SIZE in the observer agent. */
const OBSERVED_EVENTS_CAP = 5000;

interface ObservedEventRow {
  id: number;
  topic: string;
  cursor: number;
  reset_epoch: number;
  received_at: string;
  observed_at: string;
  payload: string;
}

const rowToEvent = (r: ObservedEventRow): ObservedEventState => ({
  cursor: r.cursor,
  topic: r.topic,
  receivedAt: r.received_at,
  resetEpoch: r.reset_epoch,
  payload: JSON.parse(r.payload) as unknown,
  observedAt: r.observed_at,
});

/**
 * Append events and trim to `cap`, oldest first. Returns the number inserted.
 *
 * One transaction for the whole batch: a burst is one lock acquisition and one
 * fsync rather than one per event.
 */
export function appendObservedEvents(
  events: ObservedEventState[],
  cap: number = OBSERVED_EVENTS_CAP,
): number {
  if (events.length === 0) return 0;
  const d = db();
  tx(d, () => {
    const ins = d.prepare(
      'INSERT INTO observed_events (topic, cursor, reset_epoch, received_at, observed_at, payload) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const e of events) {
      ins.run(e.topic, e.cursor, e.resetEpoch, e.receivedAt, e.observedAt, JSON.stringify(e.payload ?? null));
    }
    // Trim by id, which is monotonic — not by received_at, which comes from
    // bezant-server's clock and can go backwards across a reset.
    d.prepare(
      'DELETE FROM observed_events WHERE id <= ' +
        '(SELECT id FROM observed_events ORDER BY id DESC LIMIT 1 OFFSET ?)',
    ).run(cap);
  });
  return events.length;
}

/** Rows as stored, including ids. Exposed so tests can assert append semantics. */
export function loadObservedEventRows(): Array<{ id: number; topic: string; cursor: number }> {
  const d = db();
  return d.prepare('SELECT id, topic, cursor FROM observed_events ORDER BY id ASC').all() as
    Array<{ id: number; topic: string; cursor: number }>;
}

/**
 * Most recent events, returned oldest-first.
 *
 * `limit` selects the most RECENT n but the result stays chronological, because
 * every consumer walks a time series forward (intraday drawdown, fill matching).
 */
export function loadObservedEvents(opts?: { topic?: string; limit?: number }): ObservedEventState[] {
  const d = db();
  const { topic, limit } = opts ?? {};
  const where = topic ? 'WHERE topic = ?' : '';
  const args: unknown[] = topic ? [topic] : [];
  if (limit !== undefined) args.push(limit);
  const rows = d
    .prepare(
      `SELECT * FROM (SELECT * FROM observed_events ${where} ORDER BY id DESC` +
        `${limit !== undefined ? ' LIMIT ?' : ''}) ORDER BY id ASC`,
    )
    .all(...(args as [])) as unknown as ObservedEventRow[];
  return rows.map(rowToEvent);
}

/**
 * Move a legacy `observedEvents` blob into rows and delete the blob.
 *
 * Idempotent and transactional: the blob is removed in the SAME transaction that
 * inserts the rows, so a crash mid-migration leaves either the old shape or the
 * new one, never both. Leaving both would double the history on the next run.
 */
export function migrateObservedEvents(cap: number = OBSERVED_EVENTS_CAP): number {
  return migrateObservedEventsOn(db(), cap);
}

/** Same, against an explicit connection — used during open, before `_db` is live. */
function migrateObservedEventsOn(d: DatabaseSync, cap: number = OBSERVED_EVENTS_CAP): number {
  let moved = 0;
  tx(d, () => {
    const row = d.prepare("SELECT value FROM state_kv WHERE key = 'observedEvents'").get() as
      { value?: string } | undefined;
    if (!row?.value) return;
    let legacy: ObservedEventState[];
    try {
      legacy = JSON.parse(row.value) as ObservedEventState[];
    } catch {
      // Unparseable: drop it rather than wedging every future open on it.
      d.prepare("DELETE FROM state_kv WHERE key = 'observedEvents'").run();
      return;
    }
    if (Array.isArray(legacy)) {
      const ins = d.prepare(
        'INSERT INTO observed_events (topic, cursor, reset_epoch, received_at, observed_at, payload) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const e of legacy.slice(-cap)) {
        ins.run(
          String(e.topic), Number(e.cursor) || 0, Number(e.resetEpoch) || 0,
          String(e.receivedAt), String(e.observedAt ?? e.receivedAt), JSON.stringify(e.payload ?? null),
        );
        moved++;
      }
    }
    d.prepare("DELETE FROM state_kv WHERE key = 'observedEvents'").run();
  });
  return moved;
}
