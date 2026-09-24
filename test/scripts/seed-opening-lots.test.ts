import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFakeBezant, type FakeBezant } from '../harness/fake-bezant';
import { buildScriptRoot, freshStateDir, type ScriptRoot } from '../harness/scripts';
import { putTrades, getTrades, putState, getState } from '../harness/ledger';

/**
 * scripts/seed-opening-lots.mjs end to end against a fake bezant. Synthetic
 * book: FAKE is held (two pre-ledger buys, one ledger sale), GONE was bought
 * before the ledger and sold by the bot, so it is ledgered but no longer held.
 */
let root: ScriptRoot;
let bezant: FakeBezant;

const FAKE = 900001;
const GONE = 900002;

function arrange(state: string) {
  putTrades(state, [
    { timestamp: '2026-07-06T14:00:00.000Z', symbol: 'FAKE', action: 'SELL', qty: 5, estimatedValue: 250,
      fillPrice: 50, orderId: 11, status: 'filled', reason: 'rebalance', commission: 1 },
    { timestamp: '2026-07-06T14:05:00.000Z', symbol: 'GONE', action: 'SELL', qty: 8, estimatedValue: 240,
      fillPrice: 30, orderId: 12, status: 'filled', reason: 'rebalance' },
  ]);
  // The pre-migration world: the accepted drift papers over the missing history.
  putState(state, { ledgerDriftBaseline: 'FAKE:15,GONE:8', ledgerDriftSignature: 'FAKE:15,GONE:8' });
}

beforeAll(async () => {
  root = buildScriptRoot();
  bezant = await startFakeBezant({
    positions: [{ ticker: 'FAKE', conid: FAKE, position: 10, avgCost: 42 }],
    contracts: { GONE },
    paTransactions: {
      [FAKE]: [
        { rawDate: '20230928', type: 'Buy', qty: 10, pr: 40, fxRate: 1.55 },
        { rawDate: '20240501', type: 'Buy', qty: 5, pr: 45, fxRate: 1.52 },
        { rawDate: '20260706', type: 'Sell', qty: -5, pr: 50, fxRate: 1.45 },
        { rawDate: '20260908', type: 'Dividend Payment', fxRate: 1.4, amt: 7 },
      ],
      [GONE]: [
        { rawDate: '20231002', type: 'Buy', qty: 8, pr: 25, fxRate: 1.56 },
        { rawDate: '20260706', type: 'Sell', qty: -8, pr: 30, fxRate: 1.45 },
      ],
    },
  });
}, 120_000);

afterAll(async () => {
  await bezant?.close();
  root?.cleanup();
});

const env = (state: string) => ({ STATE_DIR: state, BEZANT_URL: bezant.url, PA_DELAY_MS: '0' });

describe('seed-opening-lots.mjs', () => {
  it('--dry-run verifies against IBKR and writes nothing', async () => {
    const state = freshStateDir(root.root, 'dry');
    arrange(state);
    const r = await root.run('seed-opening-lots.mjs', ['--dry-run'], env(state));
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/Opening lots to write: 3/);
    expect(r.stdout).toMatch(/Verified/);
    expect(getTrades(state)).toHaveLength(2);
    expect(getState(state).ledgerDriftBaseline).toBe('FAKE:15,GONE:8');
  });

  it('writes opening lots, annotations and the zeroed baseline together; a re-run changes nothing', async () => {
    const state = freshStateDir(root.root, 'write');
    arrange(state);
    const r = await root.run('seed-opening-lots.mjs', [], env(state));
    expect(r.code, r.stderr + r.stdout).toBe(0);

    const trades = getTrades(state);
    expect(trades).toHaveLength(5);
    const opening = trades.filter((t) => t.source === 'opening');
    expect(opening.map((t) => `${t.symbol}:${t.tradeDate}:${t.qty}`).sort()).toEqual([
      'FAKE:2023-09-28:10', 'FAKE:2024-05-01:5', 'GONE:2023-10-02:8',
    ]);
    // The ledger's own sales now carry IBKR's date and rate; missing brokerage is estimated.
    expect(trades[0]).toMatchObject({ tradeDate: '2026-07-06', audPerUsd: 1.45, fxSource: 'ibkr', conid: FAKE });
    expect(trades[1]).toMatchObject({ audPerUsd: 1.45, commission: 1, commissionEstimated: true });

    const s = getState(state);
    expect(s.ledgerDriftBaseline).toBe('');
    expect(s.ledgerDriftSignature).toBe('');
    expect(s.ledgerMigratedAt).toBeTruthy();

    const again = await root.run('seed-opening-lots.mjs', [], env(state));
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/Opening lots to write: 0/);
    expect(again.stdout).toMatch(/Ledger rows to annotate: 0/);
    expect(getTrades(state)).toEqual(trades);
  });

  it('refuses, writing nothing, when the result would not match IBKR positions', async () => {
    const state = freshStateDir(root.root, 'mismatch');
    arrange(state);
    bezant.state.positions = [{ ticker: 'FAKE', conid: FAKE, position: 11, avgCost: 42 }];
    try {
      const r = await root.run('seed-opening-lots.mjs', [], env(state));
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/FAKE: ledger would imply 10, IBKR holds 11/);
      expect(getTrades(state)).toHaveLength(2);
      expect(getState(state).ledgerDriftBaseline).toBe('FAKE:15,GONE:8');
    } finally {
      bezant.state.positions = [{ ticker: 'FAKE', conid: FAKE, position: 10, avgCost: 42 }];
    }
  });

  it('refuses while an execution run holds the lock', async () => {
    const state = freshStateDir(root.root, 'locked');
    arrange(state);
    putState(state, { executionRunLock: { at: new Date().toISOString(), pid: 1, phase: 'place' } });
    const r = await root.run('seed-opening-lots.mjs', [], env(state));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/holds the lock/);
    expect(getTrades(state)).toHaveLength(2);
  });
});
