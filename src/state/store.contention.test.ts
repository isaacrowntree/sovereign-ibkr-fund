import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Write contention between the two orchestrators that now share one ledger.
 *
 * Until 2026-08-19 the systemd observer wrote its own bot-state.db while the
 * paperclip-scheduled trading agents wrote another. Merging them into a single
 * durable file was correct, but it also merged their write load: the observer
 * runs every 5 minutes and rewrites `observedEvents` — a JSON array at a 5000
 * event cap, ~1.3MB — in full, under `PRAGMA synchronous = FULL`, taking the
 * database-wide write lock via BEGIN IMMEDIATE.
 *
 * The hazard is not a lost update (mergeState is a per-key upsert and
 * observedEvents has one writer). It is that a transaction which waits out
 * busy_timeout THROWS, and an agent dying mid-run is not a neutral event: per
 * store.ts's own note, risk-manager dying means the drawdown gate is never
 * written and the hard stop silently does not fire.
 *
 * db() retried the OPEN on busy. Nothing retried the transaction.
 */

const TEST_DIR = resolve(__dirname, '../../.test-store-contention-' + process.pid);
const HOLDER = resolve(TEST_DIR, 'holder.mjs');
const STORE_TS = resolve(__dirname, 'store.ts');
const WRITER = resolve(TEST_DIR, 'writer.mjs');

/**
 * `big` > 0 writes a payload of that many thousand entries, repeatedly — the
 * observer's shape. `big` = 0 does the single small write an agent run does.
 */
const WRITER_SRC = `
import { pathToFileURL } from 'node:url';
process.env.STATE_DIR = process.argv[2];
const key = process.argv[3];
const big = Number(process.argv[4]);
const store = await import(pathToFileURL(${JSON.stringify(STORE_TS)}).href);
try {
  if (big > 0) {
    const payload = Array.from({ length: big * 1000 }, (_, i) => ({ i, s: 'evt-' + i }));
    for (let n = 0; n < 12; n++) store.mergeState({ [key]: { n, payload } });
  } else {
    store.mergeState({ [key]: Date.now() });
  }
  store.closeDb();
  process.stdout.write('OK');
} catch (e) {
  process.stdout.write('ERR ' + (e.errcode ?? '?') + ' ' + e.message);
}
`;

function spawnWriter(key: string, big: number): Promise<string> {
  return new Promise(res => {
    const p = spawn(process.execPath, ['--import', 'tsx', WRITER, TEST_DIR, key, String(big)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += String(d); });
    p.stderr.on('data', d => { out += String(d); });
    p.on('exit', () => res(out.trim()));
  });
}

/** Holds an exclusive write lock for HOLD_MS, then releases it cleanly. */
const HOLDER_SRC = `
import { DatabaseSync } from 'node:sqlite';
const [, , dir, holdMs] = process.argv;
const db = new DatabaseSync(dir + '/bot-state.db');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('CREATE TABLE IF NOT EXISTS state_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.exec('BEGIN IMMEDIATE');
db.exec("INSERT INTO state_kv (key, value) VALUES ('holder', '1') ON CONFLICT(key) DO UPDATE SET value='1'");
process.stdout.write('LOCKED');
const until = Date.now() + Number(holdMs);
while (Date.now() < until) { /* hold the lock */ }
db.exec('COMMIT');
db.close();
`;

function spawnHolder(dir: string, holdMs: number): Promise<{ locked: Promise<void>; done: Promise<void> }> {
  const p = spawn(process.execPath, [HOLDER, dir, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let resolveLocked: () => void;
  const locked = new Promise<void>(r => { resolveLocked = r; });
  p.stdout.on('data', d => { if (String(d).includes('LOCKED')) resolveLocked(); });
  const done = new Promise<void>(r => p.on('exit', () => r()));
  return Promise.resolve({ locked, done });
}

describe('store write contention', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(HOLDER, HOLDER_SRC);
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.STATE_DIR;
    delete process.env.STATE_BUSY_TIMEOUT_MS;
  });

  it('a write survives a lock held longer than busy_timeout', async () => {
    // A short busy_timeout makes the failure fast and deterministic instead of
    // needing a >5s hold. The point is the same: the timeout expires while the
    // lock is still held, so the transaction must retry rather than throw.
    process.env.STATE_DIR = TEST_DIR;
    process.env.STATE_BUSY_TIMEOUT_MS = '150';

    const { locked, done } = await spawnHolder(TEST_DIR, 1200);
    await locked;

    const store = await import('./store.js?contention=1');
    // Without a transaction-level retry this throws SQLITE_BUSY after 150ms.
    expect(() => store.mergeState({ lastCheckAt: 'survived' })).not.toThrow();
    await done;

    store.closeDb();
  }, 20_000);
});

describe('mergeState no-op elimination', () => {
  beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }); });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.STATE_DIR;
  });

  it('does not rewrite a key whose value is unchanged', async () => {
    // The observer polls every 5 minutes and usually finds nothing: its own logs
    // read `events=0`. Rewriting an unchanged 1.3MB blob 288 times a day is pure
    // write amplification against a shared lock on an SD-backed Pi.
    process.env.STATE_DIR = TEST_DIR;
    const store = await import('./store.js?noop=1');

    const big = { events: Array.from({ length: 500 }, (_, i) => ({ i, kind: 'x' })) };

    const first = store.mergeState({ observedEvents: big });
    expect(first.written).toBe(1);

    const second = store.mergeState({ observedEvents: big });
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(1);

    // A real change must still be written.
    const changed = { events: [...big.events, { i: 999, kind: 'y' }] };
    const third = store.mergeState({ observedEvents: changed });
    expect(third.written).toBe(1);

    // And the value on disk must be the changed one, not the skipped one.
    const state = store.loadState();
    expect((state.observedEvents as typeof changed).events).toHaveLength(501);

    store.closeDb();
  });
});

describe('store under realistic mixed load', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(WRITER, WRITER_SRC);
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.STATE_DIR;
    delete process.env.STATE_BUSY_TIMEOUT_MS;
  });

  it('every agent commits while a big-blob writer hammers the same file', async () => {
    // A SHORT busy_timeout is what gives this test teeth. Left at the 5s default
    // the handler absorbs all contention on its own, the retry budgets never
    // engage, and the test passes with or without them — proving nothing. At
    // 50ms the lock is genuinely lost mid-run and only the retry budget recovers
    // it, which is the production failure in miniature.
    process.env.STATE_BUSY_TIMEOUT_MS = '50';
    // The production shape: one observer-like process rewriting a large blob in
    // a loop, and several agent-like processes each doing the small write an
    // agent does on a run. Before the retry budgets were deadlines rather than
    // attempt counts, the agents died on open against exactly this.
    const procs = [
      spawnWriter('blob', 25),   // big payload, repeated — the observer
      spawnWriter('a1', 0),
      spawnWriter('a2', 0),
      spawnWriter('a3', 0),
      spawnWriter('a4', 0),
      spawnWriter('a5', 0),
    ];
    const results = await Promise.all(procs);
    const failures = results.filter(r => !r.startsWith('OK'));
    expect(failures).toEqual([]);

    process.env.STATE_DIR = TEST_DIR;
    const store = await import('./store.js?mixed=1');
    const state = store.loadState();
    // Every agent's key must be present: no silent lost write.
    for (const k of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      expect(state[k as keyof typeof state]).toBeDefined();
    }
    store.closeDb();
  }, 60_000);
});
