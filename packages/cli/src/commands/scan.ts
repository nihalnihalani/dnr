/**
 * Product-mode `dnr scan` (§8): reuses the mining discovery engine (`scanPairs`, §9.1 steps 1–2)
 * with language globs instead of the trial E-rules, resolves each pair's changed units with the
 * engine, and writes `ScanCandidate[]` to `$DNR_STATE_DIR/candidates.json`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { extractUnitChanges } from '@dnr/core';
import { catBlobs, parents, scanPairs } from '@dnr/git';
import { loadParser } from '@dnr/hook';
import { ScanCandidate } from '@dnr/schemas';
import { z } from 'zod';
import { parse, str } from '../args';
import { repoContext } from '../context';
import { EXIT, usage } from '../errors';
import type { CliIO } from '../io';

const TICKET_RE = /#(\d{1,7})\b/g;

export async function cmdScan(argv: string[], io: CliIO): Promise<number> {
  const { values: v } = parse(argv, {
    branch: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    lang: { type: 'string' },
    'fetch-tickets': { type: 'string' },
    out: { type: 'string' },
  });
  if (v.help) {
    io.out(
      'dnr scan [--branch <name>] [--since <date>] [--until <date>] [--lang py,ts] [--fetch-tickets trac|github|none] [--out <file>]\n',
    );
    return EXIT.OK;
  }
  const langs = (str(v.lang) ?? 'py,ts').split(',').map((s) => s.trim());
  if (langs.some((l) => l !== 'py' && l !== 'ts')) throw usage('dnr scan: --lang takes py, ts or py,ts');
  const fetch = str(v['fetch-tickets']) ?? 'none';
  if (!['trac', 'github', 'none'].includes(fetch))
    throw usage('dnr scan: --fetch-tickets is trac, github or none');
  const ctx = await repoContext(io);
  const pairs = await scanPairs(ctx.repoRoot, {
    ...(v.branch ? { branch: str(v.branch) as string } : {}),
    ...(v.since ? { since: str(v.since) as string } : {}),
    ...(v.until ? { until: str(v.until) as string } : {}),
    langs: langs as Array<'py' | 'ts'>,
  });
  const parser = await loadParser();
  const out: ScanCandidate[] = [];
  for (const pair of pairs) {
    const C = pair.revert.original_sha as string;
    const [parent] = await parents(ctx.repoRoot, C);
    const specs = pair.files.flatMap((f) => [...(parent ? [`${parent}:${f}`] : []), `${C}:${f}`]);
    const blobs = await catBlobs(ctx.repoRoot, specs);
    const units: ScanCandidate['units'] = [];
    for (const f of pair.files) {
      const before = parent ? (blobs.get(`${parent}:${f}`) ?? null) : null;
      const after = blobs.get(`${C}:${f}`) ?? null;
      for (const u of extractUnitChanges(
        parser,
        { path: f, before, after },
        { testGlobs: ctx.config.test_globs },
      ))
        units.push({ file: u.file, qualname: u.qualname });
    }
    if (units.length === 0) continue;
    const tickets: string[] = [];
    for (const m of `${pair.revert.subject}\n${pair.revert.body}`.matchAll(TICKET_RE))
      if (!tickets.includes(m[1] as string)) tickets.push(m[1] as string);
    out.push({
      revert_sha: pair.revert.revert_sha,
      original_sha: C,
      subject: pair.revert.subject,
      committed_at: new Date(Date.parse(pair.revert.committed_at)).toISOString(),
      units,
      tickets,
    });
  }
  const valid = z.array(ScanCandidate).parse(out);
  const file = v.out ? resolve(io.cwd, str(v.out) as string) : ctx.store.paths.candidatesFile;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(valid, null, 2)}\n`);
  io.out(`DNR: ${valid.length} revert(s) that change a ${langs.join('/')} unit, written to ${file}.\n`);
  if (fetch !== 'none')
    io.err(
      `DNR: --fetch-tickets ${fetch}: ticket text is fetched by \`dnr draft\`; scan records ticket IDs only.\n`,
    );
  io.out(
    valid.length ? 'Next: dnr orders build\n' : 'Next: dnr orders add --original <sha> (no reverts found)\n',
  );
  return EXIT.OK;
}
