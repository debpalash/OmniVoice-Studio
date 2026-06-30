/* global __APP_VERSION__ -- injected by Vite (vite.config define) at build time */
// The build's own version, always present regardless of Tauri presence or
// backend liveness — the always-correct source per the version-lockstep rule
// (it comes from package.json, kept in lockstep with the other version files).
export const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) || 'unknown';

/**
 * Resolve the version shown in Settings → About / the diagnostics block. Prefer
 * the authoritative Tauri-config version, then the live backend's
 * `/system/info` `app_version`, then the build-time constant — so it is NEVER
 * blank, even in the web/Pinokio build where Tauri is absent and the backend
 * may be idle (the About → Version field rendered empty there).
 *
 * @param {string|null|undefined} appVersion  Tauri `getVersion()` result
 * @param {{ app_version?: string }|null|undefined} info  `/system/info` payload
 * @returns {string}
 */
export function resolveAboutVersion(appVersion, info) {
  return appVersion || info?.app_version || APP_VERSION;
}
