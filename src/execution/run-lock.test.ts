import { describe, it, expect } from 'vitest';
import { createRunLock, runLeaseMs, type RunLockStore } from './run-lock.js';

/** In-memory store with the same CAS semantics as store.acquireLease & co. */
function fakeStore() {
  const kv = new Map<string, Record<string, unknown> | null>();
  const live = (r: Record<string, unknown> | null | undefined, now: number) =>
    !!r && Date.parse(String(r.leaseUntil)) > now;
  const store: RunLockStore = {
    acquireLease: (key, holder, leaseMs, record = {}, o = {}) => {
      const prev = kv.get(key) ?? null;
      if (live(prev, o.now!) && prev?.holder !== holder) return { acquired: false, previous: prev };
      kv.set(key, { ...record, holder, leaseUntil: new Date(o.now! + leaseMs).toISOString() });
      return { acquired: true, previous: prev };
    },
    renewLease: (key, holder, leaseMs, patch = {}, o = {}) => {
      const prev = kv.get(key);
      if (!prev || prev.holder !== holder) return false;
      kv.set(key, { ...prev, ...patch, leaseUntil: new Date(o.now! + leaseMs).toISOString() });
      return true;
    },
    releaseLease: (key, holder) => {
      const prev = kv.get(key);
      if (!prev || prev.holder !== holder) return false;
      kv.set(key, null);
      return true;
    },
  };
  return { store, kv };
}

function harness() {
  let t = Date.parse('2026-09-24T14:00:00Z');
  const ticks: Array<() => void> = [];
  const { store, kv } = fakeStore();
  const make = (holder: string) => createRunLock({
    leaseMs: 60_000, legacyStaleMs: 0, holder, store,
    now: () => t,
    setInterval: (fn) => { ticks.push(fn); return {}; },
    clearInterval: () => { ticks.length = 0; },
  });
  return { make, kv, advance: (ms: number) => { t += ms; }, beat: () => ticks.forEach(f => f()) };
}

describe('run lock', () => {
  it('a second run cannot start while the first keeps heartbeating', () => {
    const h = harness();
    const a = h.make('a');
    expect(a.acquire({ phase: 'starting' }).acquired).toBe(true);
    for (let i = 0; i < 10; i++) { h.advance(15_000); h.beat(); }
    expect(a.held()).toBe(true);
    expect(h.make('b').acquire({}).acquired).toBe(false);
  });

  it('a run that stops heartbeating (killed) frees the lock within one lease — not 35 minutes', () => {
    const h = harness();
    h.make('a').acquire({ phase: 'confirming:NET' });
    h.advance(61_000); // no beats: the process is gone
    const r = h.make('b').acquire({});
    expect(r.acquired).toBe(true);
    expect(r.previous).toMatchObject({ holder: 'a', phase: 'confirming:NET' });
  });

  it('a stalled run that lost its lease knows it and stops holding', () => {
    const h = harness();
    const a = h.make('a');
    a.acquire({});
    h.advance(61_000);
    expect(a.held()).toBe(false); // lapsed locally even before anyone else looks
    h.make('b').acquire({});
    expect(a.update({ phase: 'placing:X' })).toBe(false);
    expect(a.held()).toBe(false);
    expect(h.kv.get('executionRunLock')).toMatchObject({ holder: 'b' });
  });

  it('phase updates land in the record and renew it', () => {
    const h = harness();
    const a = h.make('a');
    a.acquire({ phase: 'starting' });
    h.advance(50_000);
    expect(a.update({ phase: 'placing:NET' })).toBe(true);
    h.advance(50_000);
    expect(a.held()).toBe(true);
    expect(h.kv.get('executionRunLock')).toMatchObject({ phase: 'placing:NET' });
  });

  it('release clears only our own lock', () => {
    const h = harness();
    const a = h.make('a');
    a.acquire({});
    a.release();
    expect(h.kv.get('executionRunLock')).toBeNull();
    expect(a.held()).toBe(false);
  });

  it('RUN_LEASE_SEC sets the lease; nonsense falls back to 120 s', () => {
    expect(runLeaseMs({ RUN_LEASE_SEC: '90' })).toBe(90_000);
    expect(runLeaseMs({ RUN_LEASE_SEC: '2' })).toBe(120_000);
    expect(runLeaseMs({})).toBe(120_000);
  });
});
