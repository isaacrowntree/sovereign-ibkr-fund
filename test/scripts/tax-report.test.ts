import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFakeBezant, type FakeBezant } from '../harness/fake-bezant';
import { buildScriptRoot, freshStateDir, type ScriptRoot } from '../harness/scripts';
import { putTrades } from '../harness/ledger';

let root: ScriptRoot;
let bezant: FakeBezant;
const FAKE = 900001;

beforeAll(async () => {
  root = buildScriptRoot();
  bezant = await startFakeBezant({
    positions: [{ ticker: 'FAKE', conid: FAKE, position: 5, avgCost: 40 }],
    paTransactions: {
      [FAKE]: [
        { rawDate: '20260908', type: 'Dividend Payment', fxRate: 1.4, amt: 7 },
        { rawDate: '20250908', type: 'Dividend Payment', fxRate: 1.5, amt: 9 }, // previous FY
      ],
    },
  });
}, 120_000);

afterAll(async () => {
  await bezant?.close();
  root?.cleanup();
});

describe('tax-report.mjs', () => {
  it('reports an annotated ledger in AUD for the beneficial owner, with dividends fetched from IBKR', async () => {
    const state = freshStateDir(root.root, 'report');
    putTrades(state, [
      { timestamp: '2023-09-28T20:00:00.000Z', tradeDate: '2023-09-28', symbol: 'FAKE', action: 'BUY', qty: 10,
        estimatedValue: 400, fillPrice: 40, orderId: 0, status: 'filled', reason: 'opening', source: 'opening',
        conid: FAKE, audPerUsd: 1.5, fxSource: 'ibkr', commission: 1, commissionEstimated: true },
      { timestamp: '2026-07-06T14:00:00.000Z', tradeDate: '2026-07-06', symbol: 'FAKE', action: 'SELL', qty: 5,
        estimatedValue: 250, fillPrice: 50, orderId: 11, status: 'filled', reason: 'rebalance', conid: FAKE,
        audPerUsd: 1.4, fxSource: 'ibkr', commission: 1 },
    ]);
    const env = {
      STATE_DIR: state, BEZANT_URL: bezant.url, PA_DELAY_MS: '0',
      TAX_OWNER_SHARES: 'Owner A:100', TAX_ACCOUNT_REGISTRATION: 'joint',
    };

    const text = await root.run('tax-report.mjs', ['--fy', 'FY2027'], env);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/joint names but held beneficially by one owner, Owner A \(100%\)/);
    expect(text.stdout).toMatch(/indicative — combine with your other CGT events/);

    const json = await root.run('tax-report.mjs', ['--fy', 'FY2027', '--json', '--carried-forward', 'Owner A=10'], env);
    expect(json.code, json.stderr).toBe(0);
    const r = JSON.parse(json.stdout);
    // Proceeds (250 - 1) * 1.4 = 348.6 ; cost (5*40 + 0.5) * 1.5 = 300.75 ; discountable
    expect(r.totals.discountGains).toBeCloseTo(47.85, 2);
    expect(r.owners[0].net.netCapitalGain).toBeCloseTo((47.85 - 10) / 2, 2);
    expect(r.dividends).toHaveLength(1);
    expect(r.owners[0].dividends.grossAud).toBe(7);
    expect(r.owners[0].dividends.foreignIncomeTaxOffsetAud).toBe(1.05);
  });

  it('exits 3 and says INCOMPLETE when a trade has no AUD rate', async () => {
    const state = freshStateDir(root.root, 'incomplete');
    putTrades(state, [
      { timestamp: '2023-09-28T20:00:00.000Z', symbol: 'FAKE', action: 'BUY', qty: 1, estimatedValue: 40, fillPrice: 40,
        orderId: 0, status: 'filled', reason: 'x' },
      { timestamp: '2026-07-06T14:00:00.000Z', symbol: 'FAKE', action: 'SELL', qty: 1, estimatedValue: 50, fillPrice: 50,
        orderId: 1, status: 'filled', reason: 'x' },
    ]);
    const r = await root.run('tax-report.mjs', ['--fy', 'FY2027', '--no-dividends'], { STATE_DIR: state });
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/INCOMPLETE/);
  });
});
