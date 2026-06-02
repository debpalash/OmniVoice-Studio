/**
 * Tauri auto-update flow with progress + safety, channel-aware.
 *
 * The bundled updater plugin can't switch release channels from JS (its
 * endpoints are fixed in tauri.conf.json), so check + install go through the
 * Rust `check_update` / `install_update` commands, which bind the right
 * endpoints per call via `UpdaterExt`. The store contract here is identical to
 * the prior JS-plugin flow, so UpdateBadge / App.jsx are unaffected.
 *
 * - checkForUpdate(): non-blocking; on launch, surfaces availability into the
 *   store (no auto-install — the user picks when via the UpdateBadge).
 * - installUpdate(): installs with a progress callback (Rust emits
 *   `update://progress`), then relaunches. The badge gates the action while a
 *   job is running so in-flight work isn't lost.
 *
 * Both no-op outside a packaged Tauri build.
 */
import { normalizeChannel } from './updateChannel';

export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function currentChannel() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return normalizeChannel(await invoke('get_update_channel'));
  } catch {
    return 'stable';
  }
}

export async function checkForUpdate(store) {
  if (!isTauri()) return;
  // A periodic re-check must not interrupt an in-progress download or a
  // ready-to-restart state (it would reset the badge mid-flight), nor wipe a
  // surfaced error — `setUpdateChecking()` clears `updateError` and hides the
  // pill, so a 6h tick would silently erase the "failed · retry" prompt the
  // user still needs to act on. Retry is user-initiated (it goes through
  // installUpdate → downloading), so skipping the auto re-check here is safe.
  if (
    store.updateStatus === 'downloading' ||
    store.updateStatus === 'ready' ||
    store.updateStatus === 'error'
  ) {
    return;
  }
  try {
    store.setUpdateChecking();
    const { invoke } = await import('@tauri-apps/api/core');
    const channel = await currentChannel();
    const update = await invoke('check_update', { channel });
    if (update) store.setUpdateAvailable(update.version, update.notes || null);
    else store.setUpdateIdle();
  } catch (e) {
    // Endpoint 404s until the first signed release on a channel — non-fatal.
    console.debug('Update check failed (non-fatal):', e);
    store.setUpdateIdle();
  }
}

export async function installUpdate(store) {
  if (!isTauri()) return;
  let unlisten;
  try {
    const [{ invoke }, { listen }, { relaunch }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
      import('@tauri-apps/plugin-process'),
    ]);
    const channel = await currentChannel();
    store.setUpdateProgress(0);
    unlisten = await listen('update://progress', (ev) => {
      const { downloaded = 0, total = 0 } = ev?.payload || {};
      if (total > 0) store.setUpdateProgress(Math.min(99, (downloaded / total) * 100));
    });
    await invoke('install_update', { channel });
    store.setUpdateReady();
    await relaunch();
  } catch (e) {
    console.warn('Update install failed:', e);
    store.setUpdateError((e && e.message) || String(e) || 'Update failed');
  } finally {
    if (unlisten) unlisten();
  }
}

/** Fetch the project's releases (changelog/history) via the Rust command. [] outside Tauri / on error. */
export async function listReleases(channel) {
  if (!isTauri()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  const data = await invoke('list_releases', { channel });
  return Array.isArray(data) ? data : [];
}

/** Current app version via Tauri, or null outside a packaged build. */
export async function fetchAppVersion() {
  if (!isTauri()) return null;
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return null;
  }
}
