/**
 * Board-only error banners (plan §10) from the real hook state (`GET /api/status`):
 * - tamper: the persistent tamper flag (wave-3 N3). While it is open the hook keeps enforcing
 *   the last human-attested orders (never fails open), and only a human closes it.
 * - error_open: the hook failed open: it hit an error and allowed a write it could not decide.
 */
import { useConfig } from '../app/context';
import type { BoardStatus } from '../model/types';
import { Banner, useAsync } from './common';

export function HookStatusBanners() {
  const cfg = useConfig();
  const status = cfg.adapter.status?.bind(cfg.adapter);
  const q = useAsync<BoardStatus | null>(
    () => (status ? status().catch(() => null) : Promise.resolve(null)),
    [],
  );
  const s = q.data;
  if (!s) return null;
  const latest = s.error_open.slice(0, 3);
  return (
    <>
      {s.tamper && (
        <Banner
          kind="error"
          title="Tamper detected: DNR is holding the last approved orders"
          testId="banner-tamper"
        >
          <p>
            Since {s.tamper.opened_at}, orders were removed or weakened by something other than a
            human-guarded command. Until a maintainer reviews it, the hook keeps enforcing the approved orders
            it last trusted (it never fails open on tampered state).
          </p>
          <ul>
            {s.tamper.findings.map((f) => (
              <li key={`${f.at}|${f.what}`}>
                {f.at}: {f.what}
              </li>
            ))}
          </ul>
          <p>
            Run <code>dnr tamper show</code> in a terminal. If the changes were yours,{' '}
            <code>dnr tamper accept</code> makes the working copy the attested record.
          </p>
        </Banner>
      )}
      {latest.length > 0 && (
        <Banner
          kind="warn"
          title={`The hook failed open ${s.error_open.length === 1 ? 'once' : `${s.error_open.length} times`}`}
          testId="banner-error-open"
        >
          <p>
            Each time, DNR hit an error, could not decide, and let the write through (<code>error_open</code>
            ). Those writes were not checked.
          </p>
          <ul>
            {latest.map((e) => (
              <li key={`${e.at}|${e.hook}`}>
                {e.at} · {e.hook}: <code>{e.error}</code>
              </li>
            ))}
          </ul>
          <p>
            Details are in <code>.dnr/hook.log</code>. Run <code>dnr doctor</code> to check the install.
          </p>
        </Banner>
      )}
    </>
  );
}
