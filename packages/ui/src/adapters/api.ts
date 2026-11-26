/** Local board adapter: same-origin fetches to the board's /api (cookie is HttpOnly, Path=/api). */
import type { EventRecord, Grant } from '@dnr/schemas';
import {
  AdapterError,
  type ApiErrorBody,
  type DataAdapter,
  type OrderDetail,
  type OrderDiff,
  type OrderRow,
  type PatchBody,
} from '../model/types';

export class ApiAdapter implements DataAdapter {
  readonly kind = 'api' as const;
  readonly simulated = false;
  constructor(private readonly base = '') {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-DNR-CSRF': '1' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new AdapterError(0, 'network', (e as Error).message);
    }
    if (!res.ok) {
      let err: Partial<ApiErrorBody> = {};
      try {
        err = (await res.json()) as ApiErrorBody;
      } catch {}
      throw new AdapterError(res.status, err.error ?? 'bad_request', err.message ?? res.statusText);
    }
    return (await res.json()) as T;
  }

  async listOrders(): Promise<OrderRow[]> {
    return (await this.req<{ orders: OrderRow[] }>('GET', '/orders')).orders;
  }
  async getOrder(id: string): Promise<OrderDetail | null> {
    try {
      return await this.req<OrderDetail>('GET', `/orders/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof AdapterError && e.status === 404) return null;
      throw e;
    }
  }
  patchOrder(id: string, body: PatchBody) {
    return this.req<OrderRow>('PATCH', `/orders/${encodeURIComponent(id)}`, body);
  }
  allowOnce(id: string, ttlSeconds: number) {
    return this.req<Grant>('POST', `/orders/${encodeURIComponent(id)}/allow-once`, { ttl: ttlSeconds });
  }
  reapprove(id: string) {
    return this.req<OrderRow>('POST', `/orders/${encodeURIComponent(id)}/reapprove`, {});
  }
  diff(id: string) {
    return this.req<OrderDiff>('GET', `/orders/${encodeURIComponent(id)}/diff`);
  }
  async events(orderId?: string): Promise<EventRecord[]> {
    const q = orderId ? `?order=${encodeURIComponent(orderId)}` : '';
    return (await this.req<{ events: EventRecord[] }>('GET', `/events${q}`)).events;
  }
}
