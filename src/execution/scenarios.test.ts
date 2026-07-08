import { describe, it, expect } from 'vitest';
import { computeShortfall } from './shortfall.js';
import { selectExecutionStrategy, selectUrgency } from './algo-orders.js';

describe('Execution scenario tests', () => {
  it('large order uses TWAP to reduce market impact', () => {
    // 15% of portfolio is a large order — should use TWAP
    const orderValue = 150000;
    const portfolioValue = 1000000;

    const strategy = selectExecutionStrategy(orderValue, portfolioValue);
    expect(strategy).toBe('twap');
  });

  it('crisis regime uses Urgent priority', () => {
    const urgency = selectUrgency(false, false, 'crisis');
    expect(urgency).toBe('Urgent');
  });

  it('multiple partial fills compute correct weighted average', () => {
    const decision = {
      symbol: 'VTI',
      decisionPrice: 250,
      decisionTimestamp: '2024-06-15T10:00:00Z',
      action: 'BUY' as const,
      targetQty: 300,
    };

    const executions = [
      { fillPrice: 250.10, fillQty: 100, fillTimestamp: '2024-06-15T10:01:00Z', commission: 0.50 },
      { fillPrice: 250.20, fillQty: 100, fillTimestamp: '2024-06-15T10:02:00Z', commission: 0.50 },
      { fillPrice: 250.30, fillQty: 100, fillTimestamp: '2024-06-15T10:03:00Z', commission: 0.50 },
    ];

    const result = computeShortfall(decision, executions, 250.15);

    // Weighted average: (250.10*100 + 250.20*100 + 250.30*100) / 300 = 250.20
    expect(result.avgFillPrice).toBeCloseTo(250.20, 2);
  });

  it('perfect execution has zero shortfall', () => {
    const decision = {
      symbol: 'BND',
      decisionPrice: 80,
      decisionTimestamp: '2024-06-15T10:00:00Z',
      action: 'BUY' as const,
      targetQty: 50,
    };

    const executions = [
      {
        fillPrice: 80,       // fill at exactly arrival price
        fillQty: 50,
        fillTimestamp: '2024-06-15T10:00:01Z',
        commission: 0,       // zero commission
      },
    ];

    const result = computeShortfall(decision, executions, 80);

    expect(result.slippageBps).toBe(0);
    expect(result.commissionBps).toBe(0);
    expect(result.totalShortfallBps).toBe(0);
    expect(result.totalShortfallUsd).toBe(0);
  });
});
