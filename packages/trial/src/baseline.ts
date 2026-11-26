/**
 * `dnr trial baseline --generate|--score` (§9.12). `--generate` writes one ast-grep rule file per
 * order into `scripts/baseline/rules/` with a manifest of sha256s (rules and gen.ts). `--score`
 * runs the hashed rules over a corpus and counts a match only when it overlaps lines changed
 * relative to the corpus item's start (`start_sha`, or `X^` for commits).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { changedLines } from '@dnr/core';
import { readBlob } from '@dnr/git';
import { loadParser } from '@dnr/hook';
import type { Order } from '@dnr/schemas';
import { GEN_VERSION, generateRule } from './baseline-gen';
import { sha256Hex } from './prng';

export interface BaselineManifest {
  gen_version: number;
  gen_sha256: string;
  rules: Array<{
    order_id: string;
    file: string | null;
    sha256: string | null;
    patterns: number;
    na_removal_only: boolean;
  }>;
}

/** sha256 over the generator's two files: the entry point and the rule logic. */
export function genHash(root: string): string {
  return sha256Hex(
    ['scripts/baseline/gen.ts', 'packages/trial/src/baseline-gen.ts']
      .map((f) => sha256Hex(readFileSync(join(root, f))))
      .join('\n'),
  );
}

export async function generateRules(input: {
  root: string;
  orders: readonly Order[];
  gitDirs: readonly string[];
  outDir: string;
}): Promise<BaselineManifest> {
  const provider = await loadParser();
  const textAt = async (sha: string, file: string) => {
    for (const g of input.gitDirs) {
      const t = await readBlob(g, sha, file).catch(() => null);
      if (t !== null) return t;
    }
    return null;
  };
  await mkdir(input.outDir, { recursive: true });
  const rules: BaselineManifest['rules'] = [];
  for (const o of [...input.orders].sort((a, b) => a.id.localeCompare(b.id))) {
    const r = await generateRule(provider, o, textAt);
    if (r.yaml) {
      const f = join(input.outDir, `${o.id}.yml`);
      await writeFile(f, r.yaml);
      rules.push({
        order_id: o.id,
        file: `${o.id}.yml`,
        sha256: sha256Hex(r.yaml),
        patterns: r.patterns,
        na_removal_only: false,
      });
    } else rules.push({ order_id: o.id, file: null, sha256: null, patterns: 0, na_removal_only: true });
  }
  const m: BaselineManifest = {
    gen_version: GEN_VERSION,
    gen_sha256: genHash(input.root),
    rules,
  };
  await writeFile(join(input.outDir, 'MANIFEST.json'), `${JSON.stringify(m, null, 2)}\n`);
  return m;
}

/** Fails unless every rule file and gen.ts still match the manifest (the hashed set from the tag). */
export function verifyRules(root: string, dir: string): string[] {
  const p = join(dir, 'MANIFEST.json');
  if (!existsSync(p)) return [`${p} missing (run \`dnr trial baseline --generate\` before prereg-v1)`];
  const m = JSON.parse(readFileSync(p, 'utf8')) as BaselineManifest;
  const bad: string[] = [];
  if (genHash(root) !== m.gen_sha256)
    bad.push('gen.ts or baseline-gen.ts changed since the rules were generated');
  for (const r of m.rules)
    if (r.file && sha256Hex(readFileSync(join(dir, r.file))) !== r.sha256) bad.push(`${r.file} changed`);
  return bad;
}

export function astGrepBin(): string {
  const req = createRequire(import.meta.url);
  return join(dirname(req.resolve('@ast-grep/cli/package.json')), 'ast-grep');
}

export interface AstMatch {
  file: string;
  startLine: number;
  endLine: number;
  ruleId: string;
}

/** `ast-grep scan --rule <file> --json=compact <paths>` in `cwd`. */
export function astGrepScan(ruleFile: string, cwd: string, paths: string[]): Promise<AstMatch[]> {
  if (paths.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    execFile(
      astGrepBin(),
      ['scan', '--rule', ruleFile, '--json=compact', ...paths],
      { cwd, maxBuffer: 256 << 20 },
      (e, so, se) => {
        if (e && (e as { code?: unknown }).code !== 1 && !so.trim().startsWith('['))
          return reject(new Error(`ast-grep: ${se || e.message}`));
        const arr = JSON.parse(so.trim() || '[]') as Array<{
          file: string;
          ruleId: string;
          range: { start: { line: number }; end: { line: number } };
        }>;
        resolve(
          arr.map((x) => ({
            file: x.file,
            ruleId: x.ruleId,
            startLine: x.range.start.line + 1,
            endLine: x.range.end.line + 1,
          })),
        );
      },
    );
  });
}

/** Fair matching (§9.12): a match counts only if it overlaps a line changed relative to the start. */
export function fairMatches(
  matches: readonly AstMatch[],
  changed: ReadonlyMap<string, ReadonlySet<number>>,
): AstMatch[] {
  return matches.filter((m) => {
    const lines = changed.get(m.file);
    if (!lines) return false;
    for (let l = m.startLine; l <= m.endLine; l++) if (lines.has(l)) return true;
    return false;
  });
}

/** New-side changed lines per file between two texts. */
export function changedNewLines(before: string | null, after: string | null): Set<number> {
  return new Set(changedLines(before ?? '', after ?? '').new);
}
