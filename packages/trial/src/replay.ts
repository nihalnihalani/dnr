/**
 * `dnr trial replay` (§8, §9.6): records each run's DNR decision in `reports/sealed/`. Recorded
 * pre-write events are re-decided with the run's own order set and the frozen config (session
 * simulated), and the run's final working copy is checked with the crossing rule against its
 * start commit, which also covers writes that went through the shell.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { grammarForPath } from '@dnr/core';
import { git, runGit } from '@dnr/git';
import { canonicalDecision, crossingCheck, loadParser, openContext, replayEvents } from '@dnr/hook';
import { z } from 'zod';
import type { Prepared } from './prepare';
import { runOutDir } from './seal';
import { type SynCaseT, synAutoLabel } from './syn';

export const SealedDecision = z.strictObject({
  run_id: z.string(),
  arm: z.string(),
  revert_sha: z.string(),
  config_sha256: z.string(),
  order_set_hash: z.string(),
  events: z.array(
    z.strictObject({
      event_id: z.string(),
      target_rel: z.string().nullable(),
      decision: z.record(z.string(), z.unknown()),
    }),
  ),
  blocked_event_ids: z.array(z.string()),
  final: z.array(
    z.strictObject({ order_id: z.string(), crossing: z.boolean(), edit: z.number().nullable() }),
  ),
  would_block: z.boolean(),
  /** match-tier decision of the run's own order (the revert under test). */
  own_order_blocked: z.boolean(),
  /** SYN runs only: the automatic label (§9.10), null when the human label applies. */
  syn_auto: z.enum(['FULL', 'CORE']).nullable(),
});
export type SealedDecision = z.infer<typeof SealedDecision>;

export interface ReplayExtra {
  syn?: SynCaseT;
  restoredTests?: 'pass' | 'fail' | 'n/a' | 'could-not-run';
}

async function synLabel(p: Prepared, x: ReplayExtra): Promise<'FULL' | 'CORE' | null> {
  if (!x.syn || !p.start_sha) return null;
  const f = x.syn.critical_edit.file;
  const start = await runGit(['show', `${p.start_sha}:${f}`], { cwd: p.workdir, okCodes: [0, 128] });
  const finalPath = join(p.workdir, f);
  return synAutoLabel({
    provider: await loadParser(),
    critical: x.syn.critical_edit,
    restoredTests: x.restoredTests ?? 'n/a',
    startText: start.code === 0 ? start.stdout : null,
    finalText: existsSync(finalPath) ? readFileSync(finalPath, 'utf8') : null,
    grammarOf: (path) => grammarForPath(path),
  });
}

export async function replayRun(
  p: Prepared,
  outDir: string,
  extra: ReplayExtra = {},
): Promise<SealedDecision> {
  const events = join(outDir, 'events.jsonl');
  const state = await mkdtemp(join(tmpdir(), 'dnr-replay-state-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DNR_ORDERS: p.orders_dir,
    DNR_CONFIG: p.config_path,
    DNR_STATE_DIR: state,
    DNR_MODE: 'enforce',
  };
  delete env.DNR_RECORD_PATH;
  const ownId = `dnr-${p.revert_sha.slice(0, 10)}`;
  let scratch: string | null = null;
  try {
    let lines: Awaited<ReturnType<typeof replayEvents>> = [];
    if (p.start_sha && existsSync(events)) {
      // Replay against the start state, even if the agent moved HEAD.
      scratch = await mkdtemp(join(tmpdir(), 'dnr-replay-'));
      await git(['clone', '-q', '--no-local', '--no-checkout', p.workdir, scratch], { cwd: tmpdir() });
      await git(['checkout', '-q', '--detach', p.start_sha], { cwd: scratch });
      const ctx = await openContext(scratch, env);
      if (ctx) lines = await replayEvents(ctx, events, scratch);
    }
    let final: SealedDecision['final'] = [];
    if (p.start_sha) {
      const ctx = await openContext(p.workdir, env);
      if (ctx)
        final = (await crossingCheck(ctx, p.start_sha, 'worktree')).map((f) => ({
          order_id: f.order_id,
          crossing: f.crossing,
          edit: f.edit,
        }));
    }
    const blocked = lines.filter((l) => l.decision.outcome === 'block').map((l) => l.event_id);
    const ownBlocked =
      lines.some((l) => l.decision.outcome === 'block' && l.decision.order_id === ownId) ||
      final.some((f) => f.crossing && f.order_id === ownId);
    return SealedDecision.parse({
      run_id: p.run_id,
      arm: p.arm,
      revert_sha: p.revert_sha,
      config_sha256: p.config_sha256,
      order_set_hash: p.order_set.hash,
      events: lines.map((l) => ({
        event_id: l.event_id,
        target_rel: l.target_rel,
        decision: canonicalDecision(l.decision),
      })),
      blocked_event_ids: blocked,
      final,
      would_block: blocked.length > 0 || final.some((f) => f.crossing),
      own_order_blocked: ownBlocked,
      syn_auto: await synLabel(p, extra),
    });
  } finally {
    await rm(state, { recursive: true, force: true });
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

export const sealedPath = (reportsDir: string, runId: string) => join(reportsDir, 'sealed', `${runId}.json`);

export async function replayAll(
  trialRoot: string,
  reportsDir: string,
  runs: readonly Prepared[],
  extraOf: (p: Prepared) => ReplayExtra = () => ({}),
): Promise<SealedDecision[]> {
  const out: SealedDecision[] = [];
  for (const p of runs) {
    const s = await replayRun(p, runOutDir({ reportsDir, trialRoot }, p.run_id), extraOf(p));
    const f = sealedPath(reportsDir, p.run_id);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, `${JSON.stringify(s, null, 2)}\n`);
    out.push(s);
  }
  return out;
}
