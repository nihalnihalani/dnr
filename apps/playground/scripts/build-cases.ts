/**
 * Playground data, from real sources only (AGENTS.md: no mocks, no seeded data).
 *
 *   pnpm -F @dnr/playground cases
 *
 * - Cases: the `dnr export-case` bundles for the two Django demo reverts
 *   (packages/cli/templates/demo/<sha10>.case.json, or DNR_EXPORT_DIR), unchanged: same order,
 *   same stored status (draft until a human approves it), same presets. The one addition is
 *   the held-out paraphrase. export-case omits it until fixtures/mutations/ exists, so it is
 *   generated here with the same generator (testkit held-out families, seeds 2000–2004), and the
 *   label and the case notes say which mutant it is.
 * - Graveyard: the real orders in reports/orders/ (built with `dnr orders build` from Django),
 *   with their effective status computed by the built CLI (`dnr orders list --json`) in the
 *   Django clone. Nothing is assigned.
 *
 * A missing input fails the script; nothing is filled in.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, decide, grammarForPath, type ParserProvider, UnitCache } from '@dnr/core';
import { loadGrammarsNode } from '@dnr/grammar/node';
import { CaseBundle, Order } from '@dnr/schemas';
import { HELD_OUT_FAMILIES, mutate, SEEDS } from '@dnr/testkit';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/cases');
const repoRoot = resolve(here, '../../..');
const CLI = join(repoRoot, 'packages/cli/dist/cli.js');
const ORDERS = join(repoRoot, 'reports/orders');
const DEMO_REVERTS = ['43933a1dca', 'd0e4dd5cdd'];

type Preset = CaseBundle['presets'][number];
interface IndexEntry {
  id: string;
  title: string;
  order_id: string;
  grammars: string[];
  source: { repo: string; license: string; from: string };
  notes: string[];
  omitted: Array<{ kind: string; reason: string }>;
}

function fail(msg: string): never {
  console.error(`build-cases: ${msg}`);
  process.exit(1);
}

function firstOutcome(provider: ParserProvider, bundle: CaseBundle, order: Order, writes: Preset['writes']) {
  const cache = new UnitCache(provider);
  const base = Object.fromEntries(bundle.files.map((f) => [f.path, f.baseline_text]));
  const baseline = createState(base, cache);
  const w = writes[0];
  if (!w) return 'none';
  const proposed = createState({ ...base, [w.path]: w.proposed_text }, cache);
  return decide({ target: w.path, orders: [{ order }], baseline, current: baseline, proposed }).decision
    .outcome;
}

function loadExport(provider: ParserProvider, short: string): { bundle: CaseBundle; entry: IndexEntry } {
  const dirs = [process.env.DNR_EXPORT_DIR, join(repoRoot, 'packages/cli/templates/demo')].filter(
    (d): d is string => !!d,
  );
  const file = dirs.map((d) => join(d, `${short}.case.json`)).find((f) => existsSync(f));
  if (!file)
    fail(`no export-case bundle for ${short} in ${dirs.join(', ')} (run \`dnr export-case ${short}\`)`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as CaseBundle & {
    omitted_presets?: Array<{ kind: string; reason: string }>;
  };
  const exported = CaseBundle.parse(raw);
  const order = exported.order;
  const from = file.startsWith(repoRoot) ? relative(repoRoot, file) : basename(file);
  const notes = [`source: dnr export-case (${from})`, `order status as stored: ${order.status}`];
  const presets = [...exported.presets];
  const omitted: IndexEntry['omitted'] = [];
  for (const o of raw.omitted_presets ?? []) {
    if (o.kind !== 'held-out-paraphrase') {
      omitted.push({ kind: o.kind, reason: o.reason });
      continue;
    }
    const tried: string[] = [];
    let found: Preset | null = null;
    for (const family of HELD_OUT_FAMILIES) {
      for (const seed of SEEDS.heldOut) {
        const m = mutate({
          provider,
          family,
          seed,
          revertSha: order.revert_sha ?? order.original_sha,
          files: exported.files.map((f) => ({
            path: f.path,
            text: f.change_text,
            baseline: f.baseline_text,
          })),
          units: order.units.map((u) => ({ file: u.file, qualname: u.qualname })),
        });
        tried.push(`${family}/${seed}`);
        const writes = (m?.sessions[0] ?? [])
          .filter((w) => w.text !== null)
          .map((w) => ({ path: w.path, proposed_text: w.text as string }));
        if (writes.length) {
          found = {
            id: 'held-out-paraphrase',
            label: `Held-out paraphrase (${family}, seed ${seed})`,
            kind: 'held-out-paraphrase',
            writes,
          };
          break;
        }
      }
      if (found) break;
    }
    if (found) {
      presets.splice(1, 0, found);
      notes.push(
        `held-out-paraphrase: testkit mutant, tried ${tried.join(', ')} (export-case had no fixture)`,
      );
    } else {
      omitted.push({ kind: o.kind, reason: `no valid held-out mutant (tried ${tried.join(', ')})` });
    }
  }
  const bundle = CaseBundle.parse({ ...exported, presets });
  // What each preset does once a human approves the order (the Playground starts with the stored draft).
  const approved: Order = { ...order, status: 'approved' };
  for (const p of presets)
    notes.push(
      `${p.id}: when approved, the first write decides ${firstOutcome(provider, bundle, approved, p.writes)}`,
    );
  const grammars = [
    ...new Set(
      bundle.files.map((f) => grammarForPath(f.path)).filter((g): g is NonNullable<typeof g> => !!g),
    ),
  ];
  return {
    bundle,
    entry: {
      id: bundle.id,
      title: bundle.title.replace(/^dnr-[0-9a-f]{10}: /, ''),
      order_id: order.id,
      grammars,
      source: { ...bundle.source, from },
      notes,
      omitted,
    },
  };
}

/** Real effective status from the built CLI, run in the Django clone the orders were built from. */
function graveyard(django: string) {
  if (!existsSync(CLI)) fail(`the built CLI is missing (${CLI}): run pnpm -F dnr-guard build`);
  const cmd = ['orders', 'list', '--json', '--orders', ORDERS];
  const listed = JSON.parse(execFileSync('node', [CLI, ...cmd], { cwd: django, encoding: 'utf8' })) as Array<{
    id: string;
    effective: string;
  }>;
  const rows = listed.map((l) => {
    const order = Order.parse(JSON.parse(readFileSync(join(ORDERS, `${l.id}.json`), 'utf8')));
    return { order, effective: l.effective, drift: false, case_id: l.id.replace(/^dnr-/, '') };
  });
  return {
    computed_by: `cd <django clone> && dnr ${cmd.join(' ').replace(ORDERS, 'reports/orders')}`,
    django_head: execFileSync('git', ['-C', django, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    rows,
  };
}

async function main() {
  const django = process.env.DJANGO_SRC ?? resolve(repoRoot, '../dnr-work/django');
  if (!existsSync(join(django, '.git'))) fail(`Django clone not found at ${django} (set DJANGO_SRC)`);
  const provider = await loadGrammarsNode();
  mkdirSync(outDir, { recursive: true });
  // Drop any case file this script no longer produces.
  for (const f of readdirSync(outDir)) if (f.endsWith('.json')) rmSync(join(outDir, f));
  const index: IndexEntry[] = [];
  for (const short of DEMO_REVERTS) {
    const { bundle, entry } = loadExport(provider, short);
    writeFileSync(join(outDir, `${bundle.id}.json`), `${JSON.stringify(bundle)}\n`);
    index.push(entry);
    console.log(`${bundle.id}: ${bundle.order.units.length} units, ${bundle.presets.length} presets`);
    for (const n of entry.notes) console.log(`  ${n}`);
  }
  const g = graveyard(django);
  writeFileSync(join(outDir, 'graveyard.json'), `${JSON.stringify(g)}\n`);
  console.log(`graveyard: ${g.rows.map((r) => `${r.order.id}=${r.effective}`).join(', ')}`);
  writeFileSync(
    join(outDir, 'index.json'),
    `${JSON.stringify(
      {
        generator: 'apps/playground/scripts/build-cases.ts',
        cases: index,
        pending: [
          {
            what: 'TypeScript case',
            why: 'the Phase 0 TypeScript demo revert (fixtures/pins.json ts_demo) is not chosen yet',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((e) => fail(String(e?.stack ?? e)));
