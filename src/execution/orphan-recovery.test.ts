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
  timestamp: '2026-07-06T14:59:42.346Z', symbol: 'NET', action: 'BUY', qty: 1,
  estimatedValue: 100, orderId: 1, status: 'filled', reason: 'x', ...over,
});

const pos = (symbol: string, qty: number, avgCost?: number): BrokerPosition =>
  ({ symbol, qty, avgCost });

const NOW = new Date('2026-09-09T00:00:00.000Z');

describe('parseDriftSignature / formatDriftSignature', () => {
  it('round-trips the real baseline signature', () => {
    const sig = 'AMZN:4,ARM:5,BRK-B:10,NET:50,PLTR:10,TSLA:10,TWLO:20';
    expect(formatDriftSignature(parseDriftSignature(sig))).toBe(sig);
  });

  it('treats an absent or empty signature as no drift', () => {
    expect(parseDriftSignature(undefined).size).toBe(0);
    expect(parseDriftSignature('').size).toBe(0);
  });

  it('parses negative drift (broker holds fewer than the ledger implies)', () => {
    expect(parseDriftSignature('TLT:-3').get('TLT')).toBe(-3);
  });

  it('omits zero entries and sorts, so one drift has exactly one spelling', () => {
    const m = new Map([['ZZ', 1], ['AA', 2], ['MM', 0]]);
    expect(formatDriftSignature(m)).toBe('AA:2,ZZ:1');
  });

  it('ignores malformed entries rather than throwing on a corrupt signature', () => {
    const m = parseDriftSignature('AMZN:4,garbage,NET:x,TLT:3');
    expect([...m]).toEqual([['AMZN', 4], ['TLT', 3]]);
  });
});

describe('ledgerImpliedShares', () => {
  it('nets buys against sells per symbol', () => {
    const implied = ledgerImpliedShares([
      rec({ symbol: 'NET', action: 'BUY', qty: 10 }),
      rec({ symbol: 'NET', action: 'SELL', qty: 2 }),
      rec({ symbol: 'XLE', action: 'BUY', qty: 21 }),
    ]);
    expect(implied.get('NET')).toBe(8);
    expect(implied.get('XLE')).toBe(21);
  });
});

describe('recoverOrphanedFills — the 2026-09-08 VST incident', () => {
  // The directed-deposit queue was XLE, NET, VST. The run was killed after VST
  // filled at IBKR but before the fill was recorded or the queue shrunk, so
  // pendingOrders still held the VST buy and the next window would have bought
  // it a second time. getExecutions() returned [] so the fill-level reconcile
  // could not see it — only the POSITION proves it happened.
  const baseline = 'AMZN:4,ARM:5,BRK-B:10,NET:50,PLTR:10,TSLA:10,TWLO:20';
  // The book the baseline describes: shares that pre-date the ledger, so with
  // an empty ledger these positions ARE the baseline. VST sits on top of it —
  // recovery has to find one orphan inside a book full of accepted drift.
  const BASELINE_POSITIONS: BrokerPosition[] = [
    pos('AMZN', 4, 184.4), pos('ARM', 5, 88.6), pos('BRK-B', 10, 497.18),
    pos('NET', 50, 188.82), pos('PLTR', 10, 85.58), pos('TSLA', 10, 240.34),
    pos('TWLO', 20, 58.95),
  ];

  it('retires a staged buy whose shares are already at the broker', () => {
    const out = recoverOrphanedFills({
      pending: [order('VST', 'BUY', 4, 615.48)],
      history: [],
      positions: [...BASELINE_POSITIONS, pos('VST', 4, 153.545)],
      baselineSignature: baseline,
      now: NOW,
    });

    expect(out.remaining).toEqual([]);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].order.symbol).toBe('VST');
  });

  it('backfills the ledger with the fill it proved, priced at the broker cost', () => {
    const out = recoverOrphanedFills({
      pending: [order('VST', 'BUY', 4, 615.48)],
      history: [],
      positions: [...BASELINE_POSITIONS, pos('VST', 4, 153.545)],
      baselineSignature: baseline,
      now: NOW,
    });

    const t = out.recovered[0].trade;
    expect(t.symbol).toBe('VST');
    expect(t.action).toBe('BUY');
    expect(t.qty).toBe(4);
    expect(t.fillPrice).toBe(153.545);
    expect(t.estimatedValue).toBeCloseTo(614.18, 2);
    expect(t.status).toBe('filled');
    expect(t.timestamp).toBe(NOW.toISOString());
    // The price is INFERRED from the broker's average cost, not observed. The
    // ledger is the tax record, so that has to be legible in the record itself.
    expect(t.reason).toContain('recovered_orphan');
  });

  it('leaves the drift at exactly the baseline once the backfill is applied', () => {
    const out = recoverOrphanedFills({
      pending: [order('VST', 'BUY', 4, 615.48)],
      history: [],
      positions: [...BASELINE_POSITIONS, pos('VST', 4, 153.545)],
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
    const pending = [order('VST', 'BUY', 4, 615.48), order('GLD', 'BUY', 2, 800)];
    const out = recoverOrphanedFills({
      pending, history: [], positions: [pos('AMZN', 8)], baselineSignature: 'AMZN:8', now: NOW,
    });
    expect(out.remaining).toEqual(pending);
    expect(out.recovered).toEqual([]);
  });

  it('does not mistake pre-ledger drift for a fill', () => {
    // NET:50 is baseline — shares that pre-date the ledger. A staged NET buy
    // must still execute. Getting this wrong silently cancels real orders.
    const out = recoverOrphanedFills({
      pending: [order('NET', 'BUY', 4, 1141)],
      history: [],
      positions: [pos('NET', 50, 188.82)],
      baselineSignature: 'NET:50',
      now: NOW,
    });
    expect(out.recovered).toEqual([]);
    expect(out.remaining).toHaveLength(1);
  });

  it('does not re-recover a fill already in the ledger', () => {
    // XLE filled AND was recorded. Idempotency: running twice changes nothing.
    const out = recoverOrphanedFills({
      pending: [order('XLE', 'BUY', 21, 1368.57)],
      history: [rec({ symbol: 'XLE', action: 'BUY', qty: 21, fillPrice: 65.145 })],
      positions: [pos('XLE', 21, 65.19)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toEqual([]);
    expect(out.remaining).toHaveLength(1);
  });

  it('is idempotent: feeding its own backfill back in recovers nothing more', () => {
    const input = {
      pending: [order('VST', 'BUY', 4, 615.48)],
      history: [] as TradeRecord[],
      positions: [pos('VST', 4, 153.545)],
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
      pending: [order('VST', 'BUY', 4, 615.48)],
      history: [],
      positions: [pos('VST', 2, 153.545)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered[0].trade.qty).toBe(2);
    expect(out.remaining).toHaveLength(1);
    expect(out.remaining[0].qty).toBe(2);
    // The estimate must shrink with the quantity or the cash gate misprices it.
    expect(out.remaining[0].estimatedValue).toBeCloseTo(307.74, 2);
  });

  it('charges a surplus to one staged order, not to every order on the symbol', () => {
    const out = recoverOrphanedFills({
      pending: [order('VST', 'BUY', 4, 615.48), order('VST', 'BUY', 4, 615.48)],
      history: [],
      positions: [pos('VST', 4, 153.545)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toHaveLength(1);
    expect(out.remaining).toHaveLength(1);
    expect(out.remaining[0].qty).toBe(4);
  });

  it('recovers a staged sell from a shortfall at the broker', () => {
    // Ledger implies 10 TLT, broker shows 7 — the staged sell of 3 went through.
    const out = recoverOrphanedFills({
      pending: [order('TLT', 'SELL', 3, 249.88)],
      history: [rec({ symbol: 'TLT', action: 'BUY', qty: 10, fillPrice: 81.7 })],
      positions: [pos('TLT', 7, 81.7)],
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
      pending: [order('VST', 'SELL', 4, 615.48)],
      history: [],
      positions: [pos('VST', 4, 153.545)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toEqual([]);
    expect(out.unexplained).toEqual([{ symbol: 'VST', delta: 4 }]);
  });
});

describe('recoverOrphanedFills — drift no staged order explains', () => {
  it('reports an unexplained surplus instead of swallowing it', () => {
    // The LLY:+1 from the same incident: real shares at the broker that no
    // pending order accounts for. Nothing can safely be inferred — say so.
    const out = recoverOrphanedFills({
      pending: [],
      history: [rec({ symbol: 'LLY', action: 'BUY', qty: 1, fillPrice: 1204.425 })],
      positions: [pos('LLY', 2, 1169.89)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toEqual([]);
    expect(out.unexplained).toEqual([{ symbol: 'LLY', delta: 1 }]);
  });

  it('folds unexplained drift into the baseline it hands back', () => {
    // Reported once, then accepted — otherwise it re-alerts every single run.
    const out = recoverOrphanedFills({
      pending: [order('VST', 'BUY', 4, 615.48)],
      history: [rec({ symbol: 'LLY', action: 'BUY', qty: 1 })],
      positions: [pos('LLY', 2, 1169.89), pos('VST', 4, 153.545)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toHaveLength(1);
    expect(out.unexplained).toEqual([{ symbol: 'LLY', delta: 1 }]);
    expect(out.baseline).toBe('LLY:1');
  });

  it('flags that it ADOPTED a baseline when none had been accepted yet', () => {
    // With no accepted baseline every pre-ledger share looks unaccounted for.
    // That is history nobody was ever going to have recorded, not an anomaly,
    // and the caller must be able to tell the two apart before it alerts.
    const out = recoverOrphanedFills({
      pending: [],
      history: [],
      positions: [pos('AMZN', 4), pos('NET', 50)],
      baselineSignature: undefined,
      now: NOW,
    });
    expect(out.adoptedBaseline).toBe(true);
    expect(out.baseline).toBe('AMZN:4,NET:50');
  });

  it('does not claim adoption once a baseline exists, even an empty one', () => {
    // '' is a real answer — "the ledger explains every share" — not an absence.
    const out = recoverOrphanedFills({
      pending: [], history: [], positions: [pos('LLY', 1)], baselineSignature: '', now: NOW,
    });
    expect(out.adoptedBaseline).toBe(false);
    expect(out.unexplained).toEqual([{ symbol: 'LLY', delta: 1 }]);
  });

  it('reports a symbol the broker no longer holds at all', () => {
    const out = recoverOrphanedFills({
      pending: [],
      history: [rec({ symbol: 'ARM', action: 'BUY', qty: 5 })],
      positions: [],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.unexplained).toEqual([{ symbol: 'ARM', delta: -5 }]);
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
    const pending = [order('VST', 'BUY', 4, 615.48)];
    const history: TradeRecord[] = [];
    recoverOrphanedFills({
      pending, history, positions: [pos('VST', 4, 153.545)], baselineSignature: '', now: NOW,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].qty).toBe(4);
    expect(history).toEqual([]);
  });

  it('still records the fill when the broker reports no average cost', () => {
    // No price is better than no record — the ledger must not lose the shares.
    const out = recoverOrphanedFills({
      pending: [order('VST', 'BUY', 4, 615.48)],
      history: [],
      positions: [pos('VST', 4, undefined)],
      baselineSignature: '',
      now: NOW,
    });
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].trade.qty).toBe(4);
    expect(out.recovered[0].trade.fillPrice).toBeUndefined();
    expect(out.recovered[0].trade.estimatedValue).toBeCloseTo(615.48, 2);
  });

  it('ignores a zeroed-out position row rather than reading it as a sale', () => {
    const out = recoverOrphanedFills({
      pending: [], history: [], positions: [pos('VST', 0, 153.545)], baselineSignature: '', now: NOW,
    });
    expect(out.unexplained).toEqual([]);
  });
});
