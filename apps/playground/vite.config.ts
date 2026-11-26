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
      if (!html || html.type !== 'asset') return;
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

export default defineConfig({
  plugins: [react(), trialData(), packCases(), inlineCss()],
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    reportCompressedSize: true,
  },
  server: { fs: { allow: [resolve(here, '../..')] } },
});
