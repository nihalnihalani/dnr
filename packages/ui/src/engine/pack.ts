/**
 * Transport packing for case bundles. A CaseBundle repeats each file up to five times (baseline,
 * C^, C, and each preset), which gzip cannot deduplicate across 100 KB copies. The Playground
 * build stores every text but the baseline as a line patch against the baseline; the loader
 * rebuilds the exact CaseBundle (validated by Zod) before anything uses it.
 *
 * Patch ops: n > 0 copies n baseline lines, n < 0 skips -n baseline lines, string[] inserts lines.
 */
export type LineOp = number | string[];

export interface PackedCase {
  schema: 'dnr.case-packed/v1';
  bundle: Record<string, unknown>;
}

export function applyLinePatch(base: string, ops: readonly LineOp[]): string {
  const src = base.split('\n');
  const out: string[] = [];
  let i = 0;
  for (const op of ops) {
    if (typeof op === 'number') {
      if (op > 0) out.push(...src.slice(i, i + op));
      i += Math.abs(op);
    } else out.push(...op);
  }
  return out.join('\n');
}

type PackedText = string | { base: string; ops: LineOp[] };

/** Rebuild a full bundle from the packed form (or return a full bundle unchanged). */
export function unpackCase(raw: unknown): unknown {
  const p = raw as PackedCase;
  if (p?.schema !== 'dnr.case-packed/v1') return raw;
  const b = p.bundle as {
    files: Array<{
      path: string;
      baseline_text: string;
      pre_change_text: PackedText;
      change_text: PackedText;
    }>;
    presets: Array<{ writes: Array<{ path: string; proposed_text: PackedText }> }>;
  };
  const baseOf = new Map(b.files.map((f) => [f.path, f.baseline_text]));
  const text = (t: PackedText, path: string) =>
    typeof t === 'string' ? t : applyLinePatch(baseOf.get(t.base === '' ? path : t.base) ?? '', t.ops);
  return {
    ...b,
    files: b.files.map((f) => ({
      ...f,
      pre_change_text: text(f.pre_change_text, f.path),
      change_text: text(f.change_text, f.path),
    })),
    presets: b.presets.map((pr) => ({
      ...pr,
      writes: pr.writes.map((w) => ({ ...w, proposed_text: text(w.proposed_text, w.path) })),
    })),
  };
}
