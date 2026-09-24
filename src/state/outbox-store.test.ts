import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/** The outbox's SQLite half, against a real database — the CAS is the point. */
const TEST_DIR = resolve(__dirname, '../../.test-state-outbox-' + process.pid);
let store: typeof import('./store');

beforeEach(async () => {
  vi.resetModules();
  process.env.STATE_DIR = TEST_DIR;
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  store = await import('./store');
});

afterEach(() => {
  try { store?.closeDb(); } catch { /* */ }
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.STATE_DIR;
});

describe('notify outbox store', () => {
  it('enqueues a row that is due immediately', () => {
    store.outboxEnqueue('k', '{"title":"a"}', 1000);
    expect(store.outboxDue(1000).map((r) => [r.key, r.event, r.attempts])).toEqual([['k', '{"title":"a"}', 0]]);
    expect(store.outboxDue(999)).toEqual([]);
  });

  it('a newer event under the same key REPLACES the queued one and resets its schedule', () => {
    store.outboxEnqueue('k', '{"title":"old"}', 1000);
    const [r] = store.outboxDue(1000);
    store.outboxReschedule(r, 9000, 'x');
    store.outboxEnqueue('k', '{"title":"new"}', 2000);
    const rows = store.outboxAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: '{"title":"new"}', attempts: 0, nextAt: 2000, lastError: null });
  });

  it('lease is a compare-and-set: the second taker loses', () => {
    store.outboxEnqueue('k', '{}', 1000);
    const [r] = store.outboxDue(1000);
    expect(store.outboxLease(r, 5000, 1000)).toBe(true);
    expect(store.outboxLease(r, 5000, 1000)).toBe(false);
  });

  it('a lease on a superseded version fails, so the old event is never sent', () => {
    store.outboxEnqueue('k', '{"v":1}', 1000);
    const [old] = store.outboxDue(1000);
    store.outboxEnqueue('k', '{"v":2}', 1500);
    expect(store.outboxLease(old, 5000, 1500)).toBe(false);
  });

  it('removing a delivered OLD version keeps a newer one queued meanwhile', () => {
    store.outboxEnqueue('k', '{"v":1}', 1000);
    const [old] = store.outboxDue(1000);
    store.outboxEnqueue('k', '{"v":2}', 1500);
    store.outboxDelete('k', old.createdAt);
    expect(store.outboxAll().map((r) => r.event)).toEqual(['{"v":2}']);
    store.outboxDelete('k');
    expect(store.outboxAll()).toEqual([]);
  });
});
