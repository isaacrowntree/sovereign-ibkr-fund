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
