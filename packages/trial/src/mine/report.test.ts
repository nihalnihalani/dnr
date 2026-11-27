import { describe, expect, it } from 'vitest';
import { REPO2_MIN_ELIGIBLE, renderSecondRepo, type SecondRepoSummary } from './report';

const base: SecondRepoSummary = {
  repo: 'cpython',
  candidatesFile: 'fixtures/candidates.cpython.jsonl',
  candidates: 100,
  pool: 20,
  eligible: 0,
  pending: true,
};

describe('second repo choice (§9.11)', () => {
  it('P3-20: names the second repo and applies the < 15 eligible switch to sympy', () => {
    expect(REPO2_MIN_ELIGIBLE).toBe(15);
    expect(renderSecondRepo(null)).toMatch(/^## Second repo/);
    expect(renderSecondRepo(null)).toContain('Not mined yet');
    expect(renderSecondRepo(base)).toContain('**Choice: cpython, provisional.**');
    expect(renderSecondRepo({ ...base, pool: 14 })).toContain('**Choice: sympy.**');
    expect(renderSecondRepo({ ...base, pending: false, eligible: 15 })).toContain('**Choice: cpython.**');
    expect(renderSecondRepo({ ...base, pending: false, eligible: 14 })).toContain('**Choice: sympy.**');
  });
});
