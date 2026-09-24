/**
 * A fake bezant-server for exercising the operator scripts end to end.
 *
 * The scripts are plain `.mjs` files that import the BUILT dist and talk HTTP
 * to bezant. Unit tests cover the pure logic they call; this covers the part
 * that goes wrong in practice: the wiring, the transaction boundaries and the
 * refusal paths, against a broker that answers the way the real one does —
 * without ever touching the live gateway.
 *
 * Every figure served here is synthetic. Real ids, holdings and prices never
 * belong in this public repo.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakePosition {
  ticker: string;
  conid: number;
  position: number;
  avgCost: number;
  mktPrice?: number;
}

/** One row of `/pa/transactions`, as IBKR returns it (qty negative for a sell). */
export interface FakePaTxn {
  rawDate: string;
  type: 'Buy' | 'Sell' | 'Dividend Payment' | string;
  qty?: number;
  pr?: number;
  fxRate: number;
  cur?: string;
  amt?: number;
  desc?: string;
}

export interface FakeBezantState {
  accountId: string;
  authenticated: boolean;
  positions: FakePosition[];
  /** Raw `/iserver/account/trades` rows. */
  trades: Array<Record<string, unknown>>;
  /** `/pa/transactions` history per conid. */
  paTransactions: Record<number, FakePaTxn[]>;
  /** Symbol → conid for `/contracts/search`. */
  contracts: Record<string, number>;
  ledger?: Record<string, unknown>;
}

export interface FakeBezant {
  url: string;
  state: FakeBezantState;
  /** Every request seen, for asserting what a script asked for. */
  requests: Array<{ method: string; path: string; body?: unknown }>;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

export async function startFakeBezant(initial: Partial<FakeBezantState> = {}): Promise<FakeBezant> {
  const state: FakeBezantState = {
    accountId: 'UFAKE0001',
    authenticated: true,
    positions: [],
    trades: [],
    paTransactions: {},
    contracts: {},
    ...initial,
  };
  const requests: FakeBezant['requests'] = [];

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    requests.push({ method: req.method ?? 'GET', path: path + url.search, body });

    if (path === '/health') {
      return send(res, 200, { authenticated: state.authenticated, connected: true });
    }
    if (path === '/accounts') return send(res, 200, [{ accountId: state.accountId }]);
    const acct = path.match(/^\/accounts\/([^/]+)\/(summary|positions|ledger)$/);
    if (acct) {
      if (acct[2] === 'positions') return send(res, 200, state.positions);
      if (acct[2] === 'ledger') return send(res, 200, state.ledger ?? {});
      const nav = state.positions.reduce((s, p) => s + p.position * (p.mktPrice ?? p.avgCost), 0);
      return send(res, 200, { netliquidation: { amount: nav }, totalcashvalue: { amount: 0 } });
    }
    if (path === '/v1/api/iserver/account/trades') return send(res, 200, state.trades);
    if (path === '/contracts/search') {
      const sym = (url.searchParams.get('symbol') ?? '').toUpperCase();
      const conid = state.contracts[sym];
      return send(res, 200, conid ? [{ conid, symbol: sym, description: 'NASDAQ' }] : []);
    }
    if (path === '/v1/api/pa/transactions' && req.method === 'POST') {
      const b = (body ?? {}) as { conids?: Array<number | string>; currency?: string };
      const conid = Number(b.conids?.[0]);
      const rows = state.paTransactions[conid] ?? [];
      return send(res, 200, {
        id: 'getTransactions',
        currency: b.currency ?? 'USD',
        transactions: rows.map((t) => ({
          cur: t.cur ?? 'USD',
          acctid: state.accountId,
          conid,
          desc: t.desc ?? `FAKE ${conid}`,
          isRealTime: false,
          date: t.rawDate,
          ...t,
          // Requested in AUD: `amt` is the AUD value, sign as IBKR gives it.
          amt: t.amt ?? (t.qty != null && t.pr != null ? -t.qty * t.pr * t.fxRate : 0),
        })),
        rpnl: { data: [], amt: '0' },
      });
    }
    send(res, 404, { error: `fake bezant: no route ${req.method} ${path}` });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
