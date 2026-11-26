import { beforeAll, describe, expect, it } from 'vitest';
import { buildOrder } from '../build-order';
import { decide, type OrderEntry } from '../decide';
import { scoreOrder } from '../score';
import { createState, UnitCache } from '../state';
import type { ParserProvider } from '../syntax';
import { AFTER, BEFORE, BEFORE_REFORMATTED, DISJOINT } from './django-fixture';
import { grammars, LINKS, SHA_C, SHA_R, SHA_S } from './helpers';

const FILE = 'django/db/models/sql/query.py';
let P: ParserProvider;
let entry: OrderEntry;
let cache: UnitCache;
beforeAll(async () => {
  P = await grammars();
  cache = new UnitCache(P);
  const r = buildOrder({
    provider: P,
    original_sha: SHA_C,
    revert_sha: SHA_R,
    snapshot_sha: SHA_S,
    files: [{ path: FILE, before: BEFORE, after: AFTER, post_revert: BEFORE }],
    links: LINKS,
    at: '2026-11-26T00:00:00Z',
  });
  if (!r.ok) throw new Error('expected an order');
  entry = { order: { ...r.order, status: 'approved' }, material: r.material };
});

const st = (text: string) => createState({ [FILE]: text }, cache);
const write = (text: string, warned: string[] = []) =>
  decide({
    target: FILE,
    orders: [entry],
    baseline: st(BEFORE),
    current: st(BEFORE),
    proposed: st(text),
    warned,
  });

describe('Django-like fixture', () => {
  it('builds one modified unit, Query.set_group_by, with a stable id', () => {
    expect(entry.order.id).toBe('dnr-a1b2c3d4e5');
    expect(entry.order.units.map((u) => [u.qualname, u.kind])).toEqual([['Query.set_group_by', 'modified']]);
    const u = entry.order.units[0];
    expect(u?.A).toContain('seen');
    expect(u?.R).toContain('values_select');
    expect(u?.post_revert_token_count).toBeGreaterThan(50);
  });
  it('an exact re-application scores 1.0 and blocks', () => {
    const d = write(AFTER);
    expect(d.decision.edit_score).toBe(1);
    expect(d.decision.outcome).toBe('block');
    expect(d.decision.tier).toBe('match');
    expect(d.decision.reason_line).toMatch(
      /^DNR: Placeholder: .* https:\/\/github.com\/django\/django\/commit\/a1b2$/,
    );
  });
  it('an exact re-application in a different format still scores 1.0', () => {
    const reformatted = AFTER.replace(
      'group_by = list(self.select)',
      'group_by = list(\n            self.select,\n        )'.replace(',\n        )', '\n        )'),
    ).replace('for col in group_by_cols:', 'for col in group_by_cols:  # dedupe');
    expect(write(reformatted).decision.edit_score).toBe(1);
  });
  it('a disjoint rewrite scores 0 and is allowed', () => {
    const d = write(DISJOINT);
    expect(d.decision.edit_score).toBe(0);
    expect(d.decision.outcome).toBe('allow');
  });
  it('formatting-only changes do not match and do not warn', () => {
    const d = write(BEFORE_REFORMATTED);
    expect(d.decision.edit_score).toBe(0);
    expect(d.decision.outcome).toBe('allow');
  });
  it('a formatting-only commit produces no order', () => {
    const r = buildOrder({
      provider: P,
      original_sha: SHA_C,
      revert_sha: SHA_R,
      snapshot_sha: SHA_S,
      files: [{ path: FILE, before: BEFORE, after: BEFORE_REFORMATTED, post_revert: BEFORE }],
      links: LINKS,
      at: '2026-11-26T00:00:00Z',
    });
    expect(r).toEqual({ ok: false, skip_reason: 'no-unit-change' });
  });
  it('an unrelated edit to the covered unit warns once, then passes', () => {
    const edited = BEFORE.replace('group_by = list(self.select)', 'group_by = list(self.select) + []');
    const first = write(edited);
    expect(first.decision.outcome).toBe('warn_block');
    expect(first.effects.warn).toBe(entry.order.id);
    expect(write(edited, [entry.order.id]).decision.outcome).toBe('warn_pass');
  });
  it('a write to a file no order covers takes the fast path', () => {
    const d = decide({
      target: 'README.md',
      orders: [entry],
      baseline: st(BEFORE),
      current: st(BEFORE),
      proposed: st(BEFORE),
    });
    expect(d.decision).toMatchObject({ outcome: 'allow', fast_path: true });
  });
  it('half of the re-application does not meet the two-sided rule', () => {
    // Adds the A side only: keep the old branch and add the dedupe loop.
    const aOnly = BEFORE.replace(
      '        group_by = list(self.select)\n',
      '        group_by = list(self.select)\n        seen = set(chain.from_iterable(col.get_group_by_cols() for col in group_by))\n',
    );
    const s = scoreOrder(entry.order, st(BEFORE), st(aOnly));
    expect(s.iA).toBeGreaterThan(0);
    expect(s.iR).toBe(0);
    expect(s.two_sided).toBe(false);
    expect(s.matched).toBe(false);
  });
});
