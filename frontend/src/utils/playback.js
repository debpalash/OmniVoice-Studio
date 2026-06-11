/**
 * playback.js — global single-playback manager (issue #316).
 *
 * Only one preview/output plays at a time across the whole app. Every
 * playback site claims the manager before (or right as) it starts audio;
 * claiming stops whatever was playing before. `claimPlayback` returns a
 * `release` function the owner calls when its audio ends naturally (or
 * fails to start), so the manager never holds a stale handle.
 *
 * UI can subscribe — or use the `usePlaybackSource` hook — to render a
 * visible stop affordance while something is playing.
 *
 * Plain module-level singleton: no React dependency in the core API, so it
 * is unit-testable without a DOM and usable from non-component code
 * (e.g. utils/media.js).
 */
import { useSyncExternalStore } from 'react';

let _current = null; // { stop: () => void, source: string }
const _listeners = new Set();

const notify = () => {
  for (const l of _listeners) {
    try { l(); } catch { /* listener errors must not break playback */ }
  }
};

/**
 * Register a new playback as the single active one. Any previously claimed
 * playback is stopped first (its `stop` callback runs).
 *
 * @param {() => void} stop  Halts this playback immediately (pause element /
 *                           stop buffer source / close context).
 * @param {string} source    Label for UI affordances, e.g. 'output',
 *                           'design-preview', 'gallery-preview'.
 * @returns {() => void}     release() — call when playback ends on its own.
 *                           Safe to call multiple times; a stale release
 *                           (after another claim) is a no-op.
 */
export function claimPlayback(stop, source = 'audio') {
  stopActivePlayback();
  const entry = { stop, source };
  _current = entry;
  notify();
  return () => {
    if (_current === entry) {
      _current = null;
      notify();
    }
  };
}

/** Stop whatever is currently playing (no-op when idle). */
export function stopActivePlayback() {
  if (!_current) return;
  const { stop } = _current;
  _current = null; // clear first so re-entrant release() calls are no-ops
  try { stop(); } catch { /* already-stopped handles must not throw */ }
  notify();
}

/** Source label of the active playback, or null when idle. */
export function activePlaybackSource() {
  return _current ? _current.source : null;
}

/** Subscribe to active-playback changes. Returns an unsubscribe function. */
export function subscribePlayback(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/** React hook: source label of the active playback (null when idle). */
export function usePlaybackSource() {
  return useSyncExternalStore(subscribePlayback, activePlaybackSource, () => null);
}
