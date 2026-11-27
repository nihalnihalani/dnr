/**
 * P12-11: DNR product mode on the TypeScript demo repo (fixtures/ts-demo/pins.json), run with the
 * installed `dnr` exactly as a maintainer would. Human-only steps (`dnr init`, `dnr orders build`,
 * `dnr orders approve`) are typed into a real terminal under node-pty; everything else runs as a
 * plain process, the way an agent's hook would.
 *
 *   bash scripts/demo/product-mode.sh --repo "$TS_DEMO_SRC" [--dnr <path to dnr>] [--out reports/ts-demo]
 *
 * It resets the demo clone to pins.demo_head, then: init → scan → orders build → approve the
 * demo order → a real re-application of C (the reland commit's file) must block, both through the
 * Kiro PreToolUse hook path (exit 2) and `dnr check --file`; a later real commit that edits the
 * same file outside the covered function must not block. It writes what actually ran to
 * <out>/product-mode.json and exports the case bundle with `dnr export-case`. Exit 0 only when
 * every expectation held.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CaseBundle } from '@dnr/schemas';
import { applyPatch } from 'diff';
import { runInTerminal } from '../test-pack/pty';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const { values } = parseArgs({
  options: { repo: { type: 'string' }, dnr: { type: 'string' }, out: { type: 'string' } },
});

function fail(msg: string): never {
  process.stderr.write(`product-mode: ${msg}\n`);
  process.exit(1);
}

const pins = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'ts-demo', 'pins.json'), 'utf8')) as {
  repo: string;
  R: string;
  C: string;
  file: string;
  qualname: string;
  demo_head: string;
  reland: string;
  hard_negative: string;
};
const base = process.env.INIT_CWD ?? process.cwd();
const repo = resolve(base, values.repo ?? process.env.TS_DEMO_SRC ?? fail('pass --repo or set TS_DEMO_SRC'));
if (!existsSync(join(repo, '.git'))) fail(`${repo} is not a git clone of ${pins.repo}`);
const which = spawnSync('sh', ['-c', 'command -v dnr'], { encoding: 'utf8' });
const dnrBin =
  values.dnr ?? (which.status === 0 ? which.stdout.trim() : fail('dnr is not on PATH; pass --dnr'));
const outDir = values.out ? resolve(base, values.out) : join(ROOT, 'reports', 'ts-demo');
const id = `dnr-${pins.R.slice(0, 10)}`;
/**
 * This script types the human-only commands itself, so it is the approver. It says so: approvals
 * are never attributed to the git user or any person, and the exported case keeps the order as
 * `dnr orders build` made it (draft).
 */
const HARNESS = 'node-pty test harness (not a human)';

const env: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('KIRO_') || k.startsWith('DNR_')) delete env[k];

const git = (...a: string[]) =>
  execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const dnr = (args: string[], input?: string) => {
  const t0 = Date.now();
  const r = spawnSync(dnrBin, args, { cwd: repo, env, encoding: 'utf8', input, maxBuffer: 1 << 28 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
};
const steps: Array<Record<string, unknown>> = [];
const expectations: Array<{ what: string; ok: boolean }> = [];
const check = (what: string, ok: boolean) => {
  expectations.push({ what, ok });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};

// Reset the demo clone: detached at demo_head, no DNR state from an earlier run.
git('checkout', '-q', '-f', '--detach', pins.demo_head);
rmSync(join(repo, '.dnr'), { recursive: true, force: true });
rmSync(join(repo, '.kiro'), { recursive: true, force: true });
const preCommit = join(repo, '.git', 'hooks', 'pre-commit');
if (existsSync(preCommit) && readFileSync(preCommit, 'utf8').includes('check --staged')) rmSync(preCommit);
if (git('status', '--porcelain').trim()) fail(`${repo} has local changes; use a clean clone`);

const human = async (argv: string[]) => {
  const t0 = Date.now();
  // The permissions prompt is answered "n": this script never edits ~/.kiro.
  const r = await runInTerminal([dnrBin, ...argv], {
    cwd: repo,
    env,
    answers: [[/\[y\/N\]/, 'n\r']],
    timeoutMs: 600_000,
  });
  steps.push({ cmd: `dnr ${argv.join(' ')}`, via: 'node-pty terminal', exit: r.code, ms: Date.now() - t0 });
  return r;
};

const version = dnr(['--version']).out.trim();
const init = await human(['init']);
check('dnr init (terminal) exits 0', init.code === 0);
const scan = dnr(['scan']);
steps.push({ cmd: 'dnr scan', exit: scan.code, ms: scan.ms, out: scan.out.trim() });
check('dnr scan exits 0', scan.code === 0);
const cands = JSON.parse(readFileSync(join(repo, '.dnr', 'candidates.json'), 'utf8')) as Array<{
  revert_sha: string;
  original_sha: string;
  units: Array<{ file: string; qualname: string }>;
}>;
const cand = cands.find((c) => c.revert_sha === pins.R);
check(`scan finds R ${pins.R.slice(0, 10)} → C ${pins.C.slice(0, 10)}`, cand?.original_sha === pins.C);
check(
  `scan resolves ${pins.file}:${pins.qualname}`,
  !!cand?.units.some((u) => u.file === pins.file && u.qualname === pins.qualname),
);
const build = await human(['orders', 'build', '--by', HARNESS]);
check('dnr orders build (terminal) exits 0', build.code === 0);
check(`orders build creates ${id}`, existsSync(join(repo, '.dnr', 'orders', `${id}.json`)));

// The case bundle for the Playground's /play, exported before any approval: the order is a draft,
// as `dnr orders build` made it. Visitors approve it themselves (simulated) in /play.
mkdirSync(outDir, { recursive: true });
const caseFile = join(outDir, `${id}.case.json`);
const exp = dnr(['export-case', pins.R, '--out', caseFile]);
steps.push({ cmd: `dnr export-case ${pins.R.slice(0, 10)}`, exit: exp.code, ms: exp.ms });
const bundle = exp.code === 0 ? CaseBundle.safeParse(JSON.parse(readFileSync(caseFile, 'utf8'))) : null;
check('dnr export-case writes a valid CaseBundle', !!bundle?.success);
check(
  'the exported order is a draft with only its created entry',
  !!bundle?.success &&
    bundle.data.order.status === 'draft' &&
    bundle.data.order.history.map((h) => h.action).join(',') === 'created',
);

const approve = await human(['orders', 'approve', id, '--by', HARNESS]);
check(`dnr orders approve ${id} --by '${HARNESS}' (terminal) exits 0`, approve.code === 0);
const approvedEntry = (
  JSON.parse(readFileSync(join(repo, '.dnr', 'orders', `${id}.json`), 'utf8')) as {
    history: Array<{ by: string; action: string; origin?: { harness: string | null } }>;
  }
).history.at(-1);
check(
  'the approval is recorded as the test harness, with the harness named in its origin',
  approvedEntry?.by === HARNESS && approvedEntry.action === 'approved' && !!approvedEntry.origin?.harness,
);
steps.push({ approval_recorded: approvedEntry });

// A real re-application of C: the reland commit (c0d590d697, #24067) re-landed C unchanged. An
// agent at demo_head writes the reland's version of every file the order covers, one write at a
// time, through the Kiro PreToolUse hook; a write the hook lets through lands on disk, as in Kiro.
const before = readFileSync(join(repo, pins.file), 'utf8');
const order = JSON.parse(readFileSync(join(repo, '.dnr', 'orders', `${id}.json`), 'utf8')) as {
  units: Array<{ file: string }>;
};
const files = [...new Set(order.units.map((u) => u.file))];
const ordered = [...files.filter((f) => f !== pins.file), pins.file];
const event = (path: string, content: string, session: string) =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    cwd: repo,
    session_id: session,
    tool_name: 'fs_write',
    tool_input: { command: 'create', path, file_text: content, content },
  });
const lastOutcome = () => {
  const lines = readFileSync(join(repo, '.dnr', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n');
  return (JSON.parse(lines.at(-1) as string) as { decision: { outcome: string; edit_score: number | null } })
    .decision;
};
const writes: Array<Record<string, unknown>> = [];
let final: { code: number; outcome: string; err: string } = { code: -1, outcome: '', err: '' };
for (const f of ordered) {
  const content = git('show', `${pins.reland}:${f}`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = dnr(['check', '--stdin', '--hook', 'kiro'], event(f, content, 'ts-demo-reland'));
    const d = lastOutcome();
    writes.push({ file: f, attempt, exit: r.code, outcome: d.outcome, edit_score: d.edit_score, ms: r.ms });
    final = { code: r.code, outcome: d.outcome, err: r.err };
    if (r.code === 0) {
      writeFileSync(join(repo, f), content); // the hook allowed it: Kiro performs the write
      break;
    }
    if (d.outcome !== 'warn_block') break; // a block is final; a once-per-session warning is retried
  }
}
steps.push({ cmd: 'dnr check --stdin --hook kiro (reland, file by file)', writes, stderr: final.err });
check(
  `PreToolUse hook blocks the full re-application at ${pins.file} (exit 2, outcome block, names the order)`,
  final.code === 2 && final.outcome === 'block' && final.err.includes(id),
);
check('the blocked write did not change the file', readFileSync(join(repo, pins.file), 'utf8') === before);

// The same through `dnr check --file`, with the agent's earlier writes on disk.
const tmp = join(tmpdir(), `dnr-ts-demo-${process.pid}`);
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, 'reapply.ts'), git('show', `${pins.reland}:${pins.file}`));
const direct = dnr(['check', '--file', pins.file, '--proposed', join(tmp, 'reapply.ts')]);
const directJ = JSON.parse(direct.out);
steps.push({
  cmd: 'dnr check --file (reland build.ts, other files re-applied)',
  exit: direct.code,
  decision: directJ.decision,
});
check('dnr check --file: the re-application is a block', directJ.decision.outcome === 'block');
// Undo the agent's writes before the hard negative.
git('checkout', '-q', '--', ...files);

// Hard negative: a later real commit's edit to the same file, outside the covered function.
const patch = git('diff', `${pins.hard_negative}^`, pins.hard_negative, '--', pins.file);
const negative = applyPatch(before, patch, { fuzzFactor: 0 });
if (negative === false) fail(`${pins.hard_negative} does not apply to ${pins.file} at demo_head`);
writeFileSync(join(tmp, 'negative.ts'), negative);
const neg = dnr(['check', '--file', pins.file, '--proposed', join(tmp, 'negative.ts')]);
const negJ = JSON.parse(neg.out);
steps.push({ cmd: 'dnr check --file (hard negative)', exit: neg.code, decision: negJ.decision });
check('dnr check --file: the hard negative is not blocked', negJ.decision.outcome === 'allow');
const negHook = dnr(['check', '--stdin', '--hook', 'kiro'], event(pins.file, negative, 'ts-demo-negative'));
steps.push({ cmd: 'dnr check --stdin --hook kiro (hard negative)', exit: negHook.code, ms: negHook.ms });
check('PreToolUse hook lets the hard negative through (exit 0)', negHook.code === 0);
rmSync(tmp, { recursive: true, force: true });

const doctor = dnr(['doctor']);
const report = {
  ran_at: new Date().toISOString(),
  dnr: { bin: dnrBin, version },
  node: process.version,
  repo: { url: pins.repo, head: git('rev-parse', 'HEAD').trim(), path_name: repo.split('/').pop() },
  order: id,
  candidates: cands.length,
  steps,
  doctor: doctor.out.trim().split('\n'),
  expectations,
  ok: expectations.every((e) => e.ok),
};
// Local paths under the home directory are written as `~` (the report is committed).
const text = JSON.stringify(report, null, 2).split(homedir()).join('~');
writeFileSync(join(outDir, 'product-mode.json'), `${text}\n`);
process.stdout.write(`${report.ok ? 'PASS' : 'FAIL'}: wrote ${join(outDir, 'product-mode.json')}\n`);
process.exit(report.ok ? 0 : 1);
