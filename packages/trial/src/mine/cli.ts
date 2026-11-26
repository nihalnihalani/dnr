/**
 * Mining entry point (stands in for `dnr trial mine|tickets|assign` until the CLI package wires
 * these in). Run with `pnpm tsx packages/trial/src/mine/cli.ts <command> [flags]`.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { revParse } from '@dnr/git';
import {
  Assignment,
  Candidate,
  DjangoPython,
  KnownReverts,
  KnownRevertsRejected,
  ReasonLabels,
  type RevertCase,
  RevertCases,
  RevertKindDecisions,
} from '@dnr/schemas';
import { loadAnalyzer } from './analyzer';
import { assignRoles } from './assign';
import { DEMO_REVERTS } from './eligibility';
import { classifyKnownReverts, ghSearchCommits, KNOWN_REVERT_QUERIES } from './known-reverts';
import { cohenKappa, mergeReasonAnswers, writeReasonPackets } from './label';
import { type MineResult, mine, PROFILES, toJsonl, toRevertCase } from './mine';
import { buildDjangoPythonTable, detectPython } from './python-version';
import { computeRdelta } from './rdelta';
import { renderEligibility } from './report';
import {
  countDjangoRelands,
  countGithub,
  countRevertOfRevert,
  countTracDuplicates,
  renderReproposals,
} from './reproposals';
import { planTestLabels } from './test-labels';
import { defaultGh, defaultSleep, fetchDiscussions, PoliteFetcher } from './tickets';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const P = {
  candidates: join(ROOT, 'fixtures/candidates.jsonl'),
  known: join(ROOT, 'fixtures/known-reverts.json'),
  rejected: join(ROOT, 'fixtures/known-reverts-rejected.json'),
  reverts: join(ROOT, 'fixtures/reverts.json'),
  kindDecisions: join(ROOT, 'fixtures/revert-kind-decisions.json'),
  assignment: join(ROOT, 'fixtures/assignment.json'),
  pins: join(ROOT, 'fixtures/pins.json'),
  djangoPython: join(ROOT, 'fixtures/django-python.json'),
  discussion: join(ROOT, 'fixtures/discussion'),
  eligibility: join(ROOT, 'reports/eligibility.md'),
  reproposals: join(ROOT, 'reports/human-reproposals.md'),
};

const log = (m: string) => process.stderr.write(`[mine] ${m}\n`);

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
const json = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`;

function gitDirFor(repo: string, flag?: string): string {
  if (flag) return resolve(flag);
  if (repo === 'django') return process.env.DJANGO_SRC ?? resolve(ROOT, '../dnr-work/django');
  const s = process.env.SECOND_SRC;
  if (!s) throw new Error('SECOND_SRC is not set');
  return s;
}

async function defaultRef(repo: string): Promise<string> {
  if (repo === 'django' && existsSync(P.pins)) {
    const pins = JSON.parse(await readFile(P.pins, 'utf8')) as { django_sha?: string };
    if (pins.django_sha) return pins.django_sha;
  }
  return 'origin/main';
}

async function readCandidates(): Promise<Candidate[]> {
  const text = await readFile(P.candidates, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => Candidate.parse(JSON.parse(l)));
}

const pool = (cs: readonly Candidate[]) =>
  cs.filter((c) => c.window !== null && Object.values(c.rules).every((s) => s !== 'fail'));

async function cmdMine(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      labels: { type: 'string' },
      'kind-decisions': { type: 'string' },
      repo: { type: 'string', default: 'django' },
      ref: { type: 'string' },
      'git-dir': { type: 'string' },
      'no-revert-check': { type: 'boolean', default: false },
    },
  });
  const repo = values.repo as keyof typeof PROFILES;
  const profile = PROFILES[repo];
  if (!profile) throw new Error(`unknown repo ${repo}`);
  const gitDir = gitDirFor(repo, values['git-dir']);
  const ref = values.ref ?? (await defaultRef(repo));
  const labels = values.labels
    ? ReasonLabels.parse(JSON.parse(await readFile(resolve(values.labels), 'utf8')))
    : null;
  const kdPath = values['kind-decisions'] ? resolve(values['kind-decisions']) : P.kindDecisions;
  const kindDecisions = existsSync(kdPath)
    ? RevertKindDecisions.parse(JSON.parse(await readFile(kdPath, 'utf8')))
    : [];
  if (kindDecisions.length > 0) log(`revert-kind decisions: ${kindDecisions.length} from ${kdPath}`);
  const analyzer = await loadAnalyzer(log);
  const res: MineResult = await mine({
    kindDecisions,
    gitDir,
    ref,
    profile,
    analyzer,
    labels,
    revertCheck: !values['no-revert-check'],
    onProgress: log,
  });
  const cands = res.mined.map((m) => m.candidate);
  const suffix = repo === 'django' ? '' : `.${repo}`;
  const candPath = P.candidates.replace(/\.jsonl$/, `${suffix}.jsonl`);
  const eligPath = P.eligibility.replace(/\.md$/, `${suffix}.md`);
  await writeText(candPath, toJsonl(cands));
  await writeText(eligPath, renderEligibility(res, { repo, gitDir, ref, labels: values.labels ?? null }));
  log(`wrote ${candPath} (${cands.length}) and ${eligPath}`);

  let status = 0;
  if (repo === 'django' && existsSync(P.known)) {
    const known = KnownReverts.parse(JSON.parse(await readFile(P.known, 'utf8')));
    const got = new Set(cands.map((c) => c.revert_sha));
    const missing = known.filter((k) => !got.has(k.sha));
    log(`known reverts recovered: ${known.length - missing.length}/${known.length}`);
    for (const m of missing) log(`  MISSING ${m.sha} ${m.subject}`);
    if (missing.length > 0) status = 1;
    for (const d of DEMO_REVERTS)
      if (!got.has(d)) {
        log(`  MISSING demo ${d}`);
        status = 1;
      }
  }

  if (labels) {
    const cases: RevertCase[] = [];
    for (const m of res.mined) {
      const c = m.candidate;
      if (!c.original_sha || !c.match_method || !c.revert_kind) continue;
      const lab =
        labels.find((l) => l.revert_sha === c.revert_sha && l.adjudicated) ??
        labels.find((l) => l.revert_sha === c.revert_sha);
      if (!lab) continue;
      const rdelta = m.outcome.eligible
        ? await computeRdelta(gitDir, res.refSha, c.revert_sha, c.units, analyzer)
        : null;
      const rc = toRevertCase(m, lab.category, rdelta);
      const plan = await planTestLabels(gitDir, c.original_sha, c.revert_sha);
      rc.restored_tests.paths = plan.restored.paths;
      rc.restored_tests.labels = plan.restored.labels;
      cases.push(rc);
    }
    await writeText(P.reverts.replace(/\.json$/, `${suffix}.json`), json(RevertCases.parse(cases)));
    log(
      `wrote reverts.json (${cases.length} labeled pairs, ${cases.filter((c) => c.eligible).length} eligible)`,
    );
  }
  return status;
}

async function cmdKnownReverts(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { 'git-dir': { type: 'string' }, ref: { type: 'string' } } });
  const gitDir = gitDirFor('django', values['git-dir']);
  const ref = await revParse(gitDir, values.ref ?? (await defaultRef('django')));
  const shas: string[] = [];
  for (const q of KNOWN_REVERT_QUERIES) {
    const hits = await ghSearchCommits(q);
    log(`gh search/commits ${q}: ${hits.length} hits`);
    shas.push(...hits);
    await defaultSleep(2000);
  }
  const { known, rejected } = await classifyKnownReverts(gitDir, ref, shas);
  await writeText(P.known, json(KnownReverts.parse(known)));
  await writeText(P.rejected, json(KnownRevertsRejected.parse(rejected)));
  log(`known ${known.length}, rejected ${rejected.length}`);
  return 0;
}

async function cmdTickets(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      only: { type: 'string', multiple: true },
      all: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
    },
  });
  const cs = await readCandidates();
  const pick = values.only?.length
    ? cs.filter((c) => values.only?.some((o) => c.revert_sha.startsWith(o)))
    : values.all
      ? cs.filter((c) => c.original_sha !== null)
      : [...pool(cs), ...cs.filter((c) => DEMO_REVERTS.includes(c.revert_sha))];
  log(`fetching discussion for ${pick.length} revert(s)`);
  const r = await fetchDiscussions(
    pick.map((c) => ({ revert_sha: c.revert_sha, original_sha: c.original_sha, tickets: c.tickets })),
    {
      outDir: P.discussion,
      repoSlug: 'django/django',
      fetcher: new PoliteFetcher(),
      gh: defaultGh,
      refresh: values.refresh,
      onProgress: log,
    },
  );
  log(`written ${r.written.length}, kept ${r.skipped.length}`);
  return 0;
}

async function cmdAssign(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      'min-order-weight': { type: 'string', default: '8' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!existsSync(P.reverts)) {
    log(
      'fixtures/reverts.json does not exist yet: run `mine --labels fixtures/reason-labels.json` after reason labeling',
    );
    return 1;
  }
  const reverts = RevertCases.parse(JSON.parse(await readFile(P.reverts, 'utf8')));
  const weights = new Map((await readCandidates()).map((c) => [c.revert_sha, c.order_weight]));
  const elig = reverts.filter((r) => r.eligible);
  const res = assignRoles(
    elig.map((r) => ({
      revert_sha: r.revert_sha,
      repo: r.repo,
      order_weight: weights.get(r.revert_sha) ?? null,
    })),
    {
      minOrderWeight: Number(values['min-order-weight']),
      demos: DEMO_REVERTS.map((d) => ({
        revert_sha: d,
        repo: 'django' as const,
        order_weight: weights.get(d) ?? null,
      })),
    },
  );
  for (const w of res.warnings) log(`warning: ${w}`);
  log(`K = ${res.K}`);
  if (!values['dry-run']) await writeText(P.assignment, json(Assignment.parse(res.assignment)));
  else process.stdout.write(json(res.assignment));
  return 0;
}

async function cmdPythonTable(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { 'git-dir': { type: 'string' } } });
  const table = await buildDjangoPythonTable(gitDirFor('django', values['git-dir']));
  await writeText(P.djangoPython, json(DjangoPython.parse(table)));
  log(`wrote ${P.djangoPython} (${table.length} rows)`);
  return 0;
}

async function cmdPython(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'git-dir': { type: 'string' } },
  });
  const gitDir = gitDirFor('django', values['git-dir']);
  const table = existsSync(P.djangoPython)
    ? DjangoPython.parse(JSON.parse(await readFile(P.djangoPython, 'utf8')))
    : undefined;
  for (const sha of positionals)
    process.stdout.write(`${sha} ${JSON.stringify(await detectPython(gitDir, sha, table))}\n`);
  return 0;
}

async function cmdPackets(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, key: { type: 'string' }, 'git-dir': { type: 'string' } },
  });
  if (!values.out || !values.key)
    throw new Error('packets needs --out <dir> (inside dnr-labeling) and --key <path> (kept by the builder)');
  const n = await writeReasonPackets(gitDirFor('django', values['git-dir']), pool(await readCandidates()), {
    discussionDir: P.discussion,
    outDir: resolve(values.out),
    keyPath: resolve(values.key),
  });
  log(`wrote ${n} reason packets`);
  return 0;
}

async function cmdMergeReasons(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      answers: { type: 'string' },
      key: { type: 'string' },
      labeler: { type: 'string' },
      adjudicated: { type: 'boolean', default: false },
      labels: { type: 'string', default: join(ROOT, 'fixtures/reason-labels.json') },
    },
  });
  if (!values.answers || !values.key || !values.labeler)
    throw new Error('merge-reasons needs --answers, --key and --labeler');
  const all = await mergeReasonAnswers({
    answersPath: resolve(values.answers),
    keyPath: resolve(values.key),
    labelsPath: resolve(values.labels as string),
    labeler: values.labeler,
    adjudicated: values.adjudicated,
  });
  const labelers = [...new Set(all.filter((l) => !l.adjudicated).map((l) => l.labeler))].sort();
  if (labelers.length >= 2) {
    const k = cohenKappa(all, labelers[0] as string, labelers[1] as string);
    log(`κ(${labelers[0]}, ${labelers[1]}) = ${k.kappa} over ${k.n}`);
  }
  return 0;
}

async function cmdReproposals(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { 'git-dir': { type: 'string' }, ref: { type: 'string' } } });
  const gitDir = gitDirFor('django', values['git-dir']);
  const ref = await revParse(gitDir, values.ref ?? (await defaultRef('django')));
  const rows = [];
  rows.push(...(await countDjangoRelands(gitDir, ref)).rows);
  if (existsSync(P.candidates)) rows.push(countRevertOfRevert(await readCandidates()));
  rows.push(await countTracDuplicates(new PoliteFetcher()));
  rows.push(...(await countGithub(defaultGh, defaultSleep)));
  await writeText(P.reproposals, renderReproposals(rows, ref));
  log(`wrote ${P.reproposals}`);
  return 0;
}

async function cmdEnvs(): Promise<number> {
  log('trial envs is a later wave (uv/Docker environments); not implemented here');
  return 2;
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  mine: cmdMine,
  'known-reverts': cmdKnownReverts,
  tickets: cmdTickets,
  assign: cmdAssign,
  'python-table': cmdPythonTable,
  python: cmdPython,
  packets: cmdPackets,
  'merge-reasons': cmdMergeReasons,
  reproposals: cmdReproposals,
  envs: cmdEnvs,
};

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const fn = cmd ? COMMANDS[cmd] : undefined;
  if (!fn) {
    process.stderr.write(`usage: cli.ts <${Object.keys(COMMANDS).join('|')}> [flags]\n`);
    return 2;
  }
  return fn(rest);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    },
  );
}
