/**
 * Captures the social preview image (og:image) and the touch icon from the real built Playground:
 * `/play/43933a1dca` after the in-browser engine decides the original Django change (C) against
 * the order approved in this browser (the "simulated" approval the page labels as such). Nothing is
 * drawn by hand; the picture is the page as a visitor sees it.
 *
 *   pnpm -F @dnr/playground build && pnpm -F @dnr/playground capture:og
 *
 * Writes public/og.png (1200×630) and public/apple-touch-icon.png (180×180, from favicon.svg).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const port = Number(process.env.OG_PORT ?? 4198);
const base = `http://127.0.0.1:${port}/`;

const server = spawn(
  'pnpm',
  ['exec', 'vite', 'preview', '--strictPort', '--port', String(port), '--host', '127.0.0.1'],
  {
    cwd: app,
    stdio: 'ignore',
  },
);
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    if (i > 100) throw new Error('vite preview did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(`${base}play/43933a1dca`);
  await page.locator('fieldset.presets[data-engine="ready"]').waitFor({ timeout: 60_000 });
  await page.locator('.sim-actions [data-action="approve"]').click();
  await page.locator('[data-preset="reset"]').click();
  await page.locator('[data-preset-kind="original-change"]').click();
  const verdict = page.getByTestId('verdict');
  await verdict.waitFor();
  if ((await verdict.getAttribute('data-verdict')) !== 'BLOCK') throw new Error('expected a BLOCK decision');
  await verdict.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -120));
  await page.screenshot({ path: resolve(app, 'public/og.png') });

  const icon = await browser.newPage({ viewport: { width: 180, height: 180 } });
  const svg = readFileSync(resolve(app, 'public/favicon.svg'), 'utf8');
  await icon.setContent(
    `<html><body style="margin:0">${svg.replace('<svg ', '<svg width="180" height="180" ')}</body></html>`,
  );
  await icon.screenshot({ path: resolve(app, 'public/apple-touch-icon.png'), omitBackground: false });
  await browser.close();
  console.log('wrote public/og.png and public/apple-touch-icon.png');
} finally {
  server.kill();
}
