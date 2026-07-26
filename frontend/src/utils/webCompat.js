/**
 * Web-platform gap fills for the OLDEST WebView we claim to support.
 *
 * `tauri.conf.json` declares `minimumSystemVersion: "12.0"` and the install
 * docs promise macOS 12 (Monterey) — which ships Safari/WKWebView **15.6**.
 * Anything newer than that is not present at runtime on a supported machine,
 * and because our entry chunk touches these during the first React render, a
 * single missing method is not a degraded feature: it throws mid-render, the
 * tree unmounts, and the user gets a dead window with no backend ever started
 * (#1245).
 *
 * This module must be imported for side effects as the FIRST thing in
 * `main.jsx`, before any app chunk loads. `test/webCompat.test.js` keeps the
 * list honest: it fails CI if app code reaches for a post-15.6 API that is not
 * filled in here.
 *
 * Windows (evergreen WebView2) and Linux (WebKitGTK ≥ 2.44 on Ubuntu 24.04+)
 * both clear the floor comfortably — macOS 12 is the binding constraint.
 */

/**
 * `AbortSignal.timeout(ms)` — Safari 16.0. Used by the backend health poll on
 * the very first render, so its absence took the whole app down on Monterey.
 */
export function installAbortSignalTimeout() {
  if (typeof AbortSignal === 'undefined' || typeof AbortController === 'undefined') return;
  if (typeof AbortSignal.timeout === 'function') return;

  AbortSignal.timeout = function timeout(ms) {
    const controller = new AbortController();
    setTimeout(() => {
      // The spec aborts with a DOMException named TimeoutError, which is how
      // callers tell "we gave up" apart from "the user cancelled". Safari 15.6
      // predates `abort(reason)`, so the argument is simply ignored there —
      // the abort itself, which is what every call site actually branches on,
      // still fires.
      let reason;
      try {
        reason = new DOMException('signal timed out', 'TimeoutError');
      } catch {
        reason = new Error('signal timed out');
        reason.name = 'TimeoutError';
      }
      controller.abort(reason);
    }, ms);
    return controller.signal;
  };
}

export function installWebCompat() {
  installAbortSignalTimeout();
}

installWebCompat();
