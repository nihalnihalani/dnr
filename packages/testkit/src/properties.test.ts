/**
 * Engine properties P1–P5, P7, P8, P10, P12, P14, P15, P17 (plan §12.1), as fast-check tests.
 * P16 is in mutate.test.ts. Run count: DNR_FC_RUNS (default 500; nightly 2,000).
 */
import {
  createState,
  decide,
  diffTokens,
  intersectionWeight,
  isCrossing,
  isRelanded,
  jaccard,
  type OrderScore,
  type ParserProvider,
  proxUnit,
  scoreOrder,
  shingles3,
  UnitCache,
  unitKey,
  weightOf,
} from '@dnr/core';
import { loadGrammarsNode } from '@dnr/grammar/node';
import type { Order } from '@dnr/schemas';
import fc from 'fast-check';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { freshStmt, modArb, styleArb } from './arbitraries';
import { buildCase, caseFiles, type OrderCase, stateOf, texts } from './cases';
import { changeIds, type Lang, type Mod, render, type Stmt } from './program';

const RUNS = Number(process.env.DNR_FC_RUNS ?? 500);
const opts = { numRuns: RUNS };
// 500 runs take ~1 s per property; nightly 2,000 runs need more than vitest's 5 s default
vi.setConfig({ testTimeout: 600_000 });
let P: ParserProvider;
beforeAll(async () => {
  P = await loadGrammarsNode();
});

const langArb = fc.constantFrom<Lang>('python', 'typescript');
const modsArb = (o?: Parameters<typeof modArb>[0]) =>
  fc.tuple(langArb, fc.array(modArb(o), { minLength: 1, maxLength: 2 }));

function mk(lang: Lang, mods: Mod[]): OrderCase | null {
  return buildCase(P, caseFiles(mods, lang), new UnitCache(P));
}

const totalWeight = (s: OrderScore) => s.wA + s.wR;
/** A file the order covers (a write to any other file takes the fast path, correctly). */
const orderFile = (c: OrderCase) => c.entry.order.units[0]?.file ?? '';

/** Independent reference implementation of the §5.5 edit score (separate A and R multisets, with repeats). */
function referenceEdit(
  order: Order,
  base: (f: string, q: string) => string[],
  prop: (f: string, q: string) => string[],
) {
  let num = 0;
  let den = 0;
  for (const u of order.units) {
    const g = u.tokenizer.grammar;
    const d = diffTokens(base(u.file, u.qualname), prop(u.file, u.qualname));
    const count = (xs: string[]) => {
      const m = new Map<string, number>();
      for (const x of xs) if (weightOf([x], g) === 1) m.set(x, (m.get(x) ?? 0) + 1);
      return m;
    };
    const inter = (a: string[], b: string[]) => {
      const mb = count(b);
      let n = 0;
      for (const [k, c] of count(a)) n += Math.min(c, mb.get(k) ?? 0);
      return n;
    };
    num += inter(u.A, d.A) + inter(u.R, d.R);
    den += weightOf(u.A, g) + weightOf(u.R, g);
  }
  return den === 0 ? 0 : num / den;
}

/** Insert fresh statements (tokens that no order contains) into random function bodies. */
function withFresh(mods: Mod[], picks: Array<{ m: number; f: number; s: Stmt }>): Mod[] {
  const out = structuredClone(mods);
  picks.forEach((p, i) => {
    const mod = out[p.m % out.length] as Mod;
    const fns = [...mod.fns, ...(mod.cls?.methods ?? [])].filter((f) => f.status === 'keep');
    const fn = fns[p.f % Math.max(1, fns.length)];
    if (fn) fn.body.splice(0, 0, { id: `fresh${i}`, status: 'keep', stmt: p.s });
  });
  return out;
}

const freshPicks = fc.array(fc.record({ m: fc.nat(), f: fc.nat(), s: freshStmt }), {
  minLength: 1,
  maxLength: 3,
});

describe('P1: an exact re-application scores 1.0 and blocks when it can match', () => {
  it('holds for Python and TypeScript, in any formatting', () => {
    fc.assert(
      fc.property(modsArb(), styleArb, ([lang, mods], style) => {
        const c = mk(lang, mods);
        fc.pre(c !== null);
        if (!c) return;
        const base = stateOf(c, []);
        const prop = stateOf(c, c.ids, style);
        const s = scoreOrder(c.entry.order, base, prop);
        expect(s.edit).toBe(1);
        const d = decide({
          target: orderFile(c),
          orders: [c.entry],
          baseline: base,
          current: base,
          proposed: prop,
        });
        if (totalWeight(s) >= 8) expect(d.decision.outcome).toBe('block');
        else expect(d.decision.outcome).not.toBe('block');
      }),
      opts,
    );
  });
});

describe('P2: a write that touches none of the order tokens does not match', () => {
  it('fresh-token insertions score 0', () => {
    fc.assert(
      fc.property(modsArb(), freshPicks, styleArb, ([lang, mods], picks, style) => {
        const c = mk(lang, mods);
        fc.pre(c !== null);
        if (!c) return;
        const other: OrderCase = { ...c, files: caseFiles(withFresh(mods, picks), lang) };
        const s = scoreOrder(c.entry.order, stateOf(c, []), stateOf(other, [], style));
        expect(s.edit).toBe(0);
        expect(s.matched).toBe(false);
      }),
      opts,
    );
  });
});

describe('P3: a re-application split into k writes is blocked no later than the first write where the block condition holds', () => {
  it('holds for any order of per-change writes', () => {
    fc.assert(
      fc.property(
        modsArb(),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        styleArb,
        ([lang, mods], seed, style) => {
          const c = mk(lang, mods);
          fc.pre(c !== null);
          if (!c) return;
          // shuffle the change ids, then group them into k writes, each write touching one file
          const ids = [...c.ids];
          let x = seed;
          for (let i = ids.length - 1; i > 0; i--) {
            x = (x * 1103515245 + 12345) & 0x7fffffff;
            const j = x % (i + 1);
            [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
          }
          const base = stateOf(c, []);
          const applied: string[] = [];
          let blocked = false;
          let current = base;
          for (const id of ids) {
            applied.push(id);
            const target = id.slice(0, id.indexOf('|'));
            const proposed = stateOf(c, applied, style);
            const cond = scoreOrder(c.entry.order, base, proposed);
            const d = decide({ target, orders: [c.entry], baseline: base, current, proposed });
            if (cond.matched) {
              expect(d.decision.outcome).toBe('block');
              blocked = true;
              break;
            }
            expect(d.decision.outcome).not.toBe('block');
            current = proposed;
          }
          const full = scoreOrder(c.entry.order, base, stateOf(c, c.ids));
          if (full.matched) expect(blocked).toBe(true);
        },
      ),
      opts,
    );
  });
});

describe('P4: a token present in both A and R cannot cancel itself', () => {
  it('scores equal the separate-multiset reference on any partial state', () => {
    fc.assert(
      fc.property(modsArb(), fc.array(fc.boolean(), { maxLength: 40 }), ([lang, mods], mask) => {
        const c = mk(lang, mods);
        fc.pre(c !== null);
        if (!c) return;
        const applied = c.ids.filter((_, i) => mask[i] ?? false);
        const base = stateOf(c, []);
        const prop = stateOf(c, applied);
        const tok = (st: typeof base) => (f: string, q: string) => st.units(f)?.units.get(q)?.tokens ?? [];
        const s = scoreOrder(c.entry.order, base, prop);
        expect(s.edit).toBeCloseTo(referenceEdit(c.entry.order, tok(base), tok(prop)), 12);
      }),
      opts,
    );
  });
  it('an order whose A and R share tokens scores 1 on re-application and 0 on no-op', () => {
    fc.assert(
      fc.property(modsArb(), ([lang, mods]) => {
        const c = mk(lang, mods);
        fc.pre(c !== null);
        if (!c) return;
        const shared = c.entry.order.units.some((u) => intersectionWeight(u.A, u.R, u.tokenizer.grammar) > 0);
        fc.pre(shared);
        const base = stateOf(c, []);
        expect(scoreOrder(c.entry.order, base, stateOf(c, c.ids)).edit).toBe(1);
        expect(scoreOrder(c.entry.order, base, base).edit).toBe(0);
      }),
      { ...opts, numRuns: Math.max(50, Math.floor(RUNS / 5)) },
    );
  });
});

describe('P5: scores lie in [0,1] and do not change with whitespace or comments', () => {
  it('holds on random partial states plus fresh edits', () => {
    fc.assert(
      fc.property(
        modsArb(),
        fc.array(fc.boolean(), { maxLength: 40 }),
        freshPicks,
        styleArb,
        styleArb,
        ([lang, mods], mask, picks, s1, s2) => {
          const c = mk(lang, mods);
          fc.pre(c !== null);
          if (!c) return;
          const applied = c.ids.filter((_, i) => mask[i] ?? false);
          const other: OrderCase = { ...c, files: caseFiles(withFresh(mods, picks), lang) };
          const base = stateOf(c, []);
          const a = scoreOrder(c.entry.order, base, stateOf(other, applied, s1));
          const b = scoreOrder(c.entry.order, base, stateOf(other, applied, s2));
          expect(a.edit).toBeGreaterThanOrEqual(0);
          expect(a.edit).toBeLessThanOrEqual(1);
          expect(b.edit).toBe(a.edit);
          expect(b.matched).toBe(a.matched);
          // the baseline's formatting does not matter either
          const c2 = scoreOrder(c.entry.order, stateOf(c, [], s2), stateOf(other, applied, s1));
          expect(c2.edit).toBe(a.edit);
        },
      ),
      opts,
    );
  });
});

describe('P7: an unchanged post-revert file scores 0', () => {
  it('holds in any formatting', () => {
    fc.assert(
      fc.property(modsArb(), styleArb, ([lang, mods], style) => {
        const c = mk(lang, mods);
        fc.pre(c !== null);
        if (!c) return;
        const s = scoreOrder(c.entry.order, stateOf(c, []), stateOf(c, [], style));
        expect(s.edit).toBe(0);
        expect(s.matched).toBe(false);
      }),
      opts,
    );
  });
});

describe('P8: a removal-only re-application is blocked when the order meets min_order_weight', () => {
  it('holds for orders whose C only removed code', () => {
    fc.assert(
      fc.property(modsArb({ statuses: ['del'], fnChanges: ['del'] }), styleArb, ([lang, mods], style) => {
        const c = mk(lang, mods);
        fc.pre(c !== null);
        if (!c) return;
        const base = stateOf(c, []);
        const prop = stateOf(c, c.ids, style);
        const s = scoreOrder(c.entry.order, base, prop);
        expect(s.wA).toBe(0);
        fc.pre(s.wR >= 8);
        const d = decide({
          target: orderFile(c),
          orders: [c.entry],
          baseline: base,
          current: base,
          proposed: prop,
        });
        expect(d.decision.outcome).toBe('block');
      }),
      opts,
    );
  });
});

describe('P10: a grant applies only to its own order', () => {
  it('allow_grant only for the granted order; others still block', () => {
    fc.assert(
      fc.property(modsArb(), fc.boolean(), ([lang, mods], grantFirst) => {
        const c = mk(lang, mods);
        fc.pre(c !== null);
        if (!c) return;
        const base = stateOf(c, []);
        const prop = stateOf(c, c.ids);
        fc.pre(scoreOrder(c.entry.order, base, prop).matched);
        const twin = { ...c.entry, order: { ...c.entry.order, id: 'dnr-ffffffffff' } };
        const granted = grantFirst ? c.entry.order.id : twin.order.id;
        const target = orderFile(c);
        const both = decide({
          target,
          orders: [c.entry, twin],
          baseline: base,
          current: base,
          proposed: prop,
          grantApplies: (id) => id === granted,
        });
        expect(both.decision.outcome).toBe('block');
        expect(both.decision.order_id).not.toBe(granted);
        const only = decide({
          target,
          orders: [grantFirst ? c.entry : twin],
          baseline: base,
          current: base,
          proposed: prop,
          grantApplies: (id) => id === granted,
        });
        expect(only.decision).toMatchObject({ outcome: 'allow_grant', order_id: granted });
        const none = decide({
          target,
          orders: [grantFirst ? c.entry : twin],
          baseline: base,
          current: base,
          proposed: prop,
          grantApplies: () => false,
        });
        expect(none.decision.outcome).toBe('block');
      }),
      { ...opts, numRuns: Math.max(50, Math.floor(RUNS / 5)) },
    );
  });
});

describe('P12: after a re-land is committed, a later unrelated edit is allowed', () => {
  it('holds with the re-landed state as the session baseline', () => {
    fc.assert(
      fc.property(modsArb(), freshPicks, ([lang, mods], picks) => {
        const c = mk(lang, mods);
        fc.pre(c !== null);
        if (!c) return;
        const snap = stateOf(c, []);
        const head = stateOf(c, c.ids);
        const relanded = isRelanded(c.entry.order, snap, head);
        // an unrelated edit: a new function made of fresh tokens appended to the first file
        const f0 = c.files.find((f) => f.path === orderFile(c));
        if (!f0) return;
        const extra = render(
          {
            header: [],
            fns: [
              {
                id: 'x',
                name: 'zz_unrelated',
                params: [],
                status: 'keep',
                decorator: null,
                body: picks.map((p, i) => ({ id: `x${i}`, status: 'keep' as const, stmt: p.s })),
              },
            ],
            cls: null,
          },
          lang,
          new Set(),
        );
        const headTexts = texts(c.files, c.ids);
        const edited = { ...headTexts, [f0.path]: `${headTexts[f0.path]}\n\n${extra}` };
        const d = decide({
          target: f0.path,
          orders: [{ ...c.entry, relanded }],
          baseline: head,
          current: head,
          proposed: createState(edited, c.cache),
        });
        expect(d.decision.outcome).toBe('allow');
      }),
      opts,
    );
  });
});

describe('P14: prox_u = 1 for an exact replay of kind=modified and kind=added units', () => {
  it('holds at any size of C', () => {
    fc.assert(
      fc.property(modsArb(), styleArb, ([lang, mods], style) => {
        const c = mk(lang, mods);
        fc.pre(c !== null);
        if (!c) return;
        const s = scoreOrder(c.entry.order, stateOf(c, []), stateOf(c, c.ids, style), {
          material: c.entry.material,
          computeProx: true,
        });
        let checked = 0;
        for (const u of c.entry.order.units) {
          if (u.kind === 'removed') continue;
          const m = c.entry.material?.get(unitKey(u.file, u.qualname));
          if (!m) continue;
          const g = u.tokenizer.grammar;
          const sC = shingles3(m.C, g);
          if (sC.size === 0 || jaccard(sC, shingles3(m.PR, g)) >= 1) continue; // §5.6 edge cases: prox_u = 0
          const us = s.units.find((x) => x.file === u.file && x.qualname === u.qualname);
          expect(us?.prox).toBe(1);
          checked++;
        }
        fc.pre(checked > 0);
      }),
      opts,
    );
  });
});

describe('P15: a re-application split across two committed sessions is blocked at the crossing commit', () => {
  it('holds for random splits, including A-heavy orders whose first commit lands only the A side', () => {
    fc.assert(
      fc.property(
        modsArb(),
        fc.array(fc.boolean(), { maxLength: 40 }),
        fc.boolean(),
        ([lang, mods], mask, aOnly) => {
          const c = mk(lang, mods);
          fc.pre(c !== null);
          if (!c) return;
          const snap = stateOf(c, []);
          const full = stateOf(c, c.ids);
          fc.pre(scoreOrder(c.entry.order, snap, full).matched);
          // parent: the first session's commit. A-only: every addition, no removal.
          const isIns = (id: string) => {
            const f = c.files.find((x) => id.startsWith(`${x.path}|`));
            const local = id.slice(id.indexOf('|') + 1);
            const fns = [...(f?.mod.fns ?? []), ...(f?.mod.cls?.methods ?? [])];
            for (const fn of fns) {
              if (fn.id === local) return fn.status === 'ins';
              const e = fn.body.find((b) => b.id === local);
              if (e) return e.status === 'ins';
            }
            return false;
          };
          const parentIds = aOnly ? c.ids.filter(isIns) : c.ids.filter((_, i) => mask[i] ?? false);
          const parent = stateOf(c, parentIds);
          const r = isCrossing(c.entry.order, snap, parent, full);
          if (r.parent.matched) {
            // already in history: re-landed, never a crossing
            expect(r.crossing).toBe(false);
            expect(isRelanded(c.entry.order, snap, parent)).toBe(true);
          } else {
            expect(r.crossing).toBe(true);
          }
          if (aOnly && r.next.wA > 0 && r.next.wR > 0) {
            expect(r.parent.iR).toBe(0);
            expect(r.parent.matched).toBe(false);
            expect(r.crossing).toBe(true);
          }
          // the first session's own commit is a crossing only if it already matches
          const first = isCrossing(c.entry.order, snap, snap, parent);
          expect(first.crossing).toBe(r.parent.matched);
        },
      ),
      opts,
    );
  });
});

describe('P17: prox_u is never negative', () => {
  const toks = fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e', '(', ')', 'x', 'y'), { maxLength: 30 });
  it('for any C, PR, baseline and candidate', () => {
    fc.assert(
      fc.property(toks, toks, toks, fc.array(toks, { maxLength: 3 }), (C, PR, base, cands) => {
        const v = proxUnit(C, PR, base, cands, 'python');
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }),
      opts,
    );
  });
  it('a rewrite sharing no 3-shingles with C_u or PR_u has prox_u = 0 for any baseline', () => {
    const fresh = fc.array(fc.constantFrom('q1', 'q2', 'q3', 'q4'), { maxLength: 20 });
    fc.assert(
      fc.property(toks, toks, toks, fresh, (C, PR, base, rewrite) => {
        expect(proxUnit(C, PR, base, [rewrite], 'python')).toBe(0);
      }),
      opts,
    );
  });
});

describe('generated programs are valid', () => {
  it('the snapshot, C and every partial state parse without errors', () => {
    fc.assert(
      fc.property(
        modsArb(),
        styleArb,
        fc.array(fc.boolean(), { maxLength: 40 }),
        ([lang, mods], style, mask) => {
          const files = caseFiles(mods, lang);
          const ids = files.flatMap((f) => changeIds(f.mod).map((id) => `${f.path}|${id}`));
          for (const applied of [[], ids, ids.filter((_, i) => mask[i] ?? false)]) {
            for (const [path, t] of Object.entries(texts(files, applied, style))) {
              const tree = P.parse(lang, t);
              expect(tree.rootNode.hasError, `${path}\n${t}`).toBe(false);
              tree.delete?.();
            }
          }
        },
      ),
      { numRuns: Math.max(100, Math.floor(RUNS / 5)) },
    );
  });
});
