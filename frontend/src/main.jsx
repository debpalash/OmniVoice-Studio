if (import.meta.env.DEV && !window.__vite_plugin_react_preamble_installed__) {
  const RefreshRuntime = await import('/@react-refresh');
  RefreshRuntime.default.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
}

const { bootstrapApp } = await import('./main-app.jsx');

bootstrapApp();

// Global double-click-to-maximize for the custom titlebar (all platforms).
// The window is borderless (decorations:false), so the OS won't zoom on a
// title-bar double-click — wire it ourselves once, delegated across every
// `data-tauri-drag-region` (splash, first-run, wizard, main header). Skips
// interactive controls inside the bar (selects/buttons), and no-ops in a
// plain browser (doubleClickMaximize guards on tauriWindow).
const { doubleClickMaximize } = await import('./utils/media');
// Use mousedown with detail===2 instead of `dblclick`: on macOS the drag
// region's startDragging() swallows the second click so `dblclick` never
// fires; the second mousedown still arrives (detail 2). This is also the
// ONLY maximize handler — a second one (e.g. an onDoubleClick on the header)
// would toggle twice and visually do nothing.
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.detail !== 2) return;
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;
  if (!t.closest('[data-tauri-drag-region]')) return;
  if (t.closest('button, a, input, select, textarea, label, [role="button"], [contenteditable]')) return;
  e.preventDefault();
  doubleClickMaximize();
});

// #380: after an app update, a still-open window can hold an index.html whose
// lazy chunks reference old hashed assets that no longer exist on disk —
// vite surfaces that as "Unable to preload CSS for /assets/…". The documented
// recovery is a one-time reload to pick up the fresh manifest. The session
// flag prevents a reload loop if the asset is genuinely missing.
window.addEventListener('vite:preloadError', (event) => {
  if (sessionStorage.getItem('omnivoice.preloadErrorReloaded') === '1') return;
  sessionStorage.setItem('omnivoice.preloadErrorReloaded', '1');
  event.preventDefault();
  window.location.reload();
});
