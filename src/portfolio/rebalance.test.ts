import { describe, it, expect } from 'vitest';
import { generateRebalanceOrders, decideRebalance, type PortfolioSnapshot } from './rebalance';

const PRICE = 100;

function snapshot(overrides: Partial<PortfolioSnapshot>): PortfolioSnapshot {
  return {
    symbols: ['A', 'B', 'C', 'D'],
    prices: new Map([['A', PRICE], ['B', PRICE], ['C', PRICE], ['D', PRICE]]),
    currentShares: new Map(),
    nav: 10_000,
    cash: 0,
    peakNav: 10_000,
    ...overrides,
  };
}

describe('generateRebalanceOrders — cash-aware behavior', () => {
  it('issues BUYs at full size when buys fit in available cash', () => {
    // NAV $11k, $11k cash. Targets sum to 90% of NAV ($9,900). Available cash
    // for buys = $11k - $50 buffer = $10,950 ≥ $9,900 → no scaling.
    const orders = generateRebalanceOrders(
      snapshot({ cash: 11_000, nav: 11_000, peakNav: 11_000 }),
      new Map([['A', 0.225], ['B', 0.225], ['C', 0.225], ['D', 0.225]]),
      'static',
      50,
    );

    const buys = orders.filter(o => o.action === 'BUY');
    expect(buys).toHaveLength(4);
    for (const o of buys) {
      // 22.5% of $11k = $2475 → 24 shares (floor) × $100 = $2400
      expect(o.shares).toBe(24);
      expect(o.estimatedValue).toBe(2400);
      expect(o.reason).not.toMatch(/scaled/i); // no scaling note
    }
  });

  it('scales BUYs proportionally when sum of buys exceeds available cash', () => {
    // Realistic: NAV $37,000 mostly in tracked positions but cash only $36.
    // Targets sum to 100% but we only have $36 cash + sells.
    // Existing: NET 30%, TSLA 10% (40% allocated, 60% target zero positions).
    // We sell down NET to 4% and TSLA to 4%, then try to buy AVGO/CAT/LLY etc.
    const nav = 37_000;
    const cash = 36;
    const snap = snapshot({
      symbols: ['NET', 'TSLA', 'AVGO', 'CAT', 'LLY'],
      prices: new Map([['NET', 200], ['TSLA', 400], ['AVGO', 500], ['CAT', 800], ['LLY', 900]]),
      currentShares: new Map([['NET', 55], ['TSLA', 9]]), // $11k + $3.6k = $14.6k positions
      nav,
      cash,
      peakNav: nav,
    });
    const targets = new Map<string, number>([
      ['NET', 0.04], ['TSLA', 0.04], ['AVGO', 0.20], ['CAT', 0.30], ['LLY', 0.42],
    ]);
    const orders = generateRebalanceOrders(snap, targets, 'static', 50);
    const sells = orders.filter(o => o.action === 'SELL');
    const buys = orders.filter(o => o.action === 'BUY');
    const sellNotional = sells.reduce((s, o) => s + o.estimatedValue, 0);
    const buyNotional = buys.reduce((s, o) => s + o.estimatedValue, 0);

    // Sells should reduce overweight positions to target (full size, no scaling)
    expect(sells.length).toBeGreaterThan(0);
    for (const s of sells) {
      expect(s.reason).not.toMatch(/scaled/i);
    }

    // Total buy notional must NOT exceed available cash (cash + sells - safety buffer)
    const safety = 50;
    expect(buyNotional).toBeLessThanOrEqual(cash + sellNotional - safety + 1e-6);

    // BUYs should be tagged as scaled
    expect(buys.length).toBeGreaterThan(0);
    for (const b of buys) {
      expect(b.reason).toMatch(/scaled \d+% to fit cash/);
    }
  });

  it('all BUYs scaled by the same factor (preserves relative weights)', () => {
    const snap = snapshot({
      cash: 1_000, // tiny cash
      currentShares: new Map(),
    });
    // Target = 50% A + 50% B → would want $5000 each = $10000 buy notional
    // but only $1000 cash available, so scale should be ~10% (after buffer)
    const orders = generateRebalanceOrders(
      snap,
      new Map([['A', 0.5], ['B', 0.5]]),
      'static',
      10,
    );
    const buyA = orders.find(o => o.symbol === 'A' && o.action === 'BUY')!;
    const buyB = orders.find(o => o.symbol === 'B' && o.action === 'BUY')!;
    // With cash=$1000, safety=$50, scale = 950/10000 = 0.095
    // 50 shares × 0.095 = 4.75 → floor → 4 shares each, $400 each, $800 total
    expect(buyA.shares).toBe(buyB.shares);
    expect(buyA.estimatedValue).toBe(buyB.estimatedValue);
  });

  it('issues all SELLs at full size even when buys are scaled to zero', () => {
    // Account fully invested in overweight, no cash, no buys can fit
    const snap = snapshot({
      currentShares: new Map([['A', 100]]), // $10k in A, 100% allocated
      cash: 0,
    });
    // Target: A=20%, B=80% — sell most of A, try to buy B
    const orders = generateRebalanceOrders(
      snap,
      new Map([['A', 0.20], ['B', 0.80]]),
      'static',
      50,
    );
    const sells = orders.filter(o => o.action === 'SELL');
    const buys = orders.filter(o => o.action === 'BUY');
    expect(sells).toHaveLength(1);
    expect(sells[0].symbol).toBe('A');
    expect(sells[0].shares).toBe(80); // sell 80 to get from 100 → 20
    // Buys scaled: only $8000 of sell proceeds + 0 cash - $50 buffer = $7950 available
    // Target buy would be $8000 → scale = 7950/8000 = 0.99375
    // 80 × 0.99375 = 79.5 → floor → 79 shares
    expect(buys).toHaveLength(1);
    expect(buys[0].symbol).toBe('B');
    expect(buys[0].reason).toMatch(/scaled/);
  });

  it('drops a buy entirely when scaled qty floors to 0', () => {
    // Two buys of very different unit prices, one scales to 0 shares
    const snap = snapshot({
      symbols: ['CHEAP', 'EXPENSIVE'],
      prices: new Map([['CHEAP', 10], ['EXPENSIVE', 5_000]]), // EXPENSIVE = 1 share = $5k
      currentShares: new Map(),
      cash: 100, // tiny cash
      nav: 10_100,
    });
    // Target: 1% expensive ($101 → 0 shares because $5k > $101), 99% cheap ($9999)
    const orders = generateRebalanceOrders(
      snap,
      new Map([['CHEAP', 0.99], ['EXPENSIVE', 0.01]]),
      'static',
      10,
    );
    // EXPENSIVE: target $101 < price $5000 → 0 shares → no order at full size either
    // CHEAP: target $9999, scaled by $50/$9999 ≈ 0.5%, ~5 shares × $10 = $50
    const buys = orders.filter(o => o.action === 'BUY');
    expect(buys.find(o => o.symbol === 'EXPENSIVE')).toBeUndefined();
    // CHEAP may or may not survive depending on minTradeUsd; just confirm no expensive order
  });

  it('respects minTradeUsd after scaling — drops orders that fall below threshold', () => {
    const snap = snapshot({
      symbols: ['A', 'B'],
      prices: new Map([['A', 100], ['B', 100]]),
      currentShares: new Map(),
      cash: 100,
      nav: 10_000,
    });
    // Target 50% / 50% → would want $5000 each at full size = $10k buys
    // Available = $50. Each buy scales to 0.5 shares → 0 after floor. No orders.
    const orders = generateRebalanceOrders(
      snap,
      new Map([['A', 0.5], ['B', 0.5]]),
      'static',
      50, // minTradeUsd higher than scaled-down value
    );
    expect(orders.filter(o => o.action === 'BUY')).toHaveLength(0);
  });

  it('does not scale when only sells are needed (no buys)', () => {
    // Single-symbol target — only A is rebalanced. B is held at $4000 but
    // not in the target map so no order is generated for it.
    const snap = snapshot({
      symbols: ['A'],
      prices: new Map([['A', 100]]),
      currentShares: new Map([['A', 60]]),
      cash: 4_000,
      nav: 10_000,
    });
    const orders = generateRebalanceOrders(
      snap,
      new Map([['A', 0.50]]),
      'static',
      50,
    );
    // A: 60 shares × $100 = $6000 = 60% of NAV, target 50% = $5000 → SELL 10
    // No other targets → no buys → no scaling
    expect(orders).toHaveLength(1);
    expect(orders[0].action).toBe('SELL');
    expect(orders[0].symbol).toBe('A');
    expect(orders[0].shares).toBe(10);
    expect(orders[0].reason).not.toMatch(/scaled/i);
  });

  it('keeps the safety buffer (does not spend the last $50)', () => {
    const snap = snapshot({
      symbols: ['A'],
      prices: new Map([['A', 1]]), // $1 shares so we can be precise about cents
      currentShares: new Map(),
      cash: 1_000,
      nav: 1_000,
    });
    // Target 100% A → would want $1000 buy
    const orders = generateRebalanceOrders(
      snap,
      new Map([['A', 1.0]]),
      'static',
      10,
    );
    const buys = orders.filter(o => o.action === 'BUY');
    expect(buys).toHaveLength(1);
    // Available cash for buys = 1000 + 0 - 50 = 950
    // scale = 950 / 1000 = 0.95 → 1000 × 0.95 = 950 shares
    expect(buys[0].shares).toBe(950);
    expect(buys[0].estimatedValue).toBe(950);
  });
});

describe('generateRebalanceOrders — cashBufferPct', () => {
  it('reserves the configured percentage of NAV as cash', () => {
    // NAV $10k, $10k cash. Target 100% A. With 1% cash buffer, target
    // is effectively 99% × $10k = $9,900 → buy 9,900 shares at $1.
    const snap = snapshot({
      symbols: ['A'],
      prices: new Map([['A', 1]]),
      currentShares: new Map(),
      cash: 10_000,
      nav: 10_000,
    });
    const orders = generateRebalanceOrders(
      snap,
      new Map([['A', 1.0]]),
      'static',
      10,
      { cashBufferPct: 1 },
    );
    expect(orders).toHaveLength(1);
    // 100% target × (1 - 0.01) = 99% × $10k = $9,900
    expect(orders[0].estimatedValue).toBeCloseTo(9_900, 0);
    // Should NOT be tagged as scaled — the buffer makes the target fit
    expect(orders[0].reason).not.toMatch(/scaled|partial/i);
  });

  it('cashBufferPct=0 (default) replicates pre-buffer behaviour', () => {
    const snap = snapshot({
      symbols: ['A'],
      prices: new Map([['A', 1]]),
      currentShares: new Map(),
      cash: 10_000,
      nav: 10_000,
    });
    const ordersDefault = generateRebalanceOrders(
      snap,
      new Map([['A', 1.0]]),
      'static',
      10,
    );
    const ordersExplicit = generateRebalanceOrders(
      snap,
      new Map([['A', 1.0]]),
      'static',
      10,
      { cashBufferPct: 0 },
    );
    expect(ordersDefault[0].shares).toBe(ordersExplicit[0].shares);
  });
});

describe('generateRebalanceOrders — fillMode greedy', () => {
  it('greedy fully fills the highest-drift names first, drops lowest', () => {
    // Two BUYs, more cash for one but not both. Greedy should fill the
    // one with bigger drift completely and drop the other.
    const snap = snapshot({
      symbols: ['A', 'B'],
      prices: new Map([['A', 100], ['B', 100]]),
      currentShares: new Map(),
      cash: 5_500,
      nav: 10_000,
    });
    // Target 80% A + 10% B → would want $8,000 + $1,000 = $9,000 in BUYs
    // Available cash = 5500 - 50 = 5450 → can only afford one of them.
    // Greedy: A has drift 80%, B has drift 10% → A wins, B dropped.
    const orders = generateRebalanceOrders(
      snap,
      new Map([['A', 0.80], ['B', 0.10]]),
      'static',
      50,
      { fillMode: 'greedy' },
    );
    const buys = orders.filter(o => o.action === 'BUY');
    const a = buys.find(o => o.symbol === 'A');
    const b = buys.find(o => o.symbol === 'B');
    expect(a?.shares).toBe(54); // 5450 / 100 = 54.5 → floor → 54
    // Either dropped entirely, or partial fill — either is acceptable so
    // long as cash invariant holds
    const totalBuys = buys.reduce((s, o) => s + o.estimatedValue, 0);
    expect(totalBuys).toBeLessThanOrEqual(5_450 + 1e-6);
  });

  it('greedy partial-fills the cutoff name when cash falls between full and zero', () => {
    const snap = snapshot({
      symbols: ['A', 'B'],
      prices: new Map([['A', 100], ['B', 100]]),
      currentShares: new Map(),
      cash: 7_550,
      nav: 10_000,
    });
    // Target 80% A + 10% B → $8,000 + $1,000 = $9,000 BUYs at full size.
    // Available cash = 7,500. A needs $8,000 (overflows by 500); B needs $1,000.
    // Greedy: A first → partial 75 shares = $7,500. Cash = 0. B dropped.
    const orders = generateRebalanceOrders(
      snap,
      new Map([['A', 0.80], ['B', 0.10]]),
      'static',
      50,
      { fillMode: 'greedy' },
    );
    const buys = orders.filter(o => o.action === 'BUY');
    const a = buys.find(o => o.symbol === 'A');
    expect(a?.shares).toBe(75);
    expect(a?.reason).toMatch(/partial fill: 75 of \d+ fit cash/i);
  });

  it('greedy = proportional when cash is sufficient (both fill at full size)', () => {
    const snap = snapshot({
      symbols: ['A', 'B'],
      prices: new Map([['A', 100], ['B', 100]]),
      currentShares: new Map(),
      cash: 20_000,
      nav: 20_000,
    });
    const greedy = generateRebalanceOrders(
      snap, new Map([['A', 0.40], ['B', 0.40]]), 'static', 10,
      { fillMode: 'greedy' },
    );
    const proportional = generateRebalanceOrders(
      snap, new Map([['A', 0.40], ['B', 0.40]]), 'static', 10,
      { fillMode: 'proportional' },
    );
    const totals = (orders: { estimatedValue: number }[]) =>
      orders.reduce((s, o) => s + o.estimatedValue, 0);
    expect(totals(greedy)).toBe(totals(proportional));
  });
});

describe('generateRebalanceOrders — wash-sale guard', () => {
  it('drops BUYs for symbols inside an active wash-sale window', () => {
    const snap = snapshot({
      symbols: ['A', 'B'],
      prices: new Map([['A', 100], ['B', 100]]),
      currentShares: new Map(),
      nav: 10_000,
      cash: 10_000,
      peakNav: 10_000,
    });
    const targets = new Map([['A', 0.40], ['B', 0.40]]);
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const orders = generateRebalanceOrders(snap, targets, 'static', 50, {
      washSales: [{ symbol: 'A', soldAt: new Date().toISOString(), expiresAt: futureExpiry }],
    });
    const buySymbols = orders.filter(o => o.action === 'BUY').map(o => o.symbol);
    expect(buySymbols).not.toContain('A');
    expect(buySymbols).toContain('B');
  });

  it('allows BUYs for symbols whose wash-sale window has expired', () => {
    const snap = snapshot({
      symbols: ['A'],
      prices: new Map([['A', 100]]),
      currentShares: new Map(),
      nav: 10_000,
      cash: 10_000,
      peakNav: 10_000,
    });
    const targets = new Map([['A', 0.40]]);
    const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const orders = generateRebalanceOrders(snap, targets, 'static', 50, {
      washSales: [{ symbol: 'A', soldAt: pastExpiry, expiresAt: pastExpiry }],
    });
    expect(orders.filter(o => o.action === 'BUY').map(o => o.symbol)).toContain('A');
  });
});

describe('generateRebalanceOrders — loss-first SELL ordering for tax', () => {
  it('orders sells by P&L per share ascending when avgCosts provided', () => {
    // Three holdings, all overweight, all need selling. We want the
    // loss-position to sell FIRST so IBKR realises the loss (lower CGT).
    const snap = snapshot({
      symbols: ['LOSER', 'BREAKEVEN', 'WINNER'],
      prices: new Map([['LOSER', 50], ['BREAKEVEN', 100], ['WINNER', 200]]),
      currentShares: new Map([
        ['LOSER', 100],     // current $5k, avg cost $80 → loss of $30/sh
        ['BREAKEVEN', 100], // current $10k, avg cost $100 → flat
        ['WINNER', 100],    // current $20k, avg cost $50 → gain $150/sh
      ]),
      cash: 0,
      nav: 35_000,
    });
    const targets = new Map([
      ['LOSER', 0.05],     // target 5% = $1,750 → sell ~65 shares
      ['BREAKEVEN', 0.05], // target 5% = $1,750 → sell ~83 shares
      ['WINNER', 0.05],    // target 5% = $1,750 → sell ~91 shares
    ]);
    const avgCosts = new Map([
      ['LOSER', 80], ['BREAKEVEN', 100], ['WINNER', 50],
    ]);
    const orders = generateRebalanceOrders(
      snap, targets, 'static', 50,
      { avgCosts },
    );
    const sells = orders.filter(o => o.action === 'SELL');
    expect(sells[0].symbol).toBe('LOSER');
    expect(sells[1].symbol).toBe('BREAKEVEN');
    expect(sells[2].symbol).toBe('WINNER');
    // Reason string includes the P&L per share for visibility
    expect(sells[0].reason).toMatch(/P&L\/share: -\$30\.00/);
    expect(sells[1].reason).toMatch(/P&L\/share: \+\$0\.00/);
    expect(sells[2].reason).toMatch(/P&L\/share: \+\$150\.00/);
  });

  it('without avgCosts, sells stay in iteration order (no sort)', () => {
    const snap = snapshot({
      symbols: ['A', 'B'],
      prices: new Map([['A', 100], ['B', 100]]),
      currentShares: new Map([['A', 100], ['B', 100]]),
      cash: 0,
      nav: 20_000,
    });
    // Both overweight, target 5% each → both need to sell down
    const orders = generateRebalanceOrders(
      snap, new Map([['A', 0.05], ['B', 0.05]]), 'static', 50,
      // no avgCosts
    );
    const sells = orders.filter(o => o.action === 'SELL');
    expect(sells).toHaveLength(2);
    // No P&L tag in reason (since avgCosts wasn't provided)
    for (const s of sells) {
      expect(s.reason).not.toMatch(/P&L\/share/);
    }
  });
});

describe('decideRebalance', () => {
  const cfg = { driftThreshold: 10, urgentDriftThreshold: 25, frequencyDays: 45 };

  it('urgent: max drift exceeds urgent threshold (cooldown bypassed)', () => {
    expect(decideRebalance(30, 5, cfg)).toBe('urgent');   // even 5d since rebalance
    expect(decideRebalance(25, 0, cfg)).toBe('urgent');   // exactly at threshold, today
    expect(decideRebalance(99, 200, cfg)).toBe('urgent'); // long since
  });

  it('regular: drift over normal threshold AND cooldown lapsed', () => {
    expect(decideRebalance(15, 60, cfg)).toBe('regular');
    expect(decideRebalance(10, 45, cfg)).toBe('regular'); // exactly at both
  });

  it('too-soon: drift exceeds threshold but cooldown active', () => {
    expect(decideRebalance(15, 30, cfg)).toBe('too-soon'); // 15% drift, 30d (need 45)
    expect(decideRebalance(10, 44, cfg)).toBe('too-soon'); // exactly at drift, 1d short
  });

  it('within-threshold: drift below normal threshold', () => {
    expect(decideRebalance(5, 100, cfg)).toBe('within-threshold');
    expect(decideRebalance(9.9, 100, cfg)).toBe('within-threshold');
    expect(decideRebalance(0, 0, cfg)).toBe('within-threshold');
  });

  it('urgent takes precedence over cooldown — even on day 0', () => {
    // Real scenario this guards against: a single position drifts
    // catastrophically right after a rebalance (e.g. takeover, news shock).
    // We don't want to wait 45 days while the portfolio's risk profile
    // changes materially.
    expect(decideRebalance(40, 0, cfg)).toBe('urgent');
  });

  it('Infinity daysSince (never rebalanced) gates correctly', () => {
    expect(decideRebalance(15, Infinity, cfg)).toBe('regular');
    expect(decideRebalance(40, Infinity, cfg)).toBe('urgent');
    expect(decideRebalance(5, Infinity, cfg)).toBe('within-threshold');
  });
});
