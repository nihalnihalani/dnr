/**
 * VID-05/06/08, VID-01/02, WRITE-03: the video renderer and checker on numbers.json and trial.json
 * produced by the harness's own scoring code from constructed, labeled TEST inputs
 * (scripts/video/test/trial-data.ts), written to temp directories only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORDINGS } from '../../packages/trial/src/decision';
import { impact, pitch, pitchMechanism, pitchResult, readmeOneLiner } from '../submission/pitch';
import {
  checkBannedStems,
  checkBlockBy19,
  main as checkMain,
  checkNumbersVsTrial,
  checkVideo,
  checkWordCaps,
  checkWording,
  prose,
  runChecks,
} from './check';
import { chainVariant, readContext } from './context';
import { parseNumbers, type VideoNumbers } from './numbers';
import { mergeChoice, render, main as renderMain } from './render';
import { buildScript, type ScriptContext, ScriptError } from './script';
import { parseSrt } from './srt';
import { D1, D2, D2_CLOSE, D3, D5, D6, type Scenario, scoreScenario, writeScenario } from './test/trial-data';

const ROOT = join(import.meta.dirname, '../..');
const ctx: ScriptContext = {
  chain: 'fallback',
  surfaces: ['Specs', 'Hooks'],
  repo_url: 'https://github.com/nihalnihalani/dnr',
};

/** TEST DATA: the §11 caption examples, standing in for a filmed run that does not exist yet. */
const TEST_CHOICE = {
  audience: 'For repos that accept AI-agent changes',
  package: 'dnr-guard',
  playground_url: 'https://nihalnihalani.github.io/dnr/',
  case: { id: 'dnr-43933a1dca', reason_short: 'it broke query grouping' },
  run: {
    l_run_id: 'demo/L/43933a1dca/r1',
    t_run_id: 'demo/T/43933a1dca/r1',
    l_outcome: 'stopped_and_reported',
    score: 1,
    task_short: 'Clean up `clear_ordering`',
  },
};

function scored(sc: Scenario, extra: Record<string, unknown> = {}) {
  const { trial, numbers } = scoreScenario(sc);
  const n = mergeChoice(parseNumbers(JSON.parse(JSON.stringify(numbers))), TEST_CHOICE);
  return {
    trial: JSON.parse(JSON.stringify(trial)) as Record<string, unknown>,
    n: { ...n, ...extra } as VideoNumbers,
  };
}

const allText = (n: VideoNumbers) =>
  buildScript(n, ctx)
    .flatMap((s) => [...s.caption, s.narration])
    .join('\n');

describe('VID-08 render: every §11 outcome variant, from real scored numbers', () => {
  it('VID-08 D2: block captions and three rate lines over K_eff', () => {
    const { n } = scored(D2);
    const shots = buildScript(n, ctx);
    expect(shots.find((s) => s.id === 'block')?.caption).toEqual([
      'Blocked: this exact change was undone before',
    ]);
    expect(shots.find((s) => s.id === 'response')?.caption).toEqual(['The agent stops and tells you why']);
    const card = shots.find((s) => s.id === 'results');
    expect(card?.caption).toContain('No DNR: 4 of 8 landed');
    expect(card?.caption).toContain(
      "Steering file from history (our build of New Math Data's approach): 2 of 8 landed",
    );
    expect(card?.caption).toContain('DNR live: 0 of 8 landed');
    expect(card?.narration).toBe('Pre-registered: without DNR, 4 of 8. Steering alone, 2. With DNR, 0.');
    const problem = shots.find((s) => s.id === 'problem')?.caption;
    expect(problem?.[0]).toBe('Existing tests caught 1 of 4 re-applications');
    // No person has confirmed a re-proposal count in this scenario, so it stays pending.
    expect(problem?.[1]).toBe(
      '[pending: numbers.json human_reproposals] reverted changes were proposed again by people',
    );
  });

  it('VID-08 s_close_to_l: the S line keeps its number and the narration changes', () => {
    const { n } = scored(D2_CLOSE);
    expect(n.s_close_to_l).toBe(true);
    const card = buildScript(n, ctx).find((s) => s.id === 'results');
    expect(card?.caption).toContain(
      "Steering file from history (our build of New Math Data's approach): 1 of 8 landed",
    );
    expect(card?.narration).toBe(
      "Steering alone came close. DNR adds the reason, the links and a maintainer's approval.",
    );
    expect(pitchResult(n)).toContain('A steering file from history came close (1 of 8)');
  });

  it('VID-08 D3 warn-only: every slot uses its warn variant, the L line says both tiers', () => {
    const { n } = scored(D3);
    expect(n.mode).toBe('warn-only');
    const shots = buildScript(n, ctx);
    expect(shots.find((s) => s.id === 'block')?.narration).toBe(
      'DNR warns before the file changes, and shows why.',
    );
    expect(shots.find((s) => s.id === 'results')?.caption).toContain(
      'DNR live, both tiers (trial configuration, not shipped): 0 of 8 landed',
    );
    expect(shots.find((s) => s.id === 'surfaces')?.caption).toEqual(['DNR flags every Crew PR']);
    expect(prose(allText(n), n.package)).not.toMatch(/\b(stop|block|guard)/i);
    expect(pitchMechanism(n)).toContain('warns the agent');
  });

  it('VID-08 D5: re-proposal line only at 0:38, the null-result wording on the card', () => {
    const { n } = scored(D5);
    const shots = buildScript(n, ctx);
    expect(shots.find((s) => s.id === 'problem')?.caption).toHaveLength(1);
    expect(shots.find((s) => s.id === 'results')?.caption[0]).toBe(WORDINGS.D5_null(8, 1));
    expect(prose(allText(n), n.package)).not.toMatch(/\b(stop|block|guard)/i);
  });

  it('VID-08 D6→D5: no rate lines anywhere, including the pitch and Impact', () => {
    const { n } = scored(D6);
    expect(n.via_d6).toBe(true);
    const shots = buildScript(n, ctx);
    const card = shots.find((s) => s.id === 'results');
    expect(card?.caption[0]).toBe(WORDINGS.D6_inconclusive);
    expect(card?.narration).toBe('The trial could not produce a reliable rate.');
    for (const t of [allText(n), pitch(n), impact(n, null)]) expect(t).not.toMatch(/\d+ of \d+/);
  });

  it('VID-08 D1 commit-enforce: commit refused by 0:19, no DNR live line, no Q or W_L', () => {
    const { n } = scored(D1);
    const shots = buildScript(n, ctx);
    const block = shots.find((s) => s.id === 'block');
    expect(block?.caption).toEqual(['Blocked at commit: this change was undone before']);
    expect(block?.start).toBeLessThanOrEqual(19);
    expect(shots.some((s) => s.id === 'response')).toBe(false);
    const card = shots.find((s) => s.id === 'results');
    expect(card?.caption.join('\n')).not.toContain('DNR live');
    expect(card?.caption[0]).toBe(WORDINGS.D1_study_failed);
    expect(pitchMechanism(n)).toBe(
      "When a Kiro agent's write would bring a reverted change back, the commit and the Crew check stop it.",
    );
  });

  it('VID-08 Touch the Plan rows and never-filmed outcomes refuse to render', () => {
    const { n } = scored(D2);
    expect(() => buildScript({ ...n, row: 'D4', mode: null }, ctx)).toThrow(ScriptError);
    expect(() => buildScript({ ...n, run: { ...n.run, l_outcome: 'landed' } }, ctx)).toThrow(/FB-1/);
  });

  it('VID-02 SRT: one cue per shot, the block cue at 0:12, under 3:00', () => {
    const { n } = scored(D2);
    const r = render(n, ctx);
    const cues = parseSrt(r.srt);
    expect(cues).toHaveLength(r.shots.length);
    expect(cues[3]?.start).toBe(12);
    expect(cues[3]?.text[0]).toBe('Blocked: this exact change was undone before');
    expect(cues.at(-1)?.end).toBe(170);
    expect(r.srt).not.toContain('`');
  });

  it('VID-10 chain variant is keyed on reports/property-failures.md', () => {
    expect(chainVariant(readFileSync(join(ROOT, 'reports/property-failures.md'), 'utf8'))).toBe('fallback');
    expect(chainVariant('## Engine properties: P3 failed on the engine\n')).toBe('property');
    expect(chainVariant(null)).toBe('pending');
    expect(readContext(ROOT).surfaces).toContain('Hooks');
  });
});

describe('VID-05 checker', () => {
  it('VID-05: numbers match trial.json for every row', () => {
    for (const sc of [D1, D2, D2_CLOSE, D3, D5, D6]) {
      const { n, trial } = scored(sc);
      expect(checkNumbersVsTrial(n, trial).status).toBe('PASS');
    }
  });

  it('VID-05: a number that differs from trial.json fails', () => {
    const { n, trial } = scored(D2);
    const c = checkNumbersVsTrial({ ...n, X_eff: 5 }, trial);
    expect(c.status).toBe('FAIL');
    expect(c.detail).toContain('X_eff');
    expect(checkNumbersVsTrial({ ...n, s_close_to_l: true }, trial).status).toBe('FAIL');
  });

  it('VID-05: §9.8 wording word for word, on the card', () => {
    for (const sc of [D1, D5, D6, D2]) {
      const { n, trial } = scored(sc);
      expect(checkWording(n, trial, buildScript(n, ctx)).status).toBe('PASS');
    }
    const { n, trial } = scored(D5);
    const changed = { ...n, wording: (n.wording ?? '').replace('re-applied', 'reapplied') };
    expect(checkWording(changed, trial, buildScript(changed, ctx)).status).toBe('FAIL');
  });

  it('VID-06: word caps, and task_short without a file path', () => {
    const { n } = scored(D2);
    expect(checkWordCaps(n).map((c) => c.status)).toEqual(['PASS', 'PASS', 'PASS']);
    const long = { ...n, case: { reason_short: 'it broke query grouping in aggregation' } };
    expect(checkWordCaps(long)[1]?.status).toBe('FAIL');
    const path = { ...n, run: { task_short: 'Clean up django/db/query.py' } };
    expect(checkWordCaps(path)[2]?.status).toBe('FAIL');
    expect(checkWordCaps({ ...n, audience: undefined })[0]?.status).toBe('PENDING');
  });

  it('VID-05: banned stems under warn-only, code spans and the package exempt', () => {
    const { n } = scored(D3);
    expect(checkBannedStems(n, [{ where: 'x', text: 'DNR stops it' }]).status).toBe('FAIL');
    expect(checkBannedStems(n, [{ where: 'x', text: 'Blocked: undone' }]).status).toBe('FAIL');
    expect(
      checkBannedStems(n, [{ where: 'x', text: 'Run `dnr list --blocked`, install dnr-guard' }]).status,
    ).toBe('PASS');
    const d2 = scored(D2).n;
    expect(checkBannedStems(d2, [{ where: 'x', text: 'DNR stops it' }]).status).toBe('PASS');
  });

  it('VID-02: the block by 0:19', () => {
    const { n } = scored(D2);
    const r = render(n, ctx);
    expect(checkBlockBy19(r.shots, r.srt).status).toBe('PASS');
    const late = r.shots.map((s) => (s.id === 'block' ? { ...s, start: 20 } : s));
    expect(checkBlockBy19(late, null).status).toBe('FAIL');
  });

  it('VID-05: full run passes on rendered files and fails on a hand edit', () => {
    const { n, trial } = scored(D3);
    const r = render(n, ctx);
    const base = { numbers: n, trial, ctx, rendered: { srt: r.srt, json: r.json } };
    const checks = runChecks(base);
    expect(checks.filter((c) => c.status === 'FAIL')).toEqual([]);
    expect(checks.find((c) => c.id === 'slots')?.status).toBe('PENDING'); // Y and human re-proposals
    const edited = runChecks({
      ...base,
      rendered: { srt: r.srt.replace('Warned', 'Blocked'), json: r.json },
    });
    expect(edited.find((c) => c.id === 'generated')?.status).toBe('FAIL');
  });

  it('VID-05 CLI: reads the files dnr trial report writes; pending, not fail, without numbers.json', () => {
    const w = writeScenario(D2);
    writeFileSync(join(w.dir, 'choice.json'), JSON.stringify(TEST_CHOICE));
    const args = [
      '--numbers',
      w.numbers,
      '--trial',
      w.trial,
      '--choice',
      join(w.dir, 'choice.json'),
      '--rendered',
      w.dir,
    ];
    expect(
      renderMain(['--numbers', w.numbers, '--choice', join(w.dir, 'choice.json'), '--out-dir', w.dir], ROOT),
    ).toBe(3);
    expect(
      renderMain(
        [
          '--numbers',
          w.numbers,
          '--choice',
          join(w.dir, 'choice.json'),
          '--out-dir',
          w.dir,
          '--allow-pending',
        ],
        ROOT,
      ),
    ).toBe(0);
    expect(checkMain(args, ROOT)).toBe(0);
    writeFileSync(w.numbers, readFileSync(w.numbers, 'utf8').replace('"X_eff": 4', '"X_eff": 5'));
    expect(checkMain(args, ROOT)).toBe(1);
    const empty = mkdtempSync(join(tmpdir(), 'dnr-launch-test-'));
    expect(checkMain(['--numbers', join(empty, 'numbers.json')], ROOT)).toBe(0);
    expect(renderMain(['--numbers', join(empty, 'numbers.json')], ROOT)).toBe(1);
  });

  it('WRITE-03: pitch, one-liner and Impact are pending without numbers.json', () => {
    expect(pitchMechanism(null)).toMatch(/^\[pending: reports\/video\/numbers\.json/);
    expect(readmeOneLiner(null)).toMatch(/^\[pending/);
    expect(impact(null, null)).toContain('[pending: reports/pilot.json');
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
describe.skipIf(!hasFfmpeg)('VID-01 ffprobe on a real encoded file (needs ffmpeg)', () => {
  const make = (h: number, secs: number) => {
    const f = join(mkdtempSync(join(tmpdir(), 'dnr-launch-test-')), `v${h}.mp4`);
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${(h * 16) / 9}x${h}:d=${secs}`,
      '-pix_fmt',
      'yuv420p',
      f,
    ]);
    return f;
  };
  it('VID-01: a 2 s 1080p file passes; 720p fails; no file is pending', () => {
    expect(checkVideo(make(1080, 2)).status).toBe('PASS');
    expect(checkVideo(make(720, 2)).status).toBe('FAIL');
    expect(checkVideo(undefined).status).toBe('PENDING');
  });
});
