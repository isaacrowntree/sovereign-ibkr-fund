/**
 * FIFO match for a sale about to be recorded — a thin view over the lot engine.
 *
 * The executor annotates each SELL it records with the parcels it consumed,
 * its weighted cost base and realised P&L. That used to be its own matcher
 * (whole-lot consumption for legacy records, commission ignored, a `> 365.25
 * days` long-term test); it is now the lot engine's open parcels, so the
 * annotation and the tax report are the same computation.
 *
 * The annotation is informational: the tax report recomputes every sale from
 * the fills and never reads it back.
 */
import type { TradeRecord } from '../state/store.js';
import { openLotsFor } from './lots.js';
import { exchangeTradeDate, isDiscountEligible } from './au-dates.js';

export interface MatchedLot {
  /** `timestamp` of the BUY record this parcel came from. */
  buyTimestamp: string;
  /** Shares matched from that lot. */
  qty: number;
  /** Per-share purchase price of that lot (excluding brokerage). */
  buyPrice: number;
  /** Whether this parcel qualifies for the AU CGT 50% discount at this sale. */
  longTerm: boolean;
}

export interface FifoMatch {
  /** Weighted-average cost base per share across matched parcels, brokerage included. */
  costBasisPrice: number;
  /** Realised P&L in USD across matched parcels, net of buy and sell brokerage. */
  realisedPnlUsd: number;
  /** Shares that found a matching lot (may be < sellQty if history is short). */
  matchedQty: number;
  /** Quantity eligible for the AU CGT discount. */
  longTermQty: number;
  /** The parcels consumed, oldest first. */
  lots: MatchedLot[];
}

/**
 * FIFO cost base / realised P&L for a SELL of `sellQty` shares of `symbol` at
 * `sellPrice`, against the parcels still open after replaying `history`.
 *
 * `sellTime` defaults to now; injectable for tests. `sellCommission` (USD) is
 * the sale's brokerage, when known.
 */
export function matchSellFifo(
  history: TradeRecord[],
  symbol: string,
  sellQty: number,
  sellPrice: number,
  sellTime: number = Date.now(),
  sellCommission = 0,
): FifoMatch {
  const sellIso = new Date(sellTime).toISOString();
  const sellDate = exchangeTradeDate(sellIso) ?? sellIso.slice(0, 10);
  // Only what was bought at or before the sale can be sold.
  const prior = history.filter((t) => t.symbol === symbol && Date.parse(t.timestamp) <= sellTime);
  const lots = openLotsFor(prior, symbol);

  const out: MatchedLot[] = [];
  let toFill = sellQty;
  let cost = 0;
  let longTermQty = 0;
  for (const lot of lots) {
    if (toFill <= 0) break;
    const take = Math.min(lot.qty, toFill);
    const longTerm = !!lot.buyDate && isDiscountEligible(lot.buyDate, sellDate);
    out.push({ buyTimestamp: lot.buyTimestamp, qty: take, buyPrice: lot.priceUsd, longTerm });
    cost += take * lot.costPerShareUsd;
    if (longTerm) longTermQty += take;
    toFill -= take;
  }
  const matchedQty = sellQty - toFill;
  const sellCommMatched = sellQty > 0 ? (Math.abs(sellCommission) * matchedQty) / sellQty : 0;
  return {
    costBasisPrice: matchedQty > 0 ? cost / matchedQty : 0,
    realisedPnlUsd: matchedQty > 0 ? matchedQty * sellPrice - sellCommMatched - cost : 0,
    matchedQty,
    longTermQty,
    lots: out,
  };
}
