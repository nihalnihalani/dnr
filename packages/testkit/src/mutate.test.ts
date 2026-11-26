import { buildOrder, createState, type ParserProvider, scoreOrder, UnitCache } from '@dnr/core';
import { loadGrammarsNode } from '@dnr/grammar/node';
import { beforeAll, describe, expect, it } from 'vitest';
import { LINKS, SHA_C, SHA_R, SHA_S } from './cases';
import { MUTATION_FIXTURES, type MutationFixture } from './fixtures';
import {
  MUTATION_FAMILIES,
  type Mutant,
  MutantShortfallError,
  mutantSet,
  mutants,
  mutate,
  SEEDS,
  seedsFor,
} from './mutate';

let P: ParserProvider;
beforeAll(async () => {
  P = await loadGrammarsNode();
});

function orderFor(fx: MutationFixture) {
  const r = buildOrder({
    provider: P,
    original_sha: SHA_C,
    revert_sha: SHA_R,
    snapshot_sha: SHA_S,
    files: [{ path: fx.path, before: fx.before, after: fx.after, post_revert: fx.before }],
    links: LINKS,
    at: '2026-11-26T00:00:00Z',
    status: 'approved',
  });
  if (!r.ok) throw new Error('no order');
  return r;
}

const input = (fx: MutationFixture, family: (typeof MUTATION_FAMILIES)[number], text = fx.after) => {
  const r = orderFor(fx);
  return {
    provider: P,
    family,
    revertSha: SHA_R,
    files: [{ path: fx.path, text, baseline: fx.before }],
    units: r.order.units.map((u) => ({ file: u.file, qualname: u.qualname })),
  };
};

function parsesClean(path: string, text: string): boolean {
  const g = path.endsWith('.py') ? 'python' : 'typescript';
  const t = P.parse(g, text);
  const ok = !t.rootNode.hasError;
  t.delete?.();
  return ok;
}

describe('M4: no silent mutant shortfall', () => {
  it('mutantSet reports seeds that produced no mutant, and mutants() throws', () => {
    // a unit with no if-statement: invert-condition cannot apply to any seed
    const path = 'm.py';
    const before = 'def f(a):\n    return a\n';
    const after = 'def f(a):\n    b = a * 2\n    return b\n';
    const r = buildOrder({
      provider: P,
      original_sha: SHA_C,
      revert_sha: SHA_R,
      snapshot_sha: SHA_S,
      files: [{ path, before, after, post_revert: before }],
      links: LINKS,
      at: '2026-11-26T00:00:00Z',
    });
    if (!r.ok) throw new Error('no order');
    const inp = {
      provider: P,
      family: 'invert-condition' as const,
      revertSha: SHA_R,
      files: [{ path, text: after, baseline: before }],
      units: r.order.units.map((u) => ({ file: u.file, qualname: u.qualname })),
    };
    const set = mutantSet(inp);
    expect(set).toMatchObject({ expected: 5, mutants: [], missing: SEEDS.heldOut });
    expect(() => mutants(inp)).toThrow(MutantShortfallError);
    expect(() => mutants(inp)).toThrow(/produced 0 of 5 valid mutants/);
  });
});

describe('seeds', () => {
  it('match the plan', () => {
    expect(SEEDS.tune).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(SEEDS.heldOut).toEqual([2000, 2001, 2002, 2003, 2004]);
    expect(SEEDS.split).toEqual([3000, 3001, 3002, 3003, 3004]);
    expect(SEEDS.moveHeldOut).toEqual([3100, 3101, 3102, 3103, 3104]);
    expect(SEEDS.moveTune).toEqual([3105, 3106, 3107, 3108, 3109]);
    expect(seedsFor('move-to-file', 'tune')).toEqual(SEEDS.moveTune);
  });
});

describe.each(MUTATION_FIXTURES.map((f) => [f.name, f] as const))('mutation operators on %s', (_name, fx) => {
  it.each(MUTATION_FAMILIES.map((f) => [f]))('%s: five valid, deterministic mutants', (family) => {
    const ms = mutants(input(fx, family));
    expect(ms).toHaveLength(5);
    for (const m of ms) {
      for (const session of m.sessions) {
        for (const w of session) {
          expect(w.text).not.toBeNull();
          expect(parsesClean(w.path, w.text ?? ''), `${family} ${m.seed}: ${m.note}\n${w.text}`).toBe(true);
        }
      }
      expect(m.sessions.some((s) => s.some((w) => w.text !== fx.after))).toBe(true);
      // deterministic in (family, seed, revert)
      expect(mutate({ ...input(fx, family), seed: m.seed })).toEqual(m);
    }
    if (family === 'split-across-sessions') {
      for (const m of ms) {
        expect(m.sessions).toHaveLength(2);
        expect(m.sessions[1]?.[0]?.text).toBe(fx.after);
      }
    }
  });

  it('split-across-sessions: the crossing commit is the second session', () => {
    const r = orderFor(fx);
    const cache = new UnitCache(P);
    const snap = createState({ [fx.path]: fx.before }, cache);
    for (const m of mutants(input(fx, 'split-across-sessions'))) {
      const s1 = createState({ [fx.path]: m.sessions[0]?.[0]?.text ?? null }, cache);
      const s2 = createState({ [fx.path]: m.sessions[1]?.[0]?.text ?? null }, cache);
      expect(scoreOrder(r.order, snap, s2).matched).toBe(true);
      void s1;
    }
  });
});

function applyMutant(base: Record<string, string | null>, m: Mutant): Record<string, string | null> {
  const out = { ...base };
  for (const s of m.sessions) for (const w of s) out[w.path] = w.text;
  return out;
}

describe('P16: a unit moved or renamed into another file is still matched through the fingerprint index', () => {
  it.each(MUTATION_FIXTURES.map((f) => [f.name, f] as const))(
    '%s: held-out seeds 3100–3104, moved and re-applied',
    (_n, fx) => {
      const r = orderFor(fx);
      const ms = mutants(input(fx, 'move-to-file'));
      expect(ms.map((m) => m.seed)).toEqual(SEEDS.moveHeldOut);
      const cache = new UnitCache(P);
      for (const m of ms) {
        const after = applyMutant({ [fx.path]: fx.after }, m);
        const files = Object.keys(after);
        const base = createState({ [fx.path]: fx.before }, cache);
        const prop = createState(after, cache);
        const s = scoreOrder(r.order, base, prop, { material: r.material, searchFiles: files });
        const moved = s.units.find((u) => u.qualname === m.target?.qualname);
        expect(moved?.proposed, m.note).toBe('relocated');
        expect(s.matched, `${m.note}: edit ${s.edit}`).toBe(true);
      }
    },
  );
  it.each(MUTATION_FIXTURES.map((f) => [f.name, f] as const))(
    '%s: a plain move (no re-application) never matches',
    (_n, fx) => {
      const r = orderFor(fx);
      const ms = mutants(input(fx, 'move-to-file', fx.before));
      expect(ms.length).toBeGreaterThan(0);
      const cache = new UnitCache(P);
      for (const m of ms) {
        const after = applyMutant({ [fx.path]: fx.before }, m);
        const s = scoreOrder(
          r.order,
          createState({ [fx.path]: fx.before }, cache),
          createState(after, cache),
          {
            material: r.material,
            searchFiles: Object.keys(after),
          },
        );
        const unit = s.units.find((u) => u.qualname === m.target?.qualname);
        // A same-name move is found; a rename of a very small unit can fall below the 0.7 floor and is then `missing` (warn only).
        if (!m.note.includes(' as ')) expect(unit?.proposed, m.note).toBe('relocated');
        else expect(['relocated', 'missing']).toContain(unit?.proposed);
        expect(s.matched, m.note).toBe(false);
      }
    },
  );
});
