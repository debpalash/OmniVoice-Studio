/**
 * Registry of every localStorage key OmniVoice uses, split into the
 * preferences that Settings → Factory reset clears and the keys it must
 * preserve. Factory reset promises "reset ALL in-app preferences" — before
 * this registry it only removed the zustand blob ('omnivoice.app'), leaving
 * nav-rail side, capture live-typing, stories speed, dismissed-tip flags and
 * the legacy 'omni_ui' blob behind.
 *
 * Adding a new persisted preference? Pick a key under one of
 * PREF_KEY_PREFIXES (preferred: 'omnivoice.<area>.<name>') and factory reset
 * covers it automatically. Keys that must NOT be wiped (user data,
 * connection/credentials) go in PRESERVED_KEYS with a reason.
 * utils/prefKeys.test.js scans the source tree and fails on any localStorage
 * key that is in neither bucket.
 */

/** Prefixes owned by UI preferences — factory reset clears every match. */
export const PREF_KEY_PREFIXES = [
  'omnivoice.', // zustand blob ('omnivoice.app') + navRailSide, logs.*, settings.category, donate.*, recents.*, dismissed-tip flags
  'omni_capture_', // CaptureWidget mode + live-typing
  'ov_stories_', // StoriesEditor global speed
];

/** Exact preference keys that don't fit a prefix (legacy spellings). */
export const PREF_KEYS = [
  'omni_ui', // legacy pre-zustand UI blob (useAppData shim)
  'dismissed_lang_suggestion', // BootstrapSplash language-suggestion dismissal
];

/**
 * Keys factory reset must NEVER touch:
 *  - 'ov_backend_url' / 'ov_api_key': remote-backend connection + credential —
 *    wiping them would sever a LAN-connected instance from its backend.
 *  - 'omni_transcriptions': dictation history — user DATA, not a preference.
 */
export const PRESERVED_KEYS = ['ov_backend_url', 'ov_api_key', 'omni_transcriptions'];

/** True when `key` is a resettable in-app preference. */
export function isPrefKey(key) {
  if (PRESERVED_KEYS.includes(key)) return false;
  return PREF_KEYS.includes(key) || PREF_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Remove every persisted in-app preference (and nothing else) from storage.
 * Returns the list of keys that were removed.
 */
export function clearLocalPreferences(storage = window.localStorage) {
  const keys =
    typeof storage.length === 'number' && typeof storage.key === 'function'
      ? Array.from({ length: storage.length }, (_, i) => storage.key(i))
      : Object.keys(storage);
  const doomed = keys.filter((k) => k && isPrefKey(k));
  for (const k of doomed) storage.removeItem(k);
  return doomed;
}
