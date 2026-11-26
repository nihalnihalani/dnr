import { defineConfig, devices } from '@playwright/test';

/**
 * PLAYGROUND_URL points the suite at a deployment (smoke, uptime). Without it, the suite runs
 * against `vite preview` of a local build (`pnpm -F @dnr/playground build` first).
 */
const remote = process.env.PLAYGROUND_URL;
// PW_PORT moves the local preview server off 4173 (another preview of this project may be running).
const port = Number(process.env.PW_PORT ?? 4173);
const baseURL = remote ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    // PW_CHANNEL=chrome runs the chromium project on an installed Google Chrome.
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  ...(remote
    ? {}
    : {
        webServer: {
          command: `pnpm exec vite preview --strictPort --port ${port} --host 127.0.0.1 --bypass-lock`,
          url: `http://127.0.0.1:${port}/`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }),
});
