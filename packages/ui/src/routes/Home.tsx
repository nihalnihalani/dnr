import { useConfig } from '../app/context';
import { Link } from '../app/router';
import { useAsync, useTitle } from '../components/common';

/** A real run of the built CLI, recorded by apps/playground/scripts/capture-cli.ts. */
export interface CliCapture {
  command: string;
  checkout: string;
  exit_code: number;
  stderr: string;
  stdout: string;
  captured_at: string;
  dnr_version: string;
}

async function loadCapture(url: string | null): Promise<CliCapture | null> {
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
  return (await res.json()) as CliCapture;
}

function Capture({ c }: { c: CliCapture }) {
  return (
    <figure className="terminal" style={{ margin: 0 }} data-testid="cli-capture">
      <div className="bar">
        <span>
          recorded {c.captured_at.slice(0, 10)} · dnr {c.dnr_version}
        </span>
        <span>exit {c.exit_code}</span>
      </div>
      <pre>
        <span className="prompt">$ {c.command}</span>
        {'\n'}
        {c.stdout}
        <span className="err">{c.stderr}</span>
      </pre>
      <figcaption
        style={{
          fontSize: '0.75rem',
          color: 'var(--muted)',
          padding: '6px 12px',
          borderTop: '1px solid var(--line)',
        }}
      >
        Real output of the built <code>dnr</code> CLI on {c.checkout}, captured by{' '}
        <code>apps/playground/scripts/capture-cli.ts</code>.
      </figcaption>
    </figure>
  );
}

export function Home() {
  useTitle('Do Not Resurrect');
  const cfg = useConfig();
  const idx = useAsync(() => cfg.loadCaseIndex(), []);
  const cap = useAsync(() => loadCapture(cfg.captureUrl).catch(() => null), []);
  const first = idx.data?.[0]?.id;
  return (
    <>
      <section className={cap.data ? 'hero' : 'hero solo'}>
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
        {cap.data && <Capture c={cap.data} />}
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
