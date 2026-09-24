import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The execution run lock as a lease: compare-and-set inside one transaction,
 * renewed by a heartbeat, no pid. A pid was the old liveness test and it lies
 * across a container restart (the new container's pid 1 is "alive").
 */
const TEST_DIR = resolve(__dirname, '../../.test-lease-' + process.pid);
let store: typeof import('./store');

beforeEach(async () => {
  vi.resetModules();
  process.env.STATE_DIR = TEST_DIR;
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  store = await import('./store');
});

afterEach(() => {
  try { store?.closeDb(); } catch {}
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.STATE_DIR;
});

const T0 = Date.parse('2026-09-24T14:00:00Z');
const KEY = 'executionRunLock';

describe('acquireLease', () => {
  it('takes a free lease and stores the record with holder + leaseUntil', () => {
    const r = store.acquireLease(KEY, 'run-a', 60_000, { phase: 'starting' }, { now: T0 });
    expect(r).toEqual({ acquired: true, previous: null });
    expect(store.loadState()[KEY]).toEqual({
      phase: 'starting', holder: 'run-a', leaseUntil: new Date(T0 + 60_000).toISOString(),
    });
  });

  it('refuses while another holder\'s lease is live, and reports it', () => {
    store.acquireLease(KEY, 'run-a', 60_000, {}, { now: T0 });
    const r = store.acquireLease(KEY, 'run-b', 60_000, {}, { now: T0 + 59_000 });
    expect(r.acquired).toBe(false);
    expect(r.previous?.holder).toBe('run-a');
    expect((store.loadState()[KEY] as { holder: string }).holder).toBe('run-a');
  });

  it('takes over a lapsed lease and hands back the abandoned record for a post-mortem', () => {
    store.acquireLease(KEY, 'run-a', 60_000, { phase: 'confirming:NET' }, { now: T0 });
    const r = store.acquireLease(KEY, 'run-b', 60_000, {}, { now: T0 + 60_001 });
    expect(r.acquired).toBe(true);
    expect(r.previous).toMatchObject({ holder: 'run-a', phase: 'confirming:NET' });
  });

  it('respects a pre-lease lock (no leaseUntil) by its start time', () => {
    store.mergeState({ [KEY]: { at: new Date(T0).toISOString(), pid: 123, phase: 'execute-queue' } });
    const opts = { legacyStaleMs: 35 * 60_000 };
    expect(store.acquireLease(KEY, 'run-b', 60_000, {}, { ...opts, now: T0 + 60_000 }).acquired).toBe(false);
    expect(store.acquireLease(KEY, 'run-b', 60_000, {}, { ...opts, now: T0 + 36 * 60_000 }).acquired).toBe(true);
  });

  it('treats a released (null) lock as free', () => {
    store.mergeState({ [KEY]: null });
    expect(store.acquireLease(KEY, 'run-a', 60_000, {}, { now: T0 }).acquired).toBe(true);
  });
});

describe('renewLease / releaseLease', () => {
  it('a heartbeat keeps the lease past its first expiry', () => {
    store.acquireLease(KEY, 'run-a', 60_000, {}, { now: T0 });
    expect(store.renewLease(KEY, 'run-a', 60_000, { phase: 'placing:NET' }, { now: T0 + 30_000 })).toBe(true);
    expect(store.acquireLease(KEY, 'run-b', 60_000, {}, { now: T0 + 80_000 }).acquired).toBe(false);
    expect(store.loadState()[KEY]).toMatchObject({ holder: 'run-a', phase: 'placing:NET' });
  });

  it('a holder that lost the lease cannot renew it — it learns it must stop', () => {
    store.acquireLease(KEY, 'run-a', 60_000, {}, { now: T0 });
    store.acquireLease(KEY, 'run-b', 60_000, {}, { now: T0 + 61_000 });
    expect(store.renewLease(KEY, 'run-a', 60_000, {}, { now: T0 + 62_000 })).toBe(false);
    expect((store.loadState()[KEY] as { holder: string }).holder).toBe('run-b');
  });

  it('release only clears the caller\'s own lease', () => {
    store.acquireLease(KEY, 'run-a', 60_000, {}, { now: T0 });
    expect(store.releaseLease(KEY, 'run-b')).toBe(false);
    expect(store.releaseLease(KEY, 'run-a')).toBe(true);
    expect(store.loadState()[KEY]).toBeNull();
  });
});

describe('acquireLease across processes', () => {
  // Real processes, as in store.concurrency.test.ts: DatabaseSync is
  // synchronous, so an in-thread "race" cannot interleave.
  it('exactly one of eight concurrent runs gets the lease', async () => {
    const { spawn } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const worker = resolve(TEST_DIR, 'lease-worker.mjs');
    writeFileSync(worker, `
import { pathToFileURL } from 'node:url';
process.env.STATE_DIR = process.argv[2];
const store = await import(pathToFileURL(${JSON.stringify(resolve(__dirname, 'store.ts'))}).href);
const r = store.acquireLease('executionRunLock', 'run-' + process.argv[3], 60000);
store.closeDb();
process.stdout.write(r.acquired ? 'WON' : 'LOST');
`);
    const run = (i: number) => new Promise<string>((res) => {
      const c = spawn(process.execPath, ['--import', 'tsx', worker, TEST_DIR, String(i)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => res(out.trim()));
    });
    store.closeDb();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
    expect(results.filter(r => r === 'WON')).toHaveLength(1);
    expect(results.filter(r => r === 'LOST')).toHaveLength(7);
  }, 60_000);
});
