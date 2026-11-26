import { TrialResult } from '@dnr/schemas';
import { Fragment, useState } from 'react';
import { useConfig } from '../app/context';
import { Banner, ErrorBanner, Loading, useAsync, useTitle } from '../components/common';

interface TrialRun {
  run_id: string;
  namespace: string;
  arm: string;
  revert_sha: string;
  status: string;
  landed: boolean | null;
  label: string | null;
  tests: string;
  restored_tests: string;
  decision: string | null;
  l_outcome: string | null;
  diff?: string;
}
export interface TrialData {
  sample?: boolean;
  note?: string;
  result: TrialResult;
  runs: TrialRun[];
  timeline?: Array<{ at: string; what: string }>;
  false_alarms?: Array<{ revert: string; file: string; outcome: string; note?: string }>;
  pins?: Record<string, string>;
}

export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Number((c - h).toFixed(4)), Number((c + h).toFixed(4))];
}

/** Recompute the headline figures from the run list (§9: K_eff = reverts where T, S and L all ran OK). */
export function recompute(d: TrialData) {
  const trial = d.runs.filter((r) => r.namespace === 'trial');
  const reverts = [...new Set(trial.map((r) => r.revert_sha))];
  const ok = (arm: string, rev: string) =>
    trial.some((r) => r.arm === arm && r.revert_sha === rev && r.status === 'ok');
  const keff = reverts.filter((rev) => ok('T', rev) && ok('S', rev) && ok('L', rev));
  const landed = (arm: string) =>
    keff.filter((rev) =>
      trial.some((r) => r.arm === arm && r.revert_sha === rev && r.status === 'ok' && r.landed),
    ).length;
  return { K_eff: keff.length, X_eff: landed('T'), S_eff: landed('S'), W_L: landed('L') };
}

async function getJson<T>(url: string | null): Promise<T | null> {
  if (!url) return null;
  // SPA hosts answer a missing file with index.html, so check the type.
  const res = await fetch(url);
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
  return (await res.json()) as T;
}

async function loadTrial(url: string | null): Promise<TrialData | null> {
  const d = await getJson<TrialData>(url);
  if (!d) return null;
  const p = TrialResult.safeParse(d.result);
  if (!p.success) throw new Error(`trial data is invalid: ${p.error.issues[0]?.message}`);
  return d;
}

export function Trial() {
  useTitle('Trial');
  const cfg = useConfig();
  const [preview, setPreview] = useState(false);
  const real = useAsync(() => loadTrial(cfg.trialUrl), []);
  const prereg = useAsync(() => getJson<{ tag: string; sha: string }>(cfg.preregUrl), []);
  const sample = useAsync(() => (preview ? loadTrial(cfg.trialSampleUrl) : Promise.resolve(null)), [preview]);
  return (
    <>
      <h1 id="page-title">Trial Explorer</h1>
      {real.loading && <Loading what="trial data" />}
      {real.error !== undefined && <ErrorBanner error={real.error} />}
      {real.data && <TrialBody d={{ ...real.data, sample: false }} />}
      {!real.loading && !real.data && real.error === undefined && (
        <>
          <div className="card" data-testid="empty-trial">
            <h2 id="empty-trial-h" style={{ marginTop: 0 }}>
              The pre-registered trial has not run yet
            </h2>
            <p>
              When it has, this page shows, from <code>reports/trial.json</code>:
            </p>
            <ul>
              <li>
                three headline lines over the same reverts: without DNR, with a steering file from history,
                and with DNR live;
              </li>
              <li>per-arm run tables with the blind labels, test results, decisions and each run's diff;</li>
              <li>the timeline, false alarms, pins, κ and the decision row;</li>
              <li>a Recompute in browser button that checks every figure against the run list.</li>
            </ul>
            <p data-testid="prereg">
              Pre-registration:{' '}
              {prereg.data ? (
                <>
                  tag <code>{prereg.data.tag}</code> at <code>{prereg.data.sha}</code>
                </>
              ) : (
                <>
                  tag <code>prereg-v1</code> not created yet
                </>
              )}
              .
            </p>
            {cfg.trialSampleUrl && (
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={preview}
                  onChange={(e) => setPreview(e.target.checked)}
                  data-testid="fake-toggle"
                />
                Preview the layout with fake numbers
              </label>
            )}
          </div>
          {preview && sample.loading && <Loading what="the layout preview" />}
          {preview && sample.data && <TrialBody d={{ ...sample.data, sample: true }} />}
        </>
      )}
    </>
  );
}

/** A figure; in the layout preview every one is stamped FAKE. */
function N({ fake, children }: { fake: boolean; children: React.ReactNode }) {
  if (!fake) return <>{children}</>;
  return (
    <span className="fake-num">
      {children}
      <span className="fake-tag">FAKE</span>
    </span>
  );
}

function TrialBody({ d }: { d: TrialData }) {
  const r = d.result;
  const [check, setCheck] = useState<ReturnType<typeof recompute> | null>(null);
  const [run, setRun] = useState<string>('');
  const fake = !!d.sample;
  const S = fake ? ' (FAKE preview)' : '';
  const arms = [...new Set(d.runs.map((x) => x.arm))];
  const selected = d.runs.find((x) => x.run_id === run);
  return (
    <div className={fake ? 'fake-zone' : undefined} data-testid={fake ? 'fake-preview' : 'trial-real'}>
      {fake && (
        <Banner kind="sample" title="FAKE numbers: layout preview only" testId="banner-sample">
          {d.note ?? 'These numbers are invented to show the layout. No trial has run.'}
        </Banner>
      )}
      <section aria-labelledby="headline-h">
        <h2 id="headline-h">Headline{S}</h2>
        <p>
          Re-applications that landed, over K_eff = <N fake={fake}>{r.K_eff}</N> reverts. Lower is better.
        </p>
        <div className="stat-lines">
          <p className="stat-line">
            <span className="num">
              <N fake={fake}>{r.X_eff}</N> of <N fake={fake}>{r.K_eff}</N>
            </span>
            No DNR landed{S}
          </p>
          <p className="stat-line">
            <span className="num">
              <N fake={fake}>{r.S_eff}</N> of <N fake={fake}>{r.K_eff}</N>
            </span>
            Steering file from history landed{S}
          </p>
          <p className="stat-line">
            <span className="num">
              <N fake={fake}>{r.W_L}</N> of <N fake={fake}>{r.K_eff}</N>
            </span>
            DNR live landed{S}
          </p>
        </div>
        <dl className="kv">
          <dt>Decision row</dt>
          <dd>
            <N fake={fake}>{r.row}</N>
            {r.via_d6 ? ' (via D6)' : ''} · mode <N fake={fake}>{r.mode ?? 'n/a'}</N>
          </dd>
          <dt>X / K</dt>
          <dd>
            <N fake={fake}>{r.X}</N> / <N fake={fake}>{r.K}</N>
          </dd>
          <dt>Caught by existing tests</dt>
          <dd>
            Y <N fake={fake}>{r.Y}</N> of X <N fake={fake}>{r.X}</N>
          </dd>
          <dt>κ</dt>
          <dd>
            builder vs outside <N fake={fake}>{r.kappa.builder_vs_outside ?? 'n/a'}</N> · binary{' '}
            <N fake={fake}>{r.kappa.binary ?? 'n/a'}</N>
          </dd>
          <dt>Held-out recall</dt>
          <dd>
            <N fake={fake}>{r.held_out_recall ?? 'n/a'}</N>
          </dd>
          <dt>Pre-registration</dt>
          <dd>
            <code>prereg-v1</code> <N fake={fake}>{r.prereg_sha}</N>
          </dd>
        </dl>
        <button
          type="button"
          className="btn primary"
          onClick={() => setCheck(recompute(d))}
          data-testid="recompute"
        >
          Recompute in browser
        </button>
        {check && (
          <div className="table-wrap">
            <table data-testid="recompute-table">
              <caption>Recomputed from the run list vs trial.json</caption>
              <thead>
                <tr>
                  <th scope="col">Figure</th>
                  <th scope="col">trial.json</th>
                  <th scope="col">Recomputed</th>
                  <th scope="col">Wilson 95%</th>
                  <th scope="col">Match</th>
                </tr>
              </thead>
              <tbody>
                {(['K_eff', 'X_eff', 'S_eff', 'W_L'] as const).map((k) => {
                  const same = check[k] === r[k];
                  return (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>
                        <N fake={fake}>{r[k]}</N>
                      </td>
                      <td>
                        <N fake={fake}>{check[k]}</N>
                      </td>
                      <td>{k === 'K_eff' ? '' : wilson(check[k], check.K_eff).join(' – ')}</td>
                      <td className={same ? 'ok' : 'bad'}>{same ? '✓ matches' : '✗ differs'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section aria-labelledby="arms-h">
        <h2 id="arms-h">Runs per arm{S}</h2>
        {arms.map((arm) => (
          <div className="table-wrap" key={arm}>
            <table>
              <caption style={{ textAlign: 'left', fontWeight: 600 }}>Arm {arm}</caption>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Status</th>
                  <th scope="col">Blind label</th>
                  <th scope="col">Tests</th>
                  <th scope="col">Restored tests</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Landed</th>
                </tr>
              </thead>
              <tbody>
                {d.runs
                  .filter((x) => x.arm === arm)
                  .map((x) => (
                    <tr key={x.run_id}>
                      <td>
                        <button
                          type="button"
                          className="btn"
                          style={{ minHeight: 28, padding: '2px 8px' }}
                          onClick={() => setRun(x.run_id)}
                        >
                          <code>{x.run_id}</code>
                        </button>
                      </td>
                      <td>{x.status}</td>
                      <td>{x.label ?? 'n/a'}</td>
                      <td>{x.tests}</td>
                      <td>{x.restored_tests}</td>
                      <td>{x.decision ?? 'n/a'}</td>
                      <td>{x.landed === null ? 'n/a' : x.landed ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
        {selected && (
          <section className="card" aria-label={`Diff of ${selected.run_id}`}>
            <h3 style={{ marginTop: 0 }}>
              Diff: <code>{selected.run_id}</code>
            </h3>
            <pre className="out">{selected.diff ?? '(no diff recorded)'}</pre>
          </section>
        )}
      </section>
      <section aria-labelledby="tl-h">
        <h2 id="tl-h">Timeline{S}</h2>
        <ol>
          {(d.timeline ?? []).map((t) => (
            <li key={t.at}>
              <code>{t.at}</code> {t.what}
            </li>
          ))}
        </ol>
        <h2>False alarms{S}</h2>
        {(d.false_alarms ?? []).length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {d.false_alarms?.map((f) => (
              <li key={`${f.revert}|${f.file}`}>
                <code>{f.revert}</code> {f.file}: {f.outcome}
              </li>
            ))}
          </ul>
        )}
        <h2>Pins{S}</h2>
        <dl className="kv">
          {Object.entries(d.pins ?? {}).map(([k, v]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </Fragment>
          ))}
        </dl>
      </section>
    </div>
  );
}
