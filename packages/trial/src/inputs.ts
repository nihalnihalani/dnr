/**
 * Loads the committed trial inputs: reverts, SYN cases, assignment (the single source of roles),
 * pins and the trial order store. A dry run with `--only <sha>` may fall back to a provisional
 * case built from `fixtures/candidates.jsonl` when Phase 3 inputs (reason labels, assignment) do
 * not exist yet; such cases are flagged `provisional` everywhere and a real run refuses them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Assignment,
  Candidate,
  Order as OrderSchema,
  type Order as OrderT,
  Pins,
  type RevertCase,
  RevertCases,
  SynCase,
} from '@dnr/schemas';
import { z } from 'zod';
import { matchesSha, type Namespace } from './arms';
import type { TrialPaths } from './env';

export interface TrialCase {
  revert_sha: string;
  original_sha: string;
  repo: RevertCase['repo'];
  role: RevertCase['role'];
  rdelta_sha: string | null;
  units: Array<{ file: string; qualname: string }>;
  committed_at: string;
  restored_tests: RevertCase['restored_tests'];
  python: string | null;
  env_ok: boolean | null;
  tickets: string[];
  /** Built from candidates.jsonl for a dry run, not from Phase 3 inputs. */
  provisional: boolean;
  /** SYN only: the author's critical edit. */
  syn?: z.infer<typeof SynCase>;
}

const DEMO = new Set([
  '43933a1dca07047e95ec990d9289d0212668009e',
  'd0e4dd5cdd743a5c43c4ccc2c8fa29d3982eaa71',
]);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadPins(root: string): z.infer<typeof Pins> | null {
  const p = join(root, 'fixtures/pins.json');
  return existsSync(p) ? Pins.parse(readJson(p)) : null;
}

export function loadAssignment(root: string): z.infer<typeof Assignment> {
  const p = join(root, 'fixtures/assignment.json');
  return existsSync(p) ? Assignment.parse(readJson(p)) : [];
}

function toCase(rc: RevertCase, role: RevertCase['role']): TrialCase {
  return {
    revert_sha: rc.revert_sha,
    original_sha: rc.original_sha,
    repo: rc.repo,
    role,
    rdelta_sha: rc.rdelta_sha,
    units: rc.units,
    committed_at: rc.committed_at,
    restored_tests: rc.restored_tests,
    python: rc.python,
    env_ok: rc.env_ok,
    tickets: rc.tickets,
    provisional: false,
  };
}

/** Every committed case with its role from assignment.json (roles in reverts.json are ignored). */
export function loadCases(root: string): TrialCase[] {
  const roles = new Map(loadAssignment(root).map((a) => [a.revert_sha, a.role]));
  const out: TrialCase[] = [];
  const fx = join(root, 'fixtures');
  if (existsSync(fx))
    for (const f of readdirSync(fx)
      .filter((f) => /^reverts(\.[a-z0-9]+)?\.json$/.test(f))
      .sort())
      for (const rc of RevertCases.parse(readJson(join(fx, f))))
        out.push(toCase(rc, roles.get(rc.revert_sha) ?? null));
  const syn = join(fx, 'syn/cases.json');
  if (existsSync(syn))
    for (const sc of z.array(SynCase).parse(readJson(syn))) out.push({ ...toCase(sc, 'synthetic'), syn: sc });
  return out;
}

export function loadCandidates(root: string, repo = 'django'): Array<z.infer<typeof Candidate>> {
  const p = join(root, repo === 'django' ? 'fixtures/candidates.jsonl' : `fixtures/candidates.${repo}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => Candidate.parse(JSON.parse(l)));
}

/**
 * Dry-run fallback: a provisional case from a mined candidate that passes E1–E5 and E7 (E6 may
 * be pending). Role: demo for the two demo reverts, tune for practice, else trial.
 */
export function provisionalCase(root: string, prefix: string, ns: Namespace | null): TrialCase | null {
  const c = loadCandidates(root).find((x) => matchesSha(x.revert_sha, prefix));
  if (!c?.original_sha) return null;
  const blocking = (['E1', 'E2', 'E3', 'E4', 'E5', 'E7'] as const).filter((r) => c.rules[r] === 'fail');
  if (blocking.length > 0) return null;
  const role: RevertCase['role'] = DEMO.has(c.revert_sha) ? 'demo' : ns === 'practice' ? 'tune' : 'trial';
  return {
    revert_sha: c.revert_sha,
    original_sha: c.original_sha,
    repo: c.repo,
    role,
    rdelta_sha: null,
    units: c.units,
    committed_at: c.committed_at,
    restored_tests: {
      paths: [],
      labels: [],
      fails_post_revert: null,
      passes_on_original: null,
      valid: false,
    },
    python: null,
    env_ok: null,
    tickets: c.tickets,
    provisional: true,
  };
}

/** Orders of the trial order store (`reports/orders`), validated. */
export function loadOrders(dir: string): OrderT[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^dnr-[0-9a-f]{10}\.json$/.test(f))
    .sort()
    .map((f) => OrderSchema.parse(readJson(join(dir, f))));
}

export function trialOrdersDir(paths: TrialPaths): string {
  return join(paths.root, 'reports', 'orders');
}

/** Git dir that holds a case's history (§7 RevertCase.repo). */
export function gitDirOf(paths: TrialPaths, repo: string): string | null {
  if (repo === 'django') return paths.djangoSrc;
  if (repo === 'cpython' || repo === 'sympy') return paths.secondSrc;
  if (repo === 'syn')
    return existsSync(join(paths.trialRoot, 'syn-src', '.git')) ? join(paths.trialRoot, 'syn-src') : null;
  return null;
}

/**
 * Mined reverts that get an order in every run's order set (§9.3): every candidate that passes
 * E1–E5 and E7, whatever its role. Returns revert SHAs.
 */
export function orderSetPool(root: string, repo = 'django'): Set<string> {
  const pool = new Set<string>();
  // SYN runs see the real Django orders that are ancestors of the fork base (§9.10).
  for (const c of loadCandidates(root, repo === 'syn' ? 'django' : repo)) {
    if (c.window === null) continue;
    if ((['E1', 'E2', 'E3', 'E4', 'E5', 'E7'] as const).every((r) => c.rules[r] === 'pass'))
      pool.add(c.revert_sha);
  }
  return pool;
}
