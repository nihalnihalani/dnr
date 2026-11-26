/**
 * A view of a tree state (baseline, session state, snapshot, HEAD, …): file text plus lazily
 * extracted units, cached per text.
 */
import type { ParserProvider } from './syntax';
import { extractUnits, type FileUnits } from './units';

export interface StateView {
  /** File text, or null when the file does not exist in this state. */
  text(path: string): string | null;
  /** Units of a scored source file, or null when the file is absent or not a scored source file. */
  units(path: string): FileUnits | null;
}

export type TextSource =
  | ReadonlyMap<string, string | null>
  | Readonly<Record<string, string | null>>
  | ((path: string) => string | null);

/** Shared cache of extracted units, keyed by path and text (reuse across states of one decision). */
export class UnitCache {
  private cache = new Map<string, FileUnits | null>();
  constructor(readonly provider: ParserProvider) {}
  get(path: string, text: string): FileUnits | null {
    const key = `${path}\u0000${text}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const u = extractUnits(this.provider, path, text);
    this.cache.set(key, u);
    return u;
  }
}

/** Build a StateView from a text source. Pass a shared `UnitCache` to avoid re-parsing identical texts. */
export function createState(source: TextSource, providerOrCache: ParserProvider | UnitCache): StateView {
  const cache = providerOrCache instanceof UnitCache ? providerOrCache : new UnitCache(providerOrCache);
  const read =
    typeof source === 'function'
      ? source
      : source instanceof Map
        ? (p: string) => source.get(p) ?? null
        : (p: string) => (source as Record<string, string | null>)[p] ?? null;
  return {
    text: read,
    units(path) {
      const t = read(path);
      return t === null ? null : cache.get(path, t);
    },
  };
}

/** A state equal to `base` except for the given overrides (null deletes a file). */
export function overlayState(
  base: StateView,
  overrides: ReadonlyMap<string, string | null>,
  cache: UnitCache,
): StateView {
  return {
    text: (p) => (overrides.has(p) ? (overrides.get(p) ?? null) : base.text(p)),
    units(p) {
      if (!overrides.has(p)) return base.units(p);
      const t = overrides.get(p) ?? null;
      return t === null ? null : cache.get(p, t);
    },
  };
}
