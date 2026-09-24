import { describe, it, expect } from 'vitest';
import {
  exchangeTradeDate, tradeDateOf, addOneYear, discountEligibleFrom, isDiscountEligible,
  safeDiscountDate, financialYearOf, financialYearBounds, daysBetween,
} from './au-dates.js';

describe('exchangeTradeDate — the CGT event is the US exchange date, not Sydney', () => {
  it('a New York morning trade on 30 June stays in June though Sydney is already in July', () => {
    // 10:00 EDT on 30 June = 00:00 AEST 1 July.
    expect(exchangeTradeDate('2026-06-30T14:00:00Z')).toBe('2026-06-30');
    expect(financialYearOf(exchangeTradeDate('2026-06-30T14:00:00Z')!)).toBe('FY2026');
  });

  it('an after-midnight-UTC close is still the previous US day', () => {
    // 20:30 EST on 2 Jan = 01:30Z on 3 Jan.
    expect(exchangeTradeDate('2026-01-03T01:30:00Z')).toBe('2026-01-02');
  });

  it('takes bare and compact dates as already being trade dates', () => {
    expect(exchangeTradeDate('2023-09-28')).toBe('2023-09-28');
    expect(exchangeTradeDate('20230928')).toBe('2023-09-28');
    expect(exchangeTradeDate('garbage')).toBeUndefined();
    expect(tradeDateOf({ tradeDate: '2024-02-29', timestamp: '2024-03-01T15:00:00Z' })).toBe('2024-02-29');
  });
});

describe('the 12-month discount test (buy date + 1 year + 1 day)', () => {
  it('ordinary dates', () => {
    expect(discountEligibleFrom('2024-03-15')).toBe('2025-03-16');
    expect(isDiscountEligible('2024-03-15', '2025-03-15')).toBe(false);
    expect(isDiscountEligible('2024-03-15', '2025-03-16')).toBe(true);
  });

  it('bought on 29 February: +1 year clamps to 28 Feb, discountable from 1 March', () => {
    expect(addOneYear('2024-02-29')).toBe('2025-02-28');
    expect(isDiscountEligible('2024-02-29', '2025-02-28')).toBe(false);
    expect(isDiscountEligible('2024-02-29', '2025-03-01')).toBe(true);
  });

  it('bought 28 Feb before a leap year: discountable ON 29 February', () => {
    expect(discountEligibleFrom('2023-02-28')).toBe('2024-02-29');
    expect(isDiscountEligible('2023-02-28', '2024-02-28')).toBe(false);
    expect(isDiscountEligible('2023-02-28', '2024-02-29')).toBe(true);
  });

  it('bought 1 March before a leap year: the leap day does not bring it forward', () => {
    // 366 calendar days later is 2024-03-01 — the old "> 365 days" test said yes.
    expect(daysBetween('2023-03-01', '2024-03-01')).toBe(366);
    expect(isDiscountEligible('2023-03-01', '2024-03-01')).toBe(false);
    expect(isDiscountEligible('2023-03-01', '2024-03-02')).toBe(true);
  });

  it('year end: bought 31 Dec, discountable from 1 Jan two years on', () => {
    expect(discountEligibleFrom('2024-12-31')).toBe('2026-01-01');
  });

  it('waiting logic keeps a 2-day margin by default', () => {
    expect(safeDiscountDate('2024-03-15')).toBe('2025-03-18');
    expect(safeDiscountDate('2024-03-15', 0)).toBe('2025-03-16');
  });
});

describe('financial years', () => {
  it('label by the year they end', () => {
    expect(financialYearOf('2025-07-01')).toBe('FY2026');
    expect(financialYearOf('2026-06-30')).toBe('FY2026');
    expect(financialYearOf('2026-07-01')).toBe('FY2027');
    expect(financialYearBounds('FY2026')).toEqual({ start: '2025-07-01', end: '2026-06-30' });
  });
});
