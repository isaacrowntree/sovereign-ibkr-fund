/**
 * IBKR account history beyond the current session.
 *
 * `/iserver/account/trades` forgets anything older than a few days, so it
 * cannot seed the ledger or date a dividend. The Portfolio Analyst endpoint
 * `POST /pa/transactions` returns the whole history of one contract (back to
 * account opening with `days: 2000`), and — asked for in AUD — carries IBKR's
 * own per-trade FX rate, the same figure the broker statements use. It has no
 * commission, and it answers one conid per call, so calls are spaced out.
 *
 * Also parses the FX conversions (`sec_type: CASH`, e.g. `AUD.USD`) that
 * `parseExecutions` deliberately excludes from the equity ledger, so the
 * Division 775 export can list them.
 */
import { bezantFetch, resolveAccountId } from './gateway.js';
import { exchangeTradeDate, type IsoDate } from '../tax/au-dates.js';

/** A Buy/Sell row from `/pa/transactions`. */
export interface PaTrade {
  conid: number;
  date: IsoDate;
  /** IBKR's compact date, as given. */
  rawDate: string;
  action: 'BUY' | 'SELL';
  /** Always positive; IBKR signs sells negative. */
  qty: number;
  price: number;
  /** Trade currency (USD for US shares). */
  currency: string;
  /** AUD per 1 unit of `currency` on that date — IBKR's `fxRate`. */
  audPerUnit: number;
  description: string;
}

/** A "Dividend Payment" row. `amountAud` is IBKR's `amt` in the requested (AUD) currency. */
export interface PaDividend {
  conid: number;
  date: IsoDate;
  currency: string;
  audPerUnit: number;
  amountAud: number;
  /** amountAud / audPerUnit — the payment in its own currency. */
  amount: number;
  description: string;
}

export interface PaHistory {
  trades: PaTrade[];
  dividends: PaDividend[];
  /** Rows of any other type, kept so nothing is silently dropped. */
  other: Array<Record<string, unknown>>;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

/**
 * Pure parse of a `/pa/transactions` response body (requested in AUD).
 * `conid` is the one asked for; IBKR echoes it per row, which wins if present.
 */
export function parsePaTransactions(body: unknown, conid?: number): PaHistory {
  const out: PaHistory = { trades: [], dividends: [], other: [] };
  const rows = (body as { transactions?: unknown })?.transactions;
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Array<Record<string, unknown>>) {
    const type = String(r.type ?? '');
    const date = exchangeTradeDate(String(r.rawDate ?? ''));
    const id = Number.isFinite(num(r.conid)) ? num(r.conid) : (conid ?? NaN);
    const fx = num(r.fxRate);
    if (!date || !Number.isFinite(id) || !(fx > 0)) {
      out.other.push(r);
      continue;
    }
    if (type === 'Buy' || type === 'Sell') {
      const qty = num(r.qty);
      const price = num(r.pr);
      if (!Number.isFinite(qty) || qty === 0 || !(price > 0)) {
        out.other.push(r);
        continue;
      }
      out.trades.push({
        conid: id,
        date,
        rawDate: String(r.rawDate),
        action: qty > 0 ? 'BUY' : 'SELL',
        qty: Math.abs(qty),
        price,
        currency: String(r.cur ?? 'USD'),
        audPerUnit: fx,
        description: String(r.desc ?? ''),
      });
    } else if (/dividend/i.test(type)) {
      const amountAud = num(r.amt);
      if (!Number.isFinite(amountAud)) {
        out.other.push(r);
        continue;
      }
      out.dividends.push({
        conid: id,
        date,
        currency: String(r.cur ?? 'USD'),
        audPerUnit: fx,
        amountAud,
        amount: amountAud / fx,
        description: String(r.desc ?? ''),
      });
    } else {
      out.other.push(r);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Full history of each conid, one call at a time, `delayMs` apart (IBKR
 * throttles this endpoint). Throws on the first failed call: a partial
 * history is worse than none for seeding a tax ledger.
 */
export async function fetchPaHistory(
  conids: number[],
  opts: { days?: number; delayMs?: number } = {},
): Promise<Map<number, PaHistory>> {
  const accountId = await resolveAccountId();
  const out = new Map<number, PaHistory>();
  const delay = opts.delayMs ?? 1000;
  for (let i = 0; i < conids.length; i++) {
    if (i > 0 && delay > 0) await sleep(delay);
    const conid = conids[i];
    const body = await bezantFetch<unknown>('/v1/api/pa/transactions', {
      method: 'POST',
      body: JSON.stringify({ acctIds: [accountId], conids: [conid], currency: 'AUD', days: opts.days ?? 2000 }),
    });
    out.set(conid, parsePaTransactions(body, conid));
  }
  return out;
}

/** One currency conversion, as IBKR executed it. */
export interface FxConversion {
  execId: string;
  /** ISO time of the execution. */
  time: string;
  tradeDate: IsoDate;
  /** e.g. "AUD.USD": base.quote. */
  pair: string;
  /** Side on the BASE currency: SELL AUD.USD = AUD sold for USD. */
  side: 'BUY' | 'SELL';
  baseCurrency: string;
  quoteCurrency: string;
  /** Base-currency amount. */
  baseAmount: number;
  /** Quote per 1 base. */
  price: number;
  /** Quote-currency amount (baseAmount × price). */
  quoteAmount: number;
  commission?: number;
}

/** Pure parse of the CASH rows of `/iserver/account/trades`. Exported for tests. */
export function parseFxConversions(rows: Array<Record<string, unknown>>): FxConversion[] {
  const out: FxConversion[] = [];
  for (const t of rows) {
    if (String(t.sec_type ?? '').toUpperCase() !== 'CASH') continue;
    const pair = String(t.symbol ?? t.ticker ?? t.contract_description_1 ?? '').toUpperCase().replace(/\s+/g, '');
    const [base, quote] = pair.split('.');
    const execId = String(t.execution_id ?? t.execid ?? t.exec_id ?? '');
    const baseAmount = Math.abs(num(t.size ?? t.quantity));
    const price = num(t.price);
    if (!execId || !base || !quote || !(baseAmount > 0) || !(price > 0)) continue;
    const ms = Number(t.trade_time_r);
    let time = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
    if (!time) {
      const m = String(t.trade_time ?? '').match(/^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})$/);
      if (m) time = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
    }
    const side = String(t.side ?? '').toUpperCase();
    const commission = t.commission != null && Number.isFinite(num(t.commission)) ? Math.abs(num(t.commission)) : undefined;
    out.push({
      execId,
      time,
      tradeDate: exchangeTradeDate(time) ?? '',
      pair,
      side: side === 'S' || side === 'SELL' ? 'SELL' : 'BUY',
      baseCurrency: base,
      quoteCurrency: quote,
      baseAmount,
      price,
      quoteAmount: baseAmount * price,
      ...(commission != null ? { commission } : {}),
    });
  }
  return out;
}

/** FX conversions IBKR still reports for this session. */
export async function getFxConversions(): Promise<FxConversion[]> {
  const raw = await bezantFetch<Array<Record<string, unknown>>>('/v1/api/iserver/account/trades');
  return parseFxConversions(Array.isArray(raw) ? raw : []);
}
