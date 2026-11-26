import { useId, useState } from 'react';
import { LocalAdapter } from '../adapters/local';
import { ACTION_LABEL, type ActionId, DRIFT_INFO, STATE_INFO } from '../model/states';
import type { DataAdapter, OrderDiff, OrderRow } from '../model/types';
import { ErrorBanner } from './common';

export function SimTag({ on }: { on: boolean }) {
  return on ? <span className="sim">simulated</span> : null;
}

/** The next actions for an order's state (plan §10 state table). */
export function StateActions({
  row,
  adapter,
  onChange,
  compact = false,
}: {
  row: OrderRow;
  adapter: DataAdapter;
  onChange: (msg: string) => void;
  compact?: boolean;
}) {
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState(row.order.reason);
  const [diff, setDiff] = useState<OrderDiff | null>(null);
  const reasonId = useId();
  const actions: ActionId[] = [
    ...STATE_INFO[row.effective].actions,
    ...(row.drift ? DRIFT_INFO.actions : []),
  ];
  const sim = adapter.simulated;
  const id = row.order.id;

  const run = async (a: ActionId) => {
    setError(null);
    try {
      switch (a) {
        case 'approve':
          await adapter.patchOrder(id, { status: 'approved' });
          return onChange(`${id} approved${sim ? ' (simulated)' : ''}`);
        case 'retire':
          await adapter.patchOrder(id, { status: 'retired' });
          return onChange(`${id} retired${sim ? ' (simulated)' : ''}`);
        case 'unretire':
          await adapter.patchOrder(id, { status: 'draft' });
          return onChange(`${id} unretired to draft${sim ? ' (simulated)' : ''}`);
        case 'allow-once': {
          const g = await adapter.allowOnce(id, 3600);
          return onChange(`Allow once granted for ${id} until ${g.expires_at}${sim ? ' (simulated)' : ''}`);
        }
        case 'reapprove':
          await adapter.reapprove(id);
          return onChange(`${id} re-approved${sim ? ' (simulated)' : ''}`);
        case 'edit':
          setEditing(true);
          return;
        case 'view-diff':
          setDiff(await adapter.diff(id));
          return;
        case 'restore':
          if (adapter instanceof LocalAdapter) {
            await adapter.restore(id);
            return onChange(`${id} restored from git (simulated)`);
          }
          setDiff(await adapter.diff(id));
          return;
      }
    } catch (e) {
      setError(e);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await adapter.patchOrder(id, { reason });
      setEditing(false);
      onChange(`Reason for ${id} saved${sim ? ' (simulated)' : ''}`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="state-actions">
      <fieldset className="row actions" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="sr-only">Actions for {id}</legend>
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            className={`btn ${a === 'approve' ? 'primary' : ''}`}
            onClick={() => run(a)}
            data-action={a}
          >
            {compact && a === 'reapprove' ? 'Re-approve' : ACTION_LABEL[a]} <SimTag on={sim} />
          </button>
        ))}
      </fieldset>
      {editing && (
        <form onSubmit={save} className="card" style={{ marginTop: 10 }}>
          <label htmlFor={reasonId}>Reason (1–280 characters)</label>
          <textarea
            id={reasonId}
            value={reason}
            maxLength={280}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button type="submit" className="btn primary">
              Save reason <SimTag on={sim} />
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {diff && (
        <section className="card diff" style={{ marginTop: 10 }} aria-label="Diff against git">
          <h3 style={{ marginTop: 0 }}>Order file vs git</h3>
          {!sim && row.drift && (
            <p>
              Restore with <code>git checkout -- .dnr/orders/{id}.json</code>.
            </p>
          )}
          <pre className="out">
            {diff.unified.split('\n').map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines
              <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
                {l}
                {'\n'}
              </span>
            ))}
          </pre>
          <button type="button" className="btn" onClick={() => setDiff(null)}>
            Close diff
          </button>
        </section>
      )}
      {error !== null && <ErrorBanner error={error} />}
    </div>
  );
}
