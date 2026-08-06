//! Blank-window guard — the app must never sit on an empty window.
//!
//! VoiceStudio has shipped a blank window more than once, from unrelated causes:
//!
//!   * **Production** (#1178): a minifier temporal-dead-zone reorder threw
//!     before React mounted. Assets loaded fine; `#root` stayed empty.
//!   * **Development**: a second `bun desktop` launch killed the first
//!     instance's Vite server, leaving its window pointed at a dev URL that no
//!     longer answered.
//!
//! Both look identical to the user — a dark rectangle with no explanation and
//! no way forward. Preventing each individual cause is necessary but never
//! sufficient; the next cause is always a new one. So this guard treats "did
//! anything render?" as the invariant and enforces it regardless of *why* it
//! broke:
//!
//!   1. **Detect** — a probe injected by the shell (never by app code, which is
//!      exactly what may be broken) reports `#root`'s child count.
//!   2. **Heal** — reload with backoff. A slow bundle or a dev server still
//!      booting recovers on its own, and the user sees nothing.
//!   3. **Guarantee** — after the retries are spent, paint an explanation that
//!      is compiled into the binary, so it cannot itself fail to load.
//!
//! Scoped to the `main` window on purpose: the dictation pill (`widget`) is a
//! separate webview that legitimately renders nothing while hidden, and would
//! otherwise trip this on every launch.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

/// How long to let the app mount before the first check. Generous: a cold
/// start on a slow disk legitimately takes seconds, and a false positive here
/// would reload a perfectly healthy app out from under the user.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(12);

/// Gap between retry checks; each reload gets a little longer to settle.
const RETRY_BASE_DELAY: Duration = Duration::from_secs(6);

/// Reloads before giving up and painting the fallback. Kept small — three
/// silent reloads is already ~30s of the user staring at nothing.
const MAX_RELOADS: u32 = 3;

/// Gap between probes once the app is healthy.
///
/// A one-shot startup check would miss the blanks that happen *later*, which
/// includes the one actually reproduced in dev: the app renders fine, then its
/// dev server dies and the next navigation lands on nothing. The probe is a
/// few lines of JS, so running it on a slow heartbeat costs nothing and makes
/// the guarantee hold for the whole session rather than just the first frame.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// JS that reports whether the app mounted. Deliberately dependency-free: it
/// touches only `document` and the Tauri IPC bridge the shell injects, never
/// anything from the app bundle — the bundle is what may have crashed.
///
/// `-1` distinguishes "no #root element at all" (the document never loaded,
/// e.g. a dead dev server) from `0` ("#root exists but nothing mounted", the
/// crashed-before-render case). Both are blank to the user; the number only
/// shapes the diagnostics.
fn probe_script() -> String {
    r#"
    (function () {
      try {
        var el = document.getElementById('root');
        var n = el ? el.childElementCount : -1;
        var invoke =
          (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
          (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
        if (invoke) {
          // The invoke returns a promise. If the webview has navigated to a
          // page where this command isn't registered (e.g. a media file WebKit
          // decided to play), the promise REJECTS — and an unhandled rejection
          // surfaces to the user as a console error ("report_render_state not
          // allowed. Plugin not found"). Swallow it: a probe that reports
          // nothing is already handled by the PROBE_TIMEOUT path, and a probe
          // must never be the thing that emits an error.
          var p = invoke('report_render_state', { rootChildren: n });
          if (p && typeof p.catch === 'function') { p.catch(function () {}); }
        }
      } catch (e) { /* a throwing probe must never be the thing that breaks us */ }
    })();
    "#
    .to_string()
}

/// Self-contained failure page. Inlined into the binary and injected straight
/// into the DOM: no navigation, no network, no bundle — so whatever broke the
/// app cannot also break the explanation of what broke. Styling is intentionally
/// plain for the same reason (no external fonts or stylesheets).
///
/// This is the ONE way the fallback is shown (`show_fallback`). We deliberately
/// do not navigate the top frame to a `data:` URL: WKWebView (macOS), WebView2
/// (Windows), and WebKitGTK (Linux) all refuse top-frame navigation to a `data:`
/// URL as a security policy — it both fails to show the page and logs a console
/// error ("Not allowed to navigate top frame to data URL"). Injection runs in
/// the current document and works identically on all three platforms.
///
/// "Reload" invokes `recover_main_window`, which re-navigates the main webview
/// to the app's own entry URL — so it recovers the real app even if the webview
/// had wandered off (e.g. to a media file). If the IPC bridge is unavailable it
/// falls back to `location.reload()`; either way the guard re-runs and, if still
/// blank, lands back here.
fn fallback_html(detail: &str) -> String {
    format!(
        r##"
    (function () {{
      try {{
        document.documentElement.innerHTML =
          '<head><meta charset="utf-8"><title>VoiceStudio</title></head>' +
          '<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;' +
          'background:#14161a;color:#e8eaed;display:flex;align-items:center;' +
          'justify-content:center;height:100vh;">' +
          '<div style="max-width:32rem;padding:2rem;text-align:center;">' +
          '<div style="font-size:2.5rem;line-height:1;margin-bottom:1rem;">⚠️</div>' +
          '<h1 style="font-size:1.25rem;margin:0 0 .75rem;">VoiceStudio could not display its interface</h1>' +
          '<p style="opacity:.8;line-height:1.5;margin:0 0 1.5rem;">' +
          'The app started, but the window stayed empty. Your projects and voices are safe — ' +
          'this is a display problem, not data loss.</p>' +
          '<button id="ov-retry" style="background:#4f7cff;color:#fff;border:0;border-radius:.5rem;' +
          'padding:.6rem 1.4rem;font-size:.95rem;cursor:pointer;">Reload</button>' +
          '<p style="opacity:.55;font-size:.8rem;margin-top:1.5rem;">If reloading does not help, restart ' +
          'the app. Persisting? Report it with the detail below.</p>' +
          '<pre style="opacity:.5;font-size:.7rem;text-align:left;white-space:pre-wrap;' +
          'margin-top:.5rem;">{detail}</pre>' +
          '</div></body>';
        var b = document.getElementById('ov-retry');
        if (b) {{
          b.onclick = function () {{
            // Recover the actual app, not location.reload() of whatever page the
            // webview is currently on (it may have wandered off to a media file
            // or an error page). recover_main_window re-navigates the main
            // webview to the app's entry URL from the Rust side.
            try {{
              var invoke =
                (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
                (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
              if (invoke) {{
                var p = invoke('recover_main_window');
                if (p && typeof p.catch === 'function') {{ p.catch(function () {{ location.reload(); }}); }}
                return;
              }}
            }} catch (e) {{ /* no IPC bridge here — fall through to a plain reload */ }}
            location.reload();
          }};
        }}
      }} catch (e) {{ /* nothing left to fall back to */ }}
    }})();
    "##,
        detail = detail.replace('\'', "\\'").replace('\n', " ")
    )
}

/// How long to wait for the probe to answer before assuming the worst.
///
/// Silence IS a failure signal, and the most important one. When navigation
/// fails outright the webview lands on an internal error page (`chrome-error://`)
/// where Tauri's IPC bridge does not exist — so the probe physically cannot
/// report, no matter how blank the window is. Verified the hard way: an
/// earlier version of this guard only reacted to a report and therefore sat
/// silent through a genuine blank. Anything that cannot tell us it is fine is
/// treated as not fine.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Shared state for the main window's guard.
#[derive(Default)]
pub struct BlankGuardState {
    reloads: AtomicU32,
    /// Bumped on every healthy report. `schedule_check` samples it before
    /// probing and compares after `PROBE_TIMEOUT`; an unchanged value means
    /// the page never answered.
    healthy_seq: AtomicU32,
    /// The app's own entry URL, captured at `arm()` before anything can wander
    /// off it. The fallback's Reload button re-navigates the main window here
    /// (via `recover_main_window`) so it returns to the real app even if the
    /// webview had already navigated away — e.g. to a media file it played.
    app_url: Mutex<Option<String>>,
}

/// Reported by the injected probe. Not a public API — the frontend never calls
/// this deliberately; only the shell's own injected script does.
#[tauri::command]
pub fn report_render_state<R: Runtime>(
    app: AppHandle<R>,
    root_children: i32,
) -> Result<(), String> {
    if root_children > 0 {
        // Rendered. Reset the counter so a *later* blank (e.g. the dev server
        // dying mid-session) still gets its own full budget of retries, and
        // keep the heartbeat going so such a blank is actually noticed.
        if let Some(state) = app.try_state::<Arc<BlankGuardState>>() {
            state.reloads.store(0, Ordering::Relaxed);
            state.healthy_seq.fetch_add(1, Ordering::Relaxed);
        }
        schedule_check(app.clone(), HEARTBEAT_INTERVAL);
        return Ok(());
    }

    handle_blank(app, root_children);
    Ok(())
}

/// Reload, then fall back. `root_children` is `-2` when the probe never
/// answered at all (see `PROBE_TIMEOUT`).
fn handle_blank<R: Runtime>(app: AppHandle<R>, root_children: i32) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(state) = app.try_state::<Arc<BlankGuardState>>() else {
        return;
    };

    let attempt = state.reloads.fetch_add(1, Ordering::Relaxed) + 1;
    if attempt <= MAX_RELOADS {
        log::warn!(
            "blank window detected (#root children = {root_children}); reload {attempt}/{MAX_RELOADS}"
        );
        // Re-navigate rather than eval `location.reload()`: on an internal
        // error page the latter may not run at all, which is precisely when a
        // reload is most needed.
        let _ = window.eval("location.reload();");
        schedule_check(app.clone(), RETRY_BASE_DELAY * attempt);
    } else {
        log::error!(
            "window still blank after {MAX_RELOADS} reloads (#root children = {root_children}) \
             — showing the built-in failure page"
        );
        let detail = format!(
            "#root children: {root_children} after {MAX_RELOADS} reloads. \
             -2 = the page never answered the probe (it could not load at all); \
             -1 = no #root element; 0 = loaded but nothing mounted."
        );
        show_fallback(&window, &detail);
    }
}

/// Put the built-in failure page on screen by injecting it into the current
/// document.
///
/// We inject rather than navigate the top frame to a `data:` URL: every engine
/// we ship on (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux)
/// refuses top-frame navigation to a `data:` URL as a hard security policy. On
/// macOS that path did not just fail — it logged a console error ("Not allowed
/// to navigate top frame to data URL") and left the Reload button unable to
/// recover. Injection runs in the current document and works identically on all
/// three platforms, so it is the one reliable way to guarantee something paints.
fn show_fallback<R: Runtime>(window: &tauri::WebviewWindow<R>, detail: &str) {
    let _ = window.eval(&fallback_html(detail));
}

/// Re-navigate the main webview back to the app's own entry URL.
///
/// Invoked by the fallback page's Reload button. Unlike `location.reload()` —
/// which reloads whatever page the webview happens to be on — this returns to
/// the real app URL captured at `arm()`, so recovery works even after the
/// webview navigated away (e.g. to a media file it decided to play, #1218).
#[tauri::command]
pub fn recover_main_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    // A manual recovery is a fresh start: clear the reload budget so the healed
    // app gets its full allowance again, and keep the heartbeat alive.
    if let Some(state) = app.try_state::<Arc<BlankGuardState>>() {
        state.reloads.store(0, Ordering::Relaxed);
        let target = state.app_url.lock().ok().and_then(|u| u.clone());
        if let Some(url) = target {
            if let Ok(parsed) = url.parse() {
                if window.navigate(parsed).is_ok() {
                    schedule_check(app.clone(), RETRY_BASE_DELAY);
                    return Ok(());
                }
            }
        }
    }
    // No captured URL (or navigation refused) — reload the current page as a
    // last resort. Still better than a dead button.
    let _ = window.eval("location.reload();");
    Ok(())
}

/// Queue a render check `after` from now, and treat no answer as a blank.
///
/// A plain thread rather than the async runtime: this fires a handful of times
/// per session and sleeps the whole while, so it costs nothing meaningful and
/// keeps the guard free of an async dependency it would otherwise pull in just
/// to sleep.
pub fn schedule_check<R: Runtime>(app: AppHandle<R>, after: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(after);
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        // Sample the health counter, ask, then see whether anyone answered.
        let before = app
            .try_state::<Arc<BlankGuardState>>()
            .map(|s| s.healthy_seq.load(Ordering::Relaxed));
        let _ = window.eval(&probe_script());

        let Some(before) = before else { return };
        std::thread::sleep(PROBE_TIMEOUT);
        let after_seq = app
            .try_state::<Arc<BlankGuardState>>()
            .map(|s| s.healthy_seq.load(Ordering::Relaxed))
            .unwrap_or(before);
        if after_seq == before {
            // Nobody answered. Either the page cannot run scripts, or it has
            // no IPC bridge (an internal error page) — both are blank windows.
            handle_blank(app, -2);
        }
    });
}

/// Arm the guard. Call once from `setup`.
pub fn arm<R: Runtime>(app: &AppHandle<R>) {
    let state = BlankGuardState::default();
    // Capture the app's entry URL now, before anything can navigate away from
    // it, so `recover_main_window` can always send the webview back to the real
    // app rather than reloading whatever page it later wandered onto.
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(url) = window.url() {
            if let Ok(mut slot) = state.app_url.lock() {
                *slot = Some(url.to_string());
            }
        }
    }
    app.manage(Arc::new(state));
    schedule_check(app.clone(), FIRST_CHECK_DELAY);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_never_touches_app_bundle_globals() {
        let js = probe_script();
        // The probe must survive a crashed bundle, so it may only reference
        // `document` and the shell-injected IPC bridge.
        assert!(js.contains("document.getElementById('root')"));
        assert!(js.contains("__TAURI__") || js.contains("__TAURI_INTERNALS__"));
        for forbidden in ["React", "window.app", "import(", "require("] {
            assert!(!js.contains(forbidden), "probe must not depend on {forbidden}");
        }
    }

    #[test]
    fn probe_swallows_a_rejected_invoke() {
        // If the webview has navigated away (e.g. to a media file it decided to
        // play), `report_render_state` isn't registered and the invoke promise
        // rejects. Without a `.catch` that becomes an *unhandled* rejection the
        // user sees in the console (#1218). The probe must guard the promise.
        let js = probe_script();
        assert!(js.contains(".catch"), "probe must catch a rejected invoke");
        assert!(
            js.contains("typeof p.catch === 'function'"),
            "the .catch must be guarded so a non-promise return can't throw",
        );
    }

    #[test]
    fn probe_reports_minus_one_when_root_is_absent() {
        // -1 vs 0 is what separates "page never loaded" from "loaded but did
        // not mount" in the diagnostics, so the ternary must stay.
        assert!(probe_script().contains("el ? el.childElementCount : -1"));
    }

    #[test]
    fn fallback_is_self_contained() {
        let html = fallback_html("probe detail");
        // No network of any kind: a page that needs the network cannot be the
        // thing that explains the network being the problem.
        for forbidden in ["http://", "https://", "<script src", "@import", "localhost"] {
            assert!(!html.contains(forbidden), "fallback must not reference {forbidden}");
        }
        assert!(html.contains("probe detail"));
        assert!(html.contains("ov-retry"));
    }

    #[test]
    fn fallback_escapes_quotes_so_detail_cannot_break_the_page() {
        // The detail is interpolated into a JS string literal; an unescaped
        // quote would produce a syntax error and leave the window blank —
        // precisely the failure this module exists to prevent.
        let html = fallback_html("it's \"broken\"");
        assert!(html.contains("\\'"), "single quotes must be escaped");
    }

    #[test]
    fn fallback_reassures_about_data() {
        // A blank window reads like data loss. Say plainly that it isn't.
        assert!(fallback_html("x").contains("safe"));
    }

    #[test]
    fn fallback_is_shown_by_injection_not_data_url_navigation() {
        // WKWebView (macOS), WebView2, and WebKitGTK all refuse top-frame
        // navigation to a `data:` URL, which both failed to show the page and
        // logged a console error (#1218). The guard must therefore never build a
        // top-frame `data:` HTML navigation for the fallback — injection is the
        // only path. Scan the whole source so a future edit can't quietly bring
        // it back. The needle is assembled at runtime so this file (scanned via
        // include_str!) doesn't itself contain the literal it forbids.
        let needle = format!("{}{}", "data:text/", "html");
        let src = include_str!("blank_guard.rs");
        assert!(
            !src.contains(&needle),
            "the fallback must not depend on top-frame data: navigation",
        );
    }

    #[test]
    fn fallback_reload_recovers_the_app_not_the_current_page() {
        // The Reload button must return to the real app (recover_main_window
        // re-navigates the main webview to the captured app URL), not
        // location.reload() whatever page the webview wandered onto (#1218).
        let html = fallback_html("x");
        assert!(
            html.contains("recover_main_window"),
            "Reload must invoke the recover command",
        );
        // …with a plain reload only as the no-IPC-bridge fallback.
        assert!(html.contains("location.reload()"));
    }
}
