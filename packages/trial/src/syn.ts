/**
 * §9.10 SYN cohort: cases written by the named SYN author (`fixtures/syn/cases.json`), the fork
 * clone at `$TRIAL_ROOT/syn-src` with its ancestry check, the ticket loader, and the automatic
 * labels (FULL: the author's restored test passes on the agent's tree; CORE: the critical edit's
 * weight-1 token sequence appears contiguously in the target unit on the named side).
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractUnits, type ParserProvider, tokenWeight } from '@dnr/core';
import { git, runGit } from '@dnr/git';
import { SynCase } from '@dnr/schemas';
import { z } from 'zod';
import { sha10 } from './arms';

export type SynCaseT = z.infer<typeof SynCase>;

export function loadSynCases(root: string, file = join(root, 'fixtures/syn/cases.json')): SynCaseT[] {
  return existsSync(file) ? z.array(SynCase).parse(JSON.parse(readFileSync(file, 'utf8'))) : [];
}

/** The loader writes each case's fabricated ticket to `fixtures/discussion/<sha10>.json` (labelers and drafter only). */
export async function writeSynTickets(root: string, cases: readonly SynCaseT[]): Promise<string[]> {
  const dir = join(root, 'fixtures/discussion');
  await mkdir(dir, { recursive: true });
  const out: string[] = [];
  for (const c of cases) {
    const p = join(dir, `${sha10(c.revert_sha)}.json`);
    await writeFile(p, `${JSON.stringify([c.ticket], null, 2)}\n`);
    out.push(p);
  }
  return out;
}

/**
 * Step 1 of §9.10: `git clone "$(git -C "$DJANGO_SRC" remote get-url syn)" "$TRIAL_ROOT/syn-src"`,
 * then `merge-base --is-ancestor <syn_fork_base> HEAD`. `url` overrides the remote lookup (tests).
 */
export async function cloneSynSrc(input: {
  djangoSrc: string | null;
  dest: string;
  forkBase: string;
  url?: string;
}): Promise<{ ok: boolean; note: string }> {
  let url = input.url;
  if (!url) {
    if (!input.djangoSrc) return { ok: false, note: 'DJANGO_SRC is not available' };
    const r = await runGit(['remote', 'get-url', 'syn'], { cwd: input.djangoSrc, okCodes: [0, 2, 128] });
    if (r.code !== 0)
      return {
        ok: false,
        note: 'no `syn` remote in $DJANGO_SRC (Phase 0: the SYN author pushes django-syn)',
      };
    url = r.stdout.trim();
  }
  if (!existsSync(join(input.dest, '.git')))
    await git(['clone', '-q', url, input.dest], { cwd: join(input.dest, '..') });
  else await git(['fetch', '-q', 'origin'], { cwd: input.dest });
  const anc = await runGit(['merge-base', '--is-ancestor', input.forkBase, 'HEAD'], {
    cwd: input.dest,
    okCodes: [0, 1, 128],
  });
  return anc.code === 0
    ? {
        ok: true,
        note: `syn-src at ${(await git(['rev-parse', 'HEAD'], { cwd: input.dest })).trim().slice(0, 10)}, fork base is an ancestor`,
      }
    : { ok: false, note: `syn_fork_base ${input.forkBase} is not an ancestor of syn-src HEAD` };
}

/** Weight-1 token keys of a unit (weight-0 tokens dropped). */
export function unitKeys(
  p: ParserProvider,
  path: string,
  text: string | null,
  qualname: string,
): string[] | null {
  if (text === null) return null;
  const fu = extractUnits(p, path, text);
  const u = fu?.units.get(qualname);
  if (!fu || !u) return null;
  return u.tokens.filter((k) => tokenWeight(k, fu.grammar) === 1);
}

export function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Automatic SYN label. FULL when the restored test passes on the agent's tree. CORE when, after
 * weight-0 tokens are dropped, the critical edit's sequence is contiguous in the target unit of
 * the agent's tree and was not there at the start (side `added`), or, for side `removed`, was
 * there at the start and is absent from the agent's tree. Otherwise null (human label applies).
 */
export function synAutoLabel(input: {
  provider: ParserProvider;
  critical: SynCaseT['critical_edit'];
  restoredTests: 'pass' | 'fail' | 'n/a' | 'could-not-run';
  startText: string | null;
  finalText: string | null;
  grammarOf?: (path: string) => 'python' | 'typescript' | 'tsx' | null;
}): 'FULL' | 'CORE' | null {
  if (input.restoredTests === 'pass') return 'FULL';
  const ce = input.critical;
  const g = input.grammarOf?.(ce.file) ?? 'python';
  const needle = ce.tokens.filter((k) => tokenWeight(k, g) === 1);
  const start = unitKeys(input.provider, ce.file, input.startText, ce.qualname) ?? [];
  const fin = unitKeys(input.provider, ce.file, input.finalText, ce.qualname);
  if (ce.side === 'added')
    return fin && containsRun(fin, needle) && !containsRun(start, needle) ? 'CORE' : null;
  return containsRun(start, needle) && !(fin && containsRun(fin, needle)) ? 'CORE' : null;
}
