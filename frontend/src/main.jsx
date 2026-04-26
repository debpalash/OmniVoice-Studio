if (import.meta.env.DEV && !window.__vite_plugin_react_preamble_installed__) {
  const RefreshRuntime = await import('/@react-refresh');
  RefreshRuntime.default.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
}

const { bootstrapApp } = await import('./main-app.jsx');

bootstrapApp();
