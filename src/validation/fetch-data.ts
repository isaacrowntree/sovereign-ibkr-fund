/**
 * Fetch 2+ years of daily historical data from Yahoo Finance
 * for PLTR, AMZN, TWLO, ARM, TSLA, BRK-B
 *
 * Usage: npx tsx src/validation/fetch-data.ts
 */
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const SYMBOLS = [
  // Existing 13-stock universe
  'PLTR', 'AMZN', 'TWLO', 'ARM', 'TSLA', 'BRK-B', 'NET',
  'GE', 'CAT', 'AVGO',
  'LLY', 'JNJ',
  'GS',
  'GLD', 'WMT', 'KO',
  // ETFs: high-performers + uncorrelated hedges
  'SMH',   // Semiconductors
  'QQQ',   // Nasdaq-100
  'VXUS',  // International developed
  'TLT',   // Long treasuries
  'VNQ',   // REITs
  'XLE',   // Energy
];

// ARM IPO'd Sep 14, 2023 — start from Oct 1, 2023 for all. Overridable, because
// that IPO is the ONLY reason the default sample is short, and the default sample
// therefore contains no bear market. Dropping ARM reaches back to 2020-10 (the
// 2022 drawdown); dropping ARM and PLTR reaches 2019-10 (COVID as well). Any
// conclusion about drawdown behaviour needs one of those windows.
const START_DATE = new Date(process.env.FETCH_START || '2023-10-01');
const END_DATE = new Date(); // today

interface DailyBar {
  date: string;       // YYYY-MM-DD
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose: number;
}

async function fetchYahoo(symbol: string): Promise<DailyBar[]> {
  const period1 = Math.floor(START_DATE.getTime() / 1000);
  const period2 = Math.floor(END_DATE.getTime() / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance returned ${res.status} for ${symbol}`);
  }

  const json = await res.json() as any;
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);

  const timestamps: number[] = result.timestamp;
  const quotes = result.indicators?.quote?.[0];
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose;

  const bars: DailyBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quotes.open[i];
    const h = quotes.high[i];
    const l = quotes.low[i];
    const c = quotes.close[i];
    const v = quotes.volume[i];
    const ac = adjClose?.[i] ?? c;

    if (o == null || h == null || l == null || c == null) continue;

    const d = new Date(timestamps[i] * 1000);
    bars.push({
      date: d.toISOString().slice(0, 10),
      timestamp: timestamps[i] * 1000,
      open: Math.round(o * 100) / 100,
      high: Math.round(h * 100) / 100,
      low: Math.round(l * 100) / 100,
      close: Math.round(c * 100) / 100,
      volume: Math.round(v),
      adjClose: Math.round(ac * 100) / 100,
    });
  }

  return bars;
}

/**
 * The inputs a LIVE-path study needs besides prices (2026-09-24 review, G3/G4):
 *   fx-audusd.json — { "YYYY-MM-DD": AUD per 1 USD }, from Yahoo's AUDUSD=X.
 *   dividends.json — { SYMBOL: [{ date: ex-date, amount: USD/share }] }, the
 *     split-adjusted cash dividends, so a study can pay them as cash (net of
 *     withholding) instead of reinvesting them through adjusted closes.
 * Run with FETCH_EXTRAS=1 (and FETCH_START for the window); FETCH_SYMBOLS
 * overrides the universe for the dividend pull.
 */
async function fetchExtras(dataDir: string): Promise<void> {
  const period1 = Math.floor(START_DATE.getTime() / 1000);
  const period2 = Math.floor(END_DATE.getTime() / 1000);
  const get = async (symbol: string, extra = ''): Promise<any> => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d${extra}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status} for ${symbol}`);
    const r = ((await res.json()) as any).chart?.result?.[0];
    if (!r) throw new Error(`No data for ${symbol}`);
    return r;
  };

  const fxRaw = await get('AUDUSD=X');
  const fx: Record<string, number> = {};
  fxRaw.timestamp.forEach((t: number, i: number) => {
    const usdPerAud = fxRaw.indicators?.quote?.[0]?.close?.[i];
    if (typeof usdPerAud === 'number' && usdPerAud > 0) {
      fx[new Date(t * 1000).toISOString().slice(0, 10)] = Math.round((1 / usdPerAud) * 1e6) / 1e6;
    }
  });
  writeFileSync(resolve(dataDir, 'fx-audusd.json'), JSON.stringify(fx));
  console.log(`fx-audusd.json: ${Object.keys(fx).length} days`);

  const universe = process.env.FETCH_SYMBOLS ? process.env.FETCH_SYMBOLS.split(',') : SYMBOLS;
  const divs: Record<string, Array<{ date: string; amount: number }>> = {};
  for (const symbol of universe) {
    const r = await get(symbol, '&events=div');
    divs[symbol] = Object.values((r.events?.dividends ?? {}) as Record<string, { amount: number; date: number }>)
      .map(d => ({ date: new Date(d.date * 1000).toISOString().slice(0, 10), amount: d.amount }))
      .sort((a, b) => a.date.localeCompare(b.date));
    console.log(`  ${symbol}: ${divs[symbol].length} dividends`);
    await new Promise(res => setTimeout(res, 300));
  }
  writeFileSync(resolve(dataDir, 'dividends.json'), JSON.stringify(divs));
}

async function main() {
  const dataDir = resolve(__dirname, 'data');
  mkdirSync(dataDir, { recursive: true });
  if (process.env.FETCH_EXTRAS === '1') {
    await fetchExtras(dataDir);
    return;
  }

  const allData: Record<string, DailyBar[]> = {};

  for (const symbol of SYMBOLS) {
    console.log(`Fetching ${symbol}...`);
    const bars = await fetchYahoo(symbol);
    allData[symbol] = bars;
    console.log(`  ${bars.length} bars: ${bars[0]?.date} → ${bars[bars.length - 1]?.date}, $${bars[0]?.close} → $${bars[bars.length - 1]?.close}`);

    // Small delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  // Write combined file
  const outPath = resolve(dataDir, process.env.FETCH_OUT || 'historical-daily.json');
  writeFileSync(outPath, JSON.stringify(allData, null, 2));
  console.log(`\nWritten to ${outPath}`);
  console.log(`Total size: ${(JSON.stringify(allData).length / 1024).toFixed(0)} KB`);
}

main().catch(console.error);
