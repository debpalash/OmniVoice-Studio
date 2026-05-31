/**
 * Tauri auto-update flow with progress + safety.
 *
 * - checkForUpdate(): non-blocking; on launch, surfaces availability into the
 *   store (no auto-install — the user picks when via the UpdateBadge).
 * - installUpdate(): downloads with a progress callback → store, then relaunches.
 *   Download is safe anytime; only the relaunch ends the session, and the badge
 *   gates the action while a job is running so in-flight work isn't lost.
 *
 * Both no-op outside a packaged Tauri build.
 */
export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function checkForUpdate(store) {
  if (!isTauri()) return;
  try {
    store.setUpdateChecking();
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) store.setUpdateAvailable(update.version, update.body || null);
    else store.setUpdateIdle();
  } catch (e) {
    // Endpoint 404s until the first signed release — non-fatal noise.
    console.debug('Update check failed (non-fatal):', e);
    store.setUpdateIdle();
  }
}

export async function installUpdate(store) {
  if (!isTauri()) return;
  try {
    const [{ check }, { relaunch }] = await Promise.all([
      import('@tauri-apps/plugin-updater'),
      import('@tauri-apps/plugin-process'),
    ]);
    const update = await check();
    if (!update) { store.setUpdateIdle(); return; }
    let total = 0;
    let got = 0;
    store.setUpdateProgress(0);
    await update.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data?.contentLength || 0;
      else if (ev.event === 'Progress') {
        got += ev.data?.chunkLength || 0;
        if (total > 0) store.setUpdateProgress(Math.min(99, (got / total) * 100));
      } else if (ev.event === 'Finished') {
        store.setUpdateReady();
      }
    });
    store.setUpdateReady();
    await relaunch();
  } catch (e) {
    console.warn('Update install failed:', e);
    store.setUpdateError((e && e.message) || 'Update failed');
  }
}
