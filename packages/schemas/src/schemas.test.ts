import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DnrConfig } from './config';
import { Pins } from './fixtures';
import { Iso, RepoPath, Sha40 } from './primitives';
import { Decision, EffectiveStatus, Grant, Order } from './records';

const sha = 'a'.repeat(40);
const order = {
  schema: 'dnr.order/v1',
  id: 'dnr-0123456789',
  status: 'approved',
  source: 'revert',
  original_sha: sha,
  revert_sha: sha,
  snapshot_sha: sha,
  tickets: [{ system: 'trac', id: '123', url: 'https://code.djangoproject.com/ticket/123' }],
  links: [{ rel: 'revert', url: 'https://github.com/django/django/commit/aaaa' }],
  reason: 'Broke GROUP BY with aliases.',
  reason_source: 'human',
  units: [
    {
      file: 'django/db/models/sql/query.py',
      qualname: 'Query.set_group_by',
      kind: 'modified',
      tokenizer: { grammar: 'python', normalizer: 1 },
      A: ['seen'],
      R: ['values_select'],
      c_state_ref: { sha, file: 'django/db/models/sql/query.py', qualname: 'Query.set_group_by' },
      post_revert_hash: 'b'.repeat(64),
      post_revert_token_count: 120,
    },
  ],
  history: [{ at: '2026-11-26T00:00:00Z', by: 'builder', action: 'created' }],
  created_at: '2026-11-26T00:00:00Z',
  updated_at: '2026-11-26T00:00:00+01:00',
};

describe('primitives', () => {
  it('validate SHAs, repo paths and ISO times', () => {
    expect(Sha40.safeParse(sha).success).toBe(true);
    expect(Sha40.safeParse('A'.repeat(40)).success).toBe(false);
    expect(RepoPath.safeParse('a/b.py').success).toBe(true);
    expect(RepoPath.safeParse('/abs').success).toBe(false);
    expect(RepoPath.safeParse('a/../b').success).toBe(false);
    expect(Iso.safeParse('2026-11-26T00:00:00Z').success).toBe(true);
    expect(Iso.safeParse('2026-11-26').success).toBe(false);
  });
});

describe('Order', () => {
  it('accepts a valid order and rejects a stored stale status', () => {
    expect(Order.parse(order)).toEqual(order);
    expect(Order.safeParse({ ...order, status: 'stale' }).success).toBe(false);
    expect(Order.safeParse({ ...order, links: [] }).success).toBe(false);
    expect(Order.safeParse({ ...order, id: 'dnr-XYZ' }).success).toBe(false);
    expect(Order.safeParse({ ...order, reason: 'x'.repeat(281) }).success).toBe(false);
  });
});

describe('Decision', () => {
  it('requires scope order', () => {
    const d = {
      outcome: 'block',
      tier: 'match',
      order_id: 'dnr-0123456789',
      edit_score: 0.92,
      prox_score: null,
      fired_by: 'edit',
      scope: 'order',
      breakdown: [],
      reason_line: 'DNR: x',
      latency_ms: 3,
      fast_path: false,
    };
    expect(Decision.safeParse(d).success).toBe(true);
    expect(Decision.safeParse({ ...d, scope: 'write' }).success).toBe(false);
  });
});

describe('DnrConfig', () => {
  it('fills the §7 defaults and is strict', () => {
    expect(DnrConfig.parse({})).toEqual(DEFAULT_CONFIG);
    expect(DnrConfig.parse({ threshold: 0.7 }).threshold).toBe(0.7);
    expect(DnrConfig.safeParse({ thresold: 0.7 }).success).toBe(false);
  });
});

describe('Pins (strict fixture schema)', () => {
  const pins = {
    django_sha: sha,
    second_repo: null,
    second_sha: null,
    ts_demo: null,
    demo_cases: [{ R: sha, C: sha, file: 'a.py', qualname: 'f', c_file_count: 1 }],
    model: 'm',
    model_cutoff: { date: '2026-01', source_url: 'https://example.com/card' },
    kiro_cli_version: '3.6.0',
    npm_package: 'dnr',
    syn_fork_base: null,
    docker_images: {},
    tools: { node: '24' },
  };
  it('accepts valid pins and rejects unknown keys', () => {
    expect(Pins.safeParse(pins).success).toBe(true);
    expect(Pins.safeParse({ ...pins, extra: 1 }).success).toBe(false);
    expect(Pins.safeParse({ ...pins, demo_cases: [{ ...pins.demo_cases[0], typo: 1 }] }).success).toBe(false);
  });
});

describe('Grant.origin (optional, wave-2 C3/H4)', () => {
  const grant = {
    order_id: 'dnr-0123456789',
    session_key: null,
    kind: 'allow_once',
    granted_by: 'human',
    granted_at: '2026-11-26T00:00:00Z',
    expires_at: '2026-11-26T01:00:00Z',
    used: [],
    blobs: [],
  };
  it('accepts grants without origin (older files) and keeps origin when present', () => {
    expect(Grant.safeParse(grant).success).toBe(true);
    const origin = { via: 'cli', suspect: true, markers: ['env:KIRO_SESSION_ID', 'ancestor:kiro-cli'] };
    expect(Grant.parse({ ...grant, origin }).origin).toEqual(origin);
    expect(Grant.safeParse({ ...grant, origin: { via: 'shell', suspect: false, markers: [] } }).success).toBe(
      false,
    );
  });
});

describe('wave-3 N4/N5 additions', () => {
  it('EffectiveStatus lists the derived statuses, and Order.status still rejects them', () => {
    expect(EffectiveStatus.options).toEqual([
      'draft',
      'approved',
      'retired',
      'stale',
      'relanded',
      'violated',
    ]);
    for (const derived of ['stale', 'relanded', 'violated']) {
      expect(Order.safeParse({ ...order, status: derived }).success).toBe(false);
    }
  });
  it('Grant.origin confirmation fields are optional and validated', () => {
    const base = {
      order_id: 'dnr-0123456789',
      session_key: null,
      kind: 'allow_once',
      granted_by: 'human',
      granted_at: '2026-11-26T00:00:00Z',
      expires_at: '2026-11-26T01:00:00Z',
      used: [],
      blobs: [],
    };
    const origin = { via: 'cli', suspect: true, markers: ['no-tty'] };
    expect(Grant.safeParse({ ...base, origin }).success).toBe(true);
    const confirmed = { ...origin, confirmed_by: 'maintainer', confirmed_at: '2026-11-26T00:05:00Z' };
    expect(Grant.parse({ ...base, origin: confirmed }).origin).toEqual(confirmed);
    expect(Grant.safeParse({ ...base, origin: { ...origin, confirmed_at: 'yesterday' } }).success).toBe(
      false,
    );
  });
});
