import { describe, it, expect } from 'vitest';
import {
  assessBands, decideBands, generateBandOrders, openLotsFifo, planSellFromLots, discountDate,
  describeBands, PLAN_BANDS, type OpenLot,
} from './drift-bands.js';
import type { PortfolioSnapshot } from './rebalance.js';

/** Build a snapshot from { sym: [price, shares] } with explicit cash. */
function snap(book: Record<string, [number, number]>, cash: number): PortfolioSnapshot {
  const prices = new Map<string, number>();
  const currentShares = new Map<string, number>();
  let nav = cash;
  for (const [s, [p, q]] of Object.entries(book)) {
    prices.set(s, p);
    currentShares.set(s, q);
    nav += p * q;
  }
  return { symbols: Object.keys(book), prices, currentShares, nav, cash, peakNav: nav };
}

describe('PLAN_BANDS', () => {
  it('are exactly the plan\'s F1 parameters', () => {
    expect(PLAN_BANDS).toEqual({
      minBand: 0.015, relBand: 0.25, shareBand: 0.75,
      portfolioTrigger: 0.05, urgentMin: 0.04, urgentRel: 0.75, taxGuardDays: 60,
    });
  });
});

describe('assessBands', () => {
  it('band = max(1.5pp, 25% of target, ¾ of one share)', () => {
    // NAV 100k. A: 8% target → 2pp band. B: 2% target → 1.5pp floor.
    // C: 2% target, $2,000 share → ¾·2% = 1.5pp... use $3,000 → 2.25pp.
    const s = snap({ A: [100, 80], B: [100, 20], C: [3000, 0] }, 100_000 - 10_000);
    const a = assessBands(s, new Map([['A', 0.08], ['B', 0.02], ['C', 0.02]]));
    const band = (x: string) => a.names.find(n => n.symbol === x)!.band;
    expect(band('A')).toBeCloseTo(0.02, 12);
    expect(band('B')).toBeCloseTo(0.015, 12);
    expect(band('C')).toBeCloseTo(0.0225, 12);
  });

  it('a 2% name that triples is out of band and urgent — the legacy 10pp gate never sees it', () => {
    // NAV 100k, target 2%, holding 6% → dev +4pp ≥ max(4pp, 1.5pp) → urgent.
    const s = snap({ X: [100, 60], REST: [100, 940] }, 0);
    const a = assessBands(s, new Map([['X', 0.02], ['REST', 0.98]]));
    const x = a.names.find(n => n.symbol === 'X')!;
    expect(x.out).toBe('over');
    expect(x.urgent).toBe(true);
    expect(a.urgent).toEqual(['X']);
  });

  it('portfolio trigger is half the L1 distance, at 5%', () => {
    const s = snap({ A: [100, 550], B: [100, 450] }, 0); // 55/45 vs 50/50 → ½(5+5) = 5%
    expect(assessBands(s, new Map([['A', 0.5], ['B', 0.5]])).triggered).toBe(true);
    const t = snap({ A: [100, 540], B: [100, 460] }, 0);
    expect(assessBands(t, new Map([['A', 0.5], ['B', 0.5]])).triggered).toBe(false);
  });
});

describe('decideBands', () => {
  const base = { names: [], halfL1: 0, triggered: false, urgent: [] as string[] };
  it('urgent ignores the cooldown; the cooldown gates the regular trigger', () => {
    expect(decideBands({ ...base, urgent: ['X'] }, 0, 45)).toBe('urgent');
    expect(decideBands({ ...base, triggered: true }, 44.9, 45)).toBe('too-soon');
    expect(decideBands({ ...base, triggered: true }, 45, 45)).toBe('regular');
    expect(decideBands(base, 999, 45)).toBe('within-threshold');
  });
});

describe('generateBandOrders', () => {
  const opts = { minTradeUsd: 200, cashBufferPct: 1, today: '2026-09-24' };

  it('trims an overweight to target + half its band, not to target', () => {
    // NAV 100k; A target 20% (band 5pp), held 30% → trim to 22.5%.
    const s = snap({ A: [100, 300], B: [100, 700] }, 0);
    const a = assessBands(s, new Map([['A', 0.2], ['B', 0.8]]));
    const { orders } = generateBandOrders(s, a, { ...opts, decision: 'regular' });
    const sell = orders.find(o => o.action === 'SELL')!;
    expect(sell.symbol).toBe('A');
    expect(sell.shares).toBe(75); // 30k → 22.5k
  });

  it('urgent trims only the urgent names; regular trims every out-of-band overweight', () => {
    // NAV 100k. X: target 2%, held 6% (urgent). Y: target 20%, held 26% (out, not urgent: 6 < 15).
    const s = snap({ X: [100, 60], Y: [100, 260], Z: [100, 680] }, 0);
    const t = new Map([['X', 0.02], ['Y', 0.2], ['Z', 0.78]]);
    const a = assessBands(s, t);
    const urgent = generateBandOrders(s, a, { ...opts, decision: 'urgent' }).orders.filter(o => o.action === 'SELL');
    expect(urgent.map(o => o.symbol)).toEqual(['X']);
    const regular = generateBandOrders(s, a, { ...opts, decision: 'regular' }).orders.filter(o => o.action === 'SELL');
    expect(regular.map(o => o.symbol).sort()).toEqual(['X', 'Y']);
  });

  it('no sells and no buys for too-soon / within-threshold (the caller routes those to cash flow)', () => {
    const s = snap({ A: [100, 300], B: [100, 700] }, 5_000);
    const a = assessBands(s, new Map([['A', 0.2], ['B', 0.8]]));
    expect(generateBandOrders(s, a, { ...opts, decision: 'too-soon' }).orders).toEqual([]);
    expect(generateBandOrders(s, a, { ...opts, decision: 'within-threshold' }).orders).toEqual([]);
  });

  it('buys fill underweights to target from cash + proceeds, greedy, half-share rule, less the buffer', () => {
    // NAV 100k: A 30% vs 20% (sell 75 → +7.5k), B 60% vs 80%, cash 10k.
    const s = snap({ A: [100, 300], B: [1000, 60] }, 10_000);
    const a = assessBands(s, new Map([['A', 0.2], ['B', 0.8]]));
    const { orders } = generateBandOrders(s, a, { ...opts, decision: 'regular' });
    const buy = orders.find(o => o.action === 'BUY')!;
    // budget = 10k + 7.5k − max(50, 1k) = 16.5k → 16 shares of B at $1,000.
    expect(buy).toMatchObject({ symbol: 'B', shares: 16 });
  });

  it('the half-share rule: a deficit under half a share is not bought', () => {
    // B is $400 under target with a $1,000 share: no buy (would overshoot by $600).
    const s = snap({ A: [100, 300], B: [1000, 69] }, 600);
    const t = new Map([['A', 0.2], ['B', 0.7], ['C', 0.1]]);
    s.prices.set('C', 1); s.currentShares.set('C', 0);
    const a = assessBands(s, t);
    const buys = generateBandOrders(s, a, { ...opts, minTradeUsd: 0, decision: 'regular' }).orders.filter(o => o.action === 'BUY');
    expect(buys.find(o => o.symbol === 'B')).toBeUndefined();
  });

  it('sells run loss-first across names', () => {
    const s = snap({ A: [100, 300], B: [100, 300], C: [100, 400] }, 0);
    const t = new Map([['A', 0.2], ['B', 0.2], ['C', 0.6]]);
    const a = assessBands(s, t);
    const lots = new Map<string, OpenLot[]>([
      ['A', [{ date: '2020-01-02', qty: 300, cost: 50 }]], // gain
      ['B', [{ date: '2020-01-02', qty: 300, cost: 150 }]], // loss
    ]);
    const sells = generateBandOrders(s, a, { ...opts, decision: 'regular', lots }).orders.filter(o => o.action === 'SELL');
    expect(sells.map(o => o.symbol)).toEqual(['B', 'A']);
  });

  it('the rebuy guard exclusion applies to the buy side', () => {
    const s = snap({ A: [100, 300], B: [1000, 60] }, 10_000);
    const a = assessBands(s, new Map([['A', 0.2], ['B', 0.8]]));
    const r = generateBandOrders(s, a, { ...opts, decision: 'regular', excludeBuys: new Set(['B']) });
    expect(r.orders.some(o => o.action === 'BUY')).toBe(false);
    expect(r.notes.join()).toContain('rebuy guard');
  });

  it('describeBands produces the shadow log line', () => {
    const s = snap({ A: [100, 300], B: [100, 700] }, 0);
    const a = assessBands(s, new Map([['A', 0.2], ['B', 0.8]]));
    const d = decideBands(a, 100, 45);
    const line = describeBands(a, d, generateBandOrders(s, a, { ...opts, decision: d }));
    expect(line).toMatch(/^regular; ½Σ\|dev\| 10\.00% .*out of band: A\+10\.0pp;.*sells: A×75; buys: B×65/);
  });
});

describe('lots and the CGT guard', () => {
  it('discountDate is buy date + 1 year + 1 day', () => {
    expect(discountDate('2025-03-10')).toBe('2026-03-11');
    expect(discountDate('2024-02-29')).toBe('2025-03-01'); // the tax module's rule: 28 Feb 2025 + 1 day
  });

  it('openLotsFifo replays the ledger FIFO and reconciles to the broker quantity', () => {
    const trades = [
      { symbol: 'A', action: 'BUY' as const, qty: 10, timestamp: '2025-01-10T15:00:00Z', fillPrice: 10 },
      { symbol: 'A', action: 'BUY' as const, qty: 5, timestamp: '2025-06-10T15:00:00Z', fillPrice: 20 },
      { symbol: 'A', action: 'SELL' as const, qty: 12, timestamp: '2025-07-10T15:00:00Z', fillPrice: 25 },
      { symbol: 'B', action: 'BUY' as const, qty: 99, timestamp: '2025-01-10T15:00:00Z', fillPrice: 1 },
    ];
    expect(openLotsFifo(trades, 'A', 3)).toEqual([{ date: '2025-06-10', qty: 3, cost: 20 }]);
    // IBKR holds 8: five predate the ledger and sit at the FRONT, undated.
    expect(openLotsFifo(trades, 'A', 8)).toEqual([
      { date: null, qty: 5, cost: null },
      { date: '2025-06-10', qty: 3, cost: 20 },
    ]);
    // Ledger over-counts: trimmed from the front.
    expect(openLotsFifo(trades, 'A', 1)).toEqual([{ date: '2025-06-10', qty: 1, cost: 20 }]);
  });

  it('stops a trim before a gain lot within 60 days of its discount date', () => {
    const lots: OpenLot[] = [
      { date: '2025-01-02', qty: 10, cost: 50 }, // already discounted → sellable
      { date: '2025-10-01', qty: 10, cost: 50 }, // discount 2026-10-02: 8 days away → protected
      { date: '2025-11-01', qty: 10, cost: 50 },
    ];
    const p = planSellFromLots(lots, 25, 100, '2026-09-24', 60, false);
    expect(p.qty).toBe(10);
    expect(p.heldBack).toContain('2026-10-02');
    // Urgent overrides the guard.
    expect(planSellFromLots(lots, 25, 100, '2026-09-24', 60, true).qty).toBe(25);
    // A LOSS lot near its discount date is not protected (selling it realises a loss).
    const loss: OpenLot[] = [{ date: '2025-10-01', qty: 10, cost: 150 }];
    expect(planSellFromLots(loss, 10, 100, '2026-09-24', 60, false).qty).toBe(10);
    // A gain lot far from its discount date is not protected either.
    const young: OpenLot[] = [{ date: '2026-06-01', qty: 10, cost: 50 }];
    expect(planSellFromLots(young, 10, 100, '2026-09-24', 60, false).qty).toBe(10);
  });

  it('undated lots are sold (they predate the ledger) and reported', () => {
    const p = planSellFromLots([{ date: null, qty: 5, cost: null }], 3, 100, '2026-09-24', 60, false);
    expect(p).toMatchObject({ qty: 3, undatedQty: 3, heldBack: null });
  });

  it('a held-back trim is visible in the notes', () => {
    const s = snap({ A: [100, 300], B: [100, 700] }, 0);
    const a = assessBands(s, new Map([['A', 0.2], ['B', 0.8]]));
    const lots = new Map<string, OpenLot[]>([['A', [{ date: '2025-10-01', qty: 300, cost: 50 }]]]);
    const r = generateBandOrders(s, a, { minTradeUsd: 200, cashBufferPct: 1, today: '2026-09-24', decision: 'regular', lots });
    expect(r.orders.some(o => o.action === 'SELL')).toBe(false);
    expect(r.notes[0]).toMatch(/A: trim 0\/75 — a gain lot bought 2025-10-01/);
  });
});
