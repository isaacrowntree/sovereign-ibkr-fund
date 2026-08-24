import { describe, it, expect } from 'vitest';
import { evaluateAfterTax } from './after-tax.js';
import type { TradeRecord } from '../state/store.js';
import type { BacktestResult } from './backtest-engine.js';

const buy = (symbol: string, qty: number, price: number, ts: string): TradeRecord => ({
  timestamp: ts, symbol, action: 'BUY', qty, estimatedValue: qty * price,
  fillPrice: price, orderId: 1, status: 'filled', reason: 'test', commission: 0,
});
const sell = (symbol: string, qty: number, price: number, ts: string): TradeRecord => ({
  timestamp: ts, symbol, action: 'SELL', qty, estimatedValue: qty * price,
  fillPrice: price, orderId: 2, status: 'filled', reason: 'test', commission: 0,
});

const result = (final: number, start = 10_000): BacktestResult =>
  ({ startingCapital: start, finalPortfolioValue: final, trades: [] } as unknown as BacktestResult);

describe('evaluateAfterTax', () => {
  it('applies the 50% CGT discount only after 12 months', () => {
    // Same $1,000 gain, held 13 months vs 3 months. The discount halves the
    // taxable amount, so the long holding pays half the tax. This is the whole
    // mechanism behind a low-turnover strategy's tax advantage.
    const long = evaluateAfterTax(
      result(11_000),
      [buy('AAA', 100, 10, '2024-01-10T20:00:00Z'), sell('AAA', 100, 20, '2025-02-10T20:00:00Z')],
      0.47,
    );
    const short = evaluateAfterTax(
      result(11_000),
      [buy('BBB', 100, 10, '2024-01-10T20:00:00Z'), sell('BBB', 100, 20, '2024-04-10T20:00:00Z')],
      0.47,
    );

    expect(long.longTermGain).toBeCloseTo(1000, 2);
    expect(short.shortTermGain).toBeCloseTo(1000, 2);
    expect(long.taxableGain).toBeCloseTo(500, 2);   // discounted
    expect(short.taxableGain).toBeCloseTo(1000, 2); // full
    expect(long.taxPaid).toBeCloseTo(short.taxPaid / 2, 2);
  });

  it('offsets losses against gains before discounting', () => {
    // AU CGT nets losses first; only what survives gets the discount. Applying
    // the discount first would understate the bill.
    const r = evaluateAfterTax(
      result(10_500),
      [
        buy('AAA', 100, 10, '2024-01-10T20:00:00Z'), sell('AAA', 100, 20, '2025-02-10T20:00:00Z'), // +1000 LT
        buy('BBB', 100, 10, '2024-01-10T20:00:00Z'), sell('BBB', 100, 5, '2025-02-10T20:00:00Z'),  // -500 LT
      ],
      0.47,
    );
    expect(r.realisedNetGain).toBeCloseTo(500, 2);
    // (1000 - 500 offset) * 50% discount = 250 taxable, not 1000*0.5 - 500 = 0.
    expect(r.taxableGain).toBeCloseTo(250, 2);
  });

  it('charges no tax when nothing was sold', () => {
    const r = evaluateAfterTax(result(20_000), [buy('AAA', 100, 10, '2024-01-10T20:00:00Z')], 0.47);
    expect(r.taxPaid).toBe(0);
    expect(r.afterTaxReturnPct).toBeCloseTo(r.grossReturnPct, 6);
    // Deferral is real, but the liability is unrecorded here — which is exactly
    // why the study also reports a terminal-liquidation bookend.
  });

  it('reports drag as a share of profit, which is the comparison that matters', () => {
    const r = evaluateAfterTax(
      result(11_000),
      [buy('AAA', 100, 10, '2024-01-10T20:00:00Z'), sell('AAA', 100, 20, '2024-04-10T20:00:00Z')],
      0.47,
    );
    // 1000 taxable * 0.47 = 470 tax on 1000 of profit.
    expect(r.taxPaid).toBeCloseTo(470, 2);
    expect(r.dragPctOfProfit).toBeCloseTo(47, 1);
  });
});
