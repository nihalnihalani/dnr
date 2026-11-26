import { Candidate } from '@dnr/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, revertCommit, type TestRepo } from '../../../git/src/test-repo';
import { loadAnalyzer } from './analyzer';
import { classifyKnownReverts, UNCONFIRMED } from './known-reverts';
import { mine, PROFILES, toJsonl, toRevertCase } from './mine';
import { detectPython } from './python-version';
import { computeRdelta } from './rdelta';
import { renderEligibility } from './report';
import { planTestLabels } from './test-labels';
import { fallbackAnalyzer } from './units';

const QUERY = `class Query:
    def set_group_by(self):
        group_by = list(self.select)
        return group_by

    def other(self):
        return 1
`;
const QUERY_C = QUERY.replace(
  '        return group_by\n',
  '        group_by = [g for g in group_by if g]\n        return group_by\n',
);
const TESTS = `class AggTests:
    def test_old(self):
        pass
`;
const TESTS_C = `${TESTS}
    def test_group_by(self):
        assert True
`;

describe('mine on a synthetic django-like repo', () => {
  let r: TestRepo;
  const s: Record<string, string> = {};
  beforeAll(() => {
    r = makeRepo();
    r.write('django/db/models/sql/query.py', QUERY);
    r.write('tests/aggregation_regress/tests.py', TESTS);
    r.write('docs/index.txt', 'docs\n');
    r.write(
      'pyproject.toml',
      'requires-python = ">=3.10"\nclassifiers = [\n "Programming Language :: Python :: 3.10",\n "Programming Language :: Python :: 3.12",\n]\n',
    );
    s.base = r.commit('Initial');
    r.write('django/db/models/sql/query.py', QUERY_C);
    r.write('tests/aggregation_regress/tests.py', TESTS_C);
    s.c1 = r.commit('Fixed #26434 -- Changed set_group_by.');
    s.r1 = revertCommit(
      r,
      s.c1,
      `Reverted "Fixed #26434 -- Changed set_group_by."\n\nThis reverts commit ${s.c1}.\n\nThe implementation was flawed.`,
    );
    r.write('docs/index.txt', 'docs v2\n');
    s.c2 = r.commit('Doc tweak.');
    s.r2 = revertCommit(r, s.c2, `Revert "Doc tweak."\n\nThis reverts commit ${s.c2}.`);
    r.write('django/db/models/sql/query.py', QUERY.replace('return 1', 'return 2'));
    s.later = r.commit('Refs #1 -- Changed other().');
    r.write(
      'django/db/models/sql/query.py',
      QUERY.replace('return 1', 'return 2').replace('list(self.select)', 'tuple(self.select)'),
    );
    s.delta = r.commit('Refs #2 -- Touched set_group_by.');
    s.noise = r.commit('Mentioned revert in prose only.');
  });
  afterAll(() => r.cleanup());

  const run = () =>
    mine({ gitDir: r.dir, ref: 'main', profile: PROFILES.django, analyzer: fallbackAnalyzer });

  it('writes schema-valid, deterministic candidates', async () => {
    const a = await run();
    const b = await run();
    const ja = toJsonl(a.mined.map((m) => m.candidate));
    expect(ja).toBe(toJsonl(b.mined.map((m) => m.candidate)));
    const ra = renderEligibility(a, { repo: 'django', gitDir: r.dir, ref: 'main', labels: null });
    expect(ra).toBe(renderEligibility(b, { repo: 'django', gitDir: r.dir, ref: 'main', labels: null }));
    for (const line of ja.trim().split('\n')) Candidate.parse(JSON.parse(line));
    expect(ra).toContain('| W1 |');
  });

  it('classifies the code revert and the docs revert', async () => {
    const res = await run();
    const c1 = res.mined.find((m) => m.candidate.revert_sha === s.r1)?.candidate;
    expect(c1).toMatchObject({
      original_sha: s.c1,
      revert_kind: 'exact',
      window: 'W1',
      tickets: ['26434'],
      units: [{ file: 'django/db/models/sql/query.py', qualname: 'Query.set_group_by' }],
      proposed_category: 'CORRECTNESS_REGRESSION',
      skip_reason: 'pending:E5,E6',
    });
    expect(c1?.rules).toMatchObject({
      E1: 'pass',
      E2: 'pass',
      E3: 'pass',
      E4: 'pass',
      E5: 'pending',
      E6: 'pending',
      E7: 'pass',
      E8: 'pass',
    });
    const c2 = res.mined.find((m) => m.candidate.revert_sha === s.r2)?.candidate;
    expect(c2).toMatchObject({ proposed_category: 'DOCS_ONLY', units: [] });
    expect(c2?.rules.E4).toBe('fail');
  });

  it('applies labels and builds a RevertCase with rdelta', async () => {
    const labels = ['l1', 'l2'].map((labeler) => ({
      revert_sha: s.r1 as string,
      labeler,
      category: 'CORRECTNESS_REGRESSION' as const,
      adjudicated: false,
    }));
    const weighted = { ...fallbackAnalyzer, orderWeight: async () => 9 };
    const res = await mine({
      gitDir: r.dir,
      ref: 'main',
      profile: PROFILES.django,
      analyzer: weighted,
      labels,
    });
    const m = res.mined.find((x) => x.candidate.revert_sha === s.r1);
    expect(m?.outcome.eligible).toBe(true);
    const rd = await computeRdelta(r.dir, 'main', s.r1 as string, m?.candidate.units ?? [], fallbackAnalyzer);
    // Δ is the commit that touches set_group_by; R+Δ is its parent.
    expect(Object.entries(s).find(([, v]) => v === rd)?.[0]).toBe('later');
    const rc = toRevertCase(m as NonNullable<typeof m>, 'CORRECTNESS_REGRESSION', rd);
    expect(rc).toMatchObject({ role: null, eligible: true, skip_reason: null, rdelta_sha: s.later });
    expect(rd).toBe(s.later);
  });

  it('finds restored tests and the Python version', async () => {
    const plan = await planTestLabels(r.dir, s.c1 as string, s.r1 as string);
    expect(plan).toEqual({
      apps: ['aggregation_regress'],
      restored: {
        paths: ['tests/aggregation_regress/tests.py'],
        labels: ['aggregation_regress.tests.AggTests.test_group_by'],
      },
    });
    expect(await detectPython(r.dir, s.r1 as string)).toEqual({
      chosen: '3.12',
      declared: ['3.10', '3.12'],
      source: 'pyproject.toml',
      kind: 'uv',
    });
  });

  it('splits search hits into known and rejected', async () => {
    const { known, rejected } = await classifyKnownReverts(r.dir, 'main', [
      s.r1 as string,
      s.noise as string,
      s.c1 as string,
    ]);
    expect(known).toEqual([
      {
        sha: s.r1,
        subject: 'Reverted "Fixed #26434 -- Changed set_group_by."',
        matched_form: 'subject',
        confirmed_by: UNCONFIRMED,
      },
    ]);
    expect(rejected.map((x) => x.sha).sort()).toEqual([s.c1, s.noise].sort());
  });

  it('uses the engine analyzer for qualnames, E5 weights and E7', async () => {
    const analyzer = await loadAnalyzer();
    expect(analyzer.source).toBe('engine');
    const res = await mine({ gitDir: r.dir, ref: 'main', profile: PROFILES.django, analyzer });
    const c1 = res.mined.find((m) => m.candidate.revert_sha === s.r1)?.candidate;
    expect(c1?.units).toEqual([{ file: 'django/db/models/sql/query.py', qualname: 'Query.set_group_by' }]);
    expect(c1?.order_weight).toBeGreaterThanOrEqual(3);
    expect(c1?.rules).toMatchObject({ E4: 'pass', E5: 'pass', E6: 'pending', E7: 'pass' });
    expect(c1?.skip_reason).toBe('pending:E6');
  });
});
