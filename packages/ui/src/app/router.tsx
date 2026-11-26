/** A tiny history router that respects the deploy base path. */
import {
  type AnchorHTMLAttributes,
  createContext,
  type MouseEvent,
  useContext,
  useEffect,
  useState,
} from 'react';

interface RouterState {
  base: string;
  path: string;
  search: URLSearchParams;
  navigate(to: string, opts?: { replace?: boolean }): void;
}

const RouterContext = createContext<RouterState | null>(null);

function strip(base: string, pathname: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = b && pathname.startsWith(b) ? pathname.slice(b.length) : pathname;
  return p.startsWith('/') ? p : `/${p}`;
}

export function href(base: string, to: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${b}${to}`;
}

export function RouterProvider({ base, children }: { base: string; children: React.ReactNode }) {
  const read = () => ({ path: strip(base, location.pathname), search: new URLSearchParams(location.search) });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  });
  const navigate = (to: string, opts: { replace?: boolean } = {}) => {
    const url = href(base, to);
    if (opts.replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    setLoc(read());
    if (!opts.replace) {
      scrollTo(0, 0);
      // Move focus to the new page's main heading for screen-reader and keyboard users.
      queueMicrotask(() => document.getElementById('main')?.focus());
    }
  };
  return <RouterContext.Provider value={{ base, ...loc, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterState {
  const r = useContext(RouterContext);
  if (!r) throw new Error('RouterContext missing');
  return r;
}

export function Link({ to, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const r = useRouter();
  const target = href(r.base, to);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    r.navigate(to);
  };
  const current = r.path === to.split('?')[0] ? 'page' : undefined;
  return <a href={target} aria-current={current} {...rest} onClick={onClick} />;
}

/** Match `/a/:b` patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as string;
    const b = s[i] as string;
    if (a.startsWith(':')) out[a.slice(1)] = decodeURIComponent(b);
    else if (a !== b) return null;
  }
  return out;
}
