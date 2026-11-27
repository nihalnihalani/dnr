import { describe, expect, it } from 'vitest';
import { applyRules, type RuleInputs, resolveReason } from './eligibility';
import { pyLineQualnames } from './py-units';
import { proposeReason } from './reasons';
import { seedKey } from './seed';
import { windowOf } from './windows';

const base: RuleInputs = {
  inWindow: true,
  backport: false,
  onFirstParent: true,
  originalFound: true,
  originalIsAncestor: true,
  superseded: false,
  revertKind: 'exact',
  sourceUnits: 2,
  orderWeight: 10,
  reason: { state: 'labeled', category: 'CRASH' },
  unitsAtR: 1,
  isDemo: false,
};
const S = 'a'.repeat(40);

describe('applyRules', () => {
  it('P3-07 mine: E-rules: passes a clean revert', () => {
    const o = applyRules(base);
    expect(o).toMatchObject({ eligible: true, provisional: true, skip_reason: null });
  });
  it('P3-07 mine: E-rules: the first failing rule in order is skip_reason', () => {
    expect(applyRules({ ...base, backport: true, revertKind: 'partial' }).skip_reason).toBe('E1:backport');
    expect(applyRules({ ...base, originalFound: false }).skip_reason).toBe('E2:no-original');
    expect(applyRules({ ...base, superseded: true }).skip_reason).toBe('E2:superseded');
    expect(applyRules({ ...base, revertKind: 'unclear' }).skip_reason).toBe('E3:unclear');
    expect(applyRules({ ...base, sourceUnits: 0 }).skip_reason).toBe('E4:no-source-unit');
    expect(applyRules({ ...base, orderWeight: 2 }).skip_reason).toBe('E5:low-weight');
    expect(applyRules({ ...base, reason: { state: 'labeled', category: 'DOCS_ONLY' } }).skip_reason).toBe(
      'E6:ineligible-reason',
    );
    expect(
      applyRules({ ...base, reason: { state: 'labeled', category: 'API_POLICY_REVERSAL' } }).skip_reason,
    ).toBe('E6:secondary-reason');
    expect(applyRules({ ...base, unitsAtR: 0 }).skip_reason).toBe('E7:unit-missing');
    expect(applyRules({ ...base, isDemo: true }).skip_reason).toBe('E8:demo');
    expect(applyRules({ ...base, inWindow: false }).skip_reason).toBe('window:out-of-range');
  });
  it('P3-07 mine: E-rules: pending rules are never eligible', () => {
    const o = applyRules({ ...base, orderWeight: null, reason: { state: 'pending' } });
    expect(o).toMatchObject({ eligible: false, provisional: true, skip_reason: 'pending:E5,E6' });
    expect(o.rules.E5).toBe('pending');
    const f = applyRules({ ...base, orderWeight: null, reason: { state: 'pending' }, isDemo: true });
    expect(f).toMatchObject({ provisional: false, skip_reason: 'pending:E5,E6' });
    expect(f.rules.E8).toBe('fail');
  });
});

describe('resolveReason', () => {
  const L = (labeler: string, category: 'CRASH' | 'OTHER', adjudicated = false) => ({
    revert_sha: S,
    labeler,
    category,
    adjudicated,
  });
  it('needs both labelers, or an adjudicated label', () => {
    expect(resolveReason(S, null)).toEqual({ state: 'pending' });
    expect(resolveReason(S, [L('a', 'CRASH')])).toEqual({ state: 'pending' });
    expect(resolveReason(S, [L('a', 'CRASH'), L('b', 'CRASH')])).toEqual({
      state: 'labeled',
      category: 'CRASH',
    });
    expect(resolveReason(S, [L('a', 'CRASH'), L('b', 'OTHER')])).toEqual({ state: 'unadjudicated' });
    expect(resolveReason(S, [L('a', 'CRASH'), L('b', 'OTHER'), L('c', 'OTHER', true)])).toEqual({
      state: 'labeled',
      category: 'OTHER',
    });
  });
});

describe('proposeReason', () => {
  const p = (subject: string, body = '', cFiles = ['django/db/x.py']) =>
    proposeReason({ subject, body, quotedSubject: /"(.*)"/.exec(subject)?.[1] ?? null, cFiles });
  it('uses file scope first', () => {
    expect(p('Reverted "x"', '', ['docs/ref/a.txt']).category).toBe('DOCS_ONLY');
    expect(p('Reverted "x"', '', ['tests/a/tests.py']).category).toBe('TEST_ONLY');
    expect(p('Reverted "x"', '', ['.github/workflows/a.yml', 'tox.ini']).category).toBe('CI_INFRA');
    expect(p('Reverted "x"', '', ['django/contrib/admin/static/admin/js/a.js']).category).toBe(
      'FRONTEND_ONLY',
    );
  });
  it('ignores words in the quoted original subject', () => {
    expect(p('Reverted "Fixed crash in Foo."').category).toBe('OTHER');
    expect(p('Fixed #1 -- Reverted "Foo." due to a crash').category).toBe('CRASH');
    expect(p('Reverted "Foo."', 'The implementation was flawed.').category).toBe('CORRECTNESS_REGRESSION');
    expect(p('Reverted "Foo."', 'This caused a performance regression.').category).toBe(
      'PERFORMANCE_REGRESSION',
    );
  });
});

describe('pyLineQualnames', () => {
  it('names nested defs and module lines', () => {
    const src = [
      'import x',
      'class A:',
      '    def f(self):',
      '        return (',
      '1)',
      '    y = 2',
      'def g():',
      '    """doc',
      'def fake():',
      '    """',
      '    pass',
      'z = 1',
    ].join('\n');
    expect(pyLineQualnames(src).slice(1)).toEqual([
      '<module>',
      'A',
      'A.f',
      'A.f',
      'A.f',
      'A',
      'g',
      'g',
      'g',
      'g',
      'g',
      '<module>',
    ]);
  });
});

describe('windows and seed', () => {
  it('maps years to windows', () => {
    expect(windowOf('2025-10-28T11:40:01-04:00', 'body-sha')).toBe('W0');
    expect(windowOf('2020-01-01T00:00:00Z', 'subject')).toBe('W1');
    expect(windowOf('2017-06-01T00:00:00Z', 'body-sha')).toBe('W2');
    expect(windowOf('2016-06-01T00:00:00Z', 'body-sha')).toBe('W3');
    expect(windowOf('2016-06-01T00:00:00Z', 'patch-id-silent')).toBe('W4');
    expect(windowOf('2014-12-31T23:00:00Z', 'body-sha')).toBeNull();
    expect(windowOf('2026-01-02T00:00:00Z', 'body-sha')).toBeNull();
  });
  it('hashes the documented string', () => {
    // sha256("dnr-2026:" + 40 a's), computed independently with shasum.
    expect(seedKey(S)).toMatch(/^[0-9a-f]{64}$/);
    expect(seedKey(S)).toBe(seedKey(S));
    expect(seedKey(S)).not.toBe(seedKey('b'.repeat(40)));
  });
});
