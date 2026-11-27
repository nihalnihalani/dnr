/**
 * Shapes shared by the UI, both data adapters and the local board API (plan §10).
 * The board's JSON responses are exactly these types.
 */
import type { EventRecord, Grant, Order } from '@dnr/schemas';

/** Stored status plus the two derived ones (§5.9). `stale` and `relanded` are never stored. */
/** `violated` (N4): the re-application was committed in an agent session without a grant; still enforced. */
export type EffectiveStatus = 'draft' | 'approved' | 'retired' | 'stale' | 'relanded' | 'violated';
export type StoredStatus = Order['status'];

export interface OrderRow {
  order: Order;
  effective: EffectiveStatus;
  /** The order file differs from the committed copy in git (STATE-06). */
  drift: boolean;
  /** For `violated`: the commit that re-applied the change, and when. */
  violation?: { commit: string; at: string };
  /** Playground only: the /play case that exercises this order. */
  case_id?: string;
}

export interface OrderDetail extends OrderRow {
  grants: Grant[];
}

export interface OrderDiff {
  file: Order;
  git: Order | null;
  unified: string;
}

export interface PatchBody {
  status?: StoredStatus;
  reason?: string;
}

/**
 * Hook state the board warns about (plan §10 error banners), read from the real store:
 * - `tamper`: the persistent tamper flag (`$DNR_STATE_DIR/tamper.json`, wave-3 N3), or null;
 * - `error_open`: events where the hook failed open (allowed a write it could not decide).
 */
export interface BoardStatus {
  tamper: { opened_at: string; findings: Array<{ at: string; what: string }> } | null;
  error_open: Array<{ at: string; hook: string; error: string }>;
}

export interface Health {
  origin: string;
  version: string;
}

/** Error body for every non-2xx board response. */
export interface ApiErrorBody {
  error: 'unauthorized' | 'forbidden' | 'misdirected' | 'not_found' | 'invalid_transition' | 'bad_request';
  message: string;
}

export class AdapterError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorBody['error'] | 'invalid_order' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/** One interface, two implementations: the local board API and localStorage (Playground). */
export interface DataAdapter {
  readonly kind: 'api' | 'local';
  /** Actions only change localStorage (Playground). The UI labels them "simulated". */
  readonly simulated: boolean;
  listOrders(): Promise<OrderRow[]>;
  getOrder(id: string): Promise<OrderDetail | null>;
  patchOrder(id: string, body: PatchBody): Promise<OrderRow>;
  allowOnce(id: string, ttlSeconds: number): Promise<Grant>;
  reapprove(id: string): Promise<OrderRow>;
  diff(id: string): Promise<OrderDiff>;
  events(orderId?: string): Promise<EventRecord[]>;
  /** N5: a human confirms a suspect grant (made while an agent session looked active). */
  confirmGrant(orderId: string, sessionKey: string | null): Promise<Grant>;
  /** Board only: tamper flag and fail-open events. The Playground has no hook state. */
  status?(): Promise<BoardStatus>;
}

/** Grant origin with the N5 confirmation fields (optional until @dnr/schemas carries them). */
export type GrantOrigin = NonNullable<Grant['origin']> & { confirmed_by?: string; confirmed_at?: string };

export function grantOrigin(g: Grant): GrantOrigin | null {
  return (g.origin as GrantOrigin | undefined) ?? null;
}

/** A suspect grant applies only once a human has confirmed it. */
export function needsConfirmation(g: Grant): boolean {
  const o = grantOrigin(g);
  return !!o?.suspect && !o.confirmed_by;
}
