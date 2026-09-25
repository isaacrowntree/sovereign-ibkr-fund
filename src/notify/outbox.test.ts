import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drainOutbox, nextRetryDelay, type OutboxStore } from './outbox.js';
import type { OutboxRow } from '../state/store.js';
import type { NotifyEvent } from './index.js';

/** An in-memory outbox with the same CAS semantics as the SQLite one. */
function fakeStore(rows: OutboxRow[]) {
  const store: OutboxStore & { rows: OutboxRow[] } = {
    rows,
    due: (now, limit) => store.rows.filter((r) => r.nextAt <= now).slice(0, limit).map((r) => ({ ...r })),
    lease: (row, until, now) => {
      const r = store.rows.find((x) => x.key === row.key && x.createdAt === row.createdAt &&
        x.attempts === row.attempts && x.nextAt <= now);
      if (!r) return false;
      r.nextAt = until;
      return true;
    },
    reschedule: (row, nextAt, error) => {
      const r = store.rows.find((x) => x.key === row.key && x.createdAt === row.createdAt);
      if (r) { r.attempts++; r.nextAt = nextAt; r.lastError = error; }
    },
    remove: (key, createdAt) => { store.rows = store.rows.filter((x) => !(x.key === key && x.createdAt === createdAt)); },
  };
  return store;
}

const NOW = 1_800_000_000_000;
const ev = (title: string): string => JSON.stringify({ severity: 'critical', page: 'fund-disconnect', title } satisfies NotifyEvent);
const row = (key: string, over: Partial<OutboxRow> = {}): OutboxRow => ({
  key, event: ev(key), attempts: 0, createdAt: NOW - 60_000, nextAt: NOW - 1, lastError: null, ...over,
});

const saved = process.env.NOTIFY_OUTBOX;
beforeEach(() => { process.env.NOTIFY_OUTBOX = '1'; });
afterEach(() => { if (saved === undefined) delete process.env.NOTIFY_OUTBOX; else process.env.NOTIFY_OUTBOX = saved; });

describe('drainOutbox', () => {
  it('delivers due rows and removes them', async () => {
    const store = fakeStore([row('a'), row('b')]);
    const sent: string[] = [];
    const r = await drainOutbox(store, { now: NOW, send: async (e) => { sent.push(e.title); return true; } });
    expect(sent).toEqual(['a', 'b']);
    expect(r).toEqual({ delivered: 2, retried: 0, dropped: 0 });
    expect(store.rows).toEqual([]);
  });

  it('leaves rows that are not yet due alone', async () => {
    const store = fakeStore([row('later', { nextAt: NOW + 1 })]);
    const r = await drainOutbox(store, { now: NOW, send: async () => true });
    expect(r.delivered).toBe(0);
    expect(store.rows).toHaveLength(1);
  });

  it('a failed retry backs off and records why', async () => {
    const store = fakeStore([row('a', { attempts: 2 })]);
    const r = await drainOutbox(store, { now: NOW, send: async () => false });
    expect(r.retried).toBe(1);
    expect(store.rows[0].attempts).toBe(3);
    expect(store.rows[0].nextAt).toBe(NOW + nextRetryDelay(2));
    expect(store.rows[0].lastError).toBe('not accepted');
  });

  it('a send that THROWS is a failed retry, not a crash', async () => {
    const store = fakeStore([row('a')]);
    const r = await drainOutbox(store, { now: NOW, send: async () => { throw new Error('boom'); } });
    expect(r.retried).toBe(1);
    expect(store.rows[0].lastError).toBe('boom');
  });

  it('gives up on an event older than maxAge, without sending it', async () => {
    const store = fakeStore([row('old', { createdAt: NOW - 25 * 3_600_000 })]);
    let calls = 0;
    const r = await drainOutbox(store, { now: NOW, send: async () => { calls++; return true; } });
    expect(calls).toBe(0);
    expect(r.dropped).toBe(1);
    expect(store.rows).toEqual([]);
  });

  it('never delivers a queued event the paging policy does not allow — it is dropped, unsent', async () => {
    const store = fakeStore([row('risk', { event: JSON.stringify({ severity: 'critical', title: 'risk' }) })]);
    let calls = 0;
    const r = await drainOutbox(store, { now: NOW, send: async () => { calls++; return true; } });
    expect(calls).toBe(0);
    expect(r).toEqual({ delivered: 0, retried: 0, dropped: 1 });
    expect(store.rows).toEqual([]);
  });

  it('drops an unreadable row rather than retrying it forever', async () => {
    const store = fakeStore([row('bad', { event: '{not json' })]);
    const r = await drainOutbox(store, { now: NOW, send: async () => true });
    expect(r.dropped).toBe(1);
    expect(store.rows).toEqual([]);
  });

  it('does not send a row another drainer has leased', async () => {
    const store = fakeStore([row('a')]);
    store.lease = () => false;
    let calls = 0;
    await drainOutbox(store, { now: NOW, send: async () => { calls++; return true; } });
    expect(calls).toBe(0);
  });

  it('is a no-op when NOTIFY_OUTBOX is off — the kill switch stops the drainer too', async () => {
    delete process.env.NOTIFY_OUTBOX;
    const store = fakeStore([row('a')]);
    let calls = 0;
    await drainOutbox(store, { now: NOW, send: async () => { calls++; return true; } });
    expect(calls).toBe(0);
    expect(store.rows).toHaveLength(1);
  });

  it('never throws, even when the store does', async () => {
    const store = fakeStore([]);
    store.due = () => { throw new Error('db locked'); };
    await expect(drainOutbox(store, { now: NOW })).resolves.toEqual({ delivered: 0, retried: 0, dropped: 0 });
  });

  it('bounds a single drain to the batch size', async () => {
    const store = fakeStore(Array.from({ length: 30 }, (_, i) => row(`k${i}`)));
    const r = await drainOutbox(store, { now: NOW, batch: 5, send: async () => true });
    expect(r.delivered).toBe(5);
    expect(store.rows).toHaveLength(25);
  });
});

describe('nextRetryDelay', () => {
  it('doubles from 5 minutes and caps at an hour', () => {
    expect([0, 1, 2, 3, 4, 10].map((a) => nextRetryDelay(a) / 60_000)).toEqual([5, 10, 20, 40, 60, 60]);
  });
});
