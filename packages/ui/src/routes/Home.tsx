import { useEffect, useRef, useState } from 'react';
import { useConfig } from '../app/context';
import { Link } from '../app/router';
import { useAsync, useTitle } from '../components/common';

const PROMPT = '$ kiro-cli chat "Clean up Query.clear_ordering in django/db/models/sql/query.py"';
const LOOP_MS = 20_000;

function useReducedMotion(): boolean {
  const [r, setR] = useState(false);
  useEffect(() => {
    const m = matchMedia('(prefers-reduced-motion: reduce)');
    setR(m.matches);
    const on = () => setR(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return r;
}

/** A 20-second loop of the block. Until the demo run is filmed, it replays the engine's real output. */
function TerminalLoop({ stderr, path }: { stderr: string; path: string }) {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [t, setT] = useState(0);
  const tRef = useRef(0);
  tRef.current = t;
  const total = PROMPT.length + 40 + stderr.length;
  useEffect(() => {
    if (reduced || paused) return;
    const start = performance.now() - tRef.current;
    // ~16 updates a second is smooth enough for typing and keeps the main thread idle.
    const id = setInterval(() => setT((performance.now() - start) % LOOP_MS), 60);
    return () => clearInterval(id);
  }, [reduced, paused]);
  const shown = reduced ? total : Math.floor((Math.min(t, LOOP_MS * 0.7) / (LOOP_MS * 0.7)) * total);
  const p = PROMPT.slice(0, Math.min(shown, PROMPT.length));
  const tool = shown > PROMPT.length ? `\n● fs_write ${path}\n` : '';
  const err = shown > PROMPT.length + 40 ? stderr.slice(0, shown - PROMPT.length - 40) : '';
  const exit = shown >= total ? '\n✗ PreToolUse hook exited 2: write blocked' : '';
  return (
    <figure className="terminal" style={{ margin: 0 }}>
      <div className="bar">
        <span>dnr-pre-write · PreToolUse</span>
        <button
          type="button"
          className="btn"
          style={{ minHeight: 28, padding: '2px 10px' }}
          onClick={() => setPaused((x) => !x)}
        >
          {paused || reduced ? 'Play' : 'Pause'} loop
        </button>
      </div>
      <pre aria-hidden="true">
        <span className="prompt">{p}</span>
        {tool}
        <span className="err">{err}</span>
        {exit}
        {!reduced && <span className="cursor">&nbsp;</span>}
      </pre>
      <figcaption className="sr-only">
        An agent asked to clean up Query.clear_ordering tries to write {path}. DNR blocks the write and
        prints: {stderr}
      </figcaption>
      <figcaption
        style={{
          fontSize: '0.75rem',
          color: 'var(--muted)',
          padding: '6px 12px',
          borderTop: '1px solid var(--line)',
        }}
      >
        Placeholder: the engine's real stderr for this order, replayed. The filmed <code>demo/L</code> run
        replaces it.
      </figcaption>
    </figure>
  );
}

export function Home() {
  useTitle('Do Not Resurrect');
  const cfg = useConfig();
  const idx = useAsync(() => cfg.loadCaseIndex(), []);
  const demo = idx.data?.find((c) => c.demo)?.demo;
  const first = idx.data?.find((c) => !c.synthetic)?.id ?? idx.data?.[0]?.id;
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">A Kiro PreToolUse hook · Frankenstein</p>
          <h1 id="page-title">Some changes should stay dead.</h1>
          <p className="lede">
            When a project reverts a change, it remembers why. An AI agent doesn't. DNR turns every revert
            into an order: the reason, the links, and the exact tokens the change added and removed. When an
            agent's write would bring the change back, the hook blocks it before the file changes and tells
            the agent why.
          </p>
          <div className="row" style={{ marginTop: 18 }}>
            <Link className="btn primary" to={first ? `/play/${first}` : '/play'}>
              Try a revert
            </Link>
            <Link className="btn" to="/trial">
              See the trial
            </Link>
            <Link className="btn" to="/kiro">
              How Kiro built it
            </Link>
          </div>
        </div>
        {demo ? (
          <TerminalLoop stderr={demo.stderr} path={demo.path} />
        ) : (
          <div className="terminal" style={{ minHeight: 260 }} />
        )}
      </section>
      <section className="steps" aria-label="How it works">
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: '1.15rem' }}>1. Mine the reverts</h2>
          <p>
            <code>dnr scan</code> walks git's revert graph. Each revert becomes a draft order with tokens per
            function, from tree-sitter.
          </p>
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: '1.15rem' }}>2. A human approves</h2>
          <p>
            Only approved orders are enforced. The <Link to="/graveyard">graveyard</Link> shows each one, with
            its reason and links.
          </p>
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: '1.15rem' }}>3. The write is scored</h2>
          <p>
            Score = matched added + removed tokens ÷ order size. Formatting can't hide a re-application; a
            hard negative only warns.
          </p>
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: '1.15rem' }}>4. One click to allow</h2>
          <p>
            A wrong block takes <code>dnr board --open &lt;id&gt;</code> and Allow once: one order, one
            session, one hour.
          </p>
        </div>
      </section>
    </>
  );
}
