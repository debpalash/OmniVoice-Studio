//! OmniVoice Studio — Tauri desktop shell.
//!
//! Module layout:
//!   config    – persistent app config, region helpers
//!   bootstrap – first-run venv creation, progress stages, retry commands
//!   tools     – sidecar detection, FFmpeg/ffprobe/uv resolution & install
//!   backend   – spawn backend process, port probing, log paths
//!   commands  – Tauri IPC commands (sysinfo, logs, HF cache, paste, tray, dictation)

pub mod config;
pub mod setup;
pub mod bootstrap;
pub mod tools;
pub mod backend;
pub mod commands;
pub mod updater_channel;

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_positioner::{Position, WindowExt};

use crate::bootstrap::{BootstrapStage, BootstrapState, set_stage};
use crate::config::{default_dictation_shortcut, load_config};

// ── Port ──────────────────────────────────────────────────────────────────

pub fn backend_port() -> u16 {
    std::env::var("OMNIVOICE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3900)
}

// ── Shared state types ────────────────────────────────────────────────────

pub struct BackendState {
    pub process: Mutex<Option<Child>>,
}

pub struct AppFlags {
    pub quitting: AtomicBool,
}

pub struct TrayHandle {
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

pub struct DictationShortcutState {
    pub current: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>>,
}

pub const TRAY_ICON_DEFAULT: &[u8] = include_bytes!("../icons/32x32.png");
pub const TRAY_ICON_RECORDING: &[u8] = include_bytes!("../icons/tray-recording.png");

// ── WebView media-capture permissions ─────────────────────────────────────
//
// `getUserMedia()` needs the WebView-engine permission answered, separately
// from the OS-level microphone permission:
//
// - Windows (WebView2): with no `PermissionRequested` handler registered,
//   WebView2 falls back to its own permission UI. The dictation pill is a
//   300×64 transparent, undecorated, always-on-top window that can't host
//   that UI (and is deliberately unfocused so the auto-paste lands in the
//   target app) — the request dies and getUserMedia() rejects with
//   NotAllowedError even though Windows already lets the app record (#323:
//   backend transcribes fine, the pill still says access denied). We answer
//   media-capture requests in code, for the app's own origin only. The OS
//   privacy toggle (Settings → Privacy & security → Microphone) still
//   applies on top.
// - Linux (WebKitGTK): media-stream must be enabled per-WebView and the
//   permission request answered programmatically.
// - macOS (WKWebView): nothing to do here — wry grants media-capture to the
//   app origin and the user-visible consent is the system TCC prompt driven
//   by NSMicrophoneUsageDescription in src-tauri/Info.plist.

/// True for origins the app itself serves: the Tauri custom-protocol origin
/// in production and the Vite dev server / loopback in `tauri dev`.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_app_origin(uri: &str) -> bool {
    let rest = match uri
        .strip_prefix("https://")
        .or_else(|| uri.strip_prefix("http://"))
    {
        Some(rest) => rest,
        None => return false,
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    host == "tauri.localhost" || host == "localhost" || host == "127.0.0.1"
}

#[allow(unused_variables)]
fn grant_webview_media_permissions(win: &tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    {
        let label = win.label().to_string();
        let _ = win.with_webview(move |webview| {
            use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
            let wk = webview.inner();
            if let Some(settings) = WebViewExt::settings(&wk) {
                settings.set_enable_media_stream(true);
                settings.set_enable_mediasource(true);
                settings.set_media_playback_requires_user_gesture(false);
                log::info!("WebKitGTK: media-stream enabled on '{label}'");
            }
            wk.connect_permission_request(|_, request| {
                request.allow();
                true
            });
        });
    }

    #[cfg(windows)]
    {
        let label = win.label().to_string();
        let _ = win.with_webview(move |webview| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2, ICoreWebView2PermissionRequestedEventArgs,
                COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION,
                COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            };
            use webview2_com::{take_pwstr, PermissionRequestedEventHandler};

            let core = match unsafe { webview.controller().CoreWebView2() } {
                Ok(core) => core,
                Err(e) => {
                    log::warn!("WebView2: CoreWebView2 unavailable on '{label}': {e}");
                    return;
                }
            };
            let handler = PermissionRequestedEventHandler::create(Box::new(
                move |_core: Option<ICoreWebView2>,
                      args: Option<ICoreWebView2PermissionRequestedEventArgs>|
                      -> windows_core::Result<()> {
                    let args = match args {
                        Some(args) => args,
                        None => return Ok(()),
                    };
                    unsafe {
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                        args.PermissionKind(&mut kind)?;
                        if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                            && kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        {
                            // Leave non-media permissions to default handling.
                            return Ok(());
                        }
                        let mut uri = windows_core::PWSTR::null();
                        args.Uri(&mut uri)?;
                        if is_app_origin(&take_pwstr(uri)) {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                        }
                    }
                    Ok(())
                },
            ));
            let mut token = 0i64;
            match unsafe { core.add_PermissionRequested(&handler, &mut token) } {
                Ok(()) => log::info!("WebView2: media-capture auto-grant active on '{label}'"),
                Err(e) => log::warn!(
                    "WebView2: PermissionRequested handler registration failed on '{label}': {e}"
                ),
            }
        });
    }

    // macOS: intentionally empty — see module comment above.
}

#[cfg(test)]
mod media_permission_tests {
    use super::is_app_origin;

    #[test]
    fn allows_app_and_dev_origins() {
        assert!(is_app_origin("http://tauri.localhost/index.html"));
        assert!(is_app_origin("https://tauri.localhost"));
        assert!(is_app_origin("http://localhost:3901/"));
        assert!(is_app_origin("http://127.0.0.1:3901/index.html"));
    }

    #[test]
    fn rejects_foreign_origins() {
        assert!(!is_app_origin("http://tauri.localhost.evil.com/"));
        assert!(!is_app_origin("https://example.com/"));
        assert!(!is_app_origin("file:///C:/index.html"));
        assert!(!is_app_origin("http://localhost.evil.com:3901/"));
        assert!(!is_app_origin(""));
    }
}

// ── Tauri entry ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── Detect pill mode from CLI args OR persisted config ────────────────
    // CLI flag takes precedence. If not passed, fall back to the
    // `launch_as_widget` config field (set via tray "Switch to Pill Mode" or
    // Settings → Launch options checkbox). This means a user can configure
    // "launch as widget by default" once and never need to remember the flag.
    let cli_pill = std::env::args().any(|a| a == "--pill");
    let pill_mode = cli_pill || crate::config::load_config_pre_app().launch_as_widget;
    if pill_mode {
        log::info!(
            "Starting in pill (dictation-only) mode (source: {})",
            if cli_pill { "--pill flag" } else { "config.launch_as_widget" }
        );
        // On macOS, hide the Dock icon in pill mode so only the tray shows.
        // This is handled after the app builds via set_activation_policy.
    }

    let pill_mode_setup = pill_mode;
    let pill_mode_tray = pill_mode;

    let app = tauri::Builder::default()
        // Single-instance MUST be registered first.
        .plugin(tauri_plugin_single_instance::init(move |app, _argv, _cwd| {
            log::info!("Second instance attempted — focusing existing window");
            let target = if pill_mode { "widget" } else { "main" };
            if let Some(win) = app.get_webview_window(target) {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_positioner::init())
        .invoke_handler(tauri::generate_handler![
            bootstrap::bootstrap_status,
            bootstrap::get_bootstrap_logs,
            bootstrap::retry_bootstrap,
            bootstrap::clean_and_retry_bootstrap,
            setup::get_setup_state,
            setup::check_install_target,
            setup::complete_setup,
            config::get_region,
            config::set_region,
            config::get_update_channel,
            config::set_update_channel,
            updater_channel::check_update,
            updater_channel::install_update,
            updater_channel::list_releases,
            commands::get_sysinfo,
            commands::read_log_tail,
            commands::hf_cache_scan,
            commands::simulate_paste,
            commands::simulate_type,
            commands::set_tray_recording,
            commands::quit_app,
            commands::save_text_file,
            commands::get_dictation_shortcut,
            commands::set_dictation_shortcut,
            commands::get_launch_as_widget,
            commands::set_launch_as_widget,
        ])
        .setup(move |app| {
            app.handle().plugin(tauri_plugin_dialog::init())?;
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            app.handle().plugin(tauri_plugin_process::init())?;
            app.handle().plugin(tauri_plugin_opener::init())?;
            // Exclude the dictation widget from state persistence — otherwise
            // `tauri-plugin-window-state` restores `visible: true` on next
            // launch if the user happened to be dictating when they quit,
            // overriding the WebviewWindowBuilder `.visible(false)` below.
            // Symptom: pill appears on app load with no shortcut press.
            // "main" is denylisted too (owner decision, 2026-07-02): the app
            // must ALWAYS open maximized — not fullscreen — per
            // tauri.conf.json (`maximized: true`, `fullscreen: false`).
            // Persisting geometry meant one manual resize made every later
            // launch reopen at that smaller size, overriding the config.
            app.handle().plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_denylist(&["widget", "main"])
                    .build(),
            )?;
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .level(log::LevelFilter::Info)
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("tauri".into()),
                        }),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    ])
                    .build(),
            )?;

            // ── Programmatic widget window creation ──────────────────────
            // Tauri 2's config-array creation silently dropped the widget
            // window (declared in tauri.conf.json with create:false to
            // make the handoff explicit). Some combination of transparent
            // + decorations:false + visible:false + always-on-top was being
            // rejected without an error. Building via WebviewWindowBuilder
            // works and surfaces real errors on failure.
            {
                use tauri::{WebviewWindowBuilder, WebviewUrl};
                let result = WebviewWindowBuilder::new(
                    app,
                    "widget",
                    WebviewUrl::App("index.html".into()),
                )
                .title("Capture")
                .inner_size(300.0, 64.0)
                .resizable(false)
                .transparent(true)
                .decorations(false)
                .always_on_top(true)
                .visible(false)
                .skip_taskbar(true)
                .center()
                .build();
                if let Err(e) = result {
                    log::error!("Failed to create widget window: {e:?}");
                }
            }

            app.manage(AppFlags {
                quitting: AtomicBool::new(false),
            });
            app.manage(TrayHandle {
                tray: Mutex::new(None),
            });
            app.manage(DictationShortcutState {
                current: Mutex::new(None),
            });

            // ── Global dictation shortcut (hold-to-talk) ─────────────────
            {
                use std::str::FromStr;
                use tauri_plugin_global_shortcut::{
                    GlobalShortcutExt, Shortcut, ShortcutState,
                };

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app_handle, _shortcut, event| {
                            match event.state {
                                ShortcutState::Pressed => {
                                    log::info!("Global shortcut pressed: dictation start");
                                    // Show the widget window (works in both pill + studio mode)
                                    if let Some(win) = app_handle.get_webview_window("widget") {
                                        // Position pill at bottom-center — WhisperFlow / Ghost-Pepper
                                        // style — via tauri-plugin-positioner. Falls back to center()
                                        // if the plugin can't resolve the monitor geometry.
                                        if win.move_window(Position::BottomCenter).is_err() {
                                            let _ = win.center();
                                        }
                                        let _ = win.show();
                                        // Don't steal focus on macOS: the simulated ⌘V from
                                        // simulate_paste() must land in the app the user is
                                        // dictating into — focusing the widget would swallow
                                        // it (#287).
                                        #[cfg(not(target_os = "macos"))]
                                        let _ = win.set_focus();
                                    }
                                    let _ = app_handle.emit("tray-dictate", ());
                                }
                                ShortcutState::Released => {
                                    log::info!("Global shortcut released: dictation stop");
                                    let _ = app_handle.emit("tray-dictate-stop", ());
                                }
                            }
                        })
                        .build(),
                )?;

                let cfg = load_config(app.handle());
                let accel = cfg.dictation_shortcut.clone();
                let parsed = Shortcut::from_str(&accel)
                    .or_else(|_| {
                        log::warn!(
                            "Saved shortcut '{accel}' unparseable — falling back to default"
                        );
                        Shortcut::from_str(&default_dictation_shortcut())
                    });
                match parsed {
                    Ok(shortcut) => match app.global_shortcut().register(shortcut.clone()) {
                        Ok(()) => {
                            log::info!("Global shortcut '{accel}' registered");
                            if let Ok(mut slot) = app
                                .state::<DictationShortcutState>()
                                .current
                                .lock()
                            {
                                *slot = Some(shortcut);
                            }
                        }
                        Err(e) => log::warn!("Failed to register global shortcut: {e}"),
                    },
                    Err(e) => log::warn!("No usable dictation shortcut: {e}"),
                }
            }

            // ── System tray ──────────────────────────────────────────────
            let tray_menu = if pill_mode_tray {
                // Pill mode: minimal tray with Open Studio + Dictate + Quit
                let dictate_i = MenuItemBuilder::new("Start Dictation  ⌘⇧Space")
                    .id("dictate")
                    .build(app)?;
                let open_studio_i = MenuItemBuilder::new("Open OmniVoice Studio")
                    .id("open_studio")
                    .build(app)?;
                let quit_i = MenuItemBuilder::new("Quit Dictation")
                    .id("quit")
                    .build(app)?;
                MenuBuilder::new(app)
                    .item(&dictate_i)
                    .separator()
                    .item(&open_studio_i)
                    .separator()
                    .item(&quit_i)
                    .build()?
            } else {
                // Studio mode: full tray
                let show_i = MenuItemBuilder::new("Show OmniVoice")
                    .id("show")
                    .build(app)?;
                let dictate_i = MenuItemBuilder::new("Start Dictation  ⌘⇧Space")
                    .id("dictate")
                    .build(app)?;
                let switch_to_pill_i = MenuItemBuilder::new("Switch to Dictation Widget")
                    .id("switch_to_pill")
                    .build(app)?;
                let settings_i = MenuItemBuilder::new("Settings")
                    .id("settings")
                    .build(app)?;
                let quit_i = MenuItemBuilder::new("Quit OmniVoice")
                    .id("quit")
                    .build(app)?;
                MenuBuilder::new(app)
                    .item(&show_i)
                    .separator()
                    .item(&dictate_i)
                    .item(&switch_to_pill_i)
                    .item(&settings_i)
                    .separator()
                    .item(&quit_i)
                    .build()?
            };


            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .tooltip(if pill_mode_tray { "OmniVoice Dictation" } else { "OmniVoice Studio" })
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                #[cfg(not(target_os = "macos"))]
                                let _ = win.set_skip_taskbar(false);
                                let _ = win.set_focus();
                                // Self-recovery: if the webview failed to load
                                // the dev/prod URL earlier (Vite restarted,
                                // backend not up yet at first show, etc.) the
                                // window shows a blank `<body></body>` with a
                                // "Could not connect to the server" console
                                // error. Reload only when the body is empty
                                // so a healthy window doesn't blink on every
                                // tray click.
                                let _ = win.eval(
                                    "if (document.body && document.body.childElementCount === 0) { location.reload(); }",
                                );
                            }
                        }
                        "open_studio" => {
                            // Persist the preference (so next launch is studio, not pill)
                            // then spawn a new instance without --pill and exit this one.
                            let mut cfg = crate::config::load_config(app);
                            cfg.launch_as_widget = false;
                            crate::config::save_config(app, &cfg);
                            if let Ok(exe) = std::env::current_exe() {
                                let _ = std::process::Command::new(exe).spawn();
                            }
                            app.state::<AppFlags>()
                                .quitting
                                .store(true, Ordering::SeqCst);
                            app.exit(0);
                        }
                        "switch_to_pill" => {
                            // Mirror of "open_studio" but the other direction:
                            // persist launch_as_widget=true, relaunch with --pill,
                            // and exit the current (studio) instance.
                            let mut cfg = crate::config::load_config(app);
                            cfg.launch_as_widget = true;
                            crate::config::save_config(app, &cfg);
                            if let Ok(exe) = std::env::current_exe() {
                                let _ = std::process::Command::new(exe)
                                    .arg("--pill")
                                    .spawn();
                            }
                            app.state::<AppFlags>()
                                .quitting
                                .store(true, Ordering::SeqCst);
                            app.exit(0);
                        }
                        "dictate" => {
                            // Toggle: if the widget is visible (recording), stop;
                            // otherwise start dictation. On start, show + position
                            // + focus the widget BEFORE emitting tray-dictate so
                            // the user sees the pill instead of silent recording.
                            // Positioning mirrors the global-shortcut handler:
                            // bottom-center (WhisperFlow style).
                            if let Some(win) = app.get_webview_window("widget") {
                                if win.is_visible().unwrap_or(false) {
                                    let _ = app.emit("tray-dictate-stop", ());
                                } else {
                                    if win.move_window(Position::BottomCenter).is_err() {
                                        let _ = win.center();
                                    }
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                    let _ = app.emit("tray-dictate", ());
                                }
                            } else {
                                log::warn!(
                                    "Tray dictate: widget window not found — \
                                     emitting tray-dictate without visible UI"
                                );
                                let _ = app.emit("tray-dictate", ());
                            }
                        }
                        "settings" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                #[cfg(not(target_os = "macos"))]
                                let _ = win.set_skip_taskbar(false);
                                let _ = win.set_focus();
                            }
                            let _ = app.emit("tray-navigate", "settings");
                        }
                        "quit" => {
                            app.state::<AppFlags>()
                                .quitting
                                .store(true, Ordering::SeqCst);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            if let Ok(mut slot) = app.state::<TrayHandle>().tray.lock() {
                *slot = Some(tray);
            }

            // ── Hide the unused window per mode ──────────────────────────
            if pill_mode_setup {
                // Pill mode: hide the main window
                if let Some(main_win) = app.get_webview_window("main") {
                    let _ = main_win.hide();
                    let _ = main_win.set_skip_taskbar(true);
                }
                // On macOS, set activation policy to Accessory (no Dock icon)
                #[cfg(target_os = "macos")]
                {
                    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
                // Pill mode: widget stays HIDDEN until activated by global
                // shortcut or tray 'Start Dictation'. Pre-position it now so
                // the first show appears at bottom-center without an
                // animation/frame flicker. Trade-off accepted vs the original
                // 'looks-launch-failed' concern: the tray icon + 'OmniVoice
                // Dictation' tooltip provide the app-running signal.
                match app.get_webview_window("widget") {
                    Some(win) => {
                        // Defensive: make sure the widget is hidden on startup
                        // regardless of what window-state restored. The denylist
                        // above should handle it, but belt-and-braces.
                        let _ = win.hide();
                        if win.move_window(Position::BottomCenter).is_err() {
                            let _ = win.center();
                        }
                        log::info!("Pill mode: widget window pre-positioned at bottom-center (hidden until activated)");
                    }
                    None => log::error!(
                        "Pill mode: widget window NOT FOUND — get_webview_window(\"widget\") \
                         returned None. Check tauri.conf.json windows[label=\"widget\"]."
                    ),
                }
            } else {
                // Studio mode: widget window stays hidden but ready for the
                // global shortcut. Belt-and-braces hide() in case any plugin
                // or stale state would otherwise show it on startup.
                if let Some(win) = app.get_webview_window("widget") {
                    let _ = win.hide();
                }
            }

            // ── WebView media-capture permissions (mic for dictation) ────
            // BOTH the main window (voice-clone recording) and the dictation
            // widget need this: the widget is a separate WebView with its own
            // permission handling. Previously only "main" was covered on
            // Linux, and Windows had no handler at all — so getUserMedia() in
            // the dictation pill rejected with NotAllowedError even when the
            // OS-level mic permission was granted (#323).
            for label in ["main", "widget"] {
                if let Some(win) = app.get_webview_window(label) {
                    grant_webview_media_permissions(&win);
                }
            }

            // ── Bootstrap ────────────────────────────────────────────────
            let bootstrap_state = BootstrapState {
                stage: Arc::new(Mutex::new(BootstrapStage::Checking)),
                logs: Arc::new(Mutex::new(Vec::new())),
            };
            let stage_handle = bootstrap_state.stage.clone();
            app.manage(bootstrap_state);
            app.manage(BackendState {
                process: Mutex::new(None),
            });

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let skip_spawn = std::env::var("TAURI_SKIP_BACKEND").is_ok();
                if skip_spawn {
                    log::info!("TAURI_SKIP_BACKEND set — not spawning");
                    set_stage(&stage_handle, BootstrapStage::Ready);
                    return;
                }
                // `--setup` re-opens the install-plan screen on demand — it
                // must win over the attach-to-healthy-backend shortcut, or a
                // running backend would skip straight past it.
                if std::env::args().any(|a| a == "--setup") {
                    log::info!("--setup flag — opening the setup screen");
                    set_stage(&stage_handle, BootstrapStage::AwaitingSetup);
                    return;
                }
                if backend::backend_healthy(backend_port()) {
                    log::info!(
                        "Port {} already serving OmniVoice backend — attaching",
                        backend_port()
                    );
                    set_stage(&stage_handle, BootstrapStage::Ready);
                    return;
                }
                if backend::port_in_use(backend_port()) {
                    log::warn!(
                        "Port {} in use — taking ownership (killing whatever's there)",
                        backend_port()
                    );
                    backend::kill_orphan_on_port(backend_port());
                    std::thread::sleep(Duration::from_millis(500));
                }
                // First-run gate: never auto-install. With nothing on disk to
                // attach to, park on the setup screen and wait for the user to
                // confirm an install plan — `complete_setup` restarts the
                // bootstrap from there. Existing pre-setup-screen installs
                // (venv present) are migrated here — the bootstrap thread is
                // the only place that write happens — then pass straight
                // through the read-only is_first_run check.
                setup::migrate_existing_install_if_needed(&app_handle);
                if setup::is_first_run(&app_handle) {
                    log::info!("First run — awaiting setup screen confirmation before installing");
                    set_stage(&stage_handle, BootstrapStage::AwaitingSetup);
                    return;
                }
                // Spawn + health-poll loop shared with the Retry button —
                // includes the #314 broken-venv self-heal (quarantine the
                // venv and rebuild once when the backend exits with
                // "No pyvenv.cfg file" / code 106).
                bootstrap::spawn_backend_and_wait(&app_handle, &stage_handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let quitting = window
                    .app_handle()
                    .state::<AppFlags>()
                    .quitting
                    .load(Ordering::SeqCst);
                if quitting {
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = window.set_skip_taskbar(true);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Ok(mut lock) = app_handle.state::<BackendState>().process.lock() {
                if let Some(ref mut child) = *lock {
                    let pid = child.id();
                    log::info!("Shutting down backend (pid {})", pid);

                    #[cfg(unix)]
                    {
                        unsafe {
                            libc::kill(pid as i32, libc::SIGTERM);
                        }
                        let start = std::time::Instant::now();
                        loop {
                            match child.try_wait() {
                                Ok(Some(_)) => break,
                                Ok(None) if start.elapsed() < Duration::from_secs(2) => {
                                    std::thread::sleep(Duration::from_millis(100));
                                }
                                _ => {
                                    log::warn!("Backend didn't exit in 2 s — SIGKILL");
                                    let _ = child.kill();
                                    break;
                                }
                            }
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        let _ = child.kill();
                    }
                    let _ = child.wait();
                }
            }
        }
    });
}
