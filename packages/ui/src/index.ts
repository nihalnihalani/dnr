/**
 * @dnr/ui: one React app for the hosted Playground and the local board (plan §10).
 * `mountApp` picks nothing itself: the host passes the adapter (ApiAdapter on the board,
 * LocalAdapter in the Playground) and asset loaders.
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';

export { preloadRoute } from './app/App';

import type { AppConfig } from './app/context';
import './styles.css';

export { ApiAdapter } from './adapters/api';
export { browserStorage, LocalAdapter, memoryStorage } from './adapters/local';
export type { AppConfig, CaseIndexEntry, SimClock } from './app/context';
export { simClock } from './app/context';
export type { GrammarUrls } from './engine/grammar';
export * from './model';

export function mountApp(el: HTMLElement, config: AppConfig) {
  createRoot(el).render(createElement(App, { config }));
}
