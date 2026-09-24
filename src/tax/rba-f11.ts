/**
 * RBA F11 exchange rates — the FALLBACK source of AUD per USD, used only for
 * a trade IBKR gave no rate for. The primary source is IBKR's per-trade
 * fxRate (lots.ts), because that is the figure on the broker statements.
 *
 * Reads the RBA's own F11 CSV (the `FXRUSD` column is USD per 1 AUD) or a
 * plain `date,usdPerAud` file. A date with no published rate (weekend,
 * holiday) takes the most recent earlier rate within 7 days.
 */
import { addDays, type IsoDate } from './au-dates.js';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseDate(s: string): IsoDate | undefined {
  const t = s.trim().replace(/^"|"$/g, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  return undefined;
}

/** Map of date → AUD per USD. */
export function parseF11Csv(csv: string): Map<IsoDate, number> {
  const lines = csv.split(/\r?\n/);
  let col = 1;
  for (const l of lines) {
    const cells = l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const i = cells.indexOf('FXRUSD');
    if (i > 0) { col = i; break; }
  }
  const out = new Map<IsoDate, number>();
  for (const l of lines) {
    const cells = l.split(',');
    const date = parseDate(cells[0] ?? '');
    const usdPerAud = Number((cells[col] ?? '').trim());
    if (date && usdPerAud > 0) out.set(date, 1 / usdPerAud);
  }
  return out;
}

export function f11Lookup(rates: Map<IsoDate, number>, maxBackDays = 7): (date: IsoDate) => number | undefined {
  return (date) => {
    for (let back = 0; back <= maxBackDays; back++) {
      const r = rates.get(addDays(date, -back));
      if (r != null) return r;
    }
    return undefined;
  };
}
