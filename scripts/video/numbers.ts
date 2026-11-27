/**
 * `reports/video/numbers.json`, as written by `dnr trial report` (packages/trial/src/report.ts,
 * `videoNumbers`). Plan §11: every caption, narration line and number in the video, the §15
 * pitch, the README one-liner, the tagline and the Impact paragraph come from this file, for the
 * §9.8 row that applied. A field the file does not carry is rendered as a visible pending marker,
 * never as a value.
 */
import { existsSync, readFileSync } from 'node:fs';

export type Row = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
export type Mode = 'enforce' | 'warn-only' | 'commit-enforce' | null;
export type LOutcome =
  | 'stopped_and_reported'
  | 'retried_and_blocked'
  | 'alternative_impl'
  | 'shell_bypass'
  | 'landed';

export interface RatioOut {
  num: number;
  den: number;
  wilson?: unknown;
}

export interface VideoNumbers {
  row: Row;
  via_d6: boolean;
  mode: Mode;
  prereg_sha: string;
  content_hash: string;
  wording?: string;
  rates?: null;
  K?: number;
  X?: number;
  K_eff?: number;
  X_eff?: number;
  S_eff?: number;
  W_L?: number;
  Q?: number;
  Y?: number;
  human_reproposals?: number | null;
  /** True only when a person wrote `Confirmed total:` (§9.9); captions use the count only then. */
  human_reproposals_confirmed?: boolean;
  x_over_k?: RatioOut;
  card?: { X_eff?: RatioOut; S_eff?: RatioOut; W_L?: RatioOut };
  s_close_to_l?: boolean;
  audience?: string;
  package?: string;
  playground_url?: string;
  case?: { id?: string; revert_sha?: string; reason_short?: string };
  run?: {
    l_run_id?: string;
    t_run_id?: string;
    /** D1 `commit-enforce`: the demo/CE run (§11). */
    ce_run_id?: string;
    l_outcome?: LOutcome;
    score?: number;
    task_short?: string;
    lu?: boolean;
  };
}

const ROWS = new Set(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
const MODES = new Set(['enforce', 'warn-only', 'commit-enforce', null]);

export class NumbersError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'NumbersError';
  }
}

/** Validates the fields the renderer and checker depend on; unknown extra fields are kept. */
export function parseNumbers(raw: unknown): VideoNumbers {
  if (!raw || typeof raw !== 'object') throw new NumbersError('numbers.json is not a JSON object');
  const n = raw as Record<string, unknown>;
  if (!ROWS.has(n.row as string))
    throw new NumbersError(`numbers.json row ${JSON.stringify(n.row)} is not D1–D6`);
  if (typeof n.via_d6 !== 'boolean') throw new NumbersError('numbers.json via_d6 is not a boolean');
  if (!MODES.has(n.mode as string | null))
    throw new NumbersError(`numbers.json mode ${JSON.stringify(n.mode)}`);
  if (typeof n.prereg_sha !== 'string' || !/^[0-9a-f]{40}$/.test(n.prereg_sha))
    throw new NumbersError('numbers.json prereg_sha is not a 40-hex SHA');
  if (typeof n.content_hash !== 'string') throw new NumbersError('numbers.json content_hash is missing');
  for (const k of ['K', 'X', 'K_eff', 'X_eff', 'S_eff', 'W_L', 'Q', 'Y'])
    if (k in n && (typeof n[k] !== 'number' || !Number.isInteger(n[k]) || (n[k] as number) < 0))
      throw new NumbersError(`numbers.json ${k} is not a non-negative integer`);
  if ('human_reproposals_confirmed' in n) {
    const c = n.human_reproposals_confirmed;
    const h = n.human_reproposals;
    if (typeof c !== 'boolean')
      throw new NumbersError('numbers.json human_reproposals_confirmed is not a boolean');
    if (c !== (h !== null && h !== undefined))
      throw new NumbersError('numbers.json human_reproposals must be a number exactly when it is confirmed');
    if (c && (typeof h !== 'number' || !Number.isInteger(h) || h < 0))
      throw new NumbersError('numbers.json human_reproposals is not a non-negative integer');
  }
  return n as unknown as VideoNumbers;
}

export function loadNumbers(path: string): VideoNumbers {
  if (!existsSync(path))
    throw new NumbersError(
      `${path} does not exist: \`dnr trial report\` has not run on real scored trial data (Phase 11)`,
    );
  return parseNumbers(JSON.parse(readFileSync(path, 'utf8')));
}

/** Visible marker for a value with no source yet. The checker reports these as PENDING. */
export const pending = (source: string) => `[pending: ${source}]`;
export const PENDING_RE = /\[pending: [^\]]+\]/g;

/** Dotted lookup (`case.reason_short`) into numbers.json. */
export function field(n: VideoNumbers, path: string): unknown {
  let v: unknown = n;
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** Fills `{{a.b}}` slots from numbers.json; a missing slot becomes a pending marker naming it. */
export function fill(n: VideoNumbers, template: string): string {
  return template.replace(/\{\{([a-zA-Z_.]+)\}\}/g, (_, p: string) => {
    const v = field(n, p);
    return v === undefined || v === null ? pending(`numbers.json ${p}`) : String(v);
  });
}
