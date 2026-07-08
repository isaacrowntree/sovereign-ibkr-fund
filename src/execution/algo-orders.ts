/**
 * IBKR execution algorithms: Adaptive, TWAP, VWAP, bracket orders
 */

import { Contract, Order, OrderAction, OrderType, SecType } from '@stoqey/ib';

export type AlgoPriority = 'Patient' | 'Normal' | 'Urgent';

export interface ExecutionPlan {
  symbol: string;
  action: 'BUY' | 'SELL';
  totalQty: number;
  strategy: 'adaptive' | 'twap' | 'vwap' | 'market' | 'limit';
  urgency: AlgoPriority;
  slices?: number;
  limitPrice?: number;
}

/** Build an IBKR Adaptive algo order */
export function adaptiveOrder(
  symbol: string,
  action: 'BUY' | 'SELL',
  qty: number,
  priority: AlgoPriority = 'Normal'
): { contract: Contract; order: Partial<Order> } {
  return {
    contract: stockContract(symbol),
    order: {
      action: action === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
      orderType: OrderType.MKT,
      totalQuantity: qty,
      algoStrategy: 'Adaptive',
      algoParams: [{ tag: 'adaptivePriority', value: priority }],
      transmit: true,
    },
  };
}

/** Build a TWAP order (Time-Weighted Average Price) */
export function twapOrder(
  symbol: string,
  action: 'BUY' | 'SELL',
  qty: number,
  durationMinutes: number = 60
): { contract: Contract; order: Partial<Order> } {
  const now = new Date();
  const end = new Date(now.getTime() + durationMinutes * 60_000);

  return {
    contract: stockContract(symbol),
    order: {
      action: action === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
      orderType: OrderType.MKT,
      totalQuantity: qty,
      algoStrategy: 'Twap',
      algoParams: [
        { tag: 'startTime', value: formatIBTime(now) },
        { tag: 'endTime', value: formatIBTime(end) },
        { tag: 'allowPastEndTime', value: '1' },
      ],
      transmit: true,
    },
  };
}

/** Build a bracket order: entry + take profit + stop loss */
export function bracketOrder(
  symbol: string,
  action: 'BUY' | 'SELL',
  qty: number,
  entryPrice: number,
  takeProfitPrice: number,
  stopLossPrice: number,
  parentOrderId: number
): { contract: Contract; orders: Partial<Order>[] } {
  const parentAction = action === 'BUY' ? OrderAction.BUY : OrderAction.SELL;
  const childAction = action === 'BUY' ? OrderAction.SELL : OrderAction.BUY;

  const parent: Partial<Order> = {
    orderId: parentOrderId,
    action: parentAction,
    orderType: OrderType.LMT,
    totalQuantity: qty,
    lmtPrice: entryPrice,
    transmit: false,
  };

  const takeProfit: Partial<Order> = {
    orderId: parentOrderId + 1,
    action: childAction,
    orderType: OrderType.LMT,
    totalQuantity: qty,
    lmtPrice: takeProfitPrice,
    parentId: parentOrderId,
    transmit: false,
  };

  const stopLoss: Partial<Order> = {
    orderId: parentOrderId + 2,
    action: childAction,
    orderType: OrderType.STP,
    totalQuantity: qty,
    auxPrice: stopLossPrice,
    parentId: parentOrderId,
    transmit: true, // transmit last to send all together
  };

  return {
    contract: stockContract(symbol),
    orders: [parent, takeProfit, stopLoss],
  };
}

/** Determine best execution strategy based on order size and urgency */
export function selectExecutionStrategy(
  orderValueUsd: number,
  portfolioValueUsd: number,
  isHedge: boolean = false
): ExecutionPlan['strategy'] {
  const pctOfPortfolio = (orderValueUsd / portfolioValueUsd) * 100;

  if (isHedge) return 'adaptive'; // hedges use adaptive with Urgent priority
  if (pctOfPortfolio > 10) return 'twap';  // large orders use TWAP
  if (pctOfPortfolio > 2) return 'adaptive'; // medium orders use adaptive
  return 'market'; // small orders just use market
}

/** Select urgency based on context */
export function selectUrgency(
  isHedge: boolean,
  isRebalance: boolean,
  regime: string
): AlgoPriority {
  if (isHedge || regime === 'crisis') return 'Urgent';
  if (isRebalance) return 'Patient';
  return 'Normal';
}

function stockContract(symbol: string): Contract {
  return { symbol, secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
}

function formatIBTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
