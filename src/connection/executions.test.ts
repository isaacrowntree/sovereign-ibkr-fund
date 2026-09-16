import { describe, it, expect } from 'vitest';
import { parseExecutions, parseTradeTime } from './gateway.js';

// Real CPAPI /trades rows from 2026-07-06: the TSLA sale plus the IDEALPRO FX
// auto-liquidation IBKR booked to settle it.
const ROWS = [
  {
    execution_id: '0000d5db.6d9d9fb8.01.01', symbol: 'AUD', side: 'S', size: 1.52,
    price: '0.69321', trade_time: '20260706-14:15:33', sec_type: 'CASH',
    contract_description_1: 'AUD.USD', order_id: 17833473331,
  },
  {
    execution_id: '00024966.6a4ba827.01.01', symbol: 'TSLA', side: 'S', size: 3.0,
    price: '403.88', trade_time: '20260706-14:15:33', sec_type: 'STK', order_id: 2068143282,
  },
  {
    execution_id: '00024966.6a4ba825.01.01', symbol: 'TSLA', side: 'S', size: 4.0,
    price: '403.88', trade_time: '20260706-14:15:33', sec_type: 'STK', order_id: 2068143282,
  },
];

describe('parseExecutions', () => {
  it('excludes non-equity (FX/CASH) lines like the AUD.USD auto-liquidation', () => {
    const execs = parseExecutions(ROWS as any);
    expect(execs.every(e => e.symbol !== 'AUD')).toBe(true);
    expect(execs).toHaveLength(2);
    expect(execs.map(e => e.symbol)).toEqual(['TSLA', 'TSLA']);
  });

  it('reads orderId from order_id (not order_ref) so fills can be matched to a placed order', () => {
    const execs = parseExecutions(ROWS as any);
    expect(execs.every(e => e.orderId === 2068143282)).toBe(true);
  });

  it('maps side/qty/price correctly', () => {
    const [first] = parseExecutions(ROWS as any);
    expect(first.action).toBe('SELL');
    expect(first.qty).toBe(3);
    expect(first.price).toBe(403.88);
    expect(first.execId).toBe('00024966.6a4ba827.01.01');
  });

  it('drops rows with no execId or zero qty', () => {
    const rows = [
      { symbol: 'NET', side: 'S', size: 5, price: '240', sec_type: 'STK', execution_id: '' },
      { symbol: 'NET', side: 'S', size: 0, price: '240', sec_type: 'STK', execution_id: 'X' },
    ];
    expect(parseExecutions(rows as any)).toHaveLength(0);
  });
});

describe('parseTradeTime', () => {
  // The real VST row from 2026-09-15: IBKR's own statement shows the fill at
  // 01:19:30 AEST = 15:19:30Z, and trade_time_r agrees to the second.
  it('prefers trade_time_r (epoch ms) and renders ISO UTC', () => {
    expect(parseTradeTime({ trade_time_r: 1789485571000, trade_time: '20260915-15:19:31' }))
      .toBe('2026-09-15T15:19:31.000Z');
  });

  it('parses CPAPI\'s YYYYMMDD-HH:MM:SS as UTC when trade_time_r is absent', () => {
    expect(parseTradeTime({ trade_time: '20260706-14:15:33' })).toBe('2026-07-06T14:15:33.000Z');
  });

  it('returns empty rather than a garbage date when neither is usable', () => {
    expect(parseTradeTime({})).toBe('');
    expect(parseTradeTime({ trade_time: 'yesterday', trade_time_r: 'n/a' })).toBe('');
  });

  it('gives reconcile an ISO day to key on — the raw form never matched the ledger', () => {
    const [e] = parseExecutions([ROWS[1]] as any);
    expect(e.time.slice(0, 10)).toBe('2026-07-06');
  });
});

describe('parseExecutions commission', () => {
  it('carries the commission IBKR reports, as a number', () => {
    const [e] = parseExecutions([{ ...ROWS[1], commission: '1.0' }] as any);
    expect(e.commission).toBe(1);
  });

  it('leaves commission undefined when the row has none, rather than inventing $0', () => {
    const [e] = parseExecutions([ROWS[1]] as any);
    expect(e.commission).toBeUndefined();
  });
});
