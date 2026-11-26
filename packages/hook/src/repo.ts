/**
 * Repository text access for one hook invocation: baseline-tree, snapshot and HEAD blobs come
 * from one `git cat-file --batch`; the session's current state is the working tree.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { catBlobs } from '@dnr/git';

export function readWorktree(repoRoot: string, rel: string): string | null {
  try {
    return readFileSync(join(repoRoot, rel), 'utf8');
  } catch {
    return null;
  }
}

/** realpath of the deepest existing ancestor, with the missing tail re-attached. */
export function realpathLoose(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      // .native returns the on-disk casing (case-insensitive filesystems, wave-2 C2).
      const r = realpathSync.native(cur);
      return tail.length ? join(r, ...tail.reverse()) : r;
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs;
      tail.push(basename(cur));
      cur = up;
    }
  }
}

/** Repo-relative POSIX path of an absolute path, or null when it is outside the repo. */
export function repoRelative(repoRoot: string, absPath: string): string | null {
  const root = realpathLoose(repoRoot);
  const p = realpathLoose(absPath);
  const rel = relative(root, p);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep) || resolve(root, rel) !== p) return null;
  return rel.split(sep).join('/');
}

/** Batched blob reader keyed by `<rev>:<path>`, memoised per invocation. */
export class BlobReader {
  private cache = new Map<string, string | null>();
  constructor(readonly repoRoot: string) {}

  async prefetch(specs: readonly string[]): Promise<void> {
    const need = specs.filter((s) => !this.cache.has(s));
    if (need.length === 0) return;
    const got = await catBlobs(this.repoRoot, need);
    for (const s of need) this.cache.set(s, got.get(s) ?? null);
  }

  /** Synchronous read of a prefetched spec (null when absent or not prefetched). */
  get(rev: string, path: string): string | null {
    return this.cache.get(`${rev}:${path}`) ?? null;
  }

  async read(rev: string, path: string): Promise<string | null> {
    await this.prefetch([`${rev}:${path}`]);
    return this.get(rev, path);
  }
}

export function hasGit(repoRoot: string): boolean {
  return existsSync(join(repoRoot, '.git'));
}
