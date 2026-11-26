/**
 * Trusted DNR state (wave-2 C1, wave-3 N1/N3; lead decisions amending plan R7 and §5.9).
 *
 * An agent can write `.dnr/` with any interpreter and move HEAD with git, so no single copy of the
 * order set is trusted. DNR enforces the **union** of the approved orders in:
 *  - the working copy,
 *  - the committed tree (HEAD),
 *  - the set captured when the session started (`<state>/session-orders/<key>.json`),
 *  - the last human-attested record (`.dnr/attested.json`, written only by human-guarded commands).
 * The attested record is the human's word: for an order it lists, its status wins. Any other way
 * an order is removed or weakened is reported in `weakened` and opens a persistent tamper flag
 * (`<state>/tamper.json`) that only a guarded `dnr tamper accept` clears.
 *
 * A broken git repository (unreadable HEAD, missing objects) is tampering, not a DNR bug: the
 * hook fails closed with the working-copy, session-start and attested sets (`gitBroken`).
 *
 * The committed set is cached by HEAD's commit id (`<state>/cache/committed-<sha>.json`), read
 * from the ref files without spawning git (latency, N8). A forged cache can only change the HEAD
 * source; the union with the other three keeps enforcing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { catBlobs, committedStateArgs, hasObjects, memoGit, readHead } from '@dnr/git';
import { DnrConfig, Order } from '@dnr/schemas';
import { type AttestedRecord, orderHash, readAttested } from '@dnr/store';

export interface TrustedState {
  config: DnrConfig;
  configIssue: string | null;
  /** Effective orders by id (the union). */
  orders: Map<string, Order>;
  /** Ids whose working copy differs from HEAD. */
  differs: string[];
  /** Order files that do not validate in the working copy. */
  invalid: string[];
  /** Orders removed or weakened by something other than a human-guarded command. */
  weakened: string[];
  /** Why the git repository is unusable (fail closed), or null. */
  gitBroken: string | null;
  /** HEAD's commit id, or null (unborn or broken). */
  headSha: string | null;
  sources: {
    working: Map<string, Order>;
    committed: Map<string, Order>;
    session: Map<string, Order>;
    attested: AttestedRecord | null;
  };
}

function gitBlobSha(buf: Buffer): string {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function inside(repoRoot: string, p: string): string | null {
  const rel = relative(repoRoot, p);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) return null;
  return rel.split(sep).join('/');
}

function parseOrder(text: string | null): Order | null {
  if (text === null) return null;
  try {
    const r = Order.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Parse a config file text; `record` is refused from files. Returns the config or an issue. */
export function parseConfigText(text: string | null): { config: DnrConfig; issue: string | null } {
  if (text === null) return { config: DnrConfig.parse({}), issue: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      config: DnrConfig.parse({}),
      issue: `config is not valid JSON (${String(e).slice(0, 80)}); using the defaults`,
    };
  }
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).mode === 'record') {
    return {
      config: DnrConfig.parse({}),
      issue: 'config sets mode "record", which only DNR_MODE may set; using the defaults',
    };
  }
  const r = DnrConfig.safeParse(raw);
  if (!r.success)
    return {
      config: DnrConfig.parse({}),
      issue: `config is invalid (${r.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 160)}); using the defaults`,
    };
  return { config: r.data, issue: null };
}

/** Apply `DNR_MODE` / `DNR_THRESHOLD` (§8); invalid env values are ignored. */
export function applyEnv(config: DnrConfig, env: NodeJS.ProcessEnv): DnrConfig {
  const out = { ...config };
  const m = env.DNR_MODE;
  if (m === 'enforce' || m === 'record' || m === 'warn-only' || m === 'commit-enforce') out.mode = m;
  const t = env.DNR_THRESHOLD ? Number(env.DNR_THRESHOLD) : Number.NaN;
  if (Number.isFinite(t) && t >= 0 && t <= 1) out.threshold = t;
  return out;
}

export function readSessionOrders(
  stateDir: string,
  key: string,
): { head: string | null; orders: Map<string, Order>; committedApproved: string[] } {
  const out = new Map<string, Order>();
  try {
    const j = JSON.parse(readFileSync(join(stateDir, 'session-orders', `${key}.json`), 'utf8')) as {
      head?: string | null;
      orders?: unknown[];
      committed_approved?: unknown[];
    };
    for (const raw of j.orders ?? []) {
      const r = Order.safeParse(raw);
      if (r.success) out.set(r.data.id, r.data);
    }
    const committedApproved = (j.committed_approved ?? []).filter((x): x is string => typeof x === 'string');
    return { head: typeof j.head === 'string' ? j.head : null, orders: out, committedApproved };
  } catch {
    return { head: null, orders: out, committedApproved: [] };
  }
}

export function writeSessionOrders(
  stateDir: string,
  key: string,
  head: string | null,
  orders: Iterable<Order>,
  committedApproved: string[] = [],
): void {
  try {
    const dir = join(stateDir, 'session-orders');
    mkdirSync(dir, { recursive: true });
    const approved = [...orders].filter((o) => o.status === 'approved');
    writeFileSync(
      join(dir, `${key}.json`),
      `${JSON.stringify({ head, orders: approved, committed_approved: committedApproved })}\n`,
    );
  } catch {}
}

interface CommittedCache {
  head: string;
  scope: string[];
  entries: Record<string, string>;
}

/** Committed blobs for the scope at HEAD: cache by commit id, else one `git ls-tree`. */
async function committedEntries(
  repoRoot: string,
  cacheDir: string,
  head: string,
  scope: string[],
): Promise<{ entries: Map<string, string>; failed: boolean }> {
  const file = join(cacheDir, `committed-${head}.json`);
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as CommittedCache;
    if (c.head === head && JSON.stringify(c.scope) === JSON.stringify(scope))
      return { entries: new Map(Object.entries(c.entries)), failed: false };
  } catch {}
  const r = await memoGit(repoRoot, committedStateArgs(scope), [0, 128]);
  if (r.code !== 0) return { entries: new Map(), failed: true };
  const entries = new Map<string, string>();
  for (const rec of r.stdout.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(rec);
    if (m) entries.set(m[2] as string, m[1] as string);
  }
  try {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ head, scope, entries: Object.fromEntries(entries) } satisfies CommittedCache),
    );
    renameSync(tmp, file);
  } catch {}
  return { entries, failed: false };
}

const RANK: Record<Order['status'], number> = { approved: 2, draft: 1, retired: 0 };

/** Union of the sources (see the module comment), and which orders were weakened. */
export function unionOrders(
  s: TrustedState['sources'],
  sessionCommitted: readonly string[] = [],
): { orders: Map<string, Order>; weakened: string[] } {
  const orders = new Map<string, Order>();
  const weakened: string[] = [];
  const ids = new Set([
    ...s.working.keys(),
    ...s.committed.keys(),
    ...s.session.keys(),
    ...Object.keys(s.attested?.orders ?? {}),
  ]);
  for (const id of [...ids].sort()) {
    const cands = [s.committed.get(id), s.session.get(id), s.working.get(id)].filter((x): x is Order => !!x);
    const att = s.attested?.orders[id];
    let chosen: Order | undefined;
    if (att) {
      chosen = cands.find((c) => orderHash(c) === att.sha256);
      if (!chosen) {
        // The attested version is gone from every copy: keep the strongest one there is.
        chosen = [...cands].sort((a, b) => RANK[b.status] - RANK[a.status])[0];
        if (att.status === 'approved' && chosen?.status !== 'approved') weakened.push(id);
      }
    } else {
      chosen = [...cands].sort((a, b) => RANK[b.status] - RANK[a.status])[0];
      // An approval that disappears or drops without a human-attested record is a weakening.
      const older = [s.session.get(id), s.committed.get(id)].filter((x): x is Order => !!x);
      const newest = s.working.get(id);
      if (older.some((o) => o.status === 'approved') && newest?.status !== 'approved') weakened.push(id);
      // HEAD moved during the session (reset, amend, update-ref) and lost an approval it had.
      const committedNow = s.committed.get(id);
      if (sessionCommitted.includes(id) && committedNow?.status !== 'approved' && !weakened.includes(id))
        weakened.push(id);
    }
    if (chosen) orders.set(id, chosen);
  }
  return { orders, weakened };
}

export async function loadTrusted(input: {
  repoRoot: string;
  ordersDir: string;
  configFile: string;
  stateDir: string;
  attestedFile: string;
  env: NodeJS.ProcessEnv;
  sessionKey?: string | null;
}): Promise<TrustedState> {
  const { repoRoot } = input;
  const ordersRel = inside(repoRoot, input.ordersDir);
  const configRel = inside(repoRoot, input.configFile);
  const scope = [ordersRel, configRel].filter((x): x is string => !!x);

  // Repository health and HEAD (no git process).
  let gitBroken: string | null = null;
  let headSha: string | null = null;
  const head = readHead(repoRoot);
  if (head.state === 'broken') gitBroken = head.why;
  else if (head.state === 'unborn' && hasObjects(repoRoot))
    gitBroken = `HEAD points at ${head.ref}, which does not exist`;
  else if (head.state === 'ok') headSha = head.sha;

  // Committed blobs.
  let committed = new Map<string, string>();
  if (headSha && scope.length) {
    const r = await committedEntries(repoRoot, join(input.stateDir, 'cache'), headSha, scope);
    if (r.failed) gitBroken = 'git cannot read the committed tree (missing objects or a corrupt repository)';
    committed = r.entries;
  }

  // Working copies.
  const workingBufs = new Map<string, Buffer | null>();
  let names: string[] = [];
  try {
    names = readdirSync(input.ordersDir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {}
  for (const n of names) {
    try {
      workingBufs.set(n, readFileSync(join(input.ordersDir, n)));
    } catch {
      workingBufs.set(n, null);
    }
  }
  let configBuf: Buffer | null = null;
  try {
    configBuf = readFileSync(input.configFile);
  } catch {}

  const orderPath = (n: string) => `${ordersRel}/${n}`;
  const committedOrderNames = ordersRel
    ? [...committed.keys()]
        .filter(
          (p) =>
            p.startsWith(`${ordersRel}/`) &&
            p.endsWith('.json') &&
            !p.slice(ordersRel.length + 1).includes('/'),
        )
        .map((p) => p.slice(ordersRel.length + 1))
    : [];
  const need: string[] = [];
  for (const n of committedOrderNames) {
    const w = workingBufs.get(n);
    if (!w || gitBlobSha(w) !== committed.get(orderPath(n))) need.push(`HEAD:${orderPath(n)}`);
  }
  const configCommitted = configRel ? committed.get(configRel) : undefined;
  if (configRel && configCommitted && (!configBuf || gitBlobSha(configBuf) !== configCommitted))
    need.push(`HEAD:${configRel}`);
  let blobs = new Map<string, string | null>();
  if (need.length && !gitBroken) {
    try {
      blobs = await catBlobs(repoRoot, need);
    } catch {
      gitBroken = 'git cannot read committed objects';
    }
  }

  const working = new Map<string, Order>();
  const invalid: string[] = [];
  for (const n of names) {
    const w = workingBufs.get(n);
    const o = w ? parseOrder(w.toString('utf8')) : null;
    if (!o || `${o.id}.json` !== n) invalid.push(n);
    else working.set(o.id, o);
  }
  const committedOrders = new Map<string, Order>();
  const differs: string[] = [];
  for (const n of committedOrderNames) {
    const spec = `HEAD:${orderPath(n)}`;
    const id = n.replace(/\.json$/, '');
    if (blobs.has(spec)) {
      differs.push(id);
      const c = parseOrder(blobs.get(spec) ?? null);
      if (c && c.id === id) committedOrders.set(id, c);
    } else {
      const w = working.get(id);
      if (w) committedOrders.set(id, w); // identical blob
    }
  }

  const so = input.sessionKey ? readSessionOrders(input.stateDir, input.sessionKey) : null;
  const session = new Map<string, Order>(so?.orders ?? []);
  // Orders held by the open tamper flag stay enforced across sessions until `dnr tamper accept`.
  for (const raw of readTamper(input.stateDir)?.held ?? []) {
    const r = Order.safeParse(raw);
    if (r.success && !session.has(r.data.id)) session.set(r.data.id, r.data);
  }
  const attested = readAttested(input.attestedFile);
  const sources = { working, committed: committedOrders, session, attested };
  const { orders, weakened } = unionOrders(sources, so?.committedApproved ?? []);

  // Config: committed wins over a differing working copy; invalid → defaults.
  let configText = configBuf ? configBuf.toString('utf8') : null;
  let configIssue: string | null = null;
  if (configRel && blobs.has(`HEAD:${configRel}`)) {
    configIssue = configBuf
      ? 'the working copy of the config differs from the committed one; using the committed config'
      : 'the config file was removed from the working copy; using the committed config';
    configText = blobs.get(`HEAD:${configRel}`) ?? null;
  }
  const parsed = parseConfigText(configText);
  if (parsed.issue) configIssue = configIssue ? `${configIssue}; ${parsed.issue}` : parsed.issue;
  return {
    config: applyEnv(parsed.config, input.env),
    configIssue,
    orders,
    differs,
    invalid,
    weakened,
    gitBroken,
    headSha,
    sources,
  };
}

/** File → approved order ids, from the effective orders. Paths fold case when `fold` is set. */
export function coverageOf(orders: Map<string, Order>, fold: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const o of orders.values()) {
    if (o.status !== 'approved') continue;
    for (const f of new Set(o.units.map((u) => u.file))) {
      const k = fold ? f.toLowerCase() : f;
      out.set(k, [...(out.get(k) ?? []), o.id]);
    }
  }
  return out;
}

/** The persistent tamper flag (wave-3 N3): stays across sessions until `dnr tamper accept`. */
export interface TamperFlag {
  opened_at: string;
  findings: Array<{ at: string; what: string }>;
  /** The approved versions of weakened orders, kept enforced while the flag is open. */
  held?: unknown[];
}

export function readTamper(stateDir: string): TamperFlag | null {
  try {
    const j = JSON.parse(readFileSync(join(stateDir, 'tamper.json'), 'utf8')) as TamperFlag;
    return j && Array.isArray(j.findings) ? j : null;
  } catch {
    return null;
  }
}

/** Add findings to the flag (opening it when needed). Returns the findings that were new. */
export function openTamper(stateDir: string, whats: string[], at: string, held: Order[] = []): string[] {
  if (whats.length === 0) return [];
  const cur = readTamper(stateDir) ?? { opened_at: at, findings: [] };
  const fresh = whats.filter((w) => !cur.findings.some((f) => f.what === w));
  const heldNow = (cur.held ?? []) as Order[];
  const newHeld = held.filter((o) => o.status === 'approved' && !heldNow.some((h) => h.id === o.id));
  if (fresh.length === 0 && newHeld.length === 0) return [];
  cur.findings.push(...fresh.map((what) => ({ at, what })));
  cur.held = [...heldNow, ...newHeld];
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'tamper.json'), `${JSON.stringify(cur, null, 2)}\n`);
  } catch {}
  return fresh;
}
