import { describe, it, expect } from 'vitest';
import { planDepositBuy, type DepositPlanInput } from './deposit-plan';

/** Two cheap names + one expensive one — enough to expose stranding. */
function base(over: Partial<DepositPlanInput> = {}): DepositPlanInput {
  return {
    targets: { AAA: 50, BBB: 30, CCC: 20 },
    holdings: new Map([['AAA', 5000], ['BBB', 3000], ['CCC', 2000]]),
    prices: new Map([['AAA', 100], ['BBB', 50], ['CCC', 25]]),
    nav: 10000,
    cash: 0,
    depositUsd: 1000,
    reserveUsd: 0,
    ...over,
  };
}

describe('planDepositBuy', () => {
  it('rejects targets that over-allocate', () => {
    // Under 100 is legitimate de-risking (see the de-scaling block below);
    // over 100 sizes buys against money that does not exist.
    expect(() => planDepositBuy(base({ targets: { AAA: 60, BBB: 50 } })))
      .toThrow(/targets sum to 110/i);
  });

  it('rejects a negative deposit', () => {
    expect(() => planDepositBuy(base({ depositUsd: -1 }))).toThrow(/deposit/i);
  });

  it('throws when a target name has no price, naming it', () => {
    expect(() => planDepositBuy(base({ prices: new Map([['AAA', 100], ['BBB', 50]]) })))
      .toThrow(/CCC/);
  });

  it('buys only whole shares and never overspends the budget', () => {
    const p = planDepositBuy(base({ depositUsd: 1000, reserveUsd: 0 }));
    for (const o of p.orders) expect(Number.isInteger(o.qty)).toBe(true);
    expect(p.deployedUsd).toBeLessThanOrEqual(1000);
    expect(p.residualCashUsd).toBeGreaterThanOrEqual(0);
  });

  it('honours the reserve — it is never spent', () => {
    const p = planDepositBuy(base({ depositUsd: 1000, reserveUsd: 150 }));
    expect(p.deployedUsd).toBeLessThanOrEqual(850);
    expect(p.residualCashUsd).toBeGreaterThanOrEqual(150);
  });

  it('spends existing idle cash as well as the deposit', () => {
    // Deficits must exceed the budget, or both runs simply fill every gap and
    // the comparison proves nothing. Start fully in cash so they do.
    const allCash = (cash: number): DepositPlanInput => base({
      holdings: new Map([['AAA', 0], ['BBB', 0], ['CCC', 0]]),
      nav: 10000,
      cash,
      depositUsd: 1000,
    });
    const withCash = planDepositBuy(allCash(500));
    const without = planDepositBuy(allCash(0));
    expect(without.deployedUsd).toBeCloseTo(1000, 0);
    expect(withCash.deployedUsd).toBeGreaterThan(without.deployedUsd);
    expect(withCash.deployedUsd).toBeCloseTo(1500, 0);
  });

  it('funds a directed name to its target before anything else', () => {
    // CCC is at target; without direction it would get nothing.
    const p = planDepositBuy(base({
      targets: { AAA: 40, BBB: 30, CCC: 30 },
      directed: ['CCC'],
      depositUsd: 1000,
    }));
    const ccc = p.orders.find(o => o.symbol === 'CCC');
    expect(ccc).toBeDefined();
    // target 30% of 11000 = 3300, held 2000 -> 1300 wanted, capped by the 1000 budget
    expect(ccc!.estimatedValue).toBeGreaterThan(900);
  });

  it('opens a position in a name not currently held', () => {
    const p = planDepositBuy(base({
      targets: { AAA: 45, BBB: 30, CCC: 20, DDD: 5 },
      prices: new Map([['AAA', 100], ['BBB', 50], ['CCC', 25], ['DDD', 10]]),
      directed: ['DDD'],
      depositUsd: 1000,
    }));
    const ddd = p.orders.find(o => o.symbol === 'DDD');
    expect(ddd).toBeDefined();
    expect(ddd!.qty).toBeGreaterThan(0);
  });

  it('never buys a name already at or above target', () => {
    const p = planDepositBuy(base({
      targets: { AAA: 20, BBB: 30, CCC: 50 },   // AAA is 50% held vs 20% target
      depositUsd: 1000,
    }));
    expect(p.orders.find(o => o.symbol === 'AAA')).toBeUndefined();
  });

  it('greedy fill strands less cash than a proportional split would', () => {
    // One expensive name holds most of the deficit; a proportional slice would
    // not reach one share of it, so the cash would sit idle.
    const p = planDepositBuy({
      targets: { BIG: 60, S1: 20, S2: 20 },
      holdings: new Map([['BIG', 0], ['S1', 2000], ['S2', 2000]]),
      prices: new Map([['BIG', 900], ['S1', 10], ['S2', 10]]),
      nav: 4000,
      cash: 0,
      depositUsd: 1000,
      reserveUsd: 0,
    });
    expect(p.orders.find(o => o.symbol === 'BIG')).toBeDefined();
    expect(p.residualCashUsd).toBeLessThan(900);
  });

  it('leaves less than the cheapest buyable share as residual', () => {
    const p = planDepositBuy(base({ depositUsd: 1000, reserveUsd: 0 }));
    const cheapest = Math.min(...[...base().prices.values()]);
    expect(p.residualCashUsd).toBeLessThan(cheapest);
  });

  it('reports drift against the NEW targets, post-buy', () => {
    // Already exactly on target and no deposit -> zero drift, no orders.
    const p = planDepositBuy(base({ depositUsd: 0, cash: 0 }));
    expect(p.orders).toHaveLength(0);
    expect(p.maxDriftPct).toBeCloseTo(0, 6);
  });

  it('a deposit that cannot be deployed shows up as drift, not as silent success', () => {
    // Everything priced above the budget: nothing buyable, cash sits.
    const p = planDepositBuy(base({
      prices: new Map([['AAA', 1e6], ['BBB', 1e6], ['CCC', 1e6]]),
      depositUsd: 1000,
    }));
    expect(p.orders).toHaveLength(0);
    expect(p.residualCashUsd).toBe(1000);
    expect(p.maxDriftPct).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = planDepositBuy(base());
    const b = planDepositBuy(base());
    expect(a.orders).toEqual(b.orders);
  });

  it('does not mutate the caller\'s holdings map', () => {
    const holdings = new Map([['AAA', 5000], ['BBB', 3000], ['CCC', 2000]]);
    planDepositBuy(base({ holdings }));
    expect(holdings.get('AAA')).toBe(5000);
  });
});

describe('planDepositBuy respects the rebuy guard except where directed', () => {
  // The guard exists to stop buy-only cash flow round-tripping a name the
  // strategy just sold. That is right for incidental cash and wrong for a
  // deposit: a name the operator NAMED in advance is an instruction, not
  // churn. So directed names are exempt and everything else is not.
  const prices = new Map([['AAA', 100], ['BBB', 100], ['CCC', 100]]);
  const base = {
    targets: { AAA: 40, BBB: 30, CCC: 30 },
    holdings: new Map<string, number>([['AAA', 0], ['BBB', 0], ['CCC', 0]]),
    prices,
    nav: 0,
    cash: 0,
    depositUsd: 3000,
    reserveUsd: 0,
  };

  it('buys an excluded name when it is directed', () => {
    const p = planDepositBuy({ ...base, directed: ['BBB'], excluded: new Set(['BBB']) });
    expect(p.orders.find(o => o.symbol === 'BBB')?.qty).toBeGreaterThan(0);
  });

  it('skips an excluded name that was not directed', () => {
    const p = planDepositBuy({ ...base, directed: [], excluded: new Set(['BBB']) });
    expect(p.orders.find(o => o.symbol === 'BBB')).toBeUndefined();
  });

  it('parks the excluded share rather than overshooting the others', () => {
    const p = planDepositBuy({ ...base, directed: [], excluded: new Set(['BBB']) });
    // BBB's 30% ($900) stays in cash. Pushing it into AAA and CCC would buy
    // past their targets to dodge a guard that lapses in weeks, creating real
    // drift — and a taxable sell to unwind it. The money waits instead.
    expect(p.residualCashUsd).toBeCloseTo(900, 0);
    expect(p.orders.every(o => o.symbol !== 'BBB')).toBe(true);
  });

  it('is unchanged when nothing is excluded', () => {
    const withNone = planDepositBuy({ ...base, directed: [] });
    const withEmpty = planDepositBuy({ ...base, directed: [], excluded: new Set() });
    expect(withEmpty.orders).toEqual(withNone.orders);
  });
});

describe('planDepositBuy under risk de-scaling', () => {
  // The strategist passes `targetWeights * exposureMultiplier * ddMultiplier`.
  // In a drawdown, or with vol targeting on, those sum to LESS than 100 — the
  // shortfall IS the de-risking, held as cash on purpose. Demanding exactly
  // 100 here would throw inside the agent precisely when the fund is already
  // in a drawdown, which is the worst possible moment to lose the strategist.
  const prices = new Map([['AAA', 100], ['BBB', 100]]);
  const base = {
    holdings: new Map<string, number>([['AAA', 0], ['BBB', 0]]),
    prices,
    // NAV INCLUDES cash — it is net liquidation, not invested value. Passing
    // nav without it makes every deficit zero and the plan silently empty.
    nav: 10000,
    cash: 10000,
    depositUsd: 0,
    reserveUsd: 0,
    directed: [] as string[],
  };

  it('accepts de-scaled targets and leaves the shortfall in cash', () => {
    const p = planDepositBuy({ ...base, targets: { AAA: 45, BBB: 45 } });
    expect(p.deployedUsd).toBeCloseTo(9000, 0);
    expect(p.residualCashUsd).toBeCloseTo(1000, 0);
  });

  it('still deploys everything when targets sum to 100', () => {
    const p = planDepositBuy({ ...base, targets: { AAA: 50, BBB: 50 } });
    expect(p.deployedUsd).toBeCloseTo(10000, 0);
  });

  it('rejects targets that over-allocate', () => {
    // Above 100 is not de-risking, it is a broken model, and it would size
    // buys against money that does not exist.
    expect(() => planDepositBuy({ ...base, targets: { AAA: 60, BBB: 50 } }))
      .toThrow(/110/);
  });

  it('rejects targets that sum to nothing', () => {
    expect(() => planDepositBuy({ ...base, targets: { AAA: 0, BBB: 0 } })).toThrow();
  });
});
