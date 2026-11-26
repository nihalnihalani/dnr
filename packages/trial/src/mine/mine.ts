/**
 * `dnr trial mine` (§9.1 steps 1–4, 8). Deterministic for a fixed ref: candidates are sorted by
 * committer date then SHA and no wall-clock time is written.
 */
import {
  commitDiffU0,
  type DiscoveredRevert,
  discoverReverts,
  extractQuotedSubject,
  filePath,
  git,
  readBlob,
  revParse,
} from '@dnr/git';
import { Candidate, type ReasonLabel, type RevertCase, type RevertKindDecision } from '@dnr/schemas';
import { applyRules, DEMO_REVERTS, type RuleOutcome, resolveReason } from './eligibility';
import { proposeReason } from './reasons';
import { seedKey } from './seed';
import { fallbackAnalyzer, type UnitAnalyzer, type UnitFile } from './units';
import { windowOf } from './windows';

export interface RepoProfile {
  repo: 'django' | 'cpython' | 'sympy';
  /** §9.1 E4 source root. */
  sourceRoot: string;
  /** Extensions of source units. */
  exts: string[];
}

export const PROFILES: Readonly<Record<RepoProfile['repo'], RepoProfile>> = {
  django: { repo: 'django', sourceRoot: 'django/', exts: ['.py'] },
  cpython: { repo: 'cpython', sourceRoot: 'Lib/', exts: ['.py'] },
  sympy: { repo: 'sympy', sourceRoot: 'sympy/', exts: ['.py'] },
};

export interface MineOptions {
  gitDir: string;
  ref: string;
  profile: RepoProfile;
  analyzer?: UnitAnalyzer;
  labels?: readonly ReasonLabel[] | null;
  /** A person's decisions for `unclear` pairs (§9.1 step 2). */
  kindDecisions?: readonly RevertKindDecision[];
  revertCheck?: boolean;
  onProgress?: (msg: string) => void;
}

export interface MinedCandidate {
  candidate: Candidate;
  outcome: RuleOutcome;
  /** Files of C under the source root, with their texts (kept for --labels output; not serialized). */
  sourceFiles: UnitFile[];
}

export interface MineResult {
  refSha: string;
  analyzerSource: UnitAnalyzer['source'];
  mined: MinedCandidate[];
}

const TICKET_RE = /#(\d{3,6})\b/g;

export function ticketsOf(...texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts)
    for (const m of t.matchAll(TICKET_RE)) if (!out.includes(m[1] as string)) out.push(m[1] as string);
  return out;
}

function isSourcePath(p: string, profile: RepoProfile): boolean {
  return p.startsWith(profile.sourceRoot) && profile.exts.some((e) => p.endsWith(e));
}

async function analyze(
  opts: MineOptions,
  d: DiscoveredRevert,
  analyzer: UnitAnalyzer,
  cSubject: string,
): Promise<MinedCandidate> {
  const repo = opts.gitDir;
  const window = windowOf(d.committed_at, d.match_method);
  const cFiles: string[] = [];
  const sourceFiles: UnitFile[] = [];
  const units: Array<{ file: string; qualname: string }> = [];
  let unitsAtR: number | null = null;
  let orderWeight: number | null = null;
  const usable = d.original_sha !== null && d.original_is_ancestor === true;
  if (d.original_sha && usable) {
    const diff = await commitDiffU0(repo, d.original_sha);
    for (const f of diff) {
      const p = filePath(f);
      cFiles.push(p);
      if (f.binary || !isSourcePath(p, opts.profile)) continue;
      const before = f.oldPath ? await readBlob(repo, `${d.original_sha}^`, f.oldPath) : null;
      const after = f.newPath ? await readBlob(repo, d.original_sha, f.newPath) : null;
      const uf: UnitFile = { path: p, before, after, hunks: f.hunks };
      sourceFiles.push(uf);
      for (const q of analyzer.changedUnits(uf)) units.push({ file: p, qualname: q });
    }
    cFiles.sort();
    if (units.length > 0) {
      unitsAtR = 0;
      const atR = new Map<string, string | null>();
      for (const u of units) {
        if (!atR.has(u.file)) atR.set(u.file, await readBlob(repo, d.revert_sha, u.file));
        const text = atR.get(u.file);
        if (text != null && analyzer.unitExists(u.file, text, u.qualname)) unitsAtR++;
      }
      orderWeight = await analyzer.orderWeight(sourceFiles);
    }
  }
  const quoted = extractQuotedSubject(d.subject);
  const proposal = proposeReason({ subject: d.subject, body: d.body, quotedSubject: quoted, cFiles });
  const outcome = applyRules({
    inWindow: window !== null,
    backport: d.tags.includes('backport'),
    onFirstParent: d.on_first_parent,
    originalFound: d.original_sha !== null,
    originalIsAncestor: d.original_is_ancestor === true,
    superseded: d.superseded_by !== null,
    revertKind: d.revert_kind,
    sourceUnits: units.length,
    orderWeight,
    reason: resolveReason(d.revert_sha, opts.labels ?? null),
    unitsAtR: d.original_sha && usable ? (unitsAtR ?? 0) : null,
    isDemo: DEMO_REVERTS.includes(d.revert_sha),
  });
  const candidate = Candidate.parse({
    revert_sha: d.revert_sha,
    proposed_category: proposal.category,
    rule: proposal.rule,
    repo: opts.profile.repo,
    subject: d.subject,
    committed_at: d.committed_at,
    window,
    matched_forms: d.matched_forms,
    match_method: d.match_method,
    original_sha: d.original_sha,
    original_candidates: d.original_candidates,
    original_note: d.original_note,
    tags: d.tags,
    revert_kind: d.revert_kind,
    kind_evidence: d.kind_evidence,
    superseded_by: d.superseded_by,
    tickets: ticketsOf(d.subject, d.body, cSubject),
    c_files: cFiles,
    units,
    units_source: units.length > 0 ? analyzer.source : 'none',
    order_weight: orderWeight,
    rules: outcome.rules,
    skip_reason: outcome.skip_reason,
    seed_key: seedKey(d.revert_sha),
  });
  return { candidate, outcome, sourceFiles };
}

export async function mine(opts: MineOptions): Promise<MineResult> {
  const analyzer = opts.analyzer ?? fallbackAnalyzer;
  const refSha = await revParse(opts.gitDir, opts.ref);
  const found = await discoverReverts(opts.gitDir, {
    ref: refSha,
    silent: true,
    revertCheck: opts.revertCheck,
    // E3 `full`: R may also touch paths outside the source root (release notes, tests, AUTHORS).
    extraPathAllowed: (p) => !p.startsWith(opts.profile.sourceRoot),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  const decisions = new Map((opts.kindDecisions ?? []).map((k) => [k.revert_sha, k]));
  const mined: MinedCandidate[] = [];
  for (const d of found) {
    const dec = decisions.get(d.revert_sha);
    if (dec && d.revert_kind === 'unclear') {
      d.revert_kind = dec.revert_kind;
      d.kind_evidence = `person:${dec.decided_by}`;
      if (dec.revert_kind === 'partial' && !d.tags.includes('partial')) d.tags.push('partial');
    }
    let cSubject = '';
    if (d.original_sha) {
      cSubject = (await git(['log', '-1', '--format=%s', d.original_sha], { cwd: opts.gitDir })).trim();
    }
    mined.push(await analyze(opts, d, analyzer, cSubject));
  }
  return { refSha, analyzerSource: analyzer.source, mined };
}

/** Stable JSONL: one Candidate per line, keys in schema order. */
export function toJsonl(cands: readonly Candidate[]): string {
  return cands.map((c) => JSON.stringify(c)).join('\n') + (cands.length > 0 ? '\n' : '');
}

/**
 * `trial mine --labels` output (§9.1 step 4.3): eligible reverts as RevertCase with role null.
 * Env fields stay null until `trial envs`; rdelta_sha comes from `computeRdelta`.
 */
export function toRevertCase(
  m: MinedCandidate,
  category: RevertCase['reason_category'],
  rdelta: string | null,
): RevertCase {
  const c = m.candidate;
  if (!c.original_sha || !c.match_method || !c.revert_kind)
    throw new Error(`${c.revert_sha} is not a complete pair`);
  return {
    revert_sha: c.revert_sha,
    original_sha: c.original_sha,
    repo: c.repo,
    rdelta_sha: rdelta,
    match_method: c.match_method,
    tags: c.tags,
    revert_kind: c.revert_kind,
    committed_at: c.committed_at,
    tickets: c.tickets,
    units: c.units,
    reason_category: category,
    role: null,
    restored_tests: {
      paths: [],
      labels: [],
      fails_post_revert: null,
      passes_on_original: null,
      valid: false,
    },
    python: null,
    test_backend: 'sqlite',
    env_ok: null,
    eligible: m.outcome.eligible,
    skip_reason: m.outcome.skip_reason,
    seed_rank: null,
  };
}
