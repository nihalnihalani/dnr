import { describe, expect, it } from 'vitest';
import {
  agreement,
  agreementReport,
  bootstrapCI,
  discordant,
  formatRatio,
  mcnemarExact,
  ratio,
  wilson,
} from './stats';

describe('TRIAL-11 stats: Wilson 95%', () => {
  it('stats: golden values from §9.6 (2/8 → 7–59%, 0/30 → 0–11.4%, 7/30 → 12–41%)', () => {
    const [a, b] = wilson(2, 8);
    expect(a).toBeCloseTo(0.0715, 4);
    expect(b).toBeCloseTo(0.5907, 4);
    const [c, d] = wilson(0, 30);
    expect(c).toBe(0);
    expect(d).toBeCloseTo(0.1135, 4);
    const [e, f] = wilson(7, 30);
    expect(e).toBeCloseTo(0.1179, 4);
    expect(f).toBeCloseTo(0.4093, 4);
    expect(formatRatio(ratio(2, 8))).toBe('2/8 (95% CI 7–59%)');
    expect(formatRatio(ratio(0, 30))).toBe('0/30 (95% CI 0–11.4%)');
    expect(formatRatio(ratio(7, 30))).toBe('7/30 (95% CI 12–41%)');
  });

  it('stats: hand-computed 1/1, n/n and 0/0 edges', () => {
    // 1/1: lower = 1/(1+z²) = 1/4.8415 = 0.2065
    expect(wilson(1, 1)[0]).toBeCloseTo(0.2065, 4);
    expect(wilson(1, 1)[1]).toBe(1);
    expect(wilson(0, 0)).toEqual([0, 1]);
    expect(() => wilson(3, 2)).toThrow();
  });
});

describe('TRIAL-11 stats: exact McNemar', () => {
  it('stats: two-sided binomial p on discordant pairs (hand-computed)', () => {
    // b=5, c=1: 2·(C(6,0)+C(6,1))/2^6 = 2·7/64 = 0.21875
    expect(mcnemarExact(5, 1).p).toBeCloseTo(0.21875, 10);
    // b=7, c=0: 2/2^7 = 0.015625
    expect(mcnemarExact(7, 0).p).toBeCloseTo(0.015625, 10);
    // b=c: p capped at 1
    expect(mcnemarExact(3, 3).p).toBe(1);
    expect(mcnemarExact(0, 0)).toEqual({ b: 0, c: 0, n: 0, p: 1 });
    // b=10, c=2: 2·(1+12+66)/4096 = 0.0385742…
    expect(mcnemarExact(10, 2).p).toBeCloseTo(158 / 4096, 10);
  });

  it('stats: discordant counts from paired booleans', () => {
    expect(discordant([true, true, false, false], [true, false, true, false])).toEqual({ b: 1, c: 1 });
  });
});

describe('TRIAL-10 stats: agreement (κ, PABAK, AC1)', () => {
  const A = [1, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  const B = [1, 0, 0, 0, 1, 0, 1, 1, 1, 1];
  it('stats: binary κ, PABAK and AC1 equal the hand-computed values', () => {
    // po = 0.8; pe = 0.6·0.6 + 0.4·0.4 = 0.52; κ = 0.28/0.48
    const g = agreement(A, B, [0, 1]);
    expect(g.raw).toBeCloseTo(0.8, 12);
    expect(g.kappa).toBeCloseTo(0.28 / 0.48, 12);
    // PABAK = 2·0.8 − 1
    expect(g.pabak).toBeCloseTo(0.6, 12);
    // AC1: π1 = 0.6, pe = 2·0.6·0.4 = 0.48 → (0.8 − 0.48)/0.52
    expect(g.ac1).toBeCloseTo(0.32 / 0.52, 12);
  });

  it('stats: 6-class PABAK uses the scheme size; κ undefined when one category is used throughout', () => {
    const L = ['FULL', 'CORE', 'PARTIAL_NONCORE', 'NONE', 'UNRELATED_BREAK', 'NO_CHANGE'];
    const g = agreement(['NONE', 'FULL', 'NONE'], ['NONE', 'CORE', 'NONE'], L);
    // po = 2/3 → PABAK = (6·2/3 − 1)/5 = 0.6
    expect(g.pabak).toBeCloseTo(0.6, 12);
    expect(agreement(['NONE', 'NONE'], ['NONE', 'NONE'], L).kappa).toBeNull();
  });

  it('stats: bootstrap CIs are deterministic (seed 2026) and bracket the estimate', () => {
    const r1 = agreementReport(A, B, [0, 1], { reps: 500 });
    const r2 = agreementReport(A, B, [0, 1], { reps: 500 });
    expect(r1.ci).toEqual(r2.ci);
    const ci = r1.ci.raw as [number, number];
    expect(ci[0]).toBeLessThanOrEqual(0.8);
    expect(ci[1]).toBeGreaterThanOrEqual(0.8);
    expect(bootstrapCI(0, () => 1)).toBeNull();
  });
});
