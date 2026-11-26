/**
 * The store contract the board needs (plan §10). `dnr board` passes an implementation backed by
 * `@dnr/store` (orders, grants, events, history); tests use `MemoryStore`.
 *
 * Every method may throw `TransitionError` (→ 409) or `NotFoundError` (→ 404).
 */
import type { EventRecord, Grant, Order } from '@dnr/schemas';
import type { OrderDiff, OrderRow, PatchBody } from '@dnr/ui/model';

export type { EffectiveStatus, OrderDiff, OrderRow, PatchBody } from '@dnr/ui/model';

export class TransitionError extends Error {
  override name = 'TransitionError';
}
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export interface BoardStorePort {
  listOrders(): Promise<OrderRow[]>;
  getOrder(id: string): Promise<OrderRow | null>;
  /** Status and/or reason change, appended to history as `by`. Invalid transitions throw TransitionError. */
  patchOrder(id: string, patch: PatchBody, by: string): Promise<OrderRow>;
  /** Rebase snapshot_sha to HEAD and append `reapproved`. Only for stale or re-landed orders. */
  reapprove(id: string, by: string): Promise<OrderRow>;
  /** A session grant for the current session, or the next one (`<order_id>.pending.json`). */
  allowOnce(id: string, ttlSeconds: number, by: string): Promise<Grant>;
  listGrants(orderId?: string): Promise<Grant[]>;
  listEvents(filter: { order?: string }): Promise<EventRecord[]>;
  diff(id: string): Promise<OrderDiff>;
}

export type { EventRecord, Grant, Order };
