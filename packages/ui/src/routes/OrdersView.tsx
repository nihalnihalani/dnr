import { Order } from '@dnr/schemas';
import { useRouter } from '../app/router';
import { Banner, Loading, useAsync, useTitle } from '../components/common';
import { Headstone } from '../components/Headstone';
import { TokenChips } from '../components/TokenChips';
import { STATE_INFO } from '../model/states';

export type ViewResult =
  | { ok: true; order: Order }
  | { ok: false; kind: 'missing' | 'host' | 'fetch' | 'json' | 'invalid'; message: string };

/** Only https://raw.githubusercontent.com/... is accepted (Crew comments link there). */
export function checkSrc(src: string | null): URL | { error: ViewResult } {
  if (!src)
    return {
      error: {
        ok: false,
        kind: 'missing',
        message: 'Add ?src=<raw.githubusercontent.com URL of an order file>.',
      },
    };
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return { error: { ok: false, kind: 'host', message: 'src is not a URL.' } };
  }
  if (
    u.protocol !== 'https:' ||
    u.hostname !== 'raw.githubusercontent.com' ||
    u.username ||
    u.password ||
    u.port
  )
    return {
      error: { ok: false, kind: 'host', message: 'src must be an https://raw.githubusercontent.com/ URL.' },
    };
  return u;
}

export async function loadOrderFile(src: string | null): Promise<ViewResult> {
  const u = checkSrc(src);
  if (!(u instanceof URL)) return u.error;
  let text: string;
  try {
    const res = await fetch(u, { credentials: 'omit', redirect: 'error' });
    if (!res.ok) return { ok: false, kind: 'fetch', message: `GitHub answered ${res.status}.` };
    text = await res.text();
  } catch (e) {
    return { ok: false, kind: 'fetch', message: `Could not fetch the file (${(e as Error).message}).` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, kind: 'json', message: 'The file is not JSON.' };
  }
  const p = Order.safeParse(json);
  if (!p.success) {
    const i = p.error.issues[0];
    return { ok: false, kind: 'invalid', message: `${i?.path.join('.') || '(root)'}: ${i?.message}` };
  }
  return { ok: true, order: p.data };
}

export function OrdersView() {
  useTitle('Order file');
  const r = useRouter();
  const src = r.search.get('src');
  const q = useAsync(() => loadOrderFile(src), [src]);
  return (
    <>
      <h1 id="page-title">Committed order file</h1>
      {src && (
        <p style={{ wordBreak: 'break-all' }}>
          Source: <a href={src}>{src}</a>
        </p>
      )}
      {q.loading && <Loading what="the order file" />}
      {q.data && !q.data.ok && (
        <Banner
          kind="error"
          title={
            q.data.kind === 'invalid' ? 'Invalid order file (schema dnr.order/v1)' : 'Cannot show this order'
          }
          testId={`view-error-${q.data.kind}`}
        >
          {q.data.message}
        </Banner>
      )}
      {q.data?.ok && (
        <div className="order-layout" data-testid="view-ok">
          <Headstone
            row={{ order: q.data.order, effective: q.data.order.status, drift: false }}
            headingLevel={2}
            linkName={false}
          />
          <div>
            <p className="lede">
              <code>{q.data.order.id}</code> · {STATE_INFO[q.data.order.status].label} (stored status; stale
              and re-landed need the repository). Read-only.
            </p>
            <p>
              To act on it: <code>dnr board --open {q.data.order.id}</code>
            </p>
            {q.data.order.units.map((u) => (
              <div className="unit" key={`${u.file}|${u.qualname}`}>
                <p style={{ margin: 0 }}>
                  <code>{u.qualname}</code> in <code>{u.file}</code> · {u.kind}
                </p>
                <TokenChips A={u.A} R={u.R} />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
