import { describe, it, expect } from 'vitest';
import { computeShortfall, DecisionPoint, ExecutionRecord } from './shortfall';

describe('computeShortfall', () => {
  const baseBuyDecision: DecisionPoint = {
    symbol: 'AAPL',
    decisionPrice: 100,
    decisionTimestamp: '2024-01-01T09:30:00Z',
    action: 'BUY',
    targetQty: 100,
  };

  const baseSellDecision: DecisionPoint = {
    symbol: 'AAPL',
    decisionPrice: 100,
    decisionTimestamp: '2024-01-01T09:30:00Z',
    action: 'SELL',
    targetQty: 100,
  };

  it('BUY at $100, fill at $100.05 → slippage = 5 bps', () => {
    const executions: ExecutionRecord[] = [
      { fillPrice: 100.05, fillQty: 100, fillTimestamp: '2024-01-01T09:31:00Z', commission: 0 },
    ];
    const result = computeShortfall(baseBuyDecision, executions, 100);
    expect(result.slippageBps).toBeCloseTo(5, 1);
  });

  it('SELL at $100, fill at $99.95 → slippage = 5 bps', () => {
    const executions: ExecutionRecord[] = [
      { fillPrice: 99.95, fillQty: 100, fillTimestamp: '2024-01-01T09:31:00Z', commission: 0 },
    ];
    const result = computeShortfall(baseSellDecision, executions, 100);
    expect(result.slippageBps).toBeCloseTo(5, 1);
  });

  it('perfect fill → 0 slippage', () => {
    const executions: ExecutionRecord[] = [
      { fillPrice: 100, fillQty: 100, fillTimestamp: '2024-01-01T09:31:00Z', commission: 0 },
    ];
    const result = computeShortfall(baseBuyDecision, executions, 100);
    expect(result.slippageBps).toBe(0);
  });

  it('multiple partial fills → weighted avg price', () => {
    const executions: ExecutionRecord[] = [
      { fillPrice: 100.02, fillQty: 60, fillTimestamp: '2024-01-01T09:31:00Z', commission: 0 },
      { fillPrice: 100.08, fillQty: 40, fillTimestamp: '2024-01-01T09:32:00Z', commission: 0 },
    ];
    // Weighted avg = (100.02*60 + 100.08*40) / 100 = 100.044
    // Slippage = (100.044 - 100) / 100 * 10000 = 4.4 bps
    const result = computeShortfall(baseBuyDecision, executions, 100);
    expect(result.avgFillPrice).toBeCloseTo(100.044, 3);
    expect(result.slippageBps).toBeCloseTo(4.4, 1);
  });

  it('zero commission → 0 commission bps', () => {
    const executions: ExecutionRecord[] = [
      { fillPrice: 100.05, fillQty: 100, fillTimestamp: '2024-01-01T09:31:00Z', commission: 0 },
    ];
    const result = computeShortfall(baseBuyDecision, executions, 100);
    expect(result.commissionBps).toBe(0);
  });

  it('zero qty → throw error', () => {
    const executions: ExecutionRecord[] = [
      { fillPrice: 100.05, fillQty: 0, fillTimestamp: '2024-01-01T09:31:00Z', commission: 0 },
    ];
    expect(() => computeShortfall(baseBuyDecision, executions, 100)).toThrow(
      'Total fill quantity is zero'
    );
  });

  it('empty executions → throw error', () => {
    expect(() => computeShortfall(baseBuyDecision, [], 100)).toThrow(
      'No executions provided'
    );
  });

  it('commission is included in totalShortfallBps', () => {
    const executions: ExecutionRecord[] = [
      { fillPrice: 100, fillQty: 100, fillTimestamp: '2024-01-01T09:31:00Z', commission: 10 },
    ];
    // commission = 10 / (100 * 100) * 10000 = 10 bps
    const result = computeShortfall(baseBuyDecision, executions, 100);
    expect(result.commissionBps).toBeCloseTo(10, 1);
    expect(result.totalShortfallBps).toBeCloseTo(10, 1);
  });
});
