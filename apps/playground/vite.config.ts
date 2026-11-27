import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { packCase } from './scripts/pack';

const here = dirname(fileURLToPath(import.meta.url));

/** Copy the real reports/trial.json into the build when it exists (the sample is used otherwise). */
function trialData(): Plugin {
  return {
    name: 'dnr-trial-data',
    apply: 'build',
    writeBundle(opts) {
      const src = resolve(here, '../../reports/trial.json');
      if (!existsSync(src) || !opts.dir) return;
      mkdirSync(resolve(opts.dir, 'data'), { recursive: true });
      copyFileSync(src, resolve(opts.dir, 'data/trial.json'));
    },
  };
}

/** Replace each copied public/cases/<id>.json with its packed form (exact texts, far smaller). */
function packCases(): Plugin {
  return {
    name: 'dnr-pack-cases',
    apply: 'build',
    writeBundle(opts) {
      if (!opts.dir) return;
      const dir = resolve(opts.dir, 'cases');
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json') || f === 'index.json' || f === 'graveyard.json') continue;
        const full = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
        if (full.schema !== 'dnr.case/v1') continue;
        writeFileSync(resolve(dir, f), JSON.stringify(packCase(full)));
      }
    },
  };
}

/**
 * Inline the one stylesheet (about 5 KB gzipped) into index.html: on slow mobile links that saves
 * a render-blocking round trip before first paint. The CSP allows inline styles already.
 */
function inlineCss(): Plugin {
  return {
    name: 'dnr-inline-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = Object.values(bundle).find((a) => a.type === 'asset' && a.fileName === 'index.html');
      if (html?.type !== 'asset') return;
      let text = String(html.source);
      for (const a of Object.values(bundle)) {
        if (a.type !== 'asset' || !a.fileName.endsWith('.css')) continue;
        const re = new RegExp(
          `<link rel="stylesheet"[^>]*href="[^"]*${a.fileName.replace(/[.]/g, '\\.')}"[^>]*>`,
        );
        if (!re.test(text)) continue;
        text = text.replace(re, () => `<style>${String(a.source)}</style>`);
        // The file stays: Vite's preload helper still references it for lazy chunks.
      }
      html.source = text;
    },
  };
}

/**
 * Social preview and canonical tags. og:image must be an absolute URL, so the site URL comes from
 * DNR_SITE_URL (set per deploy target in deploy-playground.yml), defaulting to the live GitHub
 * Pages mirror. og.png is a real screenshot of /play (scripts/capture-og.ts).
 */
function socialMeta(): Plugin {
  const site = (process.env.DNR_SITE_URL ?? 'https://nihalnihalani.github.io/dnr/').replace(/\/?$/, '/');
  const title = 'DNR · Do Not Resurrect';
  const description =
    'A Kiro hook that blocks AI-agent writes which re-apply reverted changes, with the revert reason and links. Try it in your browser on a real Django revert.';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const tags = [
    `<link rel="canonical" href="${esc(site)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="DNR" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(site)}" />`,
    `<meta property="og:image" content="${esc(`${site}og.png`)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="The DNR Playground blocking a re-application of Django commit 43933a1dca, with exit code 2 and the revert reason" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(`${site}og.png`)}" />`,
  ];
  return {
    name: 'dnr-social-meta',
    transformIndexHtml: (html) => html.replace('</head>', `    ${tags.join('\n    ')}\n  </head>`),
  };
}

/**
 * Which optional data files this build ships. The app fetches only these, so a deploy without a
 * trial, a prereg tag or a CLI capture makes no requests that 404 (static hosts log those as
 * console errors). Read after `prebuild` (build-kiro.ts) has written prereg.json.
 */
const shipped = {
  trial: existsSync(resolve(here, '../../reports/trial.json')),
  prereg: existsSync(resolve(here, 'public/data/prereg.json')),
  capture: existsSync(resolve(here, 'public/data/cli-capture.json')),
};

export default defineConfig({
  plugins: [react(), socialMeta(), trialData(), packCases(), inlineCss()],
  define: { __DNR_DATA__: JSON.stringify(shipped) },
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    reportCompressedSize: true,
  },
  server: { fs: { allow: [resolve(here, '../..')] } },
});
