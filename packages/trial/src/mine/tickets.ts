/**
 * `dnr trial tickets` (§9.1 step 5). Ticket text is untrusted: it is stored for labelers and the
 * drafter only and never shown to a trial agent.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Discussion, DiscussionFile } from '@dnr/schemas';

export const USER_AGENT = 'dnr-trial/0.1';
export const MIN_INTERVAL_MS = 2000;

export type FetchText = (url: string) => Promise<{ status: number; text: string }>;
export type Sleep = (ms: number) => Promise<void>;
export type GhApi = (path: string) => Promise<unknown>;

export const defaultFetch: FetchText = async (url) => {
  const r = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv, application/rss+xml, */*' },
  });
  return { status: r.status, text: await r.text() };
};

export const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const defaultGh: GhApi = (path) =>
  new Promise((resolve, reject) => {
    execFile('gh', ['api', path], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(JSON.parse(String(stdout)));
    });
  });

/** Polite client: at least MIN_INTERVAL_MS between requests, exponential backoff on 429/5xx/network errors. */
export class PoliteFetcher {
  private last = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly fetchText: FetchText = defaultFetch,
    private readonly sleep: Sleep = defaultSleep,
    private readonly now: () => number = Date.now,
    private readonly maxRetries = 4,
  ) {}

  async get(url: string): Promise<{ status: number; text: string }> {
    let delay = MIN_INTERVAL_MS;
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + MIN_INTERVAL_MS - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      try {
        const r = await this.fetchText(url);
        if ((r.status === 429 || r.status >= 500) && attempt < this.maxRetries) {
          delay *= 2;
          await this.sleep(delay);
          continue;
        }
        return r;
      } catch (e) {
        if (attempt >= this.maxRetries) throw e;
        delay *= 2;
        await this.sleep(delay);
      }
    }
  }
}

/** Minimal RFC 4180 parser (quoted fields may contain commas, quotes and newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Trac ticket RSS: one comment per <item>. */
export function parseTracRss(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1] as string;
    const title = decodeEntities(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? '').trim();
    const author = decodeEntities(/<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(item)?.[1] ?? '').trim();
    const desc = stripHtml(decodeEntities(/<description>([\s\S]*?)<\/description>/.exec(item)?.[1] ?? ''));
    out.push([author && `${author}:`, title, desc].filter(Boolean).join(' ').trim());
  }
  return out;
}

export async function fetchTracTicket(f: PoliteFetcher, n: string, at: string): Promise<Discussion | null> {
  const base = `https://code.djangoproject.com/ticket/${n}`;
  const csv = await f.get(`${base}?format=csv`);
  if (csv.status !== 200) return null;
  const rows = parseCsv(csv.text);
  const header = rows[0] ?? [];
  const row = rows[1] ?? [];
  const col = (name: string) => row[header.indexOf(name)] ?? '';
  const rss = await f.get(`${base}?format=rss`);
  return {
    ticket: `#${n}`,
    source: 'trac',
    title: col('summary'),
    body: col('description'),
    comments: rss.status === 200 ? parseTracRss(rss.text) : [],
    fetched_at: at,
  };
}

interface GhPull {
  number: number;
  title: string;
  body: string | null;
}

export async function fetchPrs(gh: GhApi, repoSlug: string, sha: string, at: string): Promise<Discussion[]> {
  const pulls = (await gh(`repos/${repoSlug}/commits/${sha}/pulls`)) as GhPull[];
  return pulls.map((p) => ({
    ticket: `PR#${p.number}`,
    source: 'github',
    title: p.title,
    body: p.body ?? '',
    comments: [],
    fetched_at: at,
  }));
}

export interface TicketJob {
  revert_sha: string;
  original_sha: string | null;
  tickets: string[];
}

/** Fetches and writes `<outDir>/<sha10>.json` for each job. Existing files are kept unless `refresh`. */
export async function fetchDiscussions(
  jobs: readonly TicketJob[],
  opts: {
    outDir: string;
    repoSlug: string;
    fetcher?: PoliteFetcher;
    gh?: GhApi;
    sleep?: Sleep;
    refresh?: boolean;
    now?: () => Date;
    onProgress?: (m: string) => void;
  },
): Promise<{ written: string[]; skipped: string[] }> {
  const f = opts.fetcher ?? new PoliteFetcher();
  const gh = opts.gh ?? defaultGh;
  const sleep = opts.sleep ?? defaultSleep;
  await mkdir(opts.outDir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];
  for (const j of jobs) {
    const path = join(opts.outDir, `${j.revert_sha.slice(0, 10)}.json`);
    if (!opts.refresh && existsSync(path)) {
      DiscussionFile.parse(JSON.parse(await readFile(path, 'utf8')));
      skipped.push(path);
      continue;
    }
    const at = (opts.now?.() ?? new Date()).toISOString();
    const items: Discussion[] = [];
    for (const t of j.tickets) {
      const d = await fetchTracTicket(f, t, at);
      if (d) items.push(d);
    }
    const seen = new Set<string>();
    for (const sha of [j.revert_sha, j.original_sha]) {
      if (!sha) continue;
      await sleep(MIN_INTERVAL_MS);
      for (const d of await fetchPrs(gh, opts.repoSlug, sha, at)) {
        if (!seen.has(d.ticket)) {
          seen.add(d.ticket);
          items.push(d);
        }
      }
    }
    await writeFile(path, `${JSON.stringify(DiscussionFile.parse(items), null, 2)}\n`);
    written.push(path);
    opts.onProgress?.(`${path}: ${items.length} item(s)`);
  }
  return { written, skipped };
}
