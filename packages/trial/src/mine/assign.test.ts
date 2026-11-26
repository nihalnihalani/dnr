import { describe, expect, it } from 'vitest';
import { assignRoles } from './assign';
import { DEMO_REVERTS } from './eligibility';
import { seedKey } from './seed';

const sha = (i: number) => i.toString(16).padStart(40, '0');

describe('assignRoles', () => {
  const pool = Array.from({ length: 40 }, (_, i) => ({
    revert_sha: sha(i + 1),
    repo: 'django' as const,
    order_weight: i % 3 === 0 ? 5 : 12,
  }));
  const res = assignRoles(pool, {
    minOrderWeight: 8,
    demos: DEMO_REVERTS.map((d) => ({ revert_sha: d, repo: 'django' as const, order_weight: 9 })),
  });
  const ranked = [...pool].sort((a, b) => (seedKey(a.revert_sha) < seedKey(b.revert_sha) ? -1 : 1));

  it('ranks by sha256("dnr-2026:"+sha) and assigns 2 tune, 5 gate, rest trial up to K=30', () => {
    expect(res.assignment.filter((a) => a.role === 'tune')).toHaveLength(2);
    expect(res.assignment.filter((a) => a.role === 'gate')).toHaveLength(5);
    expect(res.K).toBe(30);
    expect(res.assignment.filter((a) => a.role === 'demo').map((a) => a.revert_sha)).toEqual([
      ...DEMO_REVERTS,
    ]);
    const first = res.assignment.find((a) => a.rank === 1);
    expect(first?.revert_sha).toBe(ranked[0]?.revert_sha);
    expect(res.unselected.length).toBe(40 - 32);
  });
  it('keeps light orders out of tune and gate', () => {
    const w = new Map(pool.map((p) => [p.revert_sha, p.order_weight]));
    for (const a of res.assignment)
      if (a.role === 'tune' || a.role === 'gate') expect(w.get(a.revert_sha)).toBeGreaterThanOrEqual(8);
  });
  it('keeps the lowest ranks', () => {
    const maxSelected = Math.max(...res.assignment.filter((a) => a.role !== 'demo').map((a) => a.rank));
    const ranksOfUnselected = res.unselected.map((s) => ranked.findIndex((r) => r.revert_sha === s) + 1);
    expect(Math.min(...ranksOfUnselected)).toBeGreaterThan(maxSelected);
  });
  it('is deterministic and refuses unknown weights or demos in the pool', () => {
    expect(assignRoles(pool, { minOrderWeight: 8 }).assignment).toEqual(
      assignRoles([...pool].reverse(), { minOrderWeight: 8 }).assignment,
    );
    expect(() =>
      assignRoles([{ revert_sha: sha(1), repo: 'django', order_weight: null }], { minOrderWeight: 8 }),
    ).toThrow(/order_weight/);
    expect(() =>
      assignRoles([{ revert_sha: DEMO_REVERTS[0] as string, repo: 'django', order_weight: 9 }], {
        minOrderWeight: 8,
      }),
    ).toThrow(/E8/);
  });
});
