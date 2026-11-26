/**
 * §9.11 second repo (namespace `repo2`): CPython builds (`./configure && make -j` once per revert,
 * the run's `Lib/` rsynced over a scratch copy of the build tree before `./python -m test`), or a
 * sympy uv environment with mpmath and pytest pinned to the revert date.
 */
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec, TestRun } from './envs';

/** Source root and the test directories that E4 excludes for each repo (§9.11). */
export const REPO2 = {
  cpython: { sourceRoot: 'Lib/', testDirs: ['Lib/test/'] },
  sympy: { sourceRoot: 'sympy/', testDirs: ['/tests/'] },
} as const;

/** Package-aware module map: `Lib/foo.py → test_foo`, `Lib/pkg/** → test_pkg`. */
export function cpythonTestModule(file: string): string | null {
  const m = /^Lib\/([^/]+?)(\.py)?(\/.*)?$/.exec(file);
  if (!m || file.startsWith('Lib/test/')) return null;
  const top = m[1] as string;
  if (m[2] && !m[3]) return `test_${top}`;
  if (m[3]) return `test_${top}`;
  return null;
}

/** `sympy/<pkg>/…/<x>.py → sympy/<pkg>/tests/test_<x>.py` (the nearest package's tests). */
export function sympyTestFile(file: string): string | null {
  const m = /^(sympy\/(?:[^/]+\/)*?)([^/]+)\.py$/.exec(file);
  if (!m || file.includes('/tests/')) return null;
  return `${m[1]}tests/test_${m[2]}.py`;
}

export function pythonExe(buildDir: string): string {
  return existsSync(join(buildDir, 'python.exe')) ? './python.exe' : './python';
}

export async function buildCpython(
  exec: Exec,
  repoDir: string,
  buildDir: string,
): Promise<{ ok: boolean; note: string }> {
  if (!existsSync(join(buildDir, 'Makefile'))) {
    const c = await exec('git', ['clone', '-q', '--no-local', repoDir, buildDir], { cwd: tmpdir() });
    if (c.code !== 0) return { ok: false, note: `clone failed: ${c.stderr.slice(0, 200)}` };
    const cf = await exec('./configure', ['-q'], { cwd: buildDir, timeoutMs: 30 * 60_000 });
    if (cf.code !== 0) return { ok: false, note: `configure failed: ${cf.stderr.slice(0, 200)}` };
  }
  const mk = await exec('make', ['-j8', '-s'], { cwd: buildDir, timeoutMs: 90 * 60_000 });
  return mk.code === 0
    ? { ok: true, note: 'cpython build' }
    : { ok: false, note: `make failed: ${mk.stderr.slice(-300)}` };
}

/** rsync the run's Lib/ over a scratch copy of the build, then `./python -m test <modules>`. */
export async function runCpythonTests(
  exec: Exec,
  buildDir: string,
  workdir: string,
  modules: string[],
): Promise<TestRun> {
  if (modules.length === 0) return { status: 'could-not-run', failed: [], output: '' };
  const scratch = await mkdtemp(join(tmpdir(), 'dnr-cpy-'));
  try {
    await cp(buildDir, scratch, { recursive: true });
    const rs = await exec('rsync', ['-a', '--delete', `${workdir}/Lib/`, `${scratch}/Lib/`], {
      cwd: scratch,
    });
    if (rs.code !== 0) return { status: 'could-not-run', failed: [], output: rs.stderr };
    const r = await exec(pythonExe(scratch), ['-m', 'test', ...modules], {
      cwd: scratch,
      timeoutMs: 30 * 60_000,
    });
    const output = `${r.stdout}\n${r.stderr}`;
    if (r.timedOut || !/Tests? result:|tests? OK|== Tests result/i.test(output))
      return { status: 'could-not-run', failed: [], output };
    const failed = [...output.matchAll(/^(test_\S+) failed/gm)].map((m) => m[1] as string);
    return { status: r.code === 0 ? 'pass' : 'fail', failed, output };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function sympyTestCommand(envDir: string, files: string[]): { cmd: string; args: string[] } {
  return { cmd: join(envDir, 'bin', 'python'), args: ['bin/test', ...files] };
}
