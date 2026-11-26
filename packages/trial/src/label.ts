/**
 * `dnr trial label` (§9.5): blind labeling of run, blocked and probe packets; adjudication; and
 * `--freeze`, which checks both labelers covered every packet, writes the adjudicated
 * `reports/labeling/labels.json`, and only then releases the packet key after checking its
 * sha256 against the one committed before labeling.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Arm, Label, ProbeGrade } from '@dnr/schemas';
import { z } from 'zod';
import { type PacketKind, readIndex } from './packets';
import { sha256Hex } from './prng';
import { agreement } from './stats';

export const LABELS = ['FULL', 'CORE', 'PARTIAL_NONCORE', 'NONE', 'UNRELATED_BREAK', 'NO_CHANGE'] as const;
export type LabelValue = (typeof LABELS)[number];
export const REAPPLIED = new Set<LabelValue>(['FULL', 'CORE']);
export const GRADES = [0, 1, 2] as const;

/** `reports/labeling/labelers.json`: who is who (§9.5 Labelers). */
export const Labelers = z.strictObject({
  builder: z.string().min(1),
  outside: z.string().min(1).nullable(),
  adjudicator: z.string().min(1),
  /** §9.5 pre-registered fallback: an LLM third rater replaces the outside labeler. */
  fallback_rater: z.string().min(1).nullable(),
});
export type Labelers = z.infer<typeof Labelers>;

export interface LabelLine {
  code: string;
  kind: PacketKind;
  labeler: string;
  session: string;
  label: LabelValue | null;
  grade: 0 | 1 | 2 | null;
  arm_guess: z.infer<typeof Arm> | null;
  at: string;
}

const labelsFile = (dir: string, labeler: string) =>
  join(dir, 'labels', `${labeler.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);
const adjudicationFile = (dir: string) => join(dir, 'labels', 'adjudication.jsonl');

export function readLabels(dir: string, labeler: string): LabelLine[] {
  const p = labelsFile(dir, labeler);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LabelLine);
}

/** Latest line per packet code. */
export function currentLabels(lines: readonly LabelLine[]): Map<string, LabelLine> {
  const m = new Map<string, LabelLine>();
  for (const l of lines) m.set(l.code, l);
  return m;
}

export function parseLabel(s: string): LabelValue | null {
  const t = s.trim().toUpperCase();
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= LABELS.length) return LABELS[n - 1] as LabelValue;
  return (LABELS as readonly string[]).includes(t) ? (t as LabelValue) : null;
}

export function parseArm(s: string): z.infer<typeof Arm> | null {
  const t = s.trim().toUpperCase();
  if (!t) return null;
  const r = Arm.safeParse(t);
  return r.success ? r.data : null;
}

export interface Answer {
  label?: string;
  grade?: number;
  arm_guess?: string;
}

/**
 * One labeling session: the labeler answers each not-yet-labeled packet of `kind` (or, with
 * `relabel`, every packet labeled in that earlier session). `ask` returns the answer for a code;
 * the CLI passes an interactive prompt, tests and dry runs pass scripted answers.
 */
export async function labelSession(input: {
  labelingDir: string;
  labeler: string;
  kind: PacketKind;
  session: string;
  now: () => string;
  ask: (code: string) => Promise<Answer | null>;
  relabel?: string;
}): Promise<{ labeled: number; remaining: number }> {
  const idx = readIndex(input.labelingDir).filter((p) => p.kind === input.kind);
  const mine = readLabels(input.labelingDir, input.labeler);
  const cur = currentLabels(mine);
  const todo = input.relabel
    ? idx.filter((p) => cur.get(p.code)?.session === input.relabel)
    : idx.filter((p) => !cur.has(p.code));
  let n = 0;
  await mkdir(join(input.labelingDir, 'labels'), { recursive: true });
  for (const p of todo) {
    const a = await input.ask(p.code);
    if (!a) break;
    const line: LabelLine = {
      code: p.code,
      kind: p.kind,
      labeler: input.labeler,
      session: input.session,
      label: null,
      grade: null,
      arm_guess: null,
      at: input.now(),
    };
    if (p.kind === 'probe') {
      if (a.grade !== 0 && a.grade !== 1 && a.grade !== 2)
        throw new Error(`packet ${p.code}: grade must be 0, 1 or 2`);
      line.grade = a.grade;
      ProbeGrade.parse({ packet: p.code, labeler: input.labeler, grade: a.grade, at: line.at });
    } else {
      const lab = parseLabel(a.label ?? '');
      if (!lab) throw new Error(`packet ${p.code}: label must be one of ${LABELS.join(', ')}`);
      line.label = lab;
      line.arm_guess = a.arm_guess ? parseArm(a.arm_guess) : null;
      Label.parse({
        packet: p.code,
        labeler: input.labeler,
        label: lab,
        arm_guess: line.arm_guess,
        at: line.at,
      });
    }
    await appendFile(labelsFile(input.labelingDir, input.labeler), `${JSON.stringify(line)}\n`);
    n++;
  }
  return { labeled: n, remaining: todo.length - n };
}

export interface AdjudicationLine {
  code: string;
  by: string;
  label: LabelValue | null;
  grade: 0 | 1 | 2 | null;
  at: string;
}

export function readAdjudications(dir: string): Map<string, AdjudicationLine> {
  const p = adjudicationFile(dir);
  const m = new Map<string, AdjudicationLine>();
  if (!existsSync(p)) return m;
  for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    const a = JSON.parse(l) as AdjudicationLine;
    m.set(a.code, a);
  }
  return m;
}

const labelValueOf = (l: { label: LabelValue | null; grade: number | null }) =>
  (l.label ?? String(l.grade)) as string;

/** Packets on which the two raters disagree (after the latest labels). */
export function disagreements(dir: string, a: string, b: string): string[] {
  const la = currentLabels(readLabels(dir, a));
  const lb = currentLabels(readLabels(dir, b));
  return [...la.keys()]
    .filter((c) => lb.has(c) && labelValueOf(la.get(c) as LabelLine) !== labelValueOf(lb.get(c) as LabelLine))
    .sort();
}

export async function adjudicate(input: {
  labelingDir: string;
  raters: [string, string];
  by: string;
  now: () => string;
  ask: (code: string) => Promise<Answer | null>;
}): Promise<number> {
  const done = readAdjudications(input.labelingDir);
  const idx = new Map(readIndex(input.labelingDir).map((p) => [p.code, p.kind]));
  let n = 0;
  await mkdir(join(input.labelingDir, 'labels'), { recursive: true });
  for (const code of disagreements(input.labelingDir, ...input.raters)) {
    if (done.has(code)) continue;
    const a = await input.ask(code);
    if (!a) break;
    const probe = idx.get(code) === 'probe';
    const line: AdjudicationLine = {
      code,
      by: input.by,
      label: probe ? null : parseLabel(a.label ?? ''),
      grade: probe ? ((a.grade ?? null) as 0 | 1 | 2 | null) : null,
      at: input.now(),
    };
    if (!probe && !line.label) throw new Error(`packet ${code}: invalid label`);
    if (probe && line.grade === null) throw new Error(`packet ${code}: invalid grade`);
    await appendFile(adjudicationFile(input.labelingDir), `${JSON.stringify(line)}\n`);
    n++;
  }
  return n;
}

export interface SessionKappa {
  labeler: string;
  session: string;
  kind: PacketKind;
  n: number;
  raw: number | null;
  kappa: number | null;
  ok: boolean;
}

/** κ per labeling session (fatigue check): each session's packets against the other rater's labels. A session below 0.4 must be re-labeled. */
export function sessionKappas(dir: string, a: string, b: string): SessionKappa[] {
  const la = currentLabels(readLabels(dir, a));
  const lb = currentLabels(readLabels(dir, b));
  const out: SessionKappa[] = [];
  for (const [me, mine, other] of [
    [a, la, lb],
    [b, lb, la],
  ] as const) {
    const groups = new Map<string, LabelLine[]>();
    for (const l of mine.values()) {
      const k = `${l.session}\0${l.kind}`;
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    for (const [k, ls] of [...groups.entries()].sort()) {
      const [session, kind] = k.split('\0') as [string, PacketKind];
      const pairs = ls.filter((l) => other.has(l.code));
      const cats = kind === 'probe' ? ['0', '1', '2'] : [...LABELS];
      const ag = agreement(
        pairs.map((l) => labelValueOf(l)),
        pairs.map((l) => labelValueOf(other.get(l.code) as LabelLine)),
        cats,
      );
      // κ is undefined when both raters use one category throughout; perfect raw agreement then passes.
      const ok = pairs.length === 0 || (ag.kappa !== null ? ag.kappa >= 0.4 : ag.raw === 1);
      out.push({ labeler: me, session, kind, n: pairs.length, raw: ag.raw, kappa: ag.kappa, ok });
    }
  }
  return out;
}

export const FrozenLabels = z.strictObject({
  frozen_at: z.string(),
  raters: z.tuple([z.string(), z.string()]),
  fallback: z.boolean(),
  packets: z.array(
    z.strictObject({
      code: z.string(),
      kind: z.enum(['run', 'blocked', 'probe']),
      by_rater: z.record(z.string(), z.union([z.string(), z.number()])),
      arm_guess: z.record(z.string(), z.string().nullable()),
      final: z.union([z.enum(LABELS), z.literal(0), z.literal(1), z.literal(2)]),
      source: z.enum(['agreement', 'adjudicated']),
    }),
  ),
  sessions: z.array(
    z.strictObject({
      labeler: z.string(),
      session: z.string(),
      kind: z.string(),
      n: z.number(),
      raw: z.number().nullable(),
      kappa: z.number().nullable(),
      ok: z.boolean(),
    }),
  ),
});
export type FrozenLabels = z.infer<typeof FrozenLabels>;

export class FreezeError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'FreezeError';
  }
}

/** The two raters: builder and outside labeler, or builder and the fallback rater (§9.5 fallback). */
export function raters(l: Labelers): { pair: [string, string]; fallback: boolean } {
  if (l.outside) return { pair: [l.builder, l.outside], fallback: false };
  if (l.fallback_rater) return { pair: [l.builder, l.fallback_rater], fallback: true };
  throw new FreezeError('labelers.json names neither an outside labeler nor a fallback rater');
}

export async function freeze(input: {
  labelingDir: string;
  labelers: Labelers;
  labelsOut: string;
  keyFile: string;
  shaFile: string;
  keyOut: string;
  now: string;
}): Promise<FrozenLabels> {
  const { pair, fallback } = raters(input.labelers);
  const idx = readIndex(input.labelingDir);
  const [a, b] = pair;
  const la = currentLabels(readLabels(input.labelingDir, a));
  const lb = currentLabels(readLabels(input.labelingDir, b));
  const missing = idx.filter((p) => !la.has(p.code) || !lb.has(p.code)).map((p) => p.code);
  if (missing.length > 0)
    throw new FreezeError(
      `both raters must cover every packet; missing ${missing.length}: ${missing.slice(0, 20).join(', ')}`,
    );
  const sessions = sessionKappas(input.labelingDir, a, b);
  const low = sessions.filter((s) => !s.ok);
  if (low.length > 0)
    throw new FreezeError(
      `session κ below 0.4 must be re-labeled after adjudication: ${low.map((s) => `${s.labeler}/${s.session} (κ=${s.kappa?.toFixed(2) ?? 'n/a'})`).join(', ')}`,
    );
  const adj = readAdjudications(input.labelingDir);
  const unresolved: string[] = [];
  const packets: FrozenLabels['packets'] = [];
  for (const p of idx) {
    const x = la.get(p.code) as LabelLine;
    const y = lb.get(p.code) as LabelLine;
    const vx = p.kind === 'probe' ? x.grade : x.label;
    const vy = p.kind === 'probe' ? y.grade : y.label;
    let final: FrozenLabels['packets'][number]['final'];
    let source: 'agreement' | 'adjudicated';
    if (vx === vy) {
      final = vx as typeof final;
      source = 'agreement';
    } else {
      const d = adj.get(p.code);
      if (!d) {
        unresolved.push(p.code);
        continue;
      }
      final = (p.kind === 'probe' ? d.grade : d.label) as typeof final;
      source = 'adjudicated';
    }
    packets.push({
      code: p.code,
      kind: p.kind,
      by_rater: { [a]: vx as string | number, [b]: vy as string | number },
      arm_guess: { [a]: x.arm_guess, [b]: y.arm_guess },
      final,
      source,
    });
  }
  if (unresolved.length > 0)
    throw new FreezeError(
      `${unresolved.length} disagreement(s) need adjudication: ${unresolved.slice(0, 20).join(', ')}`,
    );
  // Labels are frozen first; the key is released only afterwards, and only if its sha256 matches.
  const frozen = FrozenLabels.parse({ frozen_at: input.now, raters: pair, fallback, packets, sessions });
  await mkdir(dirname(input.labelsOut), { recursive: true });
  await writeFile(input.labelsOut, `${JSON.stringify(frozen, null, 2)}\n`);
  if (!existsSync(input.shaFile))
    throw new FreezeError(`${input.shaFile} missing: the key's sha256 must be committed before labeling`);
  const want = readFileSync(input.shaFile, 'utf8').trim().split(/\s+/)[0];
  const keyText = readFileSync(input.keyFile, 'utf8');
  if (sha256Hex(keyText) !== want)
    throw new FreezeError(`packet key sha256 ${sha256Hex(keyText)} ≠ committed ${want}`);
  await mkdir(dirname(input.keyOut), { recursive: true });
  copyFileSync(input.keyFile, input.keyOut);
  return frozen;
}
