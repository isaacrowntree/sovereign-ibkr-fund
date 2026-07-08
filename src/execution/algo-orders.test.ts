import { describe, it, expect } from 'vitest';
import { selectExecutionStrategy, selectUrgency, adaptiveOrder, twapOrder, bracketOrder } from './algo-orders';

describe('selectExecutionStrategy', () => {
  it('uses market for small orders (<2%)', () => {
    expect(selectExecutionStrategy(1000, 100000)).toBe('market');
  });

  it('uses adaptive for medium orders (2%-10%)', () => {
    expect(selectExecutionStrategy(5000, 100000)).toBe('adaptive');
  });

  it('uses twap for large orders (>10%)', () => {
    expect(selectExecutionStrategy(15000, 100000)).toBe('twap');
  });

  it('uses adaptive for hedges regardless of size', () => {
    expect(selectExecutionStrategy(500, 100000, true)).toBe('adaptive');
  });

  it('uses adaptive at exactly 2% boundary', () => {
    // 2000/100000 = 2%, which is NOT > 2, so should be market
    // Actually: pctOfPortfolio = 2.0, condition is > 2, so 2.0 is NOT > 2
    expect(selectExecutionStrategy(2000, 100000)).toBe('market');
  });

  it('uses adaptive just above 2% boundary', () => {
    expect(selectExecutionStrategy(2001, 100000)).toBe('adaptive');
  });

  it('uses twap at exactly 10% boundary', () => {
    // 10000/100000 = 10%, condition is > 10, so 10.0 is NOT > 10
    expect(selectExecutionStrategy(10000, 100000)).toBe('adaptive');
  });

  it('uses twap just above 10% boundary', () => {
    expect(selectExecutionStrategy(10001, 100000)).toBe('twap');
  });
});

describe('selectUrgency', () => {
  it('returns Urgent for hedges', () => {
    expect(selectUrgency(true, false, 'neutral')).toBe('Urgent');
  });

  it('returns Urgent in crisis', () => {
    expect(selectUrgency(false, false, 'crisis')).toBe('Urgent');
  });

  it('returns Patient for rebalances', () => {
    expect(selectUrgency(false, true, 'neutral')).toBe('Patient');
  });

  it('returns Normal otherwise', () => {
    expect(selectUrgency(false, false, 'neutral')).toBe('Normal');
  });
});

describe('adaptiveOrder', () => {
  it('builds correct order structure', () => {
    const { contract, order } = adaptiveOrder('VTI', 'BUY', 100, 'Patient');
    expect(contract.symbol).toBe('VTI');
    expect(order.algoStrategy).toBe('Adaptive');
    expect(order.totalQuantity).toBe(100);
    expect(order.transmit).toBe(true);
  });

  it('sets algoParams with correct priority', () => {
    const { order } = adaptiveOrder('VTI', 'BUY', 100, 'Patient');
    expect(order.algoParams).toEqual([{ tag: 'adaptivePriority', value: 'Patient' }]);
  });

  it('uses Urgent priority', () => {
    const { order } = adaptiveOrder('SPY', 'SELL', 50, 'Urgent');
    expect(order.algoParams).toEqual([{ tag: 'adaptivePriority', value: 'Urgent' }]);
    expect(order.action).toBe('SELL');
  });
});

describe('twapOrder', () => {
  it('builds TWAP order with correct strategy', () => {
    const { contract, order } = twapOrder('VTI', 'BUY', 50, 30);
    expect(contract.symbol).toBe('VTI');
    expect(order.algoStrategy).toBe('Twap');
    expect(order.totalQuantity).toBe(50);
    expect(order.transmit).toBe(true);
  });

  it('includes startTime, endTime, and allowPastEndTime params', () => {
    const { order } = twapOrder('VTI', 'BUY', 50, 60);
    const tags = order.algoParams?.map(p => p.tag);
    expect(tags).toEqual(['startTime', 'endTime', 'allowPastEndTime']);
    expect(order.algoParams?.[2].value).toBe('1');
  });

  it('handles SELL action', () => {
    const { order } = twapOrder('SPY', 'SELL', 100, 120);
    expect(order.action).toBe('SELL');
    expect(order.totalQuantity).toBe(100);
  });
});

describe('bracketOrder', () => {
  it('creates 3 linked orders for BUY', () => {
    const { contract, orders } = bracketOrder('VTI', 'BUY', 100, 250, 275, 240, 1);
    expect(contract.symbol).toBe('VTI');
    expect(orders).toHaveLength(3);
    // Parent
    expect(orders[0].orderId).toBe(1);
    expect(orders[0].action).toBe('BUY');
    expect(orders[0].transmit).toBe(false);
    // Take profit (child sells)
    expect(orders[1].parentId).toBe(1);
    expect(orders[1].action).toBe('SELL');
    expect(orders[1].lmtPrice).toBe(275);
    // Stop loss (child sells)
    expect(orders[2].parentId).toBe(1);
    expect(orders[2].action).toBe('SELL');
    expect(orders[2].auxPrice).toBe(240);
    expect(orders[2].transmit).toBe(true); // last one transmits all
  });

  it('creates bracket order with SELL action (short entry)', () => {
    const { orders } = bracketOrder('VTI', 'SELL', 50, 250, 225, 260, 10);
    // Parent sells
    expect(orders[0].action).toBe('SELL');
    expect(orders[0].orderId).toBe(10);
    expect(orders[0].lmtPrice).toBe(250);
    // Take profit buys to cover
    expect(orders[1].action).toBe('BUY');
    expect(orders[1].lmtPrice).toBe(225);
    expect(orders[1].parentId).toBe(10);
    // Stop loss buys to cover
    expect(orders[2].action).toBe('BUY');
    expect(orders[2].auxPrice).toBe(260);
    expect(orders[2].parentId).toBe(10);
    expect(orders[2].transmit).toBe(true);
  });
});
