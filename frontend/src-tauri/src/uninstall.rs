//! In-app uninstall — "remove all OmniVoice data" (#1089).
//!
//! Why this lives in the Rust shell and not the backend: the biggest thing to
//! remove is the **managed Python environment**, and the backend is *running
//! from it*. A process cannot delete its own interpreter out from under itself
//! (and on Windows the files are locked while it lives). The shell owns the
//! backend's lifetime, so it can stop it, delete everything, and exit.
//!
//! Paths come from the same single source of truth the rest of the app uses —
//! `setup::{resolved_data_dir, default_data_dir, env_root, resolved_models_dir,
//! default_models_dir}` and `backend::backend_log_path()` — so a custom or
//! portable install is cleaned correctly instead of the defaults being assumed.
//!
//! Safety: nothing is deleted that doesn't pass `is_recognizably_ours()` (an
//! absolute path, not `/` or `$HOME`, carrying an OmniVoice-owned component).
//! The shared Hugging Face cache is reported separately and is **opt-in** — it
//! is the standard HF cache other ML tools share, so sweeping it up silently
//! would delete models this app never downloaded.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{backend_port, AppFlags};

#[derive(Serialize, Clone, Debug)]
pub struct UninstallTarget {
    /// Stable id the UI keys off: "data" | "env" | "logs" | "models".
    pub key: String,
    pub path: String,
    pub size_bytes: u64,
    pub exists: bool,
    /// True for the shared Hugging Face cache — opt-in, never removed by default.
    pub shared: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct UninstallReport {
    pub removed: Vec<String>,
    pub failed: Vec<String>,
    pub freed_bytes: u64,
}

/// Recursive size of a directory. Symlinks are NOT followed: the HF cache is a
/// forest of symlinks into `blobs/`, and following them would count the same
/// bytes many times over (and could wander outside the tree entirely).
fn dir_size(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// The backend's own log directory (`backend.log` / `backend_err.log`).
/// `backend_log_path()` returns the FILE; we remove the directory it lives in,
/// which is OmniVoice-owned on every platform:
///   macOS   ~/Library/Logs/OmniVoice
///   Windows %LOCALAPPDATA%\OmniVoice\Logs
///   Linux   ~/.local/state/OmniVoice
fn backend_log_dir() -> Option<PathBuf> {
    crate::backend::backend_log_path()
        .parent()
        .map(|p| p.to_path_buf())
}

/// A last-resort guard before any `remove_dir_all`. A path only qualifies if it
/// is absolute, has a parent (never `/`), is not the home directory itself, and
/// carries a component this app actually owns. Pure — unit-tested below.
pub fn is_recognizably_ours(path: &Path, home: Option<&Path>) -> bool {
    if !path.is_absolute() || path.parent().is_none() {
        return false;
    }
    if let Some(home) = home {
        if path == home {
            return false;
        }
    }
    const OWNED: [&str; 5] = [
        "OmniVoice",
        "omnivoice",
        ".omnivoice",
        "com.debpalash.omnivoice-studio",
        "huggingface",
    ];
    path.components()
        .filter_map(|c| c.as_os_str().to_str())
        .any(|c| OWNED.iter().any(|o| c.eq_ignore_ascii_case(o)))
}

fn target(key: &str, path: PathBuf, shared: bool) -> UninstallTarget {
    let exists = path.exists();
    UninstallTarget {
        key: key.to_string(),
        size_bytes: if exists { dir_size(&path) } else { 0 },
        path: path.to_string_lossy().to_string(),
        exists,
        shared,
    }
}

/// Every folder this install owns, with sizes — what the confirmation UI shows.
/// Honors custom + portable locations via the shared resolvers.
#[tauri::command]
pub fn uninstall_scan(app: tauri::AppHandle) -> Vec<UninstallTarget> {
    let data = crate::setup::resolved_data_dir(&app).unwrap_or_else(crate::setup::default_data_dir);
    let env = crate::setup::env_root(&app);
    let models =
        crate::setup::resolved_models_dir(&app).unwrap_or_else(crate::setup::default_models_dir);

    let mut out = vec![
        // Voices, projects, DB, generated audio, the backend's rolling log.
        target("data", data, false),
        // config.json + the managed Python env (project/.venv) — the multi-GB one.
        target("env", env, false),
    ];
    if let Some(logs) = backend_log_dir() {
        out.push(target("logs", logs, false));
    }
    // Shared with every other huggingface_hub tool on this machine → opt-in.
    out.push(target("models", models, true));
    out
}

/// Stop the backend and delete the scanned folders. `include_models` opts into
/// the shared Hugging Face cache. Returns what was removed; the caller quits the
/// app afterwards (the Python env it runs on is gone, so there is nothing to
/// return to).
#[tauri::command]
pub fn uninstall_purge(
    app: tauri::AppHandle,
    include_models: bool,
    flags: tauri::State<'_, AppFlags>,
) -> Result<UninstallReport, String> {
    // Mark the app as quitting BEFORE the backend dies, so the #567 supervisor
    // treats the death as intentional and doesn't respawn a backend into the
    // very directories we are about to delete.
    flags
        .quitting
        .store(true, std::sync::atomic::Ordering::SeqCst);
    crate::bootstrap::set_backend_kill_intended(true);
    crate::backend::kill_orphan_on_port(backend_port());
    std::thread::sleep(std::time::Duration::from_millis(600));

    let home = dirs_next::home_dir();
    let mut report = UninstallReport {
        removed: vec![],
        failed: vec![],
        freed_bytes: 0,
    };

    for t in uninstall_scan(app.clone()) {
        if !t.exists {
            continue;
        }
        if t.shared && !include_models {
            continue; // the shared HF cache stays unless explicitly opted in
        }
        let path = PathBuf::from(&t.path);
        if !is_recognizably_ours(&path, home.as_deref()) {
            log::warn!("uninstall: refusing to delete unrecognized path {}", t.path);
            report.failed.push(t.path);
            continue;
        }
        match fs::remove_dir_all(&path) {
            Ok(()) => {
                log::info!("uninstall: removed {}", t.path);
                report.freed_bytes += t.size_bytes;
                report.removed.push(t.path);
            }
            Err(e) => {
                log::error!("uninstall: failed to remove {}: {}", t.path, e);
                report.failed.push(t.path);
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_root_home_and_foreign_paths() {
        let home = PathBuf::from("/Users/someone");
        // Never the filesystem root or the home dir itself.
        assert!(!is_recognizably_ours(Path::new("/"), Some(&home)));
        assert!(!is_recognizably_ours(&home, Some(&home)));
        // Never a path we don't own, even under home.
        assert!(!is_recognizably_ours(
            Path::new("/Users/someone/Documents"),
            Some(&home)
        ));
        // Never a relative path.
        assert!(!is_recognizably_ours(Path::new("relative/omnivoice"), None));
    }

    #[test]
    fn accepts_the_real_targets_on_every_platform() {
        let home = PathBuf::from("/Users/someone");
        for p in [
            "/Users/someone/Library/Application Support/OmniVoice",
            "/Users/someone/Library/Application Support/com.debpalash.omnivoice-studio",
            "/Users/someone/Library/Logs/OmniVoice",
            "/Users/someone/.omnivoice",
            "/Users/someone/.local/state/OmniVoice",
            "/Users/someone/.local/share/com.debpalash.omnivoice-studio",
            "/Users/someone/.cache/huggingface",
            "C:\\Users\\someone\\AppData\\Roaming\\OmniVoice",
        ] {
            let path = PathBuf::from(p);
            // Windows-style paths aren't absolute on unix; only assert the ones that are.
            if path.is_absolute() {
                assert!(
                    is_recognizably_ours(&path, Some(&home)),
                    "should accept {p}"
                );
            }
        }
    }
}
