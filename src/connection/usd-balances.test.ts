import { describe, it, expect } from 'vitest';
import { deriveUsdBalances } from './gateway.js';

// Mirrors the live CPAPI /ledger shape for the AUD-base account U1234567,
// including the BASE pseudo-currency row that aggregates every bucket.
const LEDGER = {
  AUD: { currency: 'AUD', cashbalance: 36.29, settledcash: 36.29, netliquidationvalue: 36.29, exchangerate: 1 },
  USD: { currency: 'USD', cashbalance: 0, settledcash: 0, netliquidationvalue: 29130.48, exchangerate: 1.4422051 },
  BASE: { currency: 'BASE', cashbalance: 36.29, settledcash: 36.29, netliquidationvalue: 42046.4, exchangerate: 1 },
};

describe('deriveUsdBalances', () => {
  it('excludes the BASE row so NAV is not double-counted', () => {
    const b = deriveUsdBalances(LEDGER as any);
    // base NAV = 36.29*1 + 29130.48*1.4422051 ≈ 42046; /1.4422051 ≈ 29155 USD.
    expect(b.usdNav).toBeGreaterThan(29000);
    expect(b.usdNav).toBeLessThan(29400);
    // NOT ~58k (the double-count when BASE is included).
    expect(b.usdNav).toBeLessThan(40000);
  });

  it('reports USD cashbalance (incl. unsettled), not the AUD total', () => {
    expect(deriveUsdBalances(LEDGER as any).usdCash).toBe(0);
    const withProceeds = { ...LEDGER, USD: { ...LEDGER.USD, cashbalance: 16000 } };
    expect(deriveUsdBalances(withProceeds as any).usdCash).toBe(16000);
  });

  it('falls back to the USD bucket NAV if no exchange rate is present', () => {
    const noRate = { USD: { currency: 'USD', cashbalance: 5, netliquidationvalue: 1234 } };
    expect(deriveUsdBalances(noRate as any).usdNav).toBe(1234);
  });

  it('handles an empty ledger without throwing', () => {
    const b = deriveUsdBalances({} as any);
    expect(b.usdCash).toBe(0);
    expect(b.usdNav).toBe(0);
  });
});
