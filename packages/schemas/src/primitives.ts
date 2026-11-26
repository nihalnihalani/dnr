/**
 * Shared primitive schemas (plan §7).
 */
import { z } from 'zod';

/** A full 40-hex git SHA (lowercase). */
export const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
/** Repo-relative path: non-empty, no `..` segment, no leading `/`. */
export const RepoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
    message: 'repo-relative path: no leading "/" and no ".." segment',
  });
/** ISO-8601 datetime with an offset (`Z` or `±hh:mm`). */
export const Iso = z.string().datetime({ offset: true });
