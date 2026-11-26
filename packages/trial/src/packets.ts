/**
 * §9.5 blind packets. One packet per run (every arm), per blocked proposal in L (its diff is the
 * event's `session_patch`, §9.6 Q) and per probe answer. A packet shows C's diff, the critical
 * edit note, the reason and the agent's diff; it hides arm, decision, score and transcript.
 * Codes are random 6-character strings; packet order is a seeded shuffle (2026). The key
 * (code → run) stays under $TRIAL_ROOT/sealed until `label --freeze`; only its sha256 is
 * committed before labeling.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git } from '@dnr/git';
import { type CriticalEdit, CriticalEdits } from '@dnr/schemas';
import { z } from 'zod';
import { randomCode, seededShuffle, sha256Hex } from './prng';

export const PACKET_SEED = 2026;

export const PacketKind = z.enum(['run', 'blocked', 'probe']);
export type PacketKind = z.infer<typeof PacketKind>;

export const Packet = z.strictObject({
  code: z.string().regex(/^[a-z2-9]{6}$/),
  kind: PacketKind,
  c_subject: z.string(),
  c_diff: z.string(),
  critical_edit: z.string(),
  reason: z.string(),
  /** run: the agent's diff; blocked: the event's session_patch; probe: empty. */
  agent_diff: z.string(),
  /** probe only: the function shown to the model, and its answer. */
  probe: z.strictObject({ pre_image: z.string(), answer: z.string() }).nullable(),
});
export type Packet = z.infer<typeof Packet>;

export const KeyEntry = z.strictObject({
  code: z.string(),
  kind: PacketKind,
  run_id: z.string(),
  revert_sha: z.string(),
  event_id: z.string().nullable(),
});
export type KeyEntry = z.infer<typeof KeyEntry>;
export const PacketKey = z.strictObject({
  generated_at: z.string(),
  seed: z.number(),
  /** sha256 of the sealed run outputs and state (T3), recorded when the packets are generated. */
  sealed_sha256: z.string().nullable(),
  packets: z.array(KeyEntry),
});
export type PacketKey = z.infer<typeof PacketKey>;

export interface PacketItem {
  kind: PacketKind;
  run_id: string;
  revert_sha: string;
  event_id: string | null;
  agent_diff: string;
  probe: { pre_image: string; answer: string } | null;
}

export interface RevertContext {
  c_subject: string;
  c_diff: string;
  critical_edit: string;
  reason: string;
}

/** The critical-edit note shown in packets: the adjudicated annotation, else every labeler's. */
export function criticalEditNote(edits: readonly CriticalEdit[], revertSha: string): string {
  const mine = edits.filter((e) => e.revert_sha === revertSha);
  const use = mine.some((e) => e.adjudicated) ? mine.filter((e) => e.adjudicated) : mine;
  if (use.length === 0) return '(no critical-edit annotation yet)';
  return use
    .map(
      (e) =>
        `${e.side === 'added' ? 'C added' : 'C removed'} in ${e.file} ${e.qualname}: ${e.tokens.join(' ')}`,
    )
    .join('\n');
}

export function loadCriticalEdits(root: string): CriticalEdit[] {
  const p = join(root, 'fixtures/critical-edits.json');
  return existsSync(p) ? CriticalEdits.parse(JSON.parse(readFileSync(p, 'utf8'))) : [];
}

export async function revertContext(
  gitDir: string,
  originalSha: string,
  revertSha: string,
  reason: string | null,
  edits: readonly CriticalEdit[],
): Promise<RevertContext> {
  const c_subject = (await git(['log', '-1', '--format=%s', originalSha], { cwd: gitDir })).trim();
  const c_diff = await git(['diff', '--no-color', `${originalSha}^`, originalSha], { cwd: gitDir });
  // Without an order, the plan's placeholder reason: the revert's subject (§9.3).
  const r_subject = (await git(['log', '-1', '--format=%s', revertSha], { cwd: gitDir })).trim();
  return {
    c_subject,
    c_diff,
    critical_edit: criticalEditNote(edits, revertSha),
    reason: reason ?? r_subject,
  };
}

/** Blocked proposals of an L run: pre-write block events that carry a session_patch. */
export function blockedProposals(eventsText: string): Array<{ event_id: string; session_patch: string }> {
  const out: Array<{ event_id: string; session_patch: string }> = [];
  for (const l of eventsText.split('\n')) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l) as {
        event_id?: string;
        hook?: string;
        decision?: { outcome?: string };
        session_patch?: string | null;
      };
      if (
        e.hook === 'pre-write' &&
        e.decision?.outcome === 'block' &&
        e.event_id &&
        typeof e.session_patch === 'string'
      )
        out.push({ event_id: e.event_id, session_patch: e.session_patch });
    } catch {}
  }
  return out;
}

export class PacketError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'PacketError';
  }
}

/**
 * Writes `<labelingDir>/packets/<code>.json` and `index.json` (shuffled order, no run data), the
 * key to `keyFile`, and the key's sha256 to `shaFile` (committed before labeling). Refuses to
 * overwrite an existing key: re-randomizing after the sha256 is committed would break §9.5.
 */
export async function writePackets(input: {
  items: readonly PacketItem[];
  contextOf: (revertSha: string) => Promise<RevertContext>;
  labelingDir: string;
  keyFile: string;
  shaFile: string;
  now: string;
  rand?: (n: number) => Buffer;
  sealedSha256?: string | null;
}): Promise<{ key: PacketKey; sha256: string }> {
  if (existsSync(input.keyFile))
    throw new PacketError(`${input.keyFile} exists; packets were already generated`);
  const sorted = [...input.items].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.run_id.localeCompare(b.run_id) ||
      (a.event_id ?? '').localeCompare(b.event_id ?? ''),
  );
  const shuffled = seededShuffle(sorted, PACKET_SEED);
  const used = new Set<string>();
  const entries: KeyEntry[] = [];
  const ctx = new Map<string, RevertContext>();
  await mkdir(join(input.labelingDir, 'packets'), { recursive: true });
  for (const it of shuffled) {
    let code = randomCode(input.rand);
    while (used.has(code)) code = randomCode(input.rand);
    used.add(code);
    let c = ctx.get(it.revert_sha);
    if (!c) {
      c = await input.contextOf(it.revert_sha);
      ctx.set(it.revert_sha, c);
    }
    const p = Packet.parse({ code, kind: it.kind, ...c, agent_diff: it.agent_diff, probe: it.probe });
    await writeFile(join(input.labelingDir, 'packets', `${code}.json`), `${JSON.stringify(p, null, 2)}\n`);
    entries.push({
      code,
      kind: it.kind,
      run_id: it.run_id,
      revert_sha: it.revert_sha,
      event_id: it.event_id,
    });
  }
  const index = entries.map((e, i) => ({ order: i + 1, code: e.code, kind: e.kind }));
  await writeFile(join(input.labelingDir, 'packets', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  const key: PacketKey = {
    generated_at: input.now,
    seed: PACKET_SEED,
    sealed_sha256: input.sealedSha256 ?? null,
    packets: entries,
  };
  const text = `${JSON.stringify(key, null, 2)}\n`;
  await mkdir(dirname(input.keyFile), { recursive: true });
  await writeFile(input.keyFile, text, { mode: 0o600 });
  const sha256 = sha256Hex(text);
  await mkdir(dirname(input.shaFile), { recursive: true });
  await writeFile(input.shaFile, `${sha256}  packet-key.json\n`);
  return { key, sha256 };
}

export function readIndex(labelingDir: string): Array<{ order: number; code: string; kind: PacketKind }> {
  const p = join(labelingDir, 'packets', 'index.json');
  if (!existsSync(p)) throw new PacketError(`${p} not found (generate packets first)`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function readPacket(labelingDir: string, code: string): Packet {
  return Packet.parse(JSON.parse(readFileSync(join(labelingDir, 'packets', `${code}.json`), 'utf8')));
}

/** A packet as a labeler sees it (plain text). */
export function renderPacket(p: Packet): string {
  const parts = [
    `Packet ${p.code} (${p.kind})`,
    `Original change C: ${p.c_subject}`,
    `Why it was reverted: ${p.reason}`,
    `Critical edit: ${p.critical_edit}`,
    '--- C diff ---',
    p.c_diff.trimEnd(),
  ];
  if (p.kind === 'probe' && p.probe)
    parts.push(
      '--- Function shown to the model ---',
      p.probe.pre_image.trimEnd(),
      '--- Model answer ---',
      p.probe.answer.trimEnd(),
    );
  else
    parts.push(
      p.kind === 'blocked' ? '--- Blocked proposal (session patch) ---' : '--- Agent diff ---',
      p.agent_diff.trimEnd() || '(empty)',
    );
  return `${parts.join('\n')}\n`;
}
