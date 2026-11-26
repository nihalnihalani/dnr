import { useState } from 'react';
import { useConfig } from '../app/context';
import { useRouter } from '../app/router';
import { Banner, ErrorBanner, Loading, useAsync, useTitle } from '../components/common';
import { Headstone } from '../components/Headstone';
import { StateActions } from '../components/StateActions';
import { graveyardSummary, STATE_INFO } from '../model/states';
import type { OrderRow } from '../model/types';

/** `?empty=none|reverts|drafts` previews the three empty states without a repository (Playground only). */
function preview(rows: OrderRow[], mode: string | null): { rows: OrderRow[]; scanFoundZero: boolean } {
  if (mode === 'none') return { rows: [], scanFoundZero: false };
  if (mode === 'reverts') return { rows: [], scanFoundZero: true };
  if (mode === 'drafts')
    return {
      rows: rows.slice(0, 3).map((r) => ({
        ...r,
        order: { ...r.order, status: 'draft' },
        effective: 'draft',
        drift: false,
        illustrative: true,
      })),
      scanFoundZero: false,
    };
  if (mode === 'retired')
    return {
      rows: rows.map((r) => ({
        ...r,
        order: { ...r.order, status: 'retired' },
        effective: 'retired',
        drift: false,
        illustrative: true,
      })),
      scanFoundZero: false,
    };
  return { rows, scanFoundZero: false };
}

export function Graveyard() {
  useTitle('Graveyard');
  const cfg = useConfig();
  const r = useRouter();
  const [msg, setMsg] = useState('');
  const q = useAsync(() => cfg.adapter.listOrders(), []);
  const mode = cfg.mode === 'playground' ? r.search.get('empty') : null;
  const onChange = (m: string) => {
    setMsg(m);
    q.reload();
  };
  return (
    <>
      <h1 id="page-title">The graveyard</h1>
      <p className="lede">
        Every headstone is a change that was tried and reverted. The epitaph is why. An approved order stops
        an agent from resurrecting it.
      </p>
      {cfg.adapter.simulated && (
        <Banner kind="info" title="Playground" testId="banner-simulated">
          Orders come from real Django reverts. Actions are <strong>simulated</strong> and stored only in this
          browser. States marked “illustrative” are set for the demo, not computed from a repository.
        </Banner>
      )}
      <p className="sr-only" aria-live="polite" role="status">
        {msg}
      </p>
      {msg && (
        <p className="lede" aria-hidden="true">
          {msg}
        </p>
      )}
      <ul className="legend" aria-label="Legend">
        {Object.entries(STATE_INFO).map(([k, v]) => (
          <li key={k}>
            <strong>{v.visual}</strong>: {v.label}
          </li>
        ))}
        <li>
          <strong>red border</strong>: Differs from git
        </li>
      </ul>
      {q.loading && !q.data && <Loading what="orders" />}
      {q.error !== undefined && <ErrorBanner error={q.error} />}
      {q.data && <Yard {...preview(q.data, mode)} onChange={onChange} />}
    </>
  );
}

function Yard({
  rows,
  scanFoundZero,
  onChange,
}: {
  rows: OrderRow[];
  scanFoundZero: boolean;
  onChange: (m: string) => void;
}) {
  const cfg = useConfig();
  const summary = graveyardSummary(rows, { scanFoundZero });
  const allRetired = rows.length > 0 && rows.every((x) => x.effective === 'retired');
  return (
    <section className="yard" aria-label="Headstones">
      <div className="moon" aria-hidden="true" />
      <div className="mist" aria-hidden="true" />
      {summary.kind === 'no-orders' || summary.kind === 'no-reverts' ? (
        <div className="empty-yard" data-testid={`empty-${summary.kind}`}>
          <div className="lone" aria-hidden="true" />
          <h2>{summary.label}</h2>
          <p>
            {summary.kind === 'no-reverts' ? 'Mark a commit by hand with ' : 'Next: run '}
            <code>{summary.next}</code>
          </p>
        </div>
      ) : (
        <>
          {summary.kind === 'drafts-only' && (
            <Banner kind="warn" title={summary.label} testId="banner-drafts-only">
              Nothing is enforced yet. Review drafts: approve the ones whose reason is right.
            </Banner>
          )}
          {allRetired && (
            <Banner kind="info" title="Every order is retired" testId="banner-all-retired">
              Nothing is enforced. Unretire an order to review it again.
            </Banner>
          )}
          <ul className="plots">
            {rows.map((row) => (
              <li className="plot" key={row.order.id}>
                <Headstone row={row} />
                <div className="mound" aria-hidden="true" />
                <StateActions row={row} adapter={cfg.adapter} onChange={onChange} compact />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
