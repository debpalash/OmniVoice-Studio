//! Tauri IPC commands: sysinfo, logs, HF cache, paste, tray, quit, dictation shortcut.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::image::Image;

use crate::{AppFlags, TrayHandle, DictationShortcutState};
use crate::{TRAY_ICON_DEFAULT, TRAY_ICON_RECORDING};
use crate::config::{load_config, save_config};

// ── System metrics ────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct SysinfoPayload {
    cpu: f64,
    ram: f64,
    total_ram: f64,
    vram: f64,
    gpu_active: bool,
}

#[tauri::command]
pub fn get_sysinfo() -> SysinfoPayload {
    use sysinfo::System;

    let mut sys = System::new();
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu = sys.global_cpu_usage() as f64;
    let ram = sys.used_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
    let total_ram = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);

    SysinfoPayload {
        cpu: (cpu * 100.0).round() / 100.0,
        ram: (ram * 100.0).round() / 100.0,
        total_ram: (total_ram * 100.0).round() / 100.0,
        vram: 0.0,
        gpu_active: false,
    }
}

// ── Log tail ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct LogTailPayload {
    lines: Vec<String>,
    path: String,
    exists: bool,
    total_lines: usize,
}

#[tauri::command]
pub fn read_log_tail(source: String, tail: Option<usize>) -> LogTailPayload {
    let tail = tail.unwrap_or(300).clamp(10, 2000);

    let path = match source.as_str() {
        "backend" => backend_runtime_log_path(),
        "tauri" => tauri_log_path(),
        _ => return LogTailPayload {
            lines: vec![],
            path: String::new(),
            exists: false,
            total_lines: 0,
        },
    };

    let path_str = path.to_string_lossy().to_string();
    if !path.exists() {
        return LogTailPayload {
            lines: vec![],
            path: path_str,
            exists: false,
            total_lines: 0,
        };
    }

    match fs::read_to_string(&path) {
        Ok(content) => {
            let all_lines: Vec<&str> = content.lines().collect();
            let total = all_lines.len();
            let start = total.saturating_sub(tail);
            let lines: Vec<String> = all_lines[start..]
                .iter()
                .map(|l| format!("{}\n", l))
                .collect();
            LogTailPayload {
                lines,
                path: path_str,
                exists: true,
                total_lines: total,
            }
        }
        Err(_) => LogTailPayload {
            lines: vec![],
            path: path_str,
            exists: true,
            total_lines: 0,
        },
    }
}

fn backend_runtime_log_path() -> PathBuf {
    let data_dir = if cfg!(target_os = "macos") {
        dirs_data_dir().join("OmniVoice")
    } else if cfg!(target_os = "windows") {
        PathBuf::from(
            std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string()),
        )
        .join("OmniVoice")
    } else {
        PathBuf::from(
            std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()),
        )
        .join(".omnivoice")
    };
    data_dir.join("omnivoice.log")
}

fn dirs_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        PathBuf::from(
            std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()),
        )
        .join("Library/Application Support")
    }
    #[cfg(not(target_os = "macos"))]
    {
        PathBuf::from(
            std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()),
        )
    }
}

fn tauri_log_path() -> PathBuf {
    let bid = "com.debpalash.omnivoice-studio";
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());

    if cfg!(target_os = "macos") {
        PathBuf::from(&home)
            .join("Library/Logs")
            .join(bid)
            .join("tauri.log")
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| home.clone());
        PathBuf::from(appdata).join(bid).join("logs").join("tauri.log")
    } else {
        PathBuf::from(&home)
            .join(".local/share")
            .join(bid)
            .join("logs")
            .join("tauri.log")
    }
}

// ── HuggingFace cache scan ────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct HfCacheRepo {
    repo_id: String,
    size_on_disk: u64,
    nb_files: usize,
}

#[derive(Serialize, Clone)]
pub struct HfCacheScanResult {
    repos: Vec<HfCacheRepo>,
    cache_dir: String,
}

#[tauri::command]
pub fn hf_cache_scan() -> HfCacheScanResult {
    let cache_dir = hf_hub_cache_dir();
    if !cache_dir.is_dir() {
        return HfCacheScanResult {
            repos: vec![],
            cache_dir: cache_dir.to_string_lossy().to_string(),
        };
    }

    let mut repos: Vec<HfCacheRepo> = Vec::new();

    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("models--") && !name.starts_with("datasets--") {
                continue;
            }
            let repo_path = entry.path();
            if !repo_path.is_dir() {
                continue;
            }

            let repo_id = name
                .strip_prefix("models--")
                .or_else(|| name.strip_prefix("datasets--"))
                .unwrap_or(&name)
                .replace("--", "/");

            let mut total_size: u64 = 0;
            let mut nb_files: usize = 0;

            for entry in walkdir::WalkDir::new(&repo_path)
                .follow_links(true)
                .into_iter()
                .flatten()
            {
                if entry.file_type().is_file() {
                    if let Ok(meta) = entry.metadata() {
                        total_size += meta.len();
                        nb_files += 1;
                    }
                }
            }

            if total_size > 0 {
                repos.push(HfCacheRepo {
                    repo_id,
                    size_on_disk: total_size,
                    nb_files,
                });
            }
        }
    }

    HfCacheScanResult {
        repos,
        cache_dir: cache_dir.to_string_lossy().to_string(),
    }
}

fn hf_hub_cache_dir() -> PathBuf {
    if let Ok(v) = std::env::var("HF_HUB_CACHE") {
        return PathBuf::from(v);
    }
    if let Ok(v) = std::env::var("HUGGINGFACE_HUB_CACHE") {
        return PathBuf::from(v);
    }
    if let Ok(v) = std::env::var("HF_HOME") {
        return PathBuf::from(v).join("hub");
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join(".cache")
        .join("huggingface")
        .join("hub")
}

// ── Simulate paste ────────────────────────────────────────────────────────

use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};

#[tauri::command]
pub fn simulate_paste(text: Option<String>) -> Result<(), String> {
    // Write the transcript to the clipboard natively first: the widget window
    // is intentionally unfocused on macOS (so the simulated ⌘V reaches the
    // target app), which makes the WebView clipboard APIs (navigator.clipboard
    // / execCommand('copy')) fail silently there (#287). `text` is optional so
    // call sites that already populated the clipboard keep working.
    if let Some(t) = text {
        let mut cb = arboard::Clipboard::new()
            .map_err(|e| format!("clipboard init failed: {e}"))?;
        cb.set_text(t)
            .map_err(|e| format!("clipboard write failed: {e}"))?;
    }

    std::thread::sleep(Duration::from_millis(80));

    let mut enigo = Enigo::new(&EnigoSettings::default())
        .map_err(|e| format!("Failed to init keyboard sim: {e}"))?;

    #[cfg(target_os = "macos")]
    {
        enigo.key(Key::Meta, Direction::Press)
            .map_err(|e| format!("key press failed: {e}"))?;
        enigo.key(Key::Unicode('v'), Direction::Click)
            .map_err(|e| format!("key click failed: {e}"))?;
        enigo.key(Key::Meta, Direction::Release)
            .map_err(|e| format!("key release failed: {e}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        enigo.key(Key::Control, Direction::Press)
            .map_err(|e| format!("key press failed: {e}"))?;
        enigo.key(Key::Unicode('v'), Direction::Click)
            .map_err(|e| format!("key click failed: {e}"))?;
        enigo.key(Key::Control, Direction::Release)
            .map_err(|e| format!("key release failed: {e}"))?;
    }

    Ok(())
}

// ── Simulate live typing ──────────────────────────────────────────────────

/// Type a string at the current cursor and/or emit N backspaces, for live
/// word-by-word dictation (text appears in the focused field as you speak).
///
/// `backspaces` are sent FIRST (to retract characters a streaming recognizer
/// revised), then `text` is typed. Either may be empty/zero, so a single call
/// can correct-then-type in one round trip.
///
/// Cross-platform: `enigo`'s `.text()` synthesizes Unicode key events on macOS
/// (CGEvent), Windows (`SendInput` w/ `KEYEVENTF_UNICODE`), and Linux (X11/
/// libei). Backspace is a plain virtual-key `Click`, identical on all three.
/// On macOS this reuses the SAME accessibility permission `simulate_paste`
/// already requires (both go through `enigo` → CGEvent); no new grant needed.
///
/// Returns `Err` if the input layer is unavailable (e.g. accessibility not
/// granted) so the JS caller can fall back to the clipboard+paste path for
/// that segment without double-inserting.
#[tauri::command]
pub fn simulate_type(text: Option<String>, backspaces: Option<u32>) -> Result<(), String> {
    let mut enigo = Enigo::new(&EnigoSettings::default())
        .map_err(|e| format!("Failed to init keyboard sim: {e}"))?;

    let n = backspaces.unwrap_or(0);
    for _ in 0..n {
        enigo
            .key(Key::Backspace, Direction::Click)
            .map_err(|e| format!("backspace failed: {e}"))?;
    }

    if let Some(t) = text {
        if !t.is_empty() {
            enigo
                .text(&t)
                .map_err(|e| format!("type failed: {e}"))?;
        }
    }

    Ok(())
}

// ── Tray icon swap ────────────────────────────────────────────────────────

#[tauri::command]
pub fn set_tray_recording(
    recording: bool,
    tray_handle: tauri::State<'_, TrayHandle>,
) -> Result<(), String> {
    let bytes = if recording { TRAY_ICON_RECORDING } else { TRAY_ICON_DEFAULT };
    let img = Image::from_bytes(bytes).map_err(|e| format!("decode tray icon: {e}"))?;
    let lock = tray_handle.tray.lock().map_err(|_| "tray lock poisoned")?;
    if let Some(ref tray) = *lock {
        tray.set_icon(Some(img)).map_err(|e| format!("set_icon: {e}"))?;
    }
    Ok(())
}

// ── Quit ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle, flags: tauri::State<'_, AppFlags>) {
    flags.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

// ── Dictation hotkey ──────────────────────────────────────────────────────

#[tauri::command]
pub fn get_dictation_shortcut(app: tauri::AppHandle) -> String {
    load_config(&app).dictation_shortcut
}

#[tauri::command]
pub fn set_dictation_shortcut(
    app: tauri::AppHandle,
    accelerator: String,
    state: tauri::State<'_, DictationShortcutState>,
) -> Result<String, String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let parsed = Shortcut::from_str(&accelerator)
        .map_err(|e| format!("Invalid shortcut '{accelerator}': {e}"))?;

    let gs = app.global_shortcut();

    let mut slot = state.current.lock().map_err(|_| "shortcut lock poisoned")?;
    let prev = slot.take();
    if let Some(ref p) = prev {
        let _ = gs.unregister(p.clone());
    }
    if let Err(e) = gs.register(parsed.clone()) {
        if let Some(p) = prev {
            if gs.register(p.clone()).is_ok() {
                *slot = Some(p);
            }
        }
        return Err(format!("Failed to register '{accelerator}': {e}"));
    }
    *slot = Some(parsed);
    drop(slot);

    let mut cfg = load_config(&app);
    cfg.dictation_shortcut = accelerator.clone();
    save_config(&app, &cfg);
    log::info!("Dictation shortcut updated to {accelerator}");
    Ok(accelerator)
}

// ── Launch-mode persistence ───────────────────────────────────────────────

#[tauri::command]
pub fn get_launch_as_widget(app: tauri::AppHandle) -> bool {
    load_config(&app).launch_as_widget
}

/// Persist the launch-mode preference. Takes effect on next app launch.
/// Caller decides whether to relaunch immediately (typical UX pattern:
/// tray-menu trigger relaunches; Settings checkbox just persists).
#[tauri::command]
pub fn set_launch_as_widget(app: tauri::AppHandle, value: bool) -> Result<bool, String> {
    let mut cfg = load_config(&app);
    cfg.launch_as_widget = value;
    save_config(&app, &cfg);
    log::info!("Launch mode updated: launch_as_widget={value}");
    Ok(value)
}

#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    // Subtitle exports (#309). The path comes from the OS save dialog in this
    // process — the user's dialog interaction *is* the authorization, which is
    // why this write lives here and not behind a loopback-HTTP query param.
    let p = std::path::Path::new(&path);
    if !p.is_absolute() {
        return Err("save path must be absolute".into());
    }
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create dir: {e}"))?;
    }
    std::fs::write(p, contents).map_err(|e| format!("write: {e}"))
}
