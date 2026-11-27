// Lighthouse CI gates for the hosted Playground (plan Phase 13, matrix P13-05 and P13-06).
// Lighthouse's default mobile preset (Moto G Power emulation, simulated slow 4G) on a local
// `vite preview` of the production build. Run from apps/playground after `pnpm build`:
//   pnpm exec lhci autorun
const port = Number(process.env.LHCI_PORT ?? 4199);
const base = `http://127.0.0.1:${port}`;

module.exports = {
  ci: {
    collect: {
      startServerCommand: `pnpm exec vite preview --strictPort --port ${port} --host 127.0.0.1`,
      startServerReadyPattern: 'Local',
      url: ['/', '/play/43933a1dca', '/graveyard', '/trial'].map((p) => `${base}${p}`),
      numberOfRuns: 3,
      settings: {
        // Mobile is Lighthouse's default form factor and throttling; stated here so it cannot drift.
        formFactor: 'mobile',
        screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
        throttlingMethod: 'simulate',
        chromeFlags: '--no-sandbox --headless=new',
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.9, aggregationMethod: 'median-run' }],
        'categories:accessibility': ['error', { minScore: 1, aggregationMethod: 'median-run' }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: './lhci-report',
    },
  },
};
