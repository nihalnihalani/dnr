/**
 * Shapes shared by the UI, both data adapters and the local board API (plan §10).
 * The board's JSON responses are exactly these types.
 */
import type { EventRecord, Grant, Order } from '@dnr/schemas';

/** Stored status plus the two derived ones (§5.9). `stale` and `relanded` are never stored. */
export type EffectiveStatus = 'draft' | 'approved' | 'retired' | 'stale' | 'relanded';
export type StoredStatus = Order['status'];

export interface OrderRow {
  order: Order;
  effective: EffectiveStatus;
  /** The order file differs from the committed copy in git (STATE-06). */
  drift: boolean;
  /**
   * Playground only: this row's derived state (stale, relanded, drift) is illustrative, not
   * computed from a repository. Always false on the board.
   */
  illustrative?: boolean;
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
}
