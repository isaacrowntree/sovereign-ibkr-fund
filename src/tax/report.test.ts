import { describe, it, expect } from 'vitest';
import { buildAuTaxReport, generateTaxSummary, renderAuTaxReport, INDICATIVE_LABEL } from './report';
import { dividendsFromPa } from './dividends';
import type { TradeRecord } from '../state/store';
import type { FxConversion } from '../connection/ibkr-history';

// Synthetic figures throughout.
function makeTrade(overrides: Partial<TradeRecord>): TradeRecord {
  return {
    timestamp: '2026-01-15T15:00:00.000Z',
    symbol: 'VTI',
    action: 'BUY',
    qty: 100,
    estimatedValue: 0,
    fillPrice: 335,
    orderId: 1,
    status: 'Filled',
    reason: 'test',
    commission: 0,
    ...overrides,
  };
}

describe('generateTaxSummary (currency-neutral, for backtests)', () => {
  it('groups by Australian financial year of the US trade date', () => {
    const summaries = generateTaxSummary([
      makeTrade({ action: 'BUY', fillPrice: 300, timestamp: '2025-11-03T15:00:00Z' }),
      makeTrade({ action: 'SELL', fillPrice: 335, timestamp: '2026-01-15T15:00:00Z' }), // FY2026
      makeTrade({ action: 'BUY', fillPrice: 320, timestamp: '2026-06-01T15:00:00Z' }),
      makeTrade({ action: 'SELL', fillPrice: 340, timestamp: '2026-08-03T15:00:00Z' }), // FY2027
    ]);
    expect(summaries.map((s) => s.financialYear)).toEqual(['FY2026', 'FY2027']);
  });

  it('applies the 50% discount to discount-eligible gains', () => {
    const [s] = generateTaxSummary([
      makeTrade({ action: 'BUY', fillPrice: 200, timestamp: '2024-01-02T15:00:00Z' }),
      makeTrade({ action: 'SELL', fillPrice: 300, timestamp: '2026-02-02T15:00:00Z' }),
    ]);
    expect(s.longTermGain).toBeCloseTo(10000, 2);
    expect(s.taxableGain).toBeCloseTo(5000, 2);
  });

  it('applies losses to NON-discount gains first (s102-5), not proportionally', () => {
    const [s] = generateTaxSummary([
      // Discount gain 10,000
      makeTrade({ action: 'BUY', fillPrice: 200, timestamp: '2024-01-02T15:00:00Z' }),
      makeTrade({ action: 'SELL', fillPrice: 300, timestamp: '2026-02-02T15:00:00Z' }),
      // Non-discount gain 2,000
      makeTrade({ action: 'BUY', symbol: 'BND', fillPrice: 70, timestamp: '2026-01-02T15:00:00Z' }),
      makeTrade({ action: 'SELL', symbol: 'BND', fillPrice: 90, timestamp: '2026-03-02T15:00:00Z' }),
      // Loss 3,000
      makeTrade({ action: 'BUY', symbol: 'VXUS', fillPrice: 80, timestamp: '2026-02-02T15:00:00Z' }),
      makeTrade({ action: 'SELL', symbol: 'VXUS', fillPrice: 50, timestamp: '2026-04-01T15:00:00Z' }),
    ]);
    expect(s.netGain).toBeCloseTo(9000, 2);
    // 3,000 loss wipes the 2,000 non-discount gain, 1,000 of the discount gain;
    // 9,000 discount gain left → 4,500 after the discount. (Proportional gave 5,250.)
    expect(s.taxableGain).toBeCloseTo(4500, 2);
  });

  it('counts brokerage once — inside cost base and proceeds', () => {
    const [s] = generateTaxSummary([
      makeTrade({ action: 'BUY', fillPrice: 300, commission: 1, timestamp: '2026-01-15T15:00:00Z' }),
      makeTrade({ action: 'SELL', fillPrice: 335, commission: 1.05, timestamp: '2026-03-16T15:00:00Z' }),
    ]);
    expect(s.totalCostBasis).toBeCloseTo(30001, 2);
    expect(s.totalProceeds).toBeCloseTo(33498.95, 2);
    expect(s.netGain).toBeCloseTo(3497.95, 2);
    expect(s.totalCommissions).toBeCloseTo(2.05, 2);
  });

  it('returns empty for no trades', () => {
    expect(generateTaxSummary([])).toEqual([]);
  });
});

describe('buildAuTaxReport', () => {
  const trades: TradeRecord[] = [
    makeTrade({ symbol: 'AAA', action: 'BUY', qty: 10, fillPrice: 100, commission: 1, audPerUsd: 1.5, timestamp: '2024-03-01T15:00:00Z' }),
    makeTrade({ symbol: 'AAA', action: 'SELL', qty: 10, fillPrice: 150, commission: 1, audPerUsd: 1.4, timestamp: '2025-09-02T15:00:00Z' }),
    makeTrade({ symbol: 'BBB', action: 'BUY', qty: 10, fillPrice: 50, audPerUsd: 1.5, timestamp: '2025-08-01T15:00:00Z' }),
    makeTrade({ symbol: 'BBB', action: 'SELL', qty: 10, fillPrice: 40, audPerUsd: 1.5, timestamp: '2025-10-01T15:00:00Z' }),
  ];

  it('reports discount gains, non-discount gains and losses separately, in AUD', () => {
    const r = buildAuTaxReport({ trades, financialYear: 'FY2026' });
    expect(r.disposals).toHaveLength(2);
    // AAA: proceeds (1500-1)*1.4 = 2098.6 ; cost (1000+1)*1.5 = 1501.5 ; gain 597.1, discountable
    expect(r.totals.discountGains).toBeCloseTo(597.1, 2);
    expect(r.totals.nonDiscountGains).toBe(0);
    // BBB: 10*(40-50)*1.5 = -150
    expect(r.totals.capitalLosses).toBeCloseTo(150, 2);
    expect(r.complete).toBe(true);
  });

  it('applies manual carried-forward losses per owner and labels the net figure indicative', () => {
    const r = buildAuTaxReport({ trades, financialYear: 'FY2026', carriedForwardLossesAud: { 'Beneficial owner': 100 } });
    const o = r.owners[0];
    // (597.1 - 150 - 100) = 347.1 discount gain left → 173.55 after discount
    expect(o.net.netCapitalGain).toBeCloseTo(173.55, 2);
    expect(renderAuTaxReport(r)).toContain(INDICATIVE_LABEL);
  });

  it('splits by beneficial owner and says so for a joint-named account', () => {
    const r = buildAuTaxReport({
      trades, financialYear: 'FY2026', registration: 'joint',
      owners: [{ name: 'Owner A', share: 1 }],
    });
    expect(r.ownership).toMatch(/joint names but held beneficially by one owner, Owner A \(100%\)/);
    const split = buildAuTaxReport({
      trades, financialYear: 'FY2026',
      owners: [{ name: 'Owner A', share: 0.6 }, { name: 'Owner B', share: 0.4 }],
    });
    expect(split.owners.map((o) => o.cgt.capitalLosses)).toEqual([90, 60]);
  });

  it('marks the report incomplete when a trade has no AUD rate', () => {
    const r = buildAuTaxReport({
      trades: [...trades.slice(0, 1), { ...trades[1], audPerUsd: undefined }],
      financialYear: 'FY2026',
    });
    expect(r.complete).toBe(false);
    expect(r.issues[0]).toMatch(/INCOMPLETE/);
  });

  it('reports dividends with withholding and the FITO figure', () => {
    const dividends = dividendsFromPa([
      { conid: 1, date: '2025-09-10', currency: 'USD', audPerUnit: 1.5, amountAud: 15, amount: 10, description: 'x' },
      { conid: 1, date: '2026-07-10', currency: 'USD', audPerUnit: 1.5, amountAud: 15, amount: 10, description: 'next FY' },
    ]);
    const r = buildAuTaxReport({ trades, financialYear: 'FY2026', dividends });
    expect(r.dividends).toHaveLength(1);
    expect(r.owners[0].dividends).toEqual({ grossAud: 15, withholdingAud: 2.25, netAud: 12.75, foreignIncomeTaxOffsetAud: 2.25 });
    expect(r.issues.join(' ')).toMatch(/withholding .* ESTIMATED/);
  });

  it('exports Division 775 records — conversions and the AUD value of USD spends — without a computed figure', () => {
    const conv: FxConversion = {
      execId: 'FX1', time: '2025-08-01T01:00:00.000Z', tradeDate: '2025-07-31', pair: 'AUD.USD', side: 'SELL',
      baseCurrency: 'AUD', quoteCurrency: 'USD', baseAmount: 1500, price: 0.66, quoteAmount: 990,
    };
    const r = buildAuTaxReport({ trades, financialYear: 'FY2026', fxConversions: [conv] });
    expect(r.div775.conversions).toEqual([conv]);
    expect(r.div775.usdSpends).toEqual([{ date: '2025-08-01', symbol: 'BBB', usd: 500, audPerUsd: 1.5, aud: 750 }]);
    expect(r.div775).not.toHaveProperty('gain');
  });
});
