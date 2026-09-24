import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The backtest suites (run only when the gitignored dataset is present)
    // replay years of daily data; on a loaded workstation several took 5-30s
    // and failed on vitest's 5s default without anything being wrong.
    testTimeout: 120_000,
  },
});
