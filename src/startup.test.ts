import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  agentStartup,
  assertLiveStrategyConfig,
  assertNotifierConfigured,
  effectiveConfig,
  flattenConfig,
} from './startup.js';
import { config } from './config.js';

const saved = { ...process.env };
beforeEach(() => {
  for (const k of ['TRADING_MODE', 'NOTIFIER', 'IBKR_FUND_ALERT_WEBHOOK', 'OPTIMIZER', 'ENABLE_REGIME']) delete process.env[k];
});
afterEach(() => { process.env = { ...saved }; });

describe('assertNotifierConfigured — now on every --once agent, not just the daemon', () => {
  it('live with no webhook refuses to start', () => {
    process.env.TRADING_MODE = 'live';
    expect(() => assertNotifierConfigured()).toThrow(/no notifier is configured/);
  });
  it('live with a webhook starts', () => {
    process.env.TRADING_MODE = 'live';
    process.env.IBKR_FUND_ALERT_WEBHOOK = 'https://hooks.example.test/x';
    expect(() => assertNotifierConfigured()).not.toThrow();
  });
  it('an explicit NOTIFIER=noop is a deliberate choice and is honoured', () => {
    process.env.TRADING_MODE = 'live';
    process.env.NOTIFIER = 'noop';
    expect(() => assertNotifierConfigured()).not.toThrow();
  });
  it('paper mode never refuses', () => {
    expect(() => assertNotifierConfigured()).not.toThrow();
  });
});

describe('assertLiveStrategyConfig — live must name its optimizer', () => {
  it('live without OPTIMIZER refuses', () => {
    process.env.TRADING_MODE = 'live';
    expect(() => assertLiveStrategyConfig()).toThrow(/OPTIMIZER is not set/);
    process.env.OPTIMIZER = '  ';
    expect(() => assertLiveStrategyConfig()).toThrow();
  });
  it('live with OPTIMIZER, or paper without it, starts', () => {
    process.env.TRADING_MODE = 'live';
    process.env.OPTIMIZER = 'static';
    expect(() => assertLiveStrategyConfig()).not.toThrow();
    delete process.env.OPTIMIZER;
    process.env.TRADING_MODE = 'paper';
    expect(() => assertLiveStrategyConfig()).not.toThrow();
  });
  it('agentStartup applies it only when asked (the strategist), so a risk run is never blocked by it', () => {
    process.env.TRADING_MODE = 'live';
    process.env.IBKR_FUND_ALERT_WEBHOOK = 'https://hooks.example.test/x';
    expect(() => agentStartup('RiskManager')).not.toThrow();
    expect(() => agentStartup('PortfolioStrategist', { requireExplicitOptimizer: true })).toThrow(/OPTIMIZER/);
  });
});

describe('effective config logging', () => {
  it('flattens nested config and redacts credentials and the account id', () => {
    const flat = flattenConfig({
      bezant: { url: 'http://x', accountId: 'ACCT-TEST', cfAccessClientSecret: 's3cret', cfAccessClientId: undefined },
      risk: { maxLeverage: 1 },
    });
    expect(flat['bezant.url']).toBe('http://x');
    expect(flat['bezant.accountId']).toBe('[redacted]');
    expect(flat['bezant.cfAccessClientSecret']).toBe('[redacted]');
    expect(flat['bezant.cfAccessClientId']).toBeUndefined();
    expect(flat['risk.maxLeverage']).toBe(1);
  });

  it('names every kill switch, set or not, and never prints the webhook', () => {
    process.env.IBKR_FUND_ALERT_WEBHOOK = 'https://hooks.example.test/SECRET';
    process.env.NOTIFY_OUTBOX = '1';
    const eff = effectiveConfig(config);
    const text = JSON.stringify(eff);
    expect(eff.NOTIFY_OUTBOX).toBe('1');
    expect(eff.EXECUTION_ENABLED).toBe('(unset)');
    expect(eff.notifier).toBe('webhook');
    expect(text).not.toContain('SECRET');
  });
});

describe('safe defaults', () => {
  it('the live config defaults to static weights and no regime overlay', () => {
    // config is evaluated at import; a local .env could set these, so only
    // assert the default when nothing did.
    if (!saved.OPTIMIZER) expect(config.strategy.optimizer).toBe('static');
    if (!saved.ENABLE_REGIME) expect(config.strategy.enableRegimeOverlay).toBe(false);
  });

  it('dead fields are gone', () => {
    const c = config as unknown as Record<string, unknown> & { strategy: Record<string, unknown> };
    expect(c.ib).toBeUndefined();
    expect(c.logLevel).toBeUndefined();
    expect(c.strategy.lookbackDays).toBeUndefined();
    expect(c.strategy.enableVolTargeting).toBeUndefined();
    expect(config.risk.maxLeverage).toBeTypeOf('number'); // still used by risk-manager
  });
});
