/**
 * `dnr trial probe` (§9.13): one tool-less session per Django revert with a role, no repo, the
 * pinned model, and the pre-registered prompt verbatim. A dry run builds the prompt and the HOME
 * but does not call the agent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractUnits } from '@dnr/core';
import { git, readBlob } from '@dnr/git';
import { loadParser } from '@dnr/hook';
import { probePrompt, sha10 } from './arms';
import { layout } from './env';
import type { Prepared } from './prepare';
import type { AgentRunner } from './runner';

/** C's pre-image: the target unit's text at C^, and C^'s commit date (YYYY-MM-DD). */
export async function preImage(
  gitDir: string,
  originalSha: string,
  file: string,
  qualname: string,
): Promise<{ text: string; date: string }> {
  const parent = `${originalSha}^`;
  const src = await readBlob(gitDir, parent, file);
  const date = (await git(['log', '-1', '--format=%cs', parent], { cwd: gitDir })).trim();
  if (src === null) throw new Error(`${file} does not exist at ${parent}`);
  const fu = extractUnits(await loadParser(), file, src);
  const u = fu?.units.get(qualname);
  if (!u) throw new Error(`${qualname} not found in ${file} at ${parent}`);
  const lines = src.split('\n').slice(u.startLine - 1, u.endLine);
  return { text: lines.join('\n'), date };
}

/** Assistant text from a stream-json transcript: every `text` string under assistant/message events. */
export function answerText(transcript: string): string {
  const out: string[] = [];
  const visit = (v: unknown, inAssistant: boolean) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x, inAssistant);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const a = inAssistant || o.role === 'assistant' || o.type === 'assistant' || o.type === 'text';
      if (a && typeof o.text === 'string') out.push(o.text);
      for (const [k, x] of Object.entries(o)) if (k !== 'text') visit(x, a);
    }
  };
  for (const l of transcript.split('\n')) {
    if (!l.trim()) continue;
    try {
      visit(JSON.parse(l), false);
    } catch {}
  }
  return out.join('');
}

export interface ProbeOutcome {
  run_id: string;
  revert_sha: string;
  agent: 'run' | 'not run';
  status: 'ok' | 'timeout' | 'error' | 'not_run';
  prompt_sha256_file: string;
}

export async function runProbe(input: {
  trialRoot: string;
  prepared: Prepared;
  gitDir: string;
  originalSha: string;
  runner: AgentRunner;
  dryRun: boolean;
  timeoutMs: number;
}): Promise<ProbeOutcome> {
  const p = input.prepared;
  const dir = layout(input.trialRoot).probe(sha10(p.revert_sha));
  await mkdir(dir, { recursive: true });
  const pre = await preImage(input.gitDir, input.originalSha, p.target.file, p.target.qualname);
  const prompt = probePrompt(pre.date, pre.text);
  await writeFile(join(dir, 'prompt.txt'), prompt);
  await writeFile(join(dir, 'pre_image.py'), `${pre.text}\n`);
  if (input.dryRun) {
    await writeFile(
      join(dir, 'meta.json'),
      `${JSON.stringify({ run_id: p.run_id, agent: 'not run', dry_run: true, model: p.model }, null, 2)}\n`,
    );
    return {
      run_id: p.run_id,
      revert_sha: p.revert_sha,
      agent: 'not run',
      status: 'not_run',
      prompt_sha256_file: join(dir, 'prompt.txt'),
    };
  }
  const res = await input.runner.run({
    workdir: p.workdir,
    home: p.home,
    agent: p.agent,
    model: p.model,
    prompt,
    timeoutMs: input.timeoutMs,
    env: {},
  });
  await writeFile(join(dir, 'transcript.jsonl'), res.transcript);
  await writeFile(join(dir, 'answer.txt'), answerText(res.transcript));
  const status = res.timedOut ? 'timeout' : res.exitCode === 0 && !res.spawnError ? 'ok' : 'error';
  await writeFile(
    join(dir, 'meta.json'),
    `${JSON.stringify({ run_id: p.run_id, agent: 'run', status, exit: res.exitCode, model: p.model, started_at: res.startedAt, ended_at: res.endedAt }, null, 2)}\n`,
  );
  return {
    run_id: p.run_id,
    revert_sha: p.revert_sha,
    agent: 'run',
    status,
    prompt_sha256_file: join(dir, 'prompt.txt'),
  };
}

/** Probe answers available for packets: only real agent answers (status ok). */
export function probeAnswers(
  trialRoot: string,
  shas: readonly string[],
): Array<{ revert_sha: string; run_id: string; pre_image: string; answer: string }> {
  const out = [];
  for (const sha of shas) {
    const dir = layout(trialRoot).probe(sha10(sha));
    const meta = join(dir, 'meta.json');
    if (!existsSync(meta)) continue;
    const m = JSON.parse(readFileSync(meta, 'utf8')) as { status?: string; run_id: string };
    if (m.status !== 'ok') continue;
    out.push({
      revert_sha: sha,
      run_id: m.run_id,
      pre_image: readFileSync(join(dir, 'pre_image.py'), 'utf8'),
      answer: readFileSync(join(dir, 'answer.txt'), 'utf8'),
    });
  }
  return out;
}
