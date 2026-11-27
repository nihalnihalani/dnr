/**
 * Playground adapter: bundled orders, with simulated actions kept in localStorage.
 * Every action is labeled "simulated" in the UI; nothing leaves the browser.
 */
import type { EventRecord, Grant, Order } from '@dnr/schemas';
import { applyPatch, canReapprove, effectiveStatus, TransitionRejected } from '../model/states';
import {
  AdapterError,
  type DataAdapter,
  type OrderDetail,
  type OrderDiff,
  type OrderRow,
  type PatchBody,
} from '../model/types';

const KEY = 'dnr.playground.v1';

interface Persisted {
  orders: Record<string, Order>;
  effective: Record<string, OrderRow['effective']>;
  grants: Grant[];
}

export interface Storage {
  get(): string | null;
  set(v: string): void;
}

export function browserStorage(key = KEY): Storage {
  return {
    get() {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(v) {
      try {
        globalThis.localStorage?.setItem(key, v);
      } catch {
        /* private mode: state lives for this page only */
      }
    },
  };
}

export function memoryStorage(): Storage {
  let v: string | null = null;
  return {
    get: () => v,
    set: (x) => {
      v = x;
    },
  };
}

export class LocalAdapter implements DataAdapter {
  readonly kind = 'local' as const;
  readonly simulated = true;
  private mem: Persisted;

  constructor(
    private readonly seed: () => Promise<OrderRow[]>,
    private readonly storage: Storage = browserStorage(),
    private readonly clock: () => number = () => Date.now(),
    private readonly user = 'you (simulated)',
  ) {
    this.mem = this.load();
  }

  private load(): Persisted {
    const raw = this.storage.get();
    if (raw) {
      try {
        const p = JSON.parse(raw) as Persisted;
        if (p && typeof p === 'object' && p.orders && p.grants) return { ...p, effective: p.effective ?? {} };
      } catch {
        /* corrupt: start over */
      }
    }
    return { orders: {}, effective: {}, grants: [] };
  }
  private save() {
    this.storage.set(JSON.stringify(this.mem));
  }
  /** Forget every simulated change. */
  reset() {
    this.mem = { orders: {}, effective: {}, grants: [] };
    this.save();
  }

  private async rows(): Promise<OrderRow[]> {
    const seeded = await this.seed();
    return seeded.map((r) => {
      const order = this.mem.orders[r.order.id] ?? r.order;
      const forced = this.mem.effective[r.order.id];
      const effective = forced
        ? order.status === 'approved'
          ? forced
          : order.status
        : r.order.status === order.status
          ? r.effective
          : effectiveStatus(order, {});
      const simulated = r.order.id in this.mem.orders || r.order.id in this.mem.effective;
      return { ...r, order, effective, ...(simulated ? { simulated: true } : {}) };
    });
  }

  private async row(id: string): Promise<OrderRow> {
    const r = (await this.rows()).find((x) => x.order.id === id);
    if (!r) throw new AdapterError(404, 'not_found', `No order ${id}`);
    return r;
  }

  listOrders() {
    return this.rows();
  }

  async getOrder(id: string): Promise<OrderDetail | null> {
    const r = (await this.rows()).find((x) => x.order.id === id);
    if (!r) return null;
    return { ...r, grants: this.mem.grants.filter((g) => g.order_id === id) };
  }

  /** The order a simulated /play session enforces (with simulated status changes applied). */
  async orderFor(id: string): Promise<Order | null> {
    return (await this.getOrder(id))?.order ?? null;
  }

  async patchOrder(id: string, body: PatchBody): Promise<OrderRow> {
    const r = await this.row(id);
    let next: Order;
    try {
      next = applyPatch(r.order, body, this.user, new Date(this.clock()).toISOString());
    } catch (e) {
      if (e instanceof TransitionRejected) throw new AdapterError(409, 'invalid_transition', e.message);
      throw e;
    }
    this.mem.orders[id] = next;
    // A simulated status change resets any derived state recorded for this order.
    if (body.status !== undefined) this.mem.effective[id] = effectiveStatus(next, {});
    this.save();
    return this.row(id);
  }

  async allowOnce(id: string, ttlSeconds: number): Promise<Grant> {
    const r = await this.row(id);
    if (r.order.status !== 'approved')
      throw new AdapterError(409, 'invalid_transition', 'Only an approved order can be allowed once');
    const now = this.clock();
    const g: Grant = {
      order_id: id,
      session_key: null,
      kind: 'allow_once',
      granted_by: this.user,
      granted_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
      used: [],
      blobs: [],
    };
    this.mem.grants.push(g);
    this.save();
    return g;
  }

  async reapprove(id: string): Promise<OrderRow> {
    const r = await this.row(id);
    if (!canReapprove(r.effective))
      throw new AdapterError(
        409,
        'invalid_transition',
        `Re-approve needs a stale or re-landed order (is ${r.effective})`,
      );
    const at = new Date(this.clock()).toISOString();
    this.mem.orders[id] = {
      ...r.order,
      updated_at: at,
      history: [...r.order.history, { at, by: this.user, action: 'reapproved' }],
    };
    this.mem.effective[id] = 'approved';
    this.save();
    return this.row(id);
  }

  async diff(id: string): Promise<OrderDiff> {
    const r = await this.row(id);
    const seeded = (await this.seed()).find((x) => x.order.id === id)?.order ?? null;
    const a = JSON.stringify(seeded, null, 2).split('\n');
    const b = JSON.stringify(r.order, null, 2).split('\n');
    const lines: string[] = [`--- git:.dnr/orders/${id}.json`, `+++ working:.dnr/orders/${id}.json`];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] !== undefined) lines.push(`-${a[i]}`);
      if (b[i] !== undefined) lines.push(`+${b[i]}`);
    }
    return { file: r.order, git: seeded, unified: lines.join('\n') };
  }

  async events(): Promise<EventRecord[]> {
    return [];
  }

  async confirmGrant(id: string, sessionKey: string | null): Promise<Grant> {
    const g = this.mem.grants.find((x) => x.order_id === id && x.session_key === sessionKey);
    if (!g) throw new AdapterError(404, 'not_found', `No grant for ${id}`);
    const o = g.origin as
      | (NonNullable<Grant['origin']> & { confirmed_by?: string; confirmed_at?: string })
      | undefined;
    if (!o?.suspect || o.confirmed_by)
      throw new AdapterError(409, 'invalid_transition', 'This grant does not need confirmation');
    o.confirmed_by = this.user;
    o.confirmed_at = new Date(this.clock()).toISOString();
    this.save();
    return g;
  }

  /** Record a grant use from a simulated /play write (shown in the audit panel). */
  recordUse(orderId: string, kind: 'write' | 'commit' | 'backstop' = 'write') {
    const now = this.clock();
    const g = [...this.mem.grants]
      .reverse()
      .find((x) => x.order_id === orderId && (Date.parse(x.expires_at) > now || x.used.length > 0));
    if (!g) return;
    g.used.push({ at: new Date(now).toISOString(), event_id: `sim-${now.toString(36)}`, kind });
    this.save();
  }

  /** Simulated "Restore from git": drop local changes to one order. */
  async restore(id: string): Promise<OrderRow> {
    delete this.mem.orders[id];
    delete this.mem.effective[id];
    this.save();
    const r = await this.row(id);
    return { ...r, drift: false };
  }
}
