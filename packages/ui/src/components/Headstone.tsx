import type { Order } from '@dnr/schemas';
import { Link } from '../app/router';
import { DRIFT_INFO, STATE_INFO } from '../model/states';
import type { OrderRow } from '../model/types';

const short = (sha: string | null) => (sha ? sha.slice(0, 10) : 'none');
const day = (iso: string) => iso.slice(0, 10);

export function orderName(order: Order): string {
  const named = (u: Order['units'][number]) => !u.qualname.startsWith('<');
  const first =
    order.units.find((u) => u.kind === 'modified' && named(u)) ?? order.units.find(named) ?? order.units[0];
  const more = order.units.length - 1;
  return `${first?.qualname ?? order.id}${more > 0 ? ` +${more}` : ''}`;
}

function Candle() {
  return (
    <svg className="candle-svg" viewBox="0 0 26 64" aria-hidden="true" focusable="false">
      <title>candle</title>
      <ellipse cx="13" cy="60" rx="12" ry="3" fill="#2a2a24" />
      <rect x="7" y="26" width="12" height="34" rx="2" fill="#efe7cf" />
      <rect x="12.4" y="20" width="1.2" height="7" fill="#333" />
      <path className="flame" d="M13 4 C18 11 17 18 13 21 C9 18 8 11 13 4 Z" fill="#ffcf5c" />
      <path className="flame" d="M13 10 C15 14 15 17 13 19 C11 17 11 14 13 10 Z" fill="#fff4c2" />
    </svg>
  );
}

/** One order as a headstone. Every visual signal also has a text label (A11Y-01). */
export function Headstone({
  row,
  headingLevel = 2,
  linkName = true,
}: {
  row: OrderRow;
  headingLevel?: 2 | 3;
  linkName?: boolean;
}) {
  const { order, effective, drift } = row;
  const info = STATE_INFO[effective];
  const original = order.links.find((l) => l.rel === 'original')?.url;
  const revert = order.links.find((l) => l.rel === 'revert')?.url;
  const ticket = order.tickets[0]?.url ?? order.links.find((l) => l.rel === 'ticket')?.url;
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const cls = ['stone', info.visual, drift ? 'drift' : ''].filter(Boolean).join(' ');
  return (
    <article
      className={cls}
      aria-label={`Order ${order.id}: ${info.label}${drift ? `, ${DRIFT_INFO.label}` : ''}`}
      data-state={effective}
      data-drift={drift ? 'true' : 'false'}
    >
      <span className="state" data-testid="state-label">
        {info.label}
      </span>
      {drift && (
        <span className="drift-label" data-testid="drift-label">
          {DRIFT_INFO.label}
        </span>
      )}
      <p className="rip" aria-hidden="true">
        R·I·P
      </p>
      <H className="name" style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>
        {linkName ? <Link to={`/orders/${order.id}`}>{orderName(order)}</Link> : orderName(order)}
      </H>
      <p className="epitaph" style={{ margin: 0 }}>
        <span className="sr-only">Epitaph (reason): </span>“{order.reason}”
      </p>
      <p className="dates" style={{ margin: 0 }}>
        <span>
          Born (commit):{' '}
          {original ? <a href={original}>{short(order.original_sha)}</a> : short(order.original_sha)}
        </span>
        <span>
          Died (revert): {revert ? <a href={revert}>{short(order.revert_sha)}</a> : short(order.revert_sha)} ·{' '}
          {day(order.created_at)}
        </span>
        {ticket && (
          <span>
            Ticket: <a href={ticket}>{order.tickets[0]?.id ? `#${order.tickets[0].id}` : 'link'}</a>
          </span>
        )}
        <span>{order.id}</span>
      </p>
      {row.illustrative && effective !== order.status && <span className="illus">illustrative state</span>}
      {row.illustrative && drift && <span className="illus">illustrative drift</span>}
      {effective === 'relanded' && <Candle />}
    </article>
  );
}
