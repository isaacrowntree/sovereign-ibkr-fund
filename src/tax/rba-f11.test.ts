import { describe, it, expect } from 'vitest';
import { parseF11Csv, f11Lookup } from './rba-f11';

describe('RBA F11 fallback', () => {
  it('reads the F11 layout (FXRUSD is USD per AUD) and inverts it', () => {
    const csv = [
      'F11 EXCHANGE RATES',
      'Title,A$1=USD,Trade-weighted Index',
      'Series ID,FXRUSD,FXRTWI',
      '02-Jan-2025,0.6200,60.1',
      '03-Jan-2025,0.6250,60.3',
    ].join('\n');
    const rates = parseF11Csv(csv);
    expect(rates.get('2025-01-02')).toBeCloseTo(1 / 0.62, 9);
    expect(rates.size).toBe(2);
  });

  it('reads a plain date,usdPerAud file, and falls back to the last earlier rate within a week', () => {
    const look = f11Lookup(parseF11Csv('2025-01-03,0.625\n'));
    expect(look('2025-01-05')).toBeCloseTo(1.6, 9); // Sunday → Friday's rate
    expect(look('2025-01-20')).toBeUndefined();
  });
});
