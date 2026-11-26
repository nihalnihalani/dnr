/**
 * `dnr orders build` / `orders add` (§5.3, §8): build orders from revert cases using git texts.
 * IDs are `dnr-` + revert_sha[:10] (manual orders: original_sha[:10]). New orders start as
 * `draft` with the revert subject as a placeholder reason. Re-building an existing ID keeps its
 * status, reason, reason_source, history, links, tickets and created_at, and rewrites only
 * units and snapshot data. created_at is the revert's commit time, so builds are deterministic.
 */
import { buildOrder, grammarForPath, type ParserProvider } from '@dnr/core';
import { catBlobs, changedPaths, commitInfo, githubBase, parents } from '@dnr/git';
import type { Order } from '@dnr/schemas';

export interface BuildCase {
  revert_sha: string | null;
  original_sha: string;
  /** Snapshot (post-revert) commit; defaults to revert_sha. */
  snapshot_sha?: string;
  tickets: string[];
  repo?: string;
}

export type BuildOutcome =
  | { ok: true; order: Order; created: boolean; changed: boolean }
  | { ok: false; id: string; skip_reason: string };

const KNOWN_REPOS: Record<string, string> = {
  django: 'https://github.com/django/django',
  cpython: 'https://github.com/python/cpython',
  sympy: 'https://github.com/sympy/sympy',
};

function ticketLinks(ids: string[], repo: string | undefined, gh: string | null): Order['tickets'] {
  return ids.map((id) => {
    if (repo === 'django' || (gh ?? '').endsWith('/django/django'))
      return { system: 'trac' as const, id, url: `https://code.djangoproject.com/ticket/${id}` };
    if (gh) return { system: 'github' as const, id, url: `${gh}/issues/${id}` };
    return { system: 'other' as const, id, url: `https://example.invalid/ticket/${id}` };
  });
}

function toIso(s: string): string {
  const t = Date.parse(s);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

export async function buildOne(input: {
  gitDir: string;
  provider: ParserProvider;
  c: BuildCase;
  existing: Order | null;
  testGlobs: readonly string[];
  now: string;
  reason?: string;
}): Promise<BuildOutcome> {
  const { gitDir, c } = input;
  const C = c.original_sha;
  const R = c.revert_sha;
  const snapshot = c.snapshot_sha ?? R ?? C;
  const id = `dnr-${(R ?? C).slice(0, 10)}`;
  const [parent] = await parents(gitDir, C);
  const paths = (await changedPaths(gitDir, C)).filter((p) => grammarForPath(p) !== null);
  const specs: string[] = [];
  for (const p of paths) {
    if (parent) specs.push(`${parent}:${p}`);
    specs.push(`${C}:${p}`, `${snapshot}:${p}`);
  }
  const blobs = await catBlobs(gitDir, specs);
  const files = paths.map((p) => ({
    path: p,
    before: parent ? (blobs.get(`${parent}:${p}`) ?? null) : null,
    after: blobs.get(`${C}:${p}`) ?? null,
    post_revert: blobs.get(`${snapshot}:${p}`) ?? null,
  }));
  const gh = (c.repo ? KNOWN_REPOS[c.repo] : undefined) ?? (await githubBase(gitDir));
  const revertInfo = await commitInfo(gitDir, R ?? C);
  const links: Order['links'] = [];
  const commitUrl = (sha: string) => (gh ? `${gh}/commit/${sha}` : `https://example.invalid/commit/${sha}`);
  if (R) links.push({ rel: 'revert', url: commitUrl(R) });
  links.push({ rel: 'original', url: commitUrl(C) });
  const tickets = ticketLinks(c.tickets, c.repo, gh);
  for (const t of tickets) links.push({ rel: 'ticket', url: t.url });
  const at = toIso(revertInfo.committed_at);
  const reason = (input.reason ?? revertInfo.subject).slice(0, 280) || `Reverted ${C.slice(0, 10)}`;
  const r = buildOrder({
    provider: input.provider,
    original_sha: C,
    revert_sha: R,
    snapshot_sha: snapshot,
    files,
    links,
    tickets,
    reason,
    reason_source: input.reason ? 'human' : 'placeholder',
    status: 'draft',
    at,
    testGlobs: input.testGlobs,
  });
  if (!r.ok) return { ok: false, id, skip_reason: r.skip_reason };
  const ex = input.existing;
  if (!ex) return { ok: true, order: r.order, created: true, changed: true };
  const merged: Order = {
    ...ex,
    original_sha: r.order.original_sha,
    revert_sha: r.order.revert_sha,
    snapshot_sha: r.order.snapshot_sha,
    units: r.order.units,
  };
  const changed =
    JSON.stringify(merged.units) !== JSON.stringify(ex.units) || merged.snapshot_sha !== ex.snapshot_sha;
  if (changed) merged.updated_at = input.now;
  return { ok: true, order: merged, created: false, changed };
}
