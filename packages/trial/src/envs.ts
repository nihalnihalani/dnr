/**
 * `dnr trial envs` (§9.1 steps 6–7): one shared dependency environment per revert (uv for Python
 * ≥ 3.8, a digest-pinned Docker image with committed constraints for 3.5–3.7), restored-test
 * validation (fail on R, pass on C; at R+Δ with C cherry-picked), flaky detection (two baseline
 * runs). Tests always run with PYTHONPATH=<the working copy>, never `-e .`.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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

/** The minimal dependency set: `install_requires` from setup.cfg or setup.py, or `dependencies` from pyproject.toml, plus tblib. */
export async function minimalDeps(gitDir: string, sha: string): Promise<string[]> {
  const out = new Set<string>(['tblib']);
  const cfg = await readBlob(gitDir, sha, 'setup.cfg');
  const m = cfg ? /install_requires\s*=\s*\n((?:[ \t]+\S.*\n?)+)/.exec(cfg) : null;
  if (m) for (const l of (m[1] as string).split('\n')) if (l.trim()) out.add(l.trim());
  // Older Django (before setup.cfg metadata): setup.py `install_requires=['pytz', …]`.
  const setup = await readBlob(gitDir, sha, 'setup.py');
  const sp = setup ? /install_requires\s*=\s*\[([^\]]*)\]/.exec(setup) : null;
  if (sp)
    for (const x of (sp[1] as string).matchAll(/"([^"]+)"|'([^']+)'/g)) out.add((x[1] ?? x[2]) as string);
  const py = await readBlob(gitDir, sha, 'pyproject.toml');
  const d = py ? /dependencies\s*=\s*\[([^\]]*)\]/.exec(py) : null;
  // A quoted requirement may itself hold the other quote: "tzdata; sys_platform == 'win32'".
  if (d) for (const x of (d[1] as string).matchAll(/"([^"]+)"|'([^']+)'/g)) out.add((x[1] ?? x[2]) as string);
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
    const why = /error: [^\n]*|fatal error: [^\n]*/.exec(r.stderr)?.[0] ?? r.stderr.trim().slice(-200);
    log(`uv pip install -r py3.txt failed for ${sha10(i.revertSha)} (${why.trim()}); trying the minimal set`);
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

export function dockerfile(image: string, reqFile = 'py3.txt'): string {
  return [
    `FROM ${image}`,
    'ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1',
    'COPY requirements/ /req/',
    'COPY constraints.txt /constraints.txt',
    `RUN pip install --no-cache-dir -c /constraints.txt -r /req/${reqFile}`,
    '',
  ].join('\n');
}

/** The first line of a committed constraints file names the requirement set it pins. */
export const CONSTRAINTS_HEADER = '# dnr: requirements=';

export function constraintsRequirements(text: string): string {
  const first = text.split('\n')[0] ?? '';
  return first.startsWith(CONSTRAINTS_HEADER) ? first.slice(CONSTRAINTS_HEADER.length).trim() : 'py3.txt';
}

/** pypi-timemachine's cutoff: the revert's commit time in UTC, without an offset. */
export function cutoffUtc(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19);
}

/**
 * Constraints (full transitive closure) for Python 3.5–3.7, generated once inside the digest-pinned
 * image with pypi-timemachine serving the index as of the revert date; committed as
 * `fixtures/constraints/<sha10>.txt`. pypi-timemachine runs from its own venv so its own
 * dependencies stay out of `pip freeze`. The release pip resolves depends on the image: 0.1
 * (Python 3.5, 3.6) picks a random port and prints it, so the port is read from its log; 0.2
 * (Python 3.7) takes `--port` and prints nothing. Either way pip waits until the port accepts.
 */
export function constraintsScript(date: string, reqFile = 'py3.txt'): string {
  const cutoff = cutoffUtc(date);
  return [
    'set -e',
    'python -m venv /ptm',
    '/ptm/bin/pip install -q pypi-timemachine >/tmp/ptm-install.log 2>&1 || { cat /tmp/ptm-install.log >&2; exit 3; }',
    'port=""',
    'if /ptm/bin/pypi-timemachine --help 2>/dev/null | grep -q -- --port; then',
    `  port=9876; (/ptm/bin/pypi-timemachine ${cutoff} --port 9876 >/tmp/ptm.log 2>&1 &)`,
    'else',
    `  (/ptm/bin/pypi-timemachine ${cutoff} >/tmp/ptm.log 2>&1 &)`,
    'fi',
    'up=""',
    'for i in $(seq 1 60); do',
    '  [ -n "$port" ] || port=$(sed -n \'s#.*Running on http://127.0.0.1:\\([0-9]*\\).*#\\1#p\' /tmp/ptm.log | head -n 1)',
    '  if [ -n "$port" ] && python -c "import socket,sys; socket.create_connection((\'127.0.0.1\', int(sys.argv[1])), 1)" "$port" 2>/dev/null; then up=1; break; fi',
    '  sleep 1',
    'done',
    '[ -n "$up" ] || { echo "pypi-timemachine did not start" >&2; cat /tmp/ptm.log >&2; exit 3; }',
    `pip install -q --index-url "http://127.0.0.1:$port/" --trusted-host 127.0.0.1 -r /req/${reqFile} >/tmp/pip.log 2>&1 || { tail -n 30 /tmp/pip.log >&2; exit 4; }`,
    `echo '${CONSTRAINTS_HEADER}${reqFile}'`,
    'pip freeze',
  ].join('\n');
}

export async function buildDockerEnv(
  i: BuildEnvInput,
): Promise<{ ok: boolean; note: string; image: string | null }> {
  const log = i.log ?? (() => {});
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
    // The §9.1 step 6 minimal set, offered when py3.txt cannot be installed in the image.
    const minimal = await minimalDeps(i.gitDir, i.startSha);
    await writeFile(join(ctx, 'requirements', 'minimal.txt'), `${minimal.join('\n')}\n`);
    if (!existsSync(i.constraintsFile)) {
      const generate = (reqFile: string) =>
        i.exec(
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${realpathSync(join(ctx, 'requirements'))}:/req:ro`,
            image,
            'sh',
            '-c',
            constraintsScript(i.excludeNewer, reqFile),
          ],
          { cwd: ctx, timeoutMs: 60 * 60_000 },
        );
      let gen = await generate('py3.txt');
      if (gen.code === 4) {
        const why = /error: [^\n]*|ERROR: [^\n]*/.exec(gen.stderr)?.[0] ?? gen.stderr.trim().slice(-200);
        log(
          `py3.txt does not install in ${image.split('@')[0]} for ${sha10(i.revertSha)} (${why}); trying the minimal set`,
        );
        gen = await generate('minimal.txt');
      }
      if (gen.code !== 0)
        return {
          ok: false,
          note: `constraints generation failed (exit ${gen.code}): ${gen.stderr.trim().slice(-400)}`,
          image: null,
        };
      await mkdir(join(i.constraintsFile, '..'), { recursive: true });
      await writeFile(i.constraintsFile, gen.stdout);
    }
    const constraints = readFileSync(i.constraintsFile, 'utf8');
    const reqFile = constraintsRequirements(constraints);
    await writeFile(join(ctx, 'constraints.txt'), constraints);
    await writeFile(join(ctx, 'Dockerfile'), dockerfile(image, reqFile));
    const tag = `dnr-env-${sha10(i.revertSha)}`;
    const b = await i.exec('docker', ['build', '-q', '-t', tag, ctx], { cwd: ctx, timeoutMs: 60 * 60_000 });
    return b.code === 0
      ? { ok: true, note: `docker image ${tag} (${reqFile})`, image: tag }
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
        // The real path: on macOS tmpdir() is under the /var symlink, which a Docker VM
        // (colima, Docker Desktop) only shares as /private/var/….
        `${realpathSync(workdir)}:/w`,
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

/** Writes `rev:<path>` from `repoDir` into `dir` for each path (a missing blob is an error). */
export async function overlayFiles(
  repoDir: string,
  rev: string,
  paths: string[],
  dir: string,
): Promise<void> {
  for (const p of paths) {
    const text = await readBlob(repoDir, rev, p);
    if (text === null) throw new Error(`${rev}:${p} does not exist; cannot restore the test file`);
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), text);
  }
}

/**
 * Puts every `tests/` file R changed back to its `R^` state in `dir` (a file R added is removed).
 * `paths` (the files holding the restored tests) must be among them.
 */
export async function restoreTestSide(
  repoDir: string,
  revertSha: string,
  paths: string[],
  dir: string,
): Promise<string[]> {
  const out = await git(
    ['diff', '--no-renames', '--name-status', `${revertSha}^`, revertSha, '--', 'tests/'],
    {
      cwd: repoDir,
    },
  );
  const changed: string[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t') as [string, string];
    if (status === 'A') await rm(join(dir, file), { force: true });
    else changed.push(file);
  }
  const missing = paths.filter((p) => !changed.includes(p));
  if (missing.length > 0) throw new Error(`R did not change ${missing.join(', ')}; not restored tests`);
  await overlayFiles(repoDir, `${revertSha}^`, changed, dir);
  return changed.sort();
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
  /** R: the restored test files are put back from `R^` (the state R deleted them from). */
  revertSha: string;
  rdelta: boolean;
  labels: string[];
  /** The test files that hold the restored tests (`restored_tests.paths`). */
  paths: string[];
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
  // At the start state the restored tests were deleted, so running their labels there proves
  // nothing. Undo R's whole test-side change (the restored tests plus the models and helpers
  // they import, which R removed with them): R's code, with the tests as they were at R^.
  try {
    await restoreTestSide(i.repoDir, i.revertSha, i.paths, atStart.dir);
  } catch (e) {
    await atStart.cleanup();
    throw e;
  }
  const withC = i.rdelta
    ? await scratchAt(i.repoDir, i.startSha, i.originalSha)
    : await scratchAt(i.repoDir, i.originalSha);
  try {
    const flaky = new Set<string>();
    const twice = async (dir: string, keep?: TestRun[]) => {
      const a = await runTests(i.exec, i.env, dir, i.labels);
      const b = await runTests(i.exec, i.env, dir, i.labels);
      keep?.push(a, b);
      const fa = new Set(a.failed);
      const fb = new Set(b.failed);
      for (const t of [...fa, ...fb]) if (fa.has(t) !== fb.has(t)) flaky.add(t);
      if (a.status !== b.status) for (const t of i.labels) flaky.add(t);
      return a.status === b.status ? a.status : 'could-not-run';
    };
    const startRuns: TestRun[] = [];
    const r = await twice(atStart.dir, startRuns);
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
    // "Fails on R" means each restored test itself fails, not that its module failed to import.
    const missed = r === 'fail' ? i.labels.filter((l) => !startRuns.every((t) => t.failed.includes(l))) : [];
    const fails = r === 'could-not-run' ? null : r === 'fail' && missed.length === 0;
    const passes = c === 'could-not-run' ? null : c === 'pass';
    return {
      fails_post_revert: fails,
      passes_on_original: passes,
      valid: fails === true && passes === true && flaky.size === 0,
      flaky: [...flaky].sort(),
      note: `start ${r}${missed.length > 0 ? ` (not failing there: ${missed.join(', ')})` : ''}, with C ${c}`,
    };
  } finally {
    await atStart.cleanup();
    await withC.cleanup();
  }
}
