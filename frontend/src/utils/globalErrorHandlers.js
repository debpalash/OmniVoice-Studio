/**
 * globalErrorHandlers — last-resort surfacing for uncaught failures.
 *
 * consoleBuffer already records `window.onerror` / `unhandledrejection`
 * into the Settings → Logs → Frontend ring; this adds the user-visible
 * half: a throttled error toast with a "Report this bug" action
 * (utils/errorToast.jsx) so async failures outside any ErrorBoundary or
 * wired call site still have a path to a GitHub issue.
 *
 * Throttled per message (one toast per 30s) and filtered against known
 * benign noise — a render-loop bug must not bury the user in toasts.
 */
import i18next from 'i18next';
import { toastErrorWithReport } from './errorToast';

const THROTTLE_MS = 30_000;
const lastShown = new Map();

// Browser/webview noise that is not actionable by the user and must never
// produce a report prompt.
const IGNORE_PATTERNS = [
  /ResizeObserver loop/i,
  /AbortError/i,
  /Loading chunk \d+ failed/i, // transient on dev-server restarts
  /Script error\.?$/i,         // opaque cross-origin errors carry no info
];

function shouldShow(message) {
  if (!message || IGNORE_PATTERNS.some((p) => p.test(message))) return false;
  const key = String(message).slice(0, 200);
  const now = Date.now();
  if ((lastShown.get(key) || 0) > now - THROTTLE_MS) return false;
  lastShown.set(key, now);
  return true;
}

function surface(message, error) {
  if (!shouldShow(message)) return;
  const err = error instanceof Error ? error : new Error(String(error ?? message));
  toastErrorWithReport(
    i18next.t('errors.unexpected', { message: String(message).slice(0, 140) }),
    err,
  );
}

let installed = false;

export function installGlobalErrorHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    surface(e?.error?.message || e.message, e.error);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e?.reason;
    surface(r?.message || String(r), r);
  });
}
