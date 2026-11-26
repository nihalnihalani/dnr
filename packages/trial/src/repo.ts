/**
 * §9.3 truncated repo per start commit, and one `git clone --no-local` working copy per run.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { git, runGit } from '@dnr/git';

/**
 * `git init -b scratch <dir>; git fetch --no-tags <src> <sha>; git checkout -B main FETCH_HEAD`.
 * Idempotent: an existing repo whose main is already at `sha` is kept.
 */
export async function buildTruncatedRepo(src: string, sha: string, dir: string): Promise<void> {
  if (existsSync(dir)) {
    const head = await runGit(['rev-parse', '--verify', '-q', 'refs/heads/main'], {
      cwd: dir,
      okCodes: [0, 1, 128],
    });
    if (head.code === 0 && head.stdout.trim() === sha) return;
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
  await git(['init', '-q', '-b', 'scratch'], { cwd: dir });
  await git(['fetch', '-q', '--no-tags', src, sha], { cwd: dir });
  await git(['checkout', '-q', '-B', 'main', 'FETCH_HEAD'], { cwd: dir });
  // Drop FETCH_HEAD so no ref other than main names a commit (the check below covers --all).
  await rm(`${dir}/.git/FETCH_HEAD`, { force: true });
}

/**
 * Acceptance (§9.3, P9-02/P11-04): `git log --all` shows nothing newer than `start` — every commit
 * reachable from any ref is an ancestor of (or equal to) `start`, and no committer date is later.
 */
export async function checkNothingNewer(
  dir: string,
  start: string,
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const beyond = (await git(['rev-list', '--all', '--not', start], { cwd: dir })).trim();
  if (beyond)
    problems.push(`commits not reachable from ${start}: ${beyond.split('\n').slice(0, 5).join(', ')}`);
  const startT = Number((await git(['log', '-1', '--format=%ct', start], { cwd: dir })).trim());
  const maxT = Math.max(
    ...(await git(['log', '--all', '--format=%ct'], { cwd: dir })).split('\n').filter(Boolean).map(Number),
  );
  if (maxT > startT) problems.push(`a commit is dated after ${start} (${maxT} > ${startT})`);
  return { ok: problems.length === 0, problems };
}

/** Fresh working copy per run: `git clone --no-local <repo> <dir>`; HEAD must equal `start`. */
export async function cloneRun(repoDir: string, dir: string, start: string): Promise<void> {
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  await git(['clone', '-q', '--no-local', repoDir, dir], { cwd: dirname(dir) });
  const head = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
  if (head !== start) throw new Error(`clone ${dir}: HEAD ${head} ≠ start ${start}`);
  // The clone's origin points at the truncated repo; remove it so nothing outside the copy is named.
  await git(['remote', 'remove', 'origin'], { cwd: dir });
}

/**
 * The run diff (§9.3): `git add -A -N && git diff <start> -- . ':!.kiro' ':!.dnr' ':!.gitignore'`.
 * Uses a throwaway index so the agent's own index is left as it was.
 */
export async function runDiff(dir: string, start: string): Promise<string> {
  const env = { GIT_INDEX_FILE: `${dir}/.git/dnr-diff-index` };
  await rm(env.GIT_INDEX_FILE, { force: true });
  await git(['read-tree', 'HEAD'], { cwd: dir, env });
  await git(['add', '-A', '-N'], { cwd: dir, env });
  const out = await git(
    ['diff', '--no-color', '--no-ext-diff', start, '--', '.', ':!.kiro', ':!.dnr', ':!.gitignore'],
    {
      cwd: dir,
      env,
    },
  );
  await rm(env.GIT_INDEX_FILE, { force: true });
  return out;
}

/** Files that are not in git (untracked, not ignored) — used to check a fresh working copy is clean. */
export async function porcelain(dir: string): Promise<string[]> {
  return (await git(['status', '--porcelain', '--untracked-files=all'], { cwd: dir }))
    .split('\n')
    .filter(Boolean);
}

export async function isAncestor(gitDir: string, a: string, b: string): Promise<boolean> {
  const r = await runGit(['merge-base', '--is-ancestor', a, b], { cwd: gitDir, okCodes: [0, 1, 128] });
  return r.code === 0;
}
