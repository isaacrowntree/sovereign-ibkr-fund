/**
 * Direct access to a test ledger file, independent of the store module.
 *
 * The store caches its path on first use, so one test process cannot point it
 * at a fresh ledger per test. The scripts run as child processes anyway; this
 * is only for arranging a ledger before a run and reading it back after.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export function openLedger(stateDir: string): DatabaseSync {
  const d = new DatabaseSync(join(stateDir, 'bot-state.db'));
  d.exec('PRAGMA busy_timeout = 5000');
  d.exec('CREATE TABLE IF NOT EXISTS state_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  d.exec('CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, data TEXT NOT NULL)');
  d.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  // Mark legacy migration done so the store never looks for JSON files here.
  d.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('legacy_migrated', 'test')").run();
  return d;
}

export function withLedger<T>(stateDir: string, fn: (d: DatabaseSync) => T): T {
  const d = openLedger(stateDir);
  try { return fn(d); } finally { d.close(); }
}

export function putTrades(stateDir: string, trades: Array<Record<string, unknown>>): void {
  withLedger(stateDir, (d) => {
    const ins = d.prepare('INSERT INTO trades (ts, data) VALUES (?, ?)');
    for (const t of trades) ins.run((t.timestamp as string) ?? null, JSON.stringify(t));
  });
}

export function getTrades(stateDir: string): Array<Record<string, any>> {
  return withLedger(stateDir, (d) =>
    (d.prepare('SELECT data FROM trades ORDER BY id').all() as Array<{ data: string }>).map((r) => JSON.parse(r.data)),
  );
}

export function putState(stateDir: string, kv: Record<string, unknown>): void {
  withLedger(stateDir, (d) => {
    const put = d.prepare(
      'INSERT INTO state_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [k, v] of Object.entries(kv)) put.run(k, JSON.stringify(v));
  });
}

export function getState(stateDir: string): Record<string, any> {
  return withLedger(stateDir, (d) => {
    const out: Record<string, any> = {};
    for (const r of d.prepare('SELECT key, value FROM state_kv').all() as Array<{ key: string; value: string }>) {
      out[r.key] = JSON.parse(r.value);
    }
    return out;
  });
}
