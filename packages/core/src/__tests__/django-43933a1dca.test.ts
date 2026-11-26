/**
 * The headline demo order, built from REAL Django texts (fixtures/django-43933a1dca/SOURCE.md):
 * C = ea3a71c2d0 ("Fixed #26434 …"), revert R = 43933a1dca.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOrder } from '../build-order';
import { decide, type OrderEntry } from '../decide';
import * as core from '../index';
import { scoreOrder } from '../score';
import { createState, UnitCache } from '../state';
import type { ParserProvider } from '../syntax';
import { orderWeight, unitWeights, weightOf } from '../weights';
import { grammars } from './helpers';

const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/django-43933a1dca/${f}`, import.meta.url)), 'utf8');
const QUERY = 'django/db/models/sql/query.py';
const TESTS = 'tests/aggregation_regress/tests.py';
const C = 'ea3a71c2d09f8281d8a50ed20e40e1fb13db5cd9';
const R = '43933a1dca07047e95ec990d9289d0212668009e';

let P: ParserProvider;
let cache: UnitCache;
let entry: OrderEntry;
const T = { qb: '', qa: '', tb: '', ta: '' };
beforeAll(async () => {
  P = await grammars();
  cache = new UnitCache(P);
  T.qb = read('query.before.py');
  T.qa = read('query.after.py');
  T.tb = read('tests.before.py');
  T.ta = read('tests.after.py');
  // The revert restores both files byte for byte, so post_revert = before.
  const r = buildOrder({
    provider: P,
    original_sha: C,
    revert_sha: R,
    snapshot_sha: R,
    files: [
      { path: QUERY, before: T.qb, after: T.qa, post_revert: T.qb },
      { path: TESTS, before: T.tb, after: T.ta, post_revert: T.tb },
    ],
    links: [
      { rel: 'original', url: `https://github.com/django/django/commit/${C}` },
      { rel: 'revert', url: `https://github.com/django/django/commit/${R}` },
    ],
    tickets: [{ system: 'trac', id: '26434', url: 'https://code.djangoproject.com/ticket/26434' }],
    at: '2026-11-26T00:00:00Z',
  });
  if (!r.ok) throw new Error('expected an order');
  entry = { order: { ...r.order, status: 'approved' }, material: r.material };
});

const st = (files: Record<string, string>) => createState(files, cache);

describe('H3: real Django order dnr-43933a1dca', () => {
  it('has one unit, Query.clear_ordering, kind modified, A-only (the test file is excluded by test_globs)', () => {
    expect(entry.order.id).toBe('dnr-43933a1dca');
    expect(entry.order.units.map((u) => [u.file, u.qualname, u.kind])).toEqual([
      [QUERY, 'Query.clear_ordering', 'modified'],
    ]);
    const u = entry.order.units[0];
    if (!u) throw new Error('no unit');
    expect(weightOf(u.R, 'python')).toBe(0);
    // 31 tokens were added; 15 of them are weight-0 punctuation ( ) { } . , so w(A) = 16.
    expect(u.A).toHaveLength(31);
    expect(weightOf(u.A, 'python')).toBe(16);
    // ui's earlier "w(A)=31" was A.length: it counted the weight-0 tokens
    expect(unitWeights(u)).toEqual({ wA: 16, wR: 0 });
    expect(orderWeight(entry.order)).toBe(16);
    // exported from the public API, so consumers need no local copy
    expect(core.orderWeight(entry.order)).toBe(16);
    expect(core.unitWeights(u)).toEqual({ wA: 16, wR: 0 });
    expect(u.A.filter((t) => weightOf([t], 'python') === 1)).toEqual([
      'or',
      'isinstance',
      'self',
      'group_by',
      'tuple',
      'and',
      'not',
      '*',
      'self',
      'order_by',
      '*',
      'self',
      'extra_order_by',
      'issubset',
      'self',
      'group_by',
    ]);
  });
  it('an exact re-application of query.py blocks at 1.0', () => {
    const base = st({ [QUERY]: T.qb, [TESTS]: T.tb });
    const d = decide({
      target: QUERY,
      orders: [entry],
      baseline: base,
      current: base,
      proposed: st({ [QUERY]: T.qa, [TESTS]: T.tb }),
    });
    expect(d.decision).toMatchObject({
      outcome: 'block',
      tier: 'match',
      edit_score: 1,
      order_id: 'dnr-43933a1dca',
    });
  });
  it('restoring the test alone is allowed (tests are not part of the order)', () => {
    const base = st({ [QUERY]: T.qb, [TESTS]: T.tb });
    const d = decide({
      target: TESTS,
      orders: [entry],
      baseline: base,
      current: base,
      proposed: st({ [QUERY]: T.qb, [TESTS]: T.ta }),
    });
    expect(d.decision).toMatchObject({ outcome: 'allow', fast_path: true });
  });
  it('a one-line unrelated edit to Query.clear_ordering warns once', () => {
    const edited = T.qb.replace('        self.extra_order_by = ()\n', '        self.extra_order_by = []\n');
    expect(edited).not.toBe(T.qb);
    const base = st({ [QUERY]: T.qb });
    const d = decide({
      target: QUERY,
      orders: [entry],
      baseline: base,
      current: base,
      proposed: st({ [QUERY]: edited }),
    });
    expect(d.decision.outcome).toBe('warn_block');
    expect(scoreOrder(entry.order, base, st({ [QUERY]: edited })).edit).toBe(0);
  });
});
