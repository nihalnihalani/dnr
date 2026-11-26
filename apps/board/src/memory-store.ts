/**
 * In-memory `BoardStorePort` for tests and `dev.ts`. Uses the shared pure rules from `@dnr/ui/model`
 * so its behaviour matches the real store and the Playground adapter.
 */
import type { EventRecord, Grant, Order } from '@dnr/schemas';
import type { EffectiveStatus, OrderDiff, OrderRow, PatchBody } from '@dnr/ui/model';
import { applyPatch, canReapprove, TransitionRejected } from '@dnr/ui/model';
import { type BoardStorePort, NotFoundError, TransitionError } from './store-port';

export interface MemoryStoreInit {
  rows: OrderRow[];
  grants?: Grant[];
  events?: EventRecord[];
  /** ms clock; default Date.now. */
  now?: () => number;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements BoardStorePort {
  private readonly rows = new Map<string, OrderRow>();
  /** The committed copy of each order file (what `git show HEAD:<file>` would return). */
  private readonly git = new Map<string, Order>();
  private readonly grants: Grant[];
  private readonly events: EventRecord[];
  private readonly now: () => number;

  constructor(init: MemoryStoreInit) {
    for (const row of init.rows) {
      this.rows.set(row.order.id, clone(row));
      this.git.set(row.order.id, clone(row.order));
    }
    this.grants = clone(init.grants ?? []);
    this.events = clone(init.events ?? []);
    this.now = init.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private row(id: string): OrderRow {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError(`No order ${id}`);
    return row;
  }

  async listOrders(): Promise<OrderRow[]> {
    return [...this.rows.values()].map(clone);
  }

  async getOrder(id: string): Promise<OrderRow | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async patchOrder(id: string, patch: PatchBody, by: string): Promise<OrderRow> {
    const row = this.row(id);
    let order: Order;
    try {
      order = applyPatch(row.order, patch, by, this.iso());
    } catch (err) {
      if (err instanceof TransitionRejected) throw new TransitionError(err.message);
      throw err;
    }
    let effective: EffectiveStatus = order.status;
    // A reason edit on a stale or re-landed order keeps the derived state.
    if (order.status === 'approved' && (row.effective === 'stale' || row.effective === 'relanded')) {
      effective = row.effective;
    }
    const next: OrderRow = { ...row, order, effective };
    this.rows.set(id, next);
    return clone(next);
  }

  async reapprove(id: string, by: string): Promise<OrderRow> {
    const row = this.row(id);
    if (!canReapprove(row.effective)) {
      throw new TransitionError(`Re-approve needs a stale or re-landed order; ${id} is ${row.effective}`);
    }
    const at = this.iso();
    const order: Order = {
      ...row.order,
      history: [...row.order.history, { at, by, action: 'reapproved' }],
      updated_at: at,
    };
    const next: OrderRow = { ...row, order, effective: 'approved' };
    this.rows.set(id, next);
    return clone(next);
  }

  async allowOnce(id: string, ttlSeconds: number, by: string): Promise<Grant> {
    const row = this.row(id);
    if (row.effective !== 'approved' && row.effective !== 'stale' && row.effective !== 'relanded') {
      throw new TransitionError(`Allow once needs an enforced order; ${id} is ${row.effective}`);
    }
    const now = this.now();
    const grant: Grant = {
      order_id: id,
      session_key: null,
      kind: 'allow_once',
      granted_by: by,
      granted_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
      used: [],
      blobs: [],
    };
    this.grants.push(grant);
    return clone(grant);
  }

  async listGrants(orderId?: string): Promise<Grant[]> {
    return this.grants.filter((g) => orderId === undefined || g.order_id === orderId).map(clone);
  }

  async listEvents(filter: { order?: string }): Promise<EventRecord[]> {
    return this.events
      .filter((e) => filter.order === undefined || e.decision.order_id === filter.order)
      .map(clone);
  }

  async diff(id: string): Promise<OrderDiff> {
    const row = this.row(id);
    const git = this.git.get(id) ?? null;
    const unified = git ? unifiedDiff(json(git), json(row.order), id) : '';
    return { file: clone(row.order), git: git ? clone(git) : null, unified };
  }
}

const json = (o: Order): string => `${JSON.stringify(o, null, 2)}\n`;

/** A minimal single-hunk unified diff (LCS over lines). Order files are small. */
export function unifiedDiff(a: string, b: string, id: string): string {
  if (a === b) return '';
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const below = lcs[i + 1] as number[];
      row[j] =
        x[i] === y[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push(` ${x[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      out.push(`+${y[j]}`);
      j++;
    } else {
      out.push(`-${x[i]}`);
      i++;
    }
  }
  const path = `.dnr/orders/${id}.json`;
  return `--- a/${path}\n+++ b/${path}\n@@ -1,${n} +1,${m} @@\n${out.join('\n')}\n`;
}
