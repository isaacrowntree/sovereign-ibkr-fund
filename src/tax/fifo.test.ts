import { describe, it, expect } from 'vitest';
import { matchSellFifo } from './fifo.js';
import type { TradeRecord } from '../state/store.js';

const buy = (ts: string, qty: number, price: number): TradeRecord => ({
  timestamp: ts, symbol: 'NET', action: 'BUY', qty, estimatedValue: qty * price,
  fillPrice: price, orderId: 1, status: 'filled', reason: 'seed',
});

const sellWithLots = (
  ts: string,
  lots: Array<{ buyTimestamp: string; qty: number; buyPrice: number; longTerm: boolean }>,
): TradeRecord => ({
  timestamp: ts, symbol: 'NET', action: 'SELL', qty: lots.reduce((s, l) => s + l.qty, 0),
  estimatedValue: 0, orderId: 2, status: 'filled', reason: 'prior', matchedLots: lots,
});

const T2026 = new Date('2026-07-04T00:00:00Z').getTime();

describe('matchSellFifo', () => {
  it('single full lot: cost basis and P&L are exact', () => {
    const m = matchSellFifo([buy('2026-01-02', 3, 600)], 'NET', 3, 500, T2026);
    expect(m.matchedQty).toBe(3);
    expect(m.costBasisPrice).toBe(600);
    expect(m.realisedPnlUsd).toBe(3 * (500 - 600));
    expect(m.lots).toHaveLength(1);
  });

  it('multi-lot sell: weights cost basis across lots, correct P&L sign', () => {
    // The scenario the whole-lot matcher got wrong: 10 @ $100 (old) + 90 @ $200.
    // SELL 100 @ $150 → true P&L = 10*(+50) + 90*(-50) = -4000 (a LOSS).
    const history = [buy('2026-01-01', 10, 100), buy('2026-02-01', 90, 200)];
    const m = matchSellFifo(history, 'NET', 100, 150, T2026);
    expect(m.matchedQty).toBe(100);
    expect(m.realisedPnlUsd).toBe(10 * 50 + 90 * -50); // -4000
    expect(m.realisedPnlUsd).toBeLessThan(0);          // loss → wash-sale must open
    expect(m.costBasisPrice).toBeCloseTo((10 * 100 + 90 * 200) / 100, 6); // 190
    expect(m.lots.map(l => l.qty)).toEqual([10, 90]);
  });

  it('partial lot: consumes only part of an oversized lot', () => {
    const m = matchSellFifo([buy('2026-01-01', 100, 100)], 'NET', 30, 120, T2026);
    expect(m.matchedQty).toBe(30);
    expect(m.realisedPnlUsd).toBe(30 * 20);
    expect(m.lots[0].qty).toBe(30);
  });

  it('a later sell picks up the remainder of a lot the first sell partly used', () => {
    const history: TradeRecord[] = [
      buy('2026-01-01', 100, 100),
      // First sell consumed 30 of the lot (recorded as a matchedLot).
      sellWithLots('2026-03-01', [{ buyTimestamp: '2026-01-01', qty: 30, buyPrice: 100, longTerm: false }]),
    ];
    const m = matchSellFifo(history, 'NET', 50, 130, T2026);
    // 70 remain in the lot; sell 50 → all from that lot at $100.
    expect(m.matchedQty).toBe(50);
    expect(m.costBasisPrice).toBe(100);
    expect(m.realisedPnlUsd).toBe(50 * 30);
  });

  it('legacy matchedBuyTimestamp consumes the whole prior lot', () => {
    const history: TradeRecord[] = [
      buy('2026-01-01', 100, 100),
      { timestamp: '2026-03-01', symbol: 'NET', action: 'SELL', qty: 10, estimatedValue: 0,
        orderId: 3, status: 'filled', reason: 'legacy', matchedBuyTimestamp: '2026-01-01' },
      buy('2026-04-01', 20, 300),
    ];
    // The 2026-01-01 lot is fully consumed by the legacy sell; new sell hits the $300 lot.
    const m = matchSellFifo(history, 'NET', 5, 320, T2026);
    expect(m.costBasisPrice).toBe(300);
    expect(m.realisedPnlUsd).toBe(5 * 20);
  });

  it('long-term parcels: reports the >12-month quantity', () => {
    const history = [buy('2024-01-01', 40, 100), buy('2026-06-01', 60, 100)];
    const m = matchSellFifo(history, 'NET', 100, 120, T2026);
    expect(m.longTermQty).toBe(40); // only the 2024 lot is > 12 months
  });

  it('short history: matches what it can and reports the shortfall', () => {
    const m = matchSellFifo([buy('2026-01-01', 5, 100)], 'NET', 20, 120, T2026);
    expect(m.matchedQty).toBe(5);
    expect(m.lots).toHaveLength(1);
  });

  it('no matching buys: zero matched, no cost basis', () => {
    const m = matchSellFifo([], 'NET', 10, 100, T2026);
    expect(m.matchedQty).toBe(0);
    expect(m.costBasisPrice).toBe(0);
    expect(m.realisedPnlUsd).toBe(0);
  });
});
