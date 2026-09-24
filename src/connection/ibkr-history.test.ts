import { describe, it, expect } from 'vitest';
import { parsePaTransactions, parseFxConversions } from './ibkr-history';

// Shaped like a real `/pa/transactions` response requested in AUD. All values synthetic.
const PA_BODY = {
  id: 'getTransactions', currency: 'AUD', nd: 1500, from: 0, to: 0,
  rpnl: { data: [], amt: '0' },
  transactions: [
    { cur: 'USD', date: 'Thu Sep 28 00:00:00 EDT 2023', rawDate: '20230928', fxRate: 1.55, pr: 40.5, qty: 20.0,
      acctid: 'UFAKE0001', amt: -1255.5, conid: 111, type: 'Buy', desc: 'FAKE CO', isRealTime: false },
    { cur: 'USD', date: 'Mon Jul 06 00:00:00 EDT 2026', rawDate: '20260706', fxRate: 1.45, pr: 50, qty: -5.0,
      acctid: 'UFAKE0001', amt: 362.5, conid: 111, type: 'Sell', desc: 'FAKE CO', isRealTime: false },
    { cur: 'USD', date: 'Tue Sep 08 00:00:00 EDT 2026', rawDate: '20260908', fxRate: 1.4, amt: 7.0,
      conid: 111, type: 'Dividend Payment', isRealTime: false },
    { cur: 'USD', rawDate: '20260909', fxRate: 1.4, conid: 111, type: 'Something New', amt: 1 },
  ],
};

describe('parsePaTransactions', () => {
  it('reads trades with positive quantities, sells signed by side, and IBKR\'s per-trade rate', () => {
    const h = parsePaTransactions(PA_BODY, 111);
    expect(h.trades).toEqual([
      { conid: 111, date: '2023-09-28', rawDate: '20230928', action: 'BUY', qty: 20, price: 40.5, currency: 'USD', audPerUnit: 1.55, description: 'FAKE CO' },
      { conid: 111, date: '2026-07-06', rawDate: '20260706', action: 'SELL', qty: 5, price: 50, currency: 'USD', audPerUnit: 1.45, description: 'FAKE CO' },
    ]);
  });

  it('reads dividends (amt is AUD) and keeps unknown row types rather than dropping them', () => {
    const h = parsePaTransactions(PA_BODY, 111);
    expect(h.dividends).toEqual([
      { conid: 111, date: '2026-09-08', currency: 'USD', audPerUnit: 1.4, amountAud: 7, amount: 5, description: '' },
    ]);
    expect(h.other).toHaveLength(1);
  });

  it('tolerates an empty or malformed body', () => {
    expect(parsePaTransactions(undefined)).toEqual({ trades: [], dividends: [], other: [] });
    expect(parsePaTransactions({ transactions: 'nope' })).toEqual({ trades: [], dividends: [], other: [] });
  });
});

describe('parseFxConversions', () => {
  it('keeps only CASH rows and reads the pair, side and amounts', () => {
    const fx = parseFxConversions([
      { execution_id: 'S1', symbol: 'FAKE', sec_type: 'STK', side: 'B', size: 1, price: 1 },
      { execution_id: 'F1', symbol: 'AUD.USD', sec_type: 'CASH', side: 'S', size: 1000, price: 0.65,
        trade_time_r: Date.parse('2026-09-01T02:00:00Z'), commission: '2' },
    ]);
    expect(fx).toEqual([{
      execId: 'F1', time: '2026-09-01T02:00:00.000Z', tradeDate: '2026-08-31', pair: 'AUD.USD', side: 'SELL',
      baseCurrency: 'AUD', quoteCurrency: 'USD', baseAmount: 1000, price: 0.65, quoteAmount: 650, commission: 2,
    }]);
  });
});
