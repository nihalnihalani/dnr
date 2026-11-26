/**
 * §9.5 and §9.6 statistics. Every function here is pure and deterministic (the bootstrap uses a
 * seeded PRNG), so `trial rescore --check` reproduces every number exactly.
 */
import { mulberry32 } from './prng';

/** z for a two-sided 95% interval. */
export const Z95 = 1.959963984540054;

/**
 * Wilson score interval (95%). `den = 0` gives the uninformative [0, 1].
 * Golden values (plan §9.6): 2/8 → 7–59%, 0/30 → 0–11.4%, 7/30 → 12–41%.
 */
export function wilson(num: number, den: number, z = Z95): [number, number] {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num < 0 || den < 0 || num > den)
    throw new RangeError(`wilson: invalid ${num}/${den}`);
  if (den === 0) return [0, 1];
  const p = num / den;
  const z2 = z * z;
  const centre = p + z2 / (2 * den);
  const half = z * Math.sqrt((p * (1 - p)) / den + z2 / (4 * den * den));
  const denom = 1 + z2 / den;
  const lo = num === 0 ? 0 : (centre - half) / denom;
  const hi = num === den ? 1 : (centre + half) / denom;
  return [Math.max(0, lo), Math.min(1, hi)];
}

export interface RatioOut {
  num: number;
  den: number;
  wilson: [number, number];
}

export function ratio(num: number, den: number): RatioOut {
  return { num, den, wilson: wilson(num, den) };
}

/** Percent with `digits` decimals. */
export function pct(x: number, digits = 0): string {
  return (x * 100).toFixed(digits);
}

/**
 * "2/8 (95% CI 7–59%)". Interval ends are whole percents, except a 0/n or n/n interval, whose
 * open end gets one decimal ("0/30 (95% CI 0–11.4%)"), matching the plan's renderings.
 */
export function formatRatio(r: RatioOut): string {
  const d = r.num === 0 || r.num === r.den ? 1 : 0;
  const lo = r.num === 0 ? '0' : pct(r.wilson[0], d);
  const hi = r.num === r.den && r.den > 0 ? '100' : pct(r.wilson[1], d);
  return `${r.num}/${r.den} (95% CI ${lo}–${hi}%)`;
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/**
 * Exact (binomial) McNemar test on the discordant pairs: b = only the first condition positive,
 * c = only the second. Two-sided p = min(1, 2·P(X ≤ min(b, c))) with X ~ Bin(b+c, 1/2).
 */
export function mcnemarExact(b: number, c: number): { b: number; c: number; n: number; p: number } {
  const n = b + c;
  if (n === 0) return { b, c, n, p: 1 };
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { b, c, n, p: Math.min(1, 2 * tail) };
}

/** Discordant counts for paired booleans (aligned arrays). */
export function discordant(a: readonly boolean[], b: readonly boolean[]): { b: number; c: number } {
  if (a.length !== b.length) throw new RangeError('discordant: length mismatch');
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && !b[i]) x++;
    if (!a[i] && b[i]) y++;
  }
  return { b: x, c: y };
}

export interface Agreement {
  n: number;
  raw: number | null;
  kappa: number | null;
  pabak: number | null;
  ac1: number | null;
}

/**
 * Two-rater agreement over aligned label arrays. `categories` is the full scheme (6 labels, or
 * the 2 binary values); PABAK and AC1 use its size, not the number of categories observed.
 */
export function agreement<T>(a: readonly T[], b: readonly T[], categories: readonly T[]): Agreement {
  if (a.length !== b.length) throw new RangeError('agreement: length mismatch');
  const n = a.length;
  if (n === 0) return { n, raw: null, kappa: null, pabak: null, ac1: null };
  const k = categories.length;
  let agree = 0;
  const ca = new Map<T, number>();
  const cb = new Map<T, number>();
  for (let i = 0; i < n; i++) {
    const x = a[i] as T;
    const y = b[i] as T;
    if (x === y) agree++;
    ca.set(x, (ca.get(x) ?? 0) + 1);
    cb.set(y, (cb.get(y) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const c of categories) pe += ((ca.get(c) ?? 0) / n) * ((cb.get(c) ?? 0) / n);
  const kappa = pe === 1 ? null : (po - pe) / (1 - pe);
  const pabak = k > 1 ? (k * po - 1) / (k - 1) : null;
  let peG = 0;
  for (const c of categories) {
    const pi = ((ca.get(c) ?? 0) + (cb.get(c) ?? 0)) / (2 * n);
    peG += pi * (1 - pi);
  }
  peG = k > 1 ? peG / (k - 1) : 0;
  const ac1 = peG === 1 ? null : (po - peG) / (1 - peG);
  return { n, raw: po, kappa, pabak, ac1 };
}

/** Percentile bootstrap CI of `stat` over resampled item indices (seeded, default seed 2026, B = 2000). */
export function bootstrapCI(
  n: number,
  stat: (idx: number[]) => number | null,
  opts: { seed?: number; reps?: number } = {},
): [number, number] | null {
  if (n === 0) return null;
  const rnd = mulberry32(opts.seed ?? 2026);
  const reps = opts.reps ?? 2000;
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(Math.floor(rnd() * n));
    const v = stat(idx);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return null;
  vals.sort((x, y) => x - y);
  const at = (q: number) =>
    vals[Math.min(vals.length - 1, Math.max(0, Math.floor(q * vals.length)))] as number;
  return [at(0.025), at(0.975)];
}

export interface AgreementReport extends Agreement {
  ci: {
    raw: [number, number] | null;
    kappa: [number, number] | null;
    pabak: [number, number] | null;
    ac1: [number, number] | null;
  };
}

/** Agreement plus bootstrap 95% CIs on each coefficient (§9.5 reporting). */
export function agreementReport<T>(
  a: readonly T[],
  b: readonly T[],
  categories: readonly T[],
  opts: { seed?: number; reps?: number } = {},
): AgreementReport {
  const base = agreement(a, b, categories);
  const pick = (key: keyof Agreement) =>
    bootstrapCI(
      a.length,
      (idx) => {
        const r = agreement(
          idx.map((i) => a[i] as T),
          idx.map((i) => b[i] as T),
          categories,
        );
        return r[key] as number | null;
      },
      opts,
    );
  return { ...base, ci: { raw: pick('raw'), kappa: pick('kappa'), pabak: pick('pabak'), ac1: pick('ac1') } };
}
