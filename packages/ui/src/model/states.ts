/**
 * Order states (plan §10 state table): every state has a visual, a text label and next actions.
 * Transition rules are shared by the board API and the Playground's localStorage adapter.
 */
import type { Order } from '@dnr/schemas';
import type { EffectiveStatus, StoredStatus } from './types';

export type ActionId =
  | 'approve'
  | 'edit'
  | 'retire'
  | 'unretire'
  | 'allow-once'
  | 'reapprove'
  | 'view-diff'
  | 'restore';

export interface StateInfo {
  visual: 'outlined' | 'solid' | 'faded' | 'cracked' | 'candle' | 'disturbed';
  label: string;
  actions: ActionId[];
}

export const STATE_INFO: Record<EffectiveStatus, StateInfo> = {
  draft: { visual: 'outlined', label: 'Draft: not enforced', actions: ['approve', 'edit', 'retire'] },
  approved: { visual: 'solid', label: 'Approved: enforced', actions: ['allow-once', 'edit', 'retire'] },
  retired: { visual: 'faded', label: 'Retired', actions: ['unretire'] },
  stale: { visual: 'cracked', label: 'Stale: code changed, warn only', actions: ['reapprove', 'retire'] },
  relanded: {
    visual: 'candle',
    label: 'Re-landed: warn only until re-approved',
    actions: ['reapprove', 'retire'],
  },
  violated: {
    visual: 'disturbed',
    label: 'Violated: re-applied by an agent, still enforced',
    actions: ['reapprove', 'retire'],
  },
};

export const DRIFT_INFO = {
  label: 'Differs from git',
  actions: ['view-diff', 'restore'] as ActionId[],
};

export const ACTION_LABEL: Record<ActionId, string> = {
  approve: 'Approve',
  edit: 'Edit reason',
  retire: 'Retire',
  unretire: 'Unretire',
  'allow-once': 'Allow once (1 h)',
  reapprove: 'Re-approve (rebases snapshot)',
  'view-diff': 'View diff',
  restore: 'Restore from git',
};

export type HistoryAction = Order['history'][number]['action'];

/**
 * Valid stored-status transitions. Anything else is a 409.
 * - draft → approved (approved), draft → retired (retired)
 * - approved → retired (retired)
 * - retired → draft (unretired): an unretired order is not enforced until approved again.
 */
export function checkTransition(
  from: StoredStatus,
  to: StoredStatus,
): { ok: true; action: HistoryAction } | { ok: false; message: string } {
  if (from === 'draft' && to === 'approved') return { ok: true, action: 'approved' };
  if (from === 'draft' && to === 'retired') return { ok: true, action: 'retired' };
  if (from === 'approved' && to === 'retired') return { ok: true, action: 'retired' };
  if (from === 'retired' && to === 'draft') return { ok: true, action: 'unretired' };
  return { ok: false, message: `Invalid transition: ${from} → ${to}` };
}

/** Re-approve is valid only for an approved order that is stale, re-landed or violated. */
export function canReapprove(effective: EffectiveStatus): boolean {
  return effective === 'stale' || effective === 'relanded' || effective === 'violated';
}

/** Apply a PATCH to an order (pure). Throws `TransitionRejected` on an invalid transition or reason. */
export class TransitionRejected extends Error {}

export function applyPatch(
  order: Order,
  body: { status?: StoredStatus; reason?: string },
  by: string,
  at: string,
): Order {
  let next: Order = { ...order, history: [...order.history] };
  if (body.status === undefined && body.reason === undefined) throw new TransitionRejected('Empty patch');
  if (body.status !== undefined) {
    const t = checkTransition(order.status, body.status);
    if (!t.ok) throw new TransitionRejected(t.message);
    next = { ...next, status: body.status, history: [...next.history, { at, by, action: t.action }] };
  }
  if (body.reason !== undefined) {
    const reason = body.reason.trim();
    if (reason.length < 1 || reason.length > 280)
      throw new TransitionRejected('Reason must be 1–280 characters');
    if (next.status === 'retired') throw new TransitionRejected('A retired order cannot be edited');
    next = {
      ...next,
      reason,
      reason_source: 'human',
      history: [...next.history, { at, by, action: 'edited_reason' }],
    };
  }
  return { ...next, updated_at: at };
}

/** Effective status of a stored order given derived flags. */
export function effectiveStatus(
  order: Order,
  flags: { stale?: boolean; relanded?: boolean },
): EffectiveStatus {
  if (order.status !== 'approved') return order.status;
  if (flags.relanded) return 'relanded';
  if (flags.stale) return 'stale';
  return 'approved';
}

/** Graveyard empty / banner states (STATE-07). */
export type GraveyardSummary =
  | { kind: 'no-orders'; label: string; next: string }
  | { kind: 'no-reverts'; label: string; next: string }
  | { kind: 'drafts-only'; label: string; next: string }
  | { kind: 'ok' };

export function graveyardSummary(
  rows: ReadonlyArray<{ effective: EffectiveStatus }>,
  opts: { scanFoundZero?: boolean } = {},
): GraveyardSummary {
  if (rows.length === 0) {
    if (opts.scanFoundZero)
      return {
        kind: 'no-reverts',
        label: 'No reverts found in this history',
        next: 'dnr orders add <commit>',
      };
    return { kind: 'no-orders', label: 'No orders yet', next: 'dnr scan' };
  }
  const drafts = rows.filter((r) => r.effective === 'draft').length;
  const enforced = rows.filter((r) => r.effective === 'approved').length;
  if (drafts > 0 && drafts === rows.length && enforced === 0)
    return {
      kind: 'drafts-only',
      label: `${drafts} draft${drafts === 1 ? '' : 's'}, 0 enforced`,
      next: 'Review drafts',
    };
  return { kind: 'ok' };
}
