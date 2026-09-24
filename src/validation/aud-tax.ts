/**
 * After-tax AUD evaluation for studies (2026-09-24 review, G6).
 *
 * WHY NOT src/tax/report.ts. That module is being rebuilt under WS-E (it
 * applies losses proportionally rather than to non-discount gains first,
 * carries no losses across years, reads the financial year in host-local time
 * and works in USD). A study that decides a live switch-on cannot inherit
 * those, so this is a small, separately tested implementation of the rules
 * the plan states — kept in validation/, used by no live path. Once WS-E's
 * single lot engine lands, the study should call it instead.
 *
 * RULES (plan E2–E4):
 *   - FIFO parcels. Cost base = (price·qty + buy brokerage) × AUD/USD at the
 *     buy date; capital proceeds = (price·qty − sell brokerage) × AUD/USD at
 *     the sell date.
 *   - The CGT event is the trade date; the 50% discount applies iff the sell
 *     date is on or after buy date + 1 year + 1 day.
 *   - Per financial year (July–June, by trade date): current-year losses,
 *     then carried-forward losses, applied to NON-discount gains first, then
 *     to discount gains; the 50% discount last. A net loss carries forward.
 *   - Dividends: gross AUD at the ex-date rate is assessable; the 15% US
 *     withholding is a foreign income tax offset against it.
 */
import { discountDate } from '../portfolio/drift-bands';

export interface StudyTrade {
  date: string; // YYYY-MM-DD, the exchange trade date
  symbol: string;
  action: 'BUY' | 'SELL';
  qty: number;
  /** USD per share, after slippage. */
  price: number;
  /** USD brokerage for the whole trade. */
  commission: number;
}

export interface FyCgt {
  fy: string;
  nonDiscountGains: number;
  discountGains: number;
  losses: number;
  lossesBroughtForward: number;
  netCapitalGain: number;
  lossesCarriedForward: number;
}

export interface CgtResult {
  years: FyCgt[];
  totalNetCapitalGain: number;
  /** Parcels disposed of before their discount date / on or after it. */
  nonDiscountDisposals: number;
  discountDisposals: number;
  /** Shares sold that found no parcel (should be 0 — a bug if not). */
  unmatchedQty: number;
}

/** "FY2026" = 1 Jul 2025 – 30 Jun 2026. */
export function financialYear(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `FY${m >= 7 ? y + 1 : y}`;
}

export function computeAudCgt(
  trades: readonly StudyTrade[],
  audPerUsd: (date: string) => number,
  lossesBroughtForward = 0,
): CgtResult {
  const sorted = [...trades].sort((a, b) =>
    a.date === b.date ? (a.action === b.action ? 0 : a.action === 'BUY' ? -1 : 1) : a.date.localeCompare(b.date));
  const parcels = new Map<string, Array<{ date: string; qty: number; costPerShareAud: number }>>();
  const perFy = new Map<string, { nd: number; d: number; loss: number }>();
  let nonDiscountDisposals = 0;
  let discountDisposals = 0;
  let unmatchedQty = 0;

  for (const t of sorted) {
    const rate = audPerUsd(t.date);
    if (t.action === 'BUY') {
      const list = parcels.get(t.symbol) ?? [];
      list.push({ date: t.date, qty: t.qty, costPerShareAud: ((t.price * t.qty + t.commission) * rate) / t.qty });
      parcels.set(t.symbol, list);
      continue;
    }
    const list = parcels.get(t.symbol) ?? [];
    const proceedsPerShareAud = ((t.price * t.qty - t.commission) * rate) / t.qty;
    const fy = financialYear(t.date);
    const acc = perFy.get(fy) ?? { nd: 0, d: 0, loss: 0 };
    let left = t.qty;
    while (left > 0 && list.length > 0) {
      const p = list[0];
      const take = Math.min(left, p.qty);
      const gain = take * (proceedsPerShareAud - p.costPerShareAud);
      const discounted = t.date >= discountDate(p.date);
      if (gain < 0) acc.loss += -gain;
      else if (discounted) acc.d += gain;
      else acc.nd += gain;
      if (discounted) discountDisposals++; else nonDiscountDisposals++;
      p.qty -= take;
      left -= take;
      if (p.qty <= 0) list.shift();
    }
    unmatchedQty += left;
    perFy.set(fy, acc);
  }

  const years: FyCgt[] = [];
  let carried = lossesBroughtForward;
  let total = 0;
  for (const fy of [...perFy.keys()].sort()) {
    const { nd, d, loss } = perFy.get(fy)!;
    let available = loss + carried;
    const broughtForward = carried;
    const ndAfter = Math.max(0, nd - available);
    available = Math.max(0, available - nd);
    const dAfter = Math.max(0, d - available);
    available = Math.max(0, available - d);
    const net = ndAfter + dAfter * 0.5;
    carried = available;
    total += net;
    years.push({
      fy, nonDiscountGains: nd, discountGains: d, losses: loss,
      lossesBroughtForward: broughtForward, netCapitalGain: net, lossesCarriedForward: carried,
    });
  }
  return { years, totalNetCapitalGain: total, nonDiscountDisposals, discountDisposals, unmatchedQty };
}

/**
 * Extra tax on dividends at `marginalRate`, after the foreign income tax
 * offset for US withholding (capped at the Australian tax on that income).
 */
export function dividendTaxAud(
  dividends: ReadonlyArray<{ date: string; grossUsd: number; withheldUsd: number }>,
  audPerUsd: (date: string) => number,
  marginalRate: number,
): number {
  let tax = 0;
  for (const d of dividends) {
    const rate = audPerUsd(d.date);
    const grossTax = d.grossUsd * rate * marginalRate;
    tax += grossTax - Math.min(grossTax, d.withheldUsd * rate);
  }
  return tax;
}
