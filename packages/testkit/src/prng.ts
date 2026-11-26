import { sha256Hex } from '@dnr/core';

/** mulberry32: a small, fast, deterministic 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PRNG keyed by a string (e.g. `family:seed:revert_sha`), via SHA-256. */
export function keyedRng(key: string): () => number {
  return mulberry32(Number.parseInt(sha256Hex(key).slice(0, 8), 16));
}

export function pickOne<T>(rng: () => number, xs: readonly T[]): T | undefined {
  return xs.length ? xs[Math.floor(rng() * xs.length)] : undefined;
}

export function shuffle<T>(rng: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
