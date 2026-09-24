import { describe, it, expect } from 'vitest';
import { buildStressInputs } from './stress-inputs.js';
import { pairwiseCovMatrix, sampleCovMatrix } from '../portfolio/covariance.js';

const walk = (n: number, seed: number): number[] => {
  let p = 100;
  let x = seed;
  const out = [p];
  for (let i = 1; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    p *= 1 + (x / 233280 - 0.5) * 0.04;
    out.push(p);
  }
  return out;
};

describe('pairwiseCovMatrix', () => {
  it('equals the sample covariance when every series has the same length', () => {
    const a = [0.01, -0.02, 0.03, 0.0, 0.01];
    const b = [0.02, -0.01, 0.01, 0.01, -0.02];
    const p = pairwiseCovMatrix([a, b]);
    const s = sampleCovMatrix([a, b]);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) expect(p[i][j]).toBeCloseTo(s[i][j], 12);
  });

  it('uses each pair\'s overlapping (right-anchored) window, not the shortest series for all', () => {
    const long = [0.05, -0.05, 0.05, -0.05, 0.01, -0.02, 0.03];
    const short = [0.01, -0.02, 0.03];
    const p = pairwiseCovMatrix([long, short]);
    // The long name's own variance uses all 7 observations...
    expect(p[0][0]).toBeCloseTo(sampleCovMatrix([long])[0][0], 12);
    // ...and the cross term uses only the 3 they share.
    expect(p[0][1]).toBeCloseTo(sampleCovMatrix([long.slice(-3), short])[0][1], 12);
  });
});

describe('buildStressInputs', () => {
  const symbols = ['AAA', 'BBB', 'NEW'];
  const history = { AAA: walk(200, 1), BBB: walk(200, 2), NEW: walk(20, 3) };

  it('excludes a name with too little history instead of shortening everyone', () => {
    const r = buildStressInputs(symbols, [0.5, 0.4, 0.1], history, 60);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inputs.included).toEqual(['AAA', 'BBB']);
    expect(r.inputs.weights).toEqual([0.5, 0.4]);
    expect(r.inputs.excluded).toEqual([{ symbol: 'NEW', observations: 19, weight: 0.1 }]);
    expect(r.inputs.excludedWeight).toBeCloseTo(0.1, 12);
    // The two long names keep their full 199-return window.
    expect(r.inputs.cov[0][0]).toBeCloseTo(sampleCovMatrix([
      history.AAA.slice(1).map((p, i) => (p - history.AAA[i]) / history.AAA[i]),
    ])[0][0], 12);
  });

  it('says why when it cannot run', () => {
    expect(buildStressInputs(symbols, null, history)).toMatchObject({ ok: false, reason: expect.stringContaining('no model weights') });
    expect(buildStressInputs(symbols, [1, 0], history)).toMatchObject({ ok: false, reason: expect.stringContaining('model recently changed') });
    expect(buildStressInputs(symbols, [0.5, 0.4, 0.1], null)).toMatchObject({ ok: false, reason: expect.stringContaining('no price history') });
    expect(buildStressInputs(symbols, [0.5, 0.4, 0.1], { AAA: walk(200, 1) })).toMatchObject({ ok: false, reason: expect.stringContaining('only 1 holding') });
  });
});
