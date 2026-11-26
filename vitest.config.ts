import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'] } },
      { test: { name: 'fixtures', include: ['packages/schemas/test/fixtures.test.ts'] } },
    ],
  },
});
