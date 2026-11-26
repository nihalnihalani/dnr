import { extractUnitChanges, extractUnits, weightOf } from '@dnr/core';
import { loadGrammarsNode } from '@dnr/grammar/node';
import { fallbackAnalyzer, type UnitAnalyzer, type UnitFile } from './units';

type Parser = Awaited<ReturnType<typeof loadGrammarsNode>>;

/** Engine-backed analyzer: §5.2 qualnames and §5.3 unit changes / w() from @dnr/core. */
export function engineAnalyzer(parser: Parser): UnitAnalyzer {
  const changes = new Map<string, ReturnType<typeof extractUnitChanges>>();
  const changesOf = (f: UnitFile) => {
    const key = `${f.path}\0${f.before ?? '\u0001'}\0${f.after ?? '\u0001'}`;
    let c = changes.get(key);
    if (!c) {
      c = extractUnitChanges(parser, { path: f.path, before: f.before, after: f.after });
      changes.set(key, c);
    }
    return c;
  };
  return {
    source: 'engine',
    changedUnits(f) {
      return [...new Set(changesOf(f).map((c) => c.qualname))].sort();
    },
    unitExists(path, text, qualname) {
      return extractUnits(parser, path, text)?.units.has(qualname) ?? false;
    },
    async orderWeight(files) {
      let w = 0;
      for (const f of files)
        for (const c of changesOf(f)) w += weightOf(c.A, c.grammar) + weightOf(c.R, c.grammar);
      return w;
    },
  };
}

/**
 * Picks the unit analyzer: the engine's when its grammars load, else the indentation fallback
 * (E5 then stays pending). `DNR_MINE_ANALYZER=fallback` forces the fallback.
 */
export async function loadAnalyzer(log: (m: string) => void = () => {}): Promise<UnitAnalyzer> {
  if (process.env.DNR_MINE_ANALYZER === 'fallback') {
    log('unit analyzer: fallback-indent (forced)');
    return fallbackAnalyzer;
  }
  try {
    const parser = await loadGrammarsNode();
    log('unit analyzer: engine (@dnr/core §5.2 qualnames, §5.3 weights)');
    return engineAnalyzer(parser);
  } catch (e) {
    log(`unit analyzer: fallback-indent (engine unavailable: ${e instanceof Error ? e.message : String(e)})`);
    return fallbackAnalyzer;
  }
}
