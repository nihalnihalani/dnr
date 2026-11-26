import { execFile } from 'node:child_process';
import { classifyMessage, git, isAncestor, parents, resolveCommit } from '@dnr/git';
import type { KnownRevert, KnownRevertRejected } from '@dnr/schemas';

/** Phase 0 queries (§13.1): both are run with --paginate. */
export const KNOWN_REVERT_QUERIES = [
  'repo:django/django "This reverts commit" committer-date:2020-01-01..2025-12-31',
  'repo:django/django Reverted committer-date:2020-01-01..2025-12-31',
] as const;

/** Written into `confirmed_by` until a person reviews the entry; never a person's name. */
export const UNCONFIRMED = 'unconfirmed:auto-form-match';

export function ghSearchCommits(q: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      [
        'api',
        '-X',
        'GET',
        'search/commits',
        '--paginate',
        '-f',
        'per_page=100',
        '-f',
        `q=${q}`,
        '--jq',
        '.items[].sha',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) =>
        err
          ? reject(err)
          : resolve(
              String(stdout)
                .split('\n')
                .filter((l) => /^[0-9a-f]{40}$/.test(l)),
            ),
    );
  });
}

/**
 * Splits search hits into known reverts (a non-merge commit on main whose message matches one of
 * the three §9.1 forms) and rejects with a reason. Output is sorted by SHA.
 */
export async function classifyKnownReverts(
  repo: string,
  mainRef: string,
  shas: readonly string[],
): Promise<{ known: KnownRevert[]; rejected: KnownRevertRejected[] }> {
  const known: KnownRevert[] = [];
  const rejected: KnownRevertRejected[] = [];
  for (const sha of [...new Set(shas)].sort()) {
    const full = await resolveCommit(repo, sha);
    if (!full) {
      rejected.push({ sha, subject: '', reason: 'not present in the local clone' });
      continue;
    }
    const msg = await git(['log', '-1', '--format=%s%x1f%b', full], { cwd: repo });
    const [subject = '', body = ''] = msg.split('\x1f');
    if ((await parents(repo, full)).length > 1) {
      rejected.push({ sha: full, subject, reason: 'merge commit' });
      continue;
    }
    if (!(await isAncestor(repo, full, mainRef))) {
      rejected.push({ sha: full, subject, reason: 'not on main' });
      continue;
    }
    const mc = classifyMessage(subject, body);
    const form = mc.forms[0];
    if (!form) {
      rejected.push({
        sha: full,
        subject,
        reason: 'matches none of the three §9.1 forms (search hit on another word, e.g. "revert" in prose)',
      });
      continue;
    }
    known.push({ sha: full, subject, matched_form: form, confirmed_by: UNCONFIRMED });
  }
  return { known, rejected };
}
