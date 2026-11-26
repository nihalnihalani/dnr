/**
 * Normative data schemas (plan §7): orders, grants, sessions, decisions, events,
 * run records, labels and trial results.
 *
 * The mining/trial-input schemas (RevertCase, KnownRevert, SynCase, …) live in
 * `trial-inputs.ts`, owned by the mining workstream.
 */
import { z } from 'zod';
import { Iso, RepoPath, Sha40 } from './primitives';

export const Grammar = z.enum(['python', 'typescript', 'tsx']);
export type Grammar = z.infer<typeof Grammar>;

export const OrderUnit = z.object({
  file: RepoPath,
  qualname: z.string(),
  kind: z.enum(['modified', 'added', 'removed']),
  // per unit: one order may span .py and .ts
  tokenizer: z.object({ grammar: Grammar, normalizer: z.number().int() }),
  A: z.array(z.string()),
  R: z.array(z.string()),
  c_state_ref: z.object({ sha: Sha40, file: RepoPath, qualname: z.string() }),
  post_revert_hash: z.string().length(64),
  post_revert_token_count: z.number().int().nonnegative(),
});
export type OrderUnit = z.infer<typeof OrderUnit>;

/**
 * Derived order status (§5.9, amended by lead decisions N4/N5). Computed when an order loads and
 * never stored on the order (`Order.status` stays draft | approved | retired). `violated` means a
 * re-application was committed during an agent session without a grant; it keeps enforcing.
 */
export const EffectiveStatus = z.enum(['draft', 'approved', 'retired', 'stale', 'relanded', 'violated']);
export type EffectiveStatus = z.infer<typeof EffectiveStatus>;

export const Order = z.object({
  schema: z.literal('dnr.order/v1'),
  id: z.string().regex(/^dnr-[0-9a-f]{10}$/),
  status: z.enum(['draft', 'approved', 'retired']), // 'stale' is derived (§5.9), never stored
  source: z.enum(['revert', 'manual']),
  original_sha: Sha40,
  revert_sha: Sha40.nullable(),
  snapshot_sha: Sha40,
  tickets: z.array(
    z.object({ system: z.enum(['trac', 'github', 'other']), id: z.string(), url: z.string().url() }),
  ),
  links: z
    .array(z.object({ rel: z.enum(['original', 'revert', 'ticket', 'discussion']), url: z.string().url() }))
    .min(1),
  reason: z.string().min(1).max(280),
  reason_source: z.enum(['placeholder', 'drafter', 'human']),
  units: z.array(OrderUnit).min(1),
  history: z.array(
    z.object({
      at: Iso,
      by: z.string(),
      action: z.enum(['created', 'approved', 'retired', 'unretired', 'edited_reason', 'reapproved']),
    }),
  ),
  created_at: Iso,
  updated_at: Iso,
});
export type Order = z.infer<typeof Order>;

/** $DNR_STATE_DIR/grants/<order_id>.<session_key>.json (next-session grants: <order_id>.pending.json). */
export const Grant = z.object({
  order_id: z.string(),
  session_key: z.string().nullable(),
  kind: z.enum(['allow_once', 'ask']),
  granted_by: z.string(),
  granted_at: Iso,
  expires_at: Iso, // a commit is allowed whenever the grant applies (§5.4); no separate count
  used: z.array(z.object({ at: Iso, event_id: z.string(), kind: z.enum(['write', 'commit', 'backstop']) })),
  blobs: z.array(z.object({ file: RepoPath, sha256: z.string() })), // files produced by grant-covered writes (§5.7)
  // Addition beyond §7 (lead decision, wave-2 review C3/H4): how the grant was made, and whether it
  // looks agent-made. Optional so grant files written before it stay valid.
  origin: z
    .object({
      via: z.enum(['cli', 'board', 'ask']),
      suspect: z.boolean(), // created while an agent session was active, or with agent markers seen
      markers: z.array(z.string()), // e.g. 'env:KIRO_SESSION_ID', 'ancestor:kiro-cli', 'no-tty', 'active-session:<key8>'
      // A suspect grant applies only once a human confirms it (`dnr allow --confirm` or the board's confirm action).
      confirmed_by: z.string().optional(),
      confirmed_at: Iso.optional(),
    })
    .optional(),
});
export type Grant = z.infer<typeof Grant>;

export const Session = z.object({
  session_key: z.string(),
  key_source: z.enum(['hook', 'fallback']),
  baseline_tree: Sha40,
  orders_hash: z.string(),
  started_at: Iso,
  last_seen_at: Iso,
  warned: z.array(z.string()),
  pending_ask: z.array(
    z.object({ order_id: z.string(), file: RepoPath, proposed_sha256: z.string(), at: Iso, expires_at: Iso }),
  ),
  grants_used: z.array(z.string()), // order ids whose grant was used this session
  touched: z.array(RepoPath), // agent-touched files for Stop (§5.11)
  shell_snapshot: Sha40.nullable(), // tree taken at guard-shell PreToolUse
  stop_forced_turns: z.number().int().min(0),
});
export type Session = z.infer<typeof Session>;

export const Outcome = z.enum([
  'allow',
  'warn_block',
  'warn_pass',
  'block',
  'ask',
  'ask_approved',
  'ask_denied',
  'allow_grant',
  'deny_protected',
  'error_open',
  'record',
]);
export type Outcome = z.infer<typeof Outcome>;

export const Decision = z.object({
  outcome: Outcome,
  tier: z.enum(['none', 'protect', 'match', 'warn']),
  order_id: z.string().nullable(),
  edit_score: z.number().nullable(),
  prox_score: z.number().nullable(),
  fired_by: z.enum(['edit', 'prox']).nullable(),
  scope: z.literal('order'),
  breakdown: z.array(z.unknown()),
  reason_line: z.string().nullable(),
  latency_ms: z.number(),
  fast_path: z.boolean(),
});
export type Decision = z.infer<typeof Decision>;

export const Mode = z.enum(['enforce', 'record', 'warn-only', 'commit-enforce']);
export type Mode = z.infer<typeof Mode>;

export const EventRecord = z.object({
  event_id: z.string(),
  at: Iso,
  mode: Mode,
  hook: z.enum([
    'pre-write',
    'post-write',
    'guard-shell',
    'post-shell',
    'stop',
    'pre-commit',
    'session-start',
  ]),
  session_key: z.string().nullable(),
  raw: z.unknown(),
  target_rel: RepoPath.nullable(),
  // recorded in every mode on block, warn_block and ask events, and on every event in record mode
  proposed_text: z.string().nullable(),
  // on block, warn_block and ask: unified diff of every order file, baseline_tree vs the proposed session state (§9.6)
  session_patch: z.string().nullable(),
  decision: Decision,
  dnr_version: z.string(),
  kiro_cli_version: z.string().nullable(),
});
export type EventRecord = z.infer<typeof EventRecord>;

/** LU = U prompt with L hooks (demo only); CE = demo/T plus a captured maintainer commit under commit-enforce; PROBE = memorization probe. */
export const Arm = z.enum(['T', 'U', 'B', 'S', 'H', 'L', 'T2', 'T3', 'LU', 'CE', 'PROBE']);
export type Arm = z.infer<typeof Arm>;

export const RunRecord = z.object({
  // run_id = <namespace>/<arm>/<revert10>/r<k>
  run_id: z.string(),
  namespace: z.enum(['trial', 'demo', 'practice', 'syn', 'rdelta', 'repo2', 'probe']),
  revert_sha: Sha40,
  arm: Arm,
  replicate: z.number().int().min(1),
  task: z.string(),
  start_sha: Sha40.nullable(), // null for namespace 'probe' (no repo)
  kiro_cli_version: z.string(),
  model: z.string(),
  started_at: Iso,
  ended_at: Iso,
  status: z.enum(['ok', 'timeout', 'infra_retry', 'error']),
  shell_route: z.boolean(),
  consulted_history: z.boolean(),
  l_outcome: z
    .enum(['stopped_and_reported', 'alternative_impl', 'retried_and_blocked', 'shell_bypass', 'landed'])
    .nullable(),
  tests: z.enum(['pass', 'fail', 'could-not-run', 'n/a']),
  restored_tests: z.enum(['pass', 'fail', 'n/a', 'could-not-run']),
});
export type RunRecord = z.infer<typeof RunRecord>;

export const Label = z.object({
  packet: z.string().length(6),
  labeler: z.string(),
  label: z.enum(['FULL', 'CORE', 'PARTIAL_NONCORE', 'NONE', 'UNRELATED_BREAK', 'NO_CHANGE']),
  arm_guess: Arm.nullable(),
  at: Iso,
});
export type Label = z.infer<typeof Label>;

export const Ratio = z.object({
  num: z.number(),
  den: z.number(),
  wilson: z.tuple([z.number(), z.number()]),
});
export type Ratio = z.infer<typeof Ratio>;

export const ProbeGrade = z.object({
  packet: z.string().length(6),
  labeler: z.string(),
  grade: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  at: Iso,
});
export type ProbeGrade = z.infer<typeof ProbeGrade>;

export const TrialResult = z.object({
  K: z.number(),
  K_eff: z.number(), // denominator actually used (the D6 restored-test subset when that path applies)
  M: z.number(),
  X: z.number(),
  U: z.number(),
  B: z.number(),
  S: z.number(),
  X_eff: z.number(), // T re-applications on the K_eff reverts
  S_eff: z.number(), // S counted on the same K_eff reverts
  W: z.number(), // paired: of T's X re-applied reverts, how many still landed in L
  W_L: z.number(), // all L runs that landed a re-application, over K_eff
  Q: z.number(), // §9.6
  Q_false_blocks: z.number(),
  Y: z.number(),
  Z: z.number(),
  F: z.number(),
  N: z.number(),
  RL: z.number(), // re-lands among accepted commits
  warn_blocks: z.number(),
  row: z.enum(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']),
  via_d6: z.boolean(),
  held_out_recall: z.number().nullable(),
  kappa: z.object({ builder_vs_outside: z.number().nullable(), binary: z.number().nullable() }),
  mode: z.enum(['enforce', 'warn-only', 'commit-enforce']).nullable(),
  secondary: z.object({
    rdelta: z.record(z.string(), Ratio).nullable(),
    syn: z.record(z.string(), Ratio).nullable(),
    repo2: z.record(z.string(), Ratio).nullable(),
    probe: z.record(z.string(), Ratio).nullable(),
    baseline: z.record(z.string(), Ratio).nullable(),
    human_reproposals: z.number().int().nullable(),
  }),
  prereg_sha: Sha40,
  content_hash: z.string(),
});
export type TrialResult = z.infer<typeof TrialResult>;

/** Playground data, written by `dnr export-case`. */
export const CaseBundle = z.object({
  schema: z.literal('dnr.case/v1'),
  id: z.string(),
  title: z.string(),
  order: Order,
  files: z.array(
    z.object({
      path: RepoPath,
      baseline_text: z.string(),
      pre_change_text: z.string(),
      change_text: z.string(),
    }),
  ),
  presets: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum([
        'original-change',
        'recorded-agent',
        'held-out-paraphrase',
        'hard-negative',
        'half-of-two-file',
        'formatting-only',
      ]),
      writes: z.array(z.object({ path: RepoPath, proposed_text: z.string() })),
    }),
  ),
  source: z.object({ repo: z.string(), license: z.string() }),
});
export type CaseBundle = z.infer<typeof CaseBundle>;
