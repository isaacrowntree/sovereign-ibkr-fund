import { describe, it, expect } from 'vitest';
import { postWebhook } from './webhook.mjs';

const URL_OK = 'https://hooks.example.test/services/T/B/x';

function fake(...rs: Array<number | Error>) {
  const calls: unknown[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    const r = rs.shift() ?? 200;
    if (r instanceof Error) throw r;
    return new Response('', { status: r });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, sleep: async () => {} };
}

describe('postWebhook', () => {
  it('posts once and reports success', async () => {
    const f = fake(200);
    expect(await postWebhook(URL_OK, { text: 'x' }, f)).toBe(true);
    expect(f.calls).toEqual([{ text: 'x' }]);
  });

  it.each([500, 503, 429])('retries a transient %i, up to two more times', async (s) => {
    const f = fake(s, s, s, 200);
    expect(await postWebhook(URL_OK, { text: 'x' }, f)).toBe(false);
    expect(f.calls).toHaveLength(3);
  });

  it('retries a dropped connection and stops at the first success', async () => {
    const f = fake(new Error('ECONNRESET'), 200);
    expect(await postWebhook(URL_OK, { text: 'x' }, f)).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it.each([400, 403, 404, 410])('does not retry a %i — a retry cannot fix it', async (s) => {
    const f = fake(s, 200);
    expect(await postWebhook(URL_OK, { text: 'x' }, f)).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it('refuses a scheme-less URL without calling fetch (it would log the secret)', async () => {
    const f = fake(200);
    expect(await postWebhook('hooks.example.test/services/T/B/secret', { text: 'x' }, f)).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('is a quiet no-op with no URL', async () => {
    const f = fake(200);
    expect(await postWebhook(undefined, { text: 'x' }, f)).toBe(false);
    expect(f.calls).toEqual([]);
  });
});
