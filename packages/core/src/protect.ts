/**
 * Protect tier (§5.4): writes under protected globs are always denied.
 * Paths are absolute POSIX paths; the caller resolves realpaths (core has no filesystem access).
 */

export interface ProtectRoots {
  /** realpath of the repository root. */
  repoRoot: string;
  /** $HOME (realpath). */
  home?: string | null;
  /** realpath($DNR_ORDERS). */
  ordersDir?: string | null;
  /** realpath($DNR_STATE_DIR). */
  stateDir?: string | null;
  /** realpath($DNR_CONFIG). */
  configFile?: string | null;
}

/** The protected globs of §5.4, as absolute patterns. A trailing `/**` covers the directory and everything under it. */
export function protectedGlobs(roots: ProtectRoots): string[] {
  const r = trimSlash(roots.repoRoot);
  const out = [`${r}/.dnr/**`, `${r}/.kiro/hooks/**`, `${r}/.kiro/settings/**`, `${r}/.kiro/agents/**`];
  if (roots.home) out.push(`${trimSlash(roots.home)}/.kiro/**`);
  if (roots.ordersDir) out.push(`${trimSlash(roots.ordersDir)}/**`);
  if (roots.stateDir) out.push(`${trimSlash(roots.stateDir)}/**`);
  if (roots.configFile) out.push(roots.configFile);
  return out;
}

/** Collapse `.`/`..` segments and duplicate slashes of an absolute POSIX path. */
export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/**
 * True when `absPath` falls under any pattern. `caseInsensitive` (default true) guards against
 * `.KIRO/hooks` on case-insensitive filesystems such as macOS APFS.
 */
export function isProtected(absPath: string, patterns: readonly string[], caseInsensitive = true): boolean {
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const p = fold(normalizePath(absPath));
  for (const raw of patterns) {
    if (raw.endsWith('/**')) {
      const dir = fold(normalizePath(raw.slice(0, -3)));
      if (p === dir || p.startsWith(`${dir}/`)) return true;
    } else if (p === fold(normalizePath(raw))) return true;
  }
  return false;
}

function trimSlash(s: string): string {
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}
