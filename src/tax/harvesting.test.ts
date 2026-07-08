import { describe, it, expect } from 'vitest';
import { isHarvestable, isWashSaleRestricted, findHarvestCandidates, createWashSaleEntry, hifoSelect, taxCostOfSale, TaxLot, WashSaleEntry } from './harvesting';

const makeLot = (overrides: Partial<TaxLot> = {}): TaxLot => ({
  id: '1', symbol: 'VTI', qty: 100, costBasis: 200, acquiredAt: '2025-01-01', currentPrice: 190,
  ...overrides,
});

describe('isHarvestable', () => {
  it('returns true for significant loss', () => {
    const lot = makeLot({ costBasis: 200, currentPrice: 180, qty: 100 }); // $2000 loss
    expect(isHarvestable(lot)).toBe(true);
  });

  it('returns false for small loss', () => {
    const lot = makeLot({ costBasis: 200, currentPrice: 199, qty: 1 }); // $1 loss
    expect(isHarvestable(lot)).toBe(false);
  });

  it('returns false for gain', () => {
    const lot = makeLot({ costBasis: 200, currentPrice: 210 });
    expect(isHarvestable(lot)).toBe(false);
  });
});

describe('isWashSaleRestricted', () => {
  it('returns true within 31-day window', () => {
    const ws: WashSaleEntry[] = [{
      symbol: 'VTI',
      soldAt: '2026-03-01',
      expiresAt: '2026-04-01',
    }];
    expect(isWashSaleRestricted('VTI', ws, new Date('2026-03-15'))).toBe(true);
  });

  it('returns false after expiry', () => {
    const ws: WashSaleEntry[] = [{
      symbol: 'VTI',
      soldAt: '2026-01-01',
      expiresAt: '2026-02-01',
    }];
    expect(isWashSaleRestricted('VTI', ws, new Date('2026-03-15'))).toBe(false);
  });

  it('returns false for different symbol', () => {
    const ws: WashSaleEntry[] = [{
      symbol: 'VXUS',
      soldAt: '2026-03-01',
      expiresAt: '2026-04-01',
    }];
    expect(isWashSaleRestricted('VTI', ws, new Date('2026-03-15'))).toBe(false);
  });
});

describe('findHarvestCandidates', () => {
  it('finds harvestable lots with replacements', () => {
    const lots = [makeLot({ costBasis: 200, currentPrice: 180, qty: 100 })]; // $2000 loss
    const candidates = findHarvestCandidates(lots, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].replacement).toBe('ITOT');
  });

  it('skips wash-sale restricted lots', () => {
    const lots = [makeLot()];
    const ws: WashSaleEntry[] = [createWashSaleEntry('VTI', new Date())];
    const candidates = findHarvestCandidates(lots, ws);
    expect(candidates).toHaveLength(0);
  });

  it('sorts by loss size descending', () => {
    const lots = [
      makeLot({ id: '1', costBasis: 200, currentPrice: 190, qty: 100 }), // $1000
      makeLot({ id: '2', costBasis: 200, currentPrice: 170, qty: 100 }), // $3000
    ];
    const candidates = findHarvestCandidates(lots, [], 100);
    expect(candidates[0].unrealizedLoss).toBeGreaterThan(candidates[1].unrealizedLoss);
  });
});

describe('createWashSaleEntry', () => {
  it('sets expiry 31 days after sale', () => {
    const entry = createWashSaleEntry('VTI', new Date('2026-03-01'));
    expect(new Date(entry.expiresAt).toISOString().slice(0, 10)).toBe('2026-04-01');
  });
});

describe('hifoSelect', () => {
  it('selects highest cost basis lots first', () => {
    const lots: TaxLot[] = [
      makeLot({ id: '1', costBasis: 100, qty: 50 }),
      makeLot({ id: '2', costBasis: 200, qty: 50 }),
      makeLot({ id: '3', costBasis: 150, qty: 50 }),
    ];
    const selected = hifoSelect(lots, 80);
    expect(selected[0].costBasis).toBe(200);
    expect(selected[1].costBasis).toBe(150);
  });

  it('respects target quantity', () => {
    const lots = [makeLot({ qty: 100 })];
    const selected = hifoSelect(lots, 50);
    expect(selected[0].qty).toBe(50);
  });
});

describe('taxCostOfSale', () => {
  it('returns 0 for lots with losses', () => {
    const lots = [makeLot({ costBasis: 200, currentPrice: 180, qty: 100 })];
    expect(taxCostOfSale(lots, 100)).toBe(0);
  });

  it('returns positive for lots with gains', () => {
    const lots = [makeLot({ costBasis: 100, currentPrice: 150, qty: 100, acquiredAt: '2024-01-01' })];
    const tax = taxCostOfSale(lots, 100, 0.37, 0.20, new Date('2026-03-01'));
    expect(tax).toBeGreaterThan(0);
    // Long-term gain: (150-100)*100 * 0.20 = $1000
    expect(tax).toBeCloseTo(1000, 0);
  });
});
