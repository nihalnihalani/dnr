import { Decision, Order } from '@dnr/schemas';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOrder } from '../build-order';
import { decide } from '../decide';
import { createState, UnitCache } from '../state';
import type { ParserProvider } from '../syntax';
import { AFTER, BEFORE } from './django-fixture';
import { grammars, LINKS, SHA_C, SHA_R, SHA_S } from './helpers';

let P: ParserProvider;
beforeAll(async () => {
  P = await grammars();
});
const FILE = 'django/db/models/sql/query.py';
const build = () =>
  buildOrder({
    provider: P,
    original_sha: SHA_C,
    revert_sha: SHA_R,
    snapshot_sha: SHA_S,
    files: [{ path: FILE, before: BEFORE, after: AFTER, post_revert: BEFORE }],
    links: LINKS,
    at: '2026-11-26T00:00:00Z',
  });

describe('core output conforms to @dnr/schemas', () => {
  it('buildOrder produces a valid Order, deterministically', () => {
    const a = build();
    const b = build();
    if (!a.ok || !b.ok) throw new Error('no order');
    expect(Order.parse(a.order)).toEqual(a.order);
    expect(JSON.stringify(a.order)).toBe(JSON.stringify(b.order));
    expect(a.order.reason_source).toBe('placeholder');
  });
  it('decide produces valid Decisions for every outcome it emits', () => {
    const r = build();
    if (!r.ok) throw new Error('no order');
    const cache = new UnitCache(P);
    const st = (t: string) => createState({ [FILE]: t }, cache);
    const entry = { order: { ...r.order, status: 'approved' as const }, material: r.material };
    for (const proposed of [
      AFTER,
      BEFORE,
      BEFORE.replace('self.group_by = tuple(group_by)', 'self.group_by = list(group_by)'),
    ]) {
      const d = decide({
        target: FILE,
        orders: [entry],
        baseline: st(BEFORE),
        current: st(BEFORE),
        proposed: st(proposed),
      });
      expect(Decision.parse(JSON.parse(JSON.stringify(d.decision)))).toBeTruthy();
    }
  });
});
