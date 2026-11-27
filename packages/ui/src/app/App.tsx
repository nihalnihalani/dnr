import { lazy, Suspense } from 'react';
import { Loading, useTitle } from '../components/common';
import { Home } from '../routes/Home';
import { type AppConfig, ConfigContext, useConfig } from './context';
import { Link, match, RouterProvider, useRouter } from './router';

const load = {
  play: () => import('../routes/Play'),
  graveyard: () => import('../routes/Graveyard'),
  order: () => import('../routes/OrderPage'),
  view: () => import('../routes/OrdersView'),
  trial: () => import('../routes/Trial'),
  replay: () => import('../routes/Replay'),
  kiro: () => import('../routes/Kiro'),
};

/** Start loading the route chunk for `path` before React renders (called by the host at startup). */
export function preloadRoute(path: string) {
  const first = path.split('/').filter(Boolean)[0];
  if (first === 'play') void load.play();
  else if (first === 'graveyard') void load.graveyard();
  else if (first === 'orders') void (path.startsWith('/orders/view') ? load.view() : load.order());
  else if (first === 'trial') void load.trial();
  else if (first === 'replay') void load.replay();
  else if (first === 'kiro') void load.kiro();
}

const Play = lazy(() => load.play().then((m) => ({ default: m.Play })));
const PlayIndex = lazy(() => load.play().then((m) => ({ default: m.PlayIndex })));
const Graveyard = lazy(() => load.graveyard().then((m) => ({ default: m.Graveyard })));
const OrderPage = lazy(() => load.order().then((m) => ({ default: m.OrderPage })));
const OrdersView = lazy(() => load.view().then((m) => ({ default: m.OrdersView })));
const Trial = lazy(() => load.trial().then((m) => ({ default: m.Trial })));
const Replay = lazy(() => load.replay().then((m) => ({ default: m.Replay })));
const Kiro = lazy(() => load.kiro().then((m) => ({ default: m.Kiro })));

function Routes() {
  const { path } = useRouter();
  if (path === '/' || path === '') return <Home />;
  if (path === '/play' || path === '/play/') return <PlayIndex />;
  const play = match('/play/:case', path);
  if (play) return <Play caseId={play.case as string} />;
  if (path === '/graveyard') return <Graveyard />;
  if (path === '/orders/view') return <OrdersView />;
  const ord = match('/orders/:id', path);
  if (ord) return <OrderPage id={ord.id as string} />;
  if (path === '/trial') return <Trial />;
  if (path === '/replay') return <Replay />;
  if (path === '/kiro') return <Kiro />;
  return <NotFound path={path} />;
}

function NotFound({ path }: { path: string }) {
  useTitle('Page not found');
  return (
    <section className="not-found" data-testid="not-found" aria-labelledby="page-title">
      <p className="eyebrow">404 · page not found</p>
      <h1 id="page-title">Nothing buried here</h1>
      <p className="lede">
        There is no page at <code>{path}</code>. It may have moved, or the link has a typo.
      </p>
      <ul className="not-found-links">
        <li>
          <Link to="/" className="btn">
            Home
          </Link>
        </li>
        <li>
          <Link to="/play" className="btn">
            Try a revert
          </Link>
        </li>
        <li>
          <Link to="/graveyard" className="btn">
            The graveyard
          </Link>
        </li>
      </ul>
    </section>
  );
}

function Shell() {
  const cfg = useConfig();
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <Link to="/" className="brand">
          <svg width="28" height="32" viewBox="0 0 28 32" aria-hidden="true" focusable="false">
            <path d="M3 31 V12 A11 11 0 0 1 25 12 V31 Z" fill="#c9c4b8" />
            <path d="M9 16 h10 M14 11 v12" stroke="#1d1c1a" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          DNR <small>Do Not Resurrect</small>
        </Link>
        <nav aria-label="Main">
          <ul>
            <li>
              <Link to="/play">Play</Link>
            </li>
            <li>
              <Link to="/graveyard">Graveyard</Link>
            </li>
            <li>
              <Link to="/replay">Replay</Link>
            </li>
            <li>
              <Link to="/trial">Trial</Link>
            </li>
            <li>
              <Link to="/kiro">Kiro</Link>
            </li>
          </ul>
        </nav>
        <span className="mode-pill">
          {cfg.mode === 'board' ? 'Local board' : 'Playground · runs in your browser'}
        </span>
      </header>
      <main id="main" tabIndex={-1}>
        <Suspense fallback={<Loading what="page" />}>
          <Routes />
        </Suspense>
      </main>
      <footer className="footer">
        DNR {cfg.version}. Case data excerpts Django source (BSD-3-Clause, © Django Software Foundation and
        individual contributors; <a href={`${cfg.base}licenses/django-LICENSE.txt`}>license</a>). Grammars:
        tree-sitter-python and tree-sitter-typescript (MIT).
      </footer>
    </>
  );
}

export function App({ config }: { config: AppConfig }) {
  return (
    <ConfigContext.Provider value={config}>
      <RouterProvider base={config.base}>
        <Shell />
      </RouterProvider>
    </ConfigContext.Provider>
  );
}
