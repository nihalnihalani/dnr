/**
 * The §11 video checker (VID-05, VID-06, VID-01/02, WRITE-03):
 * - every number in numbers.json matches reports/trial.json;
 * - the per-row wording matches §9.8 word for word (packages/trial/src/decision.ts WORDINGS);
 * - the rendered captions/shot list are exactly what numbers.json renders to;
 * - each caption field is within its word cap;
 * - under D3, D5 and D6→D5 (`warn-only`), no `stop`/`block`/`guard` stem in prose, code spans and
 *   the {{package}} value exempt (captions, narration, pitch, one-liner, tagline, Impact);
 * - the block (or, under D1 `commit-enforce`, the refused commit) appears by 0:19;
 * - with ffprobe, the final video is under 180 s.
 *
 *   pnpm tsx scripts/video/check.ts [--numbers …] [--trial reports/trial.json] [--choice …]
 *                                   [--rendered reports/video] [--video final.mp4]
 *
 * Prints PASS, FAIL or PENDING per check; exits 1 on any FAIL.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { WORDINGS } from '../../packages/trial/src/decision';
import { impact, pitch, readmeOneLiner, tagline } from '../submission/pitch';
import { readContext } from './context';
import { field, loadNumbers, NumbersError, type VideoNumbers } from './numbers';
import { mergeChoice, readChoice, render } from './render';
import type { ScriptContext, Shot } from './script';
import { CAP_SECONDS, parseSrt, screenText } from './srt';

export type Status = 'PASS' | 'FAIL' | 'PENDING';
export interface Check {
  id: string;
  status: Status;
  detail: string;
}

const ok = (id: string, detail: string): Check => ({ id, status: 'PASS', detail });
const bad = (id: string, detail: string): Check => ({ id, status: 'FAIL', detail });
const wait = (id: string, detail: string): Check => ({ id, status: 'PENDING', detail });

/** Fields of numbers.json that must equal trial.json exactly (path in trial.json). */
const SAME: Array<[string, string]> = [
  ['row', 'row'],
  ['via_d6', 'via_d6'],
  ['mode', 'mode'],
  ['prereg_sha', 'prereg_sha'],
  ['content_hash', 'content_hash'],
  ['K', 'K'],
  ['X', 'X'],
  ['K_eff', 'K_eff'],
  ['X_eff', 'X_eff'],
  ['S_eff', 'S_eff'],
  ['W_L', 'W_L'],
  ['Q', 'Q'],
  ['Y', 'Y'],
  ['human_reproposals', 'secondary.human_reproposals'],
];

export function checkNumbersVsTrial(n: VideoNumbers, trial: Record<string, unknown>): Check {
  const diffs: string[] = [];
  const get = (o: unknown, p: string) =>
    p
      .split('.')
      .reduce<unknown>(
        (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
        o,
      );
  for (const [nk, tk] of SAME) {
    const nv = field(n, nk);
    if (nv === undefined) continue;
    const tv = get(trial, tk);
    if (nv !== tv) diffs.push(`${nk}: numbers.json ${JSON.stringify(nv)} ≠ trial.json ${JSON.stringify(tv)}`);
  }
  // The card ratios share K_eff as the denominator and the counts above as numerators.
  for (const [k, num] of [
    ['X_eff', n.X_eff],
    ['S_eff', n.S_eff],
    ['W_L', n.W_L],
  ] as const) {
    const c = n.card?.[k];
    if (!c) continue;
    if (c.num !== num || c.den !== n.K_eff)
      diffs.push(`card.${k} is ${c.num}/${c.den}, expected ${num}/${n.K_eff}`);
  }
  if (n.s_close_to_l !== undefined && n.S_eff !== undefined && n.W_L !== undefined)
    if (n.s_close_to_l !== Math.abs(n.S_eff - n.W_L) <= 1)
      diffs.push(`s_close_to_l is ${n.s_close_to_l} but |S_eff − W_L| = ${Math.abs(n.S_eff - n.W_L)}`);
  return diffs.length ? bad('numbers', diffs.join('; ')) : ok('numbers', 'numbers.json matches trial.json');
}

/** The §9.8 wording the applied row must carry verbatim (K and X from trial.json), or null. */
export function expectedWording(n: VideoNumbers, trial: Record<string, unknown>): string | null {
  if (n.via_d6) return WORDINGS.D6_inconclusive;
  if (n.row === 'D5') return WORDINGS.D5_null(trial.K as number, trial.X as number);
  if (n.row === 'D1' && n.mode === 'commit-enforce') return WORDINGS.D1_study_failed;
  return null;
}

export function checkWording(n: VideoNumbers, trial: Record<string, unknown>, shots: Shot[]): Check {
  const want = expectedWording(n, trial);
  if (want === null)
    return n.wording === undefined
      ? ok('wording', `row ${n.row}: no §9.8 wording applies, and numbers.json carries none`)
      : bad('wording', `row ${n.row} carries a wording it should not: "${n.wording}"`);
  if (n.wording !== want) return bad('wording', `numbers.json wording "${n.wording}" ≠ §9.8 "${want}"`);
  const card = shots.find((s) => s.id === 'results');
  if (!card?.caption.includes(want))
    return bad('wording', 'the results card does not carry the §9.8 wording verbatim');
  return ok(
    'wording',
    `row ${n.row}${n.via_d6 ? ' via D6' : ''}: §9.8 wording verbatim in numbers.json and on the card`,
  );
}

export const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export const CAPS: Array<{ path: string; max: number; noPath?: boolean }> = [
  { path: 'audience', max: 8 },
  { path: 'case.reason_short', max: 5 },
  { path: 'run.task_short', max: 4, noPath: true },
];

export function checkWordCaps(n: VideoNumbers): Check[] {
  return CAPS.map(({ path, max, noPath }) => {
    const v = field(n, path);
    const id = `cap:${path}`;
    if (v === undefined || v === null) return wait(id, `${path} not set (filmed run not chosen yet)`);
    if (typeof v !== 'string') return bad(id, `${path} is not a string`);
    const w = words(v);
    if (w > max) return bad(id, `${path} "${v}" has ${w} words (max ${max})`);
    if (noPath && /[\w-]+\/[\w./-]+|\b[\w-]+\.(py|ts|js|tsx|jsx)\b/.test(v))
      return bad(id, `${path} "${v}" contains a file path`);
    return ok(id, `${path}: ${w}/${max} words`);
  });
}

/** Prose with code spans and the package value removed (§11 exemption). */
export function prose(text: string, pkg: string | undefined): string {
  let t = text.replace(/`[^`]*`/g, ' ');
  if (pkg) t = t.split(pkg).join(' ');
  return t;
}

export const BANNED = /\b(stop|block|guard)\w*/gi;

export function checkBannedStems(n: VideoNumbers, texts: Array<{ where: string; text: string }>): Check {
  if (n.mode !== 'warn-only')
    return ok('stems', `mode ${n.mode ?? 'null'}: the stop/block/guard rule applies only under warn-only`);
  const hits: string[] = [];
  for (const { where, text } of texts)
    for (const m of prose(text, n.package).matchAll(BANNED)) hits.push(`${where}: "${m[0]}"`);
  return hits.length
    ? bad('stems', `warn-only prose uses banned stems: ${hits.join('; ')}`)
    : ok('stems', `warn-only: no stop/block/guard stem in ${texts.length} prose lines`);
}

export function checkBlockBy19(shots: Shot[], srt: string | null): Check {
  const s = shots.find((x) => x.id === 'block');
  if (!s) return bad('block-by-0:19', 'the script has no block shot');
  if (s.start > 19) return bad('block-by-0:19', `the block shot starts at ${s.start} s`);
  if (srt !== null) {
    const cue = parseSrt(srt)[shots.indexOf(s)];
    if (!cue || cue.text[0] !== screenText(s.caption[0] ?? ''))
      return bad('block-by-0:19', 'captions.srt has no cue for the block caption');
    if (cue.start > 19) return bad('block-by-0:19', `captions.srt shows the block at ${cue.start} s`);
  }
  const end = Math.max(...shots.map((x) => x.end));
  if (end >= CAP_SECONDS) return bad('block-by-0:19', `the script runs ${end} s (cap ${CAP_SECONDS})`);
  return ok(
    'block-by-0:19',
    `"${s.caption[0]}" at 0:${String(s.start).padStart(2, '0')}; script length ${end} s`,
  );
}

export function probeVideo(path: string): { duration: number; height: number } {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'format=duration:stream=height',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: Array<{ height?: number }> };
  return { duration: Number(j.format?.duration), height: Number(j.streams?.[0]?.height) };
}

export function checkVideo(path: string | undefined): Check {
  if (!path) return wait('ffprobe', 'no final video given (--video); the video is not cut yet');
  if (!existsSync(path)) return bad('ffprobe', `${path} does not exist`);
  const { duration, height } = probeVideo(path);
  if (!(duration < CAP_SECONDS))
    return bad('ffprobe', `${path} is ${duration} s (must be under ${CAP_SECONDS})`);
  if (height !== 1080) return bad('ffprobe', `${path} is ${duration.toFixed(1)} s but ${height}p, not 1080p`);
  return ok('ffprobe', `${path}: ${duration.toFixed(1)} s, 1080p`);
}

export interface CheckInputs {
  numbers: VideoNumbers;
  trial: Record<string, unknown> | null;
  ctx: ScriptContext;
  /** Files in the rendered directory, when present. */
  rendered: { srt: string | null; json: string | null };
  video?: string;
}

export function runChecks(i: CheckInputs): Check[] {
  const n = i.numbers;
  const r = render(n, i.ctx);
  const out: Check[] = [];
  out.push(i.trial ? checkNumbersVsTrial(n, i.trial) : bad('numbers', 'reports/trial.json is missing'));
  out.push(i.trial ? checkWording(n, i.trial, r.shots) : bad('wording', 'reports/trial.json is missing'));
  if (i.rendered.srt === null || i.rendered.json === null)
    out.push(
      r.pending.length
        ? wait('generated', 'captions not rendered yet (slots pending)')
        : bad('generated', 'captions.srt/shotlist.json missing: run scripts/video/render.ts'),
    );
  else if (i.rendered.srt !== r.srt || i.rendered.json !== r.json)
    out.push(
      bad(
        'generated',
        'captions.srt/shotlist.json differ from what numbers.json renders to (hand-edited or stale)',
      ),
    );
  else out.push(ok('generated', 'captions.srt and shotlist.json are exactly what numbers.json renders to'));
  out.push(...checkWordCaps(n));
  const texts = [
    ...r.shots.flatMap((s) => [
      ...s.caption.map((c, k) => ({ where: `${s.id} caption ${k + 1}`, text: c })),
      { where: `${s.id} narration`, text: s.narration },
    ]),
    { where: 'pitch', text: pitch(n) },
    { where: 'README one-liner', text: readmeOneLiner(n) },
    { where: 'tagline', text: tagline() },
    { where: 'Impact', text: impact(n, null) },
  ];
  out.push(checkBannedStems(n, texts));
  out.push(checkBlockBy19(r.shots, i.rendered.srt));
  out.push(
    r.pending.length
      ? wait('slots', `${r.pending.length} slot(s) without a source: ${r.pending.join(', ')}`)
      : ok('slots', 'every slot has a source'),
  );
  out.push(checkVideo(i.video));
  return out;
}

export const format = (cs: Check[]) => cs.map((c) => `${c.status.padEnd(7)} ${c.id}: ${c.detail}`).join('\n');

export function main(argv: string[], root = process.cwd()): number {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      numbers: { type: 'string', default: 'reports/video/numbers.json' },
      trial: { type: 'string', default: 'reports/trial.json' },
      choice: { type: 'string', default: 'reports/video/choice.json' },
      rendered: { type: 'string', default: 'reports/video' },
      video: { type: 'string' },
    },
  });
  const numbersPath = resolve(root, v.numbers);
  if (!existsSync(numbersPath)) {
    const c = [
      wait('numbers', `${v.numbers} does not exist: \`dnr trial report\` has not run on real trial data`),
      checkVideo(v.video ? resolve(root, v.video) : undefined),
    ];
    process.stdout.write(`${format(c)}\n`);
    return c.some((x) => x.status === 'FAIL') ? 1 : 0;
  }
  let numbers: VideoNumbers;
  try {
    numbers = mergeChoice(loadNumbers(numbersPath), readChoice(resolve(root, v.choice)));
  } catch (e) {
    if (!(e instanceof NumbersError)) throw e;
    process.stdout.write(`FAIL    numbers: ${e.message}\n`);
    return 1;
  }
  const tp = resolve(root, v.trial);
  const rd = resolve(root, v.rendered);
  const read = (f: string) => (existsSync(join(rd, f)) ? readFileSync(join(rd, f), 'utf8') : null);
  const checks = runChecks({
    numbers,
    trial: existsSync(tp) ? (JSON.parse(readFileSync(tp, 'utf8')) as Record<string, unknown>) : null,
    ctx: readContext(root),
    rendered: { srt: read('captions.srt'), json: read('shotlist.json') },
    video: v.video ? resolve(root, v.video) : undefined,
  });
  process.stdout.write(`${format(checks)}\n`);
  return checks.some((c) => c.status === 'FAIL') ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
