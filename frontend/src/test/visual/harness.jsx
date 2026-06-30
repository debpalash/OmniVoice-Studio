// ─────────────────────────────────────────────────────────────────
//  Visual-regression harness entry.
//
//  Renders ONE presentational component (chosen via the `component` URL
//  param) wrapped in the requested theme (`theme` URL param) so Playwright
//  can snapshot it in isolation — no Python backend, no app shell, no
//  network. This is the gating safety net for the CSS → Tailwind v4
//  migration: see ./README.md for how to add a component or update a
//  baseline.
//
//  URL: /src/test/visual/harness.html?component=Badge&theme=midnight
// ─────────────────────────────────────────────────────────────────

// React-Refresh preamble guard — mirrors src/main.jsx. @vitejs/plugin-react
// injects this for HTML it transforms, but we install it defensively so the
// harness never trips the "can't detect preamble" error on any Vite version.
if (import.meta.env.DEV && !window.__vite_plugin_react_preamble_installed__) {
  const RefreshRuntime = await import('/@react-refresh');
  RefreshRuntime.default.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
}

import { createRoot } from 'react-dom/client';

// Load the exact same fonts + token layers the real app loads (main-app.jsx),
// in the same order, so snapshots match production rendering.
import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource-variable/source-serif-4';
import '../../ui/tokens.css';
import '../../ui/themes.css';
import '../../index.css';

import { SPECS } from './specs.jsx';

const params = new URLSearchParams(window.location.search);
const componentName = params.get('component') || '';
const theme = params.get('theme') || 'default';
const spec = SPECS[componentName];

function Harness() {
  // Default theme (Gruvbox Dark) is the bare :root tokens — no data-theme.
  // Every other theme is applied via the [data-theme="…"] selector in
  // ui/themes.css, set on the wrapper so the token overrides cascade in.
  const themeAttr = theme === 'default' ? {} : { 'data-theme': theme };
  return (
    <div id="visual-root" className="visual-root" {...themeAttr}>
      {spec ? (
        spec.render()
      ) : (
        <div className="visual-root__error">Unknown component: {componentName || '(none)'}</div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);

// Signal readiness once webfonts have settled so Playwright never snapshots a
// fallback-font frame. toHaveScreenshot also retries until pixels are stable.
document.fonts.ready.then(() => {
  document.documentElement.setAttribute('data-visual-ready', 'true');
});
