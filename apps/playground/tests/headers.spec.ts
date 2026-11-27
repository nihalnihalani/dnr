/**
 * P7-09 and DEPLOY-01: real response headers. Locally, `vite preview` applies public/_headers as
 * Cloudflare Pages does (vite.config.ts), so these are the headers the Cloudflare site sends. Against
 * the GitHub Pages mirror (PLAYGROUND_URL), which ignores _headers, only GitHub's own WASM type is
 * checked; it has no custom CSP (docs/architecture.md, "Hosted Playground headers").
 */
import { expect, test } from '@playwright/test';
import { isRemote, openPlay } from './helpers';

const CONNECT_SRC =
  "connect-src 'self' https://raw.githubusercontent.com http://127.0.0.1:* http://*.localhost:*";

test('P7-09: WASM is application/wasm; the CSP has wasm-unsafe-eval and the stated connect-src; the engine runs under it', {
  tag: ['@P7-09', '@headers'],
}, async ({ page }) => {
  test.skip(isRemote, 'the GitHub Pages mirror ignores _headers (DEPLOY-01 below)');
  const violations: string[] = [];
  await page.exposeFunction('__cspViolation', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __cspViolation: (v: string) => void }).__cspViolation(
        `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`,
      ),
    );
  });
  const wasm: Array<{ url: string; type: string; cache: string }> = [];
  page.on('response', (r) => {
    if (r.url().endsWith('.wasm'))
      wasm.push({
        url: r.url(),
        type: r.headers()['content-type'] ?? '',
        cache: r.headers()['cache-control'] ?? '',
      });
  });
  const doc = await page.goto('play/43933a1dca');
  const csp = doc?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain(CONNECT_SRC);
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(doc?.headers()['x-content-type-options']).toBe('nosniff');
  await openPlay(page);
  // The runtime and the Python grammar at least; every one is application/wasm and immutable.
  expect(wasm.length).toBeGreaterThanOrEqual(2);
  for (const w of wasm) {
    expect(w.type, w.url).toBe('application/wasm');
    expect(w.cache, w.url).toBe('public, max-age=31536000, immutable');
  }
  expect(violations).toEqual([]);
});

test('DEPLOY-01: the GitHub Pages mirror serves the WASM files as application/wasm', {
  tag: ['@DEPLOY-01', '@headers', '@polish'],
}, async ({ page }) => {
  test.skip(!isRemote, 'checks the deployed mirror (PLAYGROUND_URL)');
  const wasm: Array<{ url: string; type: string }> = [];
  page.on('response', (r) => {
    if (r.url().endsWith('.wasm')) wasm.push({ url: r.url(), type: r.headers()['content-type'] ?? '' });
  });
  await openPlay(page);
  expect(wasm.length).toBeGreaterThanOrEqual(2);
  for (const w of wasm) expect(w.type, w.url).toBe('application/wasm');
});
