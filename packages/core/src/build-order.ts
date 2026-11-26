/**
 * Building an order (§5.3) from file texts. Git access belongs to the caller: pass, for each
 * file C touched, its text before C (C^), after C, and at the post-revert snapshot.
 */
import type { Order, OrderUnit } from '@dnr/schemas';
import { diffLines } from 'diff';
import { diffTokens } from './diff';
import { DEFAULT_TEST_GLOBS, isTestPath } from './glob';
import { type UnitMaterial, unitKey } from './material';
import { sha256Hex } from './sha256';
import { type GrammarId, grammarForPath, type ParserProvider } from './syntax';
import { extractUnits, type FileUnits, qualnamesForLines } from './units';
import { NORMALIZER_VERSION, weightOf } from './weights';

export interface BuildOrderFile {
  path: string;
  /** Text at C^ (null when C added the file). */
  before: string | null;
  /** Text at C (null when C deleted the file). */
  after: string | null;
  /** Text at the post-revert snapshot (null when absent there). */
  post_revert: string | null;
}

export interface UnitChange {
  file: string;
  qualname: string;
  grammar: GrammarId;
  kind: OrderUnit['kind'];
  A: string[];
  R: string[];
  /** Unit tokens before and after C. */
  before: string[];
  after: string[];
}

/** 1-based changed line numbers on each side of a text change (what `git diff -U0` reports). */
export function changedLines(before: string, after: string): { old: number[]; new: number[] } {
  const oldLines: number[] = [];
  const newLines: number[] = [];
  let o = 1;
  let n = 1;
  for (const part of diffLines(before, after)) {
    const count = part.count ?? 0;
    if (part.added) {
      for (let i = 0; i < count; i++) newLines.push(n + i);
      n += count;
    } else if (part.removed) {
      for (let i = 0; i < count; i++) oldLines.push(o + i);
      o += count;
    } else {
      o += count;
      n += count;
    }
  }
  return { old: oldLines, new: newLines };
}

/**
 * The changed units of one file (§5.3 steps 1–3): map hunks to qualnames on both sides, then
 * tokenize each unit before and after and diff. Units whose only change is formatting (no
 * weighted token change) are skipped. Mining's rule E5 uses this.
 */
export function extractUnitChanges(
  provider: ParserProvider,
  file: Pick<BuildOrderFile, 'path' | 'before' | 'after'>,
  opts: { testGlobs?: readonly string[] } = {},
): UnitChange[] {
  const grammar = grammarForPath(file.path);
  if (!grammar) return [];
  // Test paths are never order units: restored tests are the trial's oracle (§9.1 step 7, §9.4).
  if (isTestPath(file.path, opts.testGlobs ?? DEFAULT_TEST_GLOBS)) return [];
  const before = file.before ?? '';
  const after = file.after ?? '';
  const bu = file.before === null ? null : extractUnits(provider, file.path, before);
  const au = file.after === null ? null : extractUnits(provider, file.path, after);
  const lines = changedLines(before, after);
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (q: string) => {
    if (!seen.has(q)) {
      seen.add(q);
      names.push(q);
    }
  };
  if (au) for (const q of qualnamesForLines(au, lines.new)) add(q);
  if (bu) for (const q of qualnamesForLines(bu, lines.old)) add(q);
  // A whole-file add/delete maps every unit on that side.
  if (!bu && au) for (const q of au.units.keys()) add(q);
  if (!au && bu) for (const q of bu.units.keys()) add(q);
  const out: UnitChange[] = [];
  for (const q of names) {
    const b = bu?.units.get(q);
    const a = au?.units.get(q);
    if (!a && !b) continue;
    const bt = b?.tokens ?? [];
    const at = a?.tokens ?? [];
    const d = diffTokens(bt, at);
    if (weightOf(d.A, grammar) + weightOf(d.R, grammar) === 0) continue; // formatting-only
    out.push({
      file: file.path,
      qualname: q,
      grammar,
      kind: a && b ? 'modified' : a ? 'added' : 'removed',
      A: d.A,
      R: d.R,
      before: bt,
      after: at,
    });
  }
  return out;
}

export interface BuildOrderInput {
  provider: ParserProvider;
  /** C */
  original_sha: string;
  /** R (null for a manual order) */
  revert_sha: string | null;
  /** The post-revert snapshot the baseline and stale checks compare against. */
  snapshot_sha: string;
  source?: Order['source'];
  files: readonly BuildOrderFile[];
  links: Order['links'];
  tickets?: Order['tickets'];
  reason?: string;
  reason_source?: Order['reason_source'];
  status?: Order['status'];
  /** ISO time for created_at/updated_at/history. */
  at: string;
  by?: string;
  /** Paths excluded from the order (config `test_globs`); defaults to DEFAULT_TEST_GLOBS. */
  testGlobs?: readonly string[];
}

export type BuildOrderResult =
  | { ok: true; order: Order; material: Map<string, UnitMaterial>; changes: UnitChange[] }
  | { ok: false; skip_reason: 'no-unit-change' };

/** Order ID (§5.3): `dnr-` + the first 10 hex characters of revert_sha (manual orders: original_sha). */
export function orderId(revertSha: string | null, originalSha: string): string {
  return `dnr-${(revertSha ?? originalSha).slice(0, 10)}`;
}

/** Hash of a unit's token sequence (`post_revert_hash`). */
export function unitHash(tokens: readonly string[]): string {
  return sha256Hex(JSON.stringify(tokens));
}

export function buildOrder(input: BuildOrderInput): BuildOrderResult {
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const units: OrderUnit[] = [];
  const changes: UnitChange[] = [];
  const material = new Map<string, UnitMaterial>();
  for (const f of files) {
    const fileChanges = extractUnitChanges(
      input.provider,
      f,
      input.testGlobs ? { testGlobs: input.testGlobs } : {},
    );
    if (fileChanges.length === 0) continue;
    const pr: FileUnits | null =
      f.post_revert === null ? null : extractUnits(input.provider, f.path, f.post_revert);
    for (const c of fileChanges) {
      const prTokens = pr?.units.get(c.qualname)?.tokens ?? [];
      units.push({
        file: c.file,
        qualname: c.qualname,
        kind: c.kind,
        tokenizer: { grammar: c.grammar, normalizer: NORMALIZER_VERSION[c.grammar] },
        A: c.A,
        R: c.R,
        c_state_ref: { sha: input.original_sha, file: c.file, qualname: c.qualname },
        post_revert_hash: unitHash(prTokens),
        post_revert_token_count: prTokens.length,
      });
      material.set(unitKey(c.file, c.qualname), { C: c.after, PR: prTokens });
      changes.push(c);
    }
  }
  if (units.length === 0) return { ok: false, skip_reason: 'no-unit-change' };
  const source = input.source ?? (input.revert_sha ? 'revert' : 'manual');
  const id = orderId(source === 'manual' ? null : input.revert_sha, input.original_sha);
  const order: Order = {
    schema: 'dnr.order/v1',
    id,
    status: input.status ?? 'draft',
    source,
    original_sha: input.original_sha,
    revert_sha: input.revert_sha,
    snapshot_sha: input.snapshot_sha,
    tickets: input.tickets ?? [],
    links: input.links,
    reason:
      input.reason ??
      `Placeholder: ${input.original_sha.slice(0, 10)} was reverted${input.revert_sha ? ` in ${input.revert_sha.slice(0, 10)}` : ''}; reason not yet drafted.`,
    reason_source: input.reason_source ?? (input.reason ? 'human' : 'placeholder'),
    units,
    history: [{ at: input.at, by: input.by ?? 'dnr', action: 'created' }],
    created_at: input.at,
    updated_at: input.at,
  };
  return { ok: true, order, material, changes };
}

/** Rebuild order material (C_u, PR_u) from texts at C and at the snapshot (e.g. from c_state_ref). */
export function materialFromTexts(
  provider: ParserProvider,
  order: Order,
  cText: (file: string) => string | null,
  snapshotText: (file: string) => string | null,
): Map<string, UnitMaterial> {
  const out = new Map<string, UnitMaterial>();
  const cache = new Map<string, FileUnits | null>();
  const unitsOf = (tag: string, file: string, text: string | null) => {
    const k = `${tag}\u0000${file}`;
    if (!cache.has(k)) cache.set(k, text === null ? null : extractUnits(provider, file, text));
    return cache.get(k) ?? null;
  };
  for (const u of order.units) {
    const c =
      u.kind === 'removed'
        ? []
        : (unitsOf('c', u.c_state_ref.file, cText(u.c_state_ref.file))?.units.get(u.c_state_ref.qualname)
            ?.tokens ?? []);
    const pr = unitsOf('pr', u.file, snapshotText(u.file))?.units.get(u.qualname)?.tokens ?? [];
    out.set(unitKey(u.file, u.qualname), { C: c, PR: pr });
  }
  return out;
}
