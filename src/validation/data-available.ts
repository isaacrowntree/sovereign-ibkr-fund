import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * True when the backtest dataset is present. The data (Yahoo Finance daily bars)
 * is gitignored and NOT shipped — a fresh clone won't have it. Run
 * `npm run fetch-data` to generate it. The backtest test suites use this to
 * `describe.skipIf(!BACKTEST_DATA_AVAILABLE)` so a clone is green out of the box.
 */
export const BACKTEST_DATA_AVAILABLE = existsSync(
  resolve(__dirname, 'data', 'historical-daily.json'),
);

/**
 * The long-window dataset (reaches back through the 2022 bear; built with
 * FETCH_START/FETCH_OUT). The 2022/2023 scenario tests need it — the default
 * file starts 2023-10 and the engine now refuses out-of-range windows.
 */
export const LONG_DATA_AVAILABLE = existsSync(
  resolve(__dirname, 'data', 'historical-long.json'),
);

/**
 * The live-path study inputs (2026-09-24, G3/G4): the 35-name energy dataset
 * (all 19 live-shape names, 2020-09 →), AUD/USD and cash dividends. Built with
 * `FETCH_EXTRAS=1 pnpm fetch-data` (plus the energy dataset fetch).
 */
export const LIVE_STUDY_DATA_AVAILABLE = ['historical-energy.json', 'fx-audusd.json', 'dividends.json']
  .every(f => existsSync(resolve(__dirname, 'data', f)));
