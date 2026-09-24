import { describe, it, expect } from 'vitest';
import { summariseStderr } from './stderr.mjs';

// A bare `adapter_failed` hid an IP-whitelist rejection, a key without trade
// permission for three days, and "quantity has too much precision". The one
// line that explains a failure is already in stderr_excerpt; this finds it.
describe('summariseStderr', () => {
  it('takes the FATAL line a run writes on the way out', () => {
    const s = '[data] noise\nFATAL: Binance API key rejected. Check that the trusted IP whitelist includes this server.\n';
    expect(summariseStderr(s)).toBe('Binance API key rejected. Check that the trusted IP whitelist includes this server.');
  });

  it('takes run-agent.sh refusals', () => {
    expect(summariseStderr('[run-agent] FATAL: dist/ does not match src/ — refusing to trade on stale code.\n[run-agent] built from : abc'))
      .toBe('dist/ does not match src/ — refusing to trade on stale code.');
  });

  it('takes the last FATAL when there are several', () => {
    expect(summariseStderr('FATAL: first\nFATAL: second')).toBe('second');
  });

  it('reads the older Node "Fatal error: Error: …" dump, first line only', () => {
    const s = "Fatal error: Error: Parameter 'quantity' has too much precision.\n    at /x/http-client.js:132:17\n    at process.processTicksAndRejections";
    expect(summariseStderr(s)).toBe("Parameter 'quantity' has too much precision.");
  });

  it('reads the fund agents\' "ERROR: Fatal — …" lines', () => {
    const s = '[02:15:48] ERROR: gateway connect: bezant-server 401 on /health\n[02:15:48] [Hedger] ERROR: Fatal — bezant-server 401 on /health: gateway is not authenticated\n';
    expect(summariseStderr(s)).toBe('bezant-server 401 on /health: gateway is not authenticated');
  });

  it('falls back to a plain ERROR line', () => {
    expect(summariseStderr('[t] ERROR: something broke\n')).toBe('something broke');
  });

  it('nothing recognisable → null', () => {
    expect(summariseStderr('')).toBeNull();
    expect(summariseStderr(null)).toBeNull();
    expect(summariseStderr('[run-agent] WARNING: dist/.build-stamp missing')).toBeNull();
  });

  it('redacts signatures, API keys and IBKR account ids', () => {
    const s = 'FATAL: https://api.example.com/order?timestamp=1&signature=deadbeefcafe apiKey=AbC123xyz account U1234567 and DU7654321';
    const out = summariseStderr(s)!;
    expect(out).not.toContain('deadbeefcafe');
    expect(out).not.toContain('AbC123xyz');
    expect(out).not.toContain('U1234567');
    expect(out).not.toContain('DU7654321');
  });

  it('caps the length', () => {
    expect(summariseStderr('FATAL: ' + 'x'.repeat(500))!.length).toBeLessThanOrEqual(160);
  });
});
