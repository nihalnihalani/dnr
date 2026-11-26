/**
 * Order cases built from generated programs: one or two files, an approved order, and
 * helpers to render any intermediate state.
 */
import {
  buildOrder,
  createState,
  type OrderEntry,
  type ParserProvider,
  type StateView,
  UnitCache,
} from '@dnr/core';
import { changeIds, DEFAULT_STYLE, fileName, type Lang, type Mod, render, type Style } from './program';

export const SHA_C = '1'.repeat(40);
export const SHA_R = '2'.repeat(40);
export const SHA_S = '3'.repeat(40);
export const LINKS = [
  { rel: 'original' as const, url: 'https://example.test/commit/1111' },
  { rel: 'revert' as const, url: 'https://example.test/commit/2222' },
];

export interface CaseFile {
  path: string;
  mod: Mod;
  lang: Lang;
}

export interface OrderCase {
  files: CaseFile[];
  entry: OrderEntry;
  /** Every change id across files, prefixed by path (`path|id`). */
  ids: string[];
  cache: UnitCache;
}

export function caseFiles(mods: Mod[], lang: Lang): CaseFile[] {
  return mods.map((mod, i) => ({ path: `pkg/${fileName(`mod${i}`, lang)}`, mod, lang }));
}

export function allIds(files: readonly CaseFile[]): string[] {
  return files.flatMap((f) => changeIds(f.mod).map((id) => `${f.path}|${id}`));
}

/** Texts of the state with `applied` (prefixed ids) applied. */
export function texts(
  files: readonly CaseFile[],
  applied: Iterable<string>,
  style: Style = DEFAULT_STYLE,
): Record<string, string> {
  const set = new Set(applied);
  const out: Record<string, string> = {};
  for (const f of files) {
    const local = new Set(
      [...set].filter((x) => x.startsWith(`${f.path}|`)).map((x) => x.slice(f.path.length + 1)),
    );
    out[f.path] = render(f.mod, f.lang, local, style);
  }
  return out;
}

export function stateOf(
  c: Pick<OrderCase, 'files' | 'cache'>,
  applied: Iterable<string>,
  style: Style = DEFAULT_STYLE,
): StateView {
  return createState(texts(c.files, applied, style), c.cache);
}

/** Build the approved order for C = every change applied; null when C changed nothing scorable. */
export function buildCase(
  provider: ParserProvider,
  files: CaseFile[],
  cache = new UnitCache(provider),
): OrderCase | null {
  const ids = allIds(files);
  const before = texts(files, []);
  const after = texts(files, ids);
  const r = buildOrder({
    provider,
    original_sha: SHA_C,
    revert_sha: SHA_R,
    snapshot_sha: SHA_S,
    files: files.map((f) => ({
      path: f.path,
      before: before[f.path] ?? null,
      after: after[f.path] ?? null,
      post_revert: before[f.path] ?? null,
    })),
    links: LINKS,
    at: '2026-11-26T00:00:00Z',
    status: 'approved',
  });
  if (!r.ok) return null;
  return { files, entry: { order: r.order, material: r.material }, ids, cache };
}
