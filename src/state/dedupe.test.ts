import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * claimAlert / releaseAlert.
 *
 * Uses the real store, deliberately: claimAlert IS its SQL semantics — the
 * BEGIN IMMEDIATE compare-and-set, the NULL-means-never encoding, the prune
 * predicate. A faked store would test the fake.
 *
 * store.ts reads STATE_DIR at module load, hence the resetModules ceremony
 * (same shape as store.test.ts).
 */

const TEST_DIR = resolve(__dirname, '../../.test-dedupe-' + process.pid);

const HOUR = 60 * 60 * 1000;

let store: typeof import('./store');

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  process.env.STATE_DIR = TEST_DIR;
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  store = await import('./store');
});

afterEach(() => {
  try { store.closeDb(); } catch { /* not opened */ }
  vi.useRealTimers();
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.STATE_DIR;
});

describe('claimAlert: basic semantics', () => {
  it('claims a key that has never been alerted', () => {
    expect(store.claimAlert('risk:dd', 'stopped', 6 * HOUR)).toBe(true);
  });

  it('suppresses an unchanged fingerprint inside the ttl', () => {
    expect(store.claimAlert('risk:dd', 'stopped', 6 * HOUR)).toBe(true);
    expect(store.claimAlert('risk:dd', 'stopped', 6 * HOUR)).toBe(false);
    expect(store.claimAlert('risk:dd', 'stopped', 6 * HOUR)).toBe(false);
  });

  it('claims again when the fingerprint CHANGES inside the ttl', () => {
    expect(store.claimAlert('risk:dd', 'warning', 6 * HOUR)).toBe(true);
    expect(store.claimAlert('risk:dd', 'derisking', 6 * HOUR)).toBe(true);
    expect(store.claimAlert('risk:dd', 'derisking', 6 * HOUR)).toBe(false);
    expect(store.claimAlert('risk:dd', 'stopped', 6 * HOUR)).toBe(true);
  });

  it('keys are independent', () => {
    expect(store.claimAlert('a', 'x', 6 * HOUR)).toBe(true);
    expect(store.claimAlert('b', 'x', 6 * HOUR)).toBe(true);
  });
});

describe('claimAlert: ttl / re-nag', () => {
  it('re-nags once the ttl has elapsed', () => {
    const t0 = new Date('2026-07-16T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    expect(store.claimAlert('exec:blocked', '', 6 * HOUR)).toBe(true);

    vi.setSystemTime(new Date(t0.getTime() + 4 * HOUR));
    expect(store.claimAlert('exec:blocked', '', 6 * HOUR), 'still inside ttl').toBe(false);

    vi.setSystemTime(new Date(t0.getTime() + 7 * HOUR));
    expect(store.claimAlert('exec:blocked', '', 6 * HOUR), 'ttl elapsed — must re-nag').toBe(true);
  });

  it('an Infinity ttl never expires (once-ever alert)', () => {
    const t0 = new Date('2026-07-16T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    expect(store.claimAlert('digest:2026-07-16', '', Infinity)).toBe(true);

    vi.setSystemTime(new Date(t0.getTime() + 500 * 24 * HOUR));
    expect(store.claimAlert('digest:2026-07-16', '', Infinity)).toBe(false);
  });

  it('stores Infinity as NULL, not as a number', () => {
    store.claimAlert('once', '', Infinity);
    store.claimAlert('ttl', '', 6 * HOUR);

    // Reach into the db the way a restored/inspected db would.
    const rows = readDedupe();
    expect(rows.find((r) => r.key === 'once')!.expires_at).toBeNull();
    expect(typeof rows.find((r) => r.key === 'ttl')!.expires_at).toBe('number');
  });

  it('treats a backwards clock step as elapsed rather than suppressing', () => {
    const t0 = new Date('2026-07-16T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    expect(store.claimAlert('risk:dd', 'stopped', 6 * HOUR)).toBe(true);

    // NTP steps the Pi's clock backwards (no RTC on board).
    vi.setSystemTime(new Date(t0.getTime() - 4 * HOUR));
    expect(store.claimAlert('risk:dd', 'stopped', 6 * HOUR)).toBe(true);
  });
});

describe('claimAlert: the drawdown escalation it exists for', () => {
  it('warning → derisking ×3 → stopped over five runs sends exactly 3 times', () => {
    const t0 = new Date('2026-07-16T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    const levels = ['warning', 'derisking', 'derisking', 'derisking', 'stopped'];
    const sent: string[] = [];

    levels.forEach((level, i) => {
      vi.setSystemTime(new Date(t0.getTime() + i * 4 * HOUR)); // 4h agent cadence
      if (store.claimAlert('risk:drawdown-level', level, 12 * HOUR)) sent.push(level);
    });

    // warning, derisking (transition), stopped (transition). The two repeated
    // deriskings are suppressed — 12h ttl outlives the 4h cadence, so only real
    // transitions get through.
    expect(sent).toEqual(['warning', 'derisking', 'stopped']);
  });
});

describe('releaseAlert', () => {
  it('lets the next attempt re-send after a failed delivery', () => {
    expect(store.claimAlert('fill:abc', '', Infinity)).toBe(true);
    expect(store.claimAlert('fill:abc', '', Infinity)).toBe(false);

    store.releaseAlert('fill:abc'); // delivery failed

    expect(store.claimAlert('fill:abc', '', Infinity), 'a lost send must be retryable').toBe(true);
  });

  it('is a no-op for an unknown key', () => {
    expect(() => store.releaseAlert('never-claimed')).not.toThrow();
  });
});

describe('prune', () => {
  it('never drops never-expires rows, however many claims run', () => {
    store.claimAlert('once', '', Infinity);
    // Far more than PRUNE_ODDS (64), so the prune has certainly run many times.
    for (let i = 0; i < 500; i++) store.claimAlert(`k${i}`, '', 1);

    expect(store.claimAlert('once', '', Infinity), 'once-ever key was pruned and would re-alert').toBe(false);
    expect(readDedupe().find((r) => r.key === 'once')).toBeDefined();
  });
});

describe('claimAlert: cross-process atomicity', () => {
  // Must be real processes: DatabaseSync is synchronous, so two connections in
  // one thread cannot interleave — a single-threaded "race" proves nothing.
  it('exactly one of 8 simultaneous processes wins the same key', async () => {
    const worker = resolve(TEST_DIR, 'claim-worker.mjs');
    writeFileSync(
      worker,
      `
import { pathToFileURL } from 'node:url';
process.env.STATE_DIR = process.argv[2];
const store = await import(pathToFileURL(${JSON.stringify(resolve(__dirname, 'store.ts'))}).href);
try {
  const won = store.claimAlert('contended', 'same-fingerprint', 60_000);
  store.closeDb();
  process.stdout.write(won ? 'WON' : 'LOST');
} catch (e) {
  process.stdout.write('ERR ' + (e.errcode ?? '?') + ' ' + e.message);
}
`,
    );

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<string>((res) => {
          const c = spawn(process.execPath, ['--import', 'tsx', worker, TEST_DIR], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          let err = '';
          c.stdout.on('data', (d) => { out += d; });
          c.stderr.on('data', (d) => { err += d; });
          c.on('close', () => res(out.trim() || `ERR no-output ${err.slice(0, 200)}`));
          c.on('error', (e) => res(`ERR spawn ${e.message}`));
        }),
      ),
    );

    const errs = results.filter((r) => r.startsWith('ERR'));
    expect(errs, `claims errored:\n${errs.join('\n')}`).toEqual([]);
    expect(results.filter((r) => r === 'WON'), 'exactly one process may win a contended key').toHaveLength(1);
    expect(results.filter((r) => r === 'LOST')).toHaveLength(7);
  }, 60_000);

  it('survives a process restart (the actual production shape)', async () => {
    // Every agent run is a brand-new process, so the claim must live in SQLite,
    // not in memory.
    expect(store.claimAlert('restart-key', 'fp', 60_000)).toBe(true);

    store.closeDb();
    vi.resetModules();
    const reopened = await import('./store');

    expect(reopened.claimAlert('restart-key', 'fp', 60_000)).toBe(false);
    reopened.closeDb();
  });
});

/** Read notify_dedupe directly — asserts on-disk encoding, not the API's view. */
function readDedupe(): Array<{ key: string; expires_at: number | null }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const d = new DatabaseSync(resolve(TEST_DIR, 'bot-state.db'));
  try {
    return d.prepare('SELECT key, expires_at FROM notify_dedupe').all() as Array<{
      key: string;
      expires_at: number | null;
    }>;
  } finally {
    d.close();
  }
}
