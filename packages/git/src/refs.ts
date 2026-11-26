import { git, runGit } from './exec';

const SHA40 = /^[0-9a-f]{40}$/;

/** Resolves a revision to a full commit SHA, or null when it does not resolve to a commit. */
export async function resolveCommit(repo: string, rev: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
    cwd: repo,
    okCodes: [0, 1, 128],
  });
  const out = r.stdout.trim();
  return r.code === 0 && SHA40.test(out) ? out : null;
}

export async function revParse(repo: string, rev: string): Promise<string> {
  const sha = await resolveCommit(repo, rev);
  if (!sha) throw new Error(`cannot resolve ${rev} in ${repo}`);
  return sha;
}

/** `git merge-base --is-ancestor a b` (true when a is an ancestor of, or equal to, b). */
export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  const r = await runGit(['merge-base', '--is-ancestor', a, b], { cwd: repo, okCodes: [0, 1] });
  return r.code === 0;
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string | null> {
  const r = await runGit(['merge-base', a, b], { cwd: repo, okCodes: [0, 1] });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function parents(repo: string, sha: string): Promise<string[]> {
  const out = await git(['rev-list', '--parents', '-n', '1', sha], { cwd: repo });
  return out.trim().split(/\s+/).slice(1);
}

export async function treeOf(repo: string, rev: string): Promise<string> {
  return (await git(['rev-parse', `${rev}^{tree}`], { cwd: repo })).trim();
}

/** Paths changed between a commit and its first parent (no rename detection). */
export async function changedPaths(repo: string, sha: string): Promise<string[]> {
  const out = await git(
    ['diff-tree', '--no-commit-id', '--root', '-r', '--no-renames', '-z', '--name-only', sha],
    {
      cwd: repo,
    },
  );
  return out.split('\0').filter((p) => p.length > 0);
}
