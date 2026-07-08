import { describe, it, expect } from 'vitest';
import { executeQueue, type ExecutorDeps, type ExecutorContext } from './executor.js';
import type { StagedOrder } from './staging.js';
import type { TradeResult } from '../connection/gateway.js';
import type { FillConfirmation } from '../observability/fill-confirmer.js';
import type { TradeRecord } from '../state/store.js';

const order = (
  symbol: string,
  action: 'BUY' | 'SELL',
  estimatedValue: number,
  qty = 1,
): StagedOrder => ({ symbol, action, qty, estimatedValue, reason: 'test' });

const accepted = (o: StagedOrder, orderId = 1): TradeResult => ({
  orderId,
  symbol: o.symbol,
  action: o.action,
  qty: o.qty,
  status: 'Submitted',
});

const confirmation = (
  orderId: number,
  over: Partial<FillConfirmation> = {},
): FillConfirmation => ({
  orderId,
  status: 'filled',
  totalFilledQty: over.totalFilledQty ?? 1,
  avgFillPrice: 100,
  remainingQty: 0,
  events: [],
  timedOut: false,
  ...over,
});

interface FakeOpts {
  /** Per-symbol overrides for the confirmation result. */
  confirm?: Record<string, Partial<FillConfirmation>>;
  /** Symbols whose placement should throw. */
  failPlace?: string[];
  /** Symbols whose placement returns an unusable orderId (0). */
  zeroOrderId?: string[];
  /** Symbols whose confirmFill should throw. */
  failConfirm?: string[];
  cash?: number;
  /** getAccountCash rejects instead of returning. */
  cashThrows?: boolean;
  history?: TradeRecord[];
  /** isWindowOpen returns true for the first N checks, then false. Omit → no window dep. */
  windowOpenFor?: number;
  /** Symbol+action pairs already working at IBKR (idempotency guard), e.g. ['SELL:NET']. */
  liveWorking?: string[];
  /** getLiveOrders rejects (idempotency guard unavailable). */
  liveOrdersThrows?: boolean;
  /** Executions returned by getExecutions (for reconcile-on-failure), keyed by nothing — a flat list. */
  executions?: Array<{ execId: string; symbol: string; action: 'BUY' | 'SELL'; qty: number; price: number; orderId?: number }>;
  /** Per-symbol avg cost (fallback cost basis). */
  avgCosts?: Record<string, number>;
  /** appendTrade throws (simulate a trade-history write failure). */
  appendThrows?: boolean;
}

function makeDeps(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const placed: Array<{ order: StagedOrder; orderId: number }> = [];
  const confirmCalls: Array<{ orderId: number; symbol: string }> = [];
  const cancelled: number[] = [];
  const trades: TradeRecord[] = [];
  const persisted: StagedOrder[][] = [];
  let nextOrderId = 100;
  let windowChecks = 0;

  const deps: ExecutorDeps = {
    placeOrder: async (o) => {
      calls.push(`place:${o.action}:${o.symbol}`);
      if (opts.failPlace?.includes(o.symbol)) throw new Error(`boom placing ${o.symbol}`);
      const orderId = opts.zeroOrderId?.includes(o.symbol) ? 0 : nextOrderId++;
      placed.push({ order: o, orderId });
      return accepted(o, orderId);
    },
    confirmFill: async (orderId, { targetQty }) => {
      const sym = placed[placed.length - 1].order.symbol;
      confirmCalls.push({ orderId, symbol: sym });
      calls.push(`confirm:${sym}`);
      if (opts.failConfirm?.includes(sym)) throw new Error(`confirm stream down for ${sym}`);
      return confirmation(orderId, {
        totalFilledQty: targetQty,
        remainingQty: 0,
        ...opts.confirm?.[sym],
      });
    },
    getUsdCash: async () => {
      calls.push('cash');
      if (opts.cashThrows) throw new Error('cash fetch timeout');
      return opts.cash ?? 1_000_000;
    },
    cancelOrder: async (orderId) => {
      cancelled.push(orderId);
      calls.push(`cancel:${orderId}`);
    },
    getLiveOrders: async () => {
      calls.push('liveOrders');
      if (opts.liveOrdersThrows) throw new Error('bezant unreachable');
      return (opts.liveWorking ?? []).map((k) => {
        const [action, symbol] = k.split(':');
        return { symbol, action: action as 'BUY' | 'SELL', status: 'Submitted' };
      });
    },
    getExecutions: async () => opts.executions ?? [],
    getAvgCosts: async () => new Map(Object.entries(opts.avgCosts ?? {})),
    persistRemaining: (orders) => {
      persisted.push(orders.map((o) => ({ ...o })));
    },
    loadTradeHistory: () => opts.history ?? [],
    appendTrade: (t) => {
      if (opts.appendThrows) throw new Error('disk full writing trade-history.json');
      trades.push(t);
    },
    isWindowOpen: opts.windowOpenFor === undefined
      ? undefined
      : () => {
          windowChecks += 1;
          return windowChecks <= opts.windowOpenFor!;
        },
    log: () => {},
    logError: () => {},
  };
  return { deps, calls, placed, confirmCalls, cancelled, trades, persisted };
}

const ctx = (over: Partial<ExecutorContext> = {}): ExecutorContext => ({
  validated: true,
  nav: 42000,
  regime: 'neutral',
  fillConfirmationEnabled: true,
  cashHeadroomPct: 2,
  ...over,
});

const MIXED_QUEUE: StagedOrder[] = [
  order('BRK-B', 'SELL', 1500, 3),
  order('NET', 'SELL', 10800, 43),
  order('AVGO', 'BUY', 3360, 9),
  order('GLD', 'BUY', 1500, 4),
];

describe('executeQueue — ordering', () => {
  it('executes sells before buys, and fetches cash after the sells', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(false);
    expect(outcome.requeue).toEqual([]);
    const placeCalls = calls.filter(c => c.startsWith('place:'));
    expect(placeCalls).toEqual([
      'place:SELL:BRK-B',
      'place:SELL:NET',
      'place:BUY:AVGO',
      'place:BUY:GLD',
    ]);
    // Cash gate must see post-sell balances: 'cash' after both sell
    // placements, before any buy placement.
    const cashIdx = calls.indexOf('cash');
    expect(cashIdx).toBeGreaterThan(calls.indexOf('place:SELL:NET'));
    expect(cashIdx).toBeLessThan(calls.indexOf('place:BUY:AVGO'));
  });

  it('does nothing on an empty queue', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await executeQueue([], ctx(), deps);
    expect(outcome.confirmedFill).toBe(false);
    expect(outcome.requeue).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('executeQueue — validation mode', () => {
  it('places only the smallest SELL and requeues everything else', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await executeQueue(MIXED_QUEUE, ctx({ validated: false }), deps);

    expect(outcome.mode).toBe('validate');
    expect(calls.filter(c => c.startsWith('place:'))).toEqual(['place:SELL:BRK-B']);
    expect(outcome.confirmedFill).toBe(true);
    expect(outcome.validationFailed).toBe(false);
    expect(outcome.requeue.map(o => o.symbol).sort()).toEqual(['AVGO', 'GLD', 'NET']);
  });

  it('confirms fills even when fill confirmation is env-disabled', async () => {
    const { deps, calls } = makeDeps();
    await executeQueue(MIXED_QUEUE, ctx({ validated: false, fillConfirmationEnabled: false }), deps);
    expect(calls).toContain('confirm:BRK-B');
  });

  it('rejected probe: validation fails, probe not requeued, queue stays intact', async () => {
    const { deps, calls } = makeDeps({
      confirm: { 'BRK-B': { status: 'rejected', totalFilledQty: 0 } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx({ validated: false }), deps);

    expect(outcome.validationFailed).toBe(true);
    expect(outcome.confirmedFill).toBe(false);
    expect(outcome.halted).toBe(true);
    expect(calls.filter(c => c.startsWith('place:'))).toEqual(['place:SELL:BRK-B']);
    // Probe was rejected — retrying it verbatim is pointless, so it is
    // dropped; the deferred orders all survive.
    expect(outcome.requeue.map(o => o.symbol).sort()).toEqual(['AVGO', 'GLD', 'NET']);
  });

  it('probe timeout with zero fills: validation fails, probe NOT requeued (duplicate risk)', async () => {
    const { deps } = makeDeps({
      confirm: { 'BRK-B': { status: 'pending', totalFilledQty: 0, timedOut: true, remainingQty: 3 } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx({ validated: false }), deps);

    expect(outcome.validationFailed).toBe(true);
    expect(outcome.requeue.some(o => o.symbol === 'BRK-B')).toBe(false);
    expect(outcome.requeue.map(o => o.symbol).sort()).toEqual(['AVGO', 'GLD', 'NET']);
  });
});

describe('executeQueue — halt on uncertainty', () => {
  it('rejected order halts the run and requeues the untouched remainder', async () => {
    const { deps, calls } = makeDeps({
      confirm: { 'BRK-B': { status: 'rejected', totalFilledQty: 0 } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(true);
    expect(calls.filter(c => c.startsWith('place:'))).toEqual(['place:SELL:BRK-B']);
    // Rejected order dropped; NET/AVGO/GLD untouched and requeued verbatim.
    expect(outcome.requeue).toEqual(MIXED_QUEUE.slice(1));
  });

  it('timeout with zero fills halts; the order is NOT requeued', async () => {
    const { deps } = makeDeps({
      confirm: { 'NET': { status: 'pending', totalFilledQty: 0, timedOut: true, remainingQty: 43 } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(true);
    expect(outcome.requeue.some(o => o.symbol === 'NET')).toBe(false);
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['AVGO', 'GLD']);
  });

  it('submission failure DROPS that order (ambiguous — may be live) and halts', async () => {
    const { deps, calls } = makeDeps({ failPlace: ['NET'] });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(true);
    expect(calls.filter(c => c.startsWith('place:'))).toEqual([
      'place:SELL:BRK-B',
      'place:SELL:NET',
    ]);
    // NET is NOT requeued: a post-accept timeout could have left it live at
    // IBKR, so requeueing would risk a duplicate. Buys never ran (still queued).
    // BRK-B already executed (dropped from queue).
    expect(outcome.requeue.some(o => o.symbol === 'NET')).toBe(false);
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['AVGO', 'GLD']);
    expect(outcome.executed.map(o => o.symbol)).toEqual(['BRK-B']);
  });

  it('confirm-stream failure halts and does not place further orders', async () => {
    const { deps, calls } = makeDeps({ failConfirm: ['BRK-B'] });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(true);
    expect(calls.filter(c => c.startsWith('place:'))).toEqual(['place:SELL:BRK-B']);
    // The placed order's outcome is unknown — not requeued.
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['NET', 'AVGO', 'GLD']);
  });
});

describe('executeQueue — partial fills', () => {
  it('terminal partial requeues only the remainder and continues', async () => {
    const { deps, calls } = makeDeps({
      confirm: { 'NET': { status: 'partial', totalFilledQty: 40, remainingQty: 3 } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(false);
    // Buys still ran after the partial sell.
    expect(calls.filter(c => c.startsWith('place:BUY'))).toHaveLength(2);
    const requeued = outcome.requeue.find(o => o.symbol === 'NET');
    expect(requeued?.qty).toBe(3);
    expect(requeued?.reason).toContain('partial_fill_remainder');
  });

  it('partial WITH timeout halts and does not requeue the remainder', async () => {
    const { deps } = makeDeps({
      confirm: { 'NET': { status: 'partial', totalFilledQty: 40, remainingQty: 3, timedOut: true } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(true);
    expect(outcome.requeue.some(o => o.symbol === 'NET')).toBe(false);
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['AVGO', 'GLD']);
  });
});

describe('executeQueue — cash gate', () => {
  it('defers buys that exceed post-sell cash, executes the ones that fit', async () => {
    // AVGO needs 3360*1.02 = 3427.20; GLD needs 1530. Cash 3000 → only GLD fits.
    const { deps, calls } = makeDeps({ cash: 3000 });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(calls.filter(c => c.startsWith('place:BUY'))).toEqual(['place:BUY:GLD']);
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['AVGO']);
  });

  it('halted sells skip the cash fetch entirely; buys stay queued', async () => {
    const { deps, calls } = makeDeps({ failPlace: ['BRK-B'] });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(calls).not.toContain('cash');
    // BRK-B (the failed placement) is dropped as ambiguous; NET + both buys
    // never ran and stay queued.
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['NET', 'AVGO', 'GLD']);
  });
});

describe('executeQueue — trade records and tax', () => {
  it('records the confirmed fill qty and price, not the estimate (filled != ordered)', async () => {
    // Terminal partial: 2 of 3 filled. A tautology-free check — order.qty is
    // 3, so asserting qty===2 fails if the executor records order.qty.
    const { deps, trades } = makeDeps({
      confirm: { 'BRK-B': { status: 'partial', totalFilledQty: 2, remainingQty: 1, avgFillPrice: 505.5 } },
    });
    await executeQueue([MIXED_QUEUE[0]], ctx(), deps);

    expect(trades).toHaveLength(1);
    expect(trades[0].qty).toBe(2);
    expect(trades[0].fillPrice).toBe(505.5);
  });

  it('loss SELL gets FIFO cost basis and opens a wash-sale entry', async () => {
    const buy: TradeRecord = {
      timestamp: '2026-01-02T00:00:00.000Z',
      symbol: 'BRK-B', action: 'BUY', qty: 3, estimatedValue: 1800,
      fillPrice: 600, orderId: 1, status: 'filled', reason: 'seed',
    };
    const { deps, trades } = makeDeps({
      history: [buy],
      confirm: { 'BRK-B': { totalFilledQty: 3, avgFillPrice: 500 } },
    });
    const outcome = await executeQueue([MIXED_QUEUE[0]], ctx(), deps);

    expect(trades[0].costBasisPrice).toBe(600);
    expect(trades[0].realisedPnlUsd).toBeLessThan(0);
    expect(outcome.washSales.map(w => w.symbol)).toEqual(['BRK-B']);
  });

  it('profitable SELL opens no wash-sale entry', async () => {
    const buy: TradeRecord = {
      timestamp: '2026-01-02T00:00:00.000Z',
      symbol: 'BRK-B', action: 'BUY', qty: 3, estimatedValue: 1200,
      fillPrice: 400, orderId: 1, status: 'filled', reason: 'seed',
    };
    const { deps } = makeDeps({
      history: [buy],
      confirm: { 'BRK-B': { totalFilledQty: 3, avgFillPrice: 500 } },
    });
    const outcome = await executeQueue([MIXED_QUEUE[0]], ctx(), deps);
    expect(outcome.washSales).toEqual([]);
  });
});

describe('executeQueue — confirmFill invoked with the placed order id', () => {
  it('passes each placement result.orderId into confirmFill (not a stale/wrong id)', async () => {
    const { deps, confirmCalls, placed } = makeDeps();
    await executeQueue(MIXED_QUEUE, ctx(), deps);
    // Every confirm call must carry the orderId returned by the matching
    // placement — a regression that confirmed a wrong/zero id would break this.
    expect(confirmCalls.length).toBeGreaterThan(0);
    for (const c of confirmCalls) {
      const match = placed.find(p => p.order.symbol === c.symbol);
      expect(c.orderId).toBe(match!.orderId);
      expect(c.orderId).toBeGreaterThan(0);
    }
  });
});

describe('executeQueue — unusable orderId (gateway coerces missing id to 0)', () => {
  it('halts without recording a trade and without requeueing the phantom order', async () => {
    const { deps, calls, trades } = makeDeps({ zeroOrderId: ['BRK-B'] });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(true);
    // Never reached confirmation, never recorded a fill.
    expect(calls).not.toContain('confirm:BRK-B');
    expect(trades).toHaveLength(0);
    // The zero-id order is NOT requeued (might be working); remainder is.
    expect(outcome.requeue.some(o => o.symbol === 'BRK-B')).toBe(false);
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['NET', 'AVGO', 'GLD']);
  });
});

describe('executeQueue — getAccountCash failure', () => {
  it('defers all buys (sells already recorded) instead of throwing out of the run', async () => {
    const { deps, trades } = makeDeps({ cashThrows: true });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    // Both sells executed and were recorded before the cash fetch failed.
    expect(trades.map(t => t.symbol)).toEqual(['BRK-B', 'NET']);
    // Buys deferred, not lost; run did not reject.
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['AVGO', 'GLD']);
  });
});

describe('executeQueue — window closes mid-run', () => {
  it('halts before placing an order once the window has closed', async () => {
    // Window open for the first 2 checks (BRK-B, NET), closed for the buys.
    const { deps, calls } = makeDeps({ windowOpenFor: 2 });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(calls.filter(c => c.startsWith('place:'))).toEqual([
      'place:SELL:BRK-B',
      'place:SELL:NET',
    ]);
    expect(outcome.halted).toBe(true);
    expect(outcome.haltReason).toContain('window');
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['AVGO', 'GLD']);
  });
});

describe('executeQueue — cancel/reject carrying real fills', () => {
  it('records the shares EXECUTIONS confirm on a cancel (authoritative), then halts on the partial', async () => {
    // confirmFill reports cancelled; executions are the truth — NET's orderId
    // is 101 (BRK-B is the first placement, 100). Executions show 30 filled.
    const { deps, trades } = makeDeps({
      confirm: { 'NET': { status: 'cancelled', totalFilledQty: 0 } },
      executions: [{ execId: 'E-NET', symbol: 'NET', action: 'SELL', qty: 30, price: 250, orderId: 101 }],
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    // The 30 shares that actually executed (per IBKR) are on the tax ledger.
    const netTrade = trades.find(t => t.symbol === 'NET');
    expect(netTrade?.qty).toBe(30);
    expect(netTrade?.fillPrice).toBe(250);
    expect(outcome.confirmedFill).toBe(true);
    // Partial (30 of 43) → still halts (remainder unknown), buys not placed.
    expect(outcome.halted).toBe(true);
    expect(outcome.requeue.map(o => o.symbol)).toEqual(['AVGO', 'GLD']);
  });

  it('CONTINUES the batch when executions confirm a FULL fill despite a "cancelled" report (the TWLO bug)', async () => {
    // Single sell: confirmFill lies "cancelled 0", executions show full 43 fill.
    const q = [order('NET', 'SELL', 10800, 43)];
    const { deps, trades, cancelled } = makeDeps({
      confirm: { 'NET': { status: 'cancelled', totalFilledQty: 0 } },
      executions: [{ execId: 'E1', symbol: 'NET', action: 'SELL', qty: 43, price: 250, orderId: 100 }],
      avgCosts: { NET: 60 },
    });
    const outcome = await executeQueue(q, ctx(), deps);
    expect(trades.find(t => t.symbol === 'NET')?.qty).toBe(43);
    expect(outcome.confirmedFill).toBe(true);
    expect(outcome.halted).toBe(false); // full fill → batch continues, no false halt
    expect(cancelled).not.toContain(100); // don't cancel a filled order
  });
});

describe('executeQueue — cancel on unconfirmed state', () => {
  it('cancels the working order on a zero-fill timeout', async () => {
    const { deps, cancelled, placed } = makeDeps({
      confirm: { 'NET': { status: 'pending', totalFilledQty: 0, timedOut: true, remainingQty: 43 } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);
    const netId = placed.find(p => p.order.symbol === 'NET')!.orderId;
    expect(cancelled).toContain(netId);
    expect(outcome.halted).toBe(true);
  });

  it('cancels the remainder on a timed-out partial (but records the filled shares)', async () => {
    const { deps, cancelled, placed, trades } = makeDeps({
      confirm: { 'NET': { status: 'partial', totalFilledQty: 40, remainingQty: 3, timedOut: true } },
    });
    await executeQueue(MIXED_QUEUE, ctx(), deps);
    const netId = placed.find(p => p.order.symbol === 'NET')!.orderId;
    expect(cancelled).toContain(netId);
    expect(trades.find(t => t.symbol === 'NET')?.qty).toBe(40);
  });

  it('cancels the order when the confirm stream errors', async () => {
    const { deps, cancelled, placed } = makeDeps({ failConfirm: ['BRK-B'] });
    await executeQueue(MIXED_QUEUE, ctx(), deps);
    const id = placed.find(p => p.order.symbol === 'BRK-B')!.orderId;
    expect(cancelled).toContain(id);
  });
});

describe('executeQueue — orders cursor floor', () => {
  it('passes ctx.ordersCursorFloor into confirmFill so stale events are skipped', async () => {
    let seenFromCursor: number | undefined;
    const { deps } = makeDeps();
    const inner = deps.confirmFill;
    deps.confirmFill = (orderId, opts) => {
      seenFromCursor = opts.fromCursor;
      return inner(orderId, opts);
    };
    await executeQueue([MIXED_QUEUE[0]], ctx({ ordersCursorFloor: 4242 }), deps);
    expect(seenFromCursor).toBe(4242);
  });
});

describe('executeQueue — confirmed qty with unparseable price', () => {
  it('adopts the filled qty even when avgFillPrice is NaN (keeps decision price)', async () => {
    const { deps, trades } = makeDeps({
      confirm: { 'BRK-B': { status: 'partial', totalFilledQty: 2, remainingQty: 1, avgFillPrice: NaN } },
    });
    await executeQueue([MIXED_QUEUE[0]], ctx(), deps);

    expect(trades[0].qty).toBe(2);                 // NOT the full order qty of 3
    expect(trades[0].fillPrice).toBe(1500 / 3);    // decision price fallback
  });
});

describe('executeQueue — partial remainder value scaling', () => {
  it('requeues the remainder with estimatedValue scaled to remaining shares', async () => {
    const { deps } = makeDeps({
      confirm: { 'NET': { status: 'partial', totalFilledQty: 40, remainingQty: 3 } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);
    const remainder = outcome.requeue.find(o => o.symbol === 'NET')!;
    expect(remainder.qty).toBe(3);
    // Original: 43 sh @ 10800 → per-share ~251.16; remainder value ~753.5.
    expect(remainder.estimatedValue).toBeCloseTo((10800 / 43) * 3, 2);
  });
});

describe('executeQueue — partial-fill tax P&L uses filled qty', () => {
  it('books realised P&L on the filled shares, not the submitted qty', async () => {
    const buy: TradeRecord = {
      timestamp: '2026-01-02T00:00:00.000Z',
      symbol: 'NET', action: 'BUY', qty: 43, estimatedValue: 43 * 260,
      fillPrice: 260, orderId: 1, status: 'filled', reason: 'seed',
    };
    const { deps, trades } = makeDeps({
      history: [buy],
      confirm: { 'NET': { status: 'partial', totalFilledQty: 3, remainingQty: 40, avgFillPrice: 240 } },
    });
    await executeQueue([MIXED_QUEUE[1]], ctx(), deps);
    const netTrade = trades.find(t => t.symbol === 'NET')!;
    // 3 filled shares * (240 - 260) = -60, NOT 43 * -20 = -860.
    expect(netTrade.realisedPnlUsd).toBeCloseTo(-60, 6);
  });
});

describe('executeQueue — confirmation disabled (opt-out)', () => {
  it('skips confirmFill, trusts acceptance, still unlocks validation state', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await executeQueue(
      MIXED_QUEUE,
      ctx({ fillConfirmationEnabled: false }),
      deps,
    );
    expect(calls.some(c => c.startsWith('confirm:'))).toBe(false);
    expect(outcome.confirmedFill).toBe(true);
    expect(outcome.halted).toBe(false);
  });
});

describe('executeQueue — absolute notional caps', () => {
  const caps = { maxOrderNotionalUsd: 15000, maxOrderPctNav: 50, maxRunNotionalUsd: 60000 };

  it('halts and places nothing when an order breaches the $ cap', async () => {
    const { deps, calls } = makeDeps();
    // A single implausibly large sell (bad-data blowup).
    const bad = [order('NET', 'SELL', 40000, 43)];
    const outcome = await executeQueue(bad, ctx({ caps }), deps);
    expect(outcome.halted).toBe(true);
    expect(outcome.haltReason).toContain('cap breached');
    expect(calls.some(c => c.startsWith('place:'))).toBe(false);
  });

  it('passes the real queue (largest order ~$10.9k, ~37% of NAV) under caps', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await executeQueue(MIXED_QUEUE, ctx({ nav: 29156, caps }), deps);
    expect(outcome.halted).toBe(false);
    expect(calls.filter(c => c.startsWith('place:')).length).toBe(MIXED_QUEUE.length);
  });
});

describe('executeQueue — idempotency guard fails closed', () => {
  it('halts and places nothing if getLiveOrders throws (cannot verify no duplicate)', async () => {
    const { deps, calls } = makeDeps({ liveOrdersThrows: true });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(true);
    expect(outcome.haltReason).toContain('idempotency');
    // No order was placed — the whole queue stays for the next run.
    expect(calls.some(c => c.startsWith('place:'))).toBe(false);
    expect(outcome.requeue.map(o => o.symbol)).toEqual(MIXED_QUEUE.map(o => o.symbol));
    expect(outcome.executed).toEqual([]);
  });
});

describe('executeQueue — go-live blocker fixes', () => {
  it('idempotency: skips placing an order that is already working at IBKR', async () => {
    // NET already has a working SELL at the broker → do not place a duplicate.
    const { deps, calls, placed } = makeDeps({ liveWorking: ['SELL:NET'] });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(placed.some(p => p.order.symbol === 'NET')).toBe(false);
    expect(calls).not.toContain('place:SELL:NET');
    // NET is dropped from the queue (IBKR owns it); the rest proceed.
    expect(outcome.requeue.some(o => o.symbol === 'NET')).toBe(false);
    expect(outcome.executed.some(o => o.symbol === 'BRK-B')).toBe(true);
  });

  it('incremental persistence: queue on disk never contains an executed order', async () => {
    const { deps, persisted } = makeDeps();
    await executeQueue(MIXED_QUEUE, ctx(), deps);
    // After BRK-B and NET execute, no persisted snapshot may still list them.
    const brkbSnapshots = persisted.filter(s => s.some(o => o.symbol === 'BRK-B'));
    const lastSnapshot = persisted[persisted.length - 1];
    // The final persisted queue is empty (everything executed).
    expect(lastSnapshot).toEqual([]);
    // And once BRK-B was executed, later snapshots dropped it (monotonic shrink).
    const idxLastBrkb = persisted.map((s, i) => s.some(o => o.symbol === 'BRK-B') ? i : -1).filter(i => i >= 0).pop() ?? -1;
    const idxFirstEmpty = persisted.findIndex(s => s.length === 0);
    expect(idxFirstEmpty).toBeGreaterThan(idxLastBrkb);
    expect(brkbSnapshots.length).toBeLessThan(persisted.length);
  });

  it('crash-safety: a mid-run halt leaves ONLY unexecuted orders persisted', async () => {
    // NET rejects after BRK-B fills; disk must show BRK-B gone, NET gone (dropped),
    // buys still queued — so a crash here cannot replay BRK-B.
    const { deps, persisted } = makeDeps({
      confirm: { 'NET': { status: 'rejected', totalFilledQty: 0 } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);
    const last = persisted[persisted.length - 1];
    expect(last.some(o => o.symbol === 'BRK-B')).toBe(false); // executed → not on disk
    expect(last.map(o => o.symbol)).toEqual(['AVGO', 'GLD']);  // untouched buys
    expect(outcome.requeue).toEqual(last);
  });

  it('phantom fill: filled status with zero qty records nothing and halts', async () => {
    const { deps, trades, cancelled, placed } = makeDeps({
      confirm: { 'BRK-B': { status: 'filled', totalFilledQty: 0, remainingQty: 3 } },
    });
    const outcome = await executeQueue([MIXED_QUEUE[0]], ctx(), deps);
    expect(trades).toHaveLength(0);            // no phantom trade recorded
    expect(outcome.confirmedFill).toBe(false); // validation must NOT unlock
    expect(outcome.halted).toBe(true);
    expect(cancelled).toContain(placed[0].orderId);
  });

  it('guarded recording: a trade-history write failure does not unwind the run', async () => {
    // appendTrade throws on the fill, but the run must still complete and mark
    // the order executed (removed from the queue) rather than re-queue it.
    const { deps, persisted } = makeDeps({ appendThrows: true });
    const outcome = await executeQueue([order('BRK-B', 'SELL', 1500, 3)], ctx(), deps);
    expect(outcome.executed.map(o => o.symbol)).toEqual(['BRK-B']);
    expect(persisted[persisted.length - 1]).toEqual([]); // dropped from queue
    expect(outcome.halted).toBe(false);
  });

  it('outcome.executed reports filled qty for reconciliation', async () => {
    const { deps } = makeDeps({
      confirm: { 'NET': { status: 'partial', totalFilledQty: 40, remainingQty: 3 } },
    });
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);
    const netExec = outcome.executed.find(o => o.symbol === 'NET');
    expect(netExec?.qty).toBe(40);
  });
});

describe('executeQueue — persistence failure halts', () => {
  it('halts and stops placing further orders when persistRemaining throws', async () => {
    const { deps, calls } = makeDeps();
    // Make the FIRST persist (after BRK-B completes) throw.
    let persistCalls = 0;
    deps.persistRemaining = () => {
      persistCalls += 1;
      if (persistCalls === 1) throw new Error('disk full writing bot-state.json');
    };
    const outcome = await executeQueue(MIXED_QUEUE, ctx(), deps);

    expect(outcome.halted).toBe(true);
    expect(outcome.haltReason).toContain('persist');
    // BRK-B placed; after its persist failed, no further orders placed.
    const placed = calls.filter(c => c.startsWith('place:'));
    expect(placed).toEqual(['place:SELL:BRK-B']);
  });
});

describe('executeQueue — reconcile a fill the confirmation missed (the TSLA bug)', () => {
  it('records a fill that IBKR executions confirm, even when confirmFill timed out at 0/N', async () => {
    const q = [order('TSLA', 'SELL', 2761, 7)];
    const { deps, trades, cancelled } = makeDeps({
      confirm: { 'TSLA': { status: 'pending', totalFilledQty: 0, timedOut: true, remainingQty: 7 } },
      executions: [{ execId: 'E1', symbol: 'TSLA', action: 'SELL', qty: 7, price: 403.88, orderId: 100 }],
      avgCosts: { TSLA: 240.34 },
    });
    const outcome = await executeQueue(q, ctx(), deps);

    // The fill is NOT lost — it's recovered from executions.
    const t = trades.find(x => x.symbol === 'TSLA');
    expect(t?.qty).toBe(7);
    expect(t?.fillPrice).toBeCloseTo(403.88, 2);
    expect(t?.realisedPnlUsd).toBeCloseTo(7 * (403.88 - 240.34), 2); // avg-cost fallback
    expect(outcome.confirmedFill).toBe(true);
    // Must NOT cancel — it actually filled.
    expect(cancelled).not.toContain(100);
  });

  it('still cancels + records nothing when executions confirm NO fill', async () => {
    const q = [order('NET', 'SELL', 10800, 43)];
    const { deps, trades, cancelled, placed } = makeDeps({
      confirm: { 'NET': { status: 'pending', totalFilledQty: 0, timedOut: true, remainingQty: 43 } },
      executions: [],
    });
    const outcome = await executeQueue(q, ctx(), deps);
    expect(trades).toHaveLength(0);
    expect(outcome.confirmedFill).toBe(false);
    expect(cancelled).toContain(placed[0].orderId);
  });

  it('recovers the fill when confirmFill throws (stream de-authed)', async () => {
    const q = [order('TSLA', 'SELL', 2761, 7)];
    const { deps, trades } = makeDeps({
      failConfirm: ['TSLA'],
      executions: [{ execId: 'E1', symbol: 'TSLA', action: 'SELL', qty: 7, price: 403.88, orderId: 100 }],
      avgCosts: { TSLA: 240.34 },
    });
    const outcome = await executeQueue(q, ctx(), deps);
    expect(trades.find(x => x.symbol === 'TSLA')?.qty).toBe(7);
    expect(outcome.confirmedFill).toBe(true);
  });
});

describe('executeQueue — avg-cost fallback for cost basis (no FIFO lot)', () => {
  it('uses the position avg cost when the ledger has no opening lot', async () => {
    const q = [order('TSLA', 'SELL', 2761, 7)];
    const { deps, trades } = makeDeps({
      confirm: { 'TSLA': { status: 'filled', totalFilledQty: 7, avgFillPrice: 403.88, remainingQty: 0 } },
      avgCosts: { TSLA: 240.34 },
    });
    await executeQueue(q, ctx(), deps);
    const t = trades.find(x => x.symbol === 'TSLA');
    expect(t?.costBasisPrice).toBe(240.34);
    expect(t?.realisedPnlUsd).toBeCloseTo(7 * (403.88 - 240.34), 2);
  });
});
