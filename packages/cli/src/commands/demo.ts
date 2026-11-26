/**
 * `dnr demo` (§8, P13-18): offline replay of the recorded demo block from the bundled fixtures
 * (`templates/demo/`): the Django `dnr-43933a1dca` order, the post-revert text of its file, and
 * the PreToolUse event that re-applies it. No Kiro, no network, no Django checkout.
 */
import { readFileSync } from 'node:fs';
import { applyTool, createState, UnitCache } from '@dnr/core';
import { blockText, contributingQualnames, decideWrite, loadParser, parseHookEvent } from '@dnr/hook';
import { CaseBundle } from '@dnr/schemas';
import { packagePath } from '../assets';
import { EXIT } from '../errors';
import type { CliIO } from '../io';

export async function cmdDemo(argv: string[], io: CliIO): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out('dnr demo   offline replay of the recorded demo block\n');
    return EXIT.OK;
  }
  const bundle = CaseBundle.parse(
    JSON.parse(readFileSync(packagePath('templates/demo/43933a1dca.case.json'), 'utf8')),
  );
  const ev = parseHookEvent(
    readFileSync(packagePath('templates/demo/reapply-43933a1dca.json'), 'utf8'),
    '/demo',
  );
  const order = { ...bundle.order, status: 'approved' as const };
  const base = new Map(bundle.files.map((f) => [f.path, f.baseline_text]));
  const parser = await loadParser();
  const cache = new UnitCache(parser);
  const baseline = createState((p) => base.get(p) ?? null, cache);
  const effect = applyTool(
    ev.tool_name ?? '',
    ev.tool_input,
    (p) => base.get(p.replace(/^\/demo\//, '')) ?? null,
  );
  const target = effect.kind === 'none' ? '' : (effect.path ?? '').replace(/^\/demo\//, '');
  const fixed = effect.kind === 'write' ? { ...effect, path: target } : effect;
  const r = decideWrite({
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
  io.out(`$ dnr check --stdin --hook kiro < reapply-43933a1dca.json   # ${ev.tool_name} ${target}\n`);
  if (r.decision.outcome === 'block') {
    io.out(`${blockText(order, r.decision, { qualnames: contributingQualnames(r, order.id) })}\n`);
    io.out('exit 2 (blocked: Kiro sends the text above to the agent)\n');
  } else io.out(`decision: ${r.decision.outcome} (exit 0)\n`);
  return EXIT.OK;
}
