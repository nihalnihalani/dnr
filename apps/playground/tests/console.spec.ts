/**
 * Production polish: no console errors, page errors or failed same-origin requests on any route.
 * Runs locally and against a deployment (PLAYGROUND_URL).
 */
import { expect, test } from '@playwright/test';

const ROUTES = [
  './',
  'play',
  'play/43933a1dca',
  'play/d0e4dd5cdd',
  'graveyard',
  'orders/dnr-43933a1dca',
  'orders/dnr-d0e4dd5cdd',
  'orders/view',
  'trial',
  'replay',
  'kiro',
  'no-such-page',
];

for (const route of ROUTES) {
  test(`polish: no console errors on /${route.replace('./', '')}`, { tag: ['@polish', '@console'] }, async ({
    page,
    baseURL,
  }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      // A static host answers an unknown route with its 404 page (real HTTP 404), and Chromium
      // logs that for the document itself. Only that one message is expected, only on that route.
      const doc = new URL(m.location().url || 'about:blank', baseURL as string);
      if (
        route === 'no-such-page' &&
        doc.pathname.endsWith('/no-such-page') &&
        /status of 404/.test(m.text())
      )
        return;
      problems.push(`console.${m.type()}: ${m.text()} (${m.location().url})`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    const origin = new URL(baseURL as string).origin;
    page.on('response', (r) => {
      // Only the page's own requests; the top-level document of an unknown route is a real 404.
      if (!r.url().startsWith(origin) || r.request().resourceType() === 'document') return;
      if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
    });
    page.on('requestfailed', (r) => problems.push(`failed: ${r.url()} (${r.failure()?.errorText})`));
    await page.goto(route);
    await expect(page.locator('#page-title, h1').first()).toBeVisible();
    if (route.startsWith('play/'))
      await expect(page.locator('fieldset.presets')).toHaveAttribute('data-engine', 'ready', {
        timeout: 30_000,
      });
    await page.waitForLoadState('networkidle');
    expect(problems).toEqual([]);
  });
}
