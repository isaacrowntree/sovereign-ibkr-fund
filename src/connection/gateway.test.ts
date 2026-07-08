import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  connect,
  getAccountSummary,
  getMarketPrice,
  getMarketPrices,
  placeMarketOrder,
  placeLimitOrder,
  symbolVariants,
  canonicalSymbol,
  parseSnapshotPrice,
  placeAdaptiveOrder,
  placeMidpriceOrder,
} from './gateway.js';
import { config } from '../config.js';

/**
 * Gateway tests: the gateway is now an HTTP client over the
 * `bezant-server` sidecar, so these tests stub `fetch` and assert the
 * request shape + response handling. No live IBKR involvement.
 */

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface ResponseSpec {
  status?: number;
  body?: unknown;
}

function makeFetch(handler: (url: string, init: FetchInit) => ResponseSpec | Promise<ResponseSpec>) {
  return vi.fn(async (input: FetchInput, init?: FetchInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const spec = await handler(url, init);
    const status = spec.status ?? 200;
    const text = spec.body === undefined ? '' : JSON.stringify(spec.body);
    return new Response(text, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('gateway HTTP client', () => {
  it('connect() probes /health and throws when not authenticated', async () => {
    globalThis.fetch = makeFetch((url) => {
      expect(url).toMatch(/\/health$/);
      return { body: { authenticated: false, connected: false } };
    });
    await expect(connect()).rejects.toThrow(/not authenticated/);
  });

  it('connect() succeeds when /health reports authenticated', async () => {
    globalThis.fetch = makeFetch(() => ({
      body: { authenticated: true, connected: true, competing: false, message: '' },
    }));
    await expect(connect()).resolves.toBeUndefined();
  });

  it('getAccountSummary() projects bezant-server payloads into typed view', async () => {
    globalThis.fetch = makeFetch((url) => {
      if (url.endsWith('/accounts')) {
        return { body: [{ id: 'U1234567', accountId: 'U1234567' }] };
      }
      if (url.includes('/summary')) {
        return {
          body: {
            netliquidation: { amount: 31000, currency: 'AUD' },
            totalcashvalue: { amount: 1500, currency: 'AUD' },
          },
        };
      }
      if (url.includes('/positions')) {
        return {
          body: [
            { ticker: 'AAPL', conid: 265598, position: 10, avgCost: 180, mktValue: 1900, mktPrice: 190 },
            { ticker: 'MSFT', conid: 272093, position: 5, avgCost: 320, mktValue: 1700, mktPrice: 340 },
          ],
        };
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const summary = await getAccountSummary();
    expect(summary.netLiquidation).toBe(31000);
    expect(summary.totalCashValue).toBe(1500);
    expect(summary.positions).toHaveLength(2);
    expect(summary.positions[0]).toMatchObject({
      symbol: 'AAPL',
      qty: 10,
      conid: 265598,
    });
  });

  it('getMarketPrice() resolves a conid then reads the snapshot', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = makeFetch((url) => {
      seenUrls.push(url);
      if (url.includes('/contracts/search')) {
        return { body: [{ symbol: 'AAPL', conid: '265598' }] };
      }
      if (url.includes('/market/snapshot')) {
        return { body: [{ conid: 265598, '31': '193.42' }] };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const price = await getMarketPrice('AAPL');
    expect(price).toBeCloseTo(193.42, 2);
    expect(seenUrls.some((u) => u.includes('symbol=AAPL'))).toBe(true);
    expect(seenUrls.some((u) => u.includes('conids=265598'))).toBe(true);
  });

  it('getMarketPrices() batches the snapshot call across symbols', async () => {
    const seen: string[] = [];
    globalThis.fetch = makeFetch((url) => {
      seen.push(url);
      if (url.includes('/contracts/search?symbol=AAPL')) {
        return { body: [{ symbol: 'AAPL', conid: 265598 }] };
      }
      if (url.includes('/contracts/search?symbol=MSFT')) {
        return { body: [{ symbol: 'MSFT', conid: 272093 }] };
      }
      if (url.includes('/market/snapshot')) {
        return {
          body: [
            { conid: 265598, '31': 190 },
            { conid: 272093, '31': 340 },
          ],
        };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const prices = await getMarketPrices(['AAPL', 'MSFT']);
    expect(prices.get('AAPL')).toBe(190);
    expect(prices.get('MSFT')).toBe(340);
    expect(seen.filter((u) => u.includes('/market/snapshot'))).toHaveLength(1);
  });

  it('placeMarketOrder() resolves the symbol then POSTs an MKT order', async () => {
    const calls: Array<{ url: string; body?: unknown; method?: string }> = [];
    globalThis.fetch = makeFetch((url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body, method: init?.method });
      if (url.endsWith('/accounts')) {
        return { body: [{ id: 'U1234567', accountId: 'U1234567' }] };
      }
      if (url.includes('/contracts/search')) {
        return { body: [{ symbol: 'AAPL', conid: 265598 }] };
      }
      if (url.includes('/orders')) {
        return { body: [{ order_id: 'abc123', order_status: 'Submitted' }] };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const result = await placeMarketOrder('AAPL', 'BUY', 10);
    expect(result.symbol).toBe('AAPL');
    expect(result.action).toBe('BUY');
    expect(result.qty).toBe(10);
    expect(result.status).toBe('Submitted');
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/orders'));
    expect(post).toBeDefined();
    expect((post!.body as any).orders[0]).toMatchObject({
      conid: 265598,
      orderType: 'MKT',
      side: 'BUY',
      quantity: 10,
      tif: 'DAY',
    });
  });

  it('placeLimitOrder() includes the limit price in the payload', async () => {
    const captured: Record<string, unknown>[] = [];
    globalThis.fetch = makeFetch((url, init) => {
      if (url.endsWith('/accounts')) {
        return { body: [{ id: 'U1234567' }] };
      }
      if (url.includes('/contracts/search')) {
        return { body: [{ symbol: 'AAPL', conid: 265598 }] };
      }
      if (url.includes('/orders') && init?.method === 'POST') {
        captured.push(JSON.parse(init.body as string));
        return { body: [{ orderId: 42, status: 'Working' }] };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const result = await placeLimitOrder('AAPL', 'SELL', 5, 200.5);
    expect(result.orderId).toBe(42);
    expect(result.status).toBe('Working');
    const order = (captured[0] as any).orders[0];
    expect(order).toMatchObject({ orderType: 'LMT', price: 200.5, side: 'SELL', quantity: 5 });
  });

  it('throws a descriptive error when bezant-server returns 5xx', async () => {
    globalThis.fetch = makeFetch(() => ({
      status: 503,
      body: { code: 'no_session', message: 'gateway has no active session' },
    }));
    await expect(getMarketPrice('AAPL')).rejects.toThrow(/503/);
  });

  it('placeAdaptiveOrder() sends Adaptive algo + priority param', async () => {
    const captured: Record<string, unknown>[] = [];
    globalThis.fetch = makeFetch((url, init) => {
      if (url.endsWith('/accounts')) return { body: [{ id: 'U1234567' }] };
      if (url.includes('/contracts/search')) return { body: [{ symbol: 'AMZN', conid: 3691937 }] };
      if (url.includes('/orders') && init?.method === 'POST') {
        captured.push(JSON.parse(init.body as string));
        return { body: [{ orderId: 99, status: 'Working' }] };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    await placeAdaptiveOrder('AMZN', 'BUY', 5, 'Patient');
    const order = (captured[0] as { orders: Record<string, unknown>[] }).orders[0];
    expect(order).toMatchObject({
      conid: 3691937,
      orderType: 'MKT',
      side: 'BUY',
      quantity: 5,
      algoStrategy: 'Adaptive',
    });
    expect(order.algoParams).toEqual([{ tag: 'adaptivePriority', value: 'Patient' }]);
  });

  it('placeAdaptiveOrder() defaults priority to Normal', async () => {
    const captured: Record<string, unknown>[] = [];
    globalThis.fetch = makeFetch((url, init) => {
      if (url.endsWith('/accounts')) return { body: [{ id: 'U1234567' }] };
      if (url.includes('/contracts/search')) return { body: [{ symbol: 'AMZN', conid: 3691937 }] };
      if (url.includes('/orders') && init?.method === 'POST') {
        captured.push(JSON.parse(init.body as string));
        return { body: [{ orderId: 100, status: 'Working' }] };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    await placeAdaptiveOrder('AMZN', 'SELL', 3);
    const order = (captured[0] as { orders: Record<string, unknown>[] }).orders[0];
    expect(order.algoParams).toEqual([{ tag: 'adaptivePriority', value: 'Normal' }]);
  });

  it('placeMidpriceOrder() sends MIDPRICE order type (no algo params)', async () => {
    const captured: Record<string, unknown>[] = [];
    globalThis.fetch = makeFetch((url, init) => {
      if (url.endsWith('/accounts')) return { body: [{ id: 'U1234567' }] };
      if (url.includes('/contracts/search')) return { body: [{ symbol: 'AMZN', conid: 3691937 }] };
      if (url.includes('/orders') && init?.method === 'POST') {
        captured.push(JSON.parse(init.body as string));
        return { body: [{ orderId: 101, status: 'Working' }] };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    await placeMidpriceOrder('AMZN', 'BUY', 7);
    const order = (captured[0] as { orders: Record<string, unknown>[] }).orders[0];
    expect(order).toMatchObject({
      orderType: 'MIDPRICE',
      side: 'BUY',
      quantity: 7,
    });
    expect(order.algoStrategy).toBeUndefined();
    expect(order.algoParams).toBeUndefined();
  });

  // Cloudflare Access service-token injection. When the ibkr-fund container
  // runs on Railway and bezant-server is published behind a Zero Trust app
  // on a residential Pi, every fetch must carry the service token headers
  // so Cloudflare's edge lets it through. Both headers must be present
  // (Cloudflare 403s on either missing); neither header should appear
  // when the env vars are unset (so localhost-only deploys aren't broken).
  describe('Cloudflare Access service-token injection', () => {
    let originalId: string | undefined;
    let originalSecret: string | undefined;

    beforeEach(() => {
      originalId = config.bezant.cfAccessClientId;
      originalSecret = config.bezant.cfAccessClientSecret;
    });

    afterEach(() => {
      config.bezant.cfAccessClientId = originalId;
      config.bezant.cfAccessClientSecret = originalSecret;
    });

    it('attaches both CF-Access headers when service token is configured', async () => {
      config.bezant.cfAccessClientId = 'tokenid.access';
      config.bezant.cfAccessClientSecret = 'tokensecret';

      const seenHeaders: Array<Record<string, string>> = [];
      globalThis.fetch = makeFetch((_url, init) => {
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return { body: { authenticated: true, connected: true, competing: false, message: '' } };
      });

      await connect();
      const headers = seenHeaders[0];
      expect(headers['CF-Access-Client-Id']).toBe('tokenid.access');
      expect(headers['CF-Access-Client-Secret']).toBe('tokensecret');
    });

    it('omits CF-Access headers when service token is not configured', async () => {
      config.bezant.cfAccessClientId = undefined;
      config.bezant.cfAccessClientSecret = undefined;

      const seenHeaders: Array<Record<string, string>> = [];
      globalThis.fetch = makeFetch((_url, init) => {
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return { body: { authenticated: true, connected: true, competing: false, message: '' } };
      });

      await connect();
      const headers = seenHeaders[0];
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
      expect(headers['CF-Access-Client-Secret']).toBeUndefined();
    });

    it('omits CF-Access headers when only one half is configured', async () => {
      // Cloudflare 403s on a request with only one header — sending an
      // incomplete pair would be worse than sending none, since the
      // request fails outright instead of falling through to the SSO
      // policy. So partial config = no headers attached.
      config.bezant.cfAccessClientId = 'tokenid.access';
      config.bezant.cfAccessClientSecret = undefined;

      const seenHeaders: Array<Record<string, string>> = [];
      globalThis.fetch = makeFetch((_url, init) => {
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return { body: { authenticated: true, connected: true, competing: false, message: '' } };
      });

      await connect();
      const headers = seenHeaders[0];
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
      expect(headers['CF-Access-Client-Secret']).toBeUndefined();
    });
  });

  describe('resolveConid: alternate symbol formats + US-equity preference', () => {
    it('falls back from BRK-B → BRK B when CPAPI returns "no symbol found" for the hyphen form', async () => {
      const seenUrls: string[] = [];
      globalThis.fetch = makeFetch((url) => {
        seenUrls.push(url);
        if (url.includes('/contracts/search?symbol=BRK-B')) {
          // CPAPI's actual response shape for unknown symbols — object, not
          // array — was the original Array.isArray crash. Now we tolerate it.
          return { body: { error: 'No symbol found' } };
        }
        if (url.includes('/contracts/search?symbol=BRK%20B')) {
          return {
            body: [
              { symbol: 'BRK B', conid: 72063691, description: 'NYSE', companyName: 'BERKSHIRE HATHAWAY INC-CL B' },
            ],
          };
        }
        if (url.includes('/market/snapshot')) {
          return { body: [{ conid: 72063691, '31': '450.12' }] };
        }
        throw new Error(`unexpected URL: ${url}`);
      });

      const price = await getMarketPrice('BRK-B');
      expect(price).toBe(450.12);
      // Verify both variants were attempted in order
      expect(seenUrls.some((u) => u.includes('symbol=BRK-B'))).toBe(true);
      expect(seenUrls.some((u) => u.includes('symbol=BRK%20B'))).toBe(true);
      expect(seenUrls.some((u) => u.includes('conids=72063691'))).toBe(true);
    });

    it('prefers a US-equity exchange match over the first-listed (non-equity) match', async () => {
      // CPAPI's `GE` query returns Euro-Dollar futures (CME) FIRST,
      // GENERAL ELECTRIC NYSE second. Without our exchange filter, we'd
      // pick the futures conid → no equity Last Price → silent skip.
      const seenUrls: string[] = [];
      globalThis.fetch = makeFetch((url) => {
        seenUrls.push(url);
        if (url.includes('/contracts/search?symbol=GE')) {
          return {
            body: [
              { symbol: 'GE', conid: 11160374, description: 'CME', companyName: 'Euro-Dollar' },
              { symbol: 'GE', conid: 498843743, description: 'NYSE', companyName: 'GENERAL ELECTRIC' },
            ],
          };
        }
        if (url.includes('/market/snapshot')) {
          return { body: [{ conid: 498843743, '31': '180.50' }] };
        }
        throw new Error(`unexpected URL: ${url}`);
      });

      const price = await getMarketPrice('GE');
      expect(price).toBe(180.50);
      // Snapshot must be queried with the NYSE conid, NOT the CME one
      expect(seenUrls.some((u) => u.includes('conids=498843743'))).toBe(true);
      expect(seenUrls.some((u) => u.includes('conids=11160374'))).toBe(false);
    });

    it('throws when no variant matches', async () => {
      globalThis.fetch = makeFetch(() => ({ body: { error: 'No symbol found' } }));
      await expect(getMarketPrice('NONEXISTENT')).rejects.toThrow(/no contract found/i);
    });
  });
});

describe('symbolVariants', () => {
  it('preserves the original symbol first', () => {
    expect(symbolVariants('AMZN')).toEqual(['AMZN']);
  });

  it('replaces hyphens with spaces for class-B style names', () => {
    const v = symbolVariants('BRK-B');
    expect(v[0]).toBe('BRK-B');
    expect(v).toContain('BRK B');
    expect(v).toContain('BRKB');
  });

  it('replaces dots with spaces (BRK.B → BRK B)', () => {
    const v = symbolVariants('BRK.B');
    expect(v).toContain('BRK B');
  });

  it('dedupes when collapsing produces an existing variant', () => {
    const v = symbolVariants('XYZ');
    // No hyphen/dot/space → all 3 transforms produce 'XYZ' → only one entry
    expect(v).toEqual(['XYZ']);
  });

  it('handles symbols with existing space (BRK B → just one variant)', () => {
    const v = symbolVariants('BRK B');
    expect(v).toContain('BRK B');
    expect(v).toContain('BRKB');
    expect(v.length).toBeLessThanOrEqual(2);
  });
});

describe('canonicalSymbol', () => {
  it('passes through normal symbols unchanged', () => {
    expect(canonicalSymbol('AMZN')).toBe('AMZN');
    expect(canonicalSymbol('PLTR')).toBe('PLTR');
  });

  it('replaces space with hyphen for class-B names returned by IBKR portfolio API', () => {
    expect(canonicalSymbol('BRK B')).toBe('BRK-B');
    expect(canonicalSymbol('BF B')).toBe('BF-B');
    expect(canonicalSymbol('RDS A')).toBe('RDS-A');
  });

  it('uppercases everything', () => {
    expect(canonicalSymbol('brk b')).toBe('BRK-B');
    expect(canonicalSymbol('amzn')).toBe('AMZN');
  });

  it('is idempotent (already-hyphenated stays as-is)', () => {
    expect(canonicalSymbol('BRK-B')).toBe('BRK-B');
  });

  it('collapses runs of spaces', () => {
    expect(canonicalSymbol('BRK   B')).toBe('BRK-B');
  });
});

describe('parseSnapshotPrice', () => {
  it('parses plain numeric strings', () => {
    expect(parseSnapshotPrice('272.05')).toBe(272.05);
    expect(parseSnapshotPrice('100')).toBe(100);
  });

  it('strips CPAPI status prefix C (after-hours close price)', () => {
    expect(parseSnapshotPrice('C272.05')).toBe(272.05);
    expect(parseSnapshotPrice('C468.52')).toBe(468.52);
  });

  it('strips other status prefixes (H halted, L locked)', () => {
    expect(parseSnapshotPrice('H272.05')).toBe(272.05);
    expect(parseSnapshotPrice('L100.50')).toBe(100.50);
  });

  it('passes through numeric values', () => {
    expect(parseSnapshotPrice(272.05)).toBe(272.05);
    expect(parseSnapshotPrice(100)).toBe(100);
  });

  it('returns NaN for undefined / empty / non-numeric', () => {
    expect(Number.isNaN(parseSnapshotPrice(undefined))).toBe(true);
    expect(Number.isNaN(parseSnapshotPrice(''))).toBe(true);
    expect(Number.isNaN(parseSnapshotPrice('halted'))).toBe(true);
  });

  it('handles negative values (rare for last price but mathematically possible)', () => {
    expect(parseSnapshotPrice('-12.50')).toBe(-12.50);
  });
});

describe('getMarketPrice: after-hours C-prefixed prices', () => {
  it('parses after-hours close-price format `C272.05` correctly', async () => {
    globalThis.fetch = makeFetch((url) => {
      if (url.includes('/contracts/search')) {
        return { body: [{ symbol: 'AMZN', conid: 3691937, description: 'NASDAQ' }] };
      }
      if (url.includes('/market/snapshot')) {
        return { body: [{ conid: 3691937, '31': 'C272.05' }] };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const price = await getMarketPrice('AMZN');
    expect(price).toBe(272.05);
  });

  it('getMarketPrices populates the price map from C-prefixed values', async () => {
    globalThis.fetch = makeFetch((url) => {
      if (url.includes('/contracts/search?symbol=AMZN')) {
        return { body: [{ symbol: 'AMZN', conid: 3691937, description: 'NASDAQ' }] };
      }
      if (url.includes('/contracts/search?symbol=BRK')) {
        // Hyphen variant fails, space variant returns NYSE match
        if (url.includes('BRK-B')) return { body: { error: 'No symbol found' } };
        return {
          body: [{ symbol: 'BRK B', conid: 72063691, description: 'NYSE' }],
        };
      }
      if (url.includes('/market/snapshot')) {
        return {
          body: [
            { conid: 3691937, '31': 'C272.05' },
            { conid: 72063691, '31': 'C468.52' },
          ],
        };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const prices = await getMarketPrices(['AMZN', 'BRK-B']);
    expect(prices.get('AMZN')).toBe(272.05);
    expect(prices.get('BRK-B')).toBe(468.52);
  });
});

describe('getAccountSummary: position symbol normalization', () => {
  it('returns position.symbol in canonical hyphen form even when IBKR sends space', async () => {
    globalThis.fetch = makeFetch((url) => {
      if (url.endsWith('/accounts')) {
        return { body: [{ accountId: 'U1234567' }] };
      }
      if (url.includes('/summary')) {
        return {
          body: {
            netliquidation: { amount: 38026.22 },
            totalcashvalue: { amount: 36.29 },
          },
        };
      }
      if (url.endsWith('/positions')) {
        return {
          body: [
            { ticker: 'BRK B', contractDesc: 'BRK B', conid: 72063691, position: 10, avgCost: 497.18, mktValue: 4692.20, mktPrice: 469.22 },
            { ticker: 'AMZN', contractDesc: 'AMZN', conid: 3691937, position: 4, avgCost: 272.12, mktValue: 1088.48, mktPrice: 272.12 },
          ],
        };
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const summary = await getAccountSummary();
    const symbols = summary.positions.map((p) => p.symbol);
    expect(symbols).toContain('BRK-B');
    expect(symbols).not.toContain('BRK B'); // canonical form only
    expect(symbols).toContain('AMZN');

    // Quantities preserved on the renamed entry
    const brkb = summary.positions.find((p) => p.symbol === 'BRK-B')!;
    expect(brkb.qty).toBe(10);
    expect(brkb.marketValue).toBe(4692.20);
  });
});
