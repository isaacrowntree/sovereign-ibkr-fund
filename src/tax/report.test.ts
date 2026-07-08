import { describe, it, expect } from 'vitest';
import { computeTaxLots, generateTaxSummary } from './report';
import type { TradeRecord } from '../state/store';

function makeTrade(overrides: Partial<TradeRecord>): TradeRecord {
  return {
    timestamp: '2026-01-15T00:00:00.000Z',
    symbol: 'VTI',
    action: 'BUY',
    qty: 100,
    estimatedValue: 33500,
    fillPrice: 335,
    orderId: 1,
    status: 'Filled',
    reason: 'test',
    commission: 0,
    ...overrides,
  };
}

describe('computeTaxLots — FIFO matching', () => {
  it('matches a single BUY to a single SELL', () => {
    const trades: TradeRecord[] = [
      makeTrade({ action: 'BUY', qty: 100, fillPrice: 300, timestamp: '2026-01-15T00:00:00Z' }),
      makeTrade({ action: 'SELL', qty: 100, fillPrice: 335, timestamp: '2026-03-15T00:00:00Z' }),
    ];
    const lots = computeTaxLots(trades);
    expect(lots).toHaveLength(1);
    expect(lots[0].qty).toBe(100);
    expect(lots[0].realisedPnl).toBeCloseTo(3500, 0); // (335-300)*100
    expect(lots[0].longTerm).toBe(false);
  });

  it('handles FIFO order', () => {
    const trades: TradeRecord[] = [
      makeTrade({ action: 'BUY', qty: 50, fillPrice: 280, timestamp: '2026-01-01T00:00:00Z' }),
      makeTrade({ action: 'BUY', qty: 50, fillPrice: 320, timestamp: '2026-02-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', qty: 50, fillPrice: 335, timestamp: '2026-03-01T00:00:00Z' }),
    ];
    const lots = computeTaxLots(trades);
    expect(lots).toHaveLength(1);
    expect(lots[0].realisedPnl).toBeCloseTo(2750, 0); // (335-280)*50
  });

  it('splits a large SELL across multiple BUYs', () => {
    const trades: TradeRecord[] = [
      makeTrade({ action: 'BUY', qty: 50, fillPrice: 280, timestamp: '2026-01-01T00:00:00Z' }),
      makeTrade({ action: 'BUY', qty: 50, fillPrice: 320, timestamp: '2026-02-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', qty: 100, fillPrice: 335, timestamp: '2026-03-01T00:00:00Z' }),
    ];
    const lots = computeTaxLots(trades);
    expect(lots).toHaveLength(2);
    expect(lots[0].qty).toBe(50);
    expect(lots[1].qty).toBe(50);
  });

  it('deducts commissions from cost basis and proceeds', () => {
    const trades: TradeRecord[] = [
      makeTrade({ action: 'BUY', qty: 100, fillPrice: 300, commission: 1.00, timestamp: '2026-01-15T00:00:00Z' }),
      makeTrade({ action: 'SELL', qty: 100, fillPrice: 335, commission: 1.05, timestamp: '2026-03-15T00:00:00Z' }),
    ];
    const lots = computeTaxLots(trades);
    // Cost: 100*300 + 1.00 = 30001, Proceeds: 100*335 - 1.05 = 33498.95
    expect(lots[0].costBasis).toBeCloseTo(30001, 0);
    expect(lots[0].proceeds).toBeCloseTo(33498.95, 0);
    expect(lots[0].realisedPnl).toBeCloseTo(3497.95, 0);
  });

  it('classifies >365 day holdings as long-term', () => {
    const trades: TradeRecord[] = [
      makeTrade({ action: 'BUY', qty: 100, fillPrice: 300, timestamp: '2025-01-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', qty: 100, fillPrice: 335, timestamp: '2026-03-01T00:00:00Z' }),
    ];
    const lots = computeTaxLots(trades);
    expect(lots[0].longTerm).toBe(true);
    expect(lots[0].holdingDays).toBeGreaterThan(365);
  });

  it('only matches same symbol', () => {
    const trades: TradeRecord[] = [
      makeTrade({ action: 'BUY', symbol: 'VTI', qty: 100, fillPrice: 300, timestamp: '2026-01-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', symbol: 'BND', qty: 100, fillPrice: 75, timestamp: '2026-03-01T00:00:00Z' }),
    ];
    const lots = computeTaxLots(trades);
    expect(lots).toHaveLength(0); // no match
  });
});

describe('generateTaxSummary', () => {
  it('groups by Australian financial year', () => {
    const trades: TradeRecord[] = [
      makeTrade({ action: 'BUY', qty: 100, fillPrice: 300, timestamp: '2025-11-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', qty: 100, fillPrice: 335, timestamp: '2026-01-15T00:00:00Z' }), // FY2026
      makeTrade({ action: 'BUY', qty: 100, fillPrice: 320, timestamp: '2026-06-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', qty: 100, fillPrice: 340, timestamp: '2026-08-01T00:00:00Z' }), // FY2027
    ];
    const summaries = generateTaxSummary(trades);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].financialYear).toBe('FY2026');
    expect(summaries[1].financialYear).toBe('FY2027');
  });

  it('applies 50% CGT discount to long-term gains', () => {
    const trades: TradeRecord[] = [
      makeTrade({ action: 'BUY', qty: 100, fillPrice: 200, timestamp: '2024-01-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', qty: 100, fillPrice: 300, timestamp: '2026-02-01T00:00:00Z' }),
    ];
    const summaries = generateTaxSummary(trades);
    expect(summaries[0].longTermGain).toBeCloseTo(10000, 0);
    expect(summaries[0].taxableGain).toBeCloseTo(5000, 0); // 50% discount
  });

  it('handles mixed gains and losses with proportional offset', () => {
    const trades: TradeRecord[] = [
      // LT gain: $10K
      makeTrade({ action: 'BUY', qty: 100, fillPrice: 200, timestamp: '2024-01-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', qty: 100, fillPrice: 300, timestamp: '2026-02-01T00:00:00Z' }),
      // ST gain: $2K
      makeTrade({ action: 'BUY', symbol: 'BND', qty: 100, fillPrice: 70, timestamp: '2026-01-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', symbol: 'BND', qty: 100, fillPrice: 90, timestamp: '2026-03-01T00:00:00Z' }),
      // ST loss: -$3K
      makeTrade({ action: 'BUY', symbol: 'VXUS', qty: 100, fillPrice: 80, timestamp: '2026-02-01T00:00:00Z' }),
      makeTrade({ action: 'SELL', symbol: 'VXUS', qty: 100, fillPrice: 50, timestamp: '2026-04-01T00:00:00Z' }),
    ];
    const summaries = generateTaxSummary(trades);
    expect(summaries[0].netGain).toBeCloseTo(9000, 0);
    // Loss offset proportional: 3000/12000 = 25%
    // LT after: 10000 * 0.75 = 7500 → discounted: 3750
    // ST after: 2000 * 0.75 = 1500
    // Taxable: 1500 + 3750 = 5250
    expect(summaries[0].taxableGain).toBeCloseTo(5250, 0);
  });

  it('returns empty for no trades', () => {
    expect(generateTaxSummary([])).toEqual([]);
  });
});
