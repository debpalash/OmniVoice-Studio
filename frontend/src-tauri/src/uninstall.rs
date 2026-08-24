//! In-app uninstall — "remove all VoiceStudio data" (#1089).
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
//! absolute path, not `/` or `$HOME`, carrying a VoiceStudio-owned component).
//! The shared Hugging Face cache is reported separately and is **opt-in** — it
//! is the standard HF cache other ML tools share, so sweeping it up silently
//! would delete models this app never downloaded.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::AppFlags;

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
/// which is VoiceStudio-owned on every platform:
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
fn uninstall_scan_blocking<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Vec<UninstallTarget> {
    let data = crate::setup::resolved_data_dir(app).unwrap_or_else(crate::setup::default_data_dir);
    let env = crate::setup::env_root(app);
    let models =
        crate::setup::resolved_models_dir(app).unwrap_or_else(crate::setup::default_models_dir);

    let mut out = vec![
        // Voices, projects, DB, generated audio, the backend's rolling log.
        target("data", data, false),
        // config.json + the managed Python env (project/.venv) — the multi-GB one.
        target("env", env, false),
    ];
    if let Some(logs) = backend_log_dir() {
        out.push(target("logs", logs, false));
    }
    // The durable per-user env file (backend/core/user_env.py). It persists the
    // model-cache location (and can hold HF_TOKEN); leaving it behind silently
    // redirected a fresh reinstall's cache to the old spot. Same path on every
    // OS (expanduser("~/.config/omnivoice/env")), so it sits under neither the
    // data nor the config dir above.
    if let Some(user_env) = user_env_dir() {
        if user_env.exists() {
            out.push(target("userenv", user_env, false));
        }
    }
    // Shared with every other huggingface_hub tool on this machine → opt-in.
    out.push(target("models", models, true));
    out
}

async fn run_scan_off_thread<T: Send + 'static>(
    scan: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(scan)
        .await
        .map_err(|error| format!("uninstall_scan_failed: {error}"))
}

#[tauri::command]
pub async fn uninstall_scan(app: tauri::AppHandle) -> Result<Vec<UninstallTarget>, String> {
    run_scan_off_thread(move || uninstall_scan_blocking(&app)).await
}

/// `~/.config/omnivoice` — the directory holding the durable per-user env file.
/// Mirrors `backend/core/user_env.py::USER_ENV_PATH`, which uses `expanduser`
/// on every platform, so this is `%USERPROFILE%\.config\omnivoice` on Windows.
fn user_env_dir() -> Option<PathBuf> {
    dirs_next::home_dir().map(|h| h.join(".config").join("omnivoice"))
}

fn purge_targets(targets: Vec<UninstallTarget>, include_models: bool) -> UninstallReport {
    let home = dirs_next::home_dir();
    let mut report = UninstallReport {
        removed: vec![],
        failed: vec![],
        freed_bytes: 0,
    };

    for t in targets {
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
    report
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct UninstallClaim(u64);

static NEXT_UNINSTALL_CLAIM: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

fn claim_uninstall(
    uninstalling: &std::sync::atomic::AtomicBool,
    owner: &std::sync::atomic::AtomicU64,
) -> Result<UninstallClaim, String> {
    uninstalling
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .map_err(|_| "uninstall_in_progress".to_string())?;
    let claim = UninstallClaim(NEXT_UNINSTALL_CLAIM.fetch_add(
        1,
        std::sync::atomic::Ordering::SeqCst,
    ));
    owner.store(claim.0, std::sync::atomic::Ordering::SeqCst);
    Ok(claim)
}

fn release_uninstall_claim(
    uninstalling: &std::sync::atomic::AtomicBool,
    owner: &std::sync::atomic::AtomicU64,
    claim: UninstallClaim,
) -> bool {
    if owner
        .compare_exchange(
            claim.0,
            0,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return false;
    }
    let _ = uninstalling.compare_exchange(
        true,
        false,
        std::sync::atomic::Ordering::SeqCst,
        std::sync::atomic::Ordering::SeqCst,
    );
    true
}

fn catch_uninstall_panic<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
        .unwrap_or_else(|_| Err("uninstall_task_panicked".to_string()))
}

async fn run_retained_uninstall_task<T: Send + 'static>(
    worker: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(worker)
        .await
        .map_err(|error| format!("uninstall_task_failed: {error}"))
}

/// Lifecycle-aware deletion core shared by the command and the real-child
/// regression harness.
#[doc(hidden)]
pub fn purge_uninstall_targets<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    targets: Vec<UninstallTarget>,
    include_models: bool,
) -> Result<UninstallReport, String> {
    crate::bootstrap::with_backend_stopped(app, || {
        // Let Windows release any final executable/DLL handles before the
        // managed environment is removed. Lifecycle ownership stays held, so
        // no launch path can recreate the child during this grace period.
        std::thread::sleep(std::time::Duration::from_millis(600));
        purge_targets(targets, include_models)
    })
}

fn finish_uninstall_attempt<T>(
    uninstalling: &std::sync::atomic::AtomicBool,
    owner: &std::sync::atomic::AtomicU64,
    claim: UninstallClaim,
    quitting: &std::sync::atomic::AtomicBool,
    result: Result<T, String>,
    recover_backend: impl FnOnce(),
    exit_app: impl FnOnce(),
) -> Result<T, String> {
    // Every completed purge is immediately followed by application exit. An
    // Ok report may include per-target failures after other targets were
    // already removed; restoring supervision then could respawn the backend
    // into a partially deleted environment. Only an Err means teardown could
    // not complete and returns control to a usable settings UI.
    if result.is_ok() {
        // The webview which invoked this command may have closed or reloaded
        // while deletion ran. Exit from the retained native task instead of
        // relying on a frontend follow-up that may never arrive.
        quitting.store(true, std::sync::atomic::Ordering::SeqCst);
        exit_app();
    } else {
        let released = release_uninstall_claim(uninstalling, owner, claim);
        // A real ExitRequested owns `quitting`; never clear it or resurrect a
        // backend while that terminal teardown is waiting on lifecycle.
        if released && !quitting.load(std::sync::atomic::Ordering::SeqCst) {
            recover_backend();
        }
    }
    result
}

fn finish_uninstall_join<T, E>(
    uninstalling: &std::sync::atomic::AtomicBool,
    owner: &std::sync::atomic::AtomicU64,
    claim: UninstallClaim,
    quitting: &std::sync::atomic::AtomicBool,
    joined: Result<Result<T, String>, E>,
    recover_backend: impl FnOnce(),
    exit_app: impl FnOnce(),
) -> Result<T, String> {
    match joined {
        // The blocking task already finalized both its success and ordinary
        // error paths, including when the invoking webview dropped its future.
        Ok(result) => result,
        Err(_) => finish_uninstall_attempt(
            uninstalling,
            owner,
            claim,
            quitting,
            Err("uninstall_task_failed".to_string()),
            recover_backend,
            exit_app,
        ),
    }
}

/// Stop the backend and delete the scanned folders. `include_models` opts into
/// the shared Hugging Face cache. The retained native task exits the app after
/// success (the Python env it runs on is gone, so there is nothing to return
/// to), even if the invoking webview has closed or reloaded.
#[tauri::command]
pub async fn uninstall_purge(
    app: tauri::AppHandle,
    include_models: bool,
) -> Result<UninstallReport, String> {
    // Suppress backend launches without claiming terminal app exit. A normal
    // CloseRequested must still preserve the main window while this native
    // task owns the destructive operation.
    let claim = {
        let flags = app.state::<AppFlags>();
        claim_uninstall(&flags.uninstalling, &flags.uninstall_owner)?
    };
    let purge_app = app.clone();
    let joined = run_retained_uninstall_task(move || {
        let result = catch_uninstall_panic(|| {
            let targets = uninstall_scan_blocking(&purge_app);
            purge_uninstall_targets(&purge_app, targets, include_models)
        });
        // Keep finalization in the blocking task: dropping the IPC future (for
        // example during a navigation) must neither strand supervision after
        // failure nor skip native exit after destructive success.
        let state = purge_app.state::<crate::bootstrap::BootstrapState>();
        let stage = state.stage.clone();
        let logs = state.logs.clone();
        let recover_app = purge_app.clone();
        let exit_app = purge_app.clone();
        let flags = purge_app.state::<AppFlags>();
        finish_uninstall_attempt(
            &flags.uninstalling,
            &flags.uninstall_owner,
            claim,
            &flags.quitting,
            result,
            move || {
                if crate::bootstrap::backend_stop_recovery_safe() {
                    crate::bootstrap::respawn_backend(recover_app, stage, logs);
                }
            },
            move || exit_app.exit(0),
        )
    })
    .await;
    if let Err(error) = &joined {
        log::error!("Uninstall task failed to join: {error}");
    }

    // A scheduler cancellation or finalizer failure never returned an in-task
    // result. Roll that path back while the command future is still alive.
    let state = app.state::<crate::bootstrap::BootstrapState>();
    let stage = state.stage.clone();
    let logs = state.logs.clone();
    let recover_app = app.clone();
    let exit_app = app.clone();
    let flags = app.state::<AppFlags>();
    finish_uninstall_join(
        &flags.uninstalling,
        &flags.uninstall_owner,
        claim,
        &flags.quitting,
        joined,
        move || {
            if crate::bootstrap::backend_stop_recovery_safe() {
                crate::bootstrap::respawn_backend(recover_app, stage, logs);
            }
        },
        move || exit_app.exit(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_uninstall_restores_backend_supervision() {
        let uninstalling = std::sync::atomic::AtomicBool::new(false);
        let owner = std::sync::atomic::AtomicU64::new(0);
        let quitting = std::sync::atomic::AtomicBool::new(false);
        let recoveries = std::cell::Cell::new(0);
        let exits = std::cell::Cell::new(0);

        let claim = claim_uninstall(&uninstalling, &owner).unwrap();
        let result: Result<(), String> = Err("backend tree is still running".into());
        assert!(finish_uninstall_attempt(
            &uninstalling,
            &owner,
            claim,
            &quitting,
            result,
            || {
                assert!(!uninstalling.load(std::sync::atomic::Ordering::SeqCst));
                recoveries.set(recoveries.get() + 1);
            },
            || exits.set(1),
        )
        .is_err());
        assert!(!uninstalling.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!quitting.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(recoveries.get(), 1, "a failed stop must re-arm the backend");
        assert_eq!(exits.get(), 0);

        let claim = claim_uninstall(&uninstalling, &owner).unwrap();
        assert!(finish_uninstall_attempt(
            &uninstalling,
            &owner,
            claim,
            &quitting,
            Ok(()),
            || recoveries.set(recoveries.get() + 1),
            || exits.set(1),
        )
        .is_ok());
        assert!(quitting.load(std::sync::atomic::Ordering::SeqCst));
        assert!(uninstalling.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(
            recoveries.get(),
            1,
            "a successful purge exits without restart"
        );
        assert_eq!(
            exits.get(),
            1,
            "native success must not depend on the webview"
        );

        quitting.store(false, std::sync::atomic::Ordering::SeqCst);
        let partial = UninstallReport {
            removed: vec!["environment".into()],
            failed: vec!["models".into()],
            freed_bytes: 1,
        };
        assert!(finish_uninstall_attempt(
            &uninstalling,
            &owner,
            claim,
            &quitting,
            Ok(partial),
            || recoveries.set(recoveries.get() + 1),
            || exits.set(2),
        )
        .is_ok());
        assert!(
            quitting.load(std::sync::atomic::Ordering::SeqCst),
            "a partial purge must still quit instead of respawning into deleted targets"
        );
        assert_eq!(recoveries.get(), 1, "a partial purge must not restart");
        assert_eq!(exits.get(), 2);
    }

    #[test]
    fn join_failure_recovers_unless_a_real_exit_already_owns_shutdown() {
        let uninstalling = std::sync::atomic::AtomicBool::new(false);
        let owner = std::sync::atomic::AtomicU64::new(0);
        let quitting = std::sync::atomic::AtomicBool::new(false);
        let recoveries = std::cell::Cell::new(0);

        let claim = claim_uninstall(&uninstalling, &owner).unwrap();
        let joined: Result<Result<(), String>, ()> = Err(());
        assert!(finish_uninstall_join(
            &uninstalling,
            &owner,
            claim,
            &quitting,
            joined,
            || recoveries.set(recoveries.get() + 1),
            || panic!("a failed task must not exit"),
        )
        .is_err());
        assert!(!uninstalling.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(recoveries.get(), 1);

        let claim = claim_uninstall(&uninstalling, &owner).unwrap();
        quitting.store(true, std::sync::atomic::Ordering::SeqCst);
        let joined: Result<Result<(), String>, ()> = Err(());
        assert!(finish_uninstall_join(
            &uninstalling,
            &owner,
            claim,
            &quitting,
            joined,
            || recoveries.set(recoveries.get() + 1),
            || panic!("a failed task must not exit"),
        )
        .is_err());
        assert!(!uninstalling.load(std::sync::atomic::Ordering::SeqCst));
        assert!(quitting.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(recoveries.get(), 1, "terminal exit must suppress recovery");
    }

    #[test]
    fn uninstall_is_single_flight_and_stale_claims_cannot_clear_a_new_owner() {
        let uninstalling = std::sync::atomic::AtomicBool::new(false);
        let owner = std::sync::atomic::AtomicU64::new(0);
        let first = claim_uninstall(&uninstalling, &owner).unwrap();
        assert_eq!(
            claim_uninstall(&uninstalling, &owner).unwrap_err(),
            "uninstall_in_progress"
        );
        assert!(release_uninstall_claim(&uninstalling, &owner, first));

        let second = claim_uninstall(&uninstalling, &owner).unwrap();
        assert!(!release_uninstall_claim(&uninstalling, &owner, first));
        assert!(uninstalling.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(owner.load(std::sync::atomic::Ordering::SeqCst), second.0);
        assert!(release_uninstall_claim(&uninstalling, &owner, second));
    }

    #[test]
    fn worker_panic_is_caught_and_finalized_as_a_recoverable_error() {
        let uninstalling = std::sync::atomic::AtomicBool::new(false);
        let owner = std::sync::atomic::AtomicU64::new(0);
        let quitting = std::sync::atomic::AtomicBool::new(false);
        let recoveries = std::cell::Cell::new(0);
        let claim = claim_uninstall(&uninstalling, &owner).unwrap();
        let result: Result<(), String> = catch_uninstall_panic(|| panic!("worker panic"));

        assert_eq!(
            finish_uninstall_attempt(
                &uninstalling,
                &owner,
                claim,
                &quitting,
                result,
                || recoveries.set(recoveries.get() + 1),
                || panic!("panic rollback must not exit"),
            ),
            Err("uninstall_task_panicked".to_string())
        );
        assert!(!uninstalling.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(recoveries.get(), 1);
    }

    #[test]
    fn dropped_uninstall_future_does_not_cancel_retained_worker() {
        let entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let release = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let finalized = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let entered2 = entered.clone();
        let release2 = release.clone();
        let finalized2 = finalized.clone();

        let task = tauri::async_runtime::spawn(run_retained_uninstall_task(move || {
            entered2.store(true, std::sync::atomic::Ordering::SeqCst);
            while !release2.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            finalized2.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !entered.load(std::sync::atomic::Ordering::SeqCst)
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(entered.load(std::sync::atomic::Ordering::SeqCst));
        task.abort();
        release.store(true, std::sync::atomic::Ordering::SeqCst);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !finalized.load(std::sync::atomic::Ordering::SeqCst)
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(finalized.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn recursive_scan_work_runs_off_the_async_caller_thread() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(run_scan_off_thread(|| {
            std::thread::current().id()
        }))
        .unwrap();
        assert_ne!(worker, caller);
    }

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
            // The durable per-user env dir — must clear the same guard as the rest.
            "/Users/someone/.config/omnivoice",
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

    #[test]
    fn user_env_dir_is_under_dot_config_and_recognizably_ours() {
        // The leftover that used to silently redirect a reinstall's model cache.
        let dir = user_env_dir().expect("home dir resolves in test env");
        assert!(dir.ends_with(".config/omnivoice"));
        assert!(is_recognizably_ours(&dir, dirs_next::home_dir().as_deref()));
    }
}
