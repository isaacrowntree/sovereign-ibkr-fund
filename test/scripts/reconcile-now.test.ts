import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFakeBezant, type FakeBezant } from '../harness/fake-bezant';
import { buildScriptRoot, freshStateDir, type ScriptRoot } from '../harness/scripts';
import { putTrades, getTrades } from '../harness/ledger';

/**
 * scripts/reconcile-now.mjs, end to end against a fake bezant.
 *
 * The regression: it kept its own execId-only matcher, which cannot see the
 * executor's per-order aggregate (no execId), so each partial of an already
 * recorded order was appended on top of it, and every backfill was stamped
 * with the time the script ran.
 */
let root: ScriptRoot;
let bezant: FakeBezant;

const exec = (id: string, orderId: number, size: number, price: number, iso: string, extra: Record<string, unknown> = {}) => ({
  execution_id: id, symbol: 'NET', side: 'B', size, price, sec_type: 'STK',
  order_id: orderId, trade_time_r: Date.parse(iso), ...extra,
});

beforeAll(async () => {
  root = buildScriptRoot();
  bezant = await startFakeBezant();
}, 120_000);

afterAll(async () => {
  await bezant?.close();
  root?.cleanup();
});

describe('reconcile-now.mjs', () => {
  it('does not re-append the partials of an order the executor already recorded', async () => {
    const state = freshStateDir(root.root, 'partials');
    putTrades(state, [{
      timestamp: '2026-09-01T14:00:05.000Z', symbol: 'NET', action: 'BUY', qty: 100,
      estimatedValue: 10000, fillPrice: 100, orderId: 7, status: 'filled', reason: 'rebalance',
    }]);
    bezant.state.trades = [
      exec('E1', 7, 30, 100, '2026-09-01T14:00:01Z'),
      exec('E2', 7, 30, 100, '2026-09-01T14:00:02Z'),
      exec('E3', 7, 40, 100, '2026-09-01T14:00:03Z'),
      // A genuinely missing fill, from a different order.
      exec('E9', 8, 5, 101.5, '2026-09-02T15:30:00Z', { commission: '1.00' }),
    ];

    const r = await root.run('reconcile-now.mjs', [], { STATE_DIR: state, BEZANT_URL: bezant.url });
    expect(r.code, r.stderr).toBe(0);

    const trades = getTrades(state);
    expect(trades).toHaveLength(2);
    const added = trades[1];
    expect(added.execId).toBe('E9');
    expect(added.qty).toBe(5);
    // IBKR's execution time, not the moment the script ran.
    expect(added.timestamp).toBe('2026-09-02T15:30:00.000Z');
  });

  it('is idempotent: a second run appends nothing', async () => {
    const state = freshStateDir(root.root, 'twice');
    bezant.state.trades = [exec('E1', 11, 10, 50, '2026-09-03T14:00:00Z')];
    const env = { STATE_DIR: state, BEZANT_URL: bezant.url };
    expect((await root.run('reconcile-now.mjs', [], env)).code).toBe(0);
    expect((await root.run('reconcile-now.mjs', [], env)).code).toBe(0);
    expect(getTrades(state)).toHaveLength(1);
  });
});
