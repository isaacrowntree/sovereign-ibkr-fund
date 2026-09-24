/**
 * Ledger access for the operator scripts that write `pendingOrders` directly
 * (deposit-autopilot, stage-deposit-buy).
 *
 * Both used to open the ledger with no busy_timeout, then read the queue, check
 * it was empty and write it as separate autocommitting statements:
 *
 *   - with no busy handler, any agent holding the write lock at that instant
 *     (the observer writes every five minutes) made the script throw
 *     "database is locked" instead of waiting a moment;
 *   - between the emptiness check and the write, the strategist could stage its
 *     own queue, and the script would silently overwrite it.
 *
 * Here the check and the write share one BEGIN IMMEDIATE transaction, which
 * takes the write lock before the read, so nothing can land in between.
 */
import { DatabaseSync } from 'node:sqlite';

const BUSY_MS = parseInt(process.env.STATE_BUSY_TIMEOUT_MS || '5000', 10);

export function openStateDb(path, { write = false } = {}) {
  const db = new DatabaseSync(path, { readOnly: !write });
  // Before anything else: every later statement may need to wait for a lock.
  db.exec(`PRAGMA busy_timeout = ${Number.isFinite(BUSY_MS) && BUSY_MS > 0 ? BUSY_MS : 5000}`);
  return db;
}

export function readStateKey(db, key) {
  const r = db.prepare('select value from state_kv where key = ?').get(key);
  return r ? JSON.parse(r.value) : null;
}

/**
 * Write `orders` as the queue only if the queue is empty, atomically.
 * Returns `{ staged: true }` or `{ staged: false, existing: n }`.
 */
export function stageQueueIfEmpty(db, orders) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = readStateKey(db, 'pendingOrders') || [];
    if (existing.length > 0) {
      db.exec('ROLLBACK');
      return { staged: false, existing: existing.length };
    }
    db.prepare(
      'insert into state_kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
    ).run('pendingOrders', JSON.stringify(orders));
    db.exec('COMMIT');
    return { staged: true };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}
