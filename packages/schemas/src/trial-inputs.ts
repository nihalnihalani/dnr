/**
 * Trial-input fixture schemas (plan §7, fixture block; §9.1). Owned by the mining workstream.
 * All fixture schemas are strict so a field lost to a typo fails loudly.
 */
import { z } from 'zod';

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const RepoPath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.split('/').includes('..'),
    'repo-relative path, no ".." and no leading "/"',
  );
const Iso = z.iso.datetime({ offset: true });

export const ReasonCategory = z.enum([
  'CORRECTNESS_REGRESSION',
  'CRASH',
  'BACKWARD_INCOMPAT',
  'PERFORMANCE_REGRESSION',
  'API_POLICY_REVERSAL',
  'RELEASE_TIMING',
  'ACCIDENTAL_COMMIT',
  'CI_INFRA',
  'TEST_ONLY',
  'DOCS_ONLY',
  'FRONTEND_ONLY',
  'DUPLICATE_SUPERSEDED',
  'OTHER',
]);
export type ReasonCategory = z.infer<typeof ReasonCategory>;

/** §9.1 step 4: eligible categories (PERFORMANCE_REGRESSION is its own stratum). */
export const ELIGIBLE_REASONS: readonly ReasonCategory[] = [
  'CORRECTNESS_REGRESSION',
  'CRASH',
  'BACKWARD_INCOMPAT',
  'PERFORMANCE_REGRESSION',
];
export const SECONDARY_REASONS: readonly ReasonCategory[] = ['API_POLICY_REVERSAL'];

export const TrialRepo = z.enum(['django', 'cpython', 'sympy', 'syn', 'ts-demo']);
export const RevertKind = z.enum(['exact', 'full', 'partial', 'unclear']);
export const MatchMethod = z.enum(['body-sha', 'subject', 'patch-id-silent']);
export const RevertTag = z.enum(['backport', 'revert_of_revert', 'partial']);
export const Role = z.enum(['trial', 'tune', 'gate', 'demo', 'synthetic']);
export const MiningWindow = z.enum(['W0', 'W1', 'W2', 'W3', 'W4']);

export const Unit = z.strictObject({ file: RepoPath, qualname: z.string() });

export const RevertCase = z.strictObject({
  revert_sha: Sha40,
  original_sha: Sha40,
  repo: TrialRepo,
  rdelta_sha: Sha40.nullable(),
  match_method: MatchMethod,
  tags: z.array(RevertTag),
  revert_kind: RevertKind,
  committed_at: Iso,
  tickets: z.array(z.string()),
  units: z.array(Unit),
  reason_category: ReasonCategory,
  role: Role.nullable(),
  restored_tests: z.strictObject({
    paths: z.array(RepoPath),
    labels: z.array(z.string()),
    fails_post_revert: z.boolean().nullable(),
    passes_on_original: z.boolean().nullable(),
    valid: z.boolean(),
  }),
  python: z.string().nullable(),
  test_backend: z.enum(['sqlite', 'postgres', 'mysql', 'oracle', 'other']),
  env_ok: z.boolean().nullable(),
  eligible: z.boolean(),
  skip_reason: z.string().nullable(),
  seed_rank: z.number().int().nullable(),
});
export type RevertCase = z.infer<typeof RevertCase>;
export const RevertCases = z.array(RevertCase);

export const KnownRevert = z.strictObject({
  sha: Sha40,
  subject: z.string(),
  matched_form: z.enum(['subject', 'body-this-reverts', 'body-reverts']),
  confirmed_by: z.string(),
});
export type KnownRevert = z.infer<typeof KnownRevert>;
export const KnownReverts = z.array(KnownRevert);

export const KnownRevertRejected = z.strictObject({ sha: Sha40, subject: z.string(), reason: z.string() });
export type KnownRevertRejected = z.infer<typeof KnownRevertRejected>;
export const KnownRevertsRejected = z.array(KnownRevertRejected);

export const Discussion = z.strictObject({
  ticket: z.string(),
  source: z.enum(['trac', 'github', 'bpo']),
  title: z.string(),
  body: z.string(),
  comments: z.array(z.string()),
  fetched_at: Iso,
});
export type Discussion = z.infer<typeof Discussion>;
/** `fixtures/discussion/<sha10>.json`: one entry per ticket or PR for that revert. */
export const DiscussionFile = z.array(Discussion);

export const ReasonLabel = z.strictObject({
  revert_sha: Sha40,
  labeler: z.string(),
  category: ReasonCategory,
  adjudicated: z.boolean(),
});
export type ReasonLabel = z.infer<typeof ReasonLabel>;
export const ReasonLabels = z.array(ReasonLabel);

export const CriticalEdit = z.strictObject({
  revert_sha: Sha40,
  labeler: z.string(),
  file: RepoPath,
  qualname: z.string(),
  side: z.enum(['added', 'removed']),
  tokens: z.array(z.string()),
  adjudicated: z.boolean(),
});
export type CriticalEdit = z.infer<typeof CriticalEdit>;
export const CriticalEdits = z.array(CriticalEdit);

export const SynCase = RevertCase.extend({
  repo: z.literal('syn'),
  role: z.literal('synthetic'),
  ticket: Discussion,
  critical_edit: CriticalEdit,
});
export type SynCase = z.infer<typeof SynCase>;

/** Rule-engine proposal (§7 `Proposal`); every candidates.jsonl line carries these three fields. */
export const Proposal = z.strictObject({
  revert_sha: Sha40,
  proposed_category: ReasonCategory,
  rule: z.string(),
});
export type Proposal = z.infer<typeof Proposal>;

const RuleState = z.enum(['pass', 'fail', 'pending', 'n/a']);

/**
 * One line of `fixtures/candidates.jsonl`, written by `dnr trial mine`: the §7 Proposal fields
 * plus the mining record every later step reads (window, C, kind, E1–E8 states, skip reason).
 */
export const Candidate = z.strictObject({
  revert_sha: Sha40,
  proposed_category: ReasonCategory,
  rule: z.string(),
  repo: TrialRepo,
  subject: z.string(),
  committed_at: Iso,
  window: MiningWindow.nullable(),
  matched_forms: z.array(z.enum(['subject', 'body-this-reverts', 'body-reverts'])),
  match_method: MatchMethod.nullable(),
  original_sha: Sha40.nullable(),
  original_candidates: z.array(Sha40),
  original_note: z.string().nullable(),
  tags: z.array(RevertTag),
  revert_kind: RevertKind.nullable(),
  kind_evidence: z.string().nullable(),
  superseded_by: Sha40.nullable(),
  tickets: z.array(z.string()),
  c_files: z.array(RepoPath),
  units: z.array(Unit),
  units_source: z.enum(['engine', 'fallback-indent', 'none']),
  order_weight: z.number().int().nonnegative().nullable(),
  rules: z.strictObject({
    E1: RuleState,
    E2: RuleState,
    E3: RuleState,
    E4: RuleState,
    E5: RuleState,
    E6: RuleState,
    E7: RuleState,
    E8: RuleState,
  }),
  /** First failing rule (`E<n>:<code>`), or the first pending rule (`pending:E<n>`), or null when all pass. */
  skip_reason: z.string().nullable(),
  /** sha256("dnr-2026:"+revert_sha) as hex; ranking key for `trial assign`. */
  seed_key: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Candidate = z.infer<typeof Candidate>;

/** `.dnr/candidates.json`, written by product-mode `dnr scan`, read by `orders build` by default. */
export const ScanCandidate = z.strictObject({
  revert_sha: Sha40,
  original_sha: Sha40,
  subject: z.string(),
  committed_at: Iso,
  units: z.array(Unit),
  tickets: z.array(z.string()),
});
export type ScanCandidate = z.infer<typeof ScanCandidate>;
export const ScanCandidates = z.array(ScanCandidate);

export const Assignment = z.array(
  z.strictObject({ revert_sha: Sha40, repo: TrialRepo, role: Role, rank: z.number().int() }),
);
export type Assignment = z.infer<typeof Assignment>;

export const EnvMatrixEntry = z.strictObject({
  revert_sha: Sha40,
  kind: z.enum(['uv', 'docker', 'cpython-build']),
  python: z.string(),
  path: z.string(),
  image: z.string().nullable(),
  ok: z.boolean(),
});
export const EnvMatrix = z.array(EnvMatrixEntry);
export type EnvMatrix = z.infer<typeof EnvMatrix>;

export const Flaky = z.array(z.strictObject({ revert_sha: Sha40, test: z.string() }));
export type Flaky = z.infer<typeof Flaky>;

/** `fixtures/django-python.json`: Django X.Y to the Python versions its release declares. */
export const DjangoPython = z.array(
  z.strictObject({
    django: z.string().regex(/^\d+\.\d+$/),
    tag: z.string(),
    pythons: z.array(z.string().regex(/^\d+\.\d+$/)),
    source: z.string(),
  }),
);
export type DjangoPython = z.infer<typeof DjangoPython>;

/**
 * `fixtures/revert-kind-decisions.json`: a person's decision for a pair the miner classified as
 * `unclear` (§9.1 step 2). Applied only to pairs whose computed kind is `unclear`.
 */
export const RevertKindDecision = z.strictObject({
  revert_sha: Sha40,
  revert_kind: z.enum(['full', 'partial']),
  decided_by: z.string().min(1),
  note: z.string(),
});
export const RevertKindDecisions = z.array(RevertKindDecision);
export type RevertKindDecision = z.infer<typeof RevertKindDecision>;
