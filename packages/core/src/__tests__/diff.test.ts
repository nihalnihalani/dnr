import { diffArrays } from 'diff';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffTokens } from '../diff';
import { multiset } from '../multiset';
import { sha256Hex } from '../sha256';

const RUNS = Number(process.env.DNR_FC_RUNS ?? 500);
const tok = fc.constantFrom('a', 'b', 'c', 'd', '(', ')', 'return', 'self', '=', 'x');

describe('diffTokens wraps jsdiff diffArrays', () => {
  it('equals the concatenated added/removed parts of diffArrays', () => {
    fc.assert(
      fc.property(fc.array(tok, { maxLength: 40 }), fc.array(tok, { maxLength: 40 }), (a, b) => {
        const parts = diffArrays(a, b);
        const A = parts.filter((p) => p.added).flatMap((p) => p.value);
        const R = parts.filter((p) => p.removed).flatMap((p) => p.value);
        expect(diffTokens(a, b)).toEqual({ A, R });
      }),
      { numRuns: RUNS },
    );
  });
  it('before − R + A = after, as multisets', () => {
    fc.assert(
      fc.property(fc.array(tok, { maxLength: 40 }), fc.array(tok, { maxLength: 40 }), (a, b) => {
        const { A, R } = diffTokens(a, b);
        const m = multiset(a);
        for (const r of R) m.set(r, (m.get(r) ?? 0) - 1);
        for (const x of A) m.set(x, (m.get(x) ?? 0) + 1);
        for (const [k, v] of m) if (v === 0) m.delete(k);
        expect(m).toEqual(multiset(b));
      }),
      { numRuns: RUNS },
    );
  });
  it('is empty for equal inputs and total for disjoint ones', () => {
    expect(diffTokens(['a', 'b'], ['a', 'b'])).toEqual({ A: [], R: [] });
    expect(diffTokens(['a'], ['b'])).toEqual({ A: ['b'], R: ['a'] });
    expect(diffTokens([], ['b'])).toEqual({ A: ['b'], R: [] });
    expect(diffTokens(['a'], [])).toEqual({ A: [], R: ['a'] });
  });
});

describe('sha256Hex', () => {
  it('matches the standard test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
    expect(sha256Hex('☃')).toBe('51643361c79ecaef25a8de802de24f570ba25d9c2df1d22d94fade11b4f466cc');
  });
});
