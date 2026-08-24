import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ObservedEventState } from './store.js';

/**
 * `observedEvents` moves from a single JSON blob in state_kv to real rows.
 *
 * As one blob it was a 5000-entry array around 1.3MB that the observer had to
 * LOAD, mutate and REWRITE in full on every poll — every five minutes, under
 * `synchronous = FULL`, holding the database-wide write lock on a shared file.
 * Skipping unchanged writes removed the idle cost, but an actual event burst
 * still rewrote the entire history to append a handful of rows. Rows make an
 * append cost the size of what is appended.
 */

const TEST_DIR = resolve(__dirname, '../../.test-observed-events-' + process.pid);
// resetModules, not a query-string specifier: vitest requires literal imports,
// and the store caches its connection in module scope.
const freshStore = async () => { vi.resetModules(); return import('./store.js'); };

const evt = (cursor: number, topic = 'pnl'): ObservedEventState => ({
  cursor,
  topic,
  receivedAt: new Date(1_700_000_000_000 + cursor * 1000).toISOString(),
  resetEpoch: 1,
  payload: { v: cursor },
  observedAt: new Date(1_700_000_000_000 + cursor * 1000).toISOString(),
});

describe('observed event rows', () => {
  beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }); process.env.STATE_DIR = TEST_DIR; });
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); delete process.env.STATE_DIR; });

  it('appends and reads back in chronological order', async () => {
    const store = await freshStore();
    store.appendObservedEvents([evt(1), evt(2), evt(3)]);
    const back = store.loadObservedEvents();
    expect(back.map((e: ObservedEventState) => e.cursor)).toEqual([1, 2, 3]);
    expect(back[0].payload).toEqual({ v: 1 });
    store.closeDb();
  });

  it('an append costs only the appended rows — the history is not rewritten', async () => {
    const store = await freshStore();
    store.appendObservedEvents(Array.from({ length: 400 }, (_, i) => evt(i)));
    // The old shape rewrote all 400 to add 2. Rows must leave the rest untouched,
    // which is observable as the existing rows keeping their ids.
    const before = store.loadObservedEventRows().map((r: { id: number }) => r.id);
    store.appendObservedEvents([evt(1000), evt(1001)]);
    const after = store.loadObservedEventRows().map((r: { id: number }) => r.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(402);
    store.closeDb();
  });

  it('filters by topic without loading the rest', async () => {
    const store = await freshStore();
    store.appendObservedEvents([evt(1, 'pnl'), evt(2, 'orders'), evt(3, 'pnl'), evt(4, 'gap')]);
    const pnl = store.loadObservedEvents({ topic: 'pnl' });
    expect(pnl.map((e: ObservedEventState) => e.cursor)).toEqual([1, 3]);
    store.closeDb();
  });

  it('trims to the cap, dropping oldest first', async () => {
    const store = await freshStore();
    store.appendObservedEvents(Array.from({ length: 12 }, (_, i) => evt(i)), 5);
    const back = store.loadObservedEvents();
    expect(back).toHaveLength(5);
    expect(back.map((e: ObservedEventState) => e.cursor)).toEqual([7, 8, 9, 10, 11]);
    store.closeDb();
  });

  it('limit returns the MOST RECENT n, still in chronological order', async () => {
    const store = await freshStore();
    store.appendObservedEvents(Array.from({ length: 10 }, (_, i) => evt(i)));
    const back = store.loadObservedEvents({ limit: 3 });
    expect(back.map((e: ObservedEventState) => e.cursor)).toEqual([7, 8, 9]);
    store.closeDb();
  });

  it('migrates an existing blob into rows, once, and removes the blob', async () => {
    const store = await freshStore();
    // Seed the OLD shape directly, as a real upgrade would find it.
    const legacy = Array.from({ length: 30 }, (_, i) => evt(i));
    store.mergeState({ observedEvents: legacy });
    expect((store.loadState().observedEvents as unknown[]).length).toBe(30);

    const moved = store.migrateObservedEvents();
    expect(moved).toBe(30);
    expect(store.loadObservedEvents()).toHaveLength(30);
    // The blob must be gone, or it would be migrated again and double the rows.
    expect(store.loadState().observedEvents).toBeUndefined();

    // Idempotent: a second run finds nothing to do.
    expect(store.migrateObservedEvents()).toBe(0);
    expect(store.loadObservedEvents()).toHaveLength(30);
    store.closeDb();
  });

  it('preserves every field across the migration', async () => {
    const store = await freshStore();
    const one = evt(42, 'orders');
    store.mergeState({ observedEvents: [one] });
    store.migrateObservedEvents();
    expect(store.loadObservedEvents()[0]).toEqual(one);
    store.closeDb();
  });
});
