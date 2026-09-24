/**
 * IBKR connection layer — talks HTTP to a `bezant-server` sidecar.
 *
 * The previous implementation used `@stoqey/ib`'s TWS socket protocol; this
 * version replaces it with REST calls against the bezant-server HTTP surface
 * (https://github.com/isaacrowntree/bezant). The exported function shapes
 * are preserved so that callers (`agents/*.ts`) don't need to change —
 * `connect()` / `disconnect()` are no-ops kept for API compatibility, and
 * symbol → conid resolution happens transparently inside the order helpers.
 *
 * The HTTP sidecar maintains the IBKR session cookie in its own jar; this
 * client just makes server-to-server calls and trusts the cookie state
 * established by the user's interactive Gateway login.
 */

import type {
  IndividualPosition,
  PortfolioSummary,
  SecdefSearchResponseInner,
} from 'bezant-client';
import { config } from '../config.js';
import { log, logError } from '../log.js';

// ---------- Public types preserved from the TWS-era gateway ----------
//
// Raw HTTP response shapes (`IndividualPosition`, `PortfolioSummary`,
// `SecdefSearchResponseInner`) come from the bezant-client package, which is
// auto-generated from `crates/bezant-spec/ibkr-openapi.json`. `import type`
// is erased at compile time — bezant-server is still the runtime, this just
// gives us compile-time drift detection against the CPAPI contract.
//
// Domain types below (`Position`, `AccountSummary`, `TradeResult`) are
// transformed shapes — what the rest of the bot consumes after gateway
// normalisation. They stay hand-written.

export interface Position {
  symbol: string;
  qty: number;
  avgCost: number;
  marketValue: number;
  marketPrice: number;
  conid?: number;
  /**
   * Set when IBKR gave no usable quantity and `qty` is a stand-in 0. Callers
   * that would act on a zero (orphan recovery reads it as "sold") must refuse.
   */
  qtyMissing?: true;
}

export interface AccountSummary {
  netLiquidation: number;
  totalCashValue: number;
  positions: Position[];
}

export interface ExecutionDetail {
  execId: string;
  orderId: number;
  symbol: string;
  side: string;
  shares: number;
  price: number;
  time: string;
}

export interface CommissionDetail {
  execId: string;
  commission: number;
  currency: string;
  realisedPnl: number;
}

export interface TradeResult {
  orderId: number;
  symbol: string;
  action: 'BUY' | 'SELL';
  qty: number;
  status: string;
  avgFillPrice?: number;
  commission?: number;
  commissionCurrency?: string;
  executions?: ExecutionDetail[];
  /** Confirmation prompts IBKR raised on the way to accepting the order. */
  replies?: OrderReply[];
}

// ---------- Internal helpers ----------

export class GatewayError extends Error {
  /** IBKR answered the order with an explicit rejection: it is not live. */
  rejected?: true;
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * The order provably never reached IBKR as a live order — a confirmation
 * prompt was refused, so the order died unconfirmed. Safe to keep queued; a
 * placement error WITHOUT this marker may have landed and must be treated as
 * ambiguous.
 */
export class OrderNotPlacedError extends GatewayError {
  readonly notPlaced = true as const;
  constructor(message: string, readonly replies: OrderReply[]) {
    super(message);
    this.name = 'OrderNotPlacedError';
  }
}

let cachedAccountId: string | null = null;
const conidCache = new Map<string, number>();

function cfAccessHeaders(): Record<string, string> {
  const { cfAccessClientId, cfAccessClientSecret } = config.bezant;
  if (!cfAccessClientId || !cfAccessClientSecret) return {};
  return {
    'CF-Access-Client-Id': cfAccessClientId,
    'CF-Access-Client-Secret': cfAccessClientSecret,
  };
}

async function bezantFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.bezant.timeoutMs);
  try {
    const response = await fetch(`${config.bezant.url}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...cfAccessHeaders(),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new GatewayError(
        `bezant-server ${response.status} on ${path}: ${body || response.statusText}`,
        response.status,
        body,
      );
    }
    // Empty 204 / 304 / etc. — return undefined cast so callers can guard.
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAccountId(): Promise<string> {
  if (config.bezant.accountId) return config.bezant.accountId;
  if (cachedAccountId) return cachedAccountId;
  const accounts = await bezantFetch<Array<{ id?: string; accountId?: string }>>('/accounts');
  const first = accounts?.[0];
  const id = first?.accountId ?? first?.id;
  if (!id) throw new GatewayError('no IBKR accounts available — log in to the Gateway first');
  cachedAccountId = id;
  return id;
}

/**
 * Exchanges where we trust a US equity match. CPAPI's contract search returns
 * results across instrument types and venues, so a query like `GE` brings back
 * Euro-Dollar CME futures *first* and GENERAL ELECTRIC NYSE second. Without
 * this filter we'd pick the futures conid → snapshot has no last price for
 * an equity field → the symbol gets silently dropped from rebalance orders.
 */
const US_EQUITY_EXCHANGES = ['NYSE', 'NASDAQ', 'ARCA', 'AMEX', 'BATS', 'PINK', 'IEX'];

/**
 * IBKR's portfolio endpoints emit class-B style names with a space
 * (`"BRK B"`, `"BF B"`, `"RDS A"`); our `TARGET_PORTFOLIO` and the rest of
 * the bot use the conventional hyphen form (`"BRK-B"`). Symbol-equality
 * lookups (e.g. `positions.find(p => p.symbol === sym)`) silently miss when
 * the two forms disagree — a held position appears as "current = 0%" and
 * the rebalance over-orders that name. Normalize at the gateway boundary
 * so the bot's internal model uses the canonical hyphen form throughout.
 *
 * Exported for tests; safe to call on any string (idempotent for already-
 * canonical names like "AMZN").
 */
export function canonicalSymbol(raw: string): string {
  return raw.replace(/\s+/g, '-').toUpperCase();
}

/**
 * Generate symbol variants for CPAPI's contract search. Class-B style names
 * (`BRK-B`, `BF-B`, `RDS-A`) need the hyphen replaced — IBKR uses a space
 * between root and class indicator. Returns dedup'd ordered list of variants
 * to try until one finds a match.
 */
export function symbolVariants(symbol: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: string) => {
    const trimmed = s.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };
  push(symbol);
  push(symbol.replace(/[-.]/g, ' ')); // BRK-B → BRK B, BRK.B → BRK B
  push(symbol.replace(/[-. ]/g, '')); // BRK-B → BRKB
  return out;
}

async function resolveConid(symbol: string): Promise<number> {
  const cached = conidCache.get(symbol);
  if (cached) return cached;

  // CPAPI's contract search is finicky:
  //  * Returns `{"error": "No symbol found"}` (object, not array) for
  //    unknown formats — guard with Array.isArray.
  //  * Across multiple matches, the first is often a futures contract
  //    or foreign CDR/MEXI listing. Filter to a US equity exchange.
  //  * Class-B names (BRK-B) need the hyphen replaced with a space.
  for (const variant of symbolVariants(symbol)) {
    const raw = await bezantFetch<unknown>(
      `/contracts/search?symbol=${encodeURIComponent(variant)}&secType=STK`,
    );
    const matches: SecdefSearchResponseInner[] = Array.isArray(raw)
      ? (raw as SecdefSearchResponseInner[])
      : [];
    if (matches.length === 0) continue;

    // Prefer matches whose `description` (the exchange) is a US equity venue.
    // Falls back to the symbol-equality match, then the first overall.
    const onUsExchange = matches.find((m) => {
      const desc = (m.description ?? '').toUpperCase();
      return US_EQUITY_EXCHANGES.some((ex) => desc.includes(ex));
    });
    const symbolMatch = matches.find(
      (m) => (m.symbol ?? '').toUpperCase() === variant.toUpperCase(),
    );
    const first = onUsExchange ?? symbolMatch ?? matches[0];
    const rawConid = first?.conid;
    const conid = typeof rawConid === 'string' ? parseInt(rawConid, 10) : rawConid;
    if (!conid || Number.isNaN(conid)) continue;

    conidCache.set(symbol, conid);
    return conid;
  }

  throw new GatewayError(`no contract found for symbol ${symbol}`);
}

// ---------- Session lifecycle (kept as no-ops for compatibility) ----------

/**
 * No-op in the HTTP-sidecar world — bezant-server keeps the session alive
 * via its own keepalive task. Retained so existing call sites compile.
 * Performs a `/health` probe so a misconfigured `BEZANT_URL` fails loudly
 * at startup instead of on the first trade attempt.
 */
export async function connect(): Promise<void> {
  type Health = {
    authenticated: boolean;
    connected: boolean;
    competing?: boolean;
    message?: string | null;
  };
  try {
    const health = await bezantFetch<Health>('/health');
    if (!health?.authenticated) {
      throw new GatewayError(
        `bezant-server reachable but Gateway is not authenticated — log in via ${config.bezant.url}`,
      );
    }
    log(
      `Connected to bezant-server (authenticated=${health.authenticated} connected=${health.connected})`,
    );
  } catch (err) {
    logError(`gateway connect: ${(err as Error).message}`);
    throw err;
  }
}

/** No-op — preserved for API compatibility. */
export function disconnect(): void {
  // bezant-server's keepalive runs independently of any specific bot
  // process, so there's nothing to tear down on the client side.
}

/** No-op — CPAPI's market data delivery doesn't need a delayed-data switch. */
export function requestDelayedData(): void {
  // CPAPI snapshot fields control delayed vs realtime selection at the
  // bezant-server layer; nothing to toggle from this side.
}

// ---------- Account / portfolio reads ----------

export async function getAccountSummary(): Promise<AccountSummary> {
  const accountId = await resolveAccountId();
  const summary = await bezantFetch<PortfolioSummary>(`/accounts/${accountId}/summary`);
  const positionsRaw = await bezantFetch<IndividualPosition[]>(
    `/accounts/${accountId}/positions`,
  );

  const positions: Position[] = (positionsRaw ?? []).map((p) => ({
    symbol: canonicalSymbol(p.ticker ?? p.contractDesc ?? '?'),
    qty: p.position ?? 0,
    avgCost: p.avgCost ?? 0,
    marketValue: p.mktValue ?? 0,
    marketPrice: p.mktPrice ?? 0,
    conid: p.conid,
    ...(typeof p.position === 'number' && Number.isFinite(p.position) ? {} : { qtyMissing: true as const }),
  }));

  // PortfolioSummary's value rows expose `amount: number` (numeric data) and
  // `value: string` (non-numeric). For currency-amount fields we want
  // `amount`; the string `value` is for things like account-type labels.
  const pickAmount = (row: { amount?: number } | undefined): number =>
    row?.amount ?? 0;

  return {
    netLiquidation: pickAmount(summary?.netliquidation),
    totalCashValue: pickAmount(summary?.totalcashvalue),
    positions,
  };
}

/** One per-currency row from CPAPI's `/ledger` (`LedgerList`). */
interface LedgerRow {
  currency?: string;
  /** Total cash in this currency, INCLUDING unsettled proceeds. */
  cashbalance?: number;
  /** Settled-only cash in this currency. */
  settledcash?: number;
  /** Net liquidation value of this currency bucket, in this currency. */
  netliquidationvalue?: number;
  /** Units of the account BASE currency per 1 unit of this currency. */
  exchangerate?: number;
}

export interface UsdBalances {
  /**
   * USD cash available to fund USD stock buys, including unsettled sale
   * proceeds. This is the figure to gate USD orders against — NOT the
   * account's base-currency `totalCashValue`, which for an AUD-base account
   * aggregates all currencies and tells you nothing about USD buying power.
   *
   * A cash (STKCASH) account cannot borrow USD and IBKR does not auto-convert
   * AUD→USD, so USD buys must be funded by USD cash — here, the proceeds of
   * the USD sells that run first.
   */
  usdCash: number;
  /**
   * USD cash that has SETTLED. Deliberately separate from `usdCash` above:
   * a rebalance's buys are legitimately funded by the unsettled proceeds of
   * its own sells, so the order gate must keep using `usdCash`. But a DEPOSIT
   * should not be deployed before it settles, and that is a different
   * question. Absent from the ledger means nothing is known to have settled,
   * never that everything has.
   */
  usdSettledCash: number;
  /** Total portfolio net liquidation value expressed in USD. */
  usdNav: number;
  /**
   * Base currency per 1 USD, from the USD ledger row (`exchangerate`). Lets a
   * threshold the operator thinks of in base currency (an AUD reserve) be
   * compared with the USD figures above. null when the ledger carries none.
   */
  baseRatePerUsd: number | null;
}

/**
 * Pure derivation of USD balances from a raw CPAPI ledger. Exported for
 * tests. Excludes the `BASE` pseudo-currency row (which already aggregates
 * every bucket in base currency) so NAV isn't double-counted.
 */
export function deriveUsdBalances(ledger: Record<string, LedgerRow>): UsdBalances {
  const rows = Object.entries(ledger ?? {})
    .filter(([key, r]) => key !== 'BASE' && r.currency !== 'BASE')
    .map(([, r]) => r);
  const usd = rows.find(r => r.currency === 'USD');
  const usdRate = usd?.exchangerate; // base (AUD) per 1 USD

  // Total NAV in base currency = Σ (bucket NAV in its ccy × ccy→base rate).
  const baseNav = rows.reduce(
    (sum, r) => sum + (r.netliquidationvalue ?? 0) * (r.exchangerate ?? 0),
    0,
  );
  const usdNav = usdRate && usdRate > 0 ? baseNav / usdRate : (usd?.netliquidationvalue ?? 0);

  const usdCash = usd?.cashbalance ?? 0;
  return {
    usdCash,
    // Clamped: a settled figure above the total is nonsense, and trusting it
    // would deploy more than exists.
    usdSettledCash: Math.min(usd?.settledcash ?? 0, usdCash),
    usdNav,
    baseRatePerUsd: usdRate && usdRate > 0 ? usdRate : null,
  };
}

/**
 * Read per-currency balances from the CPAPI ledger and derive USD cash +
 * USD NAV. Both order estimates and these figures are USD, so the cash gate
 * compares like-for-like.
 */
export async function getUsdBalances(): Promise<UsdBalances> {
  const accountId = await resolveAccountId();
  const ledger = await bezantFetch<Record<string, LedgerRow>>(
    `/accounts/${accountId}/ledger`,
  );
  return deriveUsdBalances(ledger ?? {});
}

export interface LiveOrder {
  orderId: number;
  symbol: string;
  action: 'BUY' | 'SELL';
  /** Raw CPAPI status (e.g. Submitted, PreSubmitted, Filled, Cancelled). */
  status: string;
  remainingQty: number;
  /** The cOID the order was placed with (CPAPI `order_ref`), when it has one. */
  orderRef?: string;
  /** ms since IBKR last touched the order (`lastExecutionTime_r`), when reported. */
  ageMs?: number;
}

/** Pure parse of one CPAPI `/iserver/account/orders` row. Exported for tests. */
export function parseLiveOrder(o: Record<string, unknown>, now: number = Date.now()): LiveOrder {
  const touched = Number(o.lastExecutionTime_r);
  const ref = o.order_ref ?? o.orderRef;
  return {
    orderId: Number(o.orderId ?? o.order_id ?? 0),
    symbol: canonicalSymbol(String(o.ticker ?? o.symbol ?? o.description1 ?? '')),
    action: String(o.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
    status: String(o.status ?? o.order_ccp_status ?? ''),
    remainingQty: Number(o.remainingQuantity ?? o.remaining_quantity ?? 0),
    ...(ref != null && String(ref) !== '' ? { orderRef: String(ref) } : {}),
    ...(Number.isFinite(touched) && touched > 0 ? { ageMs: Math.max(0, now - touched) } : {}),
  };
}

/**
 * Current live orders for the account (CPAPI `/iserver/account/orders` via
 * bezant). Used as an idempotency source: before placing an order the
 * executor checks whether a working order for the same symbol+side already
 * exists, so a prior run's un-confirmed order (or a placement that timed out
 * after IBKR accepted it) is never duplicated.
 */
export async function getLiveOrders(): Promise<LiveOrder[]> {
  const accountId = await resolveAccountId();
  const resp = await bezantFetch<{ orders?: Array<Record<string, unknown>> }>(
    `/accounts/${accountId}/orders`,
  );
  const orders = resp?.orders ?? [];
  const now = Date.now();
  return orders.map((o) => parseLiveOrder(o, now));
}

export interface Execution {
  /** IBKR's authoritative execution id — the idempotency key for reconciliation. */
  execId: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  qty: number;
  price: number;
  /**
   * When the fill happened, ISO 8601 UTC. Normalised from CPAPI's `trade_time_r`
   * (epoch ms) — the raw `trade_time` is `YYYYMMDD-HH:MM:SS`, and a ledger
   * timestamp in that form never matches the ISO day the rest of the system
   * keys on. Empty string when IBKR gave neither.
   */
  time: string;
  /** Commission IBKR charged on this execution, when reported. */
  commission?: number;
  /** Originating order id, when present. */
  orderId?: number;
  /** The cOID the originating order was placed with (`order_ref`), when present. */
  orderRef?: string;
}

/**
 * CPAPI reports trade time two ways: `trade_time_r` as epoch milliseconds and
 * `trade_time` as `YYYYMMDD-HH:MM:SS` in UTC. Prefer the unambiguous one; parse
 * the other as UTC when it is all we have. Exported for tests.
 */
export function parseTradeTime(row: { trade_time_r?: unknown; trade_time?: unknown }): string {
  const ms = Number(row.trade_time_r);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  const m = String(row.trade_time ?? '').match(/^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
  return '';
}

/**
 * Recent executions from IBKR (CPAPI `/iserver/account/trades` via bezant) —
 * the account's authoritative fill record. Used to reconcile the local ledger
 * against fills the WS event stream may have missed, keyed by `execId`.
 */
/**
 * Pure parse of CPAPI `/trades` rows → equity Executions. Exported for tests.
 * EXCLUDES non-equity lines (`sec_type` !== STK) — e.g. the IDEALPRO FX
 * auto-liquidations (`AUD.USD`, `sec_type: CASH`) IBKR books to settle a US
 * trade, which must never be recorded as a stock sale.
 */
export function parseExecutions(rows: Array<Record<string, unknown>>): Execution[] {
  return rows
    .filter((t) => String(t.sec_type ?? '').toUpperCase() === 'STK')
    .map((t) => {
      const side = String(t.side ?? '').toUpperCase();
      return {
        execId: String(t.execution_id ?? t.execid ?? t.exec_id ?? ''),
        symbol: canonicalSymbol(String(t.symbol ?? t.ticker ?? t.contract_description_1 ?? '')),
        action: (side === 'S' || side === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
        qty: Number(t.size ?? t.quantity ?? 0),
        price: Number(t.price ?? 0),
        time: parseTradeTime(t),
        commission: Number.isFinite(Number(t.commission)) && t.commission != null ? Number(t.commission) : undefined,
        // order_ref is our cOID — a string, never an order id. It used to be
        // Number()ed as a fallback, which gave NaN for every cOID.
        orderId: t.order_id != null && Number.isFinite(Number(t.order_id)) ? Number(t.order_id) : undefined,
        ...(t.order_ref != null && String(t.order_ref) !== '' ? { orderRef: String(t.order_ref) } : {}),
      };
    })
    .filter((e) => e.execId && e.qty > 0);
}

export async function getExecutions(): Promise<Execution[]> {
  const raw = await bezantFetch<Array<Record<string, unknown>>>(
    `/v1/api/iserver/account/trades`,
  );
  return parseExecutions(Array.isArray(raw) ? raw : []);
}

/**
 * Cancel a working order by id (CPAPI `DELETE /iserver/account/{id}/orders/{orderId}`
 * via bezant). Best-effort: used to retire an order whose fill state we
 * couldn't confirm, so the strategist doesn't regenerate and double it.
 */
export async function cancelOrder(orderId: number): Promise<void> {
  const accountId = await resolveAccountId();
  await bezantFetch<unknown>(`/accounts/${accountId}/orders/${orderId}`, {
    method: 'DELETE',
  });
}

// ---------- Market data ----------

/**
 * CPAPI's snapshot field 31 ("Last Price") prefixes the numeric value with a
 * status flag character outside regular trading hours: `C` = closing price,
 * `H` = halted, `L` = locked, etc. parseFloat("C272.05") returns NaN, which
 * silently drops the symbol from the price map and ends up showing as 0% in
 * the strategist's drift calculation. Strip the leading non-numeric prefix
 * before parsing so after-hours runs still see prices.
 *
 * Exported for tests; safe on already-numeric inputs.
 */
export function parseSnapshotPrice(raw: string | number | undefined): number {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  // Match the first signed/unsigned float in the string. Tolerates leading
  // status chars (C/H/L), trailing flags, and arbitrary whitespace.
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : NaN;
}

export async function getMarketPrice(symbol: string): Promise<number> {
  const conid = await resolveConid(symbol);
  // Field 31 = "Last Price" in CPAPI's snapshot field codes.
  type Snapshot = Array<{ '31'?: string | number; conid?: number }>;
  const snap = await bezantFetch<Snapshot>(
    `/market/snapshot?conids=${conid}&fields=31`,
  );
  const price = parseSnapshotPrice(snap?.[0]?.['31']);
  if (!price || Number.isNaN(price)) {
    throw new GatewayError(`no last price returned for ${symbol} (conid ${conid})`);
  }
  return price;
}

export async function getMarketPrices(symbols: string[]): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  if (symbols.length === 0) return results;
  // Resolve conids in parallel so one slow lookup doesn't gate everything.
  const conids = await Promise.all(
    symbols.map(async (s) => [s, await resolveConid(s)] as const).map((p) =>
      p.catch((err) => {
        logError(`conid lookup failed for symbol`, err);
        return null;
      }),
    ),
  );
  const valid = conids.filter((entry): entry is readonly [string, number] => entry !== null);
  if (valid.length === 0) return results;
  const idsParam = valid.map(([, c]) => c).join(',');
  type Snapshot = Array<{ '31'?: string | number; conid?: number }>;
  const conidToSymbol = new Map<number, string>(valid.map(([s, c]) => [c, s]));

  // CPAPI's snapshot endpoint SUBSCRIBES on the first call and only returns
  // field 31 (last price) once the feed has warmed up — so a single call
  // routinely returns n/a for symbols whose subscription just started. Retry
  // a few times (short waits), accumulating prices as they warm up, until
  // every requested symbol has resolved. Returns whatever resolved after the
  // final attempt (callers treat still-missing symbols as suspect data).
  const maxAttempts = parseInt(process.env.SNAPSHOT_MAX_ATTEMPTS || '6', 10);
  const retryMs = parseInt(process.env.SNAPSHOT_RETRY_MS || '1200', 10);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const snap = await bezantFetch<Snapshot>(
      `/market/snapshot?conids=${idsParam}&fields=31`,
    );
    for (const row of snap ?? []) {
      const price = parseSnapshotPrice(row['31']);
      const symbol = row.conid != null ? conidToSymbol.get(row.conid) : undefined;
      if (symbol && !results.has(symbol) && price && !Number.isNaN(price)) {
        results.set(symbol, price);
      }
    }
    if (results.size === valid.length) break;
    if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, retryMs));
  }
  return results;
}

// ---------- Order placement ----------

interface SubmitOrderResponse {
  order_id?: string | number;
  orderId?: string | number;
  order_status?: string;
  status?: string;
  /** CPAPI confirmation-reply id (present when the order needs a confirm). */
  id?: string;
  /** Confirmation/warning text accompanying a reply. */
  message?: string[];
  /** Stable ids of the prompts in `message` (e.g. `o163`). */
  messageIds?: string[];
  /** Rejection reason. */
  error?: string;
}

/** Max chained confirmation replies to answer before giving up. */
const MAX_ORDER_REPLIES = 10;

/**
 * Which order-confirmation prompts may be answered "yes" automatically.
 *
 * Every prompt used to be confirmed blind. Most are harmless ("this is a
 * market order", "price exceeds the percentage constraint"), but the same
 * mechanism carries the ones that mean stop: a trading-permission or
 * account-restriction warning, a cash shortfall, a price far from the market.
 * IBKR tags each with `messageIds` (e.g. `o163`), stable across the text.
 *
 * REPLY_POLICY=log (default) confirms as before and records what enforce
 * would have done, so the real ids can be gathered before anything is
 * refused. REPLY_POLICY=enforce confirms only allowlisted ids; a denied,
 * unknown or missing id is not confirmed, which leaves the order unplaced.
 * REPLY_ALLOW_IDS adds ids (comma-separated) — the Market Order Confirmation
 * id once the log has shown it.
 */
export const REPLY_ALLOW_IDS = ['o10151', 'o10153'];
export const REPLY_DENY_IDS = ['o354', 'o383', 'o451', 'o163', 'o403', 'o2137'];

export type ReplyPolicy = 'log' | 'enforce';

export function replyPolicy(env: NodeJS.ProcessEnv = process.env): ReplyPolicy {
  return (env.REPLY_POLICY ?? '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'log';
}

export interface OrderReply {
  /** CPAPI reply id (the /iserver/reply/{id} path segment). */
  id: string;
  messageIds: string[];
  /** Full prompt text, HTML stripped. */
  text: string;
  /** Would the allowlist confirm this? Null when it would; the reason when not. */
  refusal: string | null;
  /** What was actually done with it. */
  decision: 'confirmed' | 'refused';
  at: string;
}

/** Allowlist verdict for a prompt's message ids: null = confirm, else why not. Pure. */
export function evaluateReply(messageIds: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const extra = (env.REPLY_ALLOW_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = new Set([...REPLY_ALLOW_IDS, ...extra]);
  const deny = new Set(REPLY_DENY_IDS);
  if (messageIds.length === 0) return 'prompt carries no messageIds';
  const denied = messageIds.filter(id => deny.has(id));
  if (denied.length) return `denied prompt id(s) ${denied.join(', ')}`;
  const unknown = messageIds.filter(id => !allow.has(id));
  if (unknown.length) return `unknown prompt id(s) ${unknown.join(', ')}`;
  return null;
}

const promptText = (r: SubmitOrderResponse): string =>
  (Array.isArray(r.message) ? r.message : r.message ? [String(r.message)] : [])
    .join(' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

async function submitOrder(
  conid: number,
  symbol: string,
  action: 'BUY' | 'SELL',
  qty: number,
  body: Record<string, unknown>,
): Promise<TradeResult> {
  const accountId = await resolveAccountId();
  const payload = {
    orders: [
      {
        acctId: accountId,
        conid,
        orderType: body.orderType,
        side: action,
        quantity: qty,
        tif: 'DAY',
        ...body,
      },
    ],
  };
  let responses = await bezantFetch<SubmitOrderResponse[]>(
    `/accounts/${accountId}/orders`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  let first = responses?.[0];

  // CPAPI returns order-confirmation "replies" ({ id, message }) for the
  // mandatory warnings (Market Order Confirmation, Cap Price, size/price
  // caps, …) BEFORE it accepts an order — with no order_id. Answer each with
  // { confirmed: true } via /iserver/reply/{id}; the response is either the
  // next reply in the chain or the final order carrying an order_id. Without
  // this, the very first order of a session never gets an id.
  const policy = replyPolicy();
  const replies: OrderReply[] = [];
  while (first && first.id && first.order_id == null && first.orderId == null && !first.error) {
    if (replies.length >= MAX_ORDER_REPLIES) {
      throw new GatewayError(`order for ${symbol} stuck in confirmation replies (>${MAX_ORDER_REPLIES})`);
    }
    const messageIds = Array.isArray(first.messageIds) ? first.messageIds.map(String) : [];
    const text = promptText(first);
    const refusal = evaluateReply(messageIds);
    const refuse = refusal !== null && policy === 'enforce';
    replies.push({
      id: String(first.id), messageIds, text, refusal,
      decision: refuse ? 'refused' : 'confirmed', at: new Date().toISOString(),
    });
    if (refuse) {
      // Not answering is how an order is declined: it never goes live.
      throw new OrderNotPlacedError(
        `order for ${symbol} not placed — confirmation prompt refused (${refusal}): ${text.slice(0, 200)}`,
        replies,
      );
    }
    log(
      `Confirming order prompt for ${symbol} (reply ${replies.length}, ids ${messageIds.join(',') || 'none'}): ` +
        `${text.slice(0, 120)}${refusal ? ` — REPLY_POLICY=log; enforce would refuse: ${refusal}` : ''}`,
    );
    responses = await bezantFetch<SubmitOrderResponse[]>(
      `/v1/api/iserver/reply/${first.id}`,
      { method: 'POST', body: JSON.stringify({ confirmed: true }) },
    );
    first = responses?.[0];
  }

  if (!first) throw new GatewayError(`order submission returned no response for ${symbol}`);
  if (first.error) {
    const rejected = new GatewayError(`order rejected for ${symbol}: ${first.error}`);
    rejected.rejected = true;
    throw rejected;
  }
  const rawId = first.order_id ?? first.orderId;
  const orderId = typeof rawId === 'string' ? parseInt(rawId, 10) : rawId;
  // Fail closed: an answer with no order id is not "Submitted order 0". The
  // order may or may not be live; throwing sends it down the ambiguous path,
  // which looks it up by its cOID rather than guessing.
  if (typeof orderId !== 'number' || !Number.isFinite(orderId) || orderId <= 0) {
    throw new GatewayError(`order for ${symbol} answered without an order id: ${JSON.stringify(first).slice(0, 200)}`);
  }
  return {
    orderId,
    symbol,
    action,
    qty,
    status: String(first.order_status ?? first.status ?? 'unknown'),
    ...(replies.length ? { replies } : {}),
  };
}

/**
 * Per-placement options. `cOID` is the client order id IBKR stores on the
 * order (it comes back as `order_ref` on orders and trades) and refuses to
 * accept twice, so an order whose placement timed out can be found again —
 * and a blind retry of the same placement cannot go live twice.
 */
export interface PlaceOpts {
  cOID?: string;
}

const withCoid = (body: Record<string, unknown>, opts?: PlaceOpts): Record<string, unknown> =>
  opts?.cOID ? { ...body, cOID: opts.cOID } : body;

export async function placeMarketOrder(
  symbol: string,
  action: 'BUY' | 'SELL',
  qty: number,
  opts?: PlaceOpts,
): Promise<TradeResult> {
  const conid = await resolveConid(symbol);
  log(`Placing market ${action} ${qty} ${symbol} (conid=${conid}${opts?.cOID ? `, cOID=${opts.cOID}` : ''})`);
  return submitOrder(conid, symbol, action, qty, withCoid({ orderType: 'MKT' }, opts));
}

export async function placeLimitOrder(
  symbol: string,
  action: 'BUY' | 'SELL',
  qty: number,
  price: number,
  opts?: PlaceOpts,
): Promise<TradeResult> {
  const conid = await resolveConid(symbol);
  log(`Placing limit ${action} ${qty} ${symbol} @ $${price.toFixed(2)} (conid=${conid})`);
  return submitOrder(conid, symbol, action, qty, withCoid({ orderType: 'LMT', price }, opts));
}

export type AdaptivePriority = 'Patient' | 'Normal' | 'Urgent';

/**
 * IBKR's Adaptive algo: a "smart" market order that posts and crosses the
 * spread intelligently to minimise slippage. The `priority` knob trades
 * patience (better fills, more time in market) vs urgency (quicker fills,
 * higher slippage). For passive rebalances, `Patient` is the right default.
 *
 * Wire format: `orderType: 'MKT'` plus `algoStrategy: 'Adaptive'` plus an
 * `algoParams` array carrying the priority tag. CPGateway's order endpoint
 * accepts this shape via its standard `/accounts/{id}/orders` POST.
 */
export async function placeAdaptiveOrder(
  symbol: string,
  action: 'BUY' | 'SELL',
  qty: number,
  priority: AdaptivePriority = 'Normal',
  opts?: PlaceOpts,
): Promise<TradeResult> {
  const conid = await resolveConid(symbol);
  log(`Placing Adaptive(${priority}) ${action} ${qty} ${symbol} (conid=${conid}${opts?.cOID ? `, cOID=${opts.cOID}` : ''})`);
  return submitOrder(conid, symbol, action, qty, withCoid({
    orderType: 'MKT',
    algoStrategy: 'Adaptive',
    algoParams: [{ tag: 'adaptivePriority', value: priority }],
  }, opts));
}

/**
 * IBKR's MIDPRICE order: quotes at the bid/ask midpoint, never aggresses
 * the spread. Best for non-urgent orders where saving half-the-spread per
 * trade matters (small retail rebalance volumes). May not fill if the
 * midpoint moves away — for that case, prefer Adaptive.
 */
export async function placeMidpriceOrder(
  symbol: string,
  action: 'BUY' | 'SELL',
  qty: number,
  opts?: PlaceOpts,
): Promise<TradeResult> {
  const conid = await resolveConid(symbol);
  log(`Placing MIDPRICE ${action} ${qty} ${symbol} (conid=${conid}${opts?.cOID ? `, cOID=${opts.cOID}` : ''})`);
  return submitOrder(conid, symbol, action, qty, withCoid({ orderType: 'MIDPRICE' }, opts));
}

export interface FoundOrder {
  orderId: number;
  status: string;
  /** Which feed found it. */
  source: 'orders' | 'trades';
}

export interface FindOrderOpts {
  /** Total time to keep looking. Default 30 s. */
  timeoutMs?: number;
  /** Between polls. Default 3 s. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Find an order by the cOID it was placed with, after a placement whose
 * answer never arrived (timeout, 5xx, no order id). Polls the live orders and
 * the trades for ~30 s, matching `order_ref`. Null means not found — which is
 * NOT proof it was never placed (the order feed lags), so the caller must
 * treat the state as unknown and never re-place.
 *
 * `force=true` only on the first poll: CPAPI documents it as "clear the cache
 * and refetch", and the forced call itself answers with an empty list — every
 * later poll reads the refreshed cache.
 */
export async function findOrderByRef(ref: string, opts: FindOrderOpts = {}): Promise<FoundOrder | null> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 3_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();
  for (let poll = 0; ; poll++) {
    try {
      const resp = await bezantFetch<{ orders?: Array<Record<string, unknown>> }>(
        `/v1/api/iserver/account/orders${poll === 0 ? '?force=true' : ''}`,
      );
      const hit = (resp?.orders ?? []).map((o) => parseLiveOrder(o)).find((o) => o.orderRef === ref);
      if (hit && hit.orderId > 0) return { orderId: hit.orderId, status: hit.status, source: 'orders' };
    } catch (err) {
      logError(`findOrderByRef(${ref}): orders poll failed`, err);
    }
    try {
      const rows = await bezantFetch<Array<Record<string, unknown>>>(`/v1/api/iserver/account/trades`);
      const hit = (Array.isArray(rows) ? rows : []).find((t) => String(t.order_ref ?? '') === ref);
      const id = Number(hit?.order_id);
      if (hit && Number.isFinite(id) && id > 0) return { orderId: id, status: 'executed', source: 'trades' };
    } catch (err) {
      logError(`findOrderByRef(${ref}): trades poll failed`, err);
    }
    if (now() - start + pollMs > timeoutMs) return null;
    await sleep(pollMs);
  }
}
