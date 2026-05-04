//! OmniVoice Studio — Tauri desktop shell.
//!
//! Module layout:
//!   config    – persistent app config, region helpers
//!   bootstrap – first-run venv creation, progress stages, retry commands
//!   tools     – sidecar detection, FFmpeg/ffprobe/uv resolution & install
//!   backend   – spawn backend process, port probing, log paths
//!   commands  – Tauri IPC commands (sysinfo, logs, HF cache, paste, tray, dictation)

pub mod config;
pub mod bootstrap;
pub mod tools;
pub mod backend;
pub mod commands;

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;

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

// ── Tauri entry ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── Detect pill mode from CLI args ────────────────────────────────────
    let pill_mode = std::env::args().any(|a| a == "--pill");
    if pill_mode {
        log::info!("Starting in pill (dictation-only) mode");
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
        .invoke_handler(tauri::generate_handler![
            bootstrap::bootstrap_status,
            bootstrap::get_bootstrap_logs,
            bootstrap::retry_bootstrap,
            bootstrap::clean_and_retry_bootstrap,
            config::get_region,
            config::set_region,
            commands::get_sysinfo,
            commands::read_log_tail,
            commands::hf_cache_scan,
            commands::simulate_paste,
            commands::set_tray_recording,
            commands::quit_app,
            commands::get_dictation_shortcut,
            commands::set_dictation_shortcut,
            commands::enable_pill_autostart,
            commands::disable_pill_autostart,
            commands::is_pill_autostart_enabled,
        ])
        .setup(move |app| {
            app.handle().plugin(tauri_plugin_dialog::init())?;
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            app.handle().plugin(tauri_plugin_process::init())?;
            app.handle().plugin(tauri_plugin_opener::init())?;
            app.handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())?;
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
                                        // Position pill near top-center of primary monitor
                                        if let Ok(Some(monitor)) = win.primary_monitor() {
                                            let size = monitor.size();
                                            let scale = monitor.scale_factor();
                                            let x = ((size.width as f64 / scale) / 2.0 - 150.0) as i32;
                                            let _ = win.set_position(tauri::Position::Logical(
                                                tauri::LogicalPosition::new(x as f64, 60.0),
                                            ));
                                        } else {
                                            let _ = win.center();
                                        }
                                        let _ = win.show();
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
                            }
                        }
                        "open_studio" => {
                            // Launch ourselves without --pill to open the full studio
                            if let Ok(exe) = std::env::current_exe() {
                                let _ = std::process::Command::new(exe)
                                    .spawn();
                            }
                        }
                        "dictate" => {
                            // Toggle: if the widget is visible (recording), stop;
                            // otherwise start dictation.
                            if let Some(win) = app.get_webview_window("widget") {
                                if win.is_visible().unwrap_or(false) {
                                    let _ = app.emit("tray-dictate-stop", ());
                                } else {
                                    let _ = app.emit("tray-dictate", ());
                                }
                            } else {
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
                // Pill mode: hide the main window, keep widget ready
                if let Some(main_win) = app.get_webview_window("main") {
                    let _ = main_win.hide();
                    let _ = main_win.set_skip_taskbar(true);
                }
                // On macOS, set activation policy to Accessory (no Dock icon)
                #[cfg(target_os = "macos")]
                {
                    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            } else {
                // Studio mode: widget window stays hidden but ready for the
                // global shortcut. It's already visible:false in tauri.conf.json.
            }

            // ── Enable microphone / camera on Linux (WebKitGTK) ──────────
            #[cfg(target_os = "linux")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.with_webview(|webview| {
                        use webkit2gtk::{WebViewExt, SettingsExt, PermissionRequestExt};
                        let wk = webview.inner();
                        if let Some(settings) = WebViewExt::settings(&wk) {
                            settings.set_enable_media_stream(true);
                            settings.set_enable_mediasource(true);
                            settings.set_media_playback_requires_user_gesture(false);
                            log::info!("WebKitGTK: media-stream enabled");
                        }
                        wk.connect_permission_request(|_, request| {
                            request.allow();
                            true
                        });
                    });
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
                let child = backend::spawn_backend(&app_handle, Some(&stage_handle));
                if let Ok(mut guard) = app_handle.state::<BackendState>().process.lock() {
                    *guard = child;
                }
                let start = std::time::Instant::now();
                while start.elapsed() < Duration::from_secs(300) {
                    if backend::backend_healthy(backend_port()) {
                        set_stage(&stage_handle, BootstrapStage::Ready);
                        return;
                    }
                    let process_dead = if let Ok(mut guard) = app_handle.state::<BackendState>().process.lock() {
                        match guard.as_mut() {
                            Some(child) => match child.try_wait() {
                                Ok(Some(status)) => Some(status.to_string()),
                                Ok(None) => None,
                                Err(_) => Some("unknown".to_string()),
                            },
                            None => Some("never started".to_string()),
                        }
                    } else {
                        None
                    };
                    if let Some(exit_info) = process_dead {
                        let err_tail = backend::read_error_log_tail(30);
                        let msg = if err_tail.is_empty() {
                            format!("Backend process exited ({}) — no error output captured", exit_info)
                        } else {
                            format!(
                                "Backend process exited ({}):\n{}",
                                exit_info,
                                err_tail
                            )
                        };
                        log::error!("Backend died early: {}", msg);
                        set_stage(
                            &stage_handle,
                            BootstrapStage::Failed { message: msg },
                        );
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                let err_tail = backend::read_error_log_tail(20);
                let msg = if err_tail.is_empty() {
                    "Backend did not respond within 300 s".to_string()
                } else {
                    format!(
                        "Backend did not respond within 300 s. Last stderr output:\n{}",
                        err_tail
                    )
                };
                set_stage(
                    &stage_handle,
                    BootstrapStage::Failed { message: msg },
                );
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
