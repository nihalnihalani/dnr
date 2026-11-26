/**
 * `dnr check --replay <events.jsonl> [--canonical] [--git-dir <working copy>]` (§8, §7 canonical
 * projection). Replays recorded pre-write events with the session simulated in memory:
 * - the baseline is HEAD of `--git-dir` (the run's start state);
 * - each write is decided again with today's code and orders;
 * - a write is applied to the simulated state when it actually landed in the recording
 *   (original outcome allow / warn_pass / allow_grant / record / error_open, or an `ask` that a
 *   later post-write approved), so later decisions see the same files the agent saw;
 * - warned and grants_used are simulated per session key.
 */
import { readFileSync } from 'node:fs';
import { applyTool, type OrderEntry } from '@dnr/core';
import { catBlobs } from '@dnr/git';
import { type Decision, EventRecord } from '@dnr/schemas';
import type { HookContext } from './context';
import { createState, decideWrite, deriveStatus, filesOf, loadParser, UnitCache } from './engine';
import { decideConfig } from './prewrite';

const LANDED = new Set(['allow', 'warn_pass', 'allow_grant', 'record', 'error_open', 'ask_approved']);

export function canonicalDecision(d: Decision): Record<string, unknown> {
  const { latency_ms: _l, fast_path: _f, ...rest } = d;
  return rest;
}

/** JSON with recursively sorted keys. */
export function sortedJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as object).sort()) o[k] = norm((x as Record<string, unknown>)[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

export interface ReplayLine {
  event_id: string;
  target_rel: string | null;
  decision: Decision;
}

export async function replayEvents(
  ctx: HookContext,
  eventsFile: string,
  gitDir: string,
): Promise<ReplayLine[]> {
  const records: EventRecord[] = [];
  for (const line of readFileSync(eventsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = EventRecord.safeParse(JSON.parse(line));
    if (r.success) records.push(r.data);
  }
  const orders = (await ctx.store.orders.list()).filter((o) => o.status === 'approved');
  const targets = new Set<string>();
  for (const e of records) if (e.target_rel) targets.add(e.target_rel);
  for (const o of orders) for (const f of filesOf(o)) targets.add(f);
  const specs: string[] = [];
  for (const f of targets) specs.push(`HEAD:${f}`);
  for (const o of orders) for (const f of filesOf(o)) specs.push(`${o.snapshot_sha}:${f}`);
  const blobs = await catBlobs(gitDir, specs);
  const head = (f: string) => blobs.get(`HEAD:${f}`) ?? null;
  const parser = await loadParser();
  const cache = new UnitCache(parser);
  const entries: OrderEntry[] = orders.map((order) => ({
    order,
    ...deriveStatus(
      order,
      (f) => blobs.get(`${order.snapshot_sha}:${f}`) ?? null,
      head,
      cache,
      ctx.config,
      null,
    ),
  }));

  // Which asks were approved later (post-write ask_approved on the same file and session).
  const approvedAsk = new Set<string>();
  for (const e of records)
    if (e.hook === 'post-write' && e.decision.outcome === 'ask_approved')
      approvedAsk.add(`${e.session_key}\0${e.target_rel}`);

  const sessions = new Map<
    string,
    { files: Map<string, string | null>; warned: Set<string>; granted: Set<string>; touched: Set<string> }
  >();
  const baseline = createState(head, cache);
  const out: ReplayLine[] = [];
  for (const e of records) {
    const sk = e.session_key ?? '';
    let sim = sessions.get(sk);
    if (!sim) {
      sim = { files: new Map(), warned: new Set(), granted: new Set(), touched: new Set() };
      sessions.set(sk, sim);
    }
    if (e.hook === 'post-write' && e.decision.outcome === 'ask_approved' && e.decision.order_id)
      sim.granted.add(e.decision.order_id);
    if (e.hook !== 'pre-write' || !e.target_rel) continue;
    const s = sim;
    const currentText = (f: string) => (s.files.has(f) ? (s.files.get(f) ?? null) : head(f));
    const raw = (e.raw ?? {}) as Record<string, unknown>;
    const tool = typeof raw.tool_name === 'string' ? raw.tool_name : '';
    const input = { ...((raw.tool_input ?? {}) as Record<string, unknown>) };
    // Re-target the tool input at the recorded repo-relative path.
    for (const k of ['path', 'file_path', 'filePath', 'target_file', 'file'])
      if (k in input) input[k] = e.target_rel;
    if (!Object.keys(input).some((k) => ['path', 'file_path', 'filePath', 'target_file', 'file'].includes(k)))
      input.path = e.target_rel;
    const effect = applyTool(tool, input, (p) => currentText(p));
    s.touched.add(e.target_rel);
    const r = decideWrite({
      target: e.target_rel,
      effect,
      entries,
      baseline,
      current: createState(currentText, cache),
      cache,
      searchFiles: [...s.touched],
      warned: s.warned,
      grantApplies: (id) => s.granted.has(id),
      config: decideConfig(ctx),
    });
    if (r.effects.warn) s.warned.add(r.effects.warn);
    out.push({ event_id: e.event_id, target_rel: e.target_rel, decision: r.decision });
    const orig = e.decision.outcome;
    const landed =
      LANDED.has(orig) || (orig === 'ask' && approvedAsk.has(`${e.session_key}\0${e.target_rel}`));
    if (landed && effect.kind === 'write') s.files.set(e.target_rel, effect.text);
  }
  return out;
}

export function formatReplay(lines: ReplayLine[], canonical: boolean): string {
  return lines
    .map((l) =>
      canonical
        ? sortedJson({
            event_id: l.event_id,
            target_rel: l.target_rel,
            decision: canonicalDecision(l.decision),
          })
        : JSON.stringify(l),
    )
    .map((s) => `${s}\n`)
    .join('');
}
