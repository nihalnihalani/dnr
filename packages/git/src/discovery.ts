/**
 * Shared revert-discovery engine (plan §9.1 steps 1–2). Used by `dnr trial mine` and
 * product-mode `dnr scan`. Everything here is deterministic for a fixed `ref`.
 */
import { commitDiffU0, type FileDiff, filePath } from './diff';
import { git } from './exec';
import { inversePatchId, patchId, patchIdIndex } from './patchid';
import { isAncestor, resolveCommit } from './refs';
import { reproduceRevert } from './revert-check';

export type MatchedForm = 'subject' | 'body-this-reverts' | 'body-reverts';
export type MatchMethod = 'body-sha' | 'subject' | 'patch-id-silent';
export type RevertTag = 'backport' | 'revert_of_revert' | 'partial';
export type RevertKind = 'exact' | 'full' | 'partial' | 'unclear';

export interface LoggedCommit {
  sha: string;
  committedAt: string;
  author: string;
  subject: string;
  body: string;
}

/** §9.1 step 1 subject form, e.g. `Fixed #N -- Reverted "…"`. */
export const SUBJECT_RE = /(^|-- )(Partially )?Revert(ed|s|ing)?\b/i;
const THIS_REVERTS_RE = /This reverts commit ([0-9a-f]{7,40})\b/gi;
const REVERTS_RE = /\bReverts? (?:commit )?([0-9a-f]{7,40})\b/gi;
const BACKPORT_SUBJECT_RE = /^\[\d+\.\d+(?:\.x)?\]/;
const BACKPORT_BODY_RE = /Backport of [0-9a-f]{7,40} from (?:main|master)/i;
const PARTIAL_RE = /\b(?:Partial(?:ly)?|partly|mostly) revert/i;

export interface MessageClass {
  forms: MatchedForm[];
  /** SHAs (possibly abbreviated) named by the body forms, in order, de-duplicated. */
  bodyShas: string[];
  /** The quoted subject of the original, when the subject has `Revert… "…"`. */
  quotedSubject: string | null;
  backport: boolean;
  partialWord: boolean;
}

export function classifyMessage(subject: string, body: string): MessageClass {
  const forms: MatchedForm[] = [];
  if (SUBJECT_RE.test(subject)) forms.push('subject');
  const shas: string[] = [];
  const add = (s: string) => {
    const l = s.toLowerCase();
    if (!shas.includes(l)) shas.push(l);
  };
  let thisForm = false;
  for (const m of body.matchAll(THIS_REVERTS_RE)) {
    thisForm = true;
    add(m[1] as string);
  }
  if (thisForm) forms.push('body-this-reverts');
  let revForm = false;
  // "This reverts commit X" also satisfies the looser form; only count the looser form when it adds a hit.
  const stripped = body.replace(THIS_REVERTS_RE, '');
  for (const m of stripped.matchAll(REVERTS_RE)) {
    revForm = true;
    add(m[1] as string);
  }
  if (revForm) forms.push('body-reverts');
  return {
    forms,
    bodyShas: shas,
    quotedSubject: extractQuotedSubject(subject),
    backport: BACKPORT_SUBJECT_RE.test(subject) || BACKPORT_BODY_RE.test(body),
    partialWord: PARTIAL_RE.test(subject) || PARTIAL_RE.test(body),
  };
}

/** `Fixed #1 -- Reverted "Fixed #2 -- Foo."` gives `Fixed #2 -- Foo.` (first quote after the verb to the last quote). */
export function extractQuotedSubject(subject: string): string | null {
  const m = /Revert(?:ed|s|ing)?\s+"/i.exec(subject);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = subject.lastIndexOf('"');
  if (end <= start) return null;
  const q = subject.slice(start, end).trim();
  return q.length > 0 ? q : null;
}

/** The exact §9.1 step 1 log command. Records are in log order (newest first). */
export async function logGrepRevert(repo: string, ref: string): Promise<LoggedCommit[]> {
  const out = await git(
    ['log', ref, '--no-merges', '-i', '--grep=revert', '--format=%H%x1f%cI%x1f%an%x1f%s%x1f%b%x1e'],
    { cwd: repo },
  );
  return parseLogRecords(out);
}

export function parseLogRecords(out: string): LoggedCommit[] {
  const recs: LoggedCommit[] = [];
  for (const raw of out.split('\x1e')) {
    const rec = raw.replace(/^\n+/, '');
    if (rec.trim().length === 0) continue;
    const [sha, committedAt, author, subject, body] = rec.split('\x1f');
    if (!sha || !committedAt) continue;
    recs.push({
      sha,
      committedAt,
      author: author ?? '',
      subject: subject ?? '',
      body: (body ?? '').replace(/\n+$/, ''),
    });
  }
  return recs;
}

export interface DiscoveredRevert {
  revert_sha: string;
  committed_at: string;
  author: string;
  subject: string;
  body: string;
  matched_forms: MatchedForm[];
  match_method: MatchMethod | null;
  /** The chosen original commit C, or null when none was found. */
  original_sha: string | null;
  /** Every resolved SHA the body names (or the subject match), in message order. */
  original_candidates: string[];
  /** Why C was not found / not usable, when original_sha is null or not an ancestor. */
  original_note: string | null;
  original_is_ancestor: boolean | null;
  on_first_parent: boolean;
  tags: RevertTag[];
  revert_kind: RevertKind | null;
  /** Evidence for revert_kind (`patch-id`, `git-revert`, `line-subset`, `none`). */
  kind_evidence: string | null;
  /** A later revert of the same C (§9.1 step 2: use the latest pair). */
  superseded_by: string | null;
}

export interface DiscoverOptions {
  ref: string;
  /** Also find silent reverts by patch-id (forward == inverse of an ancestor). Default true. */
  silent?: boolean;
  /** Inclusive ISO date bounds applied to the revert's committer date (silent reverts only need these). */
  since?: string;
  until?: string;
  /** Run the worktree `git revert --no-commit` check for non-exact pairs. Default true. */
  revertCheck?: boolean;
  /** Paths where R may differ from the clean `git revert` result and still count as `full` (default: none). */
  extraPathAllowed?: (path: string) => boolean;
  onProgress?: (msg: string) => void;
}

interface SubjectIndex {
  bySubject: Map<string, string[]>; // newest first
  meta: Map<string, { committedAt: string; subject: string; author: string; body: string }>;
  firstParent: Set<string>;
}

async function buildSubjectIndex(repo: string, ref: string): Promise<SubjectIndex> {
  const out = await git(['log', ref, '--no-merges', '--format=%H%x1f%cI%x1f%an%x1f%s%x1f%b%x1e'], {
    cwd: repo,
  });
  const bySubject = new Map<string, string[]>();
  const meta = new Map<string, { committedAt: string; subject: string; author: string; body: string }>();
  for (const c of parseLogRecords(out)) {
    meta.set(c.sha, { committedAt: c.committedAt, subject: c.subject, author: c.author, body: c.body });
    const list = bySubject.get(c.subject);
    if (list) list.push(c.sha);
    else bySubject.set(c.subject, [c.sha]);
  }
  const fp = await git(['rev-list', '--first-parent', ref], { cwd: repo });
  return { bySubject, meta, firstParent: new Set(fp.split('\n').filter(Boolean)) };
}

function multiset(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

function subsetOf(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const [k, n] of a) if ((b.get(k) ?? 0) < n) return false;
  return true;
}

/** R undoes only part of C: R touches a subset of C's files and R's -/+ lines are inside C's +/- lines. */
export function isLineSubsetUndo(c: FileDiff[], r: FileDiff[]): boolean {
  const cFiles = new Map(c.map((f) => [filePath(f), f]));
  if (r.length === 0) return false;
  const cAdded: string[] = [];
  const cRemoved: string[] = [];
  for (const f of c) {
    for (const h of f.hunks) {
      cAdded.push(...h.added);
      cRemoved.push(...h.removed);
    }
  }
  const rAdded: string[] = [];
  const rRemoved: string[] = [];
  for (const f of r) {
    if (!cFiles.has(filePath(f))) return false;
    for (const h of f.hunks) {
      rAdded.push(...h.added);
      rRemoved.push(...h.removed);
    }
  }
  if (rAdded.length + rRemoved.length === 0) return false;
  return subsetOf(multiset(rRemoved), multiset(cAdded)) && subsetOf(multiset(rAdded), multiset(cRemoved));
}

export async function classifyRevertKind(
  repo: string,
  original: string,
  revert: string,
  opts: {
    revertCheck?: boolean;
    partialWord?: boolean;
    pidCache?: { forward: Map<string, string>; inverse: Map<string, string> };
    extraPathAllowed?: (path: string) => boolean;
  } = {},
): Promise<{ kind: RevertKind; evidence: string }> {
  const cPid = opts.pidCache?.forward.get(original) ?? (await patchId(repo, original));
  const rInv = opts.pidCache?.inverse.get(revert) ?? (await inversePatchId(repo, revert));
  if (cPid && rInv && cPid === rInv) return { kind: 'exact', evidence: 'patch-id' };
  if (opts.revertCheck !== false) {
    const rep = await reproduceRevert(repo, original, revert);
    if (rep.applied && rep.differing.length === 0) return { kind: 'full', evidence: 'git-revert' };
    // R may differ from the clean revert on paths the caller allows (Django reverts usually add a
    // release note or keep a regression test). Every other path must match exactly.
    const allowed = opts.extraPathAllowed ?? (() => false);
    if (rep.applied && rep.differing.every(allowed)) {
      return { kind: 'full', evidence: `git-revert+extra:${rep.differing.join(',')}` };
    }
  }
  const [cd, rd] = await Promise.all([commitDiffU0(repo, original), commitDiffU0(repo, revert)]);
  if (isLineSubsetUndo(cd, rd)) return { kind: 'partial', evidence: 'line-subset' };
  if (opts.partialWord) return { kind: 'partial', evidence: 'message' };
  return { kind: 'unclear', evidence: 'none' };
}

function inRange(iso: string, since?: string, until?: string): boolean {
  const t = Date.parse(iso);
  if (since && t < Date.parse(since)) return false;
  if (until && t > Date.parse(until)) return false;
  return true;
}

/**
 * Finds revert candidates (§9.1 step 1) and their originals (step 2). Output is sorted by
 * committer date then SHA, oldest first, so it is stable across runs.
 */
export async function discoverReverts(repo: string, opts: DiscoverOptions): Promise<DiscoveredRevert[]> {
  const log = opts.onProgress ?? (() => {});
  const idx = await buildSubjectIndex(repo, opts.ref);
  const grep = await logGrepRevert(repo, opts.ref);
  log(`log --grep=revert: ${grep.length} commits`);
  const pidIndex = opts.silent === false ? undefined : await patchIdIndex(repo, opts.ref);
  if (pidIndex) log(`patch-id index: ${pidIndex.forward.size} forward, ${pidIndex.inverse.size} inverse`);

  const results: DiscoveredRevert[] = [];
  const seen = new Set<string>();
  for (const c of grep) {
    if (!inRange(c.committedAt, opts.since, opts.until)) continue;
    const mc = classifyMessage(c.subject, c.body);
    if (mc.forms.length === 0) continue;
    seen.add(c.sha);
    const d: DiscoveredRevert = {
      revert_sha: c.sha,
      committed_at: c.committedAt,
      author: c.author,
      subject: c.subject,
      body: c.body,
      matched_forms: mc.forms,
      match_method: null,
      original_sha: null,
      original_candidates: [],
      original_note: null,
      original_is_ancestor: null,
      on_first_parent: idx.firstParent.has(c.sha),
      tags: [],
      revert_kind: null,
      kind_evidence: null,
      superseded_by: null,
    };
    if (mc.backport) d.tags.push('backport');
    // Step 2: C from the body first, else the exact quoted subject.
    for (const s of mc.bodyShas) {
      const full = await resolveCommit(repo, s);
      if (full && full !== c.sha && !d.original_candidates.includes(full)) d.original_candidates.push(full);
    }
    if (d.original_candidates.length > 0) {
      d.match_method = 'body-sha';
      for (const cand of d.original_candidates) {
        if (await isAncestor(repo, cand, c.sha)) {
          d.original_sha = cand;
          d.original_is_ancestor = true;
          break;
        }
      }
      if (!d.original_sha) {
        d.original_sha = d.original_candidates[0] as string;
        d.original_is_ancestor = false;
        d.original_note = 'body sha is not an ancestor of R';
      }
      if (d.original_candidates.length > 1)
        d.original_note = `body names ${d.original_candidates.length} commits`;
    } else if (mc.bodyShas.length > 0) {
      d.original_note = `body sha(s) ${mc.bodyShas.join(',')} do not resolve`;
    }
    if (!d.original_sha && mc.quotedSubject) {
      const matches = (idx.bySubject.get(mc.quotedSubject) ?? []).filter((s) => s !== c.sha);
      for (const m of matches) {
        if (await isAncestor(repo, m, c.sha)) {
          d.original_sha = m;
          d.original_is_ancestor = true;
          d.match_method = 'subject';
          d.original_candidates = [m];
          d.original_note = null;
          break;
        }
      }
      if (!d.original_sha)
        d.original_note =
          d.original_note ??
          (matches.length > 0
            ? 'subject match is not an ancestor of R'
            : 'no commit with the quoted subject');
    }
    if (!d.original_sha && !d.original_note) d.original_note = 'no sha in body and no quoted subject';
    if (d.original_sha) {
      const cMeta = idx.meta.get(d.original_sha);
      if (
        cMeta &&
        (SUBJECT_RE.test(cMeta.subject) || classifyMessage(cMeta.subject, cMeta.body).bodyShas.length > 0)
      ) {
        d.tags.push('revert_of_revert');
      } else if (mc.quotedSubject && /^Revert/i.test(mc.quotedSubject)) {
        d.tags.push('revert_of_revert');
      }
    }
    if (d.original_sha && d.original_is_ancestor) {
      const k = await classifyRevertKind(repo, d.original_sha, c.sha, {
        revertCheck: opts.revertCheck,
        partialWord: mc.partialWord,
        ...(opts.extraPathAllowed ? { extraPathAllowed: opts.extraPathAllowed } : {}),
        ...(pidIndex ? { pidCache: pidIndex } : {}),
      });
      d.revert_kind = k.kind;
      d.kind_evidence = k.evidence;
    }
    if (mc.partialWord || d.revert_kind === 'partial') d.tags.push('partial');
    results.push(d);
  }
  log(`message-form candidates: ${results.length}`);

  if (pidIndex) {
    // Silent reverts: X's forward patch-id equals the inverse patch-id of an earlier ancestor C.
    const byInverse = new Map<string, string[]>();
    for (const [sha, pid] of pidIndex.inverse) {
      const l = byInverse.get(pid);
      if (l) l.push(sha);
      else byInverse.set(pid, [sha]);
    }
    let silent = 0;
    for (const [x, fpid] of pidIndex.forward) {
      if (seen.has(x)) continue;
      // A whitespace-only change has equal forward and inverse patch-ids; it would pair with any
      // other whitespace-only change of the same lines, so it is never a silent revert.
      if (pidIndex.inverse.get(x) === fpid) continue;
      const cs = byInverse.get(fpid);
      if (!cs) continue;
      const meta = idx.meta.get(x);
      if (!meta || !inRange(meta.committedAt, opts.since, opts.until)) continue;
      // Newest ancestor first (meta order is log order; sort by date desc then sha).
      const ordered = cs
        .filter((s) => s !== x && idx.meta.has(s))
        .sort((a, b) => {
          const da = Date.parse(idx.meta.get(a)?.committedAt ?? '');
          const db = Date.parse(idx.meta.get(b)?.committedAt ?? '');
          return db - da || (a < b ? -1 : 1);
        });
      let orig: string | null = null;
      for (const s of ordered) {
        if (await isAncestor(repo, s, x)) {
          orig = s;
          break;
        }
      }
      if (!orig) continue;
      const cMeta = idx.meta.get(orig);
      const tags: RevertTag[] = [];
      if (BACKPORT_SUBJECT_RE.test(meta.subject)) tags.push('backport');
      if (cMeta && SUBJECT_RE.test(cMeta.subject)) tags.push('revert_of_revert');
      results.push({
        revert_sha: x,
        committed_at: meta.committedAt,
        author: meta.author,
        subject: meta.subject,
        body: meta.body,
        matched_forms: [],
        match_method: 'patch-id-silent',
        original_sha: orig,
        original_candidates: [orig],
        original_note: null,
        original_is_ancestor: true,
        on_first_parent: idx.firstParent.has(x),
        tags,
        revert_kind: 'exact',
        kind_evidence: 'patch-id',
        superseded_by: null,
      });
      silent++;
    }
    log(`silent (patch-id) candidates: ${silent}`);
  }

  results.sort(
    (a, b) =>
      Date.parse(a.committed_at) - Date.parse(b.committed_at) || (a.revert_sha < b.revert_sha ? -1 : 1),
  );
  // Latest pair per original (§9.1 step 2).
  const latest = new Map<string, DiscoveredRevert>();
  for (const r of results) {
    if (!r.original_sha) continue;
    const prev = latest.get(r.original_sha);
    if (prev) prev.superseded_by = r.revert_sha;
    latest.set(r.original_sha, r);
  }
  return results;
}
