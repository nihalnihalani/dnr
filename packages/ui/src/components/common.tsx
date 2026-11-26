import { useEffect, useState } from 'react';
import { AdapterError } from '../model/types';

export function Banner({
  kind,
  title,
  children,
  testId,
}: {
  kind: 'info' | 'warn' | 'error' | 'sample';
  title: string;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'} data-testid={testId}>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

/** Error banners for adapter failures (STATE-08: 401, 409, invalid order). */
export function ErrorBanner({ error }: { error: unknown }) {
  if (error instanceof AdapterError) {
    if (error.status === 401)
      return (
        <Banner kind="error" title="401: board not unlocked" testId="banner-401">
          This page has no board session. Run <code>dnr board</code> in a terminal to unlock it.
        </Banner>
      );
    if (error.status === 409)
      return (
        <Banner kind="error" title="409: invalid transition" testId="banner-409">
          {error.message}
        </Banner>
      );
    if (error.code === 'invalid_order')
      return (
        <Banner kind="error" title="Invalid order file" testId="banner-invalid">
          {error.message}
        </Banner>
      );
    if (error.status === 403)
      return (
        <Banner kind="error" title="403: refused" testId="banner-403">
          {error.message}
        </Banner>
      );
  }
  return (
    <Banner kind="error" title="Something went wrong" testId="banner-error">
      {(error as Error)?.message ?? String(error)}
    </Banner>
  );
}

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data?: T; error?: unknown; loading: boolean; reload(): void } {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are passed by the caller
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" aria-live="polite" className="lede">
      Loading {what}…
    </p>
  );
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · DNR`;
  }, [title]);
}
