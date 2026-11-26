import { runGit } from './exec';

/** Reads `<sha>:<path>` as UTF-8 text, or null when the path does not exist at that commit. */
export async function readBlob(repo: string, sha: string, path: string): Promise<string | null> {
  const r = await runGit(['cat-file', 'blob', `${sha}:${path}`], { cwd: repo, okCodes: [0, 128] });
  return r.code === 0 ? r.stdout : null;
}

/** Lists file paths at a commit, optionally under a prefix. */
export async function listTree(repo: string, sha: string, prefix?: string): Promise<string[]> {
  const args = ['ls-tree', '-r', '-z', '--name-only', sha];
  if (prefix) args.push('--', prefix);
  const r = await runGit(args, { cwd: repo });
  return r.stdout.split('\0').filter((p) => p.length > 0);
}
