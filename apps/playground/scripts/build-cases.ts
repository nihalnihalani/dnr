/**
 * Dev-only CaseBundle generator for the Playground (plan §10, Phase 7).
 *
 * Stand-in for `dnr export-case` until the CLI ships it. It builds real orders from the Django
 * history with `@dnr/core` and writes `public/cases/<id>.json` plus `public/cases/index.json`.
 *
 *   pnpm -F @dnr/playground cases            # DJANGO_SRC or ../dnr-work/django
 *
 * Preset sources (P7-03), following 08-phases.md Phase 7:
 *   original-change      C itself
 *   held-out-paraphrase  testkit `extract-helper` mutant, seed 2000
 *   hard-negative        H template chosen by sha256("dnr-2026:hn:"+R) mod 3, applied to the post-revert unit
 *   half-of-two-file     the first of C's first two files only (omitted when C has < 2 files)
 *   formatting-only      C reformatted (`ruff format --line-length 60` / `biome format --line-width 60`)
 * The recorded-agent preset waits for demo/L (Phase 13).
 *
 * Differences from `dnr export-case`: the hard negative is generated here rather than read from
 * fixtures/hook-events/hardneg-<sha10>.json (not written yet), and the order reason is the revert
 * subject (reason_source "placeholder", as for every undrafted order).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blockMessage,
  buildOrder,
  createState,
  decide,
  grammarForPath,
  type ParserProvider,
  sha256Hex,
  UnitCache,
} from '@dnr/core';
import { loadGrammarsNode } from '@dnr/grammar/node';
import { CaseBundle, type Order } from '@dnr/schemas';
import { LINKS, mutate, SHA_C, SHA_R, TS_FIXTURE } from '@dnr/testkit';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/cases');
const repoRoot = resolve(here, '../../..');

type Preset = CaseBundle['presets'][number];
interface FileTriple {
  path: string;
  pre: string;
  c: string;
  baseline: string;
}
interface IndexEntry {
  id: string;
  title: string;
  order_id: string;
  grammars: string[];
  synthetic: boolean;
  source: { repo: string; license: string };
  notes: string[];
  /** The block the original change produces (shown in the home-page terminal). */
  demo: { path: string; edit: number | null; stderr: string } | null;
}

const DEMO_REVERTS = ['43933a1dca', 'd0e4dd5cdd'];

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function show(dir: string, rev: string, path: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'show', `${rev}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function formatPython(text: string): string {
  return execFileSync('ruff', ['format', '--line-length', '60', '--stdin-filename', 'x.py', '-'], {
    input: text,
    encoding: 'utf8',
  });
}
function formatTs(text: string, path: string): string {
  return execFileSync('pnpm', ['exec', 'biome', 'format', '--line-width=60', `--stdin-file-path=${path}`], {
    input: text,
    encoding: 'utf8',
    cwd: repoRoot,
  });
}

/** H templates (06-trial-protocol §H): 0 type hints, 1 docstring, 2 comment each branch. */
function hardNegative(text: string, qualname: string, template: number, grammar: string): string | null {
  const name = qualname.split('.').pop() ?? qualname;
  const lines = text.split('\n');
  const defRe =
    grammar === 'python'
      ? new RegExp(`^(\\s*)def ${name}\\(`)
      : new RegExp(`^(\\s*)(export )?(function )?${name}\\(`);
  const at = lines.findIndex((l) => defRe.test(l));
  if (at < 0) return null;
  const indent = (lines[at]?.match(/^\s*/)?.[0] ?? '') + (grammar === 'python' ? '    ' : '  ');
  // End of the signature (python: line ending with ':'; ts: line with '{').
  let sig = at;
  while (sig < lines.length && !(grammar === 'python' ? /\):\s*$/ : /\{\s*$/).test(lines[sig] ?? '')) sig++;
  if (sig >= lines.length) return null;
  const end = (() => {
    let i = sig + 1;
    while (i < lines.length && ((lines[i] ?? '').trim() === '' || (lines[i] ?? '').startsWith(indent))) i++;
    return i;
  })();
  if (template === 0) {
    if (grammar !== 'python') return null;
    const l = lines[sig] as string;
    if (l.includes('->')) return null;
    lines[sig] = l.replace(/\):\s*$/, ') -> None:');
  } else if (template === 1) {
    const body = lines[sig + 1] ?? '';
    if (grammar === 'python' && /^\s*"""/.test(body)) {
      // Extend the existing docstring with one more sentence.
      let close = sig + 1;
      while (close < end && !(lines[close] as string).trimEnd().endsWith('"""')) close++;
      lines.splice(close, 0, `${indent}Callers may rely on this being idempotent.`);
    } else if (grammar === 'python') {
      lines.splice(sig + 1, 0, `${indent}"""Callers may rely on this being idempotent."""`);
    } else {
      lines.splice(at, 0, `${indent.slice(2)}/** Callers may rely on this being idempotent. */`);
    }
  } else {
    let added = 0;
    for (let i = end - 1; i > sig; i--) {
      const l = lines[i] as string;
      if (/^\s*(if|elif|else)\b/.test(l)) {
        const ind = l.match(/^\s*/)?.[0] ?? '';
        lines.splice(i, 0, `${ind}${grammar === 'python' ? '#' : '//'} Branch: see the method docstring.`);
        added++;
      }
    }
    if (added === 0) return null;
  }
  return lines.join('\n');
}

function decideFirst(provider: ParserProvider, order: Order, files: FileTriple[], writes: Preset['writes']) {
  const cache = new UnitCache(provider);
  const base = Object.fromEntries(files.map((f) => [f.path, f.baseline]));
  const baseline = createState(base, cache);
  const w = writes[0];
  if (!w) return 'none';
  const proposed = createState({ ...base, [w.path]: w.proposed_text }, cache);
  const d = decide({ target: w.path, orders: [{ order }], baseline, current: baseline, proposed }).decision;
  return d.outcome;
}

function firstStderr(provider: ParserProvider, order: Order, files: FileTriple[], writes: Preset['writes']) {
  const cache = new UnitCache(provider);
  const base = Object.fromEntries(files.map((f) => [f.path, f.baseline]));
  const baseline = createState(base, cache);
  const w = writes[0];
  if (!w) return null;
  const proposed = createState({ ...base, [w.path]: w.proposed_text }, cache);
  const d = decide({ target: w.path, orders: [{ order }], baseline, current: baseline, proposed }).decision;
  if (d.outcome !== 'block') return null;
  const q = order.units.filter((u) => u.file === w.path).map((u) => u.qualname);
  return { path: w.path, edit: d.edit_score, stderr: blockMessage(order, d, { qualnames: q }) };
}

function makeBundle(
  provider: ParserProvider,
  opts: {
    id: string;
    title: string;
    R: string;
    C: string;
    at: string;
    files: FileTriple[];
    links: Order['links'];
    tickets: Order['tickets'];
    reason: string;
    source: { repo: string; license: string };
    synthetic: boolean;
  },
): { bundle: CaseBundle; entry: IndexEntry } {
  const notes: string[] = [];
  const built = buildOrder({
    provider,
    original_sha: opts.C,
    revert_sha: opts.R,
    snapshot_sha: opts.R,
    files: opts.files.map((f) => ({ path: f.path, before: f.pre, after: f.c, post_revert: f.baseline })),
    links: opts.links,
    tickets: opts.tickets,
    reason: opts.reason.slice(0, 280),
    reason_source: 'placeholder',
    status: 'draft',
    at: opts.at,
    by: 'playground-case-generator',
  });
  if (!built.ok) throw new Error(`${opts.id}: ${built.skip_reason}`);
  const order: Order = {
    ...built.order,
    status: 'approved',
    history: [...built.order.history, { at: opts.at, by: 'playground-case-generator', action: 'approved' }],
  };
  const orderFiles = new Set(order.units.map((u) => u.file));
  const files = opts.files.filter((f) => orderFiles.has(f.path));
  const presets: Preset[] = [];
  presets.push({
    id: 'original',
    label: 'Original change C',
    kind: 'original-change',
    writes: files.map((f) => ({ path: f.path, proposed_text: f.c })),
  });

  const paraphrase = mutate({
    provider,
    family: 'extract-helper',
    seed: 2000,
    revertSha: opts.R,
    files: files.map((f) => ({ path: f.path, text: f.c, baseline: f.baseline })),
    units: order.units.map((u) => ({ file: u.file, qualname: u.qualname })),
  });
  if (paraphrase?.sessions[0]?.length) {
    presets.push({
      id: 'paraphrase',
      label: 'Held-out paraphrase (extract-helper, seed 2000)',
      kind: 'held-out-paraphrase',
      writes: paraphrase.sessions[0]
        .filter((w) => w.text !== null)
        .map((w) => ({ path: w.path, proposed_text: w.text as string })),
    });
  } else notes.push('held-out-paraphrase omitted: extract-helper seed 2000 produced no valid mutant');

  const template = Number.parseInt(sha256Hex(`dnr-2026:hn:${opts.R}`).slice(-8), 16) % 3;
  const tname = ['add type hints', 'add a docstring', 'comment each branch'][template];
  let hn: Preset | null = null;
  for (const u of order.units.filter((x) => x.kind === 'modified')) {
    const f = files.find((x) => x.path === u.file);
    const g = grammarForPath(u.file);
    if (!f || !g) continue;
    const text = hardNegative(f.baseline, u.qualname, template, g);
    if (!text || text === f.baseline) continue;
    hn = {
      id: 'hard-negative',
      label: `Hard negative (${tname} to ${u.qualname})`,
      kind: 'hard-negative',
      writes: [{ path: f.path, proposed_text: text }],
    };
    break;
  }
  if (hn) presets.push(hn);
  else notes.push(`hard-negative omitted: template "${tname}" did not apply`);

  if (files.length >= 2) {
    const first = [...files].sort((a, b) => a.path.localeCompare(b.path))[0] as FileTriple;
    presets.push({
      id: 'half',
      label: `One half of a ${files.length}-file change (${first.path} only)`,
      kind: 'half-of-two-file',
      writes: [{ path: first.path, proposed_text: first.c }],
    });
  } else notes.push('half-of-two-file omitted: the order covers fewer than two files of C');

  try {
    presets.push({
      id: 'formatting',
      label: 'Formatting only (C reformatted at line length 60)',
      kind: 'formatting-only',
      writes: files.map((f) => ({
        path: f.path,
        proposed_text: grammarForPath(f.path) === 'python' ? formatPython(f.c) : formatTs(f.c, f.path),
      })),
    });
  } catch (e) {
    notes.push(`formatting-only omitted: formatter failed (${(e as Error).message.split('\n')[0]})`);
  }

  const bundle = CaseBundle.parse({
    schema: 'dnr.case/v1',
    id: opts.id,
    title: opts.title,
    order,
    files: files.map((f) => ({
      path: f.path,
      baseline_text: f.baseline,
      pre_change_text: f.pre,
      change_text: f.c,
    })),
    presets,
    source: opts.source,
  });
  for (const p of presets)
    notes.push(`${p.id}: first write decides ${decideFirst(provider, order, files, p.writes)}`);
  const grammars = [
    ...new Set(files.map((f) => grammarForPath(f.path)).filter((g): g is NonNullable<typeof g> => !!g)),
  ];
  return {
    bundle,
    entry: {
      id: opts.id,
      title: opts.title,
      order_id: order.id,
      grammars,
      synthetic: opts.synthetic,
      source: opts.source,
      notes,
      demo: firstStderr(provider, order, files, presets[0]?.writes ?? []),
    },
  };
}

function djangoCase(provider: ParserProvider, dir: string, short: string) {
  const R = git(dir, ['rev-parse', short]).trim();
  const body = git(dir, ['show', '-s', '--format=%B', R]);
  const subject = body.split('\n')[0] as string;
  const C = body.match(/This reverts commit ([0-9a-f]{40})/)?.[1];
  if (!C) throw new Error(`${short}: no "This reverts commit" line`);
  const at = git(dir, ['show', '-s', '--format=%cI', R]).trim();
  const paths = git(dir, ['diff', '--name-only', `${C}^`, C])
    .split('\n')
    .filter((p) => p && grammarForPath(p));
  const files: FileTriple[] = [];
  for (const p of paths) {
    const pre = show(dir, `${C}^`, p);
    const c = show(dir, C, p);
    const baseline = show(dir, R, p);
    if (pre === null || c === null || baseline === null) continue;
    files.push({ path: p, pre, c, baseline });
  }
  const tickets = [...new Set([...body.matchAll(/#(\d{4,6})/g)].map((m) => m[1] as string))].map((id) => ({
    system: 'trac' as const,
    id,
    url: `https://code.djangoproject.com/ticket/${id}`,
  }));
  const links: Order['links'] = [
    { rel: 'original', url: `https://github.com/django/django/commit/${C}` },
    { rel: 'revert', url: `https://github.com/django/django/commit/${R}` },
    ...tickets.map((t) => ({ rel: 'ticket' as const, url: t.url })),
  ];
  return makeBundle(provider, {
    id: short,
    title: subject,
    R,
    C,
    at,
    files,
    links,
    tickets,
    reason: subject,
    source: { repo: 'django/django', license: 'BSD-3-Clause' },
    synthetic: false,
  });
}

function tsCase(provider: ParserProvider) {
  return makeBundle(provider, {
    id: 'ts-pricing',
    title: 'Synthetic TypeScript case: discount rules in subtotal() (testkit fixture, not a real revert)',
    R: SHA_R,
    C: SHA_C,
    at: '2026-11-01T00:00:00Z',
    files: [
      { path: TS_FIXTURE.path, pre: TS_FIXTURE.before, c: TS_FIXTURE.after, baseline: TS_FIXTURE.before },
    ],
    links: LINKS as Order['links'],
    tickets: [],
    reason: 'Synthetic example: the bulk discount double-counted quantities, so it was reverted.',
    source: { repo: 'dnr (synthetic testkit fixture)', license: 'MIT' },
    synthetic: true,
  });
}

/**
 * Graveyard specimens: real Django reverts from fixtures/known-reverts.json, built into real
 * orders, then given an ILLUSTRATIVE state (draft, retired, stale, re-landed, drift) so every
 * headstone state is visible in the Playground. The UI labels these rows "illustrative state".
 */
function specimens(provider: ParserProvider, dir: string) {
  const known = JSON.parse(readFileSync(join(repoRoot, 'fixtures/known-reverts.json'), 'utf8')) as Array<{
    sha: string;
    subject: string;
  }>;
  const wanted: Array<{ effective: string; status: Order['status']; drift: boolean }> = [
    { effective: 'draft', status: 'draft', drift: false },
    { effective: 'stale', status: 'approved', drift: false },
    { effective: 'relanded', status: 'approved', drift: false },
    { effective: 'retired', status: 'retired', drift: false },
    { effective: 'approved', status: 'approved', drift: true },
  ];
  const rows: unknown[] = [];
  for (const k of known) {
    if (rows.length >= wanted.length) break;
    if (DEMO_REVERTS.some((d) => k.sha.startsWith(d))) continue;
    try {
      const body = git(dir, ['show', '-s', '--format=%B', k.sha]);
      const C = body.match(/This reverts commit ([0-9a-f]{40})/)?.[1];
      if (!C) continue;
      const at = git(dir, ['show', '-s', '--format=%cI', k.sha]).trim();
      const paths = git(dir, ['diff', '--name-only', `${C}^`, C])
        .split('\n')
        .filter((p) => p && grammarForPath(p));
      const files = paths.flatMap((p) => {
        const before = show(dir, `${C}^`, p);
        const after = show(dir, C, p);
        const post = show(dir, k.sha, p);
        return before === null || after === null ? [] : [{ path: p, before, after, post_revert: post }];
      });
      const tickets = [...new Set([...body.matchAll(/#(\d{4,6})/g)].map((m) => m[1] as string))].map(
        (id) => ({
          system: 'trac' as const,
          id,
          url: `https://code.djangoproject.com/ticket/${id}`,
        }),
      );
      const built = buildOrder({
        provider,
        original_sha: C,
        revert_sha: k.sha,
        snapshot_sha: k.sha,
        files,
        links: [
          { rel: 'original', url: `https://github.com/django/django/commit/${C}` },
          { rel: 'revert', url: `https://github.com/django/django/commit/${k.sha}` },
          ...tickets.map((t) => ({ rel: 'ticket' as const, url: t.url })),
        ],
        tickets,
        reason: k.subject.slice(0, 280),
        reason_source: 'placeholder',
        status: 'draft',
        at,
        by: 'playground-case-generator',
      });
      if (!built.ok) continue;
      const w = wanted[rows.length] as (typeof wanted)[number];
      const history = [...built.order.history];
      if (w.status !== 'draft') history.push({ at, by: 'playground-case-generator', action: 'approved' });
      if (w.status === 'retired') history.push({ at, by: 'playground-case-generator', action: 'retired' });
      const order = { ...built.order, status: w.status, history };
      rows.push({ order, effective: w.effective, drift: w.drift, illustrative: true });
    } catch {}
  }
  return rows;
}

/**
 * Prefer the real `dnr export-case` output when it exists (DNR_EXPORT_DIR or the CLI's committed
 * demo templates). The demo order ships approved in the Playground, so it is enforced; that
 * approval is recorded in its history. If export-case omitted the held-out paraphrase only
 * because fixtures/mutations is not generated yet, it is filled from the same source (testkit
 * extract-helper, seed 2000) and labeled so.
 */
function fromExport(
  provider: ParserProvider,
  short: string,
): { bundle: CaseBundle; entry: IndexEntry } | null {
  const dirs = [process.env.DNR_EXPORT_DIR, join(repoRoot, 'packages/cli/templates/demo')].filter(
    (d): d is string => !!d,
  );
  const file = dirs.map((d) => join(d, `${short}.case.json`)).find((f) => existsSync(f));
  if (!file) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as CaseBundle & {
    omitted_presets?: Array<{ kind: string; reason: string }>;
  };
  const exported = CaseBundle.parse(raw);
  const at = exported.order.created_at;
  const order: Order =
    exported.order.status === 'approved'
      ? exported.order
      : {
          ...exported.order,
          status: 'approved',
          history: [...exported.order.history, { at, by: 'playground-case-generator', action: 'approved' }],
        };
  const files: FileTriple[] = exported.files.map((f) => ({
    path: f.path,
    pre: f.pre_change_text,
    c: f.change_text,
    baseline: f.baseline_text,
  }));
  const notes = [
    `source: dnr export-case (${file.startsWith(repoRoot) ? relative(repoRoot, file) : basename(file)})`,
  ];
  const presets = [...exported.presets];
  for (const o of raw.omitted_presets ?? []) {
    if (o.kind === 'held-out-paraphrase') {
      const m = mutate({
        provider,
        family: 'extract-helper',
        seed: 2000,
        revertSha: order.revert_sha ?? order.original_sha,
        files: files.map((f) => ({ path: f.path, text: f.c, baseline: f.baseline })),
        units: order.units.map((u) => ({ file: u.file, qualname: u.qualname })),
      });
      const writes = (m?.sessions[0] ?? [])
        .filter((w) => w.text !== null)
        .map((w) => ({ path: w.path, proposed_text: w.text as string }));
      if (writes.length) {
        presets.splice(1, 0, {
          id: 'held-out-paraphrase',
          label: 'Held-out paraphrase (extract-helper, seed 2000; generated here)',
          kind: 'held-out-paraphrase',
          writes,
        });
        notes.push(
          'held-out-paraphrase: generated with testkit extract-helper seed 2000 (export-case had no fixture)',
        );
        continue;
      }
    }
    notes.push(`${o.kind} omitted: ${o.reason}`);
  }
  const bundle = CaseBundle.parse({ ...exported, order, presets });
  for (const p of presets)
    notes.push(`${p.id}: first write decides ${decideFirst(provider, order, files, p.writes)}`);
  const grammars = [
    ...new Set(files.map((f) => grammarForPath(f.path)).filter((g): g is NonNullable<typeof g> => !!g)),
  ];
  return {
    bundle,
    entry: {
      id: bundle.id,
      title: bundle.title.replace(/^dnr-[0-9a-f]{10}: /, ''),
      order_id: order.id,
      grammars,
      synthetic: false,
      source: bundle.source,
      notes,
      demo: firstStderr(provider, order, files, presets[0]?.writes ?? []),
    },
  };
}

async function main() {
  const provider = await loadGrammarsNode();
  mkdirSync(outDir, { recursive: true });
  const index: IndexEntry[] = [];
  const dj = process.env.DJANGO_SRC ?? resolve(repoRoot, '../dnr-work/django');
  if (existsSync(join(dj, '.git'))) {
    for (const short of DEMO_REVERTS) {
      const { bundle, entry } = fromExport(provider, short) ?? djangoCase(provider, dj, short);
      writeFileSync(join(outDir, `${bundle.id}.json`), `${JSON.stringify(bundle)}\n`);
      index.push(entry);
      console.log(`${bundle.id}: ${bundle.order.units.length} units, ${bundle.presets.length} presets`);
      for (const n of entry.notes) console.log(`  ${n}`);
    }
    const caseRows = index.map((e) => {
      const b = JSON.parse(readFileSync(join(outDir, `${e.id}.json`), 'utf8')) as CaseBundle;
      return { order: b.order, effective: b.order.status, drift: false, case_id: e.id };
    });
    const rows = [...caseRows, ...specimens(provider, dj)];
    writeFileSync(join(outDir, 'graveyard.json'), `${JSON.stringify({ rows })}\n`);
    console.log(`graveyard specimens: ${rows.length}`);
  } else console.warn(`Django checkout not found at ${dj}; only the synthetic case is built`);
  const ts = tsCase(provider);
  writeFileSync(join(outDir, `${ts.bundle.id}.json`), `${JSON.stringify(ts.bundle)}\n`);
  index.push(ts.entry);
  for (const n of ts.entry.notes) console.log(`  ${n}`);
  writeFileSync(
    join(outDir, 'index.json'),
    `${JSON.stringify({ generator: 'apps/playground/scripts/build-cases.ts', cases: index }, null, 2)}\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
