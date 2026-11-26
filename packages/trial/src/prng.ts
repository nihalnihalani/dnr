/** Deterministic helpers: seeded PRNG, seeded shuffle, sha256-keyed choices. */
import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** mulberry32: small, fast, deterministic 32-bit PRNG returning floats in [0, 1). */
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

/** Fisher–Yates shuffle with a seeded PRNG; returns a new array. */
export function seededShuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** A seed derived from a string key (first 32 bits of its sha256). */
export function seedFrom(key: string): number {
  return Number.parseInt(sha256Hex(key).slice(0, 8), 16);
}

/** sha256(key) as a BigInt, reduced mod m. */
export function sha256Mod(key: string, m: number): number {
  return Number(BigInt(`0x${sha256Hex(key)}`) % BigInt(m));
}

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A random 6-character packet code (crypto-random; uniqueness is enforced by the caller). */
export function randomCode(rand: (n: number) => Buffer = randomBytes): string {
  let s = '';
  while (s.length < 6) {
    for (const b of rand(12)) {
      if (b >= 248) continue; // 248 = 8 * 31: reject to keep the alphabet uniform
      s += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (s.length === 6) break;
    }
  }
  return s;
}
