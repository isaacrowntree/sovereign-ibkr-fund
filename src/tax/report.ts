/**
 * Tax Report Generator for IBKR Fund
 *
 * Generates Australian CGT-compliant trade reports from trade-history.json.
 * - FIFO cost basis matching (BUY → SELL)
 * - Holding period classification (>12 months for 50% CGT discount)
 * - Per-trade and summary P&L with commission deductions
 * - Australian financial year grouping (July 1 → June 30)
 */

import type { TradeRecord } from '../state/store.js';
import { loadTradeHistory } from '../state/store.js';

export interface TaxLot {
  buyTrade: TradeRecord;
  sellTrade: TradeRecord;
  symbol: string;
  qty: number;
  costBasis: number;       // total cost including buy commission (USD)
  proceeds: number;        // total proceeds minus sell commission (USD)
  realisedPnl: number;
  holdingDays: number;
  longTerm: boolean;
  financialYear: string;
}

export interface TaxSummary {
  financialYear: string;
  totalProceeds: number;
  totalCostBasis: number;
  totalCommissions: number;
  grossGain: number;
  grossLoss: number;
  netGain: number;
  longTermGain: number;
  shortTermGain: number;
  taxableGain: number;
  lots: TaxLot[];
}

function financialYear(date: Date): string {
  const month = date.getMonth();
  const year = date.getFullYear();
  return month >= 6 ? `FY${year + 1}` : `FY${year}`;
}

function pricePerUnit(trade: TradeRecord): number {
  return trade.fillPrice ?? (trade.estimatedValue / trade.qty);
}

export function computeTaxLots(trades: TradeRecord[]): TaxLot[] {
  const buys = trades
    .filter(t => t.action === 'BUY')
    .map(t => ({ ...t, remainingQty: t.qty }));
  const sells = trades
    .filter(t => t.action === 'SELL')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const lots: TaxLot[] = [];

  for (const sell of sells) {
    let sellRemaining = sell.qty;
    const sellDate = new Date(sell.timestamp);
    const sellPrice = pricePerUnit(sell);
    const sellCommPerUnit = (sell.commission ?? 0) / sell.qty;

    for (const buy of buys) {
      if (sellRemaining <= 0) break;
      if (buy.remainingQty <= 0) continue;
      if (buy.symbol !== sell.symbol) continue;

      const matchQty = Math.min(sellRemaining, buy.remainingQty);
      const buyDate = new Date(buy.timestamp);
      const holdingMs = sellDate.getTime() - buyDate.getTime();
      const holdingDays = Math.floor(holdingMs / (24 * 60 * 60 * 1000));
      const longTerm = holdingDays > 365;

      const buyPrice = pricePerUnit(buy);
      const buyCommPerUnit = (buy.commission ?? 0) / buy.qty;
      const costBasis = matchQty * buyPrice + matchQty * buyCommPerUnit;
      const proceeds = matchQty * sellPrice - matchQty * sellCommPerUnit;

      lots.push({
        buyTrade: buy,
        sellTrade: sell,
        symbol: sell.symbol,
        qty: matchQty,
        costBasis,
        proceeds,
        realisedPnl: proceeds - costBasis,
        holdingDays,
        longTerm,
        financialYear: financialYear(sellDate),
      });

      buy.remainingQty -= matchQty;
      sellRemaining -= matchQty;
    }
  }

  return lots;
}

export function generateTaxSummary(trades?: TradeRecord[]): TaxSummary[] {
  const allTrades = trades ?? loadTradeHistory();
  const lots = computeTaxLots(allTrades);

  const byFY = new Map<string, TaxLot[]>();
  for (const lot of lots) {
    if (!byFY.has(lot.financialYear)) byFY.set(lot.financialYear, []);
    byFY.get(lot.financialYear)!.push(lot);
  }

  const summaries: TaxSummary[] = [];
  for (const [fy, fyLots] of byFY) {
    const totalProceeds = fyLots.reduce((s, l) => s + l.proceeds, 0);
    const totalCostBasis = fyLots.reduce((s, l) => s + l.costBasis, 0);
    const totalCommissions = allTrades
      .filter(t => financialYear(new Date(t.timestamp)) === fy)
      .reduce((s, t) => s + (t.commission ?? 0), 0);

    const gains = fyLots.filter(l => l.realisedPnl > 0);
    const losses = fyLots.filter(l => l.realisedPnl < 0);

    const grossGain = gains.reduce((s, l) => s + l.realisedPnl, 0);
    const grossLoss = losses.reduce((s, l) => s + l.realisedPnl, 0);
    const netGain = grossGain + grossLoss;

    const longTermGain = gains.filter(l => l.longTerm).reduce((s, l) => s + l.realisedPnl, 0);
    const shortTermGain = gains.filter(l => !l.longTerm).reduce((s, l) => s + l.realisedPnl, 0);

    // AU CGT: proportional loss offset, then 50% discount on remaining LT gains
    let taxableGain = 0;
    if (netGain > 0) {
      const lossOffset = -grossLoss;
      const totalGains = grossGain;
      const stAfterLoss = totalGains > 0 ? shortTermGain * (1 - lossOffset / totalGains) : 0;
      const ltAfterLoss = totalGains > 0 ? longTermGain * (1 - lossOffset / totalGains) : 0;
      taxableGain = Math.max(0, stAfterLoss) + Math.max(0, ltAfterLoss) * 0.5;
    }

    summaries.push({
      financialYear: fy,
      totalProceeds,
      totalCostBasis,
      totalCommissions,
      grossGain,
      grossLoss,
      netGain,
      longTermGain,
      shortTermGain,
      taxableGain,
      lots: fyLots,
    });
  }

  return summaries.sort((a, b) => a.financialYear.localeCompare(b.financialYear));
}
