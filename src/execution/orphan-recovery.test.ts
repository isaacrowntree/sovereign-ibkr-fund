import { describe, it, expect } from 'vitest';
import {
  recoverOrphanedFills,
  ledgerImpliedShares,
  parseDriftSignature,
  formatDriftSignature,
  type BrokerPosition,
} from './orphan-recovery.js';
import type { StagedOrder } from './staging.js';
import type { TradeRecord } from '../state/store.js';

const order = (
  symbol: string,
  action: 'BUY' | 'SELL',
  qty: number,
  estimatedValue: number,
  reason = 'directed_deposit',
): StagedOrder => ({ symbol, action, qty, estimatedValue, reason });

const rec = (over: Partial<TradeRecord>): TradeRecord => ({
  timestamp: '2026-07-06T14:59:42.346Z', symbol: 'DDD', action: 'BUY', qty: 1,
  estimatedValue: 100, orderId: 1, status: 'filled', reason: 'x', ...over,
});

const pos = (symbol: string, qty: number, avgCost?: number): BrokerPosition =>
  ({ symbol, qty, avgCost });

const NOW = new Date('2026-09-09T00:00:00.000Z');

describe('parseDriftSignature / formatDriftSignature', () => {
  it('round-trips a multi-symbol signature unchanged', () => {
    const sig = 'AAA:4,BBB:5,CC-C:10,DDD:50,EEE:10,FFF:10,GGG:20';
    expect(formatDriftSignature(parseDriftSignature(sig))).toBe(sig);
  });

  it('treats an absent or empty signature as no drift', () => {
    expect(parseDriftSignature(undefined).size).toBe(0);
    expect(parseDriftSignature('').size).toBe(0);
  });

  it('parses negative drift (broker holds fewer than the ledger implies)', () => {
    expect(parseDriftSignature('LLL:-3').get('LLL')).toBe(-3);
  });

  it('omits zero entries and sorts, so one drift has exactly one spelling', () => {
    const m = new Map([['ZZ', 1], ['AA', 2], ['MM', 0]]);
    expect(formatDriftSignature(m)).toBe('AA:2,ZZ:1');
  });

  it('ignores malformed entries rather than throwing on a corrupt signature', () => {
    const m = parseDriftSignature('AAA:4,garbage,DDD:x,LLL:3');
    expect([...m]).toEqual([['AAA', 4], ['LLL', 3]]);
  });
});

describe('ledgerImpliedShares', () => {
  it('nets buys against sells per symbol', () => {
    const implied = ledgerImpliedShares([
      rec({ symbol: 'DDD', action: 'BUY', qty: 10 }),
      rec({ symbol: 'DDD', action: 'SELL', qty: 2 }),
      rec({ symbol: 'III', action: 'BUY', qty: 21 }),
    ]);
    expect(implied.get('DDD')).toBe(8);
    expect(implied.get('III')).toBe(21);
  });
});

describe('a staged order that already filled is retired, not placed again', () => {
  // A run that dies between a fill and its ledger write leaves the order in the
  // queue with the shares already at the broker. Neither session-scoped source
  // can see it — a filled order is not "working", and getExecutions() forgets
  // across a session bounce — so the position is the only proof it happened.
  const baseline = 'AAA:4,BBB:5,CC-C:10,DDD:50,EEE:10,FFF:10,GGG:20';
  // The book that baseline describes. With an empty ledger these positions ARE
  // the baseline, so recovery must find one orphan inside a book full of
  // accepted drift rather than in isolation.
  const BASELINE_POSITIONS: BrokerPosition[] = [
    pos('AAA', 4, 10), pos('BBB', 5, 20), pos('CC-C', 10, 30),
    pos('DDD', 50, 40), pos('EEE', 10, 55), pos('FFF', 10, 60),
    pos('GGG', 20, 70),
  ];

  it('retires a staged buy whose shares are already at the broker', () => {
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [],
      positions: [...BASELINE_POSITIONS, pos('HHH', 4, 100)],
      baselineSignature: baseline,
      now: NOW,
    });

    expect(out.remaining).toEqual([]);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].order.symbol).toBe('HHH');
  });

  it('backfills the ledger with the fill it proved, priced at the broker cost', () => {
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [],
      positions: [...BASELINE_POSITIONS, pos('HHH', 4, 100)],
      baselineSignature: baseline,
      now: NOW,
    });

    const t = out.recovered[0].trade;
    expect(t.symbol).toBe('HHH');
    expect(t.action).toBe('BUY');
    expect(t.qty).toBe(4);
    expect(t.fillPrice).toBe(100);
    expect(t.estimatedValue).toBeCloseTo(400, 2);
    expect(t.status).toBe('filled');
    expect(t.timestamp).toBe(NOW.toISOString());
    // The price is INFERRED from the broker's average cost, not observed. The
    // ledger is the tax record, so that has to be legible in the record itself.
    expect(t.reason).toContain('recovered_orphan');
  });

  it('leaves the drift at exactly the baseline once the backfill is applied', () => {
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [],
      positions: [...BASELINE_POSITIONS, pos('HHH', 4, 100)],
      baselineSignature: baseline,
      now: NOW,
    });
    expect(out.baseline).toBe(baseline);
    expect(out.unexplained).toEqual([]);
  });
});

describe('recoverOrphanedFills — what it must NOT do', () => {
  it('leaves a staged order alone when the broker has no matching shares', () => {
    // The overwhelmingly common case: a queue that simply has not run yet.
    const pending = [order('HHH', 'BUY', 4, 402), order('KKK', 'BUY', 2, 160)];
    const out = recoverOrphanedFills({
      pending, history: [], positions: [pos('AAA', 8)], baselineSignature: 'AAA:8', now: NOW,
    });
    expect(out.remaining).toEqual(pending);
    expect(out.recovered).toEqual([]);
  });

  it('does not mistake pre-ledger drift for a fill', () => {
    // DDD:50 is baseline — shares that pre-date the ledger. A staged DDD buy
    // must still execute. Getting this wrong silently cancels real orders.
    const out = recoverOrphanedFills({
      pending: [order('DDD', 'BUY', 4, 160)],
      history: [],
      positions: [pos('DDD', 50, 40)],
      baselineSignature: 'DDD:50',
      now: NOW,
    });
    expect(out.recovered).toEqual([]);
    expect(out.remaining).toHaveLength(1);
  });

  it('does not re-recover a fill already in the ledger', () => {
    // III filled AND was recorded. Idempotency: running twice changes nothing.
    const out = recoverOrphanedFills({
      pending: [order('III', 'BUY', 21, 1050)],
      history: [rec({ symbol: 'III', action: 'BUY', qty: 21, fillPrice: 50 })],
      positions: [pos('III', 21, 50.02)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toEqual([]);
    expect(out.remaining).toHaveLength(1);
  });

  it('is idempotent: feeding its own backfill back in recovers nothing more', () => {
    const input = {
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [] as TradeRecord[],
      positions: [pos('HHH', 4, 100)],
      baselineSignature: '',
      now: NOW,
    };
    const first = recoverOrphanedFills(input);
    const second = recoverOrphanedFills({
      ...input,
      pending: first.remaining,
      history: [...input.history, ...first.recovered.map(r => r.trade)],
      baselineSignature: first.baseline,
    });
    expect(second.recovered).toEqual([]);
    expect(second.unexplained).toEqual([]);
  });
});

describe('recoverOrphanedFills — partial and multi-order cases', () => {
  it('shrinks a staged buy to the unfilled remainder on a partial fill', () => {
    // 2 of 4 filled. Retiring the whole order loses 2 shares of intent;
    // leaving it whole buys 4 more for 6 total. Only the remainder is right.
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [],
      positions: [pos('HHH', 2, 100)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered[0].trade.qty).toBe(2);
    expect(out.remaining).toHaveLength(1);
    expect(out.remaining[0].qty).toBe(2);
    // The estimate must shrink with the quantity or the cash gate misprices it.
    expect(out.remaining[0].estimatedValue).toBeCloseTo(201, 2);
  });

  it('charges a surplus to one staged order, not to every order on the symbol', () => {
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402), order('HHH', 'BUY', 4, 402)],
      history: [],
      positions: [pos('HHH', 4, 100)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toHaveLength(1);
    expect(out.remaining).toHaveLength(1);
    expect(out.remaining[0].qty).toBe(4);
  });

  it('recovers a staged sell from a shortfall at the broker', () => {
    // Ledger implies 10 LLL, broker shows 7 — the staged sell of 3 went through.
    const out = recoverOrphanedFills({
      pending: [order('LLL', 'SELL', 3, 120)],
      history: [rec({ symbol: 'LLL', action: 'BUY', qty: 10, fillPrice: 81.7 })],
      positions: [pos('LLL', 7, 81.7)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].trade.action).toBe('SELL');
    expect(out.recovered[0].trade.qty).toBe(3);
    expect(out.remaining).toEqual([]);
  });

  it('does not let a buy surplus retire a sell, or the reverse', () => {
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'SELL', 4, 402)],
      history: [],
      positions: [pos('HHH', 4, 100)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toEqual([]);
    expect(out.unexplained).toEqual([{ symbol: 'HHH', delta: 4 }]);
  });
});

describe('recoverOrphanedFills — drift no staged order explains', () => {
  it('reports an unexplained surplus instead of swallowing it', () => {
    // Real shares at the broker that no pending order accounts for. Nothing
    // can safely be inferred about them, so they must be reported, not hidden.
    const out = recoverOrphanedFills({
      pending: [],
      history: [rec({ symbol: 'JJJ', action: 'BUY', qty: 1, fillPrice: 200 })],
      positions: [pos('JJJ', 2, 195)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toEqual([]);
    expect(out.unexplained).toEqual([{ symbol: 'JJJ', delta: 1 }]);
  });

  it('folds unexplained drift into the baseline it hands back', () => {
    // Reported once, then accepted — otherwise it re-alerts every single run.
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [rec({ symbol: 'JJJ', action: 'BUY', qty: 1 })],
      positions: [pos('JJJ', 2, 195), pos('HHH', 4, 100)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toHaveLength(1);
    expect(out.unexplained).toEqual([{ symbol: 'JJJ', delta: 1 }]);
    expect(out.baseline).toBe('JJJ:1');
  });

  it('does not treat an empty baseline as an absent one', () => {
    // '' is a real answer — "the ledger explains every share" — not an absence.
    const out = recoverOrphanedFills({
      pending: [], history: [], positions: [pos('JJJ', 1)], baselineSignature: '', now: NOW,
    });
    expect(out.blocked).toBeNull();
    expect(out.unexplained).toEqual([{ symbol: 'JJJ', delta: 1 }]);
  });

  it('reports a symbol the broker no longer holds at all', () => {
    // The book still has other names — a wholly empty positions response is
    // untrustworthy and blocks instead (see 'refuses to guess').
    const out = recoverOrphanedFills({
      pending: [],
      history: [rec({ symbol: 'BBB', action: 'BUY', qty: 5 }), rec({ symbol: 'DDD', action: 'BUY', qty: 7 })],
      positions: [pos('DDD', 7, 40)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.blocked).toBeNull();
    expect(out.unexplained).toEqual([{ symbol: 'BBB', delta: -5 }]);
  });
});

describe('recoverOrphanedFills — degenerate inputs', () => {
  it('is a no-op on an empty queue with no drift', () => {
    const out = recoverOrphanedFills({
      pending: [], history: [], positions: [], baselineSignature: '', now: NOW,
    });
    expect(out).toMatchObject({ recovered: [], remaining: [], unexplained: [], baseline: '' });
  });

  it('does not mutate the inputs it was given', () => {
    const pending = [order('HHH', 'BUY', 4, 402)];
    const history: TradeRecord[] = [];
    recoverOrphanedFills({
      pending, history, positions: [pos('HHH', 4, 100)], baselineSignature: '', now: NOW,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].qty).toBe(4);
    expect(history).toEqual([]);
  });

  it('still records the fill when the broker reports no average cost', () => {
    // No price is better than no record — the ledger must not lose the shares.
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [],
      positions: [pos('HHH', 4, undefined)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].trade.qty).toBe(4);
    expect(out.recovered[0].trade.fillPrice).toBeUndefined();
    expect(out.recovered[0].trade.estimatedValue).toBeCloseTo(402, 2);
  });

  it('ignores a zeroed-out position row rather than reading it as a sale', () => {
    const out = recoverOrphanedFills({
      pending: [], history: [], positions: [pos('HHH', 0, 100)], baselineSignature: '', now: NOW,
    });
    expect(out.unexplained).toEqual([]);
  });
});

describe('recoverOrphanedFills — refuses to guess', () => {
  // Without an accepted baseline, pre-ledger history and an orphaned fill are
  // literally the same observation, and BOTH readings are unsafe: treat the
  // drift as history and a staged order that already filled gets placed twice;
  // treat it as fills and real staged orders are cancelled and fabricated into
  // the tax ledger. There is no safe guess, so it must not guess.
  it('blocks instead of adopting when no baseline has been accepted', () => {
    const out = recoverOrphanedFills({
      pending: [order('DDD', 'BUY', 10, 400)],
      history: [],
      positions: [pos('DDD', 50, 40)],
      baselineSignature: undefined,
      now: NOW,
    });
    expect(out.blocked).toMatch(/baseline/i);
    expect(out.recovered).toEqual([]);
    expect(out.remaining).toHaveLength(1);
    expect(out.remaining[0].qty).toBe(10);
  });

  it('does not silently bank a baseline it was not confident about', () => {
    // Storing the adopted drift would bury any real orphan inside it, and the
    // staged order it belongs to would then look unexplained and be re-placed.
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [],
      positions: [pos('HHH', 4, 100)],
      baselineSignature: undefined,
      now: NOW,
    });
    expect(out.blocked).not.toBeNull();
    expect(out.baseline).toBe('');
    expect(out.unexplained).toEqual([]);
  });

  it('blocks when the broker reports no positions but the ledger implies some', () => {
    // IBKR commonly answers [] on the first call after a session bounce. Read
    // literally that is "everything was sold", which would retire every staged
    // SELL as already-filled and write sales that never happened.
    const out = recoverOrphanedFills({
      pending: [order('LLL', 'SELL', 3, 120)],
      history: [rec({ symbol: 'LLL', action: 'BUY', qty: 10 })],
      positions: [],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.blocked).toMatch(/position/i);
    expect(out.recovered).toEqual([]);
    expect(out.remaining).toHaveLength(1);
  });

  it('still works on a genuinely empty account', () => {
    // No positions AND nothing in the ledger is consistent, not suspicious.
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [], positions: [], baselineSignature: '', now: NOW,
    });
    expect(out.blocked).toBeNull();
    expect(out.remaining).toHaveLength(1);
  });
});

describe('recoverOrphanedFills — cost basis must never be fabricated', () => {
  it('treats a zero average cost as absent, not as a free share', () => {
    // gateway.getAccountSummary() coerces a missing avgCost to 0, so `0` is
    // what production actually passes. Recording it would put a $0 cost basis
    // in the tax ledger and turn the eventual sale into 100% capital gain.
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [],
      positions: [pos('HHH', 4, 0)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toHaveLength(1);
    const t = out.recovered[0].trade;
    expect(t.fillPrice).toBeUndefined();
    expect(t.estimatedValue).toBeCloseTo(402, 2);
    expect(t.reason).toContain('no fill price');
  });

  it('treats a negative average cost as absent too', () => {
    const out = recoverOrphanedFills({
      pending: [order('HHH', 'BUY', 4, 402)],
      history: [], positions: [pos('HHH', 4, -1)], baselineSignature: '', now: NOW,
    });
    expect(out.recovered[0].trade.fillPrice).toBeUndefined();
  });
});

describe('formatDriftSignature — ordering must not depend on the locale', () => {
  it('orders by code unit, matching the signature already stored on disk', () => {
    // The signature is compared as a string against one already on disk, so
    // its spelling must be stable. localeCompare collates punctuation
    // differently and is ICU-dependent: it would re-spell an unchanged drift
    // and raise a "ledger drift changed" critical about nothing.
    const symbols = ['CCCC', 'CC-C', 'CC.C', 'AAA', 'BBB'];
    const m = new Map(symbols.map((s, i) => [s, i + 1]));
    const got = formatDriftSignature(m).split(',').map(e => e.slice(0, e.lastIndexOf(':')));
    expect(got).toEqual([...symbols].sort());
  });
});
