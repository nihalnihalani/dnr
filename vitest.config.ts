import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          exclude: ['packages/schemas/test/fixtures.test.ts', '**/node_modules/**'],
        },
      },
      { test: { name: 'fixtures', include: ['packages/schemas/test/fixtures.test.ts'] } },
      // The installed npm package (needs `pnpm build` and network): `pnpm test:pack`.
      { test: { name: 'pack', include: ['packages/cli/test-pack/**/*.test.ts'], fileParallelism: false } },
    ],
  },
});
