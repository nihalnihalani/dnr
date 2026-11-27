/**
 * `trial envs` inputs that need no Python: the minimal dependency set, the restored-test overlay,
 * and the reapply/reland counter. Real git repositories in a temp dir; nothing is stubbed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, type TestRepo } from '../../git/src/test-repo';
import { minimalDeps, overlayFiles, restoreTestSide } from './envs';
import { countRelands } from './mine/reproposals';

describe('trial envs on a real repo', () => {
  let r: TestRepo;
  let c: string;
  let rv: string;
  let land: string;
  const out = mkdtempSync(join(tmpdir(), 'dnr-overlay-'));

  beforeAll(() => {
    r = makeRepo();
    r.write(
      'pyproject.toml',
      [
        '[project]',
        'name = "x"',
        'dependencies = [',
        '    "asgiref>=3.9.1",',
        '    "sqlparse>=0.5.0",',
        '    "tzdata; sys_platform == \'win32\'",',
        ']',
        '',
      ].join('\n'),
    );
    r.write('pkg/a.py', 'def f():\n    return 1\n');
    r.write('tests/app/tests.py', 'def test_old():\n    pass\n');
    r.commit('Initial');
    r.write('pkg/a.py', 'def f():\n    return 2\n');
    r.write('tests/app/tests.py', 'def test_old():\n    pass\n\n\ndef test_new():\n    assert f() == 2\n');
    c = r.commit('Fixed #1 -- Changed f.');
    // The restored test's support model lands after C, and R removes it along with the test.
    r.write('tests/app/models.py', 'class Thing:\n    pass\n');
    r.commit('Added a test model.');
    r.write('pkg/a.py', 'def f():\n    return 1\n');
    r.write('tests/app/tests.py', 'def test_old():\n    pass\n');
    r.git('rm', '-q', 'tests/app/models.py');
    r.write('tests/app/added_by_r.py', 'x = 1\n');
    rv = r.commit(`Reverted "Fixed #1 -- Changed f."\n\nThis reverts commit ${c}.`);
    r.write('pkg/a.py', 'def f():\n    return 2\n');
    land = r.commit('Reapplied "Fixed #1 -- Changed f." with a fix.');
    r.write('pkg/b.py', 'x = 1\n');
    r.commit('Added b.\n\nWe may re-land the rest later.');
    r.write('pkg/c.py', 'y = 1\n');
    r.commit('Applied the landing page styles.');
  });
  afterAll(() => {
    r.cleanup();
    rmSync(out, { recursive: true, force: true });
  });

  it('P3-14: the minimal dependency set keeps quoted markers whole', async () => {
    expect(await minimalDeps(r.dir, c)).toEqual([
      'asgiref>=3.9.1',
      'sqlparse>=0.5.0',
      'tblib',
      "tzdata; sys_platform == 'win32'",
    ]);
  });

  it('P3-14: restored tests are put back from R^ onto the start state', async () => {
    await overlayFiles(r.dir, `${rv}^`, ['tests/app/tests.py'], out);
    const text = readFileSync(join(out, 'tests/app/tests.py'), 'utf8');
    expect(text).toContain('def test_new()');
    expect(existsSync(join(out, 'pkg/a.py'))).toBe(false);
    await expect(overlayFiles(r.dir, `${rv}^`, ['tests/missing.py'], out)).rejects.toThrow(/does not exist/);
  });

  it("P3-14: the start state gets R's whole test-side change undone, support files included", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnr-restore-'));
    try {
      r.git('--work-tree', dir, 'checkout', rv, '--', '.');
      expect(await restoreTestSide(r.dir, rv, ['tests/app/tests.py'], dir)).toEqual([
        'tests/app/models.py',
        'tests/app/tests.py',
      ]);
      expect(readFileSync(join(dir, 'tests/app/models.py'), 'utf8')).toContain('class Thing');
      expect(readFileSync(join(dir, 'tests/app/tests.py'), 'utf8')).toContain('def test_new()');
      expect(existsSync(join(dir, 'tests/app/added_by_r.py'))).toBe(false);
      expect(readFileSync(join(dir, 'pkg/a.py'), 'utf8')).toContain('return 1');
      await expect(restoreTestSide(r.dir, rv, ['tests/other.py'], dir)).rejects.toThrow(/did not change/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P3-19: counts reapply/reland commits, and subjects separately', async () => {
    const { rows, shas } = await countRelands(r.dir, 'main', 'CPython');
    expect(rows.map((x) => [x.what, x.count])).toEqual([
      ['CPython commits whose message mentions reapply/reland', 2],
      ['…of which the CPython subject itself says reapply/reland', 1],
    ]);
    expect(shas).toEqual([land]);
  });
});

describe('testCommand', () => {
  it('P3-14: passes --parallel only to a runtests.py that has it (Django 1.8 has none)', async () => {
    const { testCommand } = await import('./envs');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const d = mkdtempSync(join(tmpdir(), 'dnr-runtests-'));
    try {
      mkdirSync(join(d, 'tests'));
      const env = { kind: 'uv' as const, path: '/env', image: null };
      writeFileSync(join(d, 'tests/runtests.py'), "parser.add_argument('--failfast')\n");
      expect(testCommand(env, d, ['a.b']).args).toEqual(['tests/runtests.py', 'a.b']);
      writeFileSync(join(d, 'tests/runtests.py'), "parser.add_argument('--parallel')\n");
      expect(testCommand(env, d, ['a.b']).args).toEqual(['tests/runtests.py', '--parallel', '1', 'a.b']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
