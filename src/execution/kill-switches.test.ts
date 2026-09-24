import { describe, it, expect } from 'vitest';
import { executionDisabledReason, runBudgetMs } from './kill-switches.js';

describe('EXECUTION_ENABLED', () => {
  it('is on by default — no env, no state key', () => {
    expect(executionDisabledReason({}, undefined)).toBeNull();
  });

  it('env off stops execution whatever the state says', () => {
    for (const v of ['0', 'false', 'OFF', 'no']) {
      expect(executionDisabledReason({ EXECUTION_ENABLED: v }, true)).toMatch(/EXECUTION_ENABLED/);
    }
  });

  it('the hub toggle (state executionEnabled=false) stops execution', () => {
    expect(executionDisabledReason({}, false)).toMatch(/paused/);
  });

  it('only an explicit false in state counts — null, true or junk leave it on', () => {
    for (const v of [null, true, 'false', 0]) expect(executionDisabledReason({}, v)).toBeNull();
  });
});

describe('RUN_BUDGET_SEC', () => {
  it('defaults to 240 s', () => {
    expect(runBudgetMs({})).toBe(240_000);
    expect(runBudgetMs({ RUN_BUDGET_SEC: '' })).toBe(240_000);
  });

  it('0 (or nonsense) turns it off', () => {
    expect(runBudgetMs({ RUN_BUDGET_SEC: '0' })).toBe(0);
    expect(runBudgetMs({ RUN_BUDGET_SEC: 'abc' })).toBe(0);
  });

  it('takes a number of seconds', () => {
    expect(runBudgetMs({ RUN_BUDGET_SEC: '600' })).toBe(600_000);
  });
});
