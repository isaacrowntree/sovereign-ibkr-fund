import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  placeMarketOrder,
  placeAdaptiveOrder,
  parseExecutions,
  findOrderByRef,
  GatewayError,
  evaluateReply,
  replyPolicy,
  OrderNotPlacedError,
} from './gateway.js';

/**
 * A fake CPAPI order endpoint behind bezant: POST /accounts/{id}/orders
 * answers with a scripted chain of confirmation prompts, each answered via
 * POST /v1/api/iserver/reply/{id}, ending in an order_id. Records every
 * request so a test can assert what was (and was not) confirmed.
 */
interface Prompt { messageIds?: string[]; message?: string[] }

function fakeCpapi(opts: { prompts?: Prompt[]; final?: Record<string, unknown> } = {}) {
  const prompts = opts.prompts ?? [];
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  let step = 0;
  const promptAt = (i: number) => [{ id: `reply-${i}`, ...prompts[i] }];
  const final = () => [opts.final ?? { order_id: '987654', order_status: 'Submitted' }];

  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let body: unknown;
    if (url.endsWith('/accounts')) body = [{ accountId: 'U0000000' }];
    else if (url.includes('/contracts/search')) body = [{ symbol: 'ABC', conid: 4242, description: 'NASDAQ' }];
    else if (method === 'POST' && /\/accounts\/[^/]+\/orders$/.test(url)) {
      body = prompts.length ? promptAt(0) : final();
    } else if (method === 'POST' && url.includes('/iserver/reply/')) {
      step += 1;
      body = step < prompts.length ? promptAt(step) : final();
    } else throw new Error(`unexpected ${method} ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { fetchFn, requests, replied: () => requests.filter(r => r.url.includes('/iserver/reply/')).map(r => r.url.split('/').pop()) };
}

const MKT_CONFIRM: Prompt = { messageIds: ['o10151'], message: ['<b>You are submitting an order without market data.</b>'] };
const SIZE_CAP: Prompt = { messageIds: ['o10153'], message: ['Order value exceeds the size limit'] };
const RESTRICTED: Prompt = { messageIds: ['o163'], message: ['The following order exceeds the price percentage limit'] };

let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => { savedEnv = { ...process.env }; });
afterEach(() => { process.env = savedEnv; vi.restoreAllMocks(); });

describe('evaluateReply — the allowlist', () => {
  it('allows only the allowlisted ids', () => {
    expect(evaluateReply(['o10151'], {})).toBeNull();
    expect(evaluateReply(['o10151', 'o10153'], {})).toBeNull();
  });

  it('deny wins, even next to an allowed id', () => {
    for (const id of ['o354', 'o383', 'o451', 'o163', 'o403', 'o2137']) {
      expect(evaluateReply(['o10151', id], {})).toMatch(/denied/);
    }
  });

  it('an unknown or missing id is refused', () => {
    expect(evaluateReply(['o999'], {})).toMatch(/unknown/);
    expect(evaluateReply([], {})).toMatch(/no messageIds/);
  });

  it('REPLY_ALLOW_IDS adds ids, but cannot un-deny one', () => {
    expect(evaluateReply(['o999'], { REPLY_ALLOW_IDS: 'o999, o888' })).toBeNull();
    expect(evaluateReply(['o163'], { REPLY_ALLOW_IDS: 'o163' })).toMatch(/denied/);
  });

  it('REPLY_POLICY defaults to log; only "enforce" enforces', () => {
    expect(replyPolicy({})).toBe('log');
    expect(replyPolicy({ REPLY_POLICY: 'ENFORCE' })).toBe('enforce');
    expect(replyPolicy({ REPLY_POLICY: 'yes' })).toBe('log');
  });
});

describe('submitOrder — confirmation prompts', () => {
  it('log mode confirms everything as before, and records ids, text and the would-be verdict', async () => {
    const f = fakeCpapi({ prompts: [MKT_CONFIRM, RESTRICTED] });
    globalThis.fetch = f.fetchFn as unknown as typeof fetch;
    const r = await placeMarketOrder('ABC', 'BUY', 1);
    expect(r.orderId).toBe(987654);
    expect(f.replied()).toEqual(['reply-0', 'reply-1']);
    expect(r.replies).toHaveLength(2);
    expect(r.replies![0]).toMatchObject({
      messageIds: ['o10151'], text: 'You are submitting an order without market data.', refusal: null, decision: 'confirmed',
    });
    expect(r.replies![1]).toMatchObject({ messageIds: ['o163'], decision: 'confirmed' });
    expect(r.replies![1].refusal).toMatch(/denied/);
  });

  it('enforce mode confirms allowlisted prompts', async () => {
    process.env.REPLY_POLICY = 'enforce';
    const f = fakeCpapi({ prompts: [MKT_CONFIRM, SIZE_CAP] });
    globalThis.fetch = f.fetchFn as unknown as typeof fetch;
    const r = await placeMarketOrder('ABC', 'BUY', 1);
    expect(r.orderId).toBe(987654);
    expect(f.replied()).toEqual(['reply-0', 'reply-1']);
  });

  it('enforce mode does not confirm a denied prompt: the order is not placed', async () => {
    process.env.REPLY_POLICY = 'enforce';
    const f = fakeCpapi({ prompts: [MKT_CONFIRM, RESTRICTED] });
    globalThis.fetch = f.fetchFn as unknown as typeof fetch;
    const err = await placeMarketOrder('ABC', 'BUY', 1).catch(e => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(err.notPlaced).toBe(true);
    expect(err.replies.map((x: { decision: string }) => x.decision)).toEqual(['confirmed', 'refused']);
    // The first (allowed) prompt was answered; the denied one never was.
    expect(f.replied()).toEqual(['reply-0']);
  });

  it('enforce mode refuses a prompt with no ids at all', async () => {
    process.env.REPLY_POLICY = 'enforce';
    const f = fakeCpapi({ prompts: [{ message: ['Something new'] }] });
    globalThis.fetch = f.fetchFn as unknown as typeof fetch;
    await expect(placeMarketOrder('ABC', 'BUY', 1)).rejects.toMatchObject({ notPlaced: true });
    expect(f.replied()).toEqual([]);
  });

  it('an order with no prompts carries no replies', async () => {
    const f = fakeCpapi();
    globalThis.fetch = f.fetchFn as unknown as typeof fetch;
    const r = await placeMarketOrder('ABC', 'SELL', 2);
    expect(r.replies).toBeUndefined();
  });
});

describe('submitOrder — fail closed on the answer', () => {
  it('an answer without a usable order id throws (ambiguous) instead of returning order 0', async () => {
    for (const final of [{ order_status: 'Submitted' }, { order_id: 'abc', order_status: 'Submitted' }]) {
      const f = fakeCpapi({ final });
      globalThis.fetch = f.fetchFn as unknown as typeof fetch;
      const err = await placeMarketOrder('ABC', 'BUY', 1).catch(e => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect(err.message).toMatch(/without an order id/);
      expect(err.rejected).toBeUndefined();
      expect(err.notPlaced).toBeUndefined();
    }
  });

  it('an explicit rejection is marked rejected', async () => {
    const f = fakeCpapi({ final: { error: 'Insufficient funds' } });
    globalThis.fetch = f.fetchFn as unknown as typeof fetch;
    await expect(placeMarketOrder('ABC', 'BUY', 1)).rejects.toMatchObject({ rejected: true });
  });

  it('a missing status is "unknown", not an assumed "Submitted"', async () => {
    const f = fakeCpapi({ final: { order_id: 55 } });
    globalThis.fetch = f.fetchFn as unknown as typeof fetch;
    expect((await placeMarketOrder('ABC', 'BUY', 1)).status).toBe('unknown');
  });
});

describe('cOID', () => {
  it('rides on the order body when given, and is absent otherwise', async () => {
    const f = fakeCpapi();
    globalThis.fetch = f.fetchFn as unknown as typeof fetch;
    await placeAdaptiveOrder('ABC', 'SELL', 3, 'Patient', { cOID: 'r1-ABC-SELL-1' });
    await placeMarketOrder('ABC', 'SELL', 3);
    const posts = f.requests.filter(r => r.method === 'POST' && /\/orders$/.test(r.url));
    expect((posts[0].body as { orders: Array<Record<string, unknown>> }).orders[0]).toMatchObject({
      cOID: 'r1-ABC-SELL-1', algoStrategy: 'Adaptive',
    });
    expect((posts[1].body as { orders: Array<Record<string, unknown>> }).orders[0].cOID).toBeUndefined();
  });

  it('order_ref is read as the cOID string, never Number()ed into NaN', () => {
    const [e] = parseExecutions([
      { execution_id: 'x1', symbol: 'ABC', side: 'B', size: 1, price: 10, sec_type: 'STK', order_ref: 'r1-ABC-BUY-1' },
    ]);
    expect(e.orderId).toBeUndefined();
    expect(e.orderRef).toBe('r1-ABC-BUY-1');
  });
});

describe('findOrderByRef', () => {
  /** Scripted feeds: each poll pops the next orders page / trades page. */
  function feeds(pages: { orders: Array<Array<Record<string, unknown>>>; trades: Array<Array<Record<string, unknown>>> }) {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      let body: unknown;
      if (url.includes('/iserver/account/orders')) body = { orders: pages.orders.shift() ?? [] };
      else if (url.includes('/iserver/account/trades')) body = pages.trades.shift() ?? [];
      else throw new Error(`unexpected ${url}`);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return urls;
  }
  const fast = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it('forces a refresh on the first poll only, then finds the order in the live orders', async () => {
    const urls = feeds({
      orders: [[], [{ orderId: 777, order_ref: 'r1-ABC-BUY-1', status: 'Submitted', ticker: 'ABC', side: 'BUY' }]],
      trades: [[], []],
    });
    const found = await findOrderByRef('r1-ABC-BUY-1', fast());
    expect(found).toEqual({ orderId: 777, status: 'Submitted', source: 'orders' });
    const orderUrls = urls.filter(u => u.includes('/orders'));
    expect(orderUrls[0]).toMatch(/force=true/);
    expect(orderUrls[1]).not.toMatch(/force=true/);
  });

  it('finds an order that already filled (gone from the orders feed) in the trades', async () => {
    feeds({ orders: [[]], trades: [[{ order_ref: 'r1-ABC-BUY-1', order_id: '888', execution_id: 'e' }]] });
    expect(await findOrderByRef('r1-ABC-BUY-1', fast())).toEqual({ orderId: 888, status: 'executed', source: 'trades' });
  });

  it('does not match a different cOID', async () => {
    feeds({ orders: Array(20).fill([{ orderId: 1, order_ref: 'r1-ABC-BUY-2' }]), trades: [] });
    expect(await findOrderByRef('r1-ABC-BUY-1', fast())).toBeNull();
  });

  it('gives up after ~30 s and returns null (unknown), polling every 3 s', async () => {
    const urls = feeds({ orders: [], trades: [] });
    expect(await findOrderByRef('r1-ABC-BUY-1', fast())).toBeNull();
    expect(urls.filter(u => u.includes('/orders')).length).toBe(11); // t = 0, 3, … 30 s
  });

  it('survives a failing feed and keeps polling', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/orders')) {
        n++;
        if (n < 3) return new Response('gateway down', { status: 503 });
        return new Response(JSON.stringify({ orders: [{ orderId: 9, order_ref: 'ref' }] }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await findOrderByRef('ref', fast())).toMatchObject({ orderId: 9 });
  });
});
