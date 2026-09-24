import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  placeMarketOrder,
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
