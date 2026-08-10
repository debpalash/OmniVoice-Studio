const loadTauriWebview = () => import('@tauri-apps/api/webview');

/**
 * Apply the user's UI scale at the webview boundary when Tauri is available.
 * Native zoom keeps the CSS viewport equal to the visible window on every
 * platform; CSS zoom remains the browser/dev fallback.
 *
 * @param {number} scale
 * @param {() => Promise<{ getCurrentWebview: () => { setZoom: (scale: number) => Promise<void> } }>} [loadWebview]
 */
export async function applyUiScale(scale, loadWebview = loadTauriWebview) {
  const root = document.documentElement;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    root.dataset.uiScaleEngine = 'css';
    return 'css';
  }

  try {
    const { getCurrentWebview } = await loadWebview();
    await getCurrentWebview().setZoom(scale);
    // Switch off CSS zoom only after native zoom succeeds, avoiding an
    // unscaled flash during startup or a transient IPC failure.
    root.dataset.uiScaleEngine = 'native';
    return 'native';
  } catch {
    root.dataset.uiScaleEngine = 'css';
    return 'css';
  }
}
