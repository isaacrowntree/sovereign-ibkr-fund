/**
 * The execution run lock: a lease in the state db, renewed by a heartbeat.
 *
 * It used to be `{at, pid}` read with loadState() and written with
 * mergeState() — two transactions apart, so two runs starting together could
 * both see it free — and "is it still held?" was `process.kill(pid, 0)`. A pid
 * says nothing across a container restart (the new container reuses low pids)
 * and nothing about a process in another container, so a dead run's lock could
 * look alive and a live one dead. The fallback was a 35-minute staleness rule,
 * which meant a killed run blocked execution for 35 minutes.
 *
 * Now: taking the lock is a compare-and-set inside one transaction
 * (store.acquireLease), the holder is a random token, and the lock is only
 * held while it keeps being renewed. A run that dies stops renewing and its
 * lease lapses within RUN_LEASE_SEC; a run that loses its lease (a stall long
 * enough for another run to take over) finds out on its next heartbeat and
 * stops placing orders.
 *
 * The record doubles as the flight recorder (run-recorder.ts): each phase
 * change is written through the lease, so a killed run still leaves where it
 * got to.
 */
import { randomBytes } from 'node:crypto';
import {
  acquireLease as storeAcquire,
  renewLease as storeRenew,
  releaseLease as storeRelease,
  type LeaseAcquireResult,
} from '../state/store.js';

export interface RunLockStore {
  acquireLease: typeof storeAcquire;
  renewLease: typeof storeRenew;
  releaseLease: typeof storeRelease;
}

export interface RunLockOptions {
  key?: string;
  /** How long the lease lasts without a heartbeat. */
  leaseMs: number;
  /** Heartbeat period; default a quarter of the lease. */
  heartbeatMs?: number;
  /** How long a pre-lease lock (`{at, pid}`) is honoured — the old staleness rule. */
  legacyStaleMs: number;
  holder?: string;
  store?: RunLockStore;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (h: unknown) => void;
  onError?: (msg: string, err: unknown) => void;
}

export interface RunLock {
  readonly holder: string;
  acquire(record: Record<string, unknown>): LeaseAcquireResult;
  /** Merge `patch` into the record and renew. False when the lease is gone. */
  update(patch: Record<string, unknown>): boolean;
  /** Do we still hold it? False once a renew found someone else, or renewals failed past the lease. */
  held(): boolean;
  release(): void;
}

/** RUN_LEASE_SEC, default 120 s. The heartbeat runs every quarter of it. */
export function runLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const s = parseFloat(env.RUN_LEASE_SEC ?? '');
  return Number.isFinite(s) && s >= 10 ? s * 1000 : 120_000;
}

export function newRunId(): string {
  // Short on purpose: it prefixes every cOID, and IBKR echoes those back.
  return randomBytes(4).toString('hex');
}

export function createRunLock(opts: RunLockOptions): RunLock {
  const key = opts.key ?? 'executionRunLock';
  const store: RunLockStore = opts.store ?? {
    acquireLease: storeAcquire, renewLease: storeRenew, releaseLease: storeRelease,
  };
  const now = opts.now ?? Date.now;
  const every = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stop = opts.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));
  const holder = opts.holder ?? newRunId();
  const heartbeatMs = opts.heartbeatMs ?? Math.max(1000, Math.floor(opts.leaseMs / 4));

  let acquired = false;
  let lost = false;
  let lastRenewAt = 0;
  let timer: unknown = null;

  const renew = (patch: Record<string, unknown>): boolean => {
    if (!acquired || lost) return false;
    try {
      if (store.renewLease(key, holder, opts.leaseMs, patch, { now: now() })) {
        lastRenewAt = now();
        return true;
      }
      lost = true;
      opts.onError?.(`Run lock ${key} was taken by another run — this run no longer holds it`, undefined);
      return false;
    } catch (e) {
      // A busy db is not a lost lease; held() lapses it if this persists.
      opts.onError?.(`Run lock heartbeat failed`, e);
      return false;
    }
  };

  return {
    holder,
    acquire(record) {
      const r = store.acquireLease(key, holder, opts.leaseMs, record, { now: now(), legacyStaleMs: opts.legacyStaleMs });
      if (r.acquired) {
        acquired = true;
        lastRenewAt = now();
        const h = every(() => { renew({}); }, heartbeatMs);
        h.unref?.();
        timer = h;
      }
      return r;
    },
    update: (patch) => renew(patch),
    held: () => acquired && !lost && now() - lastRenewAt < opts.leaseMs,
    release() {
      if (timer !== null) { stop(timer); timer = null; }
      if (!acquired) return;
      acquired = false;
      try { store.releaseLease(key, holder); } catch (e) { opts.onError?.('Run lock release failed', e); }
    },
  };
}
