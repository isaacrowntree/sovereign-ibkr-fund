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

// ARM IPO'd Sep 14, 2023 — start from Oct 1, 2023 for all
const START_DATE = new Date('2023-10-01');
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

async function main() {
  const dataDir = resolve(__dirname, 'data');
  mkdirSync(dataDir, { recursive: true });

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
  const outPath = resolve(dataDir, 'historical-daily.json');
  writeFileSync(outPath, JSON.stringify(allData, null, 2));
  console.log(`\nWritten to ${outPath}`);
  console.log(`Total size: ${(JSON.stringify(allData).length / 1024).toFixed(0)} KB`);
}

main().catch(console.error);
