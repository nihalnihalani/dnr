import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventRecord, Grant, Session } from '@dnr/schemas';
import { openStore } from '@dnr/store';
import { afterEach, describe, expect, it } from 'vitest';
import { checkStaged } from '../src/commit';
import { openContext } from '../src/context';
import { runPreWrite } from '../src/prewrite';
import { formatReplay, replayEvents } from '../src/replay';
import { runSessionConfirm, runSessionStart, runShellAfter } from '../src/session-hooks';
import { runGuardShell } from '../src/shell';
import { runStop } from '../src/stop';
import {
  AFTER,
  BEFORE,
  EXTRA_AFTER,
  envFor,
  event,
  type Fixture,
  readEventsFile,
  revertFixture,
  writeEvent,
} from './helpers';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.repo.cleanup();
  fx = null;
});

function sessions(fx: Fixture): Session[] {
  const dir = join(fx.repo.dir, '.dnr', 'sessions');
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => Session.parse(JSON.parse(readFileSync(join(dir, n), 'utf8'))));
}

function grants(fx: Fixture): Grant[] {
  const dir = join(fx.repo.dir, '.dnr', 'grants');
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => Grant.parse(JSON.parse(readFileSync(join(dir, n), 'utf8'))));
  } catch {
    return [];
  }
}

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-26T12:00:00Z');
const at = (ms: number) => String(ms);

async function allowOnce(fx: Fixture, orderId: string, ms = T0) {
  return openStore(fx.repo.dir, { env: envFor(fx.repo) }).grants.create({
    order_id: orderId,
    kind: 'allow_once',
    session_key: null,
    granted_by: 'human',
    at: ms,
  });
}

function stop(fx: Fixture, env: NodeJS.ProcessEnv, session = 'sess-1', max?: number) {
  return runStop(JSON.stringify({ hook_event_name: 'Stop', cwd: fx.repo.dir, session_id: session }), {
    env,
    ...(max !== undefined ? { maxForcedTurns: max } : {}),
  });
}

function shell(fx: Fixture, command: string, session = 'sess-1') {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    cwd: fx.repo.dir,
    session_id: session,
    tool_name: 'execute_bash',
    tool_input: { command },
  });
}

describe('grants', () => {
  it('R9: an allow-once grant lets the match through as allow_grant, logs the use and adds grants_used', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_NOW: at(T0) });
    await allowOnce(fx, fx.order.id);
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(io.exitCode).toBe(0);
    expect(readEventsFile(fx.repo).at(-1)?.decision.outcome).toBe('allow_grant');
    const [s] = sessions(fx);
    expect(s?.grants_used).toEqual([fx.order.id]);
    const [g] = grants(fx);
    expect(g?.session_key).toBe(s?.session_key);
    expect(g?.used).toHaveLength(1);
    expect(g?.used[0]?.kind).toBe('write');
    expect(g?.blobs[0]?.file).toBe('shop.py');
  });

  it('P10: a grant applies only to its own order', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_NOW: at(T0) });
    await allowOnce(fx, 'dnr-0123456789');
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(io.exitCode).toBe(2);
  });

  it('P10: an unused grant stops applying once it expires (DNR_NOW)', async () => {
    fx = await revertFixture();
    await allowOnce(fx, fx.order.id);
    // Session claims the grant at T0 with an unrelated write, then tries the re-land after the TTL.
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'a\n'), { env: envFor(fx.repo, { DNR_NOW: at(T0) }) });
    const late = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), {
      env: envFor(fx.repo, { DNR_NOW: at(T0 + HOUR + 1) }),
    });
    expect(late.exitCode).toBe(2);
  });

  it('P10: a grant used in this session keeps applying after expiry, for this session only', async () => {
    fx = await revertFixture();
    await allowOnce(fx, fx.order.id);
    const first = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), {
      env: envFor(fx.repo, { DNR_NOW: at(T0) }),
    });
    expect(first.exitCode).toBe(0);
    const later = envFor(fx.repo, { DNR_NOW: at(T0 + 2 * HOUR) });
    const again = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: later });
    expect(again.exitCode).toBe(0);
    expect(readEventsFile(fx.repo).at(-1)?.decision.outcome).toBe('allow_grant');
    // Another session has no grant: blocked.
    const other = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-2'), { env: later });
    expect(other.exitCode).toBe(2);
  });

  it('P10: a pending grant is claimed by one session only', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_NOW: at(T0) });
    await allowOnce(fx, fx.order.id);
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-a'), { env })).exitCode).toBe(0);
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-b'), { env })).exitCode).toBe(2);
  });

  it('R9: a grant also turns off the warn tier for its order (allow_grant, tier warn)', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_NOW: at(T0) });
    await allowOnce(fx, fx.order.id);
    const io = await runPreWrite(
      writeEvent(fx.repo, 'shop.py', BEFORE.replace('return result', 'return -result')),
      { env },
    );
    expect(io.exitCode).toBe(0);
    const d = readEventsFile(fx.repo).at(-1)?.decision;
    expect([d?.outcome, d?.tier]).toEqual(['allow_grant', 'warn']);
  });
});

describe('session confirm', () => {
  it('R13: an approved ask becomes a grant (ask_approved), and neither Stop nor pre-commit blocks the re-land', async () => {
    fx = await revertFixture();
    fx.repo.write('.dnr/config.json', '{"decision_format":"ask"}\n');
    fx.repo.commit('config');
    const env = envFor(fx.repo, { DNR_NOW: at(T0) });
    const ask = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    // The human approves: the tool runs and writes the file, then PostToolUse fires.
    fx.repo.write('shop.py', AFTER);
    await runSessionConfirm(
      event(fx.repo, 'fs_write', { path: 'shop.py', content: AFTER }, { hook: 'PostToolUse' }),
      { env },
    );
    const outcomes = readEventsFile(fx.repo).map((e) => e.decision.outcome);
    expect(outcomes).toContain('ask_approved');
    const [g] = grants(fx);
    expect(g?.kind).toBe('ask');
    expect(g?.used[0]?.kind).toBe('write');
    const [s] = sessions(fx);
    expect(s?.grants_used).toEqual([fx.order.id]);
    expect(s?.pending_ask).toEqual([]);
    // Stop: no forced turn.
    const st = await stop(fx, envFor(fx.repo, { DNR_NOW: at(T0 + 2 * HOUR) }));
    expect(st.stdout).toBe('');
    // Pre-commit: the crossing is allowed by the blob-matched grant.
    fx.repo.git('add', 'shop.py');
    const ctx = await openContext(fx.repo.dir, envFor(fx.repo, { DNR_NOW: at(T0 + 3 * HOUR) }));
    const f = await checkStaged(ctx as NonNullable<typeof ctx>);
    expect(f.find((x) => x.order_id === fx?.order.id)).toMatchObject({ crossing: true, granted: true });
  });

  it('P13: an ask that is not approved expires after 10 minutes and logs ask_denied', async () => {
    fx = await revertFixture();
    fx.repo.write('.dnr/config.json', '{"decision_format":"ask"}\n');
    await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo, { DNR_NOW: at(T0) }) });
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'z\n'), {
      env: envFor(fx.repo, { DNR_NOW: at(T0 + 11 * 60_000) }),
    });
    expect(readEventsFile(fx.repo).map((e) => e.decision.outcome)).toContain('ask_denied');
    expect(grants(fx)).toHaveLength(0);
  });

  it('P13: an ask-approved re-land is honored at Stop and at pre-commit', async () => {
    fx = await revertFixture();
    fx.repo.write('.dnr/config.json', '{"decision_format":"ask"}\n');
    fx.repo.commit('cfg');
    const env = envFor(fx.repo, { DNR_NOW: at(T0) });
    await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    fx.repo.write('shop.py', AFTER);
    await runSessionConfirm(
      event(fx.repo, 'fs_write', { path: 'shop.py', content: AFTER }, { hook: 'PostToolUse' }),
      { env },
    );
    expect((await stop(fx, env)).stdout).toBe('');
    fx.repo.git('add', 'shop.py');
    const ctx = await openContext(fx.repo.dir, env);
    const found = await checkStaged(ctx as NonNullable<typeof ctx>);
    expect(found.every((x) => !x.crossing || x.granted)).toBe(true);
  });
});

describe('Stop backstop', () => {
  it('stop: a re-application the agent made by shell forces a turn; at most 2 per session', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await runSessionStart(
      JSON.stringify({ hook_event_name: 'SessionStart', cwd: fx.repo.dir, session_id: 'sess-1' }),
      { env },
    );
    await runGuardShell(shell(fx, "sed -i '' s/x/y/ shop.py"), { env });
    fx.repo.write('shop.py', AFTER); // the shell call's effect
    await runShellAfter(shell(fx, "sed -i '' s/x/y/ shop.py"), { env });
    expect(sessions(fx)[0]?.touched).toContain('shop.py');
    const outs = [];
    for (let i = 0; i < 3; i++) outs.push(await stop(fx, env));
    for (const o of outs) expect(o.exitCode).toBe(0);
    const forced = outs.filter((o) => o.stdout.includes('"decision":"block"'));
    expect(forced).toHaveLength(2);
    const j = JSON.parse(forced[0]?.stdout ?? '{}');
    expect(j.reason).toMatch(new RegExp(`^DNR: your edits re-apply ${fx.order.id} \\(`));
    expect(j.reason).toContain('Revert only the edits you made to total this session, then tell the user.');
  });

  it('stop: --max-forced-turns caps the turns', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'n\n'), { env });
    fx.repo.write('shop.py', AFTER);
    await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), {
      env: envFor(fx.repo, { DNR_MODE: 'record' }),
    });
    const a = await stop(fx, env, 'sess-1', 1);
    const b = await stop(fx, env, 'sess-1', 1);
    expect(a.stdout).toContain('block');
    expect(b.stdout).toBe('');
  });

  it("stop: scores only touched files, so a human's edit between turns is never forced back", async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'n\n'), { env });
    fx.repo.write('shop.py', AFTER); // a human edit in an editor, not through the agent
    const st = await stop(fx, env);
    expect(st.stdout).toBe('');
  });

  it('stop: skips orders whose grant applies', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_NOW: at(T0) });
    await allowOnce(fx, fx.order.id);
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env })).exitCode).toBe(0);
    fx.repo.write('shop.py', AFTER);
    expect((await stop(fx, envFor(fx.repo, { DNR_NOW: at(T0 + 5 * HOUR) }))).stdout).toBe('');
  });

  it('stop: orders hash — a direct edit of an order file forces one reporting turn', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'n\n'), { env });
    const file = join(fx.repo.dir, '.dnr', 'orders', `${fx.order.id}.json`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"approved"', '"retired"'));
    const a = await stop(fx, env);
    expect(JSON.parse(a.stdout).reason).toContain('order set');
    expect((await stop(fx, env)).stdout).toBe('');
  });

  it('stop: orders hash — a change made through the store (guarded dnr / board) does not force a turn', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'n\n'), { env });
    await openStore(fx.repo.dir, { env }).orders.retire(fx.order.id, 'human');
    expect((await stop(fx, env)).stdout).toBe('');
  });

  it('exit: stop always exits 0, including on a crash', async () => {
    fx = await revertFixture();
    const crash = await runStop('garbage', { env: envFor(fx.repo), cwd: fx.repo.dir });
    expect(crash.exitCode).toBe(0);
    const timeout = await stop(fx, envFor(fx.repo, { DNR_HOOK_TIMEOUT_MS: '1' }));
    expect([timeout.exitCode, timeout.stdout]).toEqual([0, '']);
  });

  it('C1: an invalid config does not make Stop fail open: it reports tamper first and still forces the re-application turn', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'n\n'), { env });
    fx.repo.write('.dnr/config.json', '{"threshold":2}');
    fx.repo.write('shop.py', AFTER);
    await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), {
      env: envFor(fx.repo, { DNR_MODE: 'record' }),
    });
    const a = await stop(fx, env);
    expect(a.exitCode).toBe(0);
    expect(JSON.parse(a.stdout).reason).toContain('DNR config: config is invalid');
    const b = await stop(fx, env);
    expect(JSON.parse(b.stdout).reason).toContain(`re-apply ${fx.order.id}`);
  });

  it('H1: Stop reports tamper in every mode, including DNR_MODE=record', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_MODE: 'record' });
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'n\n'), { env });
    fx.repo.write('.dnr/config.json', '{"mode":"record"}');
    const a = await stop(fx, env);
    expect(JSON.parse(a.stdout).reason).toContain('only DNR_MODE may set');
  });

  it('mode: warn-only Stop forces one turn with the "Tell the user; do not revert unless asked" text', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_MODE: 'warn-only' });
    await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    fx.repo.write('shop.py', AFTER);
    const a = await stop(fx, env, 'sess-1', 2);
    const b = await stop(fx, env, 'sess-1', 2);
    expect(JSON.parse(a.stdout).reason).toBe(
      `DNR: this may re-apply ${fx.order.id} (${fx.order.reason}, https://github.com/example/shop/commit/${fx.R}). Tell the user; do not revert unless asked.`,
    );
    expect(b.stdout).toBe('');
  });

  it('mode: commit-enforce Stop is capped at one turn', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_MODE: 'commit-enforce' });
    await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    fx.repo.write('shop.py', AFTER);
    const outs = [await stop(fx, env, 'sess-1', 2), await stop(fx, env, 'sess-1', 2)];
    expect(outs.filter((o) => o.stdout.includes('block'))).toHaveLength(1);
  });
});

describe('post-shell', () => {
  it('post-shell: guard-shell snapshots the tree and shell-after adds every changed file to touched', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await runGuardShell(shell(fx, "python -c \"open('shop.py','w').write('x')\""), { env });
    expect(sessions(fx)[0]?.shell_snapshot).toMatch(/^[0-9a-f]{40}$/);
    fx.repo.write('shop.py', 'x');
    fx.repo.write('gen/new.py', 'y = 1\n');
    await runShellAfter(shell(fx, 'python -c "…"'), { env });
    const s = sessions(fx)[0];
    expect(s?.touched).toEqual(['gen/new.py', 'shop.py']);
    expect(s?.shell_snapshot).toBeNull();
  });
});

describe('pre-commit', () => {
  it('P15: a re-application split across two committed sessions is blocked at --staged on the crossing commit', async () => {
    fx = await revertFixture({ twoFile: true });
    const env = envFor(fx.repo);
    // Session 1 lands the shop.py half and commits it: no crossing yet.
    fx.repo.write('shop.py', AFTER);
    fx.repo.git('add', 'shop.py');
    let ctx = await openContext(fx.repo.dir, env);
    const first = await checkStaged(ctx as NonNullable<typeof ctx>);
    expect(first.find((f) => f.order_id === fx?.order.id)?.crossing).toBe(false);
    fx.repo.git('commit', '-qm', 'half');
    // Session 2 lands util.py: that commit crosses τ.
    fx.repo.write('util.py', EXTRA_AFTER);
    fx.repo.git('add', 'util.py');
    ctx = await openContext(fx.repo.dir, env);
    const second = await checkStaged(ctx as NonNullable<typeof ctx>);
    expect(second.find((f) => f.order_id === fx?.order.id)).toMatchObject({ crossing: true, granted: false });
  });

  it('P15: an A-heavy order whose first commit lands only the A side still blocks on the commit that completes R', async () => {
    const before = `def score(rows):
    total = 0
    for r in rows:
        total += r.value
    return total / len(rows)
`;
    const after = `def score(rows):
    weighted = [r.value * r.weight for r in rows if r.enabled and r.weight > 0]
    if not weighted:
        raise ValueError("no enabled rows")
    return sum(weighted) / max(len(rows), 1)
`;
    const aSide = `def score(rows):
    weighted = [r.value * r.weight for r in rows if r.enabled and r.weight > 0]
    if not weighted:
        raise ValueError("no enabled rows")
    total = 0
    for r in rows:
        total += r.value
    return sum(weighted) / max(len(rows), 1)
`;
    fx = await revertFixture({ before, after });
    const env = envFor(fx.repo);
    fx.repo.write('shop.py', aSide);
    fx.repo.git('add', 'shop.py');
    let ctx = await openContext(fx.repo.dir, env);
    const a = (await checkStaged(ctx as NonNullable<typeof ctx>))[0];
    expect(a?.crossing).toBe(false);
    expect(a?.edit).toBeGreaterThanOrEqual(0.6); // the A side alone passes τ but fails the two-sided rule
    fx.repo.git('commit', '-qm', 'A side');
    fx.repo.write('shop.py', after);
    fx.repo.git('add', 'shop.py');
    ctx = await openContext(fx.repo.dir, env);
    const b = (await checkStaged(ctx as NonNullable<typeof ctx>))[0];
    expect(b?.crossing).toBe(true);
  });

  it('P12: after a re-land is committed, a later unrelated edit is allowed (re-landed, no crossing)', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    fx.repo.write('shop.py', AFTER);
    fx.repo.commit('re-land');
    fx.repo.write('shop.py', AFTER.replace('return x + 1', 'return x + 2'));
    fx.repo.git('add', 'shop.py');
    const ctx = await openContext(fx.repo.dir, env);
    const f = (await checkStaged(ctx as NonNullable<typeof ctx>))[0];
    expect(f).toMatchObject({ crossing: false, relanded: true });
    // And the pre-write hook only warns on the re-landed order.
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER.replace('item.quantity', 'item.qty')), {
      env,
    });
    expect(readEventsFile(fx.repo).at(-1)?.decision.outcome).not.toBe('block');
    expect([0, 2]).toContain(io.exitCode);
  });

  it('P10: pre-commit allows a crossing only for staged blobs that match a used grant', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_NOW: at(T0) });
    await allowOnce(fx, fx.order.id);
    await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    // Staged content differs from the granted blob (extra edit): not allowed.
    const tweaked = AFTER.replace('return x + 1', 'return x + 1  # tweak');
    fx.repo.write('shop.py', tweaked);
    fx.repo.git('add', 'shop.py');
    let ctx = await openContext(fx.repo.dir, env);
    expect((await checkStaged(ctx as NonNullable<typeof ctx>))[0]).toMatchObject({
      crossing: true,
      granted: false,
    });
    // Exactly the granted blob: allowed, and logged as a commit use.
    fx.repo.write('shop.py', AFTER);
    fx.repo.git('add', 'shop.py');
    ctx = await openContext(fx.repo.dir, env);
    expect((await checkStaged(ctx as NonNullable<typeof ctx>))[0]).toMatchObject({
      crossing: true,
      granted: true,
    });
    expect(grants(fx)[0]?.used.map((u) => u.kind)).toEqual(['write', 'commit']);
  });
});

describe('replay', () => {
  it('SCH-Canon: --canonical drops latency_ms and fast_path, sorts keys, and is stable across replays', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo, { DNR_MODE: 'record' });
    await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'n\n'), { env });
    await runPreWrite(writeEvent(fx.repo, 'shop.py', BEFORE.replace('return result', 'return -result')), {
      env,
    });
    await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    const ctx = await openContext(fx.repo.dir, envFor(fx.repo));
    const file = join(fx.repo.dir, '.dnr', 'events.jsonl');
    const a = formatReplay(await replayEvents(ctx as NonNullable<typeof ctx>, file, fx.repo.dir), true);
    const b = formatReplay(await replayEvents(ctx as NonNullable<typeof ctx>, file, fx.repo.dir), true);
    expect(a).toBe(b);
    const lines = a
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.decision.outcome)).toEqual(['allow', 'warn_block', 'block']);
    for (const l of lines) {
      expect(l.decision).not.toHaveProperty('latency_ms');
      expect(l.decision).not.toHaveProperty('fast_path');
      expect(Object.keys(l.decision)).toEqual([...Object.keys(l.decision)].sort());
    }
    expect(EventRecord.safeParse(readEventsFile(fx.repo)[0]).success).toBe(true);
  });
});
