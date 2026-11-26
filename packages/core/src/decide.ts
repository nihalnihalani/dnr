/**
 * Tier decision for one write (§5.4): protect → match → warn → allow, with grants.
 *
 * Core is pure: the caller (hook) supplies the session states, the warned set and a grant
 * predicate, and applies the returned `effects` to the session afterwards.
 */
import type { Decision, Order } from '@dnr/schemas';
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from './config';
import { sameTokens } from './diff';
import type { OrderMaterial } from './material';
import { type OrderScore, scoreOrder } from './score';
import type { StateView } from './state';

export interface OrderEntry {
  order: Order;
  /** Derived at load (§5.9). Stale orders only warn. */
  stale?: boolean;
  /** Derived at load (§5.9). A re-landed order only warns until re-approved. */
  relanded?: boolean;
  material?: OrderMaterial;
}

export interface DecideConfig extends MatchConfig {
  decision_format: 'deny' | 'ask';
  /** `warn-only` downgrades a match to the warn tier (§5.14). Record and commit-enforce are applied by the hook. */
  mode: 'enforce' | 'warn-only';
}

export interface DecideInput {
  /** Repo-relative target of the write. */
  target: string;
  /** The target resolved under a protected glob (see `isProtected`). */
  protected?: boolean;
  /** The tool is write-tagged but unknown (§5.8): orders covering the target can only warn. */
  unknownTool?: boolean;
  orders: readonly OrderEntry[];
  /** Session baseline tree (§5.7). */
  baseline: StateView;
  /** Session state before this write. */
  current: StateView;
  /** Session state with this write applied (every file). */
  proposed: StateView;
  /** Session.touched plus files new relative to the baseline, for the fingerprint index (§5.16). */
  searchFiles?: readonly string[];
  /** Orders this session already warned for. */
  warned?: Iterable<string>;
  /** Whether a grant applies to the order (§5.4: unexpired, or already used this session). */
  grantApplies?: (orderId: string) => boolean;
  config?: Partial<DecideConfig>;
  /** Clock for latency_ms (defaults to performance.now()). */
  now?: () => number;
}

export interface DecideEffects {
  /** Order to add to Session.warned (a warn_block was emitted). */
  warn: string | null;
  /** Orders whose grant was used by this write (add to grants_used; record a `used` entry and blobs). */
  grantsUsed: string[];
}

export interface OrderBreakdown {
  order_id: string;
  edit: number;
  prox: number | null;
  wA: number;
  wR: number;
  iA: number;
  iR: number;
  two_sided: boolean;
  small: boolean;
  degraded: boolean;
  missing: boolean;
  stale: boolean;
  matched: boolean;
  changes_covered_unit: boolean;
  units: OrderScore['units'];
}

export interface DecideResult {
  decision: Decision;
  effects: DecideEffects;
  scores: OrderScore[];
}

export const DEFAULT_DECIDE_CONFIG: DecideConfig = {
  ...DEFAULT_MATCH_CONFIG,
  decision_format: 'deny',
  mode: 'enforce',
};

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** `DNR: <reason> <revert URL>` (§6, R1). */
export function reasonLine(order: Order): string {
  const url =
    order.links.find((l) => l.rel === 'revert')?.url ??
    order.links.find((l) => l.rel === 'original')?.url ??
    order.links[0]?.url ??
    '';
  return `DNR: ${order.reason}${url ? ` ${url}` : ''}`;
}

function filesOf(order: Order): Set<string> {
  return new Set(order.units.map((u) => u.file));
}

export function decide(input: DecideInput): DecideResult {
  const now = input.now ?? clock;
  const t0 = now();
  const cfg: DecideConfig = { ...DEFAULT_DECIDE_CONFIG, ...input.config };
  const warned = new Set(input.warned ?? []);
  const grant = input.grantApplies ?? (() => false);
  const effects: DecideEffects = { warn: null, grantsUsed: [] };
  const done = (d: Omit<Decision, 'latency_ms' | 'scope'>, scores: OrderScore[] = []): DecideResult => ({
    decision: { ...d, scope: 'order', latency_ms: Math.max(0, now() - t0) },
    effects,
    scores,
  });
  const base = {
    edit_score: null,
    prox_score: null,
    fired_by: null,
    breakdown: [] as unknown[],
    reason_line: null,
  };

  if (input.protected) {
    return done({
      ...base,
      outcome: 'deny_protected',
      tier: 'protect',
      order_id: null,
      reason_line: `DNR: ${input.target} is protected`,
      fast_path: true,
    });
  }

  const approved = input.orders.filter((e) => e.order.status === 'approved');
  const searchFiles = input.searchFiles ?? [];
  const relevant = approved.filter((e) => {
    if (filesOf(e.order).has(input.target)) return true;
    // A write to another file can still complete a move/rename of an order unit (§5.16).
    return !!e.material && searchFiles.includes(input.target);
  });
  if (relevant.length === 0) {
    return done({ ...base, outcome: 'allow', tier: 'none', order_id: null, fast_path: true });
  }

  const scores: OrderScore[] = [];
  const rows: Array<{ entry: OrderEntry; score: OrderScore | null; capped: boolean; changes: boolean }> = [];
  for (const entry of [...relevant].sort((a, b) => a.order.id.localeCompare(b.order.id))) {
    const coversTarget = filesOf(entry.order).has(input.target);
    if (input.unknownTool) {
      rows.push({ entry, score: null, capped: true, changes: coversTarget });
      continue;
    }
    const score = scoreOrder(entry.order, input.baseline, input.proposed, {
      config: cfg,
      ...(entry.material ? { material: entry.material } : {}),
      searchFiles,
    });
    scores.push(score);
    const capped = !!entry.stale || !!entry.relanded;
    rows.push({ entry, score, capped, changes: changesCoveredUnit(entry.order, input, score) });
  }

  const breakdown: OrderBreakdown[] = rows
    .filter((r) => r.score)
    .map((r) => {
      const s = r.score as OrderScore;
      return {
        order_id: s.order_id,
        edit: s.edit,
        prox: s.prox,
        wA: s.wA,
        wR: s.wR,
        iA: s.iA,
        iR: s.iR,
        two_sided: s.two_sided,
        small: s.small,
        degraded: s.degraded,
        missing: s.missing,
        stale: r.capped,
        matched: s.matched && !r.capped,
        changes_covered_unit: r.changes,
        units: s.units,
      };
    });
  const scoreFields = (s: OrderScore | null) => ({
    edit_score: s ? s.edit : null,
    prox_score: s ? s.prox : null,
  });

  // Match tier (in warn-only mode, a match is downgraded to the warn tier).
  const matches = rows
    .filter((r) => r.score?.matched && !r.capped)
    .sort((a, b) => (b.score?.edit ?? 0) - (a.score?.edit ?? 0));
  const ungranted = matches.filter((r) => !grant(r.entry.order.id));
  const granted = matches.filter((r) => grant(r.entry.order.id));
  if (cfg.mode === 'enforce' && ungranted[0]) {
    const r = ungranted[0];
    const s = r.score as OrderScore;
    return done(
      {
        ...scoreFields(s),
        outcome: cfg.decision_format === 'ask' ? 'ask' : 'block',
        tier: 'match',
        order_id: r.entry.order.id,
        fired_by: s.fired_by,
        breakdown,
        reason_line: reasonLine(r.entry.order),
        fast_path: false,
      },
      scores,
    );
  }

  // Warn tier: the write changes a covered unit of an order it does not match (or a downgraded match).
  const warnRows = rows.filter((r) => {
    const liveMatch = !!r.score?.matched && !r.capped;
    if (cfg.mode === 'warn-only') return r.changes || liveMatch;
    return r.changes && !liveMatch;
  });
  const warnUngranted = warnRows.filter((r) => !grant(r.entry.order.id));
  const firstWarn = warnUngranted.find((r) => !warned.has(r.entry.order.id));
  if (firstWarn) {
    effects.warn = firstWarn.entry.order.id;
    return done(
      {
        ...scoreFields(firstWarn.score),
        outcome: 'warn_block',
        tier: 'warn',
        order_id: firstWarn.entry.order.id,
        fired_by: firstWarn.score?.matched && !firstWarn.capped ? firstWarn.score.fired_by : null,
        breakdown,
        reason_line: reasonLine(firstWarn.entry.order),
        fast_path: false,
      },
      scores,
    );
  }
  if (cfg.mode === 'enforce' && granted[0]) {
    const r = granted[0];
    effects.grantsUsed = granted.map((g) => g.entry.order.id);
    return done(
      {
        ...scoreFields(r.score),
        outcome: 'allow_grant',
        tier: 'match',
        order_id: r.entry.order.id,
        fired_by: r.score?.fired_by ?? null,
        breakdown,
        reason_line: null,
        fast_path: false,
      },
      scores,
    );
  }
  if (warnUngranted[0]) {
    const r = warnUngranted[0];
    return done(
      {
        ...scoreFields(r.score),
        outcome: 'warn_pass',
        tier: 'warn',
        order_id: r.entry.order.id,
        fired_by: null,
        breakdown,
        reason_line: null,
        fast_path: false,
      },
      scores,
    );
  }
  const warnGranted = warnRows.filter((r) => grant(r.entry.order.id));
  if (warnGranted[0]) {
    const r = warnGranted[0];
    effects.grantsUsed = warnGranted.map((g) => g.entry.order.id);
    return done(
      {
        ...scoreFields(r.score),
        outcome: 'allow_grant',
        tier: 'warn',
        order_id: r.entry.order.id,
        fired_by: null,
        breakdown,
        reason_line: null,
        fast_path: false,
      },
      scores,
    );
  }
  // Allow: still report the highest-scoring relevant order, so a near-miss is visible in the log.
  const top = [...scores].sort((a, b) => b.edit - a.edit)[0] ?? null;
  return done(
    {
      ...base,
      ...scoreFields(top),
      outcome: 'allow',
      tier: 'none',
      order_id: null,
      breakdown,
      fast_path: false,
    },
    scores,
  );
}

/** Does this write change a unit the order covers (relative to the session state before the write)? */
function changesCoveredUnit(order: Order, input: DecideInput, score: OrderScore): boolean {
  const before = input.current.units(input.target);
  const after = input.proposed.units(input.target);
  for (const u of order.units) {
    if (u.file === input.target) {
      const a = before?.units.get(u.qualname)?.tokens ?? null;
      const b = after?.units.get(u.qualname)?.tokens ?? null;
      if (a === null && b === null) continue;
      if (a === null || b === null || !sameTokens(a, b)) return true;
    }
  }
  // A unit relocated into the target counts as covered there.
  return score.units.some((us) => us.relocated_to?.file === input.target && fileChanged(input, input.target));
}

function fileChanged(input: DecideInput, path: string): boolean {
  return input.current.text(path) !== input.proposed.text(path);
}

/** The stderr text for a block (§6), at most 1,200 characters. */
export function blockMessage(
  order: Order,
  decision: Decision,
  opts: { qualnames?: readonly string[]; threshold?: number; proxThreshold?: number } = {},
): string {
  const link = (rel: string) => order.links.find((l) => l.rel === rel)?.url;
  const score =
    decision.fired_by === 'prox'
      ? `prox ${(decision.prox_score ?? 0).toFixed(2)} ≥ ${(opts.proxThreshold ?? DEFAULT_MATCH_CONFIG.prox_threshold).toFixed(2)}`
      : `edit ${(decision.edit_score ?? 0).toFixed(2)} ≥ ${(opts.threshold ?? DEFAULT_MATCH_CONFIG.threshold).toFixed(2)}`;
  const where = opts.qualnames?.length ? ` in ${opts.qualnames.join(', ')}` : '';
  const original = link('original');
  const ticket = order.tickets[0]?.url ?? link('ticket');
  const lines = [
    reasonLine(order),
    `DNR order ${order.id} matched (${score})${where}.${original ? ` Original: ${original}.` : ''}${ticket ? ` Ticket: ${ticket}.` : ''}`,
    `This change was tried and reverted. Do not re-apply it or route around this block. Tell the user. Only a human maintainer, not the agent, can approve a re-land: \`dnr board --open ${order.id}\` or \`dnr allow ${order.id}\`, which both need a terminal and refuse inside an agent session.`,
  ];
  const msg = lines.join('\n');
  return msg.length <= 1200 ? msg : `${msg.slice(0, 1199)}…`;
}
