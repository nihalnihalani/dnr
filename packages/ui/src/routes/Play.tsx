import type { OrderBreakdown } from '@dnr/core';
import { DEFAULT_MATCH_CONFIG, grammarForPath } from '@dnr/core';
import type { CaseBundle, Order } from '@dnr/schemas';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useConfig } from '../app/context';
import { Link } from '../app/router';
import { Banner, ErrorBanner, Loading, useAsync, useTitle } from '../components/common';
import { SimTag, StateActions } from '../components/StateActions';
import { TokenChips } from '../components/TokenChips';
import {
  CaseEngine,
  decisionKey,
  headline,
  initialState,
  matchedTokens,
  newSession,
  type SimState,
  type UnitHits,
  type WriteResult,
} from '../engine/session';
import { STATE_INFO } from '../model/states';
import type { OrderDetail } from '../model/types';

/** Resolve after the next paint and an idle slot (falls back to a short timeout). */
/**
 * True once the element is near the viewport (and stays true). CodeMirror's setup and its first
 * syntax parse are the heaviest main-thread work on /play, so the editor mounts only when it is
 * about to be seen: below the fold on a phone, that is after the page is interactive.
 */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), {
      rootMargin: '200px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

function afterPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const ric = (
          globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }
        ).requestIdleCallback;
        if (ric) ric(() => resolve(), { timeout: 800 });
        else setTimeout(resolve, 50);
      }),
    ),
  );
}

const CodeEditor = lazy(() => import('../components/CodeEditor'));

const ICON: Record<string, string> = { BLOCK: '⛔', DENY: '⛔', WARN: '⚠', ALLOW: '✓', ASK: '?', ERROR: '!' };

export function PlayIndex() {
  useTitle('Play');
  const cfg = useConfig();
  const q = useAsync(() => cfg.loadCaseIndex(), []);
  const pending = useAsync(() => cfg.loadPending(), []);
  return (
    <>
      <h1 id="page-title">Try a revert</h1>
      <p className="lede">
        Pick a case. Each one is an order built from a real revert, with presets that try to bring it back.
      </p>
      {q.error !== undefined && <ErrorBanner error={q.error} />}
      {q.loading && <Loading what="cases" />}
      <ul className="steps" style={{ listStyle: 'none', padding: 0 }}>
        {q.data?.map((c) => (
          <li key={c.id} className="card">
            <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>
              <Link to={`/play/${c.id}`}>{c.title}</Link>
            </h2>
            <p>
              <span className="tag">real revert</span> {c.source.repo} ({c.source.license}) ·{' '}
              {c.grammars.join(', ')}
            </p>
          </li>
        ))}
        {pending.data?.map((p) => (
          <li key={p.what} className="card" data-testid="pending-case">
            <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>{p.what}: pending</h2>
            <p>Not available yet: {p.why}.</p>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Play({ caseId }: { caseId: string }) {
  useTitle(`Play ${caseId}`);
  const cfg = useConfig();
  const index = useAsync(() => cfg.loadCaseIndex(), []);
  const entry = index.data?.find((c) => c.id === caseId);
  // The case renders as soon as its JSON arrives; the WASM grammar and the engine load behind it.
  const bundleQ = useAsync(() => cfg.loadCase(caseId), [caseId]);
  // Zod validation of the bundle is off the critical path: it runs once the engine is ready.
  const checkQ = useAsync(async () => {
    await afterPaint();
    return cfg.checkCase(caseId);
  }, [caseId]);
  const engineQ = useAsync(async () => {
    const bundle = await cfg.loadCase(caseId);
    const { createLazyProvider } = await import('../engine/grammar');
    const provider = createLazyProvider(cfg.grammarUrls);
    const grammars = [...new Set(bundle.files.map((f) => grammarForPath(f.path)).filter((g) => g !== null))];
    await provider.ensure(grammars);
    // Let the case paint first: the first parse of a large file is the heaviest task on the page.
    await afterPaint();
    return { engine: new CaseEngine(provider, bundle), grammars };
  }, [caseId]);
  if (index.data && !entry)
    return (
      <>
        <h1 id="page-title">No case “{caseId}”</h1>
        <Banner kind="warn" title="Unknown case">
          See <Link to="/play">the list of cases</Link>.
        </Banner>
      </>
    );
  return (
    <>
      <p>
        <Link to="/play">← Cases</Link>
      </p>
      <h1 id="page-title" style={{ fontSize: 'clamp(1.75rem, 3.4vw, 2.3rem)' }}>
        {entry?.title ?? caseId}
      </h1>
      {bundleQ.loading && <Loading what="the case" />}
      {bundleQ.error !== undefined && <ErrorBanner error={bundleQ.error} />}
      {engineQ.error !== undefined && <ErrorBanner error={engineQ.error} />}
      {checkQ.data && (
        <Banner kind="error" title="Invalid case bundle (dnr.case/v1)" testId="banner-invalid-case">
          {checkQ.data}
        </Banner>
      )}
      {bundleQ.data && (
        <PlayBody
          omitted={entry?.omitted ?? []}
          bundle={bundleQ.data}
          engine={engineQ.data?.engine ?? null}
          grammars={engineQ.data?.grammars ?? []}
        />
      )}
    </>
  );
}

const KIND_LABEL: Record<string, string> = {
  'original-change': 'Original change C',
  'recorded-agent': 'Recorded agent write (demo/L)',
  'held-out-paraphrase': 'Held-out paraphrase',
  'hard-negative': 'Hard negative',
  'half-of-two-file': 'One half of a two-file change',
  'formatting-only': 'Formatting only',
};

function PlayBody({
  omitted,
  bundle,
  engine,
  grammars,
}: {
  bundle: CaseBundle;
  engine: CaseEngine | null;
  grammars: string[];
  omitted: Array<{ kind: string; reason: string }>;
}) {
  const cfg = useConfig();
  const sim = cfg.sim;
  const [editorRef, editorNear] = useNearViewport<HTMLDivElement>();
  const orderId = bundle.order.id;
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [state, setState] = useState<SimState>(() => ({ ...initialState(bundle, cfg.clock.now()) }));
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({ ...state.files }));
  const [file, setFile] = useState(bundle.files[0]?.path ?? '');
  const [results, setResults] = useState<WriteResult[]>([]);
  const [hits, setHits] = useState<UnitHits[]>([]);
  const [preset, setPreset] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    const d = await sim.getOrder(orderId);
    setDetail(d);
    const grants = (d?.grants ?? []).map((g) => ({
      order_id: g.order_id,
      granted_at: Date.parse(g.granted_at),
      expires_at: Date.parse(g.expires_at),
    }));
    setState((s) => ({ ...s, grants, now: cfg.clock.now() }));
  }, [sim, orderId, cfg.clock]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const order: Order = detail?.order ?? bundle.order;
  const effective = detail?.effective ?? bundle.order.status;

  const send = (writes: Array<{ path: string; proposed_text: string }>, label: string) => {
    if (!engine) return;
    const s0 = { ...state, now: cfg.clock.now() };
    const { results: rs, next } = engine.sendAll(s0, order, writes);
    for (const r of rs)
      if (r.decision.outcome === 'allow_grant' && r.decision.order_id) sim.recordUse(r.decision.order_id);
    const proposedAll: Record<string, string> = { ...s0.files };
    for (const w of writes) proposedAll[w.path] = w.proposed_text;
    setHits(
      matchedTokens(
        engine,
        order,
        proposedAll,
        rs.flatMap((r) => r.scores),
      ),
    );
    setState(next);
    setResults(rs);
    const h = headline(rs);
    setMsg(
      h
        ? `${label}: ${h.output.verdict}, exit ${h.output.exitCode}${h.decision.edit_score !== null ? `, edit ${h.decision.edit_score.toFixed(2)}` : ''}`
        : `${label}: no writes`,
    );
    void refresh();
  };

  const runPreset = (id: string) => {
    const p = bundle.presets.find((x) => x.id === id);
    if (!p) return;
    setPreset(id);
    setDrafts((d) => ({ ...d, ...Object.fromEntries(p.writes.map((w) => [w.path, w.proposed_text])) }));
    if (p.writes[0]) setFile(p.writes[0].path);
    send(p.writes, p.label);
  };

  const reset = () => {
    const s = newSession(bundle, { ...state, now: cfg.clock.now() });
    setState(s);
    setDrafts({ ...s.files });
    setResults([]);
    setHits([]);
    setPreset(null);
    setMsg('New session: editor back on the post-revert baseline; warned set and used grants cleared.');
  };

  const advance = () => {
    cfg.clock.advance(3600_000);
    setState((s) => ({ ...s, now: cfg.clock.now() }));
    setMsg(`Clock advanced 1 h (simulated): now ${new Date(cfg.clock.now()).toISOString()}`);
  };

  const top = headline(results);
  const lang = grammarForPath(file) === 'python' ? 'python' : 'ts';
  const changedFiles = Object.keys(drafts).filter((p) => drafts[p] !== state.files[p]);

  return (
    <div className="play">
      <div>
        <section className="card order-card" aria-labelledby="order-h">
          <h2 id="order-h" style={{ marginTop: 0, fontSize: '1rem', color: 'var(--muted)' }}>
            Order <Link to={`/orders/${order.id}`}>{order.id}</Link> · {STATE_INFO[effective].label}
          </h2>
          <p className="reason">“{order.reason}”</p>
          <div className="links">
            {order.links.map((l) => (
              <a key={l.url} href={l.url}>
                {l.rel}
              </a>
            ))}
            <span>
              Source: {bundle.source.repo} ({bundle.source.license})
            </span>
          </div>
          {order.units.map((u) => {
            const h = hits.find((x) => x.file === u.file && x.qualname === u.qualname);
            return (
              <div className="unit" key={`${u.file}|${u.qualname}`}>
                <p style={{ margin: 0 }}>
                  <code>{u.qualname}</code> <span style={{ color: 'var(--muted)' }}>in {u.file}</span> ·{' '}
                  {u.kind}
                </p>
                <TokenChips A={u.A} R={u.R} {...(h ? { hitA: h.hitA, hitR: h.hitR } : {})} />
              </div>
            );
          })}
        </section>

        {effective === 'draft' && (
          <Banner kind="warn" title="Draft: not enforced" testId="banner-draft">
            This is the order as built from Django's history. No maintainer has approved it, so DNR allows
            every write. Use <strong>Approve (simulated)</strong> under Maintainer actions to enforce it in
            this browser only.
          </Banner>
        )}
        <section aria-labelledby="presets-h">
          <h2 id="presets-h">Presets</h2>
          {!engine && (
            <p role="status" className="lede" style={{ fontSize: '0.95rem' }}>
              Loading the syntax grammar (WebAssembly)…
            </p>
          )}
          <fieldset
            className="presets"
            style={{ border: 0, padding: 0, margin: 0 }}
            disabled={!engine}
            data-engine={engine ? 'ready' : 'loading'}
          >
            <legend className="sr-only">Presets</legend>
            {bundle.presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className="btn preset"
                aria-pressed={preset === p.id}
                onClick={() => runPreset(p.id)}
                data-preset={p.id}
                data-preset-kind={p.kind}
              >
                {p.label}
              </button>
            ))}
            <button type="button" className="btn" onClick={reset} data-preset="reset">
              Reset (new session)
            </button>
          </fieldset>
          <ul
            className="unavailable"
            aria-label="Presets not available for this case"
            data-testid="unavailable-presets"
          >
            {bundle.presets.every((p) => p.kind !== 'recorded-agent') && (
              <li data-kind="recorded-agent">
                <strong>{KIND_LABEL['recorded-agent']}</strong>: unavailable until the <code>demo/L</code> run
                is captured.
              </li>
            )}
            {omitted
              .filter((o) => !bundle.presets.some((p) => p.kind === o.kind))
              .map((o) => (
                <li key={o.kind} data-kind={o.kind}>
                  <strong>{KIND_LABEL[o.kind] ?? o.kind}</strong>: unavailable, {o.reason}.
                </li>
              ))}
          </ul>
        </section>

        <section aria-labelledby="editor-h">
          <h2 id="editor-h">Editor</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--muted)', marginTop: 0 }}>
            Opens on the post-revert baseline. Edit freely, then send the write as an agent would.
          </p>
          <div className="editor-wrap">
            <div className="tabs" role="tablist" aria-label="Files">
              {bundle.files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  role="tab"
                  aria-selected={file === f.path}
                  aria-controls="editor-panel"
                  onClick={() => setFile(f.path)}
                >
                  {f.path}
                  {changedFiles.includes(f.path) && <span className="changed">● unsent</span>}
                </button>
              ))}
            </div>
            <div id="editor-panel" role="tabpanel" aria-label={`Editing ${file}`} ref={editorRef}>
              <Suspense fallback={<p className="editor-placeholder">Loading editor…</p>}>
                {!engine || !editorNear ? (
                  <p className="editor-placeholder">Loading editor…</p>
                ) : (
                  <CodeEditor
                    key={file}
                    value={drafts[file] ?? ''}
                    lang={lang}
                    label={`Source of ${file}`}
                    onChange={(v) => setDrafts((d) => ({ ...d, [file]: v }))}
                  />
                )}
              </Suspense>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn primary"
              data-testid="send-write"
              disabled={!engine}
              onClick={() => {
                setPreset(null);
                send([{ path: file, proposed_text: drafts[file] ?? '' }], `Write to ${file}`);
              }}
            >
              Send write ({file.split('/').pop()})
            </button>
            <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
              Grammars loaded: {grammars.join(', ')}
            </span>
          </div>
        </section>
      </div>

      <aside className="decision" aria-labelledby="decision-h">
        <h2 id="decision-h" style={{ marginTop: 0 }}>
          Decision
        </h2>
        <p className="sr-only" role="status" aria-live="assertive" data-testid="live">
          {msg}
        </p>
        <div data-testid="results" data-results={JSON.stringify(results.map(decisionKey))}>
          {top ? <Verdict r={top} /> : <IdleVerdict />}
        </div>
        {results.length > 1 && (
          <>
            <h3>Writes in this send</h3>
            <ol className="writes">
              {results.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: one row per write
                <li key={i}>
                  <span className={`outcome-tag ${r.output.verdict}`}>
                    <strong>{r.output.verdict}</strong>
                  </span>
                  <code>{r.decision.outcome}</code> on <code>{r.path}</code>
                  {r.decision.edit_score !== null && <span>edit {r.decision.edit_score.toFixed(2)}</span>}
                  <span>{r.applied ? 'applied' : 'not applied'}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        {top && <DecisionDetail results={results} top={top} />}
        <section className="sim-actions" aria-labelledby="simact-h">
          <h3 id="simact-h">
            Maintainer actions <SimTag on />
          </h3>
          <p style={{ fontSize: '0.85rem', margin: '0 0 8px' }}>
            Status: <strong>{STATE_INFO[effective].label}</strong> · simulated clock{' '}
            <span className="clock">{new Date(state.now).toISOString().replace('.000', '')}</span> · warned:{' '}
            {state.warned.length ? state.warned.join(', ') : 'none'} · grants used:{' '}
            {state.grants_used.length ? state.grants_used.join(', ') : 'none'}
          </p>
          {detail && (
            <StateActions
              row={detail}
              adapter={sim}
              onChange={(m) => {
                setMsg(m);
                void refresh();
              }}
            />
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn" onClick={advance} data-testid="advance">
              Advance 1 h <SimTag on />
            </button>
            <button type="button" className="btn" onClick={reset}>
              New session <SimTag on />
            </button>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input
                type="checkbox"
                checked={state.decision_format === 'ask'}
                onChange={(e) =>
                  setState((s) => ({ ...s, decision_format: e.target.checked ? 'ask' : 'deny' }))
                }
              />
              Decision format <code>ask</code>
            </label>
          </div>
          {state.grants.length > 0 && (
            <p style={{ fontSize: '0.85rem' }}>
              Grants:{' '}
              {state.grants
                .map(
                  (g) =>
                    `${g.expires_at > state.now ? 'active' : 'expired'} until ${new Date(g.expires_at).toISOString()}`,
                )
                .join('; ')}
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}

function IdleVerdict() {
  return (
    <div className="verdict idle">
      <span className="word">—</span>
      <span className="meta">No write sent yet. Pick a preset or edit and send a write.</span>
    </div>
  );
}

export function Verdict({ r }: { r: WriteResult }) {
  return (
    <div className={`verdict ${r.output.verdict}`} data-testid="verdict" data-verdict={r.output.verdict}>
      <span className="icon" aria-hidden="true">
        {ICON[r.output.verdict]}
      </span>
      <div>
        <div className="word">{r.output.verdict}</div>
        <div className="meta">
          exit code <strong data-testid="exit-code">{r.output.exitCode}</strong> ·{' '}
          <code>{r.decision.outcome}</code> · tier {r.decision.tier}
          {r.decision.fast_path ? ' · fast path (file not covered)' : ''}
        </div>
      </div>
    </div>
  );
}

function Meter({ label, value, threshold }: { label: string; value: number; threshold: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const over = value >= threshold;
  return (
    <div className="meter">
      <div className="label">
        <span>{label}</span>
        <span>
          <strong>{value.toFixed(2)}</strong> {over ? '≥' : '<'} threshold {threshold.toFixed(2)} (
          {over ? 'over' : 'under'})
        </span>
      </div>
      <meter
        className="sr-only"
        min={0}
        max={1}
        value={value}
        aria-label={`${label} ${value.toFixed(2)}, threshold ${threshold.toFixed(2)}`}
      />
      <div className="track" aria-hidden="true">
        <div className={`fill${over ? ' over' : ''}`} style={{ width: `${pct}%` }} />
        <div className="threshold" style={{ left: `${threshold * 100}%` }} />
      </div>
    </div>
  );
}

export function DecisionDetail({ results, top }: { results: WriteResult[]; top: WriteResult }) {
  const bd = (top.decision.breakdown as OrderBreakdown[]).filter(
    (b) => b && typeof b === 'object' && 'order_id' in b,
  );
  const degraded = results.some((r) => (r.decision.breakdown as OrderBreakdown[]).some((b) => b?.degraded));
  const errorOpen = results.find((r) => r.decision.outcome === 'error_open');
  return (
    <>
      {degraded && (
        <Banner kind="warn" title="parse-degraded unit" testId="banner-degraded">
          More than 20% of a unit sits under tree-sitter ERROR nodes, so this order can only reach the warn
          tier.
        </Banner>
      )}
      {errorOpen && (
        <Banner kind="error" title="error_open: failed open" testId="banner-error-open">
          The engine threw, so the write was allowed (§5.12 fail open).{' '}
          {JSON.stringify(errorOpen.decision.breakdown[0])}
        </Banner>
      )}
      {top.decision.edit_score !== null && (
        <Meter
          label="Edit score"
          value={top.decision.edit_score}
          threshold={DEFAULT_MATCH_CONFIG.threshold}
        />
      )}
      {top.decision.prox_score !== null && (
        <Meter
          label="Proximity"
          value={top.decision.prox_score}
          threshold={DEFAULT_MATCH_CONFIG.prox_threshold}
        />
      )}
      {bd[0] && (
        <dl className="kv">
          <dt>Matched added</dt>
          <dd>
            w(A∩A′) {bd[0].iA} of w(A) {bd[0].wA}
          </dd>
          <dt>Matched removed</dt>
          <dd>
            w(R∩R′) {bd[0].iR} of w(R) {bd[0].wR}
          </dd>
          <dt>Score</dt>
          <dd>
            ({bd[0].iA} + {bd[0].iR}) ÷ ({bd[0].wA} + {bd[0].wR}) = {bd[0].edit.toFixed(3)}
          </dd>
          <dt>Flags</dt>
          <dd>
            two-sided {String(bd[0].two_sided)} · small {String(bd[0].small)} · degraded{' '}
            {String(bd[0].degraded)} · missing {String(bd[0].missing)} · changes covered unit{' '}
            {String(bd[0].changes_covered_unit)}
          </dd>
        </dl>
      )}
      <h3>stderr {top.output.provisionalText && <span className="tag">UI stand-in text</span>}</h3>
      <pre className="out stderr" data-testid="stderr">
        {top.output.stderr || '(empty)'}
      </pre>
      {top.output.stdout && (
        <>
          <h3>stdout</h3>
          <pre className="out" data-testid="stdout">
            {top.output.stdout}
          </pre>
        </>
      )}
      <details>
        <summary>Decision JSON</summary>
        <pre className="out" data-testid="decision-json">
          {JSON.stringify({ ...top.decision, latency_ms: undefined }, null, 2)}
        </pre>
      </details>
    </>
  );
}
