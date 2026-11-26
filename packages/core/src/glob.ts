/**
 * Minimal glob matching for repo-relative POSIX paths (isomorphic).
 * `**` matches any number of path segments (including none), `*` any run of characters
 * within one segment, `?` one character within a segment.
 */
import { DEFAULT_CONFIG } from '@dnr/schemas';

/** Default `test_globs` (§7 config): test paths are never scored or put in orders. */
export const DEFAULT_TEST_GLOBS: readonly string[] = DEFAULT_CONFIG.test_globs;

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` → zero or more segments; trailing `**` → anything
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  const out = new RegExp(re);
  cache.set(glob, out);
  return out;
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path.replace(/^\.\//, ''));
}

/** True when `path` (repo-relative) is a test path under any of `globs`. */
export function isTestPath(path: string, globs: readonly string[] = DEFAULT_TEST_GLOBS): boolean {
  return globs.some((g) => matchesGlob(path, g));
}
