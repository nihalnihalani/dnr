/**
 * P7-09, DEPLOY-01 and DEPLOY-02: real response headers and the shipped CSP. Locally, `vite
 * preview` applies public/_headers (vite.config.ts). GitHub Pages (PLAYGROUND_URL), the hosted
 * site, ignores _headers: there GitHub's own WASM type is checked, and the CSP that every built
 * page carries as a <meta> tag (docs/architecture.md, "Hosted Playground headers").
 */
import { expect, test } from '@playwright/test';
import { isRemote, openPlay } from './helpers';

const CONNECT_SRC =
  "connect-src 'self' https://raw.githubusercontent.com http://127.0.0.1:* http://*.localhost:*";

test('P7-09: WASM is application/wasm; the CSP has wasm-unsafe-eval and the stated connect-src; the engine runs under it', {
  tag: ['@P7-09', '@headers'],
}, async ({ page }) => {
  test.skip(isRemote, 'GitHub Pages ignores _headers (DEPLOY-01 and DEPLOY-02 below)');
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

test('DEPLOY-01: GitHub Pages serves the WASM files as application/wasm', {
  tag: ['@DEPLOY-01', '@headers', '@polish'],
}, async ({ page }) => {
  test.skip(!isRemote, 'checks the deployed site (PLAYGROUND_URL)');
  const wasm: Array<{ url: string; type: string }> = [];
  page.on('response', (r) => {
    if (r.url().endsWith('.wasm')) wasm.push({ url: r.url(), type: r.headers()['content-type'] ?? '' });
  });
  await openPlay(page);
  expect(wasm.length).toBeGreaterThanOrEqual(2);
  for (const w of wasm) expect(w.type, w.url).toBe('application/wasm');
});

test('DEPLOY-02: every page carries the CSP as a <meta> tag, and the engine runs under it with no violations', {
  tag: ['@DEPLOY-02', '@headers', '@polish'],
}, async ({ page }) => {
  const violations: string[] = [];
  await page.exposeFunction('__cspViolation', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __cspViolation: (v: string) => void }).__cspViolation(
        `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`,
      ),
    );
  });
  for (const path of ['./', 'play/43933a1dca', 'graveyard']) {
    const html = await (await page.request.get(path)).text();
    const metas = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/g) ?? [];
    expect(metas, path).toHaveLength(1);
    const csp = (metas[0] ?? '').replace(/^.*content="/, '').replace(/"$/, '');
    expect(csp, path).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp, path).toContain(CONNECT_SRC);
    expect(csp, path).toContain("object-src 'none'");
    // A <meta> CSP cannot carry frame-ancestors; browsers ignore it there and log an error.
    expect(csp, path).not.toContain('frame-ancestors');
    // Before any script, so it governs every script the page loads.
    expect(html.indexOf('http-equiv="Content-Security-Policy"'), path).toBeLessThan(html.indexOf('<script'));
  }
  await openPlay(page);
  expect(violations).toEqual([]);
});
