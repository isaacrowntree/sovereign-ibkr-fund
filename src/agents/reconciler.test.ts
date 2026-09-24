import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reconcile, isNotAuthenticated, type ReconcileDeps } from './reconciler.js';
import type { AccountSummary, Position } from '../connection/gateway.js';
import type { FundState, TradeRecord } from '../state/store.js';
import type { NotifyEvent } from '../notify/index.js';
import { TARGET_PORTFOLIO } from '../config.js';

/** The model book, held exactly — conformance passes, so the tests isolate drift. */
function modelPositions(extra: Record<string, number> = {}): Position[] {
  return TARGET_PORTFOLIO.map((t) => ({
    symbol: t.symbol, qty: 100 + (extra[t.symbol] ?? 0), avgCost: 1, marketValue: t.pct * 1000, marketPrice: 1,
  }));
}

/** A ledger that implies 100 of every model name. */
function ledger(): TradeRecord[] {
  return TARGET_PORTFOLIO.map((t, i) => ({
    timestamp: '2026-01-01T00:00:00Z', symbol: t.symbol, action: 'BUY', qty: 100,
    estimatedValue: 1, orderId: i + 1, status: 'Filled', reason: 'test',
  }));
}

function fakeDeps(over: Partial<ReconcileDeps> & { state?: FundState; positions?: Position[] } = {}) {
  const state: FundState = { ...(over.state ?? {}) };
  const events: NotifyEvent[] = [];
  const sleeps: number[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const deps: ReconcileDeps = {
    connect: async () => {},
    getAccountSummary: async (): Promise<AccountSummary> =>
      ({ netLiquidation: 1, totalCashValue: 0, positions: over.positions ?? modelPositions() }),
    loadState: () => ({ ...state }),
    mergeState: (u) => { writes.push(u); Object.assign(state, u); },
    loadTradeHistory: ledger,
    notify: async (e) => { events.push(e); },
    sleep: async (ms) => { sleeps.push(ms); },
    ...over,
  };
  return { deps, state, events, sleeps, writes };
}

const saved = { ...process.env };
beforeEach(() => { delete process.env.RECONCILE_DRIFT_REF; delete process.env.RECONCILE_AUTH_RETRY_MIN; });
afterEach(() => { process.env = { ...saved }; });

describe('a logged-out gateway defers the run instead of failing it', () => {
  const notAuthed = () => Object.assign(new Error('bezant-server 401 on /health: not_authenticated'), { status: 401 });

  it('retries with backoff up to 30 minutes, then defers with a push and exit-0 outcome', async () => {
    const f = fakeDeps({ connect: async () => { throw notAuthed(); } });
    expect(await reconcile(f.deps)).toBe('deferred');
    expect(f.sleeps.map((ms) => ms / 60_000)).toEqual([1, 2, 4, 8, 15]);
    expect(f.events).toHaveLength(1);
    expect(f.events[0].title).toContain('deferred');
    expect(f.events[0].channel).toBeUndefined(); // a push, not just the feed
    expect(f.writes).toEqual([]); // nothing recorded — in particular not lastReconcileAt
  });

  it('carries on normally once a retry gets a session', async () => {
    let calls = 0;
    const f = fakeDeps({ connect: async () => { if (++calls < 3) throw notAuthed(); } });
    expect(await reconcile(f.deps)).toBe('reconciled');
    expect(f.sleeps).toHaveLength(2);
  });

  it('any other connect failure still fails the run (so the unit alerts)', async () => {
    const f = fakeDeps({ connect: async () => { throw new Error('fetch failed'); } });
    await expect(reconcile(f.deps)).rejects.toThrow('fetch failed');
    expect(f.sleeps).toEqual([]);
  });

  it('recognises both spellings of logged out', () => {
    expect(isNotAuthenticated({ status: 401 })).toBe(true);
    expect(isNotAuthenticated(new Error('bezant-server reachable but Gateway is not authenticated — log in'))).toBe(true);
    expect(isNotAuthenticated(new Error('bezant-server 502 on /health'))).toBe(false);
  });
});

describe('empty positions are unknown, not a liquidation', () => {
  it('writes nothing and warns when the ledger implies holdings', async () => {
    const f = fakeDeps({ positions: [], state: { ledgerDriftSignature: '', ledgerDriftBaseline: '' } });
    expect(await reconcile(f.deps)).toBe('unknown');
    expect(f.writes).toEqual([]);
    expect(f.events.map((e) => e.title)).toEqual(['Reconcile skipped — IBKR reported no positions']);
  });

  it('a book that really is empty on both sides reconciles without dividing by zero', async () => {
    const f = fakeDeps({ positions: [], loadTradeHistory: () => [], state: { ledgerDriftBaseline: '' } });
    expect(await reconcile(f.deps)).toBe('reconciled');
    expect(f.state.ledgerDriftSignature).toBe('');
    expect(f.events).toEqual([]);
  });
});

describe('ledger drift is measured against the ACCEPTED baseline', () => {
  const base = { ledgerDriftBaseline: '', ledgerDriftSignature: '' };

  it('quiet when the broker matches ledger + baseline', async () => {
    const f = fakeDeps({ state: base });
    await reconcile(f.deps);
    expect(f.events).toEqual([]);
    expect(f.state.ledgerDriftAlerting).toBe(false);
  });

  it('an unrecorded fill alerts — and KEEPS alerting on the next run, not just once', async () => {
    const sym = TARGET_PORTFOLIO[0].symbol;
    const f = fakeDeps({ state: base, positions: modelPositions({ [sym]: 5 }) });
    await reconcile(f.deps);
    await reconcile(f.deps);
    const drift = f.events.filter((e) => e.title.startsWith('Ledger no longer'));
    expect(drift).toHaveLength(2); // the dedupe ttl, not the reconciler, decides re-nags
    expect(drift[1].severity).toBe('critical');
    expect(drift[1].dedupe).toEqual({ key: 'reconciler:ledger-drift', fingerprint: `${sym}:5` });
    expect(f.state.ledgerDriftAlerting).toBe(true);
    // The baseline is never absorbed by the reconciler.
    expect(f.state.ledgerDriftBaseline).toBe('');
  });

  it('sends a recovery when the difference returns to the baseline', async () => {
    const f = fakeDeps({ state: { ...base, ledgerDriftAlerting: true, ledgerDriftSignature: 'X:1' } });
    await reconcile(f.deps);
    expect(f.events.map((e) => e.severity)).toEqual(['recovery']);
    expect(f.state.ledgerDriftAlerting).toBe(false);
  });

  it('a non-zero accepted baseline (pre-ledger history) is not an alert', async () => {
    const sym = TARGET_PORTFOLIO[1].symbol;
    const f = fakeDeps({
      state: { ledgerDriftBaseline: `${sym}:10`, ledgerDriftSignature: `${sym}:10` },
      positions: modelPositions({ [sym]: 10 }),
    });
    await reconcile(f.deps);
    expect(f.events).toEqual([]);
  });

  it('first run adopts the difference as the baseline, silently', async () => {
    const sym = TARGET_PORTFOLIO[1].symbol;
    const f = fakeDeps({ positions: modelPositions({ [sym]: 10 }) });
    await reconcile(f.deps);
    expect(f.events).toEqual([]);
    expect(f.state.ledgerDriftBaseline).toBe(`${sym}:10`);
    expect(typeof f.state.lastReconcileAt).toBe('string');
  });

  it('RECONCILE_DRIFT_REF=last restores the once-only comparison', async () => {
    process.env.RECONCILE_DRIFT_REF = 'last';
    const sym = TARGET_PORTFOLIO[0].symbol;
    const f = fakeDeps({ state: base, positions: modelPositions({ [sym]: 5 }) });
    await reconcile(f.deps);
    await reconcile(f.deps);
    expect(f.events.filter((e) => e.title.startsWith('Ledger no longer'))).toHaveLength(1);
  });
});
