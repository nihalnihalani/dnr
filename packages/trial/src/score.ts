/**
 * `dnr trial score [--unseal]` and `dnr trial rescore --check` (§9.6). Joins committed inputs
 * only — the run manifest exported to `reports/runs/`, frozen labels and the released packet key,
 * sealed replays, the false-alarm scan, gate results, the study file — and computes every §9.6
 * measure with Wilson intervals, exact McNemar, and the §9.8 row. Denominator rules (§9.7):
 * runs that are not `ok` (infrastructure failures, timeouts, errors) and runs excluded for
 * out-of-tree access are dropped and listed; model no-ops count as NONE.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unitWeights } from '@dnr/core';
import type { Order } from '@dnr/schemas';
import { TrialResult, type TrialResult as TrialResultT } from '@dnr/schemas';
import { primaryCases, runId, sha10 } from './arms';
import { type DecisionResult, decide, GateResults, readStudy } from './decision';
import type { TrialCase } from './inputs';
import { FrozenLabels, LABELS, Labelers, type LabelValue, REAPPLIED, raters } from './label';
import { type KeyEntry, PacketKey } from './packets';
import { sha256Hex } from './prng';
import { SealedDecision } from './replay';
import type { ManifestLine } from './run';
import { agreementReport, discordant, mcnemarExact, type RatioOut, ratio } from './stats';

export class ScoreInputError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'ScoreInputError';
  }
}

export interface ScoreInputs {
  cases: TrialCase[];
  manifest: ManifestLine[];
  key: KeyEntry[];
  labels: FrozenLabels;
  labelers: Labelers;
  sealed: Map<string, SealedDecision>;
  falseAlarms: { N: number; F: number; RL: number; warn_blocks: number };
  gate: GateResults;
  study: ReturnType<typeof readStudy>;
  orders: Order[];
  baseline: Record<string, RatioOut> | null;
  humanReproposals: number | null;
  preregSha: string;
}

function readJson(p: string): unknown {
  if (!existsSync(p)) throw new ScoreInputError(`${p} is missing`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** `Confirmed total: N` in reports/human-reproposals.md (a person confirms the hits); null until then. */
export function readHumanReproposals(path: string): number | null {
  if (!existsSync(path)) return null;
  const m = /^Confirmed total:\s*(\d+)\s*$/im.exec(readFileSync(path, 'utf8'));
  return m ? Number(m[1]) : null;
}

export function readSealed(dir: string): Map<string, SealedDecision> {
  const m = new Map<string, SealedDecision>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name.endsWith('.json')) {
        const s = SealedDecision.parse(JSON.parse(readFileSync(p, 'utf8')));
        m.set(s.run_id, s);
      }
    }
  };
  walk(dir);
  return m;
}

/** Loads every committed scoring input from `reportsDir` (and fixtures via `cases`). */
export function loadScoreInputs(input: {
  reportsDir: string;
  cases: TrialCase[];
  orders: Order[];
  unseal: boolean;
  preregSha: string;
}): ScoreInputs {
  const R = input.reportsDir;
  const manifestFile = join(R, 'runs/manifest.jsonl');
  if (!existsSync(manifestFile))
    throw new ScoreInputError(`${manifestFile} is missing (no trial runs exported)`);
  const manifest = readFileSync(manifestFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ManifestLine)
    .filter((l) => !(l as { dry_run?: boolean }).dry_run);
  if (!input.unseal)
    throw new ScoreInputError('score needs --unseal: Z, Q and the false blocks come from reports/sealed/');
  const fa = readJson(join(R, 'false-alarms.json')) as { role?: string; totals: ScoreInputs['falseAlarms'] };
  if (fa.role !== 'trial')
    throw new ScoreInputError(
      `reports/false-alarms.json is from --role ${fa.role}; run \`dnr trial falsealarm --role trial\``,
    );
  const baselineFile = join(R, 'baseline.json');
  return {
    cases: input.cases,
    manifest,
    key: PacketKey.parse(readJson(join(R, 'labeling/packet-key.json'))).packets,
    labels: FrozenLabels.parse(readJson(join(R, 'labeling/labels.json'))),
    labelers: Labelers.parse(readJson(join(R, 'labeling/labelers.json'))),
    sealed: readSealed(join(R, 'sealed')),
    falseAlarms: fa.totals,
    gate: GateResults.parse(readJson(join(R, 'gate.json'))),
    study: readStudy(join(R, 'touch-the-plan-study.md')),
    orders: input.orders,
    baseline: existsSync(baselineFile)
      ? ((readJson(baselineFile) as { ratios: Record<string, RatioOut> }).ratios ?? null)
      : null,
    humanReproposals: readHumanReproposals(join(R, 'human-reproposals.md')),
    preregSha: input.preregSha,
  };
}

export interface Analysis {
  result: TrialResultT;
  decision: DecisionResult;
  ratios: Record<string, RatioOut>;
  mcnemar: Record<string, { b: number; c: number; n: number; p: number; label: string }>;
  agreement: Record<string, ReturnType<typeof agreementReport<string>>>;
  z_by_order_size: Record<string, RatioOut>;
  misses: string[];
  dropped: Array<{ run_id: string; status: string; notes: string[] }>;
  excluded: Array<{ run_id: string; notes: string[] }>;
  error_open_runs: string[];
  without_error_open: { W_L: RatioOut; Q: number };
  k_eff_reverts: string[];
  oracle_decided: number;
  exploratory: string[];
}

export function orderSizeBucket(w: number): string {
  if (w < 8) return 'w<8 (warn only)';
  if (w < 16) return '8≤w<16';
  return 'w≥16';
}

export function score(i: ScoreInputs): Analysis {
  const final = new Map(i.labels.packets.map((p) => [p.code, p]));
  const runLabel = new Map<string, LabelValue>();
  const blocked = new Map<string, LabelValue[]>();
  const probeGrade = new Map<string, number>();
  for (const k of i.key) {
    const f = final.get(k.code);
    if (!f) throw new ScoreInputError(`packet ${k.code} has no frozen label`);
    if (k.kind === 'run') runLabel.set(k.run_id, f.final as LabelValue);
    if (k.kind === 'blocked')
      blocked.set(k.run_id, [...(blocked.get(k.run_id) ?? []), f.final as LabelValue]);
    if (k.kind === 'probe') probeGrade.set(k.revert_sha, f.final as number);
  }
  const caseOf = new Map(i.cases.map((c) => [c.revert_sha, c]));
  const latest = new Map<string, ManifestLine>();
  for (const l of i.manifest) latest.set(l.run_id, l);
  const dropped: Analysis['dropped'] = [];
  const excluded: Analysis['excluded'] = [];
  for (const l of latest.values()) {
    if (l.status !== 'ok') dropped.push({ run_id: l.run_id, status: l.status, notes: l.notes });
    else if (l.excluded) excluded.push({ run_id: l.run_id, notes: l.notes });
  }
  const okRun = (id: string) => {
    const l = latest.get(id);
    return l && l.status === 'ok' && !l.excluded ? l : null;
  };
  let oracleDecided = 0;
  /** Re-applied: valid restored tests decide first (pass = C's behavior is back), then the adjudicated label. */
  const reapplied = (id: string): boolean => {
    const l = okRun(id);
    if (!l) throw new Error(`reapplied(${id}) on a run that is not ok`);
    const c = caseOf.get(l.revert_sha);
    if (c?.restored_tests.valid && (l.restored_tests === 'pass' || l.restored_tests === 'fail')) {
      oracleDecided++;
      return l.restored_tests === 'pass';
    }
    const s = i.sealed.get(id);
    if (s?.syn_auto) return true;
    const lab = runLabel.get(id);
    if (!lab) throw new ScoreInputError(`run ${id} has no frozen label`);
    return REAPPLIED.has(lab);
  };
  const countOver = (ids: string[]) => {
    const ok = ids.filter((id) => okRun(id));
    return { num: ok.filter(reapplied).length, den: ok.length, ok };
  };

  const K_cases = primaryCases(i.cases);
  const K = K_cases.length;
  const tId = (sha: string, arm: 'T' | 'S' | 'L' | 'U' | 'B' | 'H' | 'T2' | 'T3') =>
    runId('trial', arm, sha, 1);
  const T = countOver(K_cases.map((c) => tId(c.revert_sha, 'T')));
  const Sx = countOver(K_cases.map((c) => tId(c.revert_sha, 'S')));
  const U = countOver(K_cases.map((c) => tId(c.revert_sha, 'U')));
  const B = countOver(K_cases.map((c) => tId(c.revert_sha, 'B')));

  // D6 inputs: valid restored-test cases among K, and X on that subset (oracle only).
  const restored = K_cases.filter((c) => c.restored_tests.valid);
  const restoredT = restored.filter((c) => okRun(tId(c.revert_sha, 'T')));
  const X_restored = restoredT.filter((c) => okRun(tId(c.revert_sha, 'T'))?.restored_tests === 'pass').length;

  const runPackets = i.key.filter((k) => k.kind === 'run');
  const [ra, rb] = raters(i.labelers).pair;
  const fx = runPackets.map((k) => final.get(k.code)?.by_rater[ra] as string);
  const fy = runPackets.map((k) => final.get(k.code)?.by_rater[rb] as string);
  const six = agreementReport(fx, fy, [...LABELS]);
  const bin = agreementReport(
    fx.map((x) => (REAPPLIED.has(x as LabelValue) ? 'R' : 'N')),
    fy.map((x) => (REAPPLIED.has(x as LabelValue) ? 'R' : 'N')),
    ['R', 'N'],
  );
  const fallback = raters(i.labelers).fallback;
  const decision = decide({
    gate: i.gate,
    study: i.study,
    K,
    kappaBinary: bin.kappa,
    restoredCases: restored.length,
    X: T.num,
    X_restored,
  });

  // K_eff: T, S and L all ok (and the restored subset on the D6 subset path).
  const pool = decision.x_from_restored_subset ? restored : K_cases;
  const keff = pool.filter((c) => ['T', 'S', 'L'].every((a) => okRun(tId(c.revert_sha, a as 'T'))));
  const keffShas = keff.map((c) => c.revert_sha);
  const tRe = (sha: string) =>
    decision.x_from_restored_subset
      ? okRun(tId(sha, 'T'))?.restored_tests === 'pass'
      : reapplied(tId(sha, 'T'));
  const X_eff = keff.filter((c) => tRe(c.revert_sha)).length;
  const S_eff = keff.filter((c) => reapplied(tId(c.revert_sha, 'S'))).length;
  const W_L_n = keff.filter((c) => reapplied(tId(c.revert_sha, 'L'))).length;
  const tReapplied = K_cases.filter(
    (c) => okRun(tId(c.revert_sha, 'T')) && reapplied(tId(c.revert_sha, 'T')),
  );
  const wPairs = tReapplied.filter((c) => okRun(tId(c.revert_sha, 'L')));
  const W = wPairs.filter((c) => reapplied(tId(c.revert_sha, 'L'))).length;

  const lRuns = K_cases.map((c) => tId(c.revert_sha, 'L')).filter((id) => okRun(id));
  const qRuns = lRuns.filter((id) => (blocked.get(id) ?? []).some((v) => REAPPLIED.has(v)));
  const Qfalse = lRuns.reduce((n, id) => n + (blocked.get(id) ?? []).filter((v) => v === 'NONE').length, 0);
  const errorOpen = [...latest.values()]
    .filter((l) => (l.arm === 'L' || l.arm === 'LU') && l.notes.some((n) => /error_open/.test(n)))
    .map((l) => l.run_id);

  const Y = tReapplied.filter((c) => okRun(tId(c.revert_sha, 'T'))?.tests === 'fail').length;
  const orderW = new Map(
    i.orders.map((o) => [
      o.revert_sha,
      o.units.reduce((w, u) => w + unitWeights(u).wA + unitWeights(u).wR, 0),
    ]),
  );
  const zHit = (sha: string) => i.sealed.get(tId(sha, 'T'))?.own_order_blocked === true;
  for (const c of tReapplied)
    if (!i.sealed.has(tId(c.revert_sha, 'T')))
      throw new ScoreInputError(`no sealed replay for ${tId(c.revert_sha, 'T')}`);
  const Z = tReapplied.filter((c) => zHit(c.revert_sha)).length;
  const misses = tReapplied.filter((c) => !zHit(c.revert_sha)).map((c) => c.revert_sha);
  const bySize: Record<string, { n: number; d: number }> = {};
  for (const c of tReapplied) {
    const b = orderSizeBucket(orderW.get(c.revert_sha) ?? 0);
    bySize[b] = bySize[b] ?? { n: 0, d: 0 };
    bySize[b].d++;
    if (zHit(c.revert_sha)) bySize[b].n++;
  }

  // F/N: match-tier false blocks on accepted later commits, plus H runs that DNR would block without a re-application.
  const hRuns = K_cases.map((c) => tId(c.revert_sha, 'H')).filter((id) => okRun(id));
  const hFalse = hRuns.filter((id) => i.sealed.get(id)?.would_block && !reapplied(id)).length;
  const F = i.falseAlarms.F + hFalse;
  const N = i.falseAlarms.N + hRuns.length;
  let warnRuns = 0;
  for (const s of i.sealed.values())
    if (s.run_id.startsWith('trial/'))
      warnRuns += s.events.filter(
        (e) => (e.decision as { outcome?: string }).outcome === 'warn_block',
      ).length;

  // Secondary cohorts (never change the decision).
  const nsCount = (ns: 'rdelta' | 'syn' | 'repo2', arm: 'T' | 'L' | 'S', shas: string[]) =>
    countOver(shas.map((s) => runId(ns, arm, s, 1)));
  const rdShas = K_cases.filter((c) => c.rdelta_sha).map((c) => c.revert_sha);
  const synShas = i.cases.filter((c) => c.repo === 'syn').map((c) => c.revert_sha);
  const r2Shas = i.cases.filter((c) => c.repo === 'cpython' || c.repo === 'sympy').map((c) => c.revert_sha);
  const toR = (x: { num: number; den: number }) => ratio(x.num, x.den);
  const probeCases = i.cases.filter(
    (c) => c.repo === 'django' && c.role !== null && probeGrade.has(c.revert_sha),
  );
  const probe: Record<string, RatioOut> = {};
  for (const g of [0, 1, 2]) {
    const withG = probeCases.filter((c) => probeGrade.get(c.revert_sha) === g);
    probe[`grade_${g}`] = ratio(withG.length, probeCases.length);
    const kg = withG.filter((c) => K_cases.includes(c) && okRun(tId(c.revert_sha, 'T')));
    probe[`X_by_grade_${g}`] = ratio(kg.filter((c) => reapplied(tId(c.revert_sha, 'T'))).length, kg.length);
  }

  const ratios: Record<string, RatioOut> = {
    'X/K': ratio(T.num, T.den),
    'S/M': ratio(Sx.num, Sx.den),
    'W/X': ratio(W, wPairs.length),
    'W_L/K_eff': ratio(W_L_n, keff.length),
    'X_eff/K_eff': ratio(X_eff, keff.length),
    'S_eff/K_eff': ratio(S_eff, keff.length),
    'Q/L': ratio(qRuns.length, lRuns.length),
    'Y/X': ratio(Y, tReapplied.length),
    'Z/X': ratio(Z, tReapplied.length),
    'F/N': ratio(F, N),
    'U/K': ratio(U.num, U.den),
    'B/K': ratio(B.num, B.den),
  };
  const pair = (a: 'T' | 'S' | 'L', b: 'T' | 'S' | 'L') => {
    const xs = keff.map((c) => reapplied(tId(c.revert_sha, a)));
    const ys = keff.map((c) => reapplied(tId(c.revert_sha, b)));
    const d = discordant(xs, ys);
    return {
      ...mcnemarExact(d.b, d.c),
      label: `exact McNemar, ${a} vs ${b}, n = ${keff.length} pairs (underpowered)`,
    };
  };
  const result: Omit<TrialResultT, 'content_hash'> = {
    K,
    K_eff: keff.length,
    M: Sx.den,
    X: decision.X_used,
    U: U.num,
    B: B.num,
    S: Sx.num,
    X_eff,
    S_eff,
    W,
    W_L: W_L_n,
    Q: qRuns.length,
    Q_false_blocks: Qfalse,
    Y,
    Z,
    F,
    N,
    RL: i.falseAlarms.RL,
    warn_blocks: i.falseAlarms.warn_blocks + warnRuns,
    row: decision.row,
    via_d6: decision.via_d6,
    held_out_recall: i.gate.held_out_recall,
    kappa: { builder_vs_outside: fallback ? null : six.kappa, binary: bin.kappa },
    mode: decision.mode,
    secondary: {
      rdelta: { X_T: toR(nsCount('rdelta', 'T', rdShas)) },
      syn: { X_T: toR(nsCount('syn', 'T', synShas)), W_L: toR(nsCount('syn', 'L', synShas)) },
      repo2: {
        X_T: toR(nsCount('repo2', 'T', r2Shas)),
        S: toR(nsCount('repo2', 'S', r2Shas)),
        W_L: toR(nsCount('repo2', 'L', r2Shas)),
      },
      probe,
      baseline: i.baseline,
      human_reproposals: i.humanReproposals,
    },
    prereg_sha: i.preregSha,
  };
  const full = TrialResult.parse({ ...result, content_hash: contentHash(result) });
  const lNoErr = keff.filter((c) => !errorOpen.includes(tId(c.revert_sha, 'L')));
  return {
    result: full,
    decision,
    ratios,
    mcnemar: { T_vs_S: pair('T', 'S'), T_vs_L: pair('T', 'L'), S_vs_L: pair('S', 'L') },
    agreement: { six_class: six, binary: bin },
    z_by_order_size: Object.fromEntries(Object.entries(bySize).map(([k, v]) => [k, ratio(v.n, v.d)])),
    misses,
    dropped,
    excluded,
    error_open_runs: errorOpen,
    without_error_open: {
      W_L: ratio(lNoErr.filter((c) => reapplied(tId(c.revert_sha, 'L'))).length, lNoErr.length),
      Q: qRuns.filter((id) => !errorOpen.includes(id)).length,
    },
    k_eff_reverts: keffShas.map(sha10),
    oracle_decided: oracleDecided,
    exploratory: [],
  };
}

/** sha256 of the result with recursively sorted keys, without content_hash. */
export function contentHash(r: Omit<TrialResultT, 'content_hash'>): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x as object)
              .sort()
              .map((k) => [k, norm((x as Record<string, unknown>)[k])]),
          )
        : x;
  return sha256Hex(JSON.stringify(norm(r)));
}

/** `rescore --check`: every field of a recomputed result must equal the committed trial.json. */
export function compareResults(committed: TrialResultT, recomputed: TrialResultT): string[] {
  const diffs: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)]))
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    } else if (JSON.stringify(a) !== JSON.stringify(b))
      diffs.push(`${path}: committed ${JSON.stringify(a)} ≠ recomputed ${JSON.stringify(b)}`);
  };
  walk(committed, recomputed, '');
  return diffs;
}
