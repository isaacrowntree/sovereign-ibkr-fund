import { describe, it, expect } from 'vitest';
import { runBacktest, DEFAULT_CONFIG, loadHistoricalData, type Position } from './backtest-engine.js';
import { BACKTEST_DATA_AVAILABLE } from './data-available.js';

/**
 * The harness must not invent a catastrophe the strategy never had.
 *
 * The hard stop used to liquidate the whole book and `continue`, while peakValue
 * never reset — so NAV parked in cash kept the drawdown above the threshold for
 * the rest of the run and the strategy could never re-enter. Any config that
 * merely TOUCHED hardStopPct read as a near-total failure for years afterwards.
 */
describe.skipIf(!BACKTEST_DATA_AVAILABLE)('drawdown hard stop', () => {
  const SYMS = ['PLTR', 'AMZN', 'TWLO', 'TSLA', 'BRK-B', 'NET'];

  const opening = (): Position[] => {
    const data = loadHistoricalData();
    return SYMS.filter(s => data[s]?.length).map(s => ({ symbol: s, shares: 10 }));
  };

  it('halts without selling, and recovers when the drawdown does', () => {
    // A hair-trigger stop that a normal market WILL breach.
    const twitchy = runBacktest(
      { ...DEFAULT_CONFIG, name: 'twitchy', symbols: SYMS,
        drawdownLimits: { warningPct: 1, deriskPct: 2, hardStopPct: 3 } },
      30_000, opening(),
    );
    // It must actually have hit the stop, or this test proves nothing.
    expect(twitchy.hardStopDays).toBeGreaterThan(0);

    // The old behaviour: every position sold on the first breach. A liquidation
    // shows up as a burst of SELLs all on one day, for the whole book.
    const hardStopSells = twitchy.trades.filter(t => t.reason.includes('Hard stop'));
    expect(hardStopSells).toHaveLength(0);

    // And it must not be frozen at cash: the book still has value at the end.
    expect(twitchy.finalPositions.some(p => p.shares > 0)).toBe(true);
  });

  it('a breached stop no longer destroys the whole run', () => {
    const twitchy = runBacktest(
      { ...DEFAULT_CONFIG, name: 'twitchy', symbols: SYMS,
        drawdownLimits: { warningPct: 1, deriskPct: 2, hardStopPct: 3 } },
      30_000, opening(),
    );
    const normal = runBacktest(
      { ...DEFAULT_CONFIG, name: 'normal', symbols: SYMS,
        drawdownLimits: { warningPct: 7, deriskPct: 15, hardStopPct: 25 } },
      30_000, opening(),
    );
    // A tighter stop should cost SOME return — it halts more often — but it must
    // not collapse to a permanently-liquidated fraction of the normal run.
    expect(twitchy.totalReturn).toBeGreaterThan(normal.totalReturn * 0.25);
  });
});
