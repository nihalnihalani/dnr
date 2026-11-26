import { defineConfig } from 'tsup';

// One self-contained ESM bundle: workspace packages (@dnr/*) are bundled; npm dependencies stay
// external and are listed in package.json "dependencies".
export default defineConfig({
  entry: { cli: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: true,
  sourcemap: false,
  noExternal: [/^@dnr\//],
  external: [
    'web-tree-sitter',
    'zod',
    'diff',
    'shell-quote',
    'ulid',
    '@modelcontextprotocol/sdk',
    'hono',
    '@hono/node-server',
  ],
});
