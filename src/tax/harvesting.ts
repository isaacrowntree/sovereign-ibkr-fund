/**
 * Tax-loss harvesting and lot selection algorithms.
 *
 * DISABLED. This is US tax logic: a 31-day wash-sale window, US short/long
 * rates, "substantially identical" ETF swaps. None of it is how Australia
 * works. The ATO's wash-sale position (TR 2008/1) is a purpose test under
 * Part IVA, not a day count: selling to crystallise a loss and buying back
 * the same exposure can have the loss cancelled however many days apart.
 * Nothing in the fund auto-harvests; the tax optimizer only reports, and
 * with harvesting off it reports nothing. The code is kept, not rewritten,
 * until an AU-specific policy is designed.
 *
 * The 31-day re-buy block the rebalancer applies to a loss sale is behind
 * WASH_SALE_BLOCK (see washSaleBlockEnabled).
 */

/** Harvesting is off unless TAX_HARVESTING=on. Nothing acts on candidates even then. */
export function harvestingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|true|1)$/i.test(env.TAX_HARVESTING ?? '');
}

/**
 * WASH_SALE_BLOCK: whether a recent loss sale blocks re-buying the symbol for
 * 31 days. ON by default until the tax work is deployed (the plan flips the
 * default to off then); "off" / "false" / "0" disables it.
 */
export function washSaleBlockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0)$/i.test((env.WASH_SALE_BLOCK ?? 'on').trim());
}

export interface TaxLot {
  id: string;
  symbol: string;
  qty: number;
  costBasis: number;      // per share
  acquiredAt: string;      // ISO date
  currentPrice: number;
}

export interface HarvestCandidate {
  lot: TaxLot;
  unrealizedLoss: number;
  isLongTerm: boolean;
  replacement: string;     // substitute ticker
}

export interface WashSaleEntry {
  symbol: string;
  soldAt: string;          // ISO date
  expiresAt: string;       // 31 days later
}

/** ETF substitution pairs (substantially similar but not identical) */
const SUBSTITUTES: Record<string, string> = {
  'VTI': 'ITOT', 'ITOT': 'VTI',
  'VXUS': 'IXUS', 'IXUS': 'VXUS',
  'BND': 'AGG', 'AGG': 'BND',
  'BNDX': 'IAGG', 'IAGG': 'BNDX',
  'SPY': 'IVV', 'IVV': 'SPY',
  'QQQ': 'QQQM', 'QQQM': 'QQQ',
  'VGT': 'XLK', 'XLK': 'VGT',
};

/** Check if a lot has a harvestable loss */
export function isHarvestable(
  lot: TaxLot,
  minLossUsd: number = 100,
  minLossPct: number = 3
): boolean {
  const totalCost = lot.costBasis * lot.qty;
  const totalValue = lot.currentPrice * lot.qty;
  const loss = totalCost - totalValue;
  const lossPct = totalCost > 0 ? (loss / totalCost) * 100 : 0;
  return loss >= minLossUsd && lossPct >= minLossPct;
}

/** Check if a symbol is in wash sale restriction period */
export function isWashSaleRestricted(
  symbol: string,
  washSales: WashSaleEntry[],
  now: Date = new Date()
): boolean {
  return washSales.some(ws =>
    ws.symbol === symbol && new Date(ws.expiresAt) > now
  );
}

/** Scan lots for tax-loss harvesting candidates */
export function findHarvestCandidates(
  lots: TaxLot[],
  washSales: WashSaleEntry[],
  minLossUsd: number = 100,
  now: Date = new Date()
): HarvestCandidate[] {
  const candidates: HarvestCandidate[] = [];

  for (const lot of lots) {
    if (!isHarvestable(lot, minLossUsd)) continue;
    if (isWashSaleRestricted(lot.symbol, washSales, now)) continue;

    const replacement = SUBSTITUTES[lot.symbol];
    if (!replacement) continue;
    if (isWashSaleRestricted(replacement, washSales, now)) continue;

    const unrealizedLoss = (lot.costBasis - lot.currentPrice) * lot.qty;
    const daysHeld = (now.getTime() - new Date(lot.acquiredAt).getTime()) / (1000 * 86400);
    const isLongTerm = daysHeld >= 366;

    candidates.push({ lot, unrealizedLoss, isLongTerm, replacement });
  }

  // Sort by loss size descending (harvest biggest losses first)
  return candidates.sort((a, b) => b.unrealizedLoss - a.unrealizedLoss);
}

/** Create wash sale entry after harvesting */
export function createWashSaleEntry(symbol: string, soldAt: Date = new Date()): WashSaleEntry {
  const expires = new Date(soldAt);
  expires.setDate(expires.getDate() + 31);
  return {
    symbol,
    soldAt: soldAt.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

/**
 * HIFO lot selection: sell lots with highest cost basis first
 * Minimizes taxable gain (or maximizes deductible loss)
 */
export function hifoSelect(lots: TaxLot[], targetQty: number): TaxLot[] {
  const sorted = [...lots].sort((a, b) => b.costBasis - a.costBasis);
  const selected: TaxLot[] = [];
  let remaining = targetQty;

  for (const lot of sorted) {
    if (remaining <= 0) break;
    const qty = Math.min(lot.qty, remaining);
    selected.push({ ...lot, qty });
    remaining -= qty;
  }

  return selected;
}

/** Tax-aware rebalancing: compute net tax cost of a trade */
export function taxCostOfSale(
  lots: TaxLot[],
  qty: number,
  shortTermRate: number = 0.37,
  longTermRate: number = 0.20,
  now: Date = new Date()
): number {
  const selected = hifoSelect(lots, qty);
  let totalTax = 0;

  for (const lot of selected) {
    const gain = (lot.currentPrice - lot.costBasis) * lot.qty;
    if (gain <= 0) continue; // losses are beneficial, no tax
    const daysHeld = (now.getTime() - new Date(lot.acquiredAt).getTime()) / (1000 * 86400);
    const rate = daysHeld >= 366 ? longTermRate : shortTermRate;
    totalTax += gain * rate;
  }

  return totalTax;
}
