/**
 * Read HEAD without spawning git (hook latency, wave-3 N8) and classify the repository's health
 * (wave-3 N1: a broken repository is tampering, not a DNR bug). Added by the hook/CLI workstream.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface GitDirs {
  /** $GIT_DIR (the worktree's gitdir for a linked worktree). */
  gitDir: string;
  /** $GIT_COMMON_DIR (refs, objects, packed-refs). */
  commonDir: string;
}

export function gitDirs(repoRoot: string): GitDirs {
  let gitDir = join(repoRoot, '.git');
  try {
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (m?.[1]) gitDir = resolve(repoRoot, m[1].trim());
    }
  } catch {}
  let commonDir = gitDir;
  try {
    const c = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (c) commonDir = resolve(gitDir, c);
  } catch {}
  return { gitDir, commonDir };
}

export type HeadState =
  | { state: 'ok'; sha: string; ref: string | null }
  | { state: 'unborn'; ref: string }
  | { state: 'broken'; why: string };

function packedRef(commonDir: string, ref: string): string | null {
  try {
    for (const line of readFileSync(join(commonDir, 'packed-refs'), 'utf8').split('\n')) {
      const m = /^([0-9a-f]{40}) (.+)$/.exec(line);
      if (m && m[2] === ref) return m[1] as string;
    }
  } catch {}
  return null;
}

/** Resolve HEAD from the files under $GIT_DIR. */
export function readHead(repoRoot: string): HeadState {
  const { gitDir, commonDir } = gitDirs(repoRoot);
  let head: string;
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return { state: 'broken', why: 'HEAD is unreadable' };
  }
  if (/^[0-9a-f]{40}$/.test(head)) return { state: 'ok', sha: head, ref: null };
  const m = /^ref: (refs\/\S+)$/.exec(head);
  if (!m) return { state: 'broken', why: 'HEAD is not a ref or a commit id' };
  const ref = m[1] as string;
  for (const dir of [gitDir, commonDir]) {
    try {
      const v = readFileSync(join(dir, ref), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(v)) return { state: 'ok', sha: v, ref };
      return { state: 'broken', why: `${ref} does not hold a commit id` };
    } catch {}
  }
  const p = packedRef(commonDir, ref);
  if (p) return { state: 'ok', sha: p, ref };
  return { state: 'unborn', ref };
}

/** True when the repository has any objects at all (an unborn HEAD in such a repo is suspicious). */
export function hasObjects(repoRoot: string): boolean {
  const { commonDir } = gitDirs(repoRoot);
  try {
    if (readdirSync(join(commonDir, 'objects', 'pack')).some((n) => n.endsWith('.pack'))) return true;
  } catch {}
  try {
    return readdirSync(join(commonDir, 'objects')).some((n) => /^[0-9a-f]{2}$/.test(n));
  } catch {
    return false;
  }
}
