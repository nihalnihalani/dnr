import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkTransition,
  GrantStore,
  grantApplies,
  newSession,
  nowMs,
  OrderStore,
  parseTtl,
  resolvePaths,
  sessionKeyFor,
  sha256,
  TransitionError,
  withLock,
  writeFileAtomic,
} from '../src/index';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dnr-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('store primitives', () => {
  it('store: atomic writes leave no temp files and replace the target', async () => {
    const f = join(dir, 'a', 'b.json');
    await writeFileAtomic(f, 'one');
    await writeFileAtomic(f, 'two');
    expect(readdirSync(join(dir, 'a'))).toEqual(['b.json']);
  });

  it('store: the O_EXCL lock serialises concurrent read-modify-writes', async () => {
    const f = join(dir, 'counter');
    let n = 0;
    const bump = () =>
      withLock(f, async () => {
        const cur = n;
        await new Promise((r) => setTimeout(r, 2));
        n = cur + 1;
      });
    await Promise.all(Array.from({ length: 20 }, bump));
    expect(n).toBe(20);
  });

  it('store: a lock left by a dead process is broken', async () => {
    const f = join(dir, 'x');
    writeFileSync(`${f}.lock`, '999999\n');
    await expect(withLock(f, async () => 'ok', { timeoutMs: 500 })).resolves.toBe('ok');
  });

  it('env: DNR_NOW sets the clock (ISO or epoch ms); parseTtl reads 1h/30m/90s/2d', () => {
    expect(nowMs({ DNR_NOW: '2026-11-26T00:00:00Z' })).toBe(Date.parse('2026-11-26T00:00:00Z'));
    expect(nowMs({ DNR_NOW: '1000' })).toBe(1000);
    expect([parseTtl('1h'), parseTtl('30m'), parseTtl('90s'), parseTtl('2d'), parseTtl('5')]).toEqual([
      3_600_000, 1_800_000, 90_000, 172_800_000, 5000,
    ]);
  });

  it('env: DNR_STATE_DIR, DNR_ORDERS, DNR_CONFIG and DNR_RECORD_PATH set the paths', () => {
    const p = resolvePaths('/repo', {
      DNR_STATE_DIR: '/s',
      DNR_ORDERS: '/o',
      DNR_CONFIG: '/c.json',
      DNR_RECORD_PATH: '/r.jsonl',
    });
    expect([p.stateDir, p.ordersDir, p.configFile, p.recordFile, p.eventsFile]).toEqual([
      '/s',
      '/o',
      '/c.json',
      '/r.jsonl',
      '/s/events.jsonl',
    ]);
    const d = resolvePaths('/repo', {});
    expect([d.stateDir, d.ordersDir, d.configFile]).toEqual([
      '/repo/.dnr',
      '/repo/.dnr/orders',
      '/repo/.dnr/config.json',
    ]);
  });

  it('sessions: the key is sha256(session_id); the fallback derives from realpath(cwd)', () => {
    expect(sessionKeyFor('abc', dir)).toEqual({ key: sha256('abc'), source: 'hook' });
    const fb = sessionKeyFor(null, dir);
    expect(fb.source).toBe('fallback');
    expect(fb.key).toMatch(/^cwd-[0-9a-f]{64}$/);
  });
});

describe('orders and grants', () => {
  it('store: the transition table matches the board (draft→approved, →retired, retired→draft)', () => {
    expect(checkTransition('draft', 'approved')).toBe('approved');
    expect(checkTransition('approved', 'retired')).toBe('retired');
    expect(checkTransition('retired', 'draft')).toBe('unretired');
    expect(checkTransition('retired', 'approved')).toBeNull();
    expect(checkTransition('approved', 'draft')).toBeNull();
  });

  it('store: an invalid transition throws TransitionError; a missing order throws', async () => {
    const s = new OrderStore(join(dir, 'orders'));
    await expect(s.approve('dnr-0000000000', 'x')).rejects.toThrow(/no order/);
    expect(new TransitionError('a', 'draft', 'draft').name).toBe('TransitionError');
  });

  it('P10: grantApplies: own session only, while unexpired or once used in this session', async () => {
    const g = new GrantStore(join(dir, 'grants'));
    const at = Date.parse('2026-11-26T00:00:00Z');
    const grant = await g.create({
      order_id: 'dnr-aaaaaaaaaa',
      kind: 'allow_once',
      session_key: 's1',
      granted_by: 'h',
      at,
    });
    const s1 = newSession({
      key: { key: 's1', source: 'hook' },
      baseline_tree: 'a'.repeat(40),
      orders_hash: '',
      at: new Date(at).toISOString(),
    });
    const s2 = { ...s1, session_key: 's2' };
    expect(grantApplies(grant, s1, at + 1000)).toBe(true);
    expect(grantApplies(grant, s2, at + 1000)).toBe(false);
    expect(grantApplies(grant, s1, at + 3_600_001)).toBe(false);
    const used = await g.recordUse('dnr-aaaaaaaaaa', 's1', { event_id: 'e1', kind: 'write' }, [
      { file: 'a.py', sha256: 'x' },
    ]);
    expect(
      grantApplies(
        used as NonNullable<typeof used>,
        { ...s1, grants_used: ['dnr-aaaaaaaaaa'] },
        at + 9_999_999,
      ),
    ).toBe(true);
    expect(
      grantApplies(
        used as NonNullable<typeof used>,
        { ...s2, grants_used: ['dnr-aaaaaaaaaa'] },
        at + 9_999_999,
      ),
    ).toBe(false);
    expect(await g.commitGrant('dnr-aaaaaaaaaa', [{ file: 'a.py', sha256: 'x' }])).not.toBeNull();
    expect(await g.commitGrant('dnr-aaaaaaaaaa', [{ file: 'a.py', sha256: 'y' }])).toBeNull();
  });

  it('store: a pending grant is claimed once, and expired unused grants are gc-ed', async () => {
    const g = new GrantStore(join(dir, 'grants'));
    const at = 1_000_000;
    await g.create({
      order_id: 'dnr-bbbbbbbbbb',
      kind: 'allow_once',
      session_key: null,
      granted_by: 'h',
      at,
    });
    expect((await g.claimPending('s1', at + 1)).map((x) => x.session_key)).toEqual(['s1']);
    expect(await g.claimPending('s2', at + 2)).toEqual([]);
    expect(await g.gc(at + 3_600_001)).toBe(1);
  });
});
