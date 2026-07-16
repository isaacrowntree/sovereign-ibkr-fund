import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Cross-process concurrency guard for store.ts's db() open.
 *
 * These MUST spawn real processes. DatabaseSync is synchronous, so two
 * connections opened in one thread cannot interleave — a single-threaded
 * "race" is just the reopen test under another name, and a genuine interleave
 * would deadlock for the full busy_timeout and then throw.
 *
 * Regression target: db() used to run `PRAGMA journal_mode = WAL` before
 * `PRAGMA busy_timeout`. SQLite does not invoke the busy handler on the
 * journal_mode path, so concurrent opens threw SQLITE_BUSY (errcode 5)
 * outright — reproduced at 3-4 failures per 8 processes before the fix.
 *
 * Why it matters beyond a crash: every agent is a separate `--once` process
 * that opens this db on startup. risk-manager dying on open means the drawdown
 * gate is never persisted and the hard stop silently does not fire.
 */

const TEST_DIR = resolve(__dirname, '../../.test-store-concurrency-' + process.pid);
const WORKER = resolve(TEST_DIR, 'worker.mjs');
const STORE_TS = resolve(__dirname, 'store.ts');
const PROCS = 8;

// Imports the .ts directly via tsx so the test tracks source rather than dist.
const WORKER_SRC = `
import { pathToFileURL } from 'node:url';
process.env.STATE_DIR = process.argv[2];
const store = await import(pathToFileURL(${JSON.stringify(STORE_TS)}).href);
try {
  // Force an open plus a write — what an agent startup actually does.
  store.mergeState({ ['k' + process.argv[3]]: process.argv[3] });
  store.closeDb();
  process.stdout.write('OK');
} catch (e) {
  process.stdout.write('ERR ' + (e.errcode ?? '?') + ' ' + e.message);
  process.exit(1);
}
`;

function runWorker(i: number): Promise<string> {
  return new Promise((res) => {
    const c = spawn(process.execPath, ['--import', 'tsx', WORKER, TEST_DIR, String(i)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', () => res(out.trim() || `ERR no-output ${err.slice(0, 300)}`));
    c.on('error', (e) => res(`ERR spawn ${e.message}`));
  });
}

describe('store: concurrent opens across processes', () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(WORKER, WORKER_SRC);
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('opens a fresh db from 8 simultaneous processes with zero errors', async () => {
    const results = await Promise.all(Array.from({ length: PROCS }, (_, i) => runWorker(i)));
    const errs = results.filter((r) => !r.startsWith('OK'));

    expect(errs, `concurrent opens failed:\n${errs.join('\n')}`).toEqual([]);
    expect(results).toHaveLength(PROCS);
  }, 60_000);

  it('all 8 processes commit their write (no lost updates)', async () => {
    await Promise.all(Array.from({ length: PROCS }, (_, i) => runWorker(i)));

    process.env.STATE_DIR = TEST_DIR;
    const store = await import('./store.js');
    try {
      const state = store.loadState();
      for (let i = 0; i < PROCS; i++) {
        expect(state[`k${i}`], `process ${i}'s mergeState was lost`).toBe(String(i));
      }
    } finally {
      store.closeDb();
      delete process.env.STATE_DIR;
    }
  }, 60_000);
});

/**
 * appendTrade's at-most-once guarantee, under real concurrency.
 *
 * store.ts documents: "the store itself guarantees a fill is recorded at most
 * once... so callers never need their own dedup". That guarantee is the reason
 * no caller does its own dedup — so if it doesn't hold, a fill is silently
 * double-recorded and every downstream number (FIFO basis, realised P&L,
 * wash-sale windows, CGT) is computed from an inflated book.
 *
 * The dup-check and the insert have to be in ONE transaction. Without it they
 * autocommit separately, so two processes both see no dup and both insert.
 */
const TRADE_WORKER_SRC = `
import { pathToFileURL } from 'node:url';
process.env.STATE_DIR = process.argv[2];
const store = await import(pathToFileURL(${JSON.stringify(STORE_TS)}).href);

// Open (and run any migration) BEFORE the barrier, so the contention is on
// appendTrade itself and not on node/tsx startup — which otherwise staggers the
// processes by ~100ms each and hides the race entirely.
store.loadState();

// Barrier: spin until a shared wall-clock instant so all processes reach
// appendTrade together.
const startAt = Number(process.argv[4]);
while (Date.now() < startAt) { /* spin */ }

try {
  // Every process appends the SAME fill — exactly what happens when the
  // executor's WS path and the reconcile path both surface one fill.
  store.appendTrade({
    timestamp: '2026-07-16T14:00:00Z', symbol: 'VTI', action: 'BUY', qty: 100,
    estimatedValue: 25000, fillPrice: 250, orderId: 1042, status: 'filled',
    reason: 'rebalance', execId: process.argv[3] === 'execid' ? 'E-SAME' : undefined,
  });
  store.closeDb();
  process.stdout.write('OK');
} catch (e) {
  process.stdout.write('ERR ' + (e.errcode ?? '?') + ' ' + e.message);
  process.exit(1);
}
`;

function runTradeWorker(mode: 'execid' | 'natural', startAt: number): Promise<string> {
  return new Promise((res) => {
    const c = spawn(process.execPath, ['--import', 'tsx', WORKER, TEST_DIR, mode, String(startAt)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', () => res(out.trim() || `ERR no-output ${err.slice(0, 300)}`));
    c.on('error', (e) => res(`ERR spawn ${e.message}`));
  });
}

describe('store: appendTrade is at-most-once across processes', () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(WORKER, TRADE_WORKER_SRC);
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it.each(['execid', 'natural'] as const)(
    'records the same fill once when 8 processes append it simultaneously (%s key)',
    async (mode) => {
      // Generous enough for node+tsx boot in every worker, so they all clear
      // startup and hit the barrier before it releases.
      const startAt = Date.now() + 4_000;
      const results = await Promise.all(Array.from({ length: PROCS }, () => runTradeWorker(mode, startAt)));
      const errs = results.filter((r) => !r.startsWith('OK'));
      expect(errs, `appends errored:\n${errs.join('\n')}`).toEqual([]);

      process.env.STATE_DIR = TEST_DIR;
      const store = await import('./store.js');
      try {
        const history = store.loadTradeHistory();
        expect(
          history,
          `the same fill was recorded ${history.length}x — the ledger now says ` +
            `${history.reduce((s, t) => s + t.qty, 0)} shares moved, not 100`,
        ).toHaveLength(1);
      } finally {
        store.closeDb();
        delete process.env.STATE_DIR;
      }
    },
    60_000,
  );
});
