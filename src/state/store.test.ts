import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_DIR = resolve(__dirname, '../../.test-state-' + process.pid);
const legacyState = () => resolve(TEST_DIR, 'bot-state.json');
const legacyTrades = () => resolve(TEST_DIR, 'trade-history.json');
const dbFile = () => resolve(TEST_DIR, 'bot-state.db');

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

/** Close and reopen the store as a fresh process would (new connection). */
async function reopen() {
  store.closeDb();
  vi.resetModules();
  store = await import('./store');
  return store;
}

describe('mergeState', () => {
  it('merges updates into existing state without clobbering other fields', () => {
    store.saveState({ lastNav: 100000, regime: 'risk_on', lastCheckAt: '2025-01-01' });
    store.mergeState({ lastNav: 110000, lastCheckAt: '2025-01-02' });
    const loaded = store.loadState();
    expect(loaded.lastNav).toBe(110000);
    expect(loaded.lastCheckAt).toBe('2025-01-02');
    expect(loaded.regime).toBe('risk_on');
  });

  it('per-key merges never lose a concurrent update to a different field', () => {
    store.saveState({ fieldA: 1, fieldB: 2, fieldC: 3 });
    store.mergeState({ fieldA: 10 });
    store.mergeState({ fieldB: 20 });
    const loaded = store.loadState();
    expect(loaded.fieldA).toBe(10);
    expect(loaded.fieldB).toBe(20);
    expect(loaded.fieldC).toBe(3);
  });

  it('creates the store if it does not exist', () => {
    store.mergeState({ newField: 'hello' });
    expect(store.loadState().newField).toBe('hello');
  });

  it('overwrites fields with new values', () => {
    store.saveState({ pendingOrders: [{ symbol: 'VTI', qty: 100 }] });
    store.mergeState({ pendingOrders: [] });
    expect(store.loadState().pendingOrders).toEqual([]);
  });

  it('an undefined value deletes the key (matches old spread semantics)', () => {
    store.saveState({ keep: 1, drop: 2 });
    store.mergeState({ drop: undefined });
    const loaded = store.loadState();
    expect(loaded.keep).toBe(1);
    expect('drop' in loaded).toBe(false);
  });

  it('a null value is stored as null (not deleted)', () => {
    store.saveState({ lastValidationFailure: { at: 'x' } });
    store.mergeState({ lastValidationFailure: null });
    expect(store.loadState().lastValidationFailure).toBeNull();
  });
});

describe('saveState / loadState round-trip', () => {
  it('saves and loads nested structures correctly', () => {
    store.saveState({ netLiquidation: 100000, positions: ['VTI', 'BND'], nested: { a: [1, 2, 3] } });
    const loaded = store.loadState();
    expect(loaded.netLiquidation).toBe(100000);
    expect(loaded.positions).toEqual(['VTI', 'BND']);
    expect(loaded.nested).toEqual({ a: [1, 2, 3] });
  });

  it('saveState replaces the whole state (removes keys not present)', () => {
    store.saveState({ a: 1, b: 2 });
    store.saveState({ a: 9 });
    const loaded = store.loadState();
    expect(loaded.a).toBe(9);
    expect('b' in loaded).toBe(false);
  });

  it('returns an empty object when nothing has been saved', () => {
    expect(store.loadState()).toEqual({});
  });

  it('creates a SQLite db file (not a JSON blob)', () => {
    store.saveState({ test: true });
    expect(existsSync(dbFile())).toBe(true);
  });

  it('persists across a reopen (new connection)', async () => {
    store.saveState({ lastNav: 55555 });
    await reopen();
    expect(store.loadState().lastNav).toBe(55555);
  });
});

describe('trade history', () => {
  const trade = (symbol: string, ts: string) => ({
    timestamp: ts, symbol, action: 'SELL' as const, qty: 1, estimatedValue: 100,
    orderId: 1, status: 'filled', reason: 'test',
  });

  it('appends and loads trades in insertion order', () => {
    store.appendTrade(trade('NET', 't1'));
    store.appendTrade(trade('TLT', 't2'));
    const h = store.loadTradeHistory();
    expect(h.map(t => t.symbol)).toEqual(['NET', 'TLT']);
  });

  it('accumulates across many appends and persists across reopen', async () => {
    store.appendTrade(trade('NET', 't1'));
    await reopen();
    store.appendTrade(trade('TLT', 't2'));
    expect(store.loadTradeHistory().map(t => t.symbol)).toEqual(['NET', 'TLT']);
  });

  it('preserves full TradeRecord shape (matchedLots, realisedPnl, etc.)', () => {
    store.appendTrade({
      ...trade('NET', 't1'), realisedPnlUsd: -60, longTermQty: 2,
      matchedLots: [{ buyTimestamp: 'b1', qty: 3, buyPrice: 260, longTerm: false }],
    });
    const rec = store.loadTradeHistory()[0];
    expect(rec.realisedPnlUsd).toBe(-60);
    expect(rec.matchedLots).toEqual([{ buyTimestamp: 'b1', qty: 3, buyPrice: 260, longTerm: false }]);
  });

  it('returns [] when there is no history', () => {
    expect(store.loadTradeHistory()).toEqual([]);
  });

  it('is idempotent by execId — the same fill is recorded once', () => {
    store.appendTrade({ ...trade('BRK-B', 't1'), qty: 5, orderId: 100, execId: 'X1' });
    // Same fill again, different recording timestamp, still deduped by execId.
    store.appendTrade({ ...trade('BRK-B', 't2'), qty: 5, orderId: 100, execId: 'X1' });
    expect(store.loadTradeHistory()).toHaveLength(1);
  });

  it('is idempotent by (orderId, action, symbol, qty) when a record has no execId', () => {
    // The exact BRK-B duplicate we hit: one path had no execId, the other did.
    store.appendTrade({ ...trade('BRK-B', 't1'), qty: 5, orderId: 100 });                 // no execId
    store.appendTrade({ ...trade('BRK-B', 't2'), qty: 5, orderId: 100, execId: 'X1' });    // reconciled
    expect(store.loadTradeHistory()).toHaveLength(1);
  });

  it('does NOT dedupe genuinely distinct fills (different order / qty)', () => {
    store.appendTrade({ ...trade('BRK-B', 't1'), qty: 5, orderId: 100, execId: 'X1' });
    store.appendTrade({ ...trade('BRK-B', 't2'), qty: 5, orderId: 200, execId: 'X2' }); // different order
    store.appendTrade({ ...trade('TWLO', 't3'), qty: 14, orderId: 300, execId: 'X3' });
    expect(store.loadTradeHistory()).toHaveLength(3);
  });
});

describe('trade dedupe — execId records vs order aggregates', () => {
  const agg = (orderId: number, qty: number) => ({
    timestamp: '2026-09-01T14:00:05Z', symbol: 'NET', action: 'BUY' as const, qty,
    estimatedValue: qty * 100, fillPrice: 100, orderId, status: 'filled', reason: 'rebalance',
  });
  const ex = (orderId: number, qty: number, execId: string) => ({ ...agg(orderId, qty), execId, reason: 'reconciled_from_ibkr' });
  const qtyOf = () => store.loadTradeHistory().reduce((s, t) => s + t.qty, 0);

  it('keeps two equal partials of one order — they are different executions', () => {
    // The old rule compared by signature against EVERY row, so the second 50
    // matched the first and a real fill was lost.
    store.appendTrade(ex(7, 50, 'E1'));
    store.appendTrade(ex(7, 50, 'E2'));
    expect(qtyOf()).toBe(100);
  });

  it('multi-partial: re-appending the same partials is still a no-op (execId)', () => {
    for (let i = 0; i < 2; i++) {
      store.appendTrade(ex(7, 30, 'E1'));
      store.appendTrade(ex(7, 30, 'E2'));
      store.appendTrade(ex(7, 40, 'E3'));
    }
    expect(store.loadTradeHistory()).toHaveLength(3);
    expect(qtyOf()).toBe(100);
  });

  it('executions first, aggregate second: the aggregate is recognised as covered', () => {
    store.appendTrade(ex(7, 30, 'E1'));
    store.appendTrade(ex(7, 70, 'E2'));
    store.appendTrade(agg(7, 100));
    expect(qtyOf()).toBe(100);
  });

  it('an aggregate is not swallowed by a smaller execution of its order', () => {
    store.appendTrade(ex(7, 30, 'E1'));
    store.appendTrade(agg(7, 100));
    expect(qtyOf()).toBe(130); // reconcile's job to sort out, never the store's to drop a fill
  });

  it('aggregate first, then its split executions via reconcile: nothing added', async () => {
    const { reconcileExecutions } = await import('../execution/reconcile');
    store.appendTrade(agg(7, 100));
    const execs = [30, 30, 40].map((q, i) => ({
      execId: `E${i}`, symbol: 'NET', action: 'BUY' as const, qty: q, price: 100,
      time: `2026-09-01T14:00:0${i}Z`, orderId: 7,
    }));
    const added = store.appendReconciledTrades(h => reconcileExecutions(h, execs));
    expect(added).toEqual([]);
    expect(qtyOf()).toBe(100);
  });

  it('a partial aggregate (50) with executions 50 + 50 records the second 50 exactly once', async () => {
    // reconcileExecutions charges E1 to the aggregate and returns E2. The old
    // store then re-checked E2 by signature, matched the aggregate, and dropped
    // it: the fill the reconcile existed to find was lost.
    const { reconcileExecutions } = await import('../execution/reconcile');
    store.appendTrade(agg(7, 50));
    const execs = ['E1', 'E2'].map((id, i) => ({
      execId: id, symbol: 'NET', action: 'BUY' as const, qty: 50, price: 100,
      time: `2026-09-01T14:00:0${i}Z`, orderId: 7,
    }));
    expect(store.appendReconciledTrades(h => reconcileExecutions(h, execs)).map(t => t.execId)).toEqual(['E2']);
    expect(store.appendReconciledTrades(h => reconcileExecutions(h, execs))).toEqual([]);
    expect(qtyOf()).toBe(100);
  });
});

describe('fx conversions (Division 775 record)', () => {
  it('records each conversion once, by execId, and keeps them out of the trade ledger', () => {
    const c = { execId: 'F1', time: '2026-09-01T02:00:00.000Z', pair: 'AUD.USD', baseAmount: 1000 };
    expect(store.appendFxConversions([c])).toBe(1);
    expect(store.appendFxConversions([c, { ...c, execId: 'F2' }])).toBe(1);
    expect(store.loadFxConversions().map(x => x.execId)).toEqual(['F1', 'F2']);
    expect(store.loadTradeHistory()).toEqual([]);
  });
});

describe('legacy JSON migration', () => {
  it('imports a legacy bot-state.json on first open, then retires the file', () => {
    writeFileSync(legacyState(), JSON.stringify({ lastNav: 42000, pendingOrders: [{ symbol: 'NET', qty: 3 }] }));
    const loaded = store.loadState();
    expect(loaded.lastNav).toBe(42000);
    expect(loaded.pendingOrders).toEqual([{ symbol: 'NET', qty: 3 }]);
    // Legacy file retired (renamed) so it is never re-imported.
    expect(existsSync(legacyState())).toBe(false);
    expect(existsSync(legacyState() + '.migrated')).toBe(true);
  });

  it('imports a legacy trade-history.json on first open', () => {
    writeFileSync(legacyTrades(), JSON.stringify([
      { timestamp: 't1', symbol: 'NET', action: 'SELL', qty: 43, estimatedValue: 10800, orderId: 1, status: 'filled', reason: 'seed' },
    ]));
    const h = store.loadTradeHistory();
    expect(h).toHaveLength(1);
    expect(h[0].symbol).toBe('NET');
    expect(existsSync(legacyTrades() + '.migrated')).toBe(true);
  });

  it('does NOT re-import after migration (no duplicate trades on reopen)', async () => {
    writeFileSync(legacyTrades(), JSON.stringify([
      { timestamp: 't1', symbol: 'NET', action: 'SELL', qty: 1, estimatedValue: 100, orderId: 1, status: 'filled', reason: 'seed' },
    ]));
    store.loadTradeHistory();      // triggers migration
    store.appendTrade({ timestamp: 't2', symbol: 'TLT', action: 'BUY', qty: 1, estimatedValue: 100, orderId: 2, status: 'filled', reason: 'x' });
    await reopen();
    // Even if a stray legacy file reappears, migration must not run twice.
    writeFileSync(legacyTrades(), JSON.stringify([
      { timestamp: 't1', symbol: 'NET', action: 'SELL', qty: 1, estimatedValue: 100, orderId: 1, status: 'filled', reason: 'seed' },
    ]));
    const h = store.loadTradeHistory();
    expect(h.map(t => t.symbol)).toEqual(['NET', 'TLT']);
  });

  it('does not migrate a legacy file into an already-populated db', async () => {
    store.saveState({ lastNav: 1 });      // db now has data
    await reopen();
    writeFileSync(legacyState(), JSON.stringify({ lastNav: 999 }));
    expect(store.loadState().lastNav).toBe(1); // legacy ignored
  });
});
