import { describe, it, expect } from 'vitest';
import { coveredCallContracts, estimateStrikeFromDelta, generateCoveredCall, generateProtectivePut, generateCollar, tailRiskPutBudget } from './options';

describe('coveredCallContracts', () => {
  it('calculates correct number of contracts', () => {
    const contracts = coveredCallContracts({
      symbol: 'VTI', sharesHeld: 500, currentPrice: 250,
      targetDelta: 0.25, minDTE: 30, maxDTE: 45, coveragePct: 0.5,
    });
    // 500 * 0.5 = 250 shares / 100 = 2 contracts
    expect(contracts).toBe(2);
  });

  it('returns 0 for less than 100 shares', () => {
    const contracts = coveredCallContracts({
      symbol: 'VTI', sharesHeld: 80, currentPrice: 250,
      targetDelta: 0.25, minDTE: 30, maxDTE: 45, coveragePct: 1.0,
    });
    expect(contracts).toBe(0);
  });
});

describe('estimateStrikeFromDelta', () => {
  it('returns strike above current price for OTM call', () => {
    const strike = estimateStrikeFromDelta(250, 0.25, 0.20, 30);
    expect(strike).toBeGreaterThan(250);
  });

  it('higher vol gives higher strike for same delta', () => {
    const lowVol = estimateStrikeFromDelta(250, 0.25, 0.15, 30);
    const highVol = estimateStrikeFromDelta(250, 0.25, 0.30, 30);
    expect(highVol).toBeGreaterThan(lowVol);
  });

  it('returns currentPrice for delta=0.5 (ATM)', () => {
    // At delta=0.5, otmAmount=0, so strike = currentPrice
    const strike = estimateStrikeFromDelta(250, 0.5, 0.20, 30);
    expect(strike).toBe(250);
  });

  it('returns strike BELOW current price for puts (delta > 0.5)', () => {
    // Put with targetDelta=0.75 (passed as 1 + putDelta where putDelta=-0.25)
    const strike = estimateStrikeFromDelta(250, 0.75, 0.20, 30);
    expect(strike).toBeLessThan(250);
  });

  it('put strike moves further OTM with higher delta', () => {
    // delta=0.9 is deeper OTM put than delta=0.6
    const nearOtm = estimateStrikeFromDelta(250, 0.6, 0.20, 30);
    const deepOtm = estimateStrikeFromDelta(250, 0.9, 0.20, 30);
    expect(deepOtm).toBeLessThan(nearOtm);
  });
});

describe('generateCoveredCall', () => {
  it('generates sell call order', () => {
    const leg = generateCoveredCall({
      symbol: 'VTI', sharesHeld: 200, currentPrice: 250,
      targetDelta: 0.25, minDTE: 30, maxDTE: 45, coveragePct: 0.5,
    }, 0.20);
    expect(leg).not.toBeNull();
    expect(leg!.type).toBe('call');
    expect(leg!.action).toBe('sell');
    expect(leg!.qty).toBe(1);
    expect(leg!.strike).toBeGreaterThan(250);
  });

  it('returns null for insufficient shares', () => {
    const leg = generateCoveredCall({
      symbol: 'VTI', sharesHeld: 50, currentPrice: 250,
      targetDelta: 0.25, minDTE: 30, maxDTE: 45, coveragePct: 1.0,
    }, 0.20);
    expect(leg).toBeNull();
  });
});

describe('generateProtectivePut', () => {
  it('generates buy put order', () => {
    const leg = generateProtectivePut({
      symbol: 'VTI', sharesHeld: 200, currentPrice: 250,
      targetDelta: -0.25, maxCostPct: 0.02, minDTE: 30, maxDTE: 45,
    }, 0.20);
    expect(leg).not.toBeNull();
    expect(leg!.type).toBe('put');
    expect(leg!.action).toBe('buy');
    expect(leg!.qty).toBe(2); // 200 shares / 100 = 2 contracts
    expect(leg!.strike).toBeLessThanOrEqual(250 * 0.97); // capped at 97% of price
  });

  it('returns null for less than 100 shares', () => {
    const leg = generateProtectivePut({
      symbol: 'VTI', sharesHeld: 50, currentPrice: 250,
      targetDelta: -0.25, maxCostPct: 0.02, minDTE: 30, maxDTE: 45,
    }, 0.20);
    expect(leg).toBeNull();
  });
});

describe('generateCollar', () => {
  it('generates two legs: buy put + sell call', () => {
    const legs = generateCollar({
      symbol: 'VTI', sharesHeld: 200, currentPrice: 250,
      putDelta: -0.25, callDelta: 0.25, minDTE: 30, maxDTE: 45,
    }, 0.20);
    expect(legs).toHaveLength(2);
    expect(legs[0].type).toBe('put');
    expect(legs[0].action).toBe('buy');
    expect(legs[1].type).toBe('call');
    expect(legs[1].action).toBe('sell');
  });

  it('returns empty array for less than 100 shares', () => {
    const legs = generateCollar({
      symbol: 'VTI', sharesHeld: 50, currentPrice: 250,
      putDelta: -0.25, callDelta: 0.25, minDTE: 30, maxDTE: 45,
    }, 0.20);
    expect(legs).toEqual([]);
  });
});

describe('tailRiskPutBudget', () => {
  it('returns 1% of portfolio by default', () => {
    expect(tailRiskPutBudget(1000000)).toBe(10000);
  });

  it('respects custom budget percentage', () => {
    expect(tailRiskPutBudget(1000000, 0.005)).toBe(5000);
  });
});
