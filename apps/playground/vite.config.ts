import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { packCase } from './scripts/pack';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Copy the real reports/trial.json into the build when it exists. Without it, /trial shows its empty
 * state; no sample ships.
 */
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
 * One HTML file per /play case (dist/play/<id>/index.html) that preloads what that page needs
 * first: its case JSON and the /play route chunks. Without it the browser only learns about them
 * after the entry script has run, which put them late on the critical path (Lighthouse LCP on a
 * mobile CPU). Static hosts serve these files for the deep link directly (GitHub Pages; vite
 * preview), and they are the same app as index.html otherwise.
 */
function playRoutePages(): Plugin {
  return {
    name: 'dnr-play-route-pages',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = Object.values(bundle).find((a) => a.type === 'asset' && a.fileName === 'index.html');
      if (html?.type !== 'asset') return;
      const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
      const holds = (end: string) =>
        chunks.find((c) => c.type === 'chunk' && c.moduleIds.some((m) => m.endsWith(end)));
      const play = holds('/routes/Play.tsx');
      const pack = holds('/engine/pack.ts');
      if (play?.type !== 'chunk') this.error('play route pages: no chunk holds routes/Play.tsx');
      const files = new Set<string>();
      const walk = (name: string) => {
        if (files.has(name)) return;
        const c = bundle[name];
        if (c?.type !== 'chunk' || c.isEntry) return;
        files.add(name);
        for (const i of c.imports) walk(i);
      };
      walk(play.fileName);
      if (pack?.type === 'chunk') walk(pack.fileName);
      const index = JSON.parse(readFileSync(resolve(here, 'public/cases/index.json'), 'utf8')) as {
        cases: Array<{ id: string }>;
      };
      // The entry script's own URL tells us the base path this build uses.
      const entry = String(html.source).match(/src="([^"]*)assets\/index-[^"]+\.js"/)?.[1] ?? '/';
      for (const { id } of index.cases) {
        const links = [
          `<link rel="preload" href="${entry}cases/${id}.json" as="fetch" crossorigin />`,
          `<link rel="preload" href="${entry}cases/index.json" as="fetch" crossorigin />`,
          ...[...files].map((f) => `<link rel="modulepreload" crossorigin href="${entry}${f}" />`),
        ];
        this.emitFile({
          type: 'asset',
          fileName: `play/${id}/index.html`,
          source: String(html.source).replace('</head>', `    ${links.join('\n    ')}\n  </head>`),
        });
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

/** One `_headers` rule (Cloudflare Pages format): a path pattern and the headers it sets. */
interface HeaderRule {
  re: RegExp;
  headers: Array<[string, string]>;
}

/** Parse Cloudflare Pages `_headers`: `*` is a splat, `:name` a path segment. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pat = line
        .trim()
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/:\w+/g, '[^/]+');
      rules.push({ re: new RegExp(`^${pat}$`), headers: [] });
      continue;
    }
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (m && rules.length) rules[rules.length - 1]?.headers.push([m[1] as string, m[2] as string]);
  }
  return rules;
}

/**
 * `vite preview` applies public/_headers exactly as Cloudflare Pages does (every matching rule
 * applies; a header set by several rules is joined with ", "). So the e2e suite runs under the
 * production CSP, and P7-09 checks real response headers.
 */
function previewHeaders(): Plugin {
  return {
    name: 'dnr-preview-headers',
    configurePreviewServer(server) {
      const rules = parseHeaders(readFileSync(resolve(here, 'public/_headers'), 'utf8'));
      const outDir = resolve(here, server.config.build.outDir);
      // Like GitHub Pages and Cloudflare Pages: /play/<id> is served from play/<id>/index.html when
      // the build has one (playRoutePages), before the SPA fallback.
      server.middlewares.use((req, _res, next) => {
        const [path, query] = (req.url ?? '/').split('?') as [string, string?];
        const clean = path.replace(/\/+$/, '');
        if (clean && !clean.includes('..') && existsSync(join(outDir, clean, 'index.html')))
          req.url = `${clean}/index.html${query ? `?${query}` : ''}`;
        next();
      });
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0] as string;
        const set = new Map<string, string>();
        for (const r of rules)
          if (r.re.test(path))
            for (const [k, v] of r.headers) set.set(k, set.has(k) ? `${set.get(k)}, ${v}` : v);
        // Set after Vite picks its own type, so _headers wins (as on Cloudflare).
        const writeHead = res.writeHead.bind(res);
        res.writeHead = ((status: number, ...rest: unknown[]) => {
          for (const [k, v] of set) res.setHeader(k, v);
          // Headers passed to writeHead itself (sirv passes Cache-Control) would win; drop those.
          const last = rest.at(-1);
          if (last && typeof last === 'object' && !Array.isArray(last)) {
            const h = last as Record<string, unknown>;
            for (const k of Object.keys(h))
              if ([...set.keys()].some((n) => n.toLowerCase() === k.toLowerCase())) delete h[k];
          }
          return (writeHead as (...a: unknown[]) => typeof res)(status, ...rest);
        }) as typeof res.writeHead;
        next();
      });
    },
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
  plugins: [react(), socialMeta(), previewHeaders(), trialData(), packCases(), inlineCss(), playRoutePages()],
  define: { __DNR_DATA__: JSON.stringify(shipped) },
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    reportCompressedSize: true,
  },
  server: { fs: { allow: [resolve(here, '../..')] } },
});
