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
window.addEventListener('dblclick', (e) => {
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;
  if (!t.closest('[data-tauri-drag-region]')) return;
  if (t.closest('button, a, input, select, textarea, label, [role="button"], [contenteditable]')) return;
  doubleClickMaximize();
});
