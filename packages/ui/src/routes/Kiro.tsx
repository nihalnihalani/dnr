import { useConfig } from '../app/context';
import { Banner, ErrorBanner, Loading, useAsync, useTitle } from '../components/common';

interface KiroRow {
  surface: string;
  file: string;
  what: string;
  history: string[];
}

export function Kiro() {
  useTitle('How Kiro built it');
  const cfg = useConfig();
  const q = useAsync(async () => {
    const res = await fetch(cfg.kiroUrl);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()) as { rows: KiroRow[] };
  }, []);
  const surfaces = [...new Set(q.data?.rows.map((r) => r.surface) ?? [])];
  return (
    <>
      <h1 id="page-title">How Kiro built it</h1>
      <p className="lede">
        Each Kiro surface, the file in this repository that uses it, and what it does. Generated from{' '}
        <code>.kiro/</code> and <code>powers/</code> at build time, with each file's latest commits.
      </p>
      {q.loading && <Loading what="Kiro artifacts" />}
      {q.error !== undefined && <ErrorBanner error={q.error} />}
      {!q.loading && !q.data && (
        <Banner kind="info" title="No Kiro artifact index in this build" testId="empty-kiro">
          Run <code>pnpm -F @dnr/playground build</code> from the repository.
        </Banner>
      )}
      {surfaces.map((s) => (
        <section key={s} aria-labelledby={`k-${s}`}>
          <h2 id={`k-${s}`}>{s}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">What it does</th>
                  <th scope="col">What changed (git)</th>
                </tr>
              </thead>
              <tbody>
                {q.data?.rows
                  .filter((r) => r.surface === s)
                  .map((r) => (
                    <tr key={r.file}>
                      <td>
                        {cfg.repoUrl ? (
                          <a href={`${cfg.repoUrl.replace(/\/$/, '')}/blob/main/${r.file}`}>
                            <code>{r.file}</code>
                          </a>
                        ) : (
                          <code>{r.file}</code>
                        )}
                      </td>
                      <td>{r.what}</td>
                      <td>{r.history.length ? r.history.join(' · ') : 'not committed yet'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
