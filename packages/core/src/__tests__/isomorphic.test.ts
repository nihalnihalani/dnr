import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('..', import.meta.url));

describe('@dnr/core is isomorphic', () => {
  it('no source file imports a node:* module or a Node-only package', () => {
    const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(join(src, f), 'utf8');
      const imports = [...text.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(
        (m) => m[1],
      );
      for (const spec of imports) {
        expect(
          spec?.startsWith('node:') || spec === 'fs' || spec === 'path' || spec === 'crypto',
          `${f} imports ${spec}`,
        ).toBe(false);
        expect(spec?.includes('grammar/node'), `${f} imports ${spec}`).toBe(false);
      }
    }
  });
});
