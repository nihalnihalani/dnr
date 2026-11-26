/**
 * Product-mode `dnr scan` core (§8 / 04-cli-reference): the shared discovery engine plus language
 * globs instead of the trial-only E-rules. Unit qualnames are resolved by the caller's resolver
 * (the engine's §5.2 qualnames); this module only picks pairs and files.
 */
import { commitDiffU0, filePath } from './diff';
import { type DiscoveredRevert, discoverReverts } from './discovery';
import { git } from './exec';

export const DEFAULT_LANG_EXTS: Readonly<Record<'py' | 'ts', readonly string[]>> = {
  py: ['.py'],
  ts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
};

export function matchesLang(path: string, langs: ReadonlyArray<'py' | 'ts'>): boolean {
  if (path.endsWith('.d.ts')) return false;
  return langs.some((l) => DEFAULT_LANG_EXTS[l].some((e) => path.endsWith(e)));
}

export interface ScanPair {
  revert: DiscoveredRevert;
  /** C's files that match the language globs. */
  files: string[];
}

/** `--branch` default: `git symbolic-ref refs/remotes/origin/HEAD`, else HEAD. */
export async function defaultBranch(repo: string): Promise<string> {
  try {
    return (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo })).trim();
  } catch {
    return 'HEAD';
  }
}

/**
 * Reverts whose original is found, is an ancestor, is exact/full, is not superseded, and changes
 * at least one file in the language globs.
 */
export async function scanPairs(
  repo: string,
  opts: { branch?: string; since?: string; until?: string; langs?: ReadonlyArray<'py' | 'ts'> },
): Promise<ScanPair[]> {
  const ref = opts.branch ?? (await defaultBranch(repo));
  const langs = opts.langs ?? ['py', 'ts'];
  const found = await discoverReverts(repo, {
    ref,
    ...(opts.since ? { since: opts.since } : {}),
    ...(opts.until ? { until: opts.until } : {}),
  });
  const out: ScanPair[] = [];
  for (const d of found) {
    if (!d.original_sha || !d.original_is_ancestor || d.superseded_by) continue;
    if (d.revert_kind !== 'exact' && d.revert_kind !== 'full') continue;
    const files = (await commitDiffU0(repo, d.original_sha))
      .map(filePath)
      .filter((p) => matchesLang(p, langs));
    if (files.length > 0) out.push({ revert: d, files: files.sort() });
  }
  return out;
}
