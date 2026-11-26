import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Order } from '@dnr/schemas';
import { afterAll, describe, expect, it } from 'vitest';
import { DECISION_TABLE, decide, type GateResults, readStudy } from './decision';
import { DEFAULT_ROOT } from './env';
import { FreezeError, freeze, sessionKappas } from './label';
import { blockedProposals, PACKET_SEED, readIndex, readPacket, writePackets } from './packets';
import { seededShuffle, sha256Hex } from './prng';
import { compareResults, orderSizeBucket } from './score';

const tmps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const gate = (o: Partial<GateResults> = {}): GateResults => ({
  s1_blocks_any_registration: true,
  gate_1b_any_registration: true,
  gate_2: true,
  gate_3: true,
  held_out_recall: 0.8,
  ...o,
});
const ok6 = { final: true, participants: 6, rule_holds: true };
const base = { gate: gate(), study: null, K: 30, kappaBinary: 0.7, restoredCases: 3, X: 3, X_restored: 0 };

describe('§9.8 decision table, rows in order D1, D6, D2, D3, D4, D5', () => {
  it('P11-15: D1 when Kiro cannot block (commit-enforce, or Touch the Plan if the study succeeds)', () => {
    const g = gate({ s1_blocks_any_registration: false, gate_1b_any_registration: false });
    expect(decide({ ...base, gate: g })).toMatchObject({ row: 'D1', mode: 'commit-enforce', via_d6: false });
    expect(decide({ ...base, gate: g, study: ok6 })).toMatchObject({ row: 'D1', mode: null });
    // D1 is checked before D6 even when K < 8
    expect(decide({ ...base, gate: g, K: 3 }).row).toBe('D1');
    // one of S1 / 1b passing is enough to block
    expect(decide({ ...base, gate: gate({ s1_blocks_any_registration: false }) }).row).toBe('D2');
  });

  it('P11-15: D6 resolves to D4/D5 with via_d6 when K < 8 or κ < 0.4 with < 8 cases', () => {
    expect(decide({ ...base, K: 7 })).toMatchObject({ row: 'D5', via_d6: true, mode: 'warn-only' });
    expect(decide({ ...base, K: 7, study: ok6 })).toMatchObject({ row: 'D4', via_d6: true, mode: null });
    expect(decide({ ...base, kappaBinary: 0.39, restoredCases: 7 })).toMatchObject({
      row: 'D5',
      via_d6: true,
    });
    expect(decide({ ...base, kappaBinary: null, restoredCases: 0 })).toMatchObject({
      row: 'D5',
      via_d6: true,
    });
  });

  it('P11-15: κ < 0.4 with ≥ 8 restored-test cases computes X on that subset and continues at D2', () => {
    const d = decide({ ...base, kappaBinary: 0.2, restoredCases: 8, X: 9, X_restored: 2 });
    expect(d).toMatchObject({
      row: 'D2',
      via_d6: false,
      X_used: 2,
      x_from_restored_subset: true,
      mode: 'enforce',
    });
    expect(decide({ ...base, kappaBinary: 0.2, restoredCases: 8, X: 9, X_restored: 1 }).row).toBe('D5');
  });

  it('P11-15: D2 needs X ≥ 2, gates 2 and 3, recall ≥ 70%; otherwise D3; X ≤ 1 goes to D4/D5', () => {
    expect(decide(base)).toMatchObject({ row: 'D2', mode: 'enforce' });
    expect(decide({ ...base, X: 2 }).row).toBe('D2');
    expect(decide({ ...base, gate: gate({ gate_3: false }) })).toMatchObject({
      row: 'D3',
      mode: 'warn-only',
    });
    expect(decide({ ...base, gate: gate({ held_out_recall: 0.69 }) }).row).toBe('D3');
    expect(decide({ ...base, X: 1 })).toMatchObject({ row: 'D5', via_d6: false });
    expect(decide({ ...base, X: 0, study: ok6 }).row).toBe('D4');
    // fewer than 6 participants never succeeds
    expect(decide({ ...base, X: 0, study: { ...ok6, participants: 5 } }).row).toBe('D5');
  });

  it('TRIAL-12: the §9.8 table in code matches the plan text word for word', () => {
    const plan = join(DEFAULT_ROOT, '../kiroween2026/kiroween/dnr-plan/06-trial-protocol.md');
    if (!existsSync(plan)) return;
    expect(readFileSync(plan, 'utf8')).toContain(DECISION_TABLE);
  });

  it('TH18: the study file is read from its machine lines; anything else does not succeed', () => {
    const d = tmp('dnr-study-');
    const f = join(d, 's.md');
    writeFileSync(f, 'Final: yes\nParticipants completed: 7\nSuccess rule: pass\n');
    expect(readStudy(f)).toEqual({ final: true, participants: 7, rule_holds: true });
    expect(readStudy(join(d, 'none.md'))).toBeNull();
  });
});

describe('scoring helpers', () => {
  it('TH14: rescore compares every field and reports the path of a difference', () => {
    expect(compareResults({ a: 1, b: { c: 2 } } as never, { a: 1, b: { c: 3 } } as never)).toEqual([
      'b.c: committed 2 ≠ recomputed 3',
    ]);
    expect(orderSizeBucket(7)).toMatch(/warn/);
    expect(orderSizeBucket(16)).toBe('w≥16');
  });
});

const dnrBin = join(DEFAULT_ROOT, 'packages/cli/dist/cli.js');

describe('packets (§9.5)', () => {
  it('P9-11 packets: 6-char unique codes, seeded shuffle (2026), key sha256 written, refuses to regenerate', async () => {
    const d = tmp('dnr-pk-');
    const items = Array.from({ length: 12 }, (_, i) => ({
      kind: 'run' as const,
      run_id: `trial/T/${String(i).padStart(10, '0')}/r1`,
      revert_sha: String(i).padStart(40, '0'),
      event_id: null,
      agent_diff: '',
      probe: null,
    }));
    const keyFile = join(d, 'sealed/packet-key.json');
    const shaFile = join(d, 'reports/labeling/packet-key.sha256');
    const ctx = async () => ({ c_subject: 's', c_diff: '', critical_edit: 'n', reason: 'r' });
    const r = await writePackets({
      items,
      contextOf: ctx,
      labelingDir: join(d, 'lab'),
      keyFile,
      shaFile,
      now: '2026-11-27T00:00:00Z',
    });
    const codes = r.key.packets.map((p) => p.code);
    expect(new Set(codes).size).toBe(12);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{6}$/);
    expect(r.key.packets.map((p) => p.run_id)).toEqual(
      seededShuffle(items.map((i) => i.run_id).sort(), PACKET_SEED),
    );
    expect(readFileSync(shaFile, 'utf8').split(/\s/)[0]).toBe(sha256Hex(readFileSync(keyFile, 'utf8')));
    // round trip: index and packets read back; no run ID or arm in what the labeler sees
    const idx = readIndex(join(d, 'lab'));
    expect(idx.map((x) => x.code)).toEqual(codes);
    const p = readPacket(join(d, 'lab'), codes[0] as string);
    expect(JSON.stringify(p)).not.toMatch(/trial\/T|"arm"/);
    await expect(
      writePackets({ items, contextOf: ctx, labelingDir: join(d, 'lab'), keyFile, shaFile, now: 'x' }),
    ).rejects.toThrow(/already/);
  });

  it.skipIf(!existsSync(dnrBin))(
    'P9-09: two-file session_patch dry run with the built dnr — the second event blocks in enforce mode, its patch holds both files, and the Q packet shows both',
    async () => {
      const fx = JSON.parse(
        readFileSync(join(DEFAULT_ROOT, 'fixtures/hook-events/two-file-order.json'), 'utf8'),
      );
      const order = Order.parse(fx.order);
      for (const mode of ['record', 'enforce'] as const) {
        const d = tmp('dnr-p909-');
        const repo = join(d, 'repo');
        mkdirSync(repo);
        const git = (...a: string[]) =>
          execFileSync('git', ['-C', repo, ...a], {
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 't',
              GIT_AUTHOR_EMAIL: 't@x',
              GIT_COMMITTER_NAME: 't',
              GIT_COMMITTER_EMAIL: 't@x',
            },
          });
        git('init', '-q', '-b', 'main');
        for (const f of fx.files) {
          mkdirSync(dirname(join(repo, f.path)), { recursive: true });
          writeFileSync(join(repo, f.path), f.baseline_text);
        }
        git('add', '-A');
        git('commit', '-qm', 'base');
        mkdirSync(join(d, 'orders'));
        writeFileSync(join(d, 'orders', `${order.id}.json`), JSON.stringify(order));
        const env = {
          ...process.env,
          DNR_MODE: mode,
          DNR_ORDERS: join(d, 'orders'),
          DNR_STATE_DIR: join(d, 'state'),
          DNR_RECORD_PATH: join(d, 'state/events.jsonl'),
        };
        const hook = (e: unknown) => {
          try {
            execFileSync(process.execPath, [dnrBin, 'check', '--stdin', '--hook', 'kiro'], {
              cwd: repo,
              env,
              input: JSON.stringify(e),
            });
            return 0;
          } catch (x) {
            return (x as { status: number }).status;
          }
        };
        // First half: record mode never blocks; enforce mode only warns (warn_block, exit 2), never a match.
        expect(hook(fx.events[0])).toBe(mode === 'record' ? 0 : 2);
        const first = JSON.parse(
          readFileSync(join(d, 'state/events.jsonl'), 'utf8').trim().split('\n')[0] as string,
        );
        expect(first.decision.outcome).toBe(mode === 'record' ? 'record' : 'warn_block');
        writeFileSync(join(repo, fx.events[0].tool_input.path), fx.events[0].tool_input.content);
        expect(hook(fx.events[1])).toBe(mode === 'enforce' ? 2 : 0);
        const lines = readFileSync(join(d, 'state/events.jsonl'), 'utf8').trim().split('\n');
        const last = JSON.parse(lines.at(-1) as string);
        expect(last.decision.outcome).toBe(mode === 'enforce' ? 'block' : 'record');
        expect(last.session_patch).toContain('+++ shop/cart.py');
        expect(last.session_patch).toContain('+++ shop/pricing.py');
        if (mode === 'enforce') {
          const bp = blockedProposals(lines.join('\n'));
          expect(bp).toHaveLength(1);
          const r = await writePackets({
            items: [
              {
                kind: 'blocked',
                run_id: 'trial/L/2222222222/r1',
                revert_sha: order.revert_sha as string,
                event_id: bp[0]?.event_id as string,
                agent_diff: bp[0]?.session_patch as string,
                probe: null,
              },
            ],
            contextOf: async () => ({
              c_subject: order.reason,
              c_diff: '',
              critical_edit: '(none)',
              reason: order.reason,
            }),
            labelingDir: join(d, 'lab'),
            keyFile: join(d, 'key.json'),
            shaFile: join(d, 'key.sha256'),
            now: 'x',
          });
          const p = readPacket(join(d, 'lab'), r.key.packets[0]?.code as string);
          expect(p.kind).toBe('blocked');
          expect(p.agent_diff).toContain('shop/cart.py');
          expect(p.agent_diff).toContain('shop/pricing.py');
        }
      }
    },
    60_000,
  );
});

describe('label --freeze (§9.5)', () => {
  function setup() {
    const d = tmp('dnr-fr-');
    const lab = join(d, 'lab');
    mkdirSync(join(lab, 'packets'), { recursive: true });
    mkdirSync(join(lab, 'labels'), { recursive: true });
    const codes = ['aaaaaa', 'bbbbbb'];
    writeFileSync(
      join(lab, 'packets/index.json'),
      JSON.stringify(codes.map((c, i) => ({ order: i + 1, code: c, kind: 'run' }))),
    );
    const key = join(d, 'key.json');
    writeFileSync(key, '{"k":1}\n');
    const sha = join(d, 'key.sha256');
    writeFileSync(sha, `${sha256Hex('{"k":1}\n')}  packet-key.json\n`);
    const line = (code: string, labeler: string, label: string) =>
      JSON.stringify({
        code,
        kind: 'run',
        labeler,
        session: 's1',
        label,
        grade: null,
        arm_guess: null,
        at: 'x',
      });
    return { d, lab, key, sha, line };
  }
  const labelers = { builder: 'b', outside: 'o', adjudicator: 'a', fallback_rater: null };

  it('P11-08: refuses until both raters cover every packet', async () => {
    const s = setup();
    writeFileSync(
      join(s.lab, 'labels/b.jsonl'),
      `${s.line('aaaaaa', 'b', 'NONE')}\n${s.line('bbbbbb', 'b', 'NONE')}\n`,
    );
    writeFileSync(join(s.lab, 'labels/o.jsonl'), `${s.line('aaaaaa', 'o', 'NONE')}\n`);
    await expect(
      freeze({
        labelingDir: s.lab,
        labelers,
        labelsOut: join(s.d, 'labels.json'),
        keyFile: s.key,
        shaFile: s.sha,
        keyOut: join(s.d, 'out-key.json'),
        now: 'x',
      }),
    ).rejects.toThrow(FreezeError);
    expect(existsSync(join(s.d, 'out-key.json'))).toBe(false);
  });

  it('P11-09: writes labels first, then releases the key only if its sha256 matches the committed one', async () => {
    const s = setup();
    writeFileSync(
      join(s.lab, 'labels/b.jsonl'),
      `${s.line('aaaaaa', 'b', 'NONE')}\n${s.line('bbbbbb', 'b', 'FULL')}\n`,
    );
    writeFileSync(
      join(s.lab, 'labels/o.jsonl'),
      `${s.line('aaaaaa', 'o', 'NONE')}\n${s.line('bbbbbb', 'o', 'FULL')}\n`,
    );
    const args = {
      labelingDir: s.lab,
      labelers,
      labelsOut: join(s.d, 'labels.json'),
      keyFile: s.key,
      shaFile: s.sha,
      keyOut: join(s.d, 'out-key.json'),
      now: 'x',
    };
    writeFileSync(s.key, '{"k":2}\n');
    await expect(freeze(args)).rejects.toThrow(/sha256/);
    expect(existsSync(join(s.d, 'out-key.json'))).toBe(false);
    writeFileSync(s.key, '{"k":1}\n');
    const f = await freeze(args);
    expect(f.packets.map((p) => p.final)).toEqual(['NONE', 'FULL']);
    expect(existsSync(join(s.d, 'out-key.json'))).toBe(true);
  });

  it('TRIAL-10: a session whose κ is below 0.4 blocks the freeze; disagreements need adjudication', async () => {
    const s = setup();
    writeFileSync(
      join(s.lab, 'labels/b.jsonl'),
      `${s.line('aaaaaa', 'b', 'NONE')}\n${s.line('bbbbbb', 'b', 'FULL')}\n`,
    );
    writeFileSync(
      join(s.lab, 'labels/o.jsonl'),
      `${s.line('aaaaaa', 'o', 'FULL')}\n${s.line('bbbbbb', 'o', 'NONE')}\n`,
    );
    expect(sessionKappas(s.lab, 'b', 'o').every((k) => !k.ok)).toBe(true);
    await expect(
      freeze({
        labelingDir: s.lab,
        labelers,
        labelsOut: join(s.d, 'l.json'),
        keyFile: s.key,
        shaFile: s.sha,
        keyOut: join(s.d, 'k.json'),
        now: 'x',
      }),
    ).rejects.toThrow(/below 0.4/);
  });
});
