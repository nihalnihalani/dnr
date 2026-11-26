/**
 * `dnr draft [--order <id>|--all] [--orders <dir>] [--trial]` (§8, §12.3): runs the bundled
 * `dnr-drafter` agent, validates its output with Zod, retries twice, and caches the result.
 * The runner is injectable; the default one shells out to `kiro-cli` (exit 69 when missing).
 * Replacing a reason appends `edited_reason`, sets `reason_source: drafter` and keeps the status.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { commitInfo } from '@dnr/git';
import type { Order } from '@dnr/schemas';
import { nowIso } from '@dnr/store';
import { z } from 'zod';
import { parse, str } from '../args';
import { packagePath } from '../assets';
import { repoContext, requireHuman } from '../context';
import { CliError, EXIT, missingDependency, usage } from '../errors';
import type { CliIO, DraftRunner } from '../io';

/** The drafter's output contract (§12.3). */
export const DraftOutput = z.strictObject({
  order_id: z.string().regex(/^dnr-[0-9a-f]{10}$/),
  reason: z
    .string()
    .min(10)
    .max(200)
    .refine((s) => /[.!?]$/.test(s.trim()), 'must end with a period')
    .refine(
      (s) => !/https?:\/\/|www\.|`|```|\b[0-9a-f]{7,40}\b|#\d+/.test(s),
      'no URLs, code, SHAs or ticket numbers',
    )
    .refine((s) => (s.trim().match(/[.!?](\s|$)/g) ?? []).length === 1, 'exactly one sentence')
    .refine(
      (s) => !/\b(approve|allow|retire|ignore) (this|the) order\b/i.test(s),
      'no instructions about the order',
    ),
});

export function parseDraft(
  text: string,
  orderId: string,
): { ok: true; reason: string } | { ok: false; error: string } {
  const m = /\{[\s\S]*\}/.exec(text.trim());
  if (!m) return { ok: false, error: 'no JSON object in the output' };
  let j: unknown;
  try {
    j = JSON.parse(m[0]);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${String(e)}` };
  }
  const r = DraftOutput.safeParse(j);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => i.message).join('; ') };
  if (r.data.order_id !== orderId) return { ok: false, error: `order_id ${r.data.order_id} ≠ ${orderId}` };
  return { ok: true, reason: r.data.reason.trim() };
}

/** Untrusted revert and ticket text, wrapped in tags (§12.3). */
export function draftPrompt(
  order: Order,
  revert: { subject: string; body: string },
  tickets: string[],
): string {
  const esc = (s: string) => s.replaceAll('</revert>', '</ revert>').replaceAll('</ticket>', '</ ticket>');
  return [
    `order_id: ${order.id}`,
    `functions: ${[...new Set(order.units.map((u) => `${u.file} ${u.qualname}`))].join('; ')}`,
    `<revert>\n${esc(`${revert.subject}\n\n${revert.body}`.trim())}\n</revert>`,
    ...tickets.map((t) => `<ticket>\n${esc(t)}\n</ticket>`),
  ].join('\n\n');
}

/** Default runner: `kiro-cli chat --no-interactive --agent <bundled agent>` (needs kiro-cli ≥ 3.4). */
export const kiroCliRunner: DraftRunner = ({ agentPath, prompt, cwd, env }) =>
  new Promise((res, rej) => {
    execFile(
      env?.KIRO_CLI ?? 'kiro-cli',
      ['chat', '--v3', '--no-interactive', '--agent', agentPath, prompt],
      // Resolve kiro-cli on the caller's PATH (io.env), not this process's: a test can create the
      // "missing" condition with a PATH that has no kiro-cli.
      { cwd, env: env ?? process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
      (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT')
          rej(missingDependency('DNR: kiro-cli is not installed; `dnr draft` needs it'));
        else if (err) rej(err);
        else res(stdout);
      },
    );
  });

function ticketTexts(root: string, order: Order): string[] {
  const out: string[] = [];
  const f = join(
    root,
    'fixtures',
    'discussion',
    `${(order.revert_sha ?? order.original_sha).slice(0, 10)}.json`,
  );
  if (!existsSync(f)) return out;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    for (const d of Array.isArray(j) ? j : [j])
      out.push([d.title, d.body, ...(d.comments ?? [])].filter(Boolean).join('\n\n').slice(0, 8000));
  } catch {}
  return out;
}

export async function cmdDraft(argv: string[], io: CliIO): Promise<number> {
  const { values: v } = parse(argv, {
    order: { type: 'string' },
    all: { type: 'boolean' },
    orders: { type: 'string' },
    trial: { type: 'boolean' },
    'git-dir': { type: 'string' },
  });
  if (v.help) {
    io.out('dnr draft [--order <id>|--all] [--orders <dir>] [--trial]\n');
    return EXIT.OK;
  }
  if (!v.order && !v.all) throw usage('dnr draft --order <id> | --all');
  requireHuman(io, 'draft');
  const ctx = await repoContext(io, v.orders ? { orders: resolve(io.cwd, str(v.orders) as string) } : {});
  const gitDir = v['git-dir']
    ? resolve(io.cwd, str(v['git-dir']) as string)
    : io.env.DJANGO_SRC && v.trial
      ? io.env.DJANGO_SRC
      : ctx.repoRoot;
  let orders = await ctx.store.orders.list();
  if (v.order) orders = orders.filter((o) => o.id === v.order);
  if (v.order && orders.length === 0) throw usage(`DNR: no order ${v.order}`);
  if (v.trial) {
    const af = join(ctx.repoRoot, 'fixtures', 'assignment.json');
    if (!existsSync(af)) throw missingDependency(`DNR: --trial needs ${af} (run dnr trial assign)`);
    const roles = new Set(
      (JSON.parse(readFileSync(af, 'utf8')) as Array<{ revert_sha: string }>).map((a) => a.revert_sha),
    );
    orders = orders.filter((o) => o.revert_sha && roles.has(o.revert_sha));
  }
  const cacheDir = v.trial ? join(ctx.repoRoot, 'fixtures', 'drafts') : ctx.store.paths.draftsDir;
  await mkdir(cacheDir, { recursive: true });
  const runner = io.draftRunner ?? kiroCliRunner;
  const agentPath = packagePath('templates/agents/dnr-drafter.json');
  let failed = 0;
  for (const o of orders) {
    const cacheFile = join(cacheDir, `${o.id}.json`);
    let reason: string | null = null;
    if (existsSync(cacheFile)) {
      const p = parseDraft(await readFile(cacheFile, 'utf8'), o.id);
      if (p.ok) reason = p.reason;
    }
    if (!reason) {
      const info = await commitInfo(gitDir, o.revert_sha ?? o.original_sha).catch(() => ({
        subject: o.reason,
        body: '',
      }));
      const prompt = draftPrompt(o, info, ticketTexts(ctx.repoRoot, o));
      let lastErr = '';
      for (let attempt = 0; attempt < 3 && !reason; attempt++) {
        const out = await runner({
          agentPath,
          prompt: attempt
            ? `${prompt}\n\nYour previous output was invalid (${lastErr}). Print only the JSON object.`
            : prompt,
          cwd: ctx.repoRoot,
          env: io.env,
        });
        const p = parseDraft(out, o.id);
        if (p.ok) reason = p.reason;
        else lastErr = p.error;
      }
      if (!reason) {
        failed++;
        io.err(
          `DNR: ${o.id}: the drafter gave no valid reason after 3 tries (${lastErr}); the reason is unchanged.\n`,
        );
        continue;
      }
      await writeFile(cacheFile, `${JSON.stringify({ order_id: o.id, reason })}\n`);
    }
    if (reason !== o.reason || o.reason_source !== 'drafter')
      await ctx.store.orders.editReason(o.id, reason, 'dnr-drafter', 'drafter', nowIso(io.env));
    io.out(`${o.id}: ${reason}\n`);
  }
  if (failed) throw new CliError(`DNR: ${failed} order(s) not drafted`, EXIT.FINDINGS);
  return EXIT.OK;
}
