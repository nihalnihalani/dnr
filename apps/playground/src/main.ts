/**
 * Playground entry. The same build is served by the local board (`dnr board`), which injects
 * <meta name="dnr-adapter" content="api">; then the app talks to the board's /api instead of
 * localStorage.
 */
import type { CaseBundle } from '@dnr/schemas';
import {
  ApiAdapter,
  type AppConfig,
  type CaseIndexEntry,
  LocalAdapter,
  mountApp,
  type OrderRow,
  preloadRoute,
  simClock,
} from '@dnr/ui';
import runtimeUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import pythonUrl from '../../../vendor/grammars/tree-sitter-python.wasm?url';
import tsxUrl from '../../../vendor/grammars/tree-sitter-tsx.wasm?url';
import typescriptUrl from '../../../vendor/grammars/tree-sitter-typescript.wasm?url';

// The CSP has no 'unsafe-eval'. Zod's JIT probes `new Function('')`, which the browser reports as
// a CSP violation even though Zod catches it; jitless parsing never tries. Zod 4 keeps its config
// on globalThis.__zod_globalConfig and adopts an existing object (zod/v4/core/core.js), so this
// sets it without pulling zod (about 40 KB) into the entry chunk; zod loads with the routes that use it.
(globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig = { jitless: true };

const base = import.meta.env.BASE_URL;
const asset = (p: string) => `${base}${p}`;
const json = async <T>(p: string): Promise<T> => {
  const res = await fetch(asset(p));
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return (await res.json()) as T;
};

let index: Promise<CaseIndexEntry[]> | null = null;
const loadCaseIndex = () => {
  index ??= json<{ cases: CaseIndexEntry[] }>('cases/index.json').then((x) => x.cases);
  return index;
};
const cases = new Map<string, Promise<CaseBundle>>();
/** The case is rendered as soon as it is unpacked; Zod validation follows off the critical path. */
const loadCase = (id: string) => {
  let p = cases.get(id);
  if (!p) {
    p = Promise.all([
      json<unknown>(`cases/${encodeURIComponent(id)}.json`),
      import('@dnr/ui/engine/pack'),
    ]).then(([raw, e]) => e.unpackCase(raw) as CaseBundle);
    cases.set(id, p);
  }
  return p;
};
const checkCase = async (id: string): Promise<string | null> => {
  const [bundle, s] = await Promise.all([loadCase(id), import('@dnr/schemas')]);
  const r = s.CaseBundle.safeParse(bundle);
  return r.success ? null : `${r.error.issues[0]?.path.join('.')}: ${r.error.issues[0]?.message}`;
};
let seed: Promise<OrderRow[]> | null = null;
const loadSeed = () => {
  seed ??= json<{ rows: OrderRow[] }>('cases/graveyard.json').then((x) => x.rows);
  return seed;
};

const clock = simClock();
const sim = new LocalAdapter(loadSeed, undefined, clock.now);
const board = document.querySelector('meta[name="dnr-adapter"]')?.getAttribute('content') === 'api';

const config: AppConfig = {
  mode: board ? 'board' : 'playground',
  base,
  adapter: board ? new ApiAdapter() : sim,
  sim,
  clock,
  grammarUrls: { runtime: runtimeUrl, python: pythonUrl, typescript: typescriptUrl, tsx: tsxUrl },
  loadCaseIndex,
  loadCase,
  checkCase,
  trialUrl: __DNR_DATA__.trial ? asset('data/trial.json') : null,
  preregUrl: __DNR_DATA__.prereg ? asset('data/prereg.json') : null,
  kiroUrl: asset('data/kiro.json'),
  captureUrl: __DNR_DATA__.capture ? asset('data/cli-capture.json') : null,
  loadPending: async () =>
    (await json<{ pending?: Array<{ what: string; why: string }> }>('cases/index.json')).pending ?? [],
  repoUrl: import.meta.env.VITE_REPO_URL || null,
  version: import.meta.env.VITE_DNR_VERSION || '0.0.0',
};

// Start the case download before React and the route chunk load (it is the page's main content).
preloadRoute(location.pathname.slice(base.length - 1));
const play = location.pathname.slice(base.length - 1).match(/^\/play\/([^/]+)$/);
if (play?.[1]) {
  void loadCaseIndex();
  void loadCase(decodeURIComponent(play[1])).catch(() => {});
}

const root = document.getElementById('root');
if (root) mountApp(root, config);
