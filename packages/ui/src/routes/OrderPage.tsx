import type { EventRecord, Grant, Order } from '@dnr/schemas';
import { useEffect, useState } from 'react';
import { useConfig } from '../app/context';
import { Link, useRouter } from '../app/router';
import { Banner, ErrorBanner, Loading, useAsync, useTitle } from '../components/common';
import { Headstone } from '../components/Headstone';
import { StateActions } from '../components/StateActions';
import { TokenChips } from '../components/TokenChips';
import { STATE_INFO } from '../model/states';
import type { OrderDetail } from '../model/types';

type Probe = { state: 'idle' } | { state: 'probing' } | { state: 'down'; why: string };

/** Only a loopback board origin on the probed port may be navigated to. */
export function validBoardOrigin(origin: unknown, port: string): string | null {
  if (typeof origin !== 'string') return null;
  const m = origin.match(/^http:\/\/(127\.0\.0\.1|dnr-[a-z0-9]+\.localhost):(\d{1,5})$/);
  return m && m[2] === port ? origin : null;
}

export async function probeBoard(port: string, timeoutMs = 2500): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: ctl.signal,
      credentials: 'omit',
    });
    if (!res.ok) throw new Error(`health answered ${res.status}`);
    const body = (await res.json()) as { origin?: unknown };
    const o = validBoardOrigin(body.origin, port);
    if (!o) throw new Error('health returned an unexpected origin');
    return o;
  } finally {
    clearTimeout(t);
  }
}

export function OrderPage({ id }: { id: string }) {
  useTitle(id);
  const cfg = useConfig();
  const r = useRouter();
  const board = cfg.mode === 'playground' ? r.search.get('board') : null;
  const [probe, setProbe] = useState<Probe>(board ? { state: 'probing' } : { state: 'idle' });
  const [msg, setMsg] = useState('');
  const q = useAsync(() => cfg.adapter.getOrder(id), [id]);
  const ev = useAsync(() => cfg.adapter.events(id).catch(() => [] as EventRecord[]), [id]);

  useEffect(() => {
    if (!board) return;
    if (!/^\d{2,5}$/.test(board)) {
      setProbe({ state: 'down', why: 'invalid port' });
      return;
    }
    let live = true;
    probeBoard(board).then(
      (origin) => {
        if (live) location.assign(`${origin}/orders/${encodeURIComponent(id)}`);
      },
      (e) => live && setProbe({ state: 'down', why: (e as Error).message || 'unreachable' }),
    );
    return () => {
      live = false;
    };
  }, [board, id]);

  const readOnly = probe.state !== 'idle';
  if (probe.state === 'probing')
    return (
      <p role="status" className="lede">
        Looking for your local board on port {board}…
      </p>
    );
  return (
    <>
      <p>
        <Link to="/graveyard">← Graveyard</Link>
      </p>
      {probe.state === 'down' && (
        <Banner kind="warn" title="Local board not reachable" testId="banner-board-down">
          Run <code>dnr board --open {id}</code> to act on this order.{' '}
          {q.data ? 'Showing the bundled demo copy, read-only.' : ''}
        </Banner>
      )}
      {q.loading && !q.data && <Loading what={`order ${id}`} />}
      {q.error !== undefined && <ErrorBanner error={q.error} />}
      {!q.loading && !q.data && q.error === undefined && (
        <>
          <h1 id="page-title">Order {id}</h1>
          {probe.state !== 'down' && (
            <Banner kind="info" title="Not in this graveyard" testId="banner-unknown-order">
              Run <code>dnr board --open {id}</code> to act on this order.
            </Banner>
          )}
        </>
      )}
      {q.data && (
        <OrderBody
          detail={q.data}
          events={ev.data ?? []}
          readOnly={readOnly}
          msg={msg}
          onChange={(m) => {
            setMsg(m);
            q.reload();
            ev.reload();
          }}
        />
      )}
    </>
  );
}

function OrderBody({
  detail,
  events,
  readOnly,
  msg,
  onChange,
}: {
  detail: OrderDetail;
  events: EventRecord[];
  readOnly: boolean;
  msg: string;
  onChange: (m: string) => void;
}) {
  const cfg = useConfig();
  const o = detail.order;
  const crew = detail.grants.filter((g) => g.granted_by.startsWith('crew'));
  return (
    <div className="order-layout">
      <div>
        <Headstone row={detail} headingLevel={2} linkName={false} />
      </div>
      <div>
        <h1 id="page-title" style={{ fontSize: '2rem' }}>
          Order <code>{o.id}</code>
        </h1>
        <p className="lede">
          <strong>{STATE_INFO[detail.effective].label}</strong>
          {detail.drift ? ' · Differs from git' : ''} · reason source: {o.reason_source}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {msg}
        </p>
        {msg && <p aria-hidden="true">{msg}</p>}
        {!readOnly && <StateActions row={detail} adapter={cfg.adapter} onChange={onChange} />}
        {readOnly && <p className="lede">Read-only: actions need the local board.</p>}
        <p style={{ marginTop: 16 }}>
          <Link to={`/play/${cfg.mode === 'playground' ? caseFor(o) : ''}`} className="btn">
            Try a re-application in /play
          </Link>
        </p>
        <h2>Links</h2>
        <ul>
          {o.links.map((l) => (
            <li key={l.url}>
              {l.rel}: <a href={l.url}>{l.url}</a>
            </li>
          ))}
        </ul>
        <h2>Units ({o.units.length})</h2>
        {o.units.map((u) => (
          <div className="unit" key={`${u.file}|${u.qualname}`}>
            <p style={{ margin: 0 }}>
              <code>{u.qualname}</code> in <code>{u.file}</code> · {u.kind} · {u.tokenizer.grammar}
            </p>
            <TokenChips A={u.A} R={u.R} />
          </div>
        ))}
        <AuditPanel order={o} grants={detail.grants} crew={crew} events={events} />
      </div>
    </div>
  );
}

function caseFor(o: Order): string {
  return o.id.replace(/^dnr-/, '');
}

function AuditPanel({
  order,
  grants,
  crew,
  events,
}: {
  order: Order;
  grants: Grant[];
  crew: Grant[];
  events: EventRecord[];
}) {
  return (
    <section aria-labelledby="audit-h">
      <h2 id="audit-h">History and audit</h2>
      <h3>History</h3>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Order history</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {order.history.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: history is append-only
              <tr key={i}>
                <td>{h.at}</td>
                <td>{h.by}</td>
                <td>{h.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Grants (allow-once and ask)</h3>
      {grants.length === 0 ? (
        <p>No grants.</p>
      ) : (
        <div className="table-wrap">
          <table data-testid="grants">
            <caption className="sr-only">Grants</caption>
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">By</th>
                <th scope="col">Granted</th>
                <th scope="col">Expires</th>
                <th scope="col">Session</th>
                <th scope="col">Uses</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={`${g.granted_at}|${g.session_key}`}>
                  <td>{g.kind}</td>
                  <td>{g.granted_by}</td>
                  <td>{g.granted_at}</td>
                  <td>{g.expires_at}</td>
                  <td>{g.session_key ?? 'pending (next session)'}</td>
                  <td>
                    {g.used.length}
                    {g.used.length > 0 && ` (${g.used.map((u) => u.kind).join(', ')})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Crew overrides</h3>
      {crew.length === 0 ? (
        <p>No Crew overrides recorded.</p>
      ) : (
        <p>{crew.length} Crew override(s) listed above.</p>
      )}
      <h3>Hook events</h3>
      {events.length === 0 ? (
        <p>No hook events for this order.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Hook events</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Hook</th>
                <th scope="col">File</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.event_id}>
                  <td>{e.at}</td>
                  <td>{e.hook}</td>
                  <td>{e.target_rel}</td>
                  <td>{e.decision.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
