import type { CaseBundle } from '@dnr/schemas';
import { createContext, useContext } from 'react';
import type { LocalAdapter } from '../adapters/local';
import type { GrammarUrls } from '../engine/grammar';
import type { DataAdapter } from '../model/types';

export interface CaseIndexEntry {
  id: string;
  title: string;
  order_id: string;
  grammars: string[];
  source: { repo: string; license: string; from?: string };
  notes: string[];
  /** Presets this case cannot offer, and why. */
  omitted?: Array<{ kind: string; reason: string }>;
}

export interface AppConfig {
  mode: 'playground' | 'board';
  /** Base path the app is served under ('/' on Cloudflare, '/<repo>/' on the GitHub Pages mirror). */
  base: string;
  adapter: DataAdapter;
  /** The Playground's localStorage adapter (also used by /play on the board, which never touches the API). */
  sim: LocalAdapter;
  grammarUrls: GrammarUrls;
  loadCaseIndex(): Promise<CaseIndexEntry[]>;
  loadCase(id: string): Promise<CaseBundle>;
  /** Zod-validate a case (null when valid); the page shows an error banner otherwise. */
  checkCase(id: string): Promise<string | null>;
  /** URL of trial.json (real results only), or null when this build has none (empty state). */
  trialUrl: string | null;
  /** {tag, sha} of prereg-v1 once it exists (written at build time), else null. */
  preregUrl: string | null;
  /** Simulated clock shared by /play and the localStorage adapter (Advance 1 h). */
  clock: SimClock;
  kiroUrl: string;
  /** Recorded output of the built CLI on the demo checkout (data/cli-capture.json), if one exists. */
  captureUrl: string | null;
  /** Cases not available yet, and why (from cases/index.json). */
  loadPending(): Promise<Array<{ what: string; why: string }>>;
  /** Public repository URL (VITE_REPO_URL), or null. */
  repoUrl: string | null;
  version: string;
}

export interface SimClock {
  now(): number;
  advance(ms: number): void;
}

/** Wall clock plus a persisted offset (localStorage), so "Advance 1 h" survives reloads. */
export function simClock(key = 'dnr.playground.clock'): SimClock {
  const read = () => {
    try {
      return Number(globalThis.localStorage?.getItem(key) ?? 0) || 0;
    } catch {
      return 0;
    }
  };
  let offset = read();
  return {
    now: () => Date.now() + offset,
    advance(ms) {
      offset += ms;
      try {
        globalThis.localStorage?.setItem(key, String(offset));
      } catch {}
    },
  };
}

export const ConfigContext = createContext<AppConfig | null>(null);

export function useConfig(): AppConfig {
  const c = useContext(ConfigContext);
  if (!c) throw new Error('ConfigContext missing');
  return c;
}
