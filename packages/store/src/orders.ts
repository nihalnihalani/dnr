/**
 * The order store: one `<id>.json` per order in the orders directory, written atomically, with
 * lifecycle transitions and a coverage index (file → orders) cached in `<state>/cache/`.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Order } from '@dnr/schemas';
import { nowIso } from './clock';
import { readJsonOrNull, withLock, writeFileAtomic, writeJsonAtomic } from './fsutil';

export type OrderStatus = Order['status'];
export type HistoryAction = Order['history'][number]['action'];

/** Raised on an invalid lifecycle transition (the board maps it to 409). */
export class TransitionError extends Error {
  constructor(
    readonly orderId: string,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`DNR: ${orderId} cannot go from ${from} to ${to}`);
    this.name = 'TransitionError';
  }
}

export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`DNR: no order ${orderId}`);
    this.name = 'OrderNotFoundError';
  }
}

/**
 * Allowed transitions and the history action each one logs:
 * draft→approved (approved), draft→retired, approved→retired (retired), retired→draft (unretired).
 */
export function checkTransition(from: OrderStatus, to: OrderStatus): HistoryAction | null {
  if (from === 'draft' && to === 'approved') return 'approved';
  if ((from === 'draft' || from === 'approved') && to === 'retired') return 'retired';
  if (from === 'retired' && to === 'draft') return 'unretired';
  return null;
}

export interface InvalidOrderFile {
  file: string;
  error: string;
}

export interface CoverageEntry {
  id: string;
  status: OrderStatus;
}

interface IndexCache {
  version: 1;
  ordersDir: string;
  stamps: Record<string, string>;
  byFile: Record<string, CoverageEntry[]>;
}

export function serializeOrder(order: Order): string {
  return `${JSON.stringify(order, null, 2)}\n`;
}

export class OrderStore {
  constructor(
    readonly ordersDir: string,
    /** Where the coverage index cache lives (`<state>/cache`); null disables the cache. */
    readonly cacheDir: string | null = null,
    /** Called after every mutation (e.g. to refresh live sessions' orders_hash, §5.11). */
    readonly onMutate: (() => Promise<void>) | null = null,
  ) {}

  fileFor(id: string): string {
    return join(this.ordersDir, `${id}.json`);
  }

  private async names(): Promise<string[]> {
    try {
      return (await readdir(this.ordersDir)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  /** Every order that validates, plus the files that do not. */
  async load(): Promise<{ orders: Order[]; invalid: InvalidOrderFile[] }> {
    const orders: Order[] = [];
    const invalid: InvalidOrderFile[] = [];
    for (const n of await this.names()) {
      const file = join(this.ordersDir, n);
      try {
        const r = Order.safeParse(JSON.parse(await readFile(file, 'utf8')));
        if (!r.success) {
          invalid.push({
            file,
            error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        } else if (`${r.data.id}.json` !== n) {
          invalid.push({ file, error: `id ${r.data.id} does not match the file name` });
        } else orders.push(r.data);
      } catch (e) {
        invalid.push({ file, error: String(e) });
      }
    }
    return { orders, invalid };
  }

  async list(): Promise<Order[]> {
    return (await this.load()).orders;
  }

  async get(id: string): Promise<Order | null> {
    const raw = await readJsonOrNull(this.fileFor(id));
    if (raw === null) return null;
    return Order.parse(raw);
  }

  async require(id: string): Promise<Order> {
    const o = await this.get(id);
    if (!o) throw new OrderNotFoundError(id);
    return o;
  }

  /** Validate and write an order atomically. */
  async put(order: Order): Promise<void> {
    const valid = Order.parse(order);
    await writeFileAtomic(this.fileFor(valid.id), serializeOrder(valid));
    await this.mutated();
  }

  async remove(id: string): Promise<void> {
    await rm(this.fileFor(id), { force: true });
    await this.mutated();
  }

  private async mutated(): Promise<void> {
    if (this.onMutate) await this.onMutate();
  }

  /** Read-modify-write one order under its lock. `fn` returns the new order (or the same to skip). */
  async update(id: string, fn: (o: Order) => Order | Promise<Order>): Promise<Order> {
    return withLock(this.fileFor(id), async () => {
      const cur = await this.require(id);
      const next = await fn(structuredClone(cur));
      if (JSON.stringify(next) !== JSON.stringify(cur)) await this.put(next);
      return next;
    });
  }

  /** Apply a lifecycle transition; throws TransitionError when it is not allowed. */
  async transition(
    id: string,
    to: OrderStatus,
    by: string,
    at = nowIso(),
    origin?: Order['history'][number]['origin'],
  ): Promise<Order> {
    return this.update(id, (o) => {
      const action = checkTransition(o.status, to);
      if (!action) throw new TransitionError(id, o.status, to);
      o.status = to;
      o.history.push(origin ? { at, by, action, origin } : { at, by, action });
      o.updated_at = at;
      return o;
    });
  }

  approve(id: string, by: string, at?: string, origin?: Order['history'][number]['origin']) {
    return this.transition(id, 'approved', by, at, origin);
  }
  retire(id: string, by: string, at?: string) {
    return this.transition(id, 'retired', by, at);
  }
  unretire(id: string, by: string, at?: string) {
    return this.transition(id, 'draft', by, at);
  }

  /** Replace the reason; appends `edited_reason`. The status is kept (§8 `draft`). */
  async editReason(
    id: string,
    reason: string,
    by: string,
    source: Order['reason_source'] = 'human',
    at = nowIso(),
  ): Promise<Order> {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > 280)
      throw new Error('DNR: reason must be 1–280 characters after trimming');
    return this.update(id, (o) => {
      o.reason = trimmed;
      o.reason_source = source;
      o.history.push({ at, by, action: 'edited_reason' });
      o.updated_at = at;
      return o;
    });
  }

  /**
   * Coverage index: repo-relative file → orders whose units touch it. Rebuilt only when an
   * order file's size or mtime changed, so the hook's fast path reads one small JSON file.
   */
  coverage(): Map<string, CoverageEntry[]> {
    let names: string[] = [];
    try {
      names = readdirSync(this.ordersDir)
        .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
        .sort();
    } catch {
      return new Map();
    }
    const stamps: Record<string, string> = {};
    for (const n of names) {
      try {
        const st = statSync(join(this.ordersDir, n));
        stamps[n] = `${st.size}:${st.mtimeMs}`;
      } catch {}
    }
    const cacheFile = this.cacheDir ? join(this.cacheDir, 'orders-index.json') : null;
    if (cacheFile) {
      try {
        const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as IndexCache;
        if (
          c.version === 1 &&
          c.ordersDir === this.ordersDir &&
          JSON.stringify(c.stamps) === JSON.stringify(stamps)
        )
          return new Map(Object.entries(c.byFile));
      } catch {}
    }
    const byFile: Record<string, CoverageEntry[]> = {};
    for (const n of names) {
      try {
        const r = Order.safeParse(JSON.parse(readFileSync(join(this.ordersDir, n), 'utf8')));
        if (!r.success) continue;
        for (const f of new Set(r.data.units.map((u) => u.file))) {
          const list = byFile[f] ?? [];
          list.push({ id: r.data.id, status: r.data.status });
          byFile[f] = list;
        }
      } catch {}
    }
    if (cacheFile) {
      const c: IndexCache = { version: 1, ordersDir: this.ordersDir, stamps, byFile };
      writeJsonAtomic(cacheFile, c).catch(() => {});
    }
    return new Map(Object.entries(byFile));
  }
}

/**
 * Hash of the enforcement inputs (§5.11): every file in the orders dir, the config file and the
 * DNR hook files. A change not made through a guarded `dnr` command forces a Stop turn.
 */
export function computeOrdersHash(inputs: {
  ordersDir: string;
  configFile: string;
  hooksDir: string;
}): string {
  const h = createHash('sha256');
  const addFile = (label: string, file: string) => {
    try {
      h.update(`${label}\0`);
      h.update(readFileSync(file));
      h.update('\0');
    } catch {
      h.update(`${label}\0<missing>\0`);
    }
  };
  const listDir = (dir: string, pred: (n: string) => boolean) => {
    try {
      return readdirSync(dir).filter(pred).sort();
    } catch {
      return [];
    }
  };
  for (const n of listDir(inputs.ordersDir, (n) => !n.startsWith('.') && n.endsWith('.json')))
    addFile(`orders/${n}`, join(inputs.ordersDir, n));
  addFile('config', inputs.configFile);
  for (const n of listDir(inputs.hooksDir, (n) => n.startsWith('dnr-') && n.endsWith('.json')))
    addFile(`hooks/${n}`, join(inputs.hooksDir, n));
  return h.digest('hex');
}
