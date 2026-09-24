/**
 * Foreign dividends: assessable income, with the US tax withheld at source
 * claimable as a foreign income tax offset (FITO, Division 770).
 *
 * The source is IBKR's `/pa/transactions` "Dividend Payment" rows, asked for
 * in AUD, which give the payment converted at IBKR's rate on the payment date.
 * That feed does NOT carry the withholding line. Under the US-Australia treaty
 * (with a W-8BEN on file) US withholding on dividends is 15%, so where the
 * withholding is not known it is ESTIMATED at that rate from the gross and
 * flagged — the broker statement's figure wins wherever the two differ.
 *
 * The payment rows are treated as GROSS (before withholding). If an IBKR
 * statement shows the feed is net, pass `amountsAreNet` and gross is grossed up.
 */
import type { PaDividend } from '../connection/ibkr-history.js';
import { financialYearOf, type IsoDate } from './au-dates.js';

export const US_TREATY_WITHHOLDING = 0.15;

export interface DividendRecord {
  conid: number;
  symbol?: string;
  payDate: IsoDate;
  financialYear: string;
  currency: string;
  /** AUD per 1 unit of `currency` on the payment date (IBKR's rate). */
  audPerUnit: number;
  gross: number;
  withholding: number;
  net: number;
  grossAud: number;
  withholdingAud: number;
  netAud: number;
  withholdingEstimated: boolean;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function dividendsFromPa(
  rows: PaDividend[],
  opts: { symbols?: Map<number, string>; withholdingRate?: number; amountsAreNet?: boolean } = {},
): DividendRecord[] {
  const rate = opts.withholdingRate ?? US_TREATY_WITHHOLDING;
  return rows
    .map((d) => {
      const gross = opts.amountsAreNet ? d.amount / (1 - rate) : d.amount;
      const withholding = d.currency === 'USD' ? gross * rate : 0;
      const net = gross - withholding;
      return {
        conid: d.conid,
        symbol: opts.symbols?.get(d.conid),
        payDate: d.date,
        financialYear: financialYearOf(d.date),
        currency: d.currency,
        audPerUnit: d.audPerUnit,
        gross: r2(gross),
        withholding: r2(withholding),
        net: r2(net),
        grossAud: r2(gross * d.audPerUnit),
        withholdingAud: r2(withholding * d.audPerUnit),
        netAud: r2(net * d.audPerUnit),
        withholdingEstimated: withholding > 0,
      };
    })
    .sort((a, b) => a.payDate.localeCompare(b.payDate) || a.conid - b.conid);
}
