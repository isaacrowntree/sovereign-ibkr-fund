import { describe, it, expect } from 'vitest';
import { planLedgerMigration, applyPatch, estimateCommissionUsd, type LedgerRow, type MigrationInput } from './migration';
import type { PaHistory, PaTrade } from '../connection/ibkr-history';
import type { TradeRecord } from '../state/store';

// Synthetic contracts, dates, prices and rates. Nothing here is a real holding.
const C = 900001;
const SYM = 'FAKE';

const pa = (date: string, action: 'BUY' | 'SELL', qty: number, price: number, fx = 1.5): PaTrade => ({
  conid: C, date, rawDate: date.replace(/-/g, ''), action, qty, price, currency: 'USD', audPerUnit: fx, description: 'FAKE CO',
});
const hist = (...trades: PaTrade[]): Map<number, PaHistory> => new Map([[C, { trades, dividends: [], other: [] }]]);
const row = (id: number, over: Partial<TradeRecord>): LedgerRow => ({
  id,
  trade: {
    timestamp: '2026-07-06T14:00:00.000Z', symbol: SYM, action: 'SELL', qty: 5, estimatedValue: 0, fillPrice: 50,
    orderId: 10 + id, status: 'filled', reason: 'rebalance', commission: 1, ...over,
  },
});
const base = (over: Partial<MigrationInput>): MigrationInput => ({
  ledger: [],
  positions: [],
  history: new Map(),
  symbolByConid: new Map([[C, SYM]]),
  ...over,
});

/** The ledger as it would stand after writing `plan` — for idempotency checks. */
function applied(input: MigrationInput, plan: ReturnType<typeof planLedgerMigration>): LedgerRow[] {
  const patched = input.ledger.map((r) => ({ id: r.id, trade: applyPatch(r.trade, plan.patches.find((p) => p.id === r.id)) }));
  let id = Math.max(0, ...input.ledger.map((r) => r.id));
  return [...patched, ...plan.opening.map((t) => ({ id: ++id, trade: t }))];
}

describe('planLedgerMigration — opening lots', () => {
  it('seeds a single pre-ledger purchase, brokerage from IBKR avgCost', () => {
    const plan = planLedgerMigration(base({
      history: hist(pa('2023-09-28', 'BUY', 50, 40)),
      positions: [{ symbol: SYM, conid: C, qty: 50, avgCost: 40.02 }],
    }));
    expect(plan.ok).toBe(true);
    expect(plan.opening).toHaveLength(1);
    const o = plan.opening[0];
    expect(o).toMatchObject({
      source: 'opening', symbol: SYM, action: 'BUY', qty: 50, fillPrice: 40, tradeDate: '2023-09-28',
      audPerUsd: 1.5, fxSource: 'ibkr', commissionEstimated: true, openingKey: `${C}:20230928:50:40`,
    });
    expect(o.commission).toBeCloseTo(1, 9);
  });

  it('falls back to max(1, 0.005·qty) when the position is more than one lot', () => {
    const plan = planLedgerMigration(base({
      history: hist(pa('2023-01-03', 'BUY', 400, 10), pa('2024-01-03', 'BUY', 100, 12)),
      positions: [{ symbol: SYM, conid: C, qty: 500, avgCost: 10.5 }],
    }));
    expect(plan.opening.map((t) => t.commission)).toEqual([2, 1]);
    expect(estimateCommissionUsd(50)).toBe(1);
  });

  it('writes pre-ledger buys and gives the ledger\'s own sale IBKR\'s date and rate', () => {
    const input = base({
      ledger: [row(1, { action: 'SELL', qty: 5, fillPrice: 50, timestamp: '2026-07-07T02:00:00.000Z' })],
      history: hist(pa('2023-09-28', 'BUY', 10, 40), pa('2024-05-01', 'BUY', 5, 45), pa('2026-07-06', 'SELL', 5, 50, 1.45)),
      positions: [{ symbol: SYM, conid: C, qty: 10, avgCost: 42 }],
    });
    const plan = planLedgerMigration(input);
    expect(plan.ok).toBe(true);
    expect(plan.opening.map((t) => [t.tradeDate, t.qty])).toEqual([['2023-09-28', 10], ['2024-05-01', 5]]);
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].set).toMatchObject({ tradeDate: '2026-07-06', audPerUsd: 1.45, fxSource: 'ibkr', conid: C });
    expect(plan.positions).toEqual([{ symbol: SYM, ledgerBefore: -5, ledgerAfter: 10, broker: 10 }]);
  });

  it('is idempotent: re-planning the migrated ledger writes and patches nothing', () => {
    const input = base({
      ledger: [row(1, { action: 'SELL', qty: 5 })],
      history: hist(pa('2023-09-28', 'BUY', 10, 40), pa('2026-07-06', 'SELL', 5, 50)),
      positions: [{ symbol: SYM, conid: C, qty: 5, avgCost: 40 }],
    });
    const first = planLedgerMigration(input);
    expect(first.ok).toBe(true);
    const second = planLedgerMigration({ ...input, ledger: applied(input, first) });
    expect(second.ok).toBe(true);
    expect(second.opening).toEqual([]);
    expect(second.patches).toEqual([]);
  });
});

describe('planLedgerMigration — matching the ledger to IBKR', () => {
  it('matches split partials in the ledger to one IBKR row (and the reverse)', () => {
    const plan = planLedgerMigration(base({
      ledger: [
        row(1, { action: 'BUY', qty: 30, execId: 'E1', timestamp: '2026-08-03T14:00:00Z' }),
        row(2, { action: 'BUY', qty: 70, execId: 'E2', timestamp: '2026-08-03T14:00:01Z' }),
        row(3, { action: 'BUY', qty: 100, orderId: 99, timestamp: '2026-08-10T14:00:00Z' }),
      ],
      history: hist(pa('2026-08-03', 'BUY', 100, 50), pa('2026-08-10', 'BUY', 40, 50), pa('2026-08-10', 'BUY', 60, 50)),
      positions: [{ symbol: SYM, conid: C, qty: 200, avgCost: 50 }],
    }));
    expect(plan.ok).toBe(true);
    expect(plan.opening).toEqual([]);
    expect(plan.unmatchedLedger).toEqual([]);
    expect(plan.patches.map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('corrects the price and date of a recovered orphan that was inferred from avgCost', () => {
    const plan = planLedgerMigration(base({
      ledger: [
        row(1, { action: 'BUY', qty: 10, fillPrice: 40, timestamp: '2026-01-05T15:00:00Z' }),
        row(2, { action: 'BUY', qty: 4, fillPrice: 44.4, priceInferred: true, source: 'recovered', orderId: 0,
          timestamp: '2026-01-09T01:00:00Z' }),
      ],
      history: hist(pa('2026-01-05', 'BUY', 10, 40), pa('2026-01-07', 'BUY', 4, 51.2)),
      positions: [{ symbol: SYM, conid: C, qty: 14, avgCost: 43.2 }],
    }));
    const p = plan.patches.find((x) => x.id === 2)!;
    expect(p.set).toMatchObject({ fillPrice: 51.2, tradeDate: '2026-01-07' });
    expect(p.unset).toEqual(['priceInferred']);
  });

  it('backfills brokerage from executions where IBKR still has them, else estimates and flags', () => {
    const plan = planLedgerMigration(base({
      ledger: [
        row(1, { action: 'BUY', qty: 10, commission: undefined, orderId: 7, timestamp: '2026-09-01T14:00:00Z' }),
        row(2, { action: 'BUY', qty: 300, commission: undefined, orderId: 8, timestamp: '2026-09-02T14:00:00Z' }),
      ],
      history: hist(pa('2026-09-01', 'BUY', 10, 50), pa('2026-09-02', 'BUY', 300, 50)),
      positions: [{ symbol: SYM, conid: C, qty: 310, avgCost: 50 }],
      executions: [
        { execId: 'X1', symbol: SYM, action: 'BUY', qty: 4, price: 50, time: '', orderId: 7, commission: 0.5 },
        { execId: 'X2', symbol: SYM, action: 'BUY', qty: 6, price: 50, time: '', orderId: 7, commission: 0.6 },
      ],
    }));
    expect(plan.patches[0].set).toMatchObject({ commission: 1.1 });
    expect(plan.patches[0].set.commissionEstimated).toBeUndefined();
    expect(plan.patches[1].set).toMatchObject({ commission: 1.5, commissionEstimated: true });
  });
});

describe('planLedgerMigration — refuses', () => {
  it('when the result would not match IBKR positions', () => {
    const plan = planLedgerMigration(base({
      history: hist(pa('2023-09-28', 'BUY', 10, 40)),
      positions: [{ symbol: SYM, conid: C, qty: 12, avgCost: 40 }],
    }));
    expect(plan.ok).toBe(false);
    expect(plan.refusals.join()).toMatch(/ledger would imply 10, IBKR holds 12/);
  });

  it('when IBKR has trades after the ledger began that it lacks — unless told to include them', () => {
    const input = base({
      ledger: [row(1, { action: 'BUY', qty: 5, timestamp: '2026-01-05T15:00:00Z' })],
      history: hist(pa('2026-01-05', 'BUY', 5, 50), pa('2026-02-05', 'BUY', 3, 50)),
      positions: [{ symbol: SYM, conid: C, qty: 8, avgCost: 50 }],
    });
    const refused = planLedgerMigration(input);
    expect(refused.ok).toBe(false);
    expect(refused.refusals.join()).toMatch(/after the ledger began/);
    const ok = planLedgerMigration({ ...input, includePostLedger: true });
    expect(ok.ok).toBe(true);
    expect(ok.postLedger[0]).toMatchObject({ source: 'reconciled', qty: 3, tradeDate: '2026-02-05' });
  });

  it('when a sale would still have no parcel (sold before any recorded purchase)', () => {
    const plan = planLedgerMigration(base({
      history: hist(pa('2023-01-03', 'SELL', 5, 40), pa('2023-02-03', 'BUY', 5, 40)),
      positions: [],
    }));
    expect(plan.ok).toBe(false);
    expect(plan.refusals.join()).toMatch(/no parcel/);
  });

  it('when a trade is not in USD', () => {
    const plan = planLedgerMigration(base({
      history: hist({ ...pa('2023-01-03', 'BUY', 5, 40), currency: 'AUD' }),
      positions: [{ symbol: SYM, conid: C, qty: 5 }],
    }));
    expect(plan.refusals.join()).toMatch(/only USD/);
  });
});
