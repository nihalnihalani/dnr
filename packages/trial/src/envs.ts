/**
 * `dnr trial envs` (§9.1 steps 6–7): one shared dependency environment per revert (uv for Python
 * ≥ 3.8, a digest-pinned Docker image with committed constraints for 3.5–3.7), restored-test
 * validation (fail on R, pass on C; at R+Δ with C cherry-picked), flaky detection (two baseline
 * runs). Tests always run with PYTHONPATH=<the working copy>, never `-e .`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, readBlob, runGit } from '@dnr/git';
import type { DjangoPython, EnvMatrix } from '@dnr/schemas';
import { sha10 } from './arms';
import { detectPython } from './mine/python-version';
import { spawnGroup } from './runner';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string },
) => Promise<ExecResult>;

export const realExec: Exec = async (cmd, args, opts) => {
  const r = await spawnGroup(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    input: opts.input,
  });
  return {
    code: r.code,
    stdout: r.stdout,
    stderr: r.spawnError ? `${r.stderr}${r.spawnError}` : r.stderr,
    timedOut: r.timedOut,
  };
};

export type EnvEntry = EnvMatrix[number];

export interface DockerPins {
  /** `python:3.X-slim@sha256:…` by minor version, from pins.json docker_images. */
  images: Record<string, string>;
}

/** Python version for a checkout, §9.1 step 6 order (pyproject, setup.cfg, setup.py, tox.ini, CI, table). */
export async function pythonFor(gitDir: string, sha: string, table: DjangoPython | undefined) {
  return detectPython(gitDir, sha, table);
}

/** The minimal dependency set: `install_requires` from setup.cfg or `dependencies` from pyproject.toml, plus tblib. */
export async function minimalDeps(gitDir: string, sha: string): Promise<string[]> {
  const out = new Set<string>(['tblib']);
  const cfg = await readBlob(gitDir, sha, 'setup.cfg');
  const m = cfg ? /install_requires\s*=\s*\n((?:[ \t]+\S.*\n?)+)/.exec(cfg) : null;
  if (m) for (const l of (m[1] as string).split('\n')) if (l.trim()) out.add(l.trim());
  const py = await readBlob(gitDir, sha, 'pyproject.toml');
  const d = py ? /dependencies\s*=\s*\[([^\]]*)\]/.exec(py) : null;
  if (d) for (const x of (d[1] as string).matchAll(/["']([^"']+)["']/g)) out.add(x[1] as string);
  return [...out].sort();
}

export interface BuildEnvInput {
  revertSha: string;
  python: string;
  kind: 'uv' | 'docker';
  /** Checkout (the truncated repo at the start commit) that holds tests/requirements/. */
  checkout: string;
  gitDir: string;
  startSha: string;
  excludeNewer: string;
  envDir: string;
  constraintsFile: string;
  docker: DockerPins;
  exec: Exec;
  log?: (m: string) => void;
}

/** uv: `uv venv -p <ver> <env>`; `uv pip install --python <env> --exclude-newer <R date> -r tests/requirements/py3.txt`, minimal set on failure. */
export async function buildUvEnv(i: BuildEnvInput): Promise<{ ok: boolean; note: string }> {
  const log = i.log ?? (() => {});
  const v = await i.exec('uv', ['venv', '-q', '--allow-existing', '-p', i.python, i.envDir], {
    cwd: i.checkout,
  });
  if (v.code !== 0) return { ok: false, note: `uv venv failed: ${v.stderr.trim().slice(0, 300)}` };
  const py = join(i.envDir, 'bin', 'python');
  const req = join(i.checkout, 'tests/requirements/py3.txt');
  if (existsSync(req)) {
    const r = await i.exec(
      'uv',
      ['pip', 'install', '-q', '--python', py, '--exclude-newer', i.excludeNewer, '-r', req],
      {
        cwd: i.checkout,
      },
    );
    if (r.code === 0) return { ok: true, note: 'tests/requirements/py3.txt' };
    log(`uv pip install -r py3.txt failed for ${sha10(i.revertSha)}; trying the minimal set`);
  }
  const deps = await minimalDeps(i.gitDir, i.startSha);
  const r2 = await i.exec(
    'uv',
    ['pip', 'install', '-q', '--python', py, '--exclude-newer', i.excludeNewer, ...deps],
    {
      cwd: i.checkout,
    },
  );
  return r2.code === 0
    ? { ok: true, note: `minimal set (${deps.join(', ')})` }
    : { ok: false, note: `minimal install failed: ${r2.stderr.trim().slice(0, 300)}` };
}

export function dockerfile(image: string): string {
  return [
    `FROM ${image}`,
    'ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1',
    'COPY requirements/ /req/',
    'COPY constraints.txt /constraints.txt',
    'RUN pip install --no-cache-dir -c /constraints.txt -r /req/py3.txt',
    '',
  ].join('\n');
}

/**
 * Constraints (full transitive closure) for Python 3.5–3.7, generated once inside the digest-pinned
 * image with pypi-timemachine serving the index as of the revert date; committed as
 * `fixtures/constraints/<sha10>.txt`.
 */
export function constraintsScript(date: string): string {
  return [
    'set -e',
    'pip install -q pypi-timemachine >/dev/null',
    `(pypi-timemachine ${date} --port 9876 >/tmp/ptm.log 2>&1 &)`,
    'sleep 4',
    'pip install -q --index-url http://127.0.0.1:9876/ -r /req/py3.txt >/dev/null',
    'pip freeze --exclude pypi-timemachine',
  ].join('\n');
}

export async function buildDockerEnv(
  i: BuildEnvInput,
): Promise<{ ok: boolean; note: string; image: string | null }> {
  const minor = i.python;
  const image = i.docker.images[`python:${minor}-slim`] ?? i.docker.images[minor];
  if (!image)
    return { ok: false, note: `no digest-pinned image for Python ${minor} in pins.json`, image: null };
  const info = await i.exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
    cwd: i.checkout,
    timeoutMs: 30_000,
  });
  if (info.code !== 0)
    return { ok: false, note: `docker daemon unavailable: ${info.stderr.trim().slice(0, 200)}`, image: null };
  const ctx = await mkdtemp(join(tmpdir(), 'dnr-env-'));
  try {
    // The build context explicitly includes tests/requirements/ (as requirements/), from the start commit.
    await mkdir(join(ctx, 'requirements'), { recursive: true });
    const ex = await i.exec(
      '/bin/sh',
      [
        '-c',
        'set -o pipefail 2>/dev/null; git -C "$1" archive "$2" tests/requirements | (cd "$3/requirements" && tar -x --strip-components=2)',
        'sh',
        i.checkout,
        i.startSha,
        ctx,
      ],
      { cwd: ctx },
    );
    if (ex.code !== 0)
      return {
        ok: false,
        note: `could not export tests/requirements: ${ex.stderr.slice(0, 200)}`,
        image: null,
      };
    if (!existsSync(i.constraintsFile)) {
      const gen = await i.exec(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${join(ctx, 'requirements')}:/req:ro`,
          image,
          'sh',
          '-c',
          constraintsScript(i.excludeNewer),
        ],
        { cwd: ctx, timeoutMs: 60 * 60_000 },
      );
      if (gen.code !== 0)
        return { ok: false, note: `constraints generation failed: ${gen.stderr.slice(0, 300)}`, image: null };
      await mkdir(join(i.constraintsFile, '..'), { recursive: true });
      await writeFile(i.constraintsFile, gen.stdout);
    }
    await writeFile(join(ctx, 'constraints.txt'), readFileSync(i.constraintsFile, 'utf8'));
    await writeFile(join(ctx, 'Dockerfile'), dockerfile(image));
    const tag = `dnr-env-${sha10(i.revertSha)}`;
    const b = await i.exec('docker', ['build', '-q', '-t', tag, ctx], { cwd: ctx, timeoutMs: 60 * 60_000 });
    return b.code === 0
      ? { ok: true, note: `docker image ${tag}`, image: tag }
      : { ok: false, note: `docker build failed: ${b.stderr.slice(0, 300)}`, image: null };
  } finally {
    await rm(ctx, { recursive: true, force: true });
  }
}

/** The test command for an environment (§9.1 step 6), run with cwd = the working copy. */
export function testCommand(
  e: Pick<EnvEntry, 'kind' | 'path' | 'image'>,
  workdir: string,
  labels: string[],
  ids: { uid: number; gid: number } = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const tail = ['tests/runtests.py', '--parallel', '1', ...labels];
  if (e.kind === 'docker') {
    return {
      cmd: 'docker',
      args: [
        'run',
        '--rm',
        '--user',
        `${ids.uid}:${ids.gid}`,
        '-e',
        'PYTHONDONTWRITEBYTECODE=1',
        '-v',
        `${workdir}:/w`,
        '-e',
        'PYTHONPATH=/w',
        '-w',
        '/w',
        e.image as string,
        'python',
        ...tail,
      ],
      env: {},
    };
  }
  return {
    cmd: join(e.path, 'bin', 'python'),
    args: tail,
    env: { PYTHONPATH: workdir, PYTHONDONTWRITEBYTECODE: '1' },
  };
}

/** Failed test ids from Django's unittest runner output (`FAIL: test_x (mod.Class.test_x)`, `ERROR: …`). */
export function failedTests(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/^(?:FAIL|ERROR): (\S+) \(([^)]+)\)/gm)) {
    const inner = m[2] as string;
    out.add(inner.endsWith(`.${m[1]}`) ? inner : `${inner}.${m[1]}`);
  }
  return [...out].sort();
}

export interface TestRun {
  status: 'pass' | 'fail' | 'could-not-run';
  failed: string[];
  output: string;
}

export async function runTests(
  exec: Exec,
  e: EnvEntry | null,
  workdir: string,
  labels: string[],
  timeoutMs = 20 * 60_000,
): Promise<TestRun> {
  if (!e?.ok || labels.length === 0) return { status: 'could-not-run', failed: [], output: '' };
  const c = testCommand(e, workdir, labels);
  const r = await exec(c.cmd, c.args, { cwd: workdir, env: c.env, timeoutMs });
  const output = `${r.stdout}\n${r.stderr}`;
  // runtests prints "Ran N tests" whenever the suite itself ran; anything else is an environment failure.
  if (r.timedOut || !/^Ran \d+ tests?/m.test(output)) return { status: 'could-not-run', failed: [], output };
  return { status: r.code === 0 ? 'pass' : 'fail', failed: failedTests(output), output };
}

/** A scratch checkout of `sha` (git archive, no repo metadata) or of `onto` with `pick` cherry-picked. */
export async function scratchAt(
  repoDir: string,
  sha: string,
  pick?: string,
): Promise<{ dir: string; ok: boolean; note: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dnr-scratch-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  if (!pick) {
    await git(['clone', '-q', '--no-local', '--no-checkout', repoDir, dir], { cwd: tmpdir() });
    await git(['checkout', '-q', '--detach', sha], { cwd: dir });
    return { dir, ok: true, note: `checkout ${sha10(sha)}`, cleanup };
  }
  await git(['clone', '-q', '--no-local', repoDir, dir], { cwd: tmpdir() });
  await git(['checkout', '-q', '--detach', sha], { cwd: dir });
  const cp = await runGit(['cherry-pick', '--no-commit', pick], { cwd: dir, okCodes: [0, 1] });
  return cp.code === 0
    ? { dir, ok: true, note: `${sha10(pick)} cherry-picked onto ${sha10(sha)}`, cleanup }
    : { dir, ok: false, note: `cherry-pick of ${sha10(pick)} onto ${sha10(sha)} conflicts`, cleanup };
}

export interface Validation {
  fails_post_revert: boolean | null;
  passes_on_original: boolean | null;
  valid: boolean;
  flaky: string[];
  note: string;
}

/**
 * Restored tests are valid only if they fail at the start state (R, or R+Δ) and pass with C
 * (C itself, or C cherry-picked onto R+Δ; a conflict makes them invalid). Each state is run twice;
 * tests whose outcome differs between the two runs are flaky.
 */
export async function validateRestored(i: {
  exec: Exec;
  env: EnvEntry;
  repoDir: string;
  startSha: string;
  originalSha: string;
  rdelta: boolean;
  labels: string[];
}): Promise<Validation> {
  if (i.labels.length === 0)
    return {
      fails_post_revert: null,
      passes_on_original: null,
      valid: false,
      flaky: [],
      note: 'no restored tests',
    };
  const atStart = await scratchAt(i.repoDir, i.startSha);
  const withC = i.rdelta
    ? await scratchAt(i.repoDir, i.startSha, i.originalSha)
    : await scratchAt(i.repoDir, i.originalSha);
  try {
    const flaky = new Set<string>();
    const twice = async (dir: string) => {
      const a = await runTests(i.exec, i.env, dir, i.labels);
      const b = await runTests(i.exec, i.env, dir, i.labels);
      const fa = new Set(a.failed);
      const fb = new Set(b.failed);
      for (const t of [...fa, ...fb]) if (fa.has(t) !== fb.has(t)) flaky.add(t);
      if (a.status !== b.status) for (const t of i.labels) flaky.add(t);
      return a.status === b.status ? a.status : 'could-not-run';
    };
    const r = await twice(atStart.dir);
    if (!withC.ok) {
      return {
        fails_post_revert: r === 'fail',
        passes_on_original: null,
        valid: false,
        flaky: [...flaky].sort(),
        note: withC.note,
      };
    }
    const c = await twice(withC.dir);
    const fails = r === 'could-not-run' ? null : r === 'fail';
    const passes = c === 'could-not-run' ? null : c === 'pass';
    return {
      fails_post_revert: fails,
      passes_on_original: passes,
      valid: fails === true && passes === true && flaky.size === 0,
      flaky: [...flaky].sort(),
      note: `start ${r}, with C ${c}`,
    };
  } finally {
    await atStart.cleanup();
    await withC.cleanup();
  }
}
