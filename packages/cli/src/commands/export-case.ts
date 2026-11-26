/**
 * `dnr export-case <revert> [--orders <dir>] [--git-dir <path>] [--out <file>]` (§8, Phase 7):
 * writes a Playground `CaseBundle`. Texts come from git; presets come from their defined sources:
 *  - original-change: C's text for every order file;
 *  - held-out-paraphrase: `fixtures/mutations/<sha10>/extract-helper/2000` (omitted until it exists);
 *  - hard-negative: `fixtures/hook-events/hardneg-<sha10>.json`, applied to the baseline;
 *  - half-of-two-file: C's text for the first order file only (omitted when the order has one file);
 *  - formatting-only: the baseline reformatted (`ruff format` / `biome format` when installed;
 *    otherwise blank-line and comment changes), which changes no token.
 * Omitted presets are listed in `omitted_presets` with the reason.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { applyTool, grammarForPath } from '@dnr/core';
import { catBlobs, parents, resolveCommit } from '@dnr/git';
import { filesOf, parseHookEvent } from '@dnr/hook';
import { CaseBundle } from '@dnr/schemas';
import { parse, str } from '../args';
import { repoContext } from '../context';
import { EXIT, invalidData, usage } from '../errors';
import type { CliIO } from '../io';

type Preset = CaseBundle['presets'][number];

/** Reformat without changing tokens: ruff/biome when present, else blank lines + a comment. */
export function formatOnly(path: string, text: string): string {
  const g = grammarForPath(path);
  try {
    if (g === 'python')
      return execFileSync('ruff', ['format', '--stdin-filename', path, '-'], {
        input: text,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    if (g)
      return execFileSync('biome', ['format', `--stdin-file-path=${path}`], {
        input: text,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
  } catch {}
  const comment = g === 'python' ? '# formatting-only edit' : '// formatting-only edit';
  const lines = text.split('\n');
  const i = Math.max(
    0,
    lines.findIndex((l) => /^(def |class |function |export )/.test(l)),
  );
  lines.splice(i, 0, comment, '');
  return lines.join('\n');
}

export async function cmdExportCase(argv: string[], io: CliIO): Promise<number> {
  const { values: v, positionals } = parse(argv, {
    orders: { type: 'string' },
    'git-dir': { type: 'string' },
    out: { type: 'string' },
    title: { type: 'string' },
  });
  if (v.help) {
    io.out(
      'dnr export-case <revert> [--orders <dir>] [--git-dir <path>] [--out apps/playground/public/cases/<id>.json]\n',
    );
    return EXIT.OK;
  }
  const rev = positionals[0];
  if (!rev) throw usage('dnr export-case <revert>');
  const ctx = await repoContext(io, v.orders ? { orders: resolve(io.cwd, str(v.orders) as string) } : {});
  const gitDir = v['git-dir'] ? resolve(io.cwd, str(v['git-dir']) as string) : ctx.repoRoot;
  const all = await ctx.store.orders.list();
  const order = all.find(
    (o) => o.id === `dnr-${rev.slice(0, 10)}` || (o.revert_sha ?? '').startsWith(rev) || o.id === rev,
  );
  if (!order) throw usage(`DNR: no order for ${rev} in ${ctx.store.paths.ordersDir}`);
  const C = (await resolveCommit(gitDir, order.original_sha)) ?? order.original_sha;
  const [Cp] = await parents(gitDir, C);
  const files = filesOf(order);
  const blobs = await catBlobs(
    gitDir,
    files.flatMap((f) => [`${order.snapshot_sha}:${f}`, `${C}:${f}`, ...(Cp ? [`${Cp}:${f}`] : [])]),
  );
  const texts = files.map((path) => ({
    path,
    baseline_text: blobs.get(`${order.snapshot_sha}:${path}`) ?? '',
    pre_change_text: (Cp ? blobs.get(`${Cp}:${path}`) : '') ?? '',
    change_text: blobs.get(`${C}:${path}`) ?? '',
  }));
  const sha10 = (order.revert_sha ?? order.original_sha).slice(0, 10);
  const presets: Preset[] = [];
  const omitted: Array<{ kind: Preset['kind']; reason: string }> = [];
  presets.push({
    id: 'original-change',
    label: 'Original change C',
    kind: 'original-change',
    writes: texts.map((t) => ({ path: t.path, proposed_text: t.change_text })),
  });

  const mut = join(ctx.repoRoot, 'fixtures', 'mutations', sha10, 'extract-helper', '2000');
  const mutFile = [mut, `${mut}.json`].find((p) => existsSync(p));
  if (mutFile) {
    const writes: Preset['writes'] = [];
    if (statSync(mutFile).isDirectory()) {
      for (const t of texts)
        if (existsSync(join(mutFile, t.path)))
          writes.push({ path: t.path, proposed_text: readFileSync(join(mutFile, t.path), 'utf8') });
    } else {
      const j = JSON.parse(readFileSync(mutFile, 'utf8'));
      for (const w of j.writes ?? j.files ?? [])
        writes.push({ path: w.path, proposed_text: w.proposed_text ?? w.text ?? w.content });
    }
    presets.push({
      id: 'held-out-paraphrase',
      label: 'Held-out paraphrase (extract-helper, seed 2000)',
      kind: 'held-out-paraphrase',
      writes,
    });
  } else
    omitted.push({
      kind: 'held-out-paraphrase',
      reason: `fixtures/mutations/${sha10}/extract-helper/2000 does not exist yet`,
    });

  const hn = join(ctx.repoRoot, 'fixtures', 'hook-events', `hardneg-${sha10}.json`);
  if (existsSync(hn)) {
    const ev = parseHookEvent(readFileSync(hn, 'utf8'), ctx.repoRoot);
    const base = (p: string) => texts.find((t) => t.path === p)?.baseline_text ?? null;
    const eff = applyTool(ev.tool_name ?? '', ev.tool_input, base);
    if (eff.kind === 'write' && eff.text !== null)
      presets.push({
        id: 'hard-negative',
        label: 'Hard negative (a legitimate edit to the same code)',
        kind: 'hard-negative',
        writes: [{ path: eff.path, proposed_text: eff.text }],
      });
    else omitted.push({ kind: 'hard-negative', reason: `${hn} does not produce a write (${eff.kind})` });
  } else
    omitted.push({
      kind: 'hard-negative',
      reason: `fixtures/hook-events/hardneg-${sha10}.json does not exist yet`,
    });

  if (texts.length >= 2) {
    const t = texts[0] as (typeof texts)[number];
    presets.push({
      id: 'half-of-two-file',
      label: `One half of a two-file change (${t.path} only)`,
      kind: 'half-of-two-file',
      writes: [{ path: t.path, proposed_text: t.change_text }],
    });
  } else omitted.push({ kind: 'half-of-two-file', reason: 'the order covers one file (c_file_count < 2)' });

  presets.push({
    id: 'formatting-only',
    label: 'Formatting only',
    kind: 'formatting-only',
    writes: texts.map((t) => ({ path: t.path, proposed_text: formatOnly(t.path, t.baseline_text) })),
  });

  const bundle = {
    schema: 'dnr.case/v1' as const,
    id: sha10,
    title: str(v.title) ?? `${order.id}: ${order.reason.slice(0, 120)}`,
    order,
    files: texts,
    presets,
    source: /django/.test(order.links.map((l) => l.url).join(' '))
      ? { repo: 'django/django', license: 'BSD-3-Clause' }
      : { repo: 'unknown', license: 'see NOTICE' },
    omitted_presets: omitted,
  };
  const r = CaseBundle.safeParse(bundle);
  if (!r.success)
    throw invalidData(`DNR: the bundle is not a valid CaseBundle: ${r.error.issues[0]?.message}`);
  const out = v.out
    ? resolve(io.cwd, str(v.out) as string)
    : join(ctx.repoRoot, 'apps', 'playground', 'public', 'cases', `${sha10}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`);
  io.out(
    `DNR: wrote ${out} (${presets.length} preset(s)${omitted.length ? `; omitted: ${omitted.map((o) => o.kind).join(', ')}` : ''})\n`,
  );
  return EXIT.OK;
}

void readdirSync;
