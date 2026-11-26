import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, runGit } from './exec';
import { changedPaths } from './refs';

export interface RevertReproduction {
  /** `git revert --no-commit C` applied cleanly on R^. */
  applied: boolean;
  /** Paths where the reverted index differs from R's tree. */
  differing: string[];
  /** Of those, paths C also touched (any entry here means R does not undo C fully). */
  differingInC: string[];
}

/**
 * Reproduction check for `revert_kind: full` (§9.1 step 2): in a temporary detached worktree at
 * `R^`, run `git revert --no-commit C` and compare the resulting index with R's tree, path by path.
 * The worktree is always removed.
 */
export async function reproduceRevert(
  repo: string,
  original: string,
  revert: string,
): Promise<RevertReproduction> {
  const dir = await mkdtemp(join(tmpdir(), 'dnr-revert-'));
  const wt = join(dir, 'wt');
  let added = false;
  try {
    await git(['worktree', 'add', '--detach', '--quiet', wt, `${revert}^`], { cwd: repo });
    added = true;
    const r = await runGit(['revert', '--no-commit', '--no-edit', original], {
      cwd: wt,
      okCodes: [0, 1, 128], // 1: conflicts; 128: e.g. original is a merge
      env: {
        GIT_EDITOR: 'true',
        GIT_AUTHOR_NAME: 'dnr',
        GIT_AUTHOR_EMAIL: 'dnr@invalid',
        GIT_COMMITTER_NAME: 'dnr',
        GIT_COMMITTER_EMAIL: 'dnr@invalid',
      },
    });
    if (r.code !== 0) return { applied: false, differing: [], differingInC: [] };
    const out = await git(['diff', '--cached', '--no-renames', '-z', '--name-only', revert], { cwd: wt });
    const differing = out.split('\0').filter(Boolean).sort();
    const cPaths = new Set(await changedPaths(repo, original));
    return { applied: true, differing, differingInC: differing.filter((p) => cPaths.has(p)) };
  } finally {
    if (added) await runGit(['worktree', 'remove', '--force', wt], { cwd: repo, okCodes: [0, 128] });
    await rm(dir, { recursive: true, force: true });
    await runGit(['worktree', 'prune'], { cwd: repo, okCodes: [0, 128] });
  }
}

/** True when the revert applies cleanly and the result equals R's tree exactly. */
export async function revertReproduces(repo: string, original: string, revert: string): Promise<boolean> {
  const r = await reproduceRevert(repo, original, revert);
  return r.applied && r.differing.length === 0;
}
