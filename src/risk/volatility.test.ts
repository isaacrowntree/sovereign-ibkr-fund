import { describe, it, expect } from 'vitest';
import { ewmaVolatility, realizedVolatility, annualizeVol, volTargetLeverage, kellyFraction } from './volatility';

describe('ewmaVolatility', () => {
  it('computes exact EWMA volatility step by step', () => {
    // Hand-compute EWMA with lambda=0.94 for [0.01, -0.02, 0.015, -0.005, 0.01, -0.01, 0.02, -0.015]
    // Step 0: var = 0.01^2 = 0.0001
    // Step 1: var = 0.94*0.0001 + 0.06*0.0004 = 0.000118
    // Step 2: var = 0.94*0.000118 + 0.06*0.000225 = 0.00012442
    // Step 3: var = 0.94*0.00012442 + 0.06*0.000025 = 0.0001184548
    // Step 4: var = 0.94*0.0001184548 + 0.06*0.0001 = 0.00011734751
    // Step 5: var = 0.94*0.00011734751 + 0.06*0.0001 = 0.00011630666
    // Step 6: var = 0.94*0.00011630666 + 0.06*0.0004 = 0.00013332826
    // Step 7: var = 0.94*0.00013332826 + 0.06*0.000225 = 0.00013882857
    // vol = sqrt(0.00013882857) = 0.01178255...
    const returns = [0.01, -0.02, 0.015, -0.005, 0.01, -0.01, 0.02, -0.015];
    const vol = ewmaVolatility(returns);
    expect(vol).toBeCloseTo(0.011783, 4);
  });

  it('returns 0 for insufficient data', () => {
    expect(ewmaVolatility([0.01])).toBe(0);
    expect(ewmaVolatility([])).toBe(0);
  });

  it('higher lambda gives more weight to older observations', () => {
    const returns = [0.01, 0.01, 0.01, 0.01, 0.05]; // spike at end
    const highLambda = ewmaVolatility(returns, 0.97);
    const lowLambda = ewmaVolatility(returns, 0.80);
    expect(lowLambda).toBeGreaterThan(highLambda); // low lambda reacts faster
  });
});

describe('realizedVolatility', () => {
  it('computes standard deviation of returns', () => {
    const returns = [0.01, -0.01, 0.01, -0.01]; // symmetric, mean=0
    const vol = realizedVolatility(returns);
    expect(vol).toBeCloseTo(0.01155, 3); // sqrt(0.01^2 * 4/3)
  });

  it('returns 0 for constant returns', () => {
    expect(realizedVolatility([0.01, 0.01, 0.01])).toBeCloseTo(0, 10);
  });
});

describe('annualizeVol', () => {
  it('scales daily vol by sqrt(252)', () => {
    const daily = 0.01;
    const annual = annualizeVol(daily);
    expect(annual).toBeCloseTo(0.01 * Math.sqrt(252), 6);
  });
});

describe('volTargetLeverage', () => {
  it('returns 1.0 when vol equals target', () => {
    expect(volTargetLeverage(0.15, 0.15)).toBeCloseTo(1.0, 6);
  });

  it('reduces leverage when vol is high', () => {
    expect(volTargetLeverage(0.30, 0.15)).toBeCloseTo(0.5, 6);
  });

  it('caps leverage at maxLeverage', () => {
    expect(volTargetLeverage(0.05, 0.15, 1.5)).toBe(1.5);
  });

  it('floors leverage at minLeverage', () => {
    expect(volTargetLeverage(100, 0.15, 1.5, 0.1)).toBe(0.1);
  });

  it('returns minLeverage when realizedVol is 0', () => {
    // Tests the <= 0 branch
    expect(volTargetLeverage(0, 0.15)).toBe(0.1);
  });

  it('returns minLeverage when realizedVol is negative', () => {
    expect(volTargetLeverage(-0.1, 0.15)).toBe(0.1);
  });
});

describe('kellyFraction', () => {
  it('computes exact Kelly fraction for winRate=0.6, avgWin=1.5, avgLoss=1.0', () => {
    // b = avgWin/avgLoss = 1.5/1.0 = 1.5
    // f = (b*winRate - (1-winRate)) / b = (1.5*0.6 - 0.4) / 1.5 = 0.5/1.5 = 1/3
    const full = kellyFraction(0.6, 1.5, 1.0, 1.0);
    expect(full).toBeCloseTo(1 / 3, 6);

    // Quarter Kelly = (1/3) * 0.25 = 1/12 = 0.08333...
    const quarter = kellyFraction(0.6, 1.5, 1.0, 0.25);
    expect(quarter).toBeCloseTo(1 / 12, 6);
  });

  it('returns 0 for no edge', () => {
    const f = kellyFraction(0.5, 1.0, 1.0, 1.0);
    expect(f).toBe(0);
  });

  it('quarter Kelly is 1/4 of full Kelly', () => {
    const full = kellyFraction(0.6, 1.5, 1.0, 1.0);
    const quarter = kellyFraction(0.6, 1.5, 1.0, 0.25);
    expect(quarter).toBeCloseTo(full * 0.25, 6);
  });

  it('returns 0 for losing edge', () => {
    const f = kellyFraction(0.3, 1.0, 1.0, 1.0);
    expect(f).toBe(0);
  });

  it('returns 0 when avgLoss is 0', () => {
    expect(kellyFraction(0.6, 1.5, 0, 1.0)).toBe(0);
  });
});
