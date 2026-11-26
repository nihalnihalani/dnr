/**
 * `dnr demo` (§8, P13-18): offline replay of the recorded demo block. Per AGENTS.md ("no mocks,
 * no seeded data"), it replays only **real recorded** Kiro events bundled in
 * `templates/demo/recorded/*.jsonl` (EventRecord lines from the Phase 10 `demo/L` runs). None exist
 * yet (they need kiro-cli), so it says so and exits 69.
 *
 * `dnr demo --live` is the honest stand-in: it runs the real pre-write decision, offline, on the
 * bundled real Django case (`dnr-43933a1dca`, post-revert `query.py`) for the hand-written fixture
 * event `reapply-43933a1dca.json`, which is labelled provisional until spike S2 captures real stdin.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyTool, createState, UnitCache } from '@dnr/core';
import { blockText, contributingQualnames, decideWrite, loadParser, parseHookEvent } from '@dnr/hook';
import { CaseBundle, EventRecord } from '@dnr/schemas';
import { packagePath } from '../assets';
import { EXIT } from '../errors';
import type { CliIO } from '../io';

function recordings(): string[] {
  const dir = packagePath('templates/demo/recorded');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => join(dir, n));
}

export async function cmdDemo(argv: string[], io: CliIO): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(
      'dnr demo          replay the recorded demo block (real Kiro events only)\ndnr demo --live   run the real hook offline on the bundled Django case\n',
    );
    return EXIT.OK;
  }
  const bundle = CaseBundle.parse(
    JSON.parse(readFileSync(packagePath('templates/demo/43933a1dca.case.json'), 'utf8')),
  );
  const order = { ...bundle.order, status: 'approved' as const };
  const base = new Map(bundle.files.map((f) => [f.path, f.baseline_text]));
  const parser = await loadParser();
  const cache = new UnitCache(parser);
  const baseline = createState((p) => base.get(p) ?? null, cache);

  const decideOne = (tool: string, input: unknown, target: string) => {
    const effect = applyTool(tool, input, (p) => base.get(p) ?? null);
    const fixed = effect.kind === 'write' ? { ...effect, path: target } : effect;
    return decideWrite({
      target,
      effect: fixed,
      entries: [{ order }],
      baseline,
      current: baseline,
      cache,
      searchFiles: [target],
      warned: [],
      grantApplies: () => false,
      config: {},
    });
  };

  if (!argv.includes('--live')) {
    const files = recordings();
    if (files.length === 0) {
      io.err(
        'DNR: no recorded Kiro session is bundled yet. The demo runs (Phase 10, demo/L) need kiro-cli and have not happened, so there is nothing real to replay.\n' +
          'Run `dnr demo --live` to run the real hook offline on the bundled Django case (the input event is hand-written and provisional until spike S2).\n',
      );
      return EXIT.DEPENDENCY;
    }
    for (const f of files) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const e = EventRecord.parse(JSON.parse(line));
        if (e.hook !== 'pre-write' || !e.target_rel) continue;
        const raw = (e.raw ?? {}) as { tool_name?: string; tool_input?: unknown };
        const r = decideOne(raw.tool_name ?? '', raw.tool_input, e.target_rel);
        io.out(
          `recorded ${e.at}: ${raw.tool_name} ${e.target_rel} → recorded ${e.decision.outcome}, replayed ${r.decision.outcome}\n`,
        );
      }
    }
    return EXIT.OK;
  }

  const ev = parseHookEvent(
    readFileSync(packagePath('templates/demo/reapply-43933a1dca.json'), 'utf8'),
    '/demo',
  );
  const effect = applyTool(
    ev.tool_name ?? '',
    ev.tool_input,
    (p) => base.get(p.replace(/^\/demo\//, '')) ?? null,
  );
  const target = effect.kind === 'none' ? '' : (effect.path ?? '').replace(/^\/demo\//, '');
  const r = decideOne(ev.tool_name ?? '', ev.tool_input, target);
  io.out(
    `Live check (not a recording): the real DNR decision for the provisional fixture event reapply-43933a1dca.json (${ev.tool_name} ${target}) against the real Django order dnr-43933a1dca.\n`,
  );
  if (r.decision.outcome === 'block') {
    io.out(`${blockText(order, r.decision, { qualnames: contributingQualnames(r, order.id) })}\n`);
    io.out('exit 2 (blocked: Kiro sends the text above to the agent)\n');
  } else io.out(`decision: ${r.decision.outcome} (exit 0)\n`);
  return EXIT.OK;
}
