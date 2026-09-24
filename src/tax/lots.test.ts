import { describe, it, expect } from 'vitest';
import { runLotEngine, heldQuantities } from './lots.js';
import type { TradeRecord } from '../state/store.js';

// Synthetic trades only. Rates are round numbers so the AUD sums are checkable.
const t = (over: Partial<TradeRecord> & Pick<TradeRecord, 'action' | 'qty' | 'timestamp'>): TradeRecord => ({
  symbol: 'AAA', estimatedValue: 0, fillPrice: 100, orderId: 1, status: 'filled', reason: 'test',
  commission: 0, audPerUsd: 1.5, ...over,
});

describe('lot engine — ordering', () => {
  it('a sale before any purchase is UNMATCHED, never matched to the later buy', () => {
    const r = runLotEngine([
      t({ action: 'SELL', qty: 10, timestamp: '2026-01-10T15:00:00Z', fillPrice: 120 }),
      t({ action: 'BUY', qty: 10, timestamp: '2026-02-10T15:00:00Z' }),
    ]);
    expect(r.disposals).toEqual([]);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0].qty).toBe(10);
    expect(r.issues.join(' ')).toMatch(/no earlier parcel/);
    expect(heldQuantities(r).get('AAA')).toBe(10);
  });

  it('ledger order does not matter — replay is by time', () => {
    const r = runLotEngine([
      t({ action: 'SELL', qty: 5, timestamp: '2026-03-01T15:00:00Z', fillPrice: 130 }),
      t({ action: 'BUY', qty: 5, timestamp: '2026-01-02T15:00:00Z', fillPrice: 90 }),
      t({ action: 'BUY', qty: 5, timestamp: '2026-02-02T15:00:00Z', fillPrice: 110 }),
    ]);
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0].buyDate).toBe('2026-01-02');
    expect(r.disposals[0].gainUsd).toBe(5 * 40);
  });

  it('a same-instant buy is available to the sale', () => {
    const r = runLotEngine([
      t({ action: 'SELL', qty: 1, timestamp: '2026-01-02T15:00:00Z' }),
      t({ action: 'BUY', qty: 1, timestamp: '2026-01-02T15:00:00Z' }),
    ]);
    expect(r.unmatched).toEqual([]);
  });
});

describe('lot engine — partial parcels', () => {
  it('consumes oldest first across partial lots and carries the remainder', () => {
    const r = runLotEngine([
      t({ action: 'BUY', qty: 10, timestamp: '2025-01-02T15:00:00Z', fillPrice: 100 }),
      t({ action: 'BUY', qty: 10, timestamp: '2025-06-02T15:00:00Z', fillPrice: 200 }),
      t({ action: 'SELL', qty: 4, timestamp: '2025-07-01T15:00:00Z', fillPrice: 150 }),
      t({ action: 'SELL', qty: 10, timestamp: '2025-08-01T15:00:00Z', fillPrice: 150 }),
    ]);
    expect(r.disposals.map((d) => [d.qty, d.buyDate])).toEqual([
      [4, '2025-01-02'], [6, '2025-01-02'], [4, '2025-06-02'],
    ]);
    const open = r.openLots.get('AAA')!;
    expect(open).toHaveLength(1);
    expect(open[0].qty).toBe(6);
    expect(open[0].qtyBought).toBe(10);
  });
});

describe('lot engine — brokerage and AUD', () => {
  it('buy brokerage is in the cost base, sell brokerage reduces proceeds — counted once each', () => {
    const r = runLotEngine([
      t({ action: 'BUY', qty: 10, timestamp: '2025-01-02T15:00:00Z', fillPrice: 100, commission: 2, audPerUsd: 1.5 }),
      t({ action: 'SELL', qty: 5, timestamp: '2025-02-02T15:00:00Z', fillPrice: 120, commission: 1, audPerUsd: 1.6 }),
    ]);
    const d = r.disposals[0];
    expect(d.costUsd).toBeCloseTo(5 * 100 + 1, 9);        // half the buy brokerage
    expect(d.proceedsUsd).toBeCloseTo(5 * 120 - 1, 9);    // all of the sell brokerage
    // Each side at ITS OWN trade's rate.
    expect(d.costAud).toBeCloseTo((5 * 100 + 1) * 1.5, 9);
    expect(d.proceedsAud).toBeCloseTo((5 * 120 - 1) * 1.6, 9);
    expect(d.gainAud).toBeCloseTo((5 * 120 - 1) * 1.6 - (5 * 100 + 1) * 1.5, 9);
  });

  it('an AUD gain can be a USD loss (and the reverse) — FX is part of the CGT figure', () => {
    const r = runLotEngine([
      t({ action: 'BUY', qty: 1, timestamp: '2025-01-02T15:00:00Z', fillPrice: 100, audPerUsd: 1.4 }),
      t({ action: 'SELL', qty: 1, timestamp: '2025-03-02T15:00:00Z', fillPrice: 98, audPerUsd: 1.6 }),
    ]);
    expect(r.disposals[0].gainUsd).toBeLessThan(0);
    expect(r.disposals[0].gainAud).toBeGreaterThan(0);
  });

  it('uses the fallback rate when IBKR gave none, and flags it', () => {
    const r = runLotEngine(
      [
        t({ action: 'BUY', qty: 1, timestamp: '2025-01-02T15:00:00Z', audPerUsd: undefined }),
        t({ action: 'SELL', qty: 1, timestamp: '2025-03-02T15:00:00Z' }),
      ],
      { fxFallback: (d) => (d === '2025-01-02' ? 1.55 : undefined) },
    );
    expect(r.disposals[0].costAud).toBeCloseTo(155, 9);
    expect(r.disposals[0].flags).toContain('buy:fx-fallback');
  });

  it('omits AUD figures (null) rather than guessing when no rate exists', () => {
    const r = runLotEngine([
      t({ action: 'BUY', qty: 1, timestamp: '2025-01-02T15:00:00Z', audPerUsd: undefined }),
      t({ action: 'SELL', qty: 1, timestamp: '2025-03-02T15:00:00Z' }),
    ]);
    expect(r.disposals[0].gainAud).toBeNull();
    expect(r.issues.join(' ')).toMatch(/no AUD rate/);
  });

  it('flags estimated commission and inferred prices through to the disposal', () => {
    const r = runLotEngine([
      t({ action: 'BUY', qty: 1, timestamp: '2025-01-02T15:00:00Z', commission: 1, commissionEstimated: true, source: 'opening' }),
      t({ action: 'SELL', qty: 1, timestamp: '2025-03-02T15:00:00Z', priceInferred: true }),
    ]);
    expect(r.disposals[0].flags).toEqual(expect.arrayContaining(['buy:commission-estimated', 'sell:price-inferred']));
  });
});

describe('lot engine — discount and financial year per parcel', () => {
  it('splits one sale into discountable and non-discountable parcels', () => {
    const r = runLotEngine([
      t({ action: 'BUY', qty: 3, timestamp: '2024-02-29T15:00:00Z' }),
      t({ action: 'BUY', qty: 3, timestamp: '2024-06-03T15:00:00Z' }),
      t({ action: 'SELL', qty: 6, timestamp: '2025-03-03T15:00:00Z', fillPrice: 110 }),
    ]);
    expect(r.disposals.map((d) => d.discountEligible)).toEqual([true, false]);
    expect(r.disposals[0].financialYear).toBe('FY2025');
  });

  it('dates a sale by the US exchange day: 30 June in New York is FY-end, not next year', () => {
    const r = runLotEngine([
      t({ action: 'BUY', qty: 1, timestamp: '2025-01-02T15:00:00Z' }),
      t({ action: 'SELL', qty: 1, timestamp: '2025-06-30T19:00:00Z' }), // 1 July 05:00 in Sydney
    ]);
    expect(r.disposals[0].sellDate).toBe('2025-06-30');
    expect(r.disposals[0].financialYear).toBe('FY2025');
  });

  it('respects an explicit tradeDate (opening lots carry only a date)', () => {
    const r = runLotEngine([
      t({ action: 'BUY', qty: 1, timestamp: '2023-09-28T20:00:00Z', tradeDate: '2023-09-28', source: 'opening' }),
      t({ action: 'SELL', qty: 1, timestamp: '2024-09-29T15:00:00Z' }),
    ]);
    expect(r.disposals[0].discountEligible).toBe(true);
  });
});
