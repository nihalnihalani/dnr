import { applyTool, grammarForPath } from '@dnr/core';
import type { CaseBundle } from '@dnr/schemas';
import { useId, useState } from 'react';
import { useConfig } from '../app/context';
import { Banner, ErrorBanner, Loading, useAsync, useTitle } from '../components/common';
import { strReplaceFor } from '../engine/replay';
import { CaseEngine, initialState, type WriteResult } from '../engine/session';
import { DecisionDetail, Verdict } from './Play';

export function fixtureFor(bundle: CaseBundle, presetId: string): string | null {
  const p = bundle.presets.find((x) => x.id === presetId);
  const w = p?.writes[0];
  const f = bundle.files.find((x) => x.path === w?.path);
  if (!w || !f) return null;
  const sr = strReplaceFor(f.baseline_text, w.proposed_text);
  if (!sr) return null;
  return JSON.stringify(
    {
      hook_event_name: 'PreToolUse',
      session_id: 'replay-example',
      cwd: '/work/repo',
      tool_name: 'fs_write',
      tool_input: { command: 'str_replace', path: `/work/repo/${w.path}`, ...sr },
    },
    null,
    2,
  );
}

export function Replay() {
  useTitle('Replay');
  const cfg = useConfig();
  const ids = useId();
  const idx = useAsync(() => cfg.loadCaseIndex(), []);
  const [caseId, setCaseId] = useState<string>('');
  const cid = caseId || idx.data?.find((c) => !c.synthetic)?.id || idx.data?.[0]?.id || '';
  const eng = useAsync(async () => {
    if (!cid) return null;
    const bundle = await cfg.loadCase(cid);
    const { createLazyProvider } = await import('../engine/grammar');
    const provider = createLazyProvider(cfg.grammarUrls);
    await provider.ensure([
      ...new Set(bundle.files.map((f) => grammarForPath(f.path)).filter((g) => g !== null)),
    ]);
    return { bundle, engine: new CaseEngine(provider, bundle) };
  }, [cid]);
  const [text, setText] = useState('');
  const [result, setResult] = useState<WriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    setResult(null);
    if (!eng.data) return;
    const { bundle, engine } = eng.data;
    let ev: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
    try {
      ev = JSON.parse(text);
    } catch {
      return setError('Not JSON. Paste the raw stdin of a PreToolUse event.');
    }
    const tool = typeof ev.tool_name === 'string' ? ev.tool_name : '';
    const cwd = typeof ev.cwd === 'string' ? ev.cwd.replace(/\/$/, '') : '';
    const rel = (p: string) =>
      cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p.replace(/^\.\//, '');
    const s = initialState(bundle, cfg.clock.now());
    const effect = applyTool(tool, ev.tool_input, (p) => s.files[rel(p)] ?? null);
    if (effect.kind === 'none')
      return setError(`Tool "${tool}" has no target path: nothing to check (allow).`);
    if (effect.kind === 'passthrough') return setError(`Passed through: ${effect.reason}`);
    if (effect.kind === 'unknown')
      return setError('Unknown write-tagged tool: the hook can only warn (warn tier).');
    const path = rel(effect.path);
    const order = bundle.order;
    setResult(engine.send(s, order, { path, proposed_text: effect.text ?? '' }).result);
  };

  return (
    <>
      <h1 id="page-title">Replay a hook event</h1>
      <p className="lede">
        Paste the raw stdin JSON of a Kiro PreToolUse event, or pick an example built from a case preset. The
        decision runs against the case's post-revert baseline, in a fresh session.
      </p>
      {idx.error !== undefined && <ErrorBanner error={idx.error} />}
      <div className="row">
        <div style={{ minWidth: 220 }}>
          <label htmlFor={`${ids}-case`}>Case (baseline and order)</label>
          <select id={`${ids}-case`} value={cid} onChange={(e) => setCaseId(e.target.value)}>
            {idx.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}: {c.title.slice(0, 60)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 220 }}>
          <label htmlFor={`${ids}-fx`}>Example event</label>
          <select
            id={`${ids}-fx`}
            defaultValue=""
            onChange={(e) => {
              if (eng.data && e.target.value) setText(fixtureFor(eng.data.bundle, e.target.value) ?? '');
            }}
          >
            <option value="">Choose…</option>
            {eng.data?.bundle.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor={`${ids}-stdin`}>PreToolUse stdin</label>
      <textarea
        id={`${ids}-stdin`}
        className="code"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn primary"
          onClick={run}
          disabled={!eng.data}
          data-testid="replay-run"
        >
          Decide
        </button>
        {eng.loading && <Loading what="grammar" />}
      </div>
      <div aria-live="polite" role="status" style={{ marginTop: 16 }}>
        {error && (
          <Banner kind="info" title="No decision" testId="replay-note">
            {error}
          </Banner>
        )}
        {result && (
          <div data-testid="replay-result">
            <Verdict r={result} />
            <DecisionDetail results={[result]} top={result} />
          </div>
        )}
      </div>
    </>
  );
}
