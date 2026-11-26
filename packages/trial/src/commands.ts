/**
 * `dnr trial prepare|run|envs|label|replay|score|rescore|report|probe|baseline|prereg` (§8).
 * The CLI package wires these in (`packages/cli/src/commands/trial.ts`) and passes its I/O.
 * Exit codes: 0 clean, 1 incomplete runs, 64 usage, 65 invalid data, 69 dependency missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { git, runGit } from '@dnr/git';
import { type Order, TrialResult } from '@dnr/schemas';
import { matchesSha, type Namespace, type PlanCase, planRuns, type Selector, sha10 } from './arms';
import { generateRules, verifyRules } from './baseline';
import { layout, type TrialPaths, TrialRootError, trialPaths } from './env';
import { buildUvEnv, type EnvEntry, realExec, runTests, validateRestored } from './envs';
import {
  gitDirOf,
  loadCases,
  loadOrders,
  loadPins,
  provisionalCase,
  type TrialCase,
  trialOrdersDir,
} from './inputs';
import { adjudicate, freeze, Labelers, labelSession, raters } from './label';
import { lock, lockdownTargets, unlock } from './lockdown';
import { loadAnalyzer } from './mine/analyzer';
import { detectPython } from './mine/python-version';
import { computeRdelta } from './mine/rdelta';
import { planTestLabels } from './mine/test-labels';
import {
  blockedProposals,
  loadCriticalEdits,
  type PacketItem,
  readIndex,
  readPacket,
  renderPacket,
  revertContext,
  writePackets,
} from './packets';
import { type PrepareDeps, type Prepared, PrepareError, prepareAll, readPreparedIndex } from './prepare';
import { writePrereg } from './prereg';
import { probeAnswers, runProbe } from './probe';
import { replayAll } from './replay';
import { decisionMarkdown, trialMarkdown, videoNumbers } from './report';
import { AgentUnavailable, CONCURRENCY, RUN_TIMEOUT_MS, readManifest, runAll } from './run';
import { KiroRunner } from './runner';
import { compareResults, loadScoreInputs, ScoreInputError, score } from './score';

export const EXIT = { OK: 0, FINDINGS: 1, USAGE: 64, DATA: 65, DEPENDENCY: 69, INTERNAL: 70 } as const;

export interface TrialIO {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out(s: string): void;
  err(s: string): void;
  /** Interactive prompt (labeling). Absent in non-interactive contexts. */
  ask?: (question: string) => Promise<string | null>;
  deps: PrepareDeps;
}

class Usage extends Error {}
class Dependency extends Error {}

function flags(argv: string[], options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>) {
  try {
    return parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' }, ...options },
      allowPositionals: false,
      strict: true,
    }).values as Record<string, string | boolean | undefined>;
  } catch (e) {
    throw new Usage((e as Error).message);
  }
}

const NS = new Set(['trial', 'demo', 'practice', 'syn', 'rdelta', 'repo2', 'probe']);

function selectorOf(v: Record<string, unknown>): Selector {
  if (v.wave !== undefined && v.namespace !== undefined)
    throw new Usage('use --wave or --namespace, not both');
  if (v.wave !== undefined) {
    const w = Number(v.wave);
    if (![1, 2, 3].includes(w)) throw new Usage('--wave is 1, 2 or 3');
    return { wave: w as 1 | 2 | 3 };
  }
  let ns = v.namespace as string | undefined;
  if (v.stratum !== undefined) {
    if (v.stratum !== 'rdelta') throw new Usage('--stratum is rdelta');
    ns = 'rdelta';
  }
  if (v.cohort !== undefined) {
    if (v.cohort !== 'syn' && v.cohort !== 'repo2') throw new Usage('--cohort is syn or repo2');
    ns = v.cohort as string;
  }
  if (!ns)
    throw new Usage(
      'give --wave 1|2|3 or --namespace demo|practice|syn|repo2|rdelta (or --stratum/--cohort)',
    );
  if (!NS.has(ns) || ns === 'trial') throw new Usage(`unknown namespace ${ns}`);
  return { namespace: ns as Exclude<Namespace, 'trial'> };
}

/** Cases for a selection; a dry run with --only may use a provisional case from candidates.jsonl. */
async function casesFor(
  paths: TrialPaths,
  sel: Selector,
  only: string | undefined,
  log: (m: string) => void,
): Promise<TrialCase[]> {
  const cases = loadCases(paths.root);
  if (!only) return cases;
  const hit = cases.filter((c) => matchesSha(c.revert_sha, only));
  if (hit.length > 0) return hit;
  if (!paths.dryRun)
    throw new Usage(
      `--only ${only}: no such revert in fixtures/reverts.json (a real run needs Phase 3 inputs)`,
    );
  const ns = 'wave' in sel ? null : sel.namespace;
  const p = provisionalCase(paths.root, only, ns);
  if (!p) throw new Usage(`--only ${only}: not a mined candidate passing E1–E5 and E7`);
  if (ns === 'rdelta' || ('wave' in sel && sel.wave === 3)) {
    const gitDir = gitDirOf(paths, p.repo);
    if (!gitDir) throw new Dependency('DJANGO_SRC not found');
    const ref = loadPins(paths.root)?.django_sha ?? 'origin/main';
    p.rdelta_sha = await computeRdelta(gitDir, ref, p.revert_sha, p.units, await loadAnalyzer());
    log(
      `provisional rdelta_sha for ${sha10(p.revert_sha)}: ${p.rdelta_sha.slice(0, 10)} (computed from git, §9.2)`,
    );
  }
  if (ns === 'demo' && p.role !== 'demo') throw new Usage(`--only ${only} is not a demo revert`);
  log(
    `dry run: provisional case ${sha10(p.revert_sha)} from fixtures/candidates.jsonl (no Phase 3 inputs yet)`,
  );
  return [p];
}

/** Empty cohorts are missing human or upstream inputs, not usage errors. */
function requireRuns(sel: Selector, n: number): void {
  if (n > 0) return;
  if ('namespace' in sel && sel.namespace === 'syn')
    throw new Dependency(
      'no SYN cases: fixtures/syn/cases.json is written by the named SYN author (§9.10), then syn-src is cloned; nothing to run',
    );
  if ('namespace' in sel && sel.namespace === 'repo2')
    throw new Dependency(
      'no repo2 cases: needs SECOND_SRC, `dnr trial mine --repo cpython|sympy` and `trial assign --repo` (§9.11); nothing to run',
    );
  throw new Usage('no runs in this selection (check fixtures/assignment.json and --only)');
}

function planFor(sel: Selector, cases: TrialCase[], only: string | undefined) {
  const pc: PlanCase[] = cases.map((c) => ({
    revert_sha: c.revert_sha,
    repo: c.repo,
    role: c.role,
    rdelta_sha: c.rdelta_sha,
  }));
  return planRuns(sel, pc).filter((r) => !only || matchesSha(r.revert_sha, only));
}

function paths(io: TrialIO, dryRun: boolean): TrialPaths {
  if (!io.env.TRIAL_ROOT)
    throw new Dependency(
      'TRIAL_ROOT is not set: an absolute directory outside the dnr repo and not beside it, e.g. /var/tmp/dnr-trial (§9.3)',
    );
  try {
    return trialPaths(io.env, { dryRun });
  } catch (e) {
    if (e instanceof TrialRootError) throw new Usage(e.message);
    throw e;
  }
}

async function cmdPrepare(argv: string[], io: TrialIO): Promise<number> {
  const v = flags(argv, {
    wave: { type: 'string' },
    namespace: { type: 'string' },
    stratum: { type: 'string' },
    cohort: { type: 'string' },
    only: { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  if (v.help)
    return help(
      io,
      'dnr trial prepare [--wave 1|2|3 | --namespace trial|demo|practice|probe] [--stratum rdelta] [--cohort syn|repo2] [--only <sha>] [--dry-run]',
    );
  const P = paths(io, !!v['dry-run']);
  const sel = v.namespace === 'trial' ? ({ wave: 1 } as Selector) : selectorOf(v);
  const log = (m: string) => io.err(`[prepare] ${m}\n`);
  const cases = await casesFor(P, sel, v.only as string | undefined, log);
  const runs = planFor(sel, cases, v.only as string | undefined);
  requireRuns(sel, runs.length);
  const prepared = await prepareAll(
    {
      paths: P,
      env: io.env,
      pins: loadPins(P.root),
      cases: new Map(cases.map((c) => [c.revert_sha, c])),
      deps: { ...io.deps, log },
    },
    runs,
  );
  io.out(`DNR: prepared ${prepared.length} run(s) under ${P.trialRoot}\n`);
  return EXIT.OK;
}

async function cmdRun(argv: string[], io: TrialIO): Promise<number> {
  const v = flags(argv, {
    wave: { type: 'string' },
    namespace: { type: 'string' },
    concurrency: { type: 'string' },
    resume: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    only: { type: 'string' },
    unlock: { type: 'boolean' },
  });
  if (v.help)
    return help(
      io,
      'dnr trial run --wave 1|2|3 | --namespace demo|practice|syn|repo2|rdelta [--concurrency 4] [--resume] [--dry-run] [--only <sha>] | --unlock',
    );
  const dryRun = !!v['dry-run'];
  const P = paths(io, dryRun);
  if (v.unlock) {
    const n = await unlock(layout(P.trialRoot).lockdown, (m) => io.err(`${m}\n`));
    io.out(`DNR: restored ${n} path(s)\n`);
    return EXIT.OK;
  }
  const sel = selectorOf(v);
  const only = v.only as string | undefined;
  const log = (m: string) => io.err(`[run] ${m}\n`);
  const cases = await casesFor(P, sel, only, log);
  const planned = planFor(sel, cases, only);
  requireRuns(sel, planned.length);
  const idx = readPreparedIndex(P.trialRoot);
  let prepared: Prepared[];
  if (dryRun) {
    // A dry run does every real preparation step itself (truncated repo, clone, order set, HOME).
    prepared = await prepareAll(
      {
        paths: P,
        env: io.env,
        pins: loadPins(P.root),
        cases: new Map(cases.map((c) => [c.revert_sha, c])),
        deps: { ...io.deps, log },
      },
      planned,
    );
  } else {
    const missing = planned.filter((r) => !idx.has(r.run_id));
    if (missing.length)
      throw new Usage(
        `${missing.length} run(s) not prepared (run \`dnr trial prepare\` first): ${missing
          .slice(0, 5)
          .map((r) => r.run_id)
          .join(', ')}`,
      );
    prepared = planned.map((r) => idx.get(r.run_id) as Prepared);
  }
  const runner = new KiroRunner(io.env.KIRO_CLI ?? 'kiro-cli', io.env);
  const L = layout(P.trialRoot);
  let locked = false;
  try {
    if (!dryRun) {
      // Fail before locking anything if the agent CLI is missing.
      const ver = await runner.version(prepared[0]?.home ?? P.trialRoot);
      if (ver.startsWith('unavailable'))
        throw new AgentUnavailable(`kiro-cli is not available (${ver}); no trial run was started`);
      await lock(lockdownTargets(P), L.lockdown, (m) => io.err(`${m}\n`));
      locked = true;
    }
    const caseOf = new Map(cases.map((c) => [c.revert_sha, c]));
    const envMatrix = loadEnvMatrix(P);
    const s = await runAll(P.trialRoot, prepared, {
      dryRun,
      resume: !!v.resume,
      concurrency: v.concurrency ? Number(v.concurrency) : CONCURRENCY,
      timeoutMs: RUN_TIMEOUT_MS,
      runner,
      log,
      tests: async (p) => {
        const c = caseOf.get(p.revert_sha);
        const env = envMatrix.find((e) => e.revert_sha === p.revert_sha) ?? null;
        const gitDir = c ? gitDirOf(P, c.repo) : null;
        if (!c || !gitDir || !p.start_sha) return { tests: 'n/a', restored_tests: 'n/a' };
        const apps = (await planTestLabels(gitDir, c.original_sha, c.revert_sha)).apps;
        const t = await runTests(realExec, env, p.workdir, apps);
        const r = c.restored_tests.valid
          ? await runTests(realExec, env, p.workdir, c.restored_tests.labels)
          : null;
        return { tests: t.status, restored_tests: r ? r.status : 'n/a' };
      },
    });
    if (dryRun) {
      const bad = s.dryLines.filter((l) => Object.values(l.checks).some((x) => !x));
      io.out(
        `DNR: dry run: ${s.dryLines.length} run(s) prepared and checked; the agent was not run (no transcripts, no events). Manifest: ${L.manifest}\n`,
      );
      if (bad.length) {
        for (const b of bad)
          io.err(
            `DNR: ${b.run_id}: failed checks ${Object.entries(b.checks)
              .filter(([, x]) => !x)
              .map(([k]) => k)
              .join(', ')}\n`,
          );
        return EXIT.FINDINGS;
      }
      return EXIT.OK;
    }
    if (s.stoppedForDrift) io.err(`DNR: ${s.stoppedForDrift}\n`);
    if (s.notOk.length || s.stoppedForDrift) {
      for (const l of s.notOk) io.err(`DNR: ${l.run_id}: ${l.status} ${l.notes.join('; ')}\n`);
      return EXIT.FINDINGS;
    }
    io.out(`DNR: ${s.lines.length} run(s) ok, ${s.skipped.length} skipped (already ok)\n`);
    return EXIT.OK;
  } finally {
    if (locked) await unlock(L.lockdown, (m) => io.err(`${m}\n`));
  }
}

function loadEnvMatrix(P: TrialPaths): EnvEntry[] {
  const f = join(P.dryRun ? join(P.trialRoot, 'dry-fixtures') : join(P.root, 'fixtures'), 'env-matrix.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as EnvEntry[]) : [];
}

async function cmdEnvs(argv: string[], io: TrialIO): Promise<number> {
  const v = flags(argv, {
    repo: { type: 'string' },
    stratum: { type: 'string' },
    only: { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  if (v.help)
    return help(
      io,
      'dnr trial envs [--repo django|cpython|sympy|syn] [--stratum rdelta] [--only <sha>] [--dry-run]',
    );
  const P = paths(io, !!v['dry-run']);
  const repo = (v.repo as string | undefined) ?? 'django';
  if (repo !== 'django')
    throw new Dependency(
      `trial envs --repo ${repo}: CPython builds and sympy envs need SECOND_SRC and the repo2 cases (not mined yet); see packages/trial/src/repo2.ts`,
    );
  const only = v.only as string | undefined;
  const log = (m: string) => io.err(`[envs] ${m}\n`);
  const sel: Selector = v.stratum === 'rdelta' ? { namespace: 'rdelta' } : { wave: 1 };
  let cases = await casesFor(P, sel, only, log);
  cases = cases.filter((c) => c.repo === repo && c.role !== null);
  if (cases.length === 0) throw new Usage('no assigned cases (fixtures/assignment.json) for this selection');
  const table = existsSync(join(P.root, 'fixtures/django-python.json'))
    ? JSON.parse(readFileSync(join(P.root, 'fixtures/django-python.json'), 'utf8'))
    : undefined;
  const pins = loadPins(P.root);
  const fixturesOut = P.dryRun ? join(P.trialRoot, 'dry-fixtures') : join(P.root, 'fixtures');
  const matrix: EnvEntry[] = [];
  const flaky: Array<{ revert_sha: string; test: string }> = [];
  const validations: Record<string, unknown> = {};
  for (const c of cases) {
    const gitDir = gitDirOf(P, c.repo);
    if (!gitDir) throw new Dependency('DJANGO_SRC not found');
    const start = v.stratum === 'rdelta' ? c.rdelta_sha : c.revert_sha;
    if (!start) throw new Usage(`${sha10(c.revert_sha)} has no rdelta_sha`);
    const repoDir = layout(P.trialRoot).repos(start);
    const { buildTruncatedRepo } = await import('./repo');
    await buildTruncatedRepo(gitDir, start, repoDir);
    const py = await detectPython(gitDir, start, table);
    if (!py) {
      log(`${sha10(c.revert_sha)}: no Python version found`);
      continue;
    }
    const envDir = layout(P.trialRoot).envs(sha10(c.revert_sha));
    const date = (await git(['log', '-1', '--format=%cI', start], { cwd: gitDir })).trim();
    let entry: EnvEntry;
    if (py.kind === 'uv') {
      log(`${sha10(c.revert_sha)}: uv env, Python ${py.chosen} (${py.source}), --exclude-newer ${date}`);
      const r = await buildUvEnv({
        revertSha: c.revert_sha,
        python: py.chosen,
        kind: 'uv',
        checkout: repoDir,
        gitDir,
        startSha: start,
        excludeNewer: date,
        envDir,
        constraintsFile: '',
        docker: { images: {} },
        exec: realExec,
        log,
      });
      log(`${sha10(c.revert_sha)}: ${r.ok ? 'ok' : 'FAILED'}: ${r.note}`);
      entry = {
        revert_sha: c.revert_sha,
        kind: 'uv',
        python: py.chosen,
        path: envDir,
        image: null,
        ok: r.ok,
      };
    } else {
      const { buildDockerEnv } = await import('./envs');
      const r = await buildDockerEnv({
        revertSha: c.revert_sha,
        python: py.chosen,
        kind: 'docker',
        checkout: repoDir,
        gitDir,
        startSha: start,
        excludeNewer: date,
        envDir,
        constraintsFile: join(P.root, 'fixtures/constraints', `${sha10(c.revert_sha)}.txt`),
        docker: { images: pins?.docker_images ?? {} },
        exec: realExec,
        log,
      });
      log(`${sha10(c.revert_sha)}: docker: ${r.ok ? 'ok' : 'FAILED'}: ${r.note}`);
      entry = {
        revert_sha: c.revert_sha,
        kind: 'docker',
        python: py.chosen,
        path: envDir,
        image: r.image,
        ok: r.ok,
      };
    }
    matrix.push(entry);
    if (entry.ok) {
      const val = await validateRestored({
        exec: realExec,
        env: entry,
        repoDir,
        startSha: start,
        originalSha: c.original_sha,
        rdelta: v.stratum === 'rdelta',
        labels: c.restored_tests.labels,
      });
      validations[c.revert_sha] = val;
      for (const t of val.flaky) flaky.push({ revert_sha: c.revert_sha, test: t });
      log(`${sha10(c.revert_sha)}: restored tests: ${val.note}${val.valid ? ' (valid)' : ''}`);
    }
  }
  await mkdir(fixturesOut, { recursive: true });
  const name = v.stratum === 'rdelta' ? 'env-matrix.rdelta.json' : 'env-matrix.json';
  await writeFile(join(fixturesOut, name), `${JSON.stringify(matrix, null, 2)}\n`);
  await writeFile(
    join(fixturesOut, v.stratum === 'rdelta' ? 'flaky.rdelta.json' : 'flaky.json'),
    `${JSON.stringify(flaky, null, 2)}\n`,
  );
  await writeFile(join(fixturesOut, 'restored-validation.json'), `${JSON.stringify(validations, null, 2)}\n`);
  io.out(
    `DNR: ${matrix.filter((e) => e.ok).length}/${matrix.length} environment(s) ok; written to ${fixturesOut}\n`,
  );
  return matrix.every((e) => e.ok) ? EXIT.OK : EXIT.FINDINGS;
}

function readLabelers(P: TrialPaths): Labelers {
  const f = join(P.reportsDir, 'labeling/labelers.json');
  if (!existsSync(f))
    throw new Dependency(`${f} is missing: name the builder, outside labeler and adjudicator (§9.5)`);
  return Labelers.parse(JSON.parse(readFileSync(f, 'utf8')));
}

async function interactiveAnswer(io: TrialIO, P: TrialPaths, code: string, probe: boolean) {
  if (!io.ask) throw new Dependency('labeling is interactive; run it in a terminal');
  io.out(`\n${renderPacket(readPacket(P.labelingDir, code))}\n`);
  if (probe) {
    const g = await io.ask(
      'Grade 0 (no recognition), 1 (says changed and reverted, no correct detail), 2 (names the change or reason correctly), or q to stop: ',
    );
    if (g === null || g.trim() === 'q') return null;
    return { grade: Number(g.trim()) };
  }
  const l = await io.ask(
    'Label 1 FULL, 2 CORE, 3 PARTIAL_NONCORE, 4 NONE, 5 UNRELATED_BREAK, 6 NO_CHANGE (q to stop): ',
  );
  if (l === null || l.trim() === 'q') return null;
  const a = await io.ask('Arm guess (T, U, B, S, H, L, T2, T3, or blank): ');
  return { label: l, arm_guess: a ?? '' };
}

async function cmdLabel(argv: string[], io: TrialIO): Promise<number> {
  const v = flags(argv, {
    labeler: { type: 'string' },
    probe: { type: 'boolean' },
    blocked: { type: 'boolean' },
    reasons: { type: 'boolean' },
    'critical-edits': { type: 'boolean' },
    freeze: { type: 'boolean' },
    generate: { type: 'boolean' },
    adjudicate: { type: 'boolean' },
    relabel: { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  if (v.help)
    return help(
      io,
      'dnr trial label --generate | --labeler <name> [--probe|--blocked] [--relabel <session>] | --adjudicate --labeler <adjudicator> | --freeze  [--dry-run]',
    );
  if (v.reasons || v['critical-edits'])
    throw new Dependency(
      'reason labels use the mining packets (`dnr trial packets`, `dnr trial merge-reasons`); --critical-edits is not built yet',
    );
  const P = paths(io, !!v['dry-run']);
  const L = layout(P.trialRoot);
  const now = () => new Date().toISOString();
  if (v.generate) return generatePacketsCmd(io, P);
  if (v.freeze) {
    const f = await freeze({
      labelingDir: P.labelingDir,
      labelers: readLabelers(P),
      labelsOut: join(P.reportsDir, 'labeling/labels.json'),
      keyFile: L.sealedKey,
      shaFile: join(P.reportsDir, 'labeling/packet-key.sha256'),
      keyOut: join(P.reportsDir, 'labeling/packet-key.json'),
      now: now(),
    });
    io.out(
      `DNR: froze ${f.packets.length} packet label(s); key released to ${join(P.reportsDir, 'labeling/packet-key.json')}\n`,
    );
    return EXIT.OK;
  }
  const labeler = v.labeler as string | undefined;
  if (!labeler) throw new Usage('--labeler <name> is required');
  if (v.adjudicate) {
    const ls = readLabelers(P);
    if (labeler !== ls.adjudicator) throw new Usage(`only the adjudicator (${ls.adjudicator}) adjudicates`);
    const idx = new Map(readIndex(P.labelingDir).map((p) => [p.code, p.kind]));
    const n = await adjudicate({
      labelingDir: P.labelingDir,
      raters: raters(ls).pair,
      by: labeler,
      now,
      ask: (c) => interactiveAnswer(io, P, c, idx.get(c) === 'probe'),
    });
    io.out(`DNR: ${n} disagreement(s) adjudicated\n`);
    return EXIT.OK;
  }
  const kind = v.probe ? 'probe' : v.blocked ? 'blocked' : 'run';
  const session = `${now().replace(/[:.]/g, '-')}`;
  const r = await labelSession({
    labelingDir: P.labelingDir,
    labeler,
    kind,
    session,
    now,
    relabel: v.relabel as string | undefined,
    ask: (c) => interactiveAnswer(io, P, c, kind === 'probe'),
  });
  io.out(`DNR: session ${session}: ${r.labeled} labeled, ${r.remaining} remaining\n`);
  return r.remaining > 0 ? EXIT.FINDINGS : EXIT.OK;
}

/** Packets from real run outputs only: ok runs (manifest), their blocked proposals, and real probe answers. */
async function generatePacketsCmd(io: TrialIO, P: TrialPaths): Promise<number> {
  const L = layout(P.trialRoot);
  const idx = readPreparedIndex(P.trialRoot);
  const items: PacketItem[] = [];
  const cases = new Map(loadCases(P.root).map((c) => [c.revert_sha, c]));
  if (P.dryRun) {
    // Dry run: real (empty) working-copy diffs of dry-run runs; packets say the agent was not run.
    for (const l of readFileSync(L.manifest, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((x) => JSON.parse(x))) {
      if (!l.dry_run) continue;
      const p = idx.get(l.run_id);
      if (!p || p.namespace === 'probe') continue;
      items.push({
        kind: 'run',
        run_id: l.run_id,
        revert_sha: l.revert_sha,
        event_id: null,
        agent_diff: readFileSync(join(L.out(l.run_id), 'diff.patch'), 'utf8'),
        probe: null,
      });
    }
  } else {
    for (const l of readManifest(L.manifest)) {
      if (l.status !== 'ok' || l.namespace === 'probe' || l.namespace === 'demo') continue;
      const out = L.out(l.run_id);
      items.push({
        kind: 'run',
        run_id: l.run_id,
        revert_sha: l.revert_sha,
        event_id: null,
        agent_diff: readFileSync(join(out, 'diff.patch'), 'utf8'),
        probe: null,
      });
      if (l.arm === 'L')
        for (const b of blockedProposals(readFileSync(join(out, 'events.jsonl'), 'utf8')))
          items.push({
            kind: 'blocked',
            run_id: l.run_id,
            revert_sha: l.revert_sha,
            event_id: b.event_id,
            agent_diff: b.session_patch,
            probe: null,
          });
    }
    const probeShas = [...cases.values()]
      .filter((c) => c.repo === 'django' && c.role !== null)
      .map((c) => c.revert_sha);
    for (const a of probeAnswers(P.trialRoot, probeShas))
      items.push({
        kind: 'probe',
        run_id: a.run_id,
        revert_sha: a.revert_sha,
        event_id: null,
        agent_diff: '',
        probe: { pre_image: a.pre_image, answer: a.answer },
      });
  }
  if (items.length === 0) throw new Dependency('no runs to make packets from (no ok runs in the manifest)');
  const edits = loadCriticalEdits(P.root);
  const orders = loadOrders(trialOrdersDir(P));
  const keyFile = P.dryRun ? join(P.trialRoot, 'dry-sealed/packet-key.json') : L.sealedKey;
  const r = await writePackets({
    items,
    labelingDir: P.labelingDir,
    keyFile,
    shaFile: join(P.reportsDir, 'labeling/packet-key.sha256'),
    now: new Date().toISOString(),
    contextOf: async (sha) => {
      const p = [...idx.values()].find((x) => x.revert_sha === sha);
      const c = cases.get(sha);
      const repo = c?.repo ?? p?.repo ?? 'django';
      const gitDir = gitDirOf(P, repo);
      if (!gitDir) throw new Dependency(`git dir for ${repo} not found`);
      const original = c?.original_sha || (await provisionalOriginal(P, sha));
      const order = orders.find((o) => o.revert_sha === sha);
      return revertContext(gitDir, original, sha, order?.reason ?? null, edits);
    },
  });
  io.out(
    `DNR: ${r.key.packets.length} packet(s) in ${join(P.labelingDir, 'packets')}; commit the key's sha256 (${r.sha256}) before labeling\n`,
  );
  return EXIT.OK;
}

async function provisionalOriginal(P: TrialPaths, sha: string): Promise<string> {
  const c = provisionalCase(P.root, sha, null);
  if (!c) throw new Dependency(`no original commit known for ${sha}`);
  return c.original_sha;
}

async function cmdReplay(argv: string[], io: TrialIO): Promise<number> {
  const v = flags(argv, { 'dry-run': { type: 'boolean' } });
  if (v.help) return help(io, 'dnr trial replay');
  const P = paths(io, !!v['dry-run']);
  const L = layout(P.trialRoot);
  const labels = join(P.reportsDir, 'labeling/labels.json');
  if (!existsSync(labels))
    throw new Dependency('labels are not frozen: `dnr trial label --freeze` comes before replay (§9.5)');
  const idx = readPreparedIndex(P.trialRoot);
  const ok = readManifest(L.manifest).filter((l) => l.status === 'ok');
  const latest = new Map(ok.map((l) => [l.run_id, l]));
  const runs = [...latest.keys()]
    .map((id) => idx.get(id))
    .filter((p): p is Prepared => !!p && p.namespace !== 'probe');
  const cases = new Map(loadCases(P.root).map((c) => [c.revert_sha, c]));
  const s = await replayAll(P.trialRoot, P.reportsDir, runs, (p) => ({
    syn: cases.get(p.revert_sha)?.syn,
    restoredTests: latest.get(p.run_id)?.restored_tests,
  }));
  io.out(`DNR: ${s.length} run(s) replayed into ${join(P.reportsDir, 'sealed')}\n`);
  return EXIT.OK;
}

async function preregSha(root: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '-q', '--verify', 'prereg-v1^{commit}'], {
    cwd: root,
    okCodes: [0, 1, 128],
  });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Copies the manifest and per-run meta/diff into reports/runs/ so rescore needs only committed files. */
async function exportRuns(P: TrialPaths): Promise<void> {
  const L = layout(P.trialRoot);
  const lines = readManifest(L.manifest);
  await mkdir(join(P.reportsDir, 'runs'), { recursive: true });
  await writeFile(
    join(P.reportsDir, 'runs/manifest.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''),
  );
  for (const l of lines)
    for (const f of ['meta.json', 'diff.patch']) {
      const src = join(L.out(l.run_id), f);
      if (!existsSync(src)) continue;
      const dst = join(P.reportsDir, 'runs', l.run_id, f);
      await mkdir(dirname(dst), { recursive: true });
      await writeFile(dst, readFileSync(src));
    }
}

async function cmdScore(argv: string[], io: TrialIO, check = false): Promise<number> {
  const v = flags(argv, { unseal: { type: 'boolean' }, check: { type: 'boolean' } });
  if (v.help) return help(io, check ? 'dnr trial rescore --check' : 'dnr trial score --unseal');
  if (check && !v.check) throw new Usage('dnr trial rescore --check');
  const P = paths(io, false);
  const sha = await preregSha(P.root);
  if (!sha) throw new Dependency('tag prereg-v1 does not exist; scoring needs the pre-registration (§9.7)');
  if (!check) await exportRuns(P);
  const orders: Order[] = loadOrders(trialOrdersDir(P));
  const inputs = loadScoreInputs({
    reportsDir: P.reportsDir,
    cases: loadCases(P.root),
    orders,
    unseal: check || !!v.unseal,
    preregSha: sha,
  });
  const a = score(inputs);
  const out = join(P.reportsDir, 'trial.json');
  if (check) {
    if (!existsSync(out)) throw new Dependency(`${out} does not exist`);
    const committed = TrialResult.parse(JSON.parse(readFileSync(out, 'utf8')));
    const diffs = compareResults(committed, a.result);
    // The frozen config of every run must match the one hashed in prereg-v1.
    const cfg = new Set(
      inputs.manifest.map(
        (l) =>
          (
            JSON.parse(readFileSync(join(P.reportsDir, 'runs', l.run_id, 'meta.json'), 'utf8')) as {
              config_sha256: string;
            }
          ).config_sha256,
      ),
    );
    const pre = await git(['show', 'prereg-v1:reports/preregistration.md'], { cwd: P.root }).catch(() => '');
    for (const c of cfg)
      if (!pre.includes(c))
        diffs.push(`frozen config sha256 ${c} is not in prereg-v1:reports/preregistration.md`);
    if (diffs.length) {
      for (const d of diffs) io.err(`DNR: rescore: ${d}\n`);
      return EXIT.FINDINGS;
    }
    io.out('DNR: rescore --check: every count reproduces exactly\n');
    return EXIT.OK;
  }
  await writeFile(out, `${JSON.stringify(a.result, null, 2)}\n`);
  await writeFile(
    join(P.reportsDir, 'trial-analysis.json'),
    `${JSON.stringify({ ...a, result: undefined }, null, 2)}\n`,
  );
  io.out(`DNR: wrote ${out} (row ${a.result.row}${a.result.via_d6 ? ', via D6' : ''})\n`);
  return EXIT.OK;
}

async function cmdReport(argv: string[], io: TrialIO): Promise<number> {
  const v = flags(argv, {});
  if (v.help) return help(io, 'dnr trial report');
  const P = paths(io, false);
  const sha = await preregSha(P.root);
  if (!sha) throw new Dependency('tag prereg-v1 does not exist');
  const inputs = loadScoreInputs({
    reportsDir: P.reportsDir,
    cases: loadCases(P.root),
    orders: loadOrders(trialOrdersDir(P)),
    unseal: true,
    preregSha: sha,
  });
  const a = score(inputs);
  const committed = join(P.reportsDir, 'trial.json');
  if (!existsSync(committed)) throw new Dependency('run `dnr trial score --unseal` first');
  const diffs = compareResults(TrialResult.parse(JSON.parse(readFileSync(committed, 'utf8'))), a.result);
  if (diffs.length) throw new ScoreInputError(`trial.json does not reproduce: ${diffs[0]}`);
  await writeFile(join(P.reportsDir, 'trial.md'), trialMarkdown(a));
  await mkdir(join(P.reportsDir, 'video'), { recursive: true });
  await writeFile(join(P.reportsDir, 'video/numbers.json'), `${JSON.stringify(videoNumbers(a), null, 2)}\n`);
  await writeFile(join(P.reportsDir, 'decision.md'), decisionMarkdown(a));
  io.out('DNR: wrote reports/trial.md, reports/video/numbers.json and reports/decision.md\n');
  return EXIT.OK;
}

async function cmdProbe(argv: string[], io: TrialIO): Promise<number> {
  const v = flags(argv, { 'dry-run': { type: 'boolean' }, only: { type: 'string' } });
  if (v.help) return help(io, 'dnr trial probe [--dry-run --only <sha>]');
  const dryRun = !!v['dry-run'];
  const P = paths(io, dryRun);
  const only = v.only as string | undefined;
  const log = (m: string) => io.err(`[probe] ${m}\n`);
  const sel: Selector = { namespace: 'probe' };
  const cases = await casesFor(P, sel, only, log);
  const planned = planFor(sel, cases, only);
  if (planned.length === 0) throw new Usage('no probe runs (Django reverts with a role in assignment.json)');
  const runner = new KiroRunner(io.env.KIRO_CLI ?? 'kiro-cli', io.env);
  if (!dryRun) {
    const ver = await runner.version(P.trialRoot);
    if (ver.startsWith('unavailable'))
      throw new AgentUnavailable(`kiro-cli is not available (${ver}); the probe was not run`);
  }
  const prepared = await prepareAll(
    {
      paths: P,
      env: io.env,
      pins: loadPins(P.root),
      cases: new Map(cases.map((c) => [c.revert_sha, c])),
      deps: { ...io.deps, log },
    },
    planned,
  );
  const caseOf = new Map(cases.map((c) => [c.revert_sha, c]));
  let bad = 0;
  for (const p of prepared) {
    const c = caseOf.get(p.revert_sha) as TrialCase;
    const r = await runProbe({
      trialRoot: P.trialRoot,
      prepared: p,
      gitDir: gitDirOf(P, c.repo) as string,
      originalSha: c.original_sha,
      runner,
      dryRun,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    log(`${p.run_id}: ${r.agent === 'not run' ? 'agent not run (dry run); prompt written' : r.status}`);
    if (!dryRun && r.status !== 'ok') bad++;
  }
  io.out(`DNR: probe: ${prepared.length} session(s)${dryRun ? ' prepared; agent not run (dry run)' : ''}\n`);
  return bad ? EXIT.FINDINGS : EXIT.OK;
}

export async function generateBaseline(env: NodeJS.ProcessEnv, log: (m: string) => void): Promise<number> {
  const P = trialPaths({ TRIAL_ROOT: '/var/tmp/dnr-trial', ...env }, {});
  const orders = loadOrders(trialOrdersDir(P));
  if (orders.length === 0) {
    log('no orders in reports/orders');
    return EXIT.DEPENDENCY;
  }
  const dirs = [
    P.djangoSrc,
    P.secondSrc,
    existsSync(layout(P.trialRoot).synSrc) ? layout(P.trialRoot).synSrc : null,
  ].filter((x): x is string => !!x);
  const m = await generateRules({
    root: P.root,
    orders,
    gitDirs: dirs,
    outDir: join(P.root, 'scripts/baseline/rules'),
  });
  log(
    `baseline: ${m.rules.filter((r) => r.file).length} rule file(s), ${m.rules.filter((r) => r.na_removal_only).length} removal-only order(s) (na_removal_only)`,
  );
  return EXIT.OK;
}

async function cmdBaseline(argv: string[], io: TrialIO): Promise<number> {
  const v = flags(argv, { generate: { type: 'boolean' }, score: { type: 'boolean' } });
  if (v.help || (!v.generate && !v.score)) return help(io, 'dnr trial baseline --generate|--score');
  if (v.generate) return generateBaseline(io.env, (m) => io.err(`${m}\n`));
  const P = paths(io, false);
  const bad = verifyRules(P.root, join(P.root, 'scripts/baseline/rules'));
  if (bad.length) throw new ScoreInputError(`baseline rules do not match their hashes: ${bad.join('; ')}`);
  throw new Dependency(
    'baseline --score needs the Phase 11 corpus (ok T and H runs with frozen labels, and the false-alarm commits); none exists yet',
  );
}

async function cmdPrereg(argv: string[], io: TrialIO): Promise<number> {
  const v = flags(argv, { out: { type: 'string' } });
  if (v.help)
    return help(
      io,
      'dnr trial prereg [--out <file>]  (writes the draft pre-registration with current hashes; never tags)',
    );
  const P = trialPaths({ TRIAL_ROOT: '/var/tmp/dnr-trial', ...io.env }, {});
  const out = (v.out as string | undefined) ?? join(P.root, 'reports/preregistration.md');
  const missing = await writePrereg(P.root, out);
  io.out(`DNR: wrote draft ${out}; ${missing.length} input(s) still missing before prereg-v1\n`);
  return EXIT.OK;
}

function help(io: TrialIO, text: string): number {
  io.out(`${text}\n`);
  return EXIT.OK;
}

export const HARNESS_COMMANDS = [
  'prepare',
  'run',
  'envs',
  'label',
  'replay',
  'score',
  'rescore',
  'report',
  'probe',
  'baseline',
  'prereg',
] as const;

export async function runHarness(sub: string, argv: string[], io: TrialIO): Promise<number> {
  try {
    switch (sub) {
      case 'prepare':
        return await cmdPrepare(argv, io);
      case 'run':
        return await cmdRun(argv, io);
      case 'envs':
        return await cmdEnvs(argv, io);
      case 'label':
        return await cmdLabel(argv, io);
      case 'replay':
        return await cmdReplay(argv, io);
      case 'score':
        return await cmdScore(argv, io);
      case 'rescore':
        return await cmdScore(argv, io, true);
      case 'report':
        return await cmdReport(argv, io);
      case 'probe':
        return await cmdProbe(argv, io);
      case 'baseline':
        return await cmdBaseline(argv, io);
      case 'prereg':
        return await cmdPrereg(argv, io);
      default:
        io.err(`DNR: unknown trial subcommand ${sub}\n`);
        return EXIT.USAGE;
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (e instanceof Usage) {
      io.err(`DNR: dnr trial ${sub}: ${msg}\n`);
      return EXIT.USAGE;
    }
    if (e instanceof Dependency || e instanceof AgentUnavailable) {
      io.err(`DNR: dnr trial ${sub}: ${msg}\n`);
      return EXIT.DEPENDENCY;
    }
    if (
      e instanceof PrepareError ||
      e instanceof ScoreInputError ||
      (e as Error).name === 'ZodError' ||
      (e as Error).name === 'FreezeError' ||
      (e as Error).name === 'PacketError' ||
      (e as Error).name === 'PinError'
    ) {
      io.err(`DNR: dnr trial ${sub}: ${msg.split('\n')[0]}\n`);
      return EXIT.DATA;
    }
    io.err(`DNR: dnr trial ${sub}: internal error: ${msg.split('\n')[0]}\n`);
    return EXIT.INTERNAL;
  }
}
