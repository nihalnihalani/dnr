/** Build-time packer for case bundles (see packages/ui/src/engine/pack.ts). */
import { diffArrays } from 'diff';
import type { LineOp } from '../../../packages/ui/src/engine/pack';

export function linePatch(base: string, target: string): LineOp[] {
  const ops: LineOp[] = [];
  for (const part of diffArrays(base.split('\n'), target.split('\n'))) {
    const n = part.count ?? part.value.length;
    if (part.added) ops.push(part.value as string[]);
    else if (part.removed) ops.push(-n);
    else ops.push(n);
  }
  return ops;
}

interface Full {
  files: Array<{ path: string; baseline_text: string; pre_change_text: string; change_text: string }>;
  presets: Array<{ writes: Array<{ path: string; proposed_text: string }> }>;
  [k: string]: unknown;
}

export function packCase(full: Full): unknown {
  const base = new Map(full.files.map((f) => [f.path, f.baseline_text]));
  const pack = (t: string, path: string) => {
    const b = base.get(path);
    if (b === undefined) return t;
    const ops = linePatch(b, t);
    return JSON.stringify(ops).length < t.length ? { base: '', ops } : t;
  };
  return {
    schema: 'dnr.case-packed/v1',
    bundle: {
      ...full,
      files: full.files.map((f) => ({
        ...f,
        pre_change_text: pack(f.pre_change_text, f.path),
        change_text: pack(f.change_text, f.path),
      })),
      presets: full.presets.map((p) => ({
        ...p,
        writes: p.writes.map((w) => ({ ...w, proposed_text: pack(w.proposed_text, w.path) })),
      })),
    },
  };
}
