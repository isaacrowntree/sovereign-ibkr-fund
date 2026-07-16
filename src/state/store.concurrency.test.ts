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
