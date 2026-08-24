/**
 * After-tax evaluation of a backtest.
 *
 * WHY THIS EXISTS. Every optimizer comparison in this repo reports pre-tax
 * returns and models only a flat commission. On a taxable book that hides the
 * dominant cost of the highest-turnover strategy: at the live 5% drift setting
 * HRP does ~101 trades over the sample against ~16 for buy-and-hold, and the
 * column that makes HRP look best is precisely the one that ignores what those
 * trades cost. Comparing strategies on pre-tax return is comparing them on the
 * wrong number.
 *
 * It deliberately reuses `generateTaxSummary` — the SAME code path that produces
 * the live CGT report — rather than reimplementing the rules. AU CGT is not a
 * flat percentage: losses offset gains proportionally, and only the remaining
 * long-term portion gets the 50% discount. A second implementation would drift
 * from the real one, and the whole point is to predict the actual tax bill.
 *
 * ASSUMPTIONS, all of which change the answer:
 *   - Australian resident CGT (this is what src/tax already implements: 12-month
 *     discount, July-June financial years).
 *   - A single flat marginal rate applied to the taxable gain. Real marginal
 *     rates are bracketed and depend on income outside this account.
 *   - Tax is accrued when the gain is REALISED, not when it is paid. Money owed
 *     in July on a gain realised in September is treated as gone in September.
 *     This understates the strategy's true return slightly, equally for all.
 *   - Unrealised gains at the end are NOT taxed: the comparison is of tax
 *     ACTUALLY TRIGGERED by trading. A low-turnover strategy therefore ends
 *     holding a larger deferred liability, which is a real advantage but a
 *     smaller one than it looks here.
 */
import type { BacktestResult } from './backtest-engine.js';
import type { TradeRecord } from '../state/store.js';
import { generateTaxSummary } from '../tax/report.js';

export interface AfterTaxResult {
  grossReturnPct: number;
  taxPaid: number;
  afterTaxValue: number;
  afterTaxReturnPct: number;
  taxableGain: number;
  shortTermGain: number;
  longTermGain: number;
  realisedNetGain: number;
  trades: number;
  /** Tax as a percentage of the gross profit — the drag this exists to expose. */
  dragPctOfProfit: number;
}

/**
 * Convert backtest fills into the live TradeRecord shape.
 *
 * Initial positions carry no BUY record, so any sale of them would find no lot
 * and be silently dropped from the tax computation — understating tax for
 * exactly the strategies that trim the opening book hardest. Synthesise an
 * opening BUY per initial position, dated `openedAt`, so every sale has a basis.
 */
export function toTradeRecords(
  result: BacktestResult,
  openingPositions: Array<{ symbol: string; shares: number; price: number }>,
  openedAt: string,
): TradeRecord[] {
  const records: TradeRecord[] = openingPositions.map((p, i) => ({
    timestamp: new Date(openedAt).toISOString(),
    symbol: p.symbol,
    action: 'BUY' as const,
    qty: p.shares,
    estimatedValue: p.shares * p.price,
    fillPrice: p.price,
    orderId: -1000 - i,
    status: 'filled',
    reason: 'opening position (synthetic, for cost basis)',
    commission: 0,
  }));

  result.trades.forEach((t, i) => {
    records.push({
      timestamp: new Date(`${t.date}T20:00:00Z`).toISOString(), // US close
      symbol: t.symbol,
      action: t.action,
      qty: t.shares,
      estimatedValue: t.shares * t.price,
      fillPrice: t.price,
      orderId: i + 1,
      status: 'filled',
      reason: t.reason,
      commission: t.commission,
    });
  });

  return records;
}

export function evaluateAfterTax(
  result: BacktestResult,
  records: TradeRecord[],
  marginalRate: number,
): AfterTaxResult {
  const summaries = generateTaxSummary(records);

  let taxPaid = 0;
  let taxableGain = 0;
  let shortTermGain = 0;
  let longTermGain = 0;
  let realisedNetGain = 0;
  for (const s of summaries) {
    taxPaid += s.taxableGain * marginalRate;
    taxableGain += s.taxableGain;
    shortTermGain += s.shortTermGain;
    longTermGain += s.longTermGain;
    realisedNetGain += s.netGain;
  }

  const gross = result.finalPortfolioValue;
  const afterTaxValue = gross - taxPaid;
  const grossProfit = gross - result.startingCapital;

  return {
    grossReturnPct: ((gross - result.startingCapital) / result.startingCapital) * 100,
    taxPaid,
    afterTaxValue,
    afterTaxReturnPct: ((afterTaxValue - result.startingCapital) / result.startingCapital) * 100,
    taxableGain,
    shortTermGain,
    longTermGain,
    realisedNetGain,
    trades: result.trades.length,
    dragPctOfProfit: grossProfit > 0 ? (taxPaid / grossProfit) * 100 : 0,
  };
}
