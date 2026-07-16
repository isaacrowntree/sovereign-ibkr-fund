import { describe, it, expect } from 'vitest';
import { buildDigest, tradingDate, tradesOn } from './daily-summary.js';
import type { TradeRecord } from '../state/store.js';

const trade = (over: Partial<TradeRecord> = {}): TradeRecord => ({
  timestamp: '2026-07-16T18:30:00Z',
  symbol: 'VTI',
  action: 'BUY',
  qty: 10,
  estimatedValue: 3000,
  orderId: 1,
  status: 'filled',
  reason: 'rebalance',
  ...over,
});

describe('tradingDate: US session, not host-local', () => {
  // The Pi runs AEST. 22:00 AEST is ~08:00 ET the SAME day (pre-market), and
  // the US close lands on the following AEST morning — so a host-local date
  // would name the wrong session.
  it('names the US date, not the local one', () => {
    // 2026-07-17T02:00Z = 2026-07-16 22:00 ET → still the 16th in New York.
    expect(tradingDate(new Date('2026-07-17T02:00:00Z'))).toBe('2026-07-16');
  });

  it('rolls over at US midnight, not UTC midnight', () => {
    // 03:59Z = 23:59 ET on the 16th.
    expect(tradingDate(new Date('2026-07-17T03:59:00Z'))).toBe('2026-07-16');
    // 04:01Z = 00:01 ET on the 17th.
    expect(tradingDate(new Date('2026-07-17T04:01:00Z'))).toBe('2026-07-17');
  });

  it('handles US DST both ways (offset changes, logic does not)', () => {
    // January: EST = UTC-5.
    expect(tradingDate(new Date('2026-01-16T04:30:00Z'))).toBe('2026-01-15');
    // July: EDT = UTC-4.
    expect(tradingDate(new Date('2026-07-16T03:30:00Z'))).toBe('2026-07-15');
  });

  it('produces a stable YYYY-MM-DD shape usable as a dedupe key', () => {
    expect(tradingDate(new Date('2026-07-16T18:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('tradesOn', () => {
  it('selects only the given trading day', () => {
    const history = [
      trade({ timestamp: '2026-07-16T18:30:00Z', symbol: 'A' }), // 14:30 ET 16th
      trade({ timestamp: '2026-07-15T18:30:00Z', symbol: 'B' }), // 15th
      trade({ timestamp: '2026-07-17T02:00:00Z', symbol: 'C' }), // 22:00 ET 16th
    ];
    expect(tradesOn(history, '2026-07-16').map(t => t.symbol)).toEqual(['A', 'C']);
  });

  it('ignores unparseable and missing timestamps rather than throwing', () => {
    const history = [
      trade({ timestamp: 'not-a-date' }),
      trade({ timestamp: '' }),
      trade({ timestamp: '2026-07-16T18:30:00Z', symbol: 'OK' }),
    ];
    expect(tradesOn(history, '2026-07-16').map(t => t.symbol)).toEqual(['OK']);
  });
});

describe('buildDigest', () => {
  const state = {
    lastNav: 104_210,
    lastCash: 8_400,
    drawdownLevel: 'normal',
    navHistory: [110_000, 104_210],
    stressTest: { baselineVaR: 2_100, stressedVaR: 5_400 },
    factorRegression: { rSquared: 0.82, alpha: 0.00012 },
    lastSnapshot: {
      holdings: [
        { symbol: 'VTI', targetPct: 42, currentPct: 50.4, currentValue: 52_000 },
        { symbol: 'BND', targetPct: 18, currentPct: 17.8, currentValue: 18_500 },
        { symbol: 'NET', targetPct: 10, currentPct: 2.0, currentValue: 2_100 },
      ],
    },
  };

  it('headlines NAV and realised P&L for the day', () => {
    const d = buildDigest(state, [trade({ action: 'SELL', realisedPnlUsd: 1234 })], '2026-07-16');
    expect(d.title).toContain('2026-07-16');
    expect(d.title).toContain('$104,210');
    expect(d.title).toContain('+$1,234 realised');
  });

  it('computes drawdown from navHistory against the peak', () => {
    const d = buildDigest(state, [], '2026-07-16');
    // (110000 - 104210) / 110000 = 5.26%
    expect(d.fields.find(f => f.label === 'Drawdown')!.value).toBe('5.3% (normal)');
  });

  it('lists the day’s fills with price and realised P&L', () => {
    const d = buildDigest(state, [trade({ action: 'SELL', symbol: 'VTI', qty: 40, fillPrice: 251.5, realisedPnlUsd: -300, longTermHolding: true })], '2026-07-16');
    expect(d.body).toContain('SELL 40 VTI @ $251.50');
    expect(d.body).toContain('-$300');
    expect(d.body).toContain('LT');
  });

  it('says so plainly when nothing traded', () => {
    const d = buildDigest(state, [], '2026-07-16');
    expect(d.body).toContain('No fills');
    expect(d.fields.find(f => f.label === 'Fills')).toBeUndefined();
  });

  it('ranks drift worst-first', () => {
    const d = buildDigest(state, [], '2026-07-16');
    const driftIdx = d.body.indexOf('Drift');
    // NET is 8.0 off target, VTI 8.4, BND 0.2 → VTI first, then NET.
    expect(d.body.indexOf('VTI:', driftIdx)).toBeLessThan(d.body.indexOf('NET:', driftIdx));
  });

  it('absorbs the advisory output that nothing used to read', () => {
    const d = buildDigest(
      {
        ...state,
        marketAlerts: ['NET moved +4.10% — significant'],
        harvestCandidates: [{ symbol: 'VTI', loss: -820 }],
        hedgeActions: [{ hedgeType: 'protective_put', symbol: 'SPY' }],
      },
      [],
      '2026-07-16',
    );
    expect(d.body).toContain('NET moved +4.10%');
    expect(d.body).toContain('$820 loss');
    expect(d.body).toContain('protective_put SPY');
  });

  it('omits advisory sections entirely when empty, rather than printing headers', () => {
    const d = buildDigest(state, [], '2026-07-16');
    expect(d.body).not.toContain('Movers');
    expect(d.body).not.toContain('harvest');
    expect(d.body).not.toContain('Hedge');
  });

  it('survives an empty state without throwing', () => {
    expect(() => buildDigest({}, [], '2026-07-16')).not.toThrow();
    const d = buildDigest({}, [], '2026-07-16');
    expect(d.title).toContain('NAV unknown');
    expect(d.fields.find(f => f.label === 'Drawdown')!.value).toBe('unknown');
  });

  it('derives the day’s cost from trades, not from the overwrite-only shortfallMetrics key', () => {
    // execution-bot does `updates.shortfallMetrics = outcome.shortfalls` — an
    // overwrite, so that key holds the LAST RUN's fills, not the day's. The
    // digest must not read it.
    const d = buildDigest(
      { ...state, shortfallMetrics: [{ symbol: 'STALE', totalShortfallBps: 999, totalShortfallUsd: 999 }] },
      [trade({ estimatedValue: 3000 }), trade({ estimatedValue: 2000 })],
      '2026-07-16',
    );
    expect(d.fields.find(f => f.label === 'Traded')!.value).toBe('$5,000');
    expect(JSON.stringify(d)).not.toContain('STALE');
  });
});
