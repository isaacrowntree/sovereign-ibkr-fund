/**
 * Quantity-aware FIFO lot matching for realised P&L and cost basis.
 *
 * The prior implementation matched each SELL to exactly one earliest BUY
 * record and priced the WHOLE sale off that one lot, ignoring share counts.
 * That produced wrong P&L (and a sign flip that could suppress a wash-sale
 * entry) on multi-lot sells, and dropped cost basis entirely on a second
 * sell of a lot the first had "consumed".
 *
 * This module replays trade history to compute, per BUY lot, how many shares
 * remain unconsumed by earlier SELLs, then consumes the current sale across
 * those lots oldest-first — the correct FIFO treatment. It is pure and takes
 * the history as input so it is fully unit-testable.
 */
import type { TradeRecord } from '../state/store.js';

export interface MatchedLot {
  /** `timestamp` of the BUY record this parcel came from. */
  buyTimestamp: string;
  /** Shares matched from that lot. */
  qty: number;
  /** Per-share cost basis of that lot. */
  buyPrice: number;
  /** Whether this parcel was held > 12 months at sale (AU CGT discount). */
  longTerm: boolean;
}

export interface FifoMatch {
  /** Weighted-average cost basis across all matched parcels. */
  costBasisPrice: number;
  /** Realised P&L in USD across all matched parcels. */
  realisedPnlUsd: number;
  /** Shares that found a matching lot (may be < sellQty if history is short). */
  matchedQty: number;
  /** Quantity held > 12 months, eligible for the AU CGT discount. */
  longTermQty: number;
  /** The parcels consumed, oldest first. */
  lots: MatchedLot[];
}

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Compute FIFO cost basis / realised P&L for a SELL of `sellQty` shares of
 * `symbol` at `sellPrice`, against the BUY lots in `history` net of shares
 * already consumed by prior SELLs.
 *
 * Consumption is derived from prior SELL records' `matchedLots` (new format).
 * A legacy SELL carrying only `matchedBuyTimestamp` is treated as having
 * consumed its whole matched lot, preserving old behaviour for existing
 * history.
 *
 * `sellTime` defaults to now; injectable for tests.
 */
export function matchSellFifo(
  history: TradeRecord[],
  symbol: string,
  sellQty: number,
  sellPrice: number,
  sellTime: number = Date.now(),
): FifoMatch {
  // Remaining shares per BUY lot (keyed by its timestamp), oldest first.
  const buys = history
    .filter(t => t.action === 'BUY' && t.symbol === symbol)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const remaining = new Map<string, number>();
  for (const b of buys) remaining.set(b.timestamp, (remaining.get(b.timestamp) ?? 0) + b.qty);

  // Subtract shares consumed by earlier SELLs of this symbol.
  for (const s of history) {
    if (s.action !== 'SELL' || s.symbol !== symbol) continue;
    if (s.matchedLots && s.matchedLots.length > 0) {
      for (const lot of s.matchedLots) {
        remaining.set(lot.buyTimestamp, (remaining.get(lot.buyTimestamp) ?? 0) - lot.qty);
      }
    } else if (s.matchedBuyTimestamp) {
      // Legacy: whole-lot consumption.
      remaining.set(s.matchedBuyTimestamp, 0);
    }
  }

  const lots: MatchedLot[] = [];
  let toFill = sellQty;
  let costTimesQty = 0;
  let realisedPnlUsd = 0;
  let longTermQty = 0;

  for (const b of buys) {
    if (toFill <= 0) break;
    const avail = remaining.get(b.timestamp) ?? 0;
    if (avail <= 0) continue;
    const take = Math.min(avail, toFill);
    const buyPrice = b.fillPrice ?? (b.qty > 0 ? b.estimatedValue / b.qty : 0);
    const longTerm = sellTime - new Date(b.timestamp).getTime() > YEAR_MS;

    lots.push({ buyTimestamp: b.timestamp, qty: take, buyPrice, longTerm });
    costTimesQty += buyPrice * take;
    realisedPnlUsd += take * (sellPrice - buyPrice);
    if (longTerm) longTermQty += take;

    remaining.set(b.timestamp, avail - take);
    toFill -= take;
  }

  const matchedQty = sellQty - toFill;
  return {
    costBasisPrice: matchedQty > 0 ? costTimesQty / matchedQty : 0,
    realisedPnlUsd,
    matchedQty,
    longTermQty,
    lots,
  };
}
