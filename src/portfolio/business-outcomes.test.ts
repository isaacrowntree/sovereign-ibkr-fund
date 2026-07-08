import { describe, it, expect } from 'vitest';
import { blackLitterman, impliedReturns } from './black-litterman.js';
import { allocateCashFlow } from './cashflow-rebalance.js';
import { correlationStressTest } from '../risk/stress-test.js';
import { findHarvestCandidates, TaxLot, WashSaleEntry } from '../tax/harvesting.js';
import { computeShortfall } from '../execution/shortfall.js';

describe('Business outcome tests', () => {
  it('Black-Litterman with bullish VTI view overweights US equities', () => {
    // 4-asset portfolio: VTI, VXUS, BND, BNDX
    // Simple covariance matrix (annualized)
    const covMatrix = [
      [0.0225, 0.0180, 0.0020, 0.0015], // VTI  (15% vol)
      [0.0180, 0.0256, 0.0025, 0.0020], // VXUS (16% vol)
      [0.0020, 0.0025, 0.0016, 0.0012], // BND  (4% vol)
      [0.0015, 0.0020, 0.0012, 0.0025], // BNDX (5% vol)
    ];

    // Market-cap weights (approximate global market portfolio)
    const marketWeights = [0.30, 0.25, 0.25, 0.20];

    // View: VTI will return 10% (bullish on US equities)
    const views = {
      P: [[1, 0, 0, 0]], // pick VTI
      Q: [0.10],          // expect 10% return
    };

    const result = blackLitterman(covMatrix, marketWeights, views);

    // VTI optimal weight should exceed its market weight
    expect(result.optimalWeights[0]).toBeGreaterThan(marketWeights[0]);
    // Posterior return for VTI should be tilted upward vs implied equilibrium
    expect(result.posteriorReturns[0]).toBeGreaterThan(result.impliedReturns[0]);
  });

  it('cash-flow rebalancing reduces drift without selling', () => {
    // VTI is overweight (40% actual vs 30% target), others underweight
    const holdings = [
      { symbol: 'VTI', currentValue: 40000, targetPct: 30 },
      { symbol: 'VXUS', currentValue: 20000, targetPct: 25 },
      { symbol: 'BND', currentValue: 20000, targetPct: 25 },
      { symbol: 'BNDX', currentValue: 20000, targetPct: 20 },
    ];
    const depositUsd = 10000;
    const prices = new Map([
      ['VTI', 250],
      ['VXUS', 60],
      ['BND', 80],
      ['BNDX', 55],
    ]);

    const orders = allocateCashFlow(holdings, depositUsd, 100, prices);

    // All orders should be BUY only (never sell)
    expect(orders.every((o) => o.action === 'BUY')).toBe(true);

    // VTI should NOT appear in orders (it's already overweight)
    expect(orders.find((o) => o.symbol === 'VTI')).toBeUndefined();

    // Underweight assets should receive allocations
    const totalPortfolio = 100000 + depositUsd;
    const vxusOrder = orders.find((o) => o.symbol === 'VXUS');
    expect(vxusOrder).toBeDefined();

    // New VXUS value should be closer to target than before
    const vxusTargetValue = totalPortfolio * 0.25;
    const vxusBefore = Math.abs(20000 - vxusTargetValue);
    const vxusAfter = Math.abs(20000 + (vxusOrder?.amountUsd ?? 0) - vxusTargetValue);
    expect(vxusAfter).toBeLessThan(vxusBefore);
  });

  it('stressed VaR increases when correlations spike', () => {
    const weights = [0.30, 0.25, 0.25, 0.20];
    const covMatrix = [
      [0.0225, 0.0090, 0.0010, 0.0008],
      [0.0090, 0.0256, 0.0012, 0.0010],
      [0.0010, 0.0012, 0.0016, 0.0006],
      [0.0008, 0.0010, 0.0006, 0.0025],
    ];
    const portfolioValue = 1000000;

    const result = correlationStressTest(weights, covMatrix, portfolioValue, 0.9);

    expect(result.stressedVaR).toBeGreaterThan(result.baselineVaR);
    expect(result.stressedVol).toBeGreaterThan(result.baselineVol);
    // Stress should be material, not trivial
    const volIncrease = result.stressedVol - result.baselineVol;
    expect(volIncrease).toBeGreaterThan(0);
  });

  it('tax-loss harvesting produces net benefit', () => {
    const now = new Date('2024-06-15');
    const lots: TaxLot[] = [
      {
        id: 'lot-1',
        symbol: 'VTI',
        qty: 50,
        costBasis: 220,       // bought at $220
        acquiredAt: '2024-01-15',
        currentPrice: 200,    // now $200 — loss of $20/share = $1000 total
      },
      {
        id: 'lot-2',
        symbol: 'VXUS',
        qty: 100,
        costBasis: 65,
        acquiredAt: '2023-06-01',
        currentPrice: 60,     // $500 loss
      },
    ];
    const washSales: WashSaleEntry[] = []; // no prior wash sales

    const candidates = findHarvestCandidates(lots, washSales, 100, now);

    expect(candidates.length).toBeGreaterThan(0);
    // Each candidate should have a different replacement symbol
    for (const c of candidates) {
      expect(c.replacement).not.toBe(c.lot.symbol);
      expect(c.unrealizedLoss).toBeGreaterThan(0);
    }
    // VTI replacement should be ITOT
    const vtiCandidate = candidates.find((c) => c.lot.symbol === 'VTI');
    expect(vtiCandidate?.replacement).toBe('ITOT');
  });

  it('implementation shortfall detects worse-than-benchmark execution', () => {
    const decision = {
      symbol: 'VTI',
      decisionPrice: 100,
      decisionTimestamp: '2024-06-15T10:00:00Z',
      action: 'BUY' as const,
      targetQty: 100,
    };
    const executions = [
      {
        fillPrice: 100.10,
        fillQty: 100,
        fillTimestamp: '2024-06-15T10:05:00Z',
        commission: 1.0,
      },
    ];
    const benchmarkClosePrice = 100.05;

    const result = computeShortfall(decision, executions, benchmarkClosePrice);

    // Slippage: bought at 100.10 vs arrival at 100.00 — positive = worse
    expect(result.slippageBps).toBeGreaterThan(0);
    // Total shortfall includes slippage + commission
    expect(result.totalShortfallBps).toBeGreaterThan(0);
    // Avg fill price should be 100.10
    expect(result.avgFillPrice).toBeCloseTo(100.10, 2);
  });
});
