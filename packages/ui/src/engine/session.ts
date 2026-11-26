/**
 * The /play session simulator (plan §10 "Send write"). Pure and DOM-free, so the browser and the
 * node parity test (P9) run exactly the same code over different grammar loaders.
 *
 * It keeps a fixed baseline (the post-revert texts), the current session state, the warned set,
 * grants and a simulated clock. A denied write (block, ask, warn_block, deny) is not applied, as
 * in Kiro; an allowed one is.
 */
import {
  createState,
  type DecideResult,
  decide,
  diffTokens,
  materialFromTexts,
  type OrderMaterial,
  type OrderScore,
  type ParserProvider,
  UnitCache,
} from '@dnr/core';
import type { CaseBundle, Decision, Order } from '@dnr/schemas';
import { type HookOutput, hookOutput } from './output';

export interface SimGrant {
  order_id: string;
  granted_at: number;
  expires_at: number;
}

export interface SimState {
  /** Session state: path → text. Starts at the baseline. */
  files: Record<string, string>;
  warned: string[];
  grants: SimGrant[];
  /** Orders whose grant was used this session (a used grant applies for the rest of the session). */
  grants_used: string[];
  /** Simulated clock, ms. */
  now: number;
  decision_format: 'deny' | 'ask';
}

export interface WriteResult {
  path: string;
  decision: Decision;
  output: HookOutput;
  applied: boolean;
  scores: OrderScore[];
  /** Qualnames of the order units involved (for the stderr "in …" clause). */
  qualnames: string[];
}

export const SEVERITY: Record<Decision['outcome'], number> = {
  deny_protected: 9,
  block: 8,
  ask: 7,
  ask_denied: 6,
  warn_block: 5,
  error_open: 4,
  allow_grant: 3,
  ask_approved: 3,
  warn_pass: 2,
  record: 1,
  allow: 0,
};

export function baselineFiles(bundle: CaseBundle): Record<string, string> {
  return Object.fromEntries(bundle.files.map((f) => [f.path, f.baseline_text]));
}

export function initialState(bundle: CaseBundle, now = Date.parse('2026-11-26T12:00:00Z')): SimState {
  return {
    files: baselineFiles(bundle),
    warned: [],
    grants: [],
    grants_used: [],
    now,
    decision_format: 'deny',
  };
}

/** Same session, fresh: back to the baseline, warned and used grants cleared; grants and clock kept. */
export function newSession(bundle: CaseBundle, s: SimState): SimState {
  return { ...s, files: baselineFiles(bundle), warned: [], grants_used: [] };
}

export class CaseEngine {
  readonly cache: UnitCache;
  private mat: OrderMaterial | null = null;
  constructor(
    readonly provider: ParserProvider,
    readonly bundle: CaseBundle,
  ) {
    this.cache = new UnitCache(provider);
  }

  /** Order material (C and post-revert units), built on first use: it parses every order file twice. */
  get material(): OrderMaterial {
    if (!this.mat) {
      const byPath = new Map(this.bundle.files.map((f) => [f.path, f]));
      this.mat = materialFromTexts(
        this.provider,
        this.bundle.order,
        (p) => byPath.get(p)?.change_text ?? null,
        (p) => byPath.get(p)?.baseline_text ?? null,
      );
    }
    return this.mat;
  }

  grantApplies(s: SimState, orderId: string): boolean {
    if (s.grants_used.includes(orderId)) return true;
    return s.grants.some((g) => g.order_id === orderId && g.expires_at > s.now);
  }

  /** Decide one write against the session; returns the result and the next state. */
  send(
    s: SimState,
    order: Order,
    write: { path: string; proposed_text: string },
  ): { result: WriteResult; next: SimState } {
    const base = baselineFiles(this.bundle);
    const baseline = createState(base, this.cache);
    const current = createState(s.files, this.cache);
    const proposed = createState({ ...s.files, [write.path]: write.proposed_text }, this.cache);
    const searchFiles = Object.keys(s.files).filter((p) => !(p in base) || s.files[p] !== base[p]);
    let r: DecideResult;
    try {
      r = decide({
        target: write.path,
        orders: [{ order, material: this.material }],
        baseline,
        current,
        proposed,
        searchFiles,
        warned: s.warned,
        grantApplies: (id) => this.grantApplies(s, id),
        config: { decision_format: s.decision_format },
        now: () => 0,
      });
    } catch (e) {
      // Fail open (§5.12), exactly as the hook does.
      r = {
        decision: {
          outcome: 'error_open',
          tier: 'none',
          order_id: null,
          edit_score: null,
          prox_score: null,
          fired_by: null,
          scope: 'order',
          breakdown: [{ error: (e as Error).message }],
          reason_line: null,
          latency_ms: 0,
          fast_path: false,
        },
        effects: { warn: null, grantsUsed: [] },
        scores: [],
      };
    }
    const qualnames = order.units.filter((u) => u.file === write.path).map((u) => u.qualname);
    const output = hookOutput(order, r.decision, { qualnames, format: s.decision_format });
    const applied = output.exitCode === 0 && output.permission !== 'ask';
    const next: SimState = {
      ...s,
      files: applied ? { ...s.files, [write.path]: write.proposed_text } : s.files,
      warned: r.effects.warn ? [...new Set([...s.warned, r.effects.warn])] : s.warned,
      grants_used: [...new Set([...s.grants_used, ...r.effects.grantsUsed])],
    };
    return {
      result: { path: write.path, decision: r.decision, output, applied, scores: r.scores, qualnames },
      next,
    };
  }

  /** Send every write of a preset in order. */
  sendAll(
    s: SimState,
    order: Order,
    writes: ReadonlyArray<{ path: string; proposed_text: string }>,
  ): { results: WriteResult[]; next: SimState } {
    const results: WriteResult[] = [];
    let cur = s;
    for (const w of writes) {
      const { result, next } = this.send(cur, order, w);
      results.push(result);
      cur = next;
    }
    return { results, next: cur };
  }
}

/** The most severe result of a sequence (the headline decision). */
export function headline(results: readonly WriteResult[]): WriteResult | null {
  let best: WriteResult | null = null;
  for (const r of results)
    if (!best || SEVERITY[r.decision.outcome] > SEVERITY[best.decision.outcome]) best = r;
  return best;
}

/** A stable summary of a decision, for the parity test (latency excluded). */
export function decisionKey(r: WriteResult) {
  return {
    path: r.path,
    outcome: r.decision.outcome,
    tier: r.decision.tier,
    order_id: r.decision.order_id,
    edit_score: r.decision.edit_score === null ? null : Number(r.decision.edit_score.toFixed(6)),
    fired_by: r.decision.fired_by,
    exit_code: r.output.exitCode,
    stderr: r.output.stderr,
    applied: r.applied,
  };
}

export interface UnitHits {
  file: string;
  qualname: string;
  hitA: boolean[];
  hitR: boolean[];
}

/** Which A and R tokens of each order unit the proposed state reproduces (multiset intersection), for highlighting. */
export function matchedTokens(
  engine: CaseEngine,
  order: Order,
  proposedFiles: Record<string, string>,
  scores: readonly OrderScore[],
): UnitHits[] {
  const base = createState(baselineFiles(engine.bundle), engine.cache);
  const prop = createState(proposedFiles, engine.cache);
  const score = scores.find((s) => s.order_id === order.id);
  return order.units.map((u) => {
    const us = score?.units.find((x) => x.file === u.file && x.qualname === u.qualname);
    const at = us?.relocated_to ?? { file: u.file, qualname: u.qualname };
    const before = base.units(u.file)?.units.get(u.qualname)?.tokens ?? [];
    const after = prop.units(at.file)?.units.get(at.qualname)?.tokens ?? [];
    const d = diffTokens(before, after);
    const flags = (xs: readonly string[], ys: readonly string[]) => {
      const m = new Map<string, number>();
      for (const y of ys) m.set(y, (m.get(y) ?? 0) + 1);
      return xs.map((x) => {
        const c = m.get(x) ?? 0;
        if (c > 0) m.set(x, c - 1);
        return c > 0;
      });
    };
    return { file: u.file, qualname: u.qualname, hitA: flags(u.A, d.A), hitR: flags(u.R, d.R) };
  });
}
