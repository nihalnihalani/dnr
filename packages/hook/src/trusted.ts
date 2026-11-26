/**
 * Trusted DNR state (wave-2 review C1, lead decision amending plan R7): an agent can write
 * `.dnr/` with any shell interpreter, so invalid or edited state must never switch DNR off.
 *
 * - Orders and config are read from the committed tree (HEAD) whenever the working copy's copy
 *   differs from it or fails to parse. Working-copy-only orders (built or approved but not yet
 *   committed) are used as they are: they can only add enforcement.
 * - An invalid config, or `mode: "record"` in a file (record comes only from `DNR_MODE`, §7),
 *   falls back to the §7 defaults and is reported as `configIssue` (Stop reports it as tamper).
 * - Nothing here is cached on disk, so there is no cache an agent could forge.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { catBlobs, committedStateArgs, memoGit } from '@dnr/git';
import { DnrConfig, Order } from '@dnr/schemas';

export interface TrustedState {
  config: DnrConfig;
  /** Why the config on disk was not used as written (null when it was). */
  configIssue: string | null;
  /** Effective orders by id. */
  orders: Map<string, Order>;
  /** Ids whose working copy differs from HEAD (the committed version is used). */
  differs: string[];
  /** Order files that do not validate in the working copy. */
  invalid: string[];
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

export async function loadTrusted(input: {
  repoRoot: string;
  ordersDir: string;
  configFile: string;
  env: NodeJS.ProcessEnv;
}): Promise<TrustedState> {
  const { repoRoot } = input;
  const ordersRel = inside(repoRoot, input.ordersDir);
  const configRel = inside(repoRoot, input.configFile);

  // Committed blobs (one `git ls-tree`; an unborn HEAD lists nothing).
  const committed = new Map<string, string>();
  const scope = [ordersRel, configRel].filter((x): x is string => !!x);
  if (scope.length) {
    const r = await memoGit(repoRoot, committedStateArgs(scope), [0, 128]);
    if (r.code === 0)
      for (const rec of r.stdout.split('\0')) {
        const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(rec);
        if (m) committed.set(m[2] as string, m[1] as string);
      }
  }

  // Working copies.
  const working = new Map<string, Buffer | null>();
  let names: string[] = [];
  try {
    names = readdirSync(input.ordersDir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {}
  for (const n of names) {
    try {
      working.set(n, readFileSync(`${input.ordersDir}/${n}`));
    } catch {
      working.set(n, null);
    }
  }
  let configBuf: Buffer | null = null;
  try {
    configBuf = readFileSync(input.configFile);
  } catch {}

  // Which committed files differ from the working copy (and so need their committed text).
  const need: string[] = [];
  const orderPath = (n: string) => (ordersRel ? `${ordersRel}/${n}` : null);
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
  for (const n of committedOrderNames) {
    const w = working.get(n);
    if (!w || gitBlobSha(w) !== committed.get(orderPath(n) as string)) need.push(`HEAD:${orderPath(n)}`);
  }
  const configCommitted = configRel ? committed.get(configRel) : undefined;
  if (configRel && configCommitted && (!configBuf || gitBlobSha(configBuf) !== configCommitted))
    need.push(`HEAD:${configRel}`);
  const blobs = need.length ? await catBlobs(repoRoot, need) : new Map<string, string | null>();

  // Effective orders.
  const orders = new Map<string, Order>();
  const differs: string[] = [];
  const invalid: string[] = [];
  const all = new Set([...names, ...committedOrderNames]);
  for (const n of [...all].sort()) {
    const spec = ordersRel ? `HEAD:${ordersRel}/${n}` : '';
    const w = working.get(n);
    const wOrder = w ? parseOrder(w.toString('utf8')) : null;
    if (w && !wOrder) invalid.push(n);
    if (blobs.has(spec)) {
      const c = parseOrder(blobs.get(spec) ?? null);
      differs.push(n.replace(/\.json$/, ''));
      const use = c ?? wOrder;
      if (use && `${use.id}.json` === n) orders.set(use.id, use);
    } else if (wOrder && `${wOrder.id}.json` === n) orders.set(wOrder.id, wOrder);
  }

  // Effective config.
  let configText = configBuf ? configBuf.toString('utf8') : null;
  let configIssue: string | null = null;
  if (configRel && blobs.has(`HEAD:${configRel}`)) {
    const committedText = blobs.get(`HEAD:${configRel}`) ?? null;
    configIssue = configBuf
      ? 'the working copy of the config differs from the committed one; using the committed config'
      : 'the config file was removed from the working copy; using the committed config';
    configText = committedText;
  }
  const parsed = parseConfigText(configText);
  if (parsed.issue) configIssue = configIssue ? `${configIssue}; ${parsed.issue}` : parsed.issue;
  return { config: applyEnv(parsed.config, input.env), configIssue, orders, differs, invalid };
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
