import type { Order } from '@dnr/schemas';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyTool } from '../apply-tool';
import { buildOrder } from '../build-order';
import { blockMessage, decide, type OrderEntry } from '../decide';
import { isProtected, protectedGlobs } from '../protect';
import { isCrossing, proxUnit, scoreOrder } from '../score';
import { isRelanded, staleReport } from '../stale';
import { createState, UnitCache } from '../state';
import type { ParserProvider } from '../syntax';
import { grammars, LINKS, SHA_C, SHA_R, SHA_S } from './helpers';

let P: ParserProvider;
let cache: UnitCache;
beforeAll(async () => {
  P = await grammars();
  cache = new UnitCache(P);
});

const A_PY = `def keep(a):
    return a


def target(items, limit):
    total = 0
    for item in items:
        total += item.price
    return total
`;
const A_PY_C = `def keep(a):
    return a


def target(items, limit):
    total = 0
    for item in items:
        if item.price > limit:
            continue
        total += item.price * item.quantity
    return round(total, 2)
`;
const B_PY = `def other(x):
    return x * 2
`;
const B_PY_C = `def other(x):
    return x * 2


def added_helper(value, factor):
    scaled = value * factor
    return max(scaled, 0)
`;

function mk(files: Array<[string, string, string]>, status: Order['status'] = 'approved'): OrderEntry {
  const r = buildOrder({
    provider: P,
    original_sha: SHA_C,
    revert_sha: SHA_R,
    snapshot_sha: SHA_S,
    files: files.map(([path, before, after]) => ({ path, before, after, post_revert: before })),
    links: LINKS,
    at: '2026-11-26T00:00:00Z',
  });
  if (!r.ok) throw new Error('no order');
  return { order: { ...r.order, status }, material: r.material };
}
const st = (files: Record<string, string | null>) => createState(files, cache);

describe('two-file orders: whole-order scope (§5.5)', () => {
  it('a write to one file cannot block on a slice; the second write completes the match', () => {
    const e = mk([
      ['a.py', A_PY, A_PY_C],
      ['b.py', B_PY, B_PY_C],
    ]);
    expect(e.order.units.map((u) => `${u.file}:${u.qualname}:${u.kind}`)).toEqual([
      'a.py:target:modified',
      'b.py:added_helper:added',
    ]);
    const base = st({ 'a.py': A_PY, 'b.py': B_PY });
    const half = st({ 'a.py': A_PY, 'b.py': B_PY_C });
    const full = st({ 'a.py': A_PY_C, 'b.py': B_PY_C });
    const s1 = scoreOrder(e.order, base, half);
    expect(s1.edit).toBeGreaterThan(0);
    expect(s1.edit).toBeLessThan(0.6);
    const d1 = decide({ target: 'b.py', orders: [e], baseline: base, current: base, proposed: half });
    expect(d1.decision.outcome).not.toBe('block');
    const d2 = decide({ target: 'a.py', orders: [e], baseline: base, current: half, proposed: full });
    expect(d2.decision).toMatchObject({ outcome: 'block', edit_score: 1 });
  });
});

describe('grants (§5.4, P10)', () => {
  it('a grant applies only to its own order', () => {
    const e1 = mk([['a.py', A_PY, A_PY_C]]);
    const e2 = { ...e1, order: { ...e1.order, id: 'dnr-ffffffffff' } };
    const base = st({ 'a.py': A_PY });
    const prop = st({ 'a.py': A_PY_C });
    const granted = (id: string) => id === 'dnr-ffffffffff';
    const d = decide({
      target: 'a.py',
      orders: [e1, e2],
      baseline: base,
      current: base,
      proposed: prop,
      grantApplies: granted,
    });
    expect(d.decision).toMatchObject({ outcome: 'block', order_id: e1.order.id });
    const d2 = decide({
      target: 'a.py',
      orders: [e2],
      baseline: base,
      current: base,
      proposed: prop,
      grantApplies: granted,
    });
    expect(d2.decision).toMatchObject({ outcome: 'allow_grant', tier: 'match', order_id: 'dnr-ffffffffff' });
    expect(d2.effects.grantsUsed).toEqual(['dnr-ffffffffff']);
  });
  it('a grant turns off the warn tier for its order', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const base = st({ 'a.py': A_PY });
    const prop = st({ 'a.py': A_PY.replace('total = 0', 'total = 0.0') });
    const d = decide({
      target: 'a.py',
      orders: [e],
      baseline: base,
      current: base,
      proposed: prop,
      grantApplies: () => true,
    });
    expect(d.decision).toMatchObject({ outcome: 'allow_grant', tier: 'warn' });
  });
});

describe('tiers', () => {
  const base = () => st({ 'a.py': A_PY });
  it('protect denies first', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const d = decide({
      target: 'a.py',
      protected: true,
      orders: [e],
      baseline: base(),
      current: base(),
      proposed: st({ 'a.py': A_PY_C }),
    });
    expect(d.decision).toMatchObject({ outcome: 'deny_protected', tier: 'protect' });
  });
  it('ask format returns ask on a match', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const d = decide({
      target: 'a.py',
      orders: [e],
      baseline: base(),
      current: base(),
      proposed: st({ 'a.py': A_PY_C }),
      config: { decision_format: 'ask' },
    });
    expect(d.decision.outcome).toBe('ask');
  });
  it('stale and re-landed orders only warn', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    for (const flag of [{ stale: true }, { relanded: true }]) {
      const d = decide({
        target: 'a.py',
        orders: [{ ...e, ...flag }],
        baseline: base(),
        current: base(),
        proposed: st({ 'a.py': A_PY_C }),
      });
      expect(d.decision.outcome).toBe('warn_block');
    }
  });
  it('warn-only mode downgrades a match to warn_block then warn_pass', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const args = {
      target: 'a.py',
      orders: [e],
      baseline: base(),
      current: base(),
      proposed: st({ 'a.py': A_PY_C }),
      config: { mode: 'warn-only' as const },
    };
    expect(decide(args).decision).toMatchObject({ outcome: 'warn_block', fired_by: 'edit' });
    expect(decide({ ...args, warned: [e.order.id] }).decision.outcome).toBe('warn_pass');
  });
  it('draft and retired orders are ignored', () => {
    const e = mk([['a.py', A_PY, A_PY_C]], 'draft');
    const d = decide({
      target: 'a.py',
      orders: [e],
      baseline: base(),
      current: base(),
      proposed: st({ 'a.py': A_PY_C }),
    });
    expect(d.decision.outcome).toBe('allow');
  });
  it('an unknown write tool covering the order falls to warn', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const d = decide({
      target: 'a.py',
      unknownTool: true,
      orders: [e],
      baseline: base(),
      current: base(),
      proposed: base(),
    });
    expect(d.decision.outcome).toBe('warn_block');
  });
  it('a small order never reaches the match tier, but warns', () => {
    const e = mk([['a.py', A_PY, A_PY.replace('total = 0', 'total = 1')]]);
    expect(e.order.units[0]?.A).toEqual(['1']);
    const d = decide({
      target: 'a.py',
      orders: [e],
      baseline: base(),
      current: base(),
      proposed: st({ 'a.py': A_PY.replace('total = 0', 'total = 1') }),
    });
    expect(d.decision).toMatchObject({ outcome: 'warn_block', edit_score: 1 });
  });
  it('a parse-degraded unit can only warn', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const broken = A_PY_C.replace(
      '    return round(total, 2)\n',
      '    return round(total, 2\n    ))) ((( ]] [[ :: \n',
    );
    const d = decide({
      target: 'a.py',
      orders: [e],
      baseline: base(),
      current: base(),
      proposed: st({ 'a.py': broken }),
    });
    expect(d.decision.tier).not.toBe('match');
    const b = d.decision.breakdown[0] as { degraded: boolean; missing: boolean; edit: number };
    expect(b.degraded || b.missing).toBe(true);
  });
  it('the block message follows §6 and stays under 1,200 characters', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const d = decide({
      target: 'a.py',
      orders: [e],
      baseline: base(),
      current: base(),
      proposed: st({ 'a.py': A_PY_C }),
    });
    const msg = blockMessage(e.order, d.decision, { qualnames: ['target'] });
    expect(msg.split('\n')[0]).toBe(d.decision.reason_line);
    expect(msg).toContain(`DNR order ${e.order.id} matched (edit 1.00 ≥ 0.60) in target.`);
    expect(msg.length).toBeLessThanOrEqual(1200);
  });
});

describe('missing units (§5.5 table) and delete_file', () => {
  it('a removed unit counts as re-applied when it is absent from the proposal', () => {
    const before = `${A_PY}\n\ndef legacy(a, b, c):\n    value = a + b + c\n    return value * value\n`;
    const e = mk([['a.py', before, A_PY]]);
    expect(e.order.units.map((u) => u.kind)).toEqual(['removed']);
    const base = st({ 'a.py': before });
    expect(
      decide({ target: 'a.py', orders: [e], baseline: base, current: base, proposed: st({ 'a.py': A_PY }) })
        .decision.outcome,
    ).toBe('block');
  });
  it('a missing modified unit falls to warn', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const base = st({ 'a.py': A_PY });
    const gone = A_PY.slice(0, A_PY.indexOf('def target'));
    const d = decide({
      target: 'a.py',
      orders: [e],
      baseline: base,
      current: base,
      proposed: st({ 'a.py': gone }),
    });
    expect(d.decision.outcome).toBe('warn_block');
  });
  it('delete_file re-applies removals and sends other units to warn', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const base = st({ 'a.py': A_PY });
    const eff = applyTool('delete_file', { path: 'a.py' }, () => A_PY);
    expect(eff).toEqual({ kind: 'write', tool: 'delete_file', path: 'a.py', text: null });
    const d = decide({
      target: 'a.py',
      orders: [e],
      baseline: base,
      current: base,
      proposed: st({ 'a.py': null }),
    });
    expect(d.decision.outcome).toBe('warn_block');
  });
});

describe('fingerprint relocation (§5.16)', () => {
  it('a unit moved to another file and re-applied still matches', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const moved = A_PY_C.slice(A_PY_C.indexOf('def target')).replace('def target', 'def target_impl');
    const base = st({ 'a.py': A_PY, 'b.py': null });
    const prop = st({ 'a.py': A_PY.slice(0, A_PY.indexOf('def target')), 'b.py': moved });
    const s = scoreOrder(e.order, base, prop, { material: e.material, searchFiles: ['a.py', 'b.py'] });
    expect(s.units[0]?.proposed).toBe('relocated');
    expect(s.units[0]?.relocated_to?.file).toBe('b.py');
    expect(s.matched).toBe(true);
    const d = decide({
      target: 'b.py',
      orders: [e],
      baseline: base,
      current: st({ 'a.py': A_PY.slice(0, A_PY.indexOf('def target')), 'b.py': null }),
      proposed: prop,
      searchFiles: ['a.py', 'b.py'],
    });
    expect(d.decision.outcome).toBe('block');
  });
  it('a plain move does not match', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const moved = A_PY.slice(A_PY.indexOf('def target'));
    const base = st({ 'a.py': A_PY, 'b.py': null });
    const prop = st({ 'a.py': A_PY.slice(0, A_PY.indexOf('def target')), 'b.py': moved });
    const s = scoreOrder(e.order, base, prop, { material: e.material, searchFiles: ['b.py'] });
    expect(s.units[0]?.proposed).toBe('relocated');
    expect(s.edit).toBe(0);
    expect(s.matched).toBe(false);
  });
});

describe('crossing rule, stale, re-landed (§5.5, §5.9)', () => {
  it('blocks only the commit that crosses', () => {
    const e = mk([
      ['a.py', A_PY, A_PY_C],
      ['b.py', B_PY, B_PY_C],
    ]);
    const snap = st({ 'a.py': A_PY, 'b.py': B_PY });
    const s1 = st({ 'a.py': A_PY, 'b.py': B_PY_C });
    const s2 = st({ 'a.py': A_PY_C, 'b.py': B_PY_C });
    expect(isCrossing(e.order, snap, snap, s1).crossing).toBe(false);
    expect(isCrossing(e.order, snap, s1, s2).crossing).toBe(true);
    expect(isCrossing(e.order, snap, s2, s2).crossing).toBe(false);
    expect(isRelanded(e.order, snap, s2)).toBe(true);
  });
  it('is stale when more than half the snapshot tokens differ or a unit is lost', () => {
    const e = mk([['a.py', A_PY, A_PY_C]]);
    const snap = st({ 'a.py': A_PY });
    expect(staleReport(e.order, snap, snap).stale).toBe(false);
    const rewritten = A_PY.replace(
      /def target\(items, limit\):[\s\S]*$/,
      'def target(items, limit):\n    return sum(map(price_of, items))\n',
    );
    const mild = A_PY.replace('total = 0', 'total = 0.0');
    expect(staleReport(e.order, snap, st({ 'a.py': mild })).stale).toBe(false);
    expect(staleReport(e.order, snap, st({ 'a.py': rewritten })).stale).toBe(true);
    const lost = st({ 'a.py': A_PY.slice(0, A_PY.indexOf('def target')) });
    expect(staleReport(e.order, snap, lost).lost).toHaveLength(1);
    const added = mk([['b.py', B_PY, B_PY_C]]);
    expect(staleReport(added.order, st({ 'b.py': B_PY }), st({ 'b.py': B_PY })).stale).toBe(false);
  });
});

describe('proximity (§5.6)', () => {
  const C = ['a', 'b', 'c', 'd', 'e', 'f'];
  const PR = ['a', 'b', 'x', 'y', 'e', 'f'];
  it('is 1.0 for an exact replay and 0 for the post-revert state', () => {
    expect(proxUnit(C, PR, PR, [C], 'python')).toBe(1);
    expect(proxUnit(C, PR, PR, [PR], 'python')).toBe(0);
    expect(proxUnit(C, [], [], [C], 'python')).toBe(1);
  });
  it('is 0 when C has fewer than 3 weight-1 tokens or C equals PR', () => {
    expect(proxUnit(['a', '(', 'b'], [], [], [['a', 'b']], 'python')).toBe(0);
    expect(proxUnit(C, C, [], [C], 'python')).toBe(0);
  });
  it('is baseline-relative: a committed re-land stops firing', () => {
    expect(proxUnit(C, PR, C, [C], 'python')).toBe(0);
  });
});

describe('apply-tool adapters (§5.8)', () => {
  const cur = () => 'a\nb\nb\nc\n';
  it('fs_write create/overwrite and legacy commands', () => {
    expect(applyTool('fs_write', { path: 'x', file_text: 'new' }, cur)).toMatchObject({
      kind: 'write',
      text: 'new',
    });
    expect(applyTool('fs_write', { command: 'create', path: 'x', content: 'n' }, cur)).toMatchObject({
      text: 'n',
    });
    expect(
      applyTool('fs_write', { command: 'str_replace', path: 'x', old_str: 'c', new_str: 'C' }, cur),
    ).toMatchObject({ text: 'a\nb\nb\nC\n' });
    expect(applyTool('fs_write', { command: 'append', path: 'x', new_str: 'd\n' }, cur)).toMatchObject({
      text: 'a\nb\nb\nc\nd\n',
    });
    expect(
      applyTool('fs_write', { command: 'insert', path: 'x', insert_line: 1, new_str: 'z' }, cur),
    ).toMatchObject({ text: 'a\nz\nb\nb\nc\n' });
  });
  it('str_replace passes through on zero or several matches', () => {
    expect(applyTool('str_replace', { path: 'x', old_str: 'a', new_str: 'A' }, cur)).toMatchObject({
      kind: 'write',
      text: 'A\nb\nb\nc\n',
    });
    expect(applyTool('str_replace', { path: 'x', old_str: 'b', new_str: 'B' }, cur).kind).toBe('passthrough');
    expect(applyTool('str_replace', { path: 'x', old_str: 'q', new_str: 'Q' }, cur).kind).toBe('passthrough');
  });
  it('fs_append, delete_file, unknown and pathless tools', () => {
    expect(applyTool('fs_append', { path: 'x', content: 'z' }, cur)).toMatchObject({ text: 'a\nb\nb\nc\nz' });
    expect(applyTool('delete_file', { path: 'x' }, cur)).toMatchObject({ kind: 'write', text: null });
    expect(applyTool('mystery_write', { path: 'x' }, cur)).toEqual({
      kind: 'unknown',
      tool: 'mystery_write',
      path: 'x',
    });
    expect(applyTool('fs_write', {}, cur)).toEqual({ kind: 'none', tool: 'fs_write' });
  });
});

describe('protect globs (§5.4)', () => {
  const globs = protectedGlobs({
    repoRoot: '/r',
    home: '/h',
    ordersDir: '/t/orders',
    stateDir: '/t/state',
    configFile: '/t/config.json',
  });
  it('covers the plan globs', () => {
    for (const p of [
      '/r/.dnr/orders/x.json',
      '/r/.kiro/hooks/a.json',
      '/r/.kiro/settings/mcp.json',
      '/r/.kiro/agents/a.json',
      '/h/.kiro/x',
      '/t/orders/o.json',
      '/t/state/s',
      '/t/config.json',
      '/r/.KIRO/hooks/a.json',
      '/r/src/../.dnr/x',
    ]) {
      expect(isProtected(p, globs), p).toBe(true);
    }
    for (const p of ['/r/src/a.py', '/r/.kiro/steering/x.md', '/t/config.json.bak', '/r/.dnrx']) {
      expect(isProtected(p, globs), p).toBe(false);
    }
  });
});
