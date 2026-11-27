import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGrammarsNode } from '@dnr/grammar/node';
import { CaseBundle } from '@dnr/schemas';
import { describe, expect, it } from 'vitest';
import { LocalAdapter, memoryStorage } from './adapters/local';
import { strReplaceFor } from './engine/replay';
import { CaseEngine, headline, initialState, newSession } from './engine/session';
import {
  applyPatch,
  checkTransition,
  graveyardSummary,
  STATE_INFO,
  TransitionRejected,
} from './model/states';
import { AdapterError, type OrderRow } from './model/types';

const cases = fileURLToPath(new URL('../../../apps/playground/public/cases/', import.meta.url));
const bundle = CaseBundle.parse(JSON.parse(readFileSync(`${cases}43933a1dca.json`, 'utf8')));
const seedRows = (JSON.parse(readFileSync(`${cases}graveyard.json`, 'utf8')) as { rows: OrderRow[] }).rows;

describe('state model', () => {
  it('STATE-01: every state has a visual, a label and next actions', () => {
    expect(STATE_INFO.draft).toEqual({
      visual: 'outlined',
      label: 'Draft: not enforced',
      actions: ['approve', 'edit', 'retire'],
    });
    expect(STATE_INFO.approved.actions).toEqual(['allow-once', 'edit', 'retire']);
    expect(STATE_INFO.retired.actions).toEqual(['unretire']);
    expect(STATE_INFO.stale.label).toBe('Stale: code changed, warn only');
    expect(STATE_INFO.relanded.label).toBe('Re-landed: warn only until re-approved');
  });
  it('API-03: transitions follow the table; everything else is rejected', () => {
    expect(checkTransition('draft', 'approved')).toEqual({ ok: true, action: 'approved' });
    expect(checkTransition('retired', 'draft')).toEqual({ ok: true, action: 'unretired' });
    for (const [a, b] of [
      ['approved', 'draft'],
      ['retired', 'approved'],
      ['draft', 'draft'],
    ] as const)
      expect(checkTransition(a, b).ok).toBe(false);
    expect(() => applyPatch(bundle.order, { status: 'draft' }, 'me', '2026-11-26T00:00:00Z')).toThrow(
      TransitionRejected,
    );
  });
  it('STATE-07: empty and drafts-only summaries', () => {
    expect(graveyardSummary([])).toMatchObject({ kind: 'no-orders', next: 'dnr scan' });
    expect(graveyardSummary([], { scanFoundZero: true })).toMatchObject({ kind: 'no-reverts' });
    expect(graveyardSummary([{ effective: 'draft' }, { effective: 'draft' }])).toMatchObject({
      label: '2 drafts, 0 enforced',
    });
  });
});

describe('P7-01: localStorage adapter', () => {
  const make = () => {
    let t = Date.parse('2026-11-26T12:00:00Z');
    const storage = memoryStorage();
    const a = new LocalAdapter(
      async () => seedRows,
      storage,
      () => t,
    );
    return { a, storage, tick: (ms: number) => (t += ms) };
  };
  it('P7-01: simulated actions persist in storage and 409 on invalid transitions', async () => {
    const { a, storage } = make();
    const draft = (await a.listOrders()).find((r) => r.effective === 'draft') as OrderRow;
    await a.patchOrder(draft.order.id, { status: 'approved' });
    const again = new LocalAdapter(async () => seedRows, storage);
    expect((await again.getOrder(draft.order.id))?.effective).toBe('approved');
    await expect(a.patchOrder(draft.order.id, { status: 'draft' })).rejects.toMatchObject({ status: 409 });
    await expect(a.reapprove('dnr-43933a1dca')).rejects.toBeInstanceOf(AdapterError);
  });
  it('P7-01: re-approve is only for stale, re-landed or violated orders (409 otherwise)', async () => {
    const { a } = make();
    await expect(a.reapprove('dnr-43933a1dca')).rejects.toMatchObject({ status: 409 }); // draft
    await a.patchOrder('dnr-43933a1dca', { status: 'approved' });
    await expect(a.reapprove('dnr-43933a1dca')).rejects.toMatchObject({ status: 409 }); // approved
  });
  it('P7-01: allow-once needs an enforced order and creates a pending one-hour grant', async () => {
    const { a } = make();
    await expect(a.allowOnce('dnr-43933a1dca', 3600)).rejects.toMatchObject({ status: 409 }); // draft
    await a.patchOrder('dnr-43933a1dca', { status: 'approved' });
    const g = await a.allowOnce('dnr-43933a1dca', 3600);
    expect(Date.parse(g.expires_at) - Date.parse(g.granted_at)).toBe(3_600_000);
    expect((await a.getOrder('dnr-43933a1dca'))?.grants).toHaveLength(1);
  });
});

describe('P9 (node side): session simulator on the real demo case', async () => {
  const engine = new CaseEngine(await loadGrammarsNode(), bundle);
  // The real order is a draft; these checks are for the order once a maintainer approves it.
  const approved = { ...bundle.order, status: 'approved' as const };
  it('P9: as stored (draft), the order is not enforced: the original change is allowed', () => {
    const writes = bundle.presets.find((p) => p.kind === 'original-change')?.writes ?? [];
    const r = engine.sendAll(initialState(bundle), bundle.order, writes);
    expect(bundle.order.status).toBe('draft');
    expect(r.results[0]?.decision.outcome).toBe('allow');
    expect(r.results[0]?.output.exitCode).toBe(0);
  });
  it('P9: the original change blocks at 1.0 with the §6 stderr; the hard negative only warns', () => {
    const s = initialState(bundle);
    const orig = engine.sendAll(
      s,
      approved,
      bundle.presets.find((p) => p.kind === 'original-change')?.writes ?? [],
    );
    const h = headline(orig.results);
    expect(h?.decision.outcome).toBe('block');
    expect(h?.decision.edit_score).toBe(1);
    expect(h?.output.exitCode).toBe(2);
    expect(h?.output.stderr.split('\n')).toHaveLength(3);
    expect(h?.applied).toBe(false);
    const hn = engine.sendAll(
      newSession(bundle, s),
      approved,
      bundle.presets.find((p) => p.kind === 'hard-negative')?.writes ?? [],
    );
    expect(hn.results[0]?.decision.outcome).toBe('warn_block');
    // Retrying in the same session passes as warn_pass (warned once per order per session).
    const retry = engine.sendAll(
      hn.next,
      approved,
      bundle.presets.find((p) => p.kind === 'hard-negative')?.writes ?? [],
    );
    expect(retry.results[0]?.decision.outcome).toBe('warn_pass');
  });
  it('P9: a grant applies while unexpired, or for the rest of the session once used', () => {
    const writes = bundle.presets.find((p) => p.kind === 'original-change')?.writes ?? [];
    const s = {
      ...initialState(bundle),
      grants: [{ order_id: approved.id, granted_at: 0, expires_at: Date.parse('2026-11-26T13:00:00Z') }],
    };
    const used = engine.sendAll(s, approved, writes);
    expect(used.results[0]?.decision.outcome).toBe('allow_grant');
    const later = { ...used.next, now: Date.parse('2026-11-26T14:00:00Z') };
    expect(engine.grantApplies(later, approved.id)).toBe(true);
    expect(engine.grantApplies(newSession(bundle, later), approved.id)).toBe(false);
  });
});

describe('replay fixtures', () => {
  it('ROUTE-08: strReplaceFor gives a unique old_str that reproduces the target', () => {
    const a = 'x = 1\ny = 2\nx = 1\n';
    const b = 'x = 1\ny = 3\nx = 1\n';
    const sr = strReplaceFor(a, b);
    expect(sr).not.toBeNull();
    expect(a.split(sr?.old_str as string).length - 1).toBe(1);
    expect(a.replace(sr?.old_str as string, sr?.new_str as string)).toBe(b);
  });
});

describe('case packing', () => {
  it('P7-02: a packed bundle unpacks to exactly the original CaseBundle', async () => {
    const { packCase } = await import('../../../apps/playground/scripts/pack');
    const { unpackCase } = await import('./engine/pack');
    const raw = JSON.parse(readFileSync(`${cases}43933a1dca.json`, 'utf8'));
    const packed = packCase(raw);
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(raw).length / 3);
    expect(CaseBundle.parse(unpackCase(JSON.parse(JSON.stringify(packed))))).toEqual(CaseBundle.parse(raw));
  });
});

describe('router base path (GitHub Pages)', () => {
  it('ROUTE-1: a trailing slash added by a static host resolves to the same route', async () => {
    const { strip, match } = await import('./app/router');
    expect(strip('/dnr/', '/dnr/graveyard/')).toBe('/graveyard');
    expect(strip('/dnr/', '/dnr/graveyard')).toBe('/graveyard');
    expect(strip('/dnr/', '/dnr/')).toBe('/');
    expect(strip('/', '/play/43933a1dca/')).toBe('/play/43933a1dca');
    expect(match('/play/:case', strip('/dnr/', '/dnr/play/43933a1dca/'))).toEqual({ case: '43933a1dca' });
  });
});
