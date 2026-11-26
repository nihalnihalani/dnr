import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGrammarsFromBytes } from './index';
import { loadGrammarsNode, resolveGrammarDir } from './node';

describe('@dnr/grammar', () => {
  it('loads the vendored grammars in node and parses each language', async () => {
    const g = await loadGrammarsNode();
    const cases: Array<['python' | 'typescript' | 'tsx', string, string]> = [
      ['python', 'def f(): pass\n', 'function_definition'],
      ['typescript', 'function f(a: number): number { return a; }\n', 'function_declaration'],
      ['tsx', 'const X = () => <div>{1}</div>;\n', 'jsx_element'],
    ];
    for (const [lang, src, node] of cases) {
      const t = g.parse(lang, src);
      expect(t.rootNode.hasError).toBe(false);
      expect(t.rootNode.toString()).toContain(node);
      t.delete();
    }
  });
  it('the byte loader (used by the browser path) gives identical trees', async () => {
    const dir = resolveGrammarDir();
    const read = (f: string) => new Uint8Array(readFileSync(join(dir, f)));
    const g = await loadGrammarsFromBytes({
      python: read('tree-sitter-python.wasm'),
      typescript: read('tree-sitter-typescript.wasm'),
      tsx: read('tree-sitter-tsx.wasm'),
    });
    const n = await loadGrammarsNode();
    const src = 'class A:\n    def m(self):\n        return [x for x in self.y]\n';
    expect(g.parse('python', src).rootNode.toString()).toBe(n.parse('python', src).rootNode.toString());
  });
});
