import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventRecord, Session } from '@dnr/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { runPreWrite } from '../src/prewrite';
import {
  AFTER,
  BEFORE,
  COMMENT_ONLY,
  EXTRA_AFTER,
  envFor,
  event,
  type Fixture,
  OTHER_EDIT,
  readEventsFile,
  revertFixture,
  writeEvent,
} from './helpers';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.repo.cleanup();
  fx = null;
});

function sessionOf(fx: Fixture, file?: string): Session {
  const dir = join(fx.repo.dir, '.dnr', 'sessions');
  const name =
    file ?? (require('node:fs').readdirSync(dir) as string[]).find((n: string) => n.endsWith('.json'));
  return Session.parse(JSON.parse(readFileSync(join(dir, name as string), 'utf8')));
}

function setConfig(fx: Fixture, cfg: Record<string, unknown>) {
  fx.repo.write('.dnr/config.json', `${JSON.stringify(cfg)}\n`);
}

describe('pre-write hook', () => {
  it('R1: a match in deny format exits 2 with the §6 stderr (reason line first, ≤ 1,200 chars, recovery commands)', async () => {
    fx = await revertFixture();
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(2);
    const lines = io.stderr.trimEnd().split('\n');
    expect(lines[0]).toBe(`DNR: ${fx.order.reason} https://github.com/example/shop/commit/${fx.R}`);
    expect(lines[1]).toMatch(
      new RegExp(`^DNR order ${fx.order.id} matched \\(edit 1\\.00 ≥ 0\\.60\\) in total\\.`),
    );
    expect(io.stderr).toContain(`dnr board --open ${fx.order.id}`);
    expect(io.stderr).toContain(`dnr allow ${fx.order.id}`);
    expect(io.stderr.trimEnd().length).toBeLessThanOrEqual(1200);
    const ev = readEventsFile(fx.repo).at(-1) as EventRecord;
    expect(ev.decision.outcome).toBe('block');
    expect(ev.proposed_text).toBe(AFTER);
    expect(ev.session_patch).toContain('+def total(items, discount=None):');
  });

  it('R12: a match in ask format exits 0 with permissionDecision ask and records pending_ask', async () => {
    fx = await revertFixture();
    setConfig(fx, { decision_format: 'ask' });
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(0);
    const out = JSON.parse(io.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(out.hookSpecificOutput.permissionDecisionReason.split('\n')[0]).toBe(
      `DNR: ${fx.order.reason} https://github.com/example/shop/commit/${fx.R}`,
    );
    const s = sessionOf(fx);
    expect(s.pending_ask).toHaveLength(1);
    expect(s.pending_ask[0]?.order_id).toBe(fx.order.id);
    expect(s.pending_ask[0]?.file).toBe('shop.py');
  });

  it('R2: a non-matching write to a covered unit emits one warn_block in the configured format', async () => {
    fx = await revertFixture();
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', OTHER_EDIT), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(2);
    expect(io.stderr.split('\n')[0]).toContain(`DNR: ${fx.order.reason}`);
    expect(io.stderr).toContain('shown once per session');
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).toBe('warn_block');
    expect(sessionOf(fx).warned).toEqual([fx.order.id]);
  });

  it('R2: warn_block uses the ask format when decision_format is ask', async () => {
    fx = await revertFixture();
    setConfig(fx, { decision_format: 'ask' });
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', OTHER_EDIT), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(0);
    expect(JSON.parse(io.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('R3: a later non-matching write to the same order in the session is allowed (warn_pass)', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', OTHER_EDIT), { env })).exitCode).toBe(2);
    const second = await runPreWrite(writeEvent(fx.repo, 'shop.py', OTHER_EDIT.replace('2)', '3)')), { env });
    expect(second.exitCode).toBe(0);
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).toBe('warn_pass');
    // A different session warns again.
    const other = await runPreWrite(writeEvent(fx.repo, 'shop.py', OTHER_EDIT, 'sess-2'), { env });
    expect(other.exitCode).toBe(2);
  });

  it('§5.16: a write that renames the covered function and re-applies C in the same edit is relocated by the fingerprint lookup and blocks', async () => {
    fx = await revertFixture();
    const renamed = AFTER.replace('def total(', 'def grand_total(');
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', renamed), { env: envFor(fx.repo) });
    const ev = readEventsFile(fx.repo).at(-1) as EventRecord;
    expect(io.exitCode, io.stderr).toBe(2);
    expect(ev.decision.outcome).toBe('block');
    const unit = (ev.decision.breakdown[0] as { units: Array<Record<string, unknown>> }).units[0];
    expect(unit).toMatchObject({
      qualname: 'total',
      proposed: 'relocated',
      relocated_to: { file: 'shop.py', qualname: 'grand_total' },
    });
    // A rename alone (no re-application) is not blocked.
    const plain = await runPreWrite(
      writeEvent(fx.repo, 'shop.py', BEFORE.replace('def total(', 'def grand_total('), 'sess-rename'),
      { env: envFor(fx.repo) },
    );
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).not.toBe('block');
    expect(plain.exitCode === 0 || plain.exitCode === 2).toBe(true);
  });

  it('§5.16: the C-side material is cached by blob content in the state cache, and a forged entry is ignored', async () => {
    fx = await revertFixture();
    const renamed = AFTER.replace('def total(', 'def grand_total(');
    const env = envFor(fx.repo);
    const cacheFile = join(fx.repo.dir, '.dnr', 'cache', 'c-units.json');
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', renamed, 's-a'), { env })).exitCode).toBe(2);
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string[]>;
    const [key] = Object.keys(cached);
    expect(Object.keys(cached)).toHaveLength(1);
    expect(key).toContain('shop.py');
    // Warm: same decision from the cache.
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', renamed, 's-b'), { env })).exitCode).toBe(2);
    // Forged: tokens without C's added tokens are rejected, the blob is parsed again, and it still blocks.
    writeFileSync(cacheFile, JSON.stringify({ [key as string]: ['def', 'x', '(', ')', ':', 'pass'] }));
    const forged = await runPreWrite(writeEvent(fx.repo, 'shop.py', renamed, 's-c'), { env });
    expect(forged.exitCode).toBe(2);
    const ev = readEventsFile(fx.repo).at(-1) as EventRecord;
    expect(ev.decision.outcome).toBe('block');
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))[key as string]).toEqual(cached[key as string]);
  });

  it('P8: a forged c-units entry that keeps every added token but lowers similarity cannot hide a moved and re-applied unit', async () => {
    fx = await revertFixture();
    const renamed = AFTER.replace('def total(', 'def grand_total(');
    const env = envFor(fx.repo);
    const cacheFile = join(fx.repo.dir, '.dnr', 'cache', 'c-units.json');
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', renamed, 's-a'), { env })).exitCode).toBe(2);
    const [key] = Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')));
    // Passes the containment check (holds C's added tokens) but looks nothing like the moved unit.
    const forged = [...fx.order.units[0]!.A, ...Array.from({ length: 200 }, (_, i) => `zz${i}`)];
    writeFileSync(cacheFile, JSON.stringify({ [key as string]: forged }));
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', renamed, 's-b'), { env });
    expect(io.exitCode, io.stderr).toBe(2);
    const ev = readEventsFile(fx.repo).at(-1) as EventRecord;
    expect(ev.decision.outcome).toBe('block');
    expect((ev.decision.breakdown[0] as { units: Array<{ proposed: string }> }).units[0]?.proposed).toBe(
      'relocated',
    );
  });

  it('R2: a formatting-only edit of a covered unit never warns', async () => {
    fx = await revertFixture();
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', COMMENT_ONLY), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(0);
  });

  it('R4: the baseline is the session snapshot tree (pre-session human edits are baseline; index untouched)', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    // A human re-applies the change by hand before the session starts, plus an untracked and an ignored file.
    fx.repo.write('shop.py', AFTER);
    fx.repo.write('scratch.py', 'x = 1\n');
    fx.repo.write('.gitignore', 'ignored.py\n');
    fx.repo.write('ignored.py', 'y = 2\n');
    const status = fx.repo.git('status', '--porcelain');
    const index = fx.repo.git('ls-files', '--stage');
    // Session starts on an unrelated write; the agent then rewrites shop.py with the same text.
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'bye\n'), { env });
    const s = sessionOf(fx);
    expect(fx.repo.git('cat-file', '-p', `${s.baseline_tree}:shop.py`)).toBe(AFTER);
    expect(fx.repo.git('cat-file', '-p', `${s.baseline_tree}:scratch.py`)).toBe('x = 1\n');
    expect(() => fx?.repo.git('cat-file', '-e', `${s.baseline_tree}:ignored.py`)).toThrow();
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(io.exitCode).toBe(0);
    expect(fx.repo.git('status', '--porcelain')).toBe(status);
    expect(fx.repo.git('ls-files', '--stage')).toBe(index);
  });

  it('R4: the temp-index baseline works on an unborn HEAD', async () => {
    const { makeRepo } = await import('./helpers');
    const repo = makeRepo();
    try {
      repo.write('a.py', 'def f():\n    return 1\n');
      const io = await runPreWrite(writeEvent(repo, 'a.py', 'def f():\n    return 2\n'), {
        env: envFor(repo),
      });
      expect(io.exitCode).toBe(0);
      const ev = readEventsFile(repo).at(-1) as EventRecord;
      expect(ev.decision.outcome).toBe('allow');
      expect(repo.git('status', '--porcelain')).toContain('?? a.py');
    } finally {
      repo.cleanup();
    }
  });

  it('R6: writes under every protected glob are denied in deny format', async () => {
    fx = await revertFixture();
    const outside = mkdtempSync(join(tmpdir(), 'dnr-prot-'));
    const ordersDir = join(outside, 'orders');
    const stateDir = join(outside, 'state');
    const cfg = join(outside, 'frozen.json');
    mkdirSync(ordersDir);
    writeFileSync(join(ordersDir, `${fx.order.id}.json`), JSON.stringify(fx.order));
    writeFileSync(cfg, '{}\n');
    const env = envFor(fx.repo, { DNR_ORDERS: ordersDir, DNR_STATE_DIR: stateDir, DNR_CONFIG: cfg });
    const home = env.HOME as string;
    const targets = [
      '.dnr/orders/dnr-0000000000.json',
      '.dnr/config.json',
      '.kiro/hooks/dnr-pre-write.json',
      '.KIRO/Hooks/x.json',
      '.kiro/settings/mcp.json',
      '.kiro/agents/evil.json',
      '.git/hooks/pre-commit',
      join(home, '.kiro', 'hooks', 'x.json'),
      join(ordersDir, `${fx.order.id}.json`),
      join(stateDir, 'grants', 'x.pending.json'),
      cfg,
    ];
    for (const t of targets) {
      const io = await runPreWrite(writeEvent(fx.repo, t, '{}'), { env });
      expect(io.exitCode, t).toBe(2);
      expect(io.stderr, t).toContain('is protected');
    }
    const evs = readFileSync(join(stateDir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(evs.every((l) => JSON.parse(l).decision.outcome === 'deny_protected')).toBe(true);
  });

  it('R6: the protect tier denies in ask format too (permissionDecision deny, exit 0)', async () => {
    fx = await revertFixture();
    setConfig(fx, { decision_format: 'ask' });
    const io = await runPreWrite(writeEvent(fx.repo, '.kiro/hooks/x.json', '{}'), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(0);
    expect(JSON.parse(io.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('P3: a re-application split across two files blocks no later than the write that completes it', async () => {
    for (const order of [
      ['shop.py', 'util.py'],
      ['util.py', 'shop.py'],
    ]) {
      fx = await revertFixture({ twoFile: true });
      const env = envFor(fx.repo);
      const text = (f: string) => (f === 'shop.py' ? AFTER : EXTRA_AFTER);
      const first = await runPreWrite(writeEvent(fx.repo, order[0] as string, text(order[0] as string)), {
        env,
      });
      expect(first.exitCode === 0 || /shown once per session/.test(first.stderr)).toBe(true);
      // The first write landed (the agent proceeds); the second completes the order.
      fx.repo.write(order[0] as string, text(order[0] as string));
      const second = await runPreWrite(writeEvent(fx.repo, order[1] as string, text(order[1] as string)), {
        env,
      });
      expect(second.exitCode).toBe(2);
      expect(second.stderr).toContain('matched (edit 1.00');
      fx.repo.cleanup();
      fx = null;
    }
  });

  it('fast path: a write to a file no approved order covers is allowed without parsing', async () => {
    fx = await revertFixture();
    const io = await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'bye\n'), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(0);
    const ev = readEventsFile(fx.repo).at(-1) as EventRecord;
    expect(ev.decision.fast_path).toBe(true);
    expect(ev.decision.outcome).toBe('allow');
    expect(sessionOf(fx).touched).toContain('notes.txt');
  });

  it('a draft order never blocks', async () => {
    fx = await revertFixture({ status: 'draft' });
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(0);
  });

  it('R10: a stale order only warns', async () => {
    fx = await revertFixture();
    // HEAD rewrites `total` entirely, so more than half of the snapshot tokens differ.
    fx.repo.write(
      'shop.py',
      BEFORE.replace(
        /def total[\s\S]*?return result\n/,
        'def total(xs):\n    return sum(x.cost for x in xs if x)\n',
      ),
    );
    fx.repo.commit('rewrite totals');
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(2);
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).toBe('warn_block');
  });
});

describe('tool adapters', () => {
  it('adapter: fs_write create, legacy command str_replace, str_replace, fs_append and delete_file are scored', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['fs_write', { path: 'shop.py', content: AFTER }],
      ['fs_write', { command: 'create', path: 'shop.py', file_text: AFTER }],
      ['fs_write', { command: 'str_replace', path: 'shop.py', old_str: BEFORE, new_str: AFTER }],
      ['str_replace', { path: 'shop.py', old_str: BEFORE, new_str: AFTER }],
    ];
    for (const [i, [tool, input]] of cases.entries()) {
      const io = await runPreWrite(event(fx.repo, tool, input, { session: `s-${i}` }), { env });
      expect(io.exitCode, `${tool} ${JSON.stringify(Object.keys(input))}`).toBe(2);
    }
  });

  it('adapter: str_replace with zero or several matches is let through', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    const zero = await runPreWrite(
      event(fx.repo, 'str_replace', { path: 'shop.py', old_str: 'nope', new_str: AFTER }),
      { env },
    );
    expect(zero.exitCode).toBe(0);
    const many = await runPreWrite(
      event(fx.repo, 'str_replace', { path: 'shop.py', old_str: 'result', new_str: 'r' }),
      { env },
    );
    expect(many.exitCode).toBe(0);
    const ev = readEventsFile(fx.repo).at(-1) as EventRecord;
    expect(JSON.stringify(ev.decision.breakdown)).toContain('several');
  });

  it('adapter: fs_append appends to the current text; delete_file empties the file; unknown write tools warn', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    const app = await runPreWrite(
      event(fx.repo, 'fs_append', { path: 'shop.py', content: '\n\ndef extra():\n    return 3\n' }),
      { env },
    );
    expect(app.exitCode).toBe(0); // appending a new unit changes no covered unit
    const del = await runPreWrite(event(fx.repo, 'delete_file', { path: 'shop.py' }, { session: 's-del' }), {
      env,
    });
    expect(del.exitCode).toBe(2);
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).toBe('warn_block');
    const unk = await runPreWrite(
      event(fx.repo, 'fs_patch', { path: 'shop.py', patch: '…' }, { session: 's-unk' }),
      { env },
    );
    expect(unk.exitCode).toBe(2);
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).toBe('warn_block');
  });
});

describe('modes', () => {
  it('P5-05 record mode: DNR_MODE=record never blocks and records proposed_text and session_patch on every event', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_MODE: 'record' });
    for (const [p, t] of [
      ['shop.py', AFTER],
      ['notes.txt', 'x\n'],
      ['.dnr/config.json', '{}'],
    ] as const) {
      const io = await runPreWrite(writeEvent(fx.repo, p, t), { env });
      expect(io.exitCode).toBe(0);
    }
    const evs = readEventsFile(fx.repo);
    expect(evs).toHaveLength(3);
    for (const e of evs) {
      expect(EventRecord.safeParse(e).success).toBe(true);
      expect(e.mode).toBe('record');
      expect(e.decision.outcome).toBe('record');
      expect(e.proposed_text).not.toBeNull();
    }
    expect(evs[0]?.session_patch).toContain('+def total(items, discount=None):');
    expect((evs[0]?.decision.breakdown[0] as { would?: string } | undefined)?.would).toBe('block');
  });

  it('H1: `mode: "record"` in the repo config is refused (enforces with the defaults); DNR_MODE=record writes to DNR_RECORD_PATH', async () => {
    fx = await revertFixture();
    setConfig(fx, { mode: 'record' });
    const blocked = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
    expect(blocked.exitCode).toBe(2);
    expect(readFileSync(join(fx.repo.dir, '.dnr', 'hook.log'), 'utf8')).toContain('only DNR_MODE may set');
    const out = join(fx.repo.dir, 'rec', 'events.jsonl');
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-rec'), {
      env: envFor(fx.repo, { DNR_RECORD_PATH: out, DNR_MODE: 'record' }),
    });
    expect(io.exitCode).toBe(0);
    const e = JSON.parse(readFileSync(out, 'utf8').trim());
    expect(e.decision.outcome).toBe('record');
    expect(e.session_patch).toBeTruthy();
  });

  it('mode: warn-only downgrades a match to one warn_block, then warn_pass', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_MODE: 'warn-only' });
    const a = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(a.exitCode).toBe(2);
    expect(a.stderr).toContain('may re-apply');
    expect(a.stderr).toContain('do not revert unless asked');
    const b = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(b.exitCode).toBe(0);
    const evs = readEventsFile(fx.repo);
    expect(evs.map((e) => e.decision.outcome)).toEqual(['warn_block', 'warn_pass']);
  });

  it('mode: commit-enforce pre-write records and warns (never blocks)', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_MODE: 'commit-enforce' });
    const a = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(a.exitCode).toBe(2);
    const e = readEventsFile(fx.repo).at(-1) as EventRecord;
    expect(e.mode).toBe('commit-enforce');
    expect(e.decision.outcome).toBe('warn_block');
    expect(e.proposed_text).toBe(AFTER);
  });

  it('P6-08: each DNR_MODE value writes a Zod-valid EventRecord', async () => {
    for (const m of ['enforce', 'record', 'warn-only', 'commit-enforce']) {
      fx = await revertFixture();
      await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo, { DNR_MODE: m }) });
      const evs = readEventsFile(fx.repo);
      expect(evs.length).toBeGreaterThan(0);
      for (const e of evs) {
        const r = EventRecord.safeParse(e);
        expect(r.success, m).toBe(true);
        expect(e.mode).toBe(m);
      }
      fx.repo.cleanup();
      fx = null;
    }
  });
});

describe('fail open', () => {
  it('R7: invalid stdin exits 0 and logs error_open to hook.log', async () => {
    fx = await revertFixture();
    const io = await runPreWrite('{not json', { env: envFor(fx.repo), cwd: fx.repo.dir });
    expect(io.exitCode).toBe(0);
    expect(readFileSync(join(fx.repo.dir, '.dnr', 'hook.log'), 'utf8')).toContain(
      'error_open hook=pre-write',
    );
    expect(readEventsFile(fx.repo).at(-1)?.decision.outcome).toBe('error_open');
  });

  it('C1: invalid config does not fail open (defaults apply, the issue is logged)', async () => {
    for (const bad of ['{"threshold": "high"}', '{"threshold":2}', 'not json', '{"min_order_weight":-1}']) {
      fx = await revertFixture();
      fx.repo.write('.dnr/config.json', bad);
      const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
      expect(io.exitCode, bad).toBe(2);
      expect(readFileSync(join(fx.repo.dir, '.dnr', 'hook.log'), 'utf8')).toContain('config: config is');
      expect(readEventsFile(fx.repo).at(-1)?.decision.outcome).toBe('block');
      fx.repo.cleanup();
      fx = null;
    }
  });

  it('C1: a committed config wins over a weaker working-copy edit', async () => {
    fx = await revertFixture();
    fx.repo.write('.dnr/config.json', '{"mode":"enforce"}\n');
    fx.repo.commit('config');
    fx.repo.write('.dnr/config.json', '{"mode":"warn-only","threshold":1}\n');
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(2);
    expect(readEventsFile(fx.repo).at(-1)?.decision.outcome).toBe('block');
  });

  it('C1: a committed order wins over a working copy that retires, corrupts or deletes it', async () => {
    for (const tamper of ['retire', 'corrupt', 'delete'] as const) {
      fx = await revertFixture();
      fx.repo.commit('commit the order');
      const file = join(fx.repo.dir, '.dnr', 'orders', `${fx.order.id}.json`);
      if (tamper === 'retire')
        writeFileSync(file, readFileSync(file, 'utf8').replace('"approved"', '"retired"'));
      if (tamper === 'corrupt') writeFileSync(file, '{"x"');
      if (tamper === 'delete') require('node:fs').rmSync(file);
      const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
      expect(io.exitCode, tamper).toBe(2);
      fx.repo.cleanup();
      fx = null;
    }
  });

  it('C1: a corrupt, unreadable or deleted session is rebuilt from the committed tree, not a reason to allow', async () => {
    for (const tamper of ['garble', 'delete'] as const) {
      fx = await revertFixture();
      fx.repo.commit('commit order');
      const env = envFor(fx.repo);
      await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'n\n'), { env });
      // The agent lands the re-application through the shell, then destroys the session.
      fx.repo.write('shop.py', AFTER);
      const dir = join(fx.repo.dir, '.dnr', 'sessions');
      for (const n of require('node:fs').readdirSync(dir) as string[]) {
        if (tamper === 'garble') writeFileSync(join(dir, n), 'x');
        else require('node:fs').rmSync(join(dir, n));
      }
      const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
      expect(io.exitCode, tamper).toBe(2);
      expect(readFileSync(join(fx.repo.dir, '.dnr', 'hook.log'), 'utf8')).toContain(
        'rebuilt with the committed tree',
      );
      fx.repo.cleanup();
      fx = null;
    }
  });

  it('C1: a lock file the agent holds does not make the hook fail open', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'n\n'), { env });
    const dir = join(fx.repo.dir, '.dnr', 'sessions');
    for (const n of require('node:fs').readdirSync(dir) as string[])
      writeFileSync(join(dir, `${n}.lock`), `${process.pid}\n`);
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(io.exitCode).toBe(2);
  }, 15_000);

  it('R7: a timeout allows the write and logs', async () => {
    fx = await revertFixture();
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), {
      env: envFor(fx.repo, { DNR_HOOK_TIMEOUT_MS: '1' }),
    });
    expect(io.exitCode).toBe(0);
    expect(readFileSync(join(fx.repo.dir, '.dnr', 'hook.log'), 'utf8')).toContain('HookTimeoutError');
  });

  it('R7: a corrupt order file is skipped, not fatal', async () => {
    fx = await revertFixture();
    fx.repo.write('.dnr/orders/dnr-ffffffffff.json', '{"broken": true');
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(2);
  });
});

describe('exit codes', () => {
  it('exit: deny format exits 0 to allow and 2 to block', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    expect((await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'a\n'), { env })).exitCode).toBe(0);
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env })).exitCode).toBe(2);
  });

  it('exit: ask format always exits 0', async () => {
    fx = await revertFixture();
    setConfig(fx, { decision_format: 'ask' });
    const env = envFor(fx.repo);
    for (const [p, t] of [
      ['notes.txt', 'a\n'],
      ['shop.py', AFTER],
      ['shop.py', OTHER_EDIT],
      ['.dnr/x', 'y'],
    ] as const) {
      expect((await runPreWrite(writeEvent(fx.repo, p, t, `s-${p}`), { env })).exitCode).toBe(0);
    }
  });

  it('format: ask prints {"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":…}}', async () => {
    fx = await revertFixture();
    setConfig(fx, { decision_format: 'ask' });
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
    const j = JSON.parse(io.stdout);
    expect(Object.keys(j)).toEqual(['hookSpecificOutput']);
    expect(Object.keys(j.hookSpecificOutput)).toEqual(['permissionDecision', 'permissionDecisionReason']);
  });
});

describe('config and env', () => {
  it('config: lookup is DNR_CONFIG, then <repo>/.dnr/config.json, then defaults; DNR_MODE and DNR_THRESHOLD override', async () => {
    const { openStore } = await import('@dnr/store');
    fx = await revertFixture();
    const s0 = openStore(fx.repo.dir, { env: envFor(fx.repo) });
    expect((await s0.loadConfig()).source).toBe('defaults');
    setConfig(fx, { threshold: 0.7, decision_format: 'ask' });
    const s1 = await openStore(fx.repo.dir, { env: envFor(fx.repo) }).loadConfig();
    expect([s1.source, s1.config.threshold, s1.config.decision_format]).toEqual(['repo', 0.7, 'ask']);
    const frozen = join(fx.repo.dir, 'frozen.json');
    writeFileSync(frozen, '{"threshold": 0.8}');
    const s2 = await openStore(fx.repo.dir, { env: envFor(fx.repo, { DNR_CONFIG: frozen }) }).loadConfig();
    expect([s2.source, s2.config.threshold, s2.config.decision_format]).toEqual(['env', 0.8, 'deny']);
    const s3 = await openStore(fx.repo.dir, {
      env: envFor(fx.repo, { DNR_CONFIG: frozen, DNR_MODE: 'warn-only', DNR_THRESHOLD: '0.9' }),
    }).loadConfig();
    expect([s3.config.mode, s3.config.threshold]).toEqual(['warn-only', 0.9]);
  });

  it('env: DNR_THRESHOLD above the score turns a block into a warn', async () => {
    fx = await revertFixture();
    // A partial re-application scores below 1.0; with τ raised above it, the write only warns.
    const partial = AFTER.replace(
      '            result += item.price * item.quantity',
      '            result += item.price',
    );
    const env = envFor(fx.repo, { DNR_THRESHOLD: '0.99' });
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', partial), { env });
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).toBe('warn_block');
    expect(io.exitCode).toBe(2);
  });

  it('env: DNR_ORDERS and DNR_STATE_DIR move the order store and state', async () => {
    fx = await revertFixture();
    const outside = mkdtempSync(join(tmpdir(), 'dnr-env-'));
    mkdirSync(join(outside, 'orders'));
    writeFileSync(join(outside, 'orders', `${fx.order.id}.json`), JSON.stringify(fx.order));
    fx.repo.git('rm', '-rq', '--cached', '--ignore-unmatch', '.dnr');
    require('node:fs').rmSync(join(fx.repo.dir, '.dnr'), { recursive: true, force: true });
    const env = envFor(fx.repo, {
      DNR_ORDERS: join(outside, 'orders'),
      DNR_STATE_DIR: join(outside, 'state'),
    });
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(io.exitCode).toBe(2);
    expect(readFileSync(join(outside, 'state', 'events.jsonl'), 'utf8')).toContain('"outcome":"block"');
  });

  it('env: DNR_DEBUG prints the error on stderr while failing open', async () => {
    fx = await revertFixture();
    const orig = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = ((s: string) => {
      captured += s;
      return true;
    }) as typeof process.stderr.write;
    try {
      await runPreWrite('nope', { env: envFor(fx.repo, { DNR_DEBUG: '1' }), cwd: fx.repo.dir });
    } finally {
      process.stderr.write = orig;
    }
    expect(captured).toContain('DNR debug:');
  });
});

describe('case-insensitive filesystems', () => {
  const ci = (() => {
    const d = mkdtempSync(join(tmpdir(), 'dnr-ci-'));
    writeFileSync(join(d, 'probe'), '');
    return require('node:fs').existsSync(join(d, 'PROBE'));
  })();

  it.skipIf(!ci)(
    'C2: a case-variant path to a covered file is still blocked (pre-write and Stop)',
    async () => {
      for (const variant of ['Shop.py', 'SHOP.PY', 'shop.PY']) {
        fx = await revertFixture();
        const env = envFor(fx.repo);
        const io = await runPreWrite(writeEvent(fx.repo, variant, AFTER), { env });
        expect(io.exitCode, variant).toBe(2);
        expect(io.stderr, variant).toContain('matched (edit 1.00');
        // If it lands anyway (e.g. via the shell), Stop still scores it.
        fx.repo.write(variant, AFTER);
        const { runStop } = await import('../src/stop');
        const st = await runStop(
          JSON.stringify({ hook_event_name: 'Stop', cwd: fx.repo.dir, session_id: 'sess-1' }),
          { env },
        );
        expect(st.stdout, variant).toContain(`re-apply ${fx.order.id}`);
        fx.repo.cleanup();
        fx = null;
      }
    },
  );

  it.skipIf(!ci)('C2: case-variant protected paths stay denied', async () => {
    fx = await revertFixture();
    for (const t of ['.DNR/config.json', '.Kiro/Hooks/x.json', '.GIT/HOOKS/pre-commit', '.git/CONFIG']) {
      const io = await runPreWrite(writeEvent(fx.repo, t, '{}'), { env: envFor(fx.repo) });
      expect(io.exitCode, t).toBe(2);
    }
  });
});

describe('protect tier additions (wave-2 H2)', () => {
  it('H2: .git/config, .git/hooks/** and .kiro/steering/dnr.md are protected; deleting a parent of a protected path is denied', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    for (const t of ['.git/config', '.git/hooks/post-commit', '.kiro/steering/dnr.md']) {
      const io = await runPreWrite(writeEvent(fx.repo, t, 'x'), { env });
      expect(io.exitCode, t).toBe(2);
    }
    for (const d of ['.kiro', '.dnr', '.git', '.']) {
      const io = await runPreWrite(event(fx.repo, 'delete_file', { path: d }), { env });
      expect(io.exitCode, d).toBe(2);
    }
    expect((await runPreWrite(event(fx.repo, 'delete_file', { path: 'notes.txt' }), { env })).exitCode).toBe(
      0,
    );
    expect((await runPreWrite(writeEvent(fx.repo, '.kiro/steering/product.md', 'x'), { env })).exitCode).toBe(
      0,
    );
  });
});

describe('message wording (wave-2 lows)', () => {
  it('L2: the unknown-tool warning names the file instead of "a unit it covers"', async () => {
    fx = await revertFixture();
    const io = await runPreWrite(event(fx.repo, 'fs_patch', { path: 'shop.py', patch: '…' }), {
      env: envFor(fx.repo),
    });
    expect(io.stderr).toContain(
      `DNR order ${fx.order.id} covers shop.py, which this write changes (the tool is not one DNR can score)`,
    );
    expect(io.stderr).not.toContain('a unit it covers');
  });
});
