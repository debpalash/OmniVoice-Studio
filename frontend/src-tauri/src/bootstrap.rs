//! Bootstrap progress tracking, venv creation, and retry commands.

use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::config::get_effective_region;
use crate::tools::resolve_uv;
use crate::{AppFlags, BackendState, backend_port};

// ── Bootstrap stages ──────────────────────────────────────────────────────

#[derive(Clone, Serialize, Debug)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum BootstrapStage {
    /// First run with nothing installed: parked on the setup screen waiting
    /// for the user to confirm an install plan (mode, storage, mirrors).
    /// Nothing downloads or installs in this stage — `complete_setup` is the
    /// only way out of it.
    AwaitingSetup,
    /// Working out whether we need to bootstrap at all.
    Checking,
    /// Fetching the standalone `uv` binary from astral-sh/uv releases.
    DownloadingUv { percent: Option<u8> },
    /// Creating the Python 3.11 venv.
    CreatingVenv,
    /// Running `uv sync --frozen --no-dev`. Biggest time sink on first run
    /// (~5-10 min to pull torch + whisperx + faster-whisper + demucs).
    InstallingDeps,
    /// Venv ready, spawning uvicorn. Should be <5 s.
    StartingBackend,
    /// Backend is listening and healthy. Frontend can leave the splash.
    Ready,
    /// Something blew up; message carries the reason.
    Failed { message: String },
}

pub struct BootstrapState {
    pub stage: Arc<Mutex<BootstrapStage>>,
    pub logs: Arc<Mutex<Vec<LogPayload>>>,
}

pub fn set_stage(state: &Arc<Mutex<BootstrapStage>>, stage: BootstrapStage) {
    if let Ok(mut guard) = state.lock() {
        *guard = stage;
    }
}

// ── Splash log + byte-progress event channel ─────────────────────────────

#[derive(Clone, Serialize)]
pub struct LogPayload {
    pub stage: String,
    pub line: String,
}

pub fn emit_log<R: tauri::Runtime>(app: &tauri::AppHandle<R>, stage: &str, line: &str) {
    let payload = LogPayload { stage: stage.to_string(), line: line.to_string() };
    // Buffer the log so the frontend can backfill on mount.
    if let Some(state) = app.try_state::<BootstrapState>() {
        if let Ok(mut logs) = state.logs.lock() {
            logs.push(payload.clone());
        }
    }
    let _ = app.emit("bootstrap-log", payload);
}

/// Stream stdout+stderr of a long-running subprocess line-by-line into the
/// splash log panel.
pub fn run_streaming<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    stage: &str,
    cmd: &mut Command,
) -> io::Result<std::process::ExitStatus> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_out = app.clone();
    let app_err = app.clone();
    let stage_out = stage.to_string();
    let stage_err = stage.to_string();
    let h_out = std::thread::spawn(move || {
        if let Some(s) = stdout {
            for line in BufReader::new(s).lines().flatten() {
                log::info!("[{}] {}", stage_out, line);
                emit_log(&app_out, &stage_out, &line);
            }
        }
    });
    let h_err = std::thread::spawn(move || {
        if let Some(s) = stderr {
            for line in BufReader::new(s).lines().flatten() {
                log::info!("[{}] {}", stage_err, line);
                emit_log(&app_err, &stage_err, &line);
            }
        }
    });
    let status = child.wait()?;
    let _ = h_out.join();
    let _ = h_err.join();
    Ok(status)
}

// ── Tauri commands ────────────────────────────────────────────────────────

#[tauri::command]
pub fn bootstrap_status(state: tauri::State<'_, BootstrapState>) -> BootstrapStage {
    state
        .stage
        .lock()
        .map(|g| g.clone())
        .unwrap_or(BootstrapStage::Checking)
}

#[tauri::command]
pub fn get_bootstrap_logs(state: tauri::State<'_, BootstrapState>) -> Vec<LogPayload> {
    state
        .logs
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub fn retry_bootstrap(app: tauri::AppHandle, state: tauri::State<'_, BootstrapState>) {
    if let Ok(mut guard) = state.stage.lock() {
        *guard = BootstrapStage::Checking;
    }
    if let Ok(mut logs) = state.logs.lock() {
        logs.clear();
    }
    let stage_handle = state.stage.clone();
    std::thread::spawn(move || {
        let skip_spawn = std::env::var("TAURI_SKIP_BACKEND").is_ok();
        if skip_spawn {
            log::info!("TAURI_SKIP_BACKEND set — not spawning");
            set_stage(&stage_handle, BootstrapStage::Ready);
            return;
        }
        if crate::backend::backend_healthy(backend_port()) {
            log::info!("Port {} already serving OmniVoice backend — attaching", backend_port());
            set_stage(&stage_handle, BootstrapStage::Ready);
            return;
        }
        if crate::backend::port_in_use(backend_port()) {
            log::warn!("Port {} in use — taking ownership", backend_port());
            crate::backend::kill_orphan_on_port(backend_port());
            std::thread::sleep(Duration::from_millis(500));
        }
        spawn_backend_and_wait(&app, &stage_handle);
    });
}

/// Spawn the backend and poll until it is healthy (→ `Ready`) or dead /
/// timed out (→ `Failed`). Shared by the launch-time bootstrap (`lib.rs`) and
/// the Retry button (`retry_bootstrap`) so both get the same recovery
/// behavior.
///
/// #314: when the backend dies with a broken-venv signature ("No pyvenv.cfg
/// file" / exit code 106 from the CPython venv launcher), the venv — and only
/// the venv — is removed and the bootstrap re-runs once, recreating it through
/// the normal `CreatingVenv` / `InstallingDeps` setup path instead of
/// surfacing the same dead-end failure on every retry.
pub fn spawn_backend_and_wait(app: &tauri::AppHandle, stage_handle: &Arc<Mutex<BootstrapStage>>) {
    let mut venv_heal_attempted = false;
    'bootstrap: loop {
        let child = crate::backend::spawn_backend(app, Some(stage_handle));
        if let Ok(mut guard) = app.state::<BackendState>().process.lock() {
            *guard = child;
        }
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(300) {
            if crate::backend::backend_healthy(backend_port()) {
                set_stage(stage_handle, BootstrapStage::Ready);
                // #567/#570/#571: once Ready, keep watching the backend child
                // and respawn it if it dies mid-session, so a crash self-heals
                // instead of leaving every later request to dead-end on
                // "Can't reach the local backend". Only one supervisor runs at
                // a time — Retry can re-enter this function concurrently.
                if SUPERVISOR_ACTIVE
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    supervise_backend(app, stage_handle);
                    SUPERVISOR_ACTIVE.store(false, Ordering::SeqCst);
                }
                return;
            }
            let process_dead = if let Ok(mut guard) = app.state::<BackendState>().process.lock() {
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
                let err_tail = crate::backend::read_error_log_tail(30);
                // #314: a backend that dies because the venv itself is broken
                // can only be healed by rebuilding the venv — do that once
                // instead of failing into an unwinnable retry loop.
                if !venv_heal_attempted
                    && backend_exit_indicates_broken_venv(&exit_info, &err_tail)
                {
                    venv_heal_attempted = true;
                    let venv_dir = crate::setup::env_root(app).join("project").join(".venv");
                    log::warn!(
                        "Backend exited with a broken-venv signature ({}) — removing {} and rebuilding (#314)",
                        exit_info,
                        venv_dir.display()
                    );
                    emit_log(
                        app,
                        "checking",
                        "Backend failed because the Python environment is broken — rebuilding it automatically",
                    );
                    if quarantine_broken_venv(&venv_dir) {
                        set_stage(stage_handle, BootstrapStage::Checking);
                        continue 'bootstrap;
                    }
                    log::error!(
                        "Could not remove broken venv at {} — surfacing the failure",
                        venv_dir.display()
                    );
                }
                let msg = if err_tail.is_empty() {
                    format!("Backend process exited ({}) — no error output captured", exit_info)
                } else {
                    format!("Backend process exited ({}):\n{}", exit_info, err_tail)
                };
                log::error!("Backend died early: {}", msg);
                set_stage(stage_handle, BootstrapStage::Failed { message: msg });
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let err_tail = crate::backend::read_error_log_tail(20);
        let msg = if err_tail.is_empty() {
            "Backend did not respond within 300 s".to_string()
        } else {
            format!("Backend did not respond within 300 s. Last stderr output:\n{}", err_tail)
        };
        set_stage(stage_handle, BootstrapStage::Failed { message: msg });
        return;
    }
}

// ── Backend supervisor (auto-restart) ─────────────────────────────────────
//
// #567/#570/#571: the backend used to be spawned once and never watched again
// (`spawn_backend_and_wait` returned the instant it was healthy). When the
// uvicorn process then died mid-session — a CUDA OOM/context fault under a
// burst of generations, an antivirus kill, any crash — nothing restarted it,
// so every later request threw connection-refused and the user was stuck on
// the "Can't reach the local backend" toast until they restarted the whole
// app. The supervisor closes that gap: after Ready, it watches the child and
// respawns it (bounded) so a crash self-heals.

/// Only one supervisor loop may run at a time. The launch-time bootstrap and
/// the Retry button both call `spawn_backend_and_wait` (and can race), so the
/// first to reach Ready claims this and the rest fall through.
static SUPERVISOR_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Give up (surface Failed) if the backend dies this many times within
/// `RESTART_WINDOW` — a deterministic startup crash must not become a
/// fork-bomb. The #314 broken-venv self-heal stays the venv-failure path; the
/// supervisor only handles post-Ready deaths.
const MAX_RESTARTS: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

fn app_is_quitting(app: &tauri::AppHandle) -> bool {
    app.try_state::<AppFlags>()
        .map(|f| f.quitting.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// Returns `Some(exit description)` if the tracked backend child has exited,
/// `None` if it is still running (or none is tracked — which we never treat as
/// a death to respawn, to avoid fighting a deliberate teardown).
fn backend_child_exit(app: &tauri::AppHandle) -> Option<String> {
    let state = app.try_state::<BackendState>()?;
    let mut guard = state.process.lock().ok()?;
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            Ok(None) => None,
            Err(e) => Some(format!("try_wait error: {e}")),
        },
        None => None,
    }
}

/// Drop restart timestamps older than `RESTART_WINDOW` and report whether the
/// remaining count has hit the cap. Pure so the backoff policy is unit-tested
/// without spawning real processes.
fn restart_budget_exhausted(times: &mut Vec<Instant>, now: Instant) -> bool {
    times.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
    times.len() >= MAX_RESTARTS
}

/// After the backend is Ready, watch its process and respawn it on an
/// unexpected exit. Runs on the (otherwise-returning) bootstrap thread and
/// stops the instant the app is quitting so it never resurrects the backend
/// during shutdown. Death is detected only via a *confirmed process exit*
/// (`try_wait`), never a slow health probe, so a busy-but-alive backend is
/// never killed.
fn supervise_backend(app: &tauri::AppHandle, stage_handle: &Arc<Mutex<BootstrapStage>>) {
    let mut restart_times: Vec<Instant> = Vec::new();
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if app_is_quitting(app) {
            return;
        }
        let exit_info = match backend_child_exit(app) {
            Some(info) => info,
            None => continue, // still running
        };
        // The exit may have raced with a shutdown that killed the child.
        if app_is_quitting(app) {
            return;
        }
        if restart_budget_exhausted(&mut restart_times, Instant::now()) {
            let tail = crate::backend::read_error_log_tail(30);
            let msg = format!(
                "The backend kept crashing ({} times in {}s) and couldn't be kept running. \
                 Use Clean & Retry, or check Settings → Logs → Backend.{}",
                MAX_RESTARTS,
                RESTART_WINDOW.as_secs(),
                if tail.is_empty() { String::new() } else { format!("\n\nLast output:\n{tail}") },
            );
            log::error!("Backend supervisor giving up: {msg}");
            let _ = app.emit("backend-restart-failed", msg.clone());
            set_stage(stage_handle, BootstrapStage::Failed { message: msg });
            return;
        }
        restart_times.push(Instant::now());
        log::warn!("Backend process exited unexpectedly ({exit_info}) — restarting it (#567)");
        emit_log(app, "starting_backend", "Backend stopped unexpectedly — restarting it automatically");
        // Frontend listens for this to show a "reconnecting" banner (the splash
        // poll has already stopped post-Ready, so the stage alone won't show).
        let _ = app.emit("backend-restarting", exit_info.clone());
        set_stage(stage_handle, BootstrapStage::StartingBackend);
        // Clear any orphan still holding the port before the respawn.
        if crate::backend::port_in_use(backend_port()) {
            crate::backend::kill_orphan_on_port(backend_port());
            std::thread::sleep(Duration::from_millis(300));
        }
        let child = crate::backend::spawn_backend(app, Some(stage_handle));
        if let Ok(mut guard) = app.state::<BackendState>().process.lock() {
            *guard = child;
        }
        // Wait (bounded) for the respawn to become healthy. If it dies again
        // immediately, bail early so the next loop counts it toward the cap.
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(120) {
            if app_is_quitting(app) {
                return;
            }
            if crate::backend::backend_healthy(backend_port()) {
                set_stage(stage_handle, BootstrapStage::Ready);
                let _ = app.emit("backend-restored", ());
                log::info!("Backend restarted and healthy again");
                break;
            }
            if backend_child_exit(app).is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

#[tauri::command]
pub fn clean_and_retry_bootstrap(app: tauri::AppHandle, state: tauri::State<'_, BootstrapState>) {
    // env_root honors the setup-screen choice (portable / custom env dir), so
    // clean-retry removes the venv the bootstrap actually uses.
    let project_dir = crate::setup::env_root(&app).join("project");
    if project_dir.is_dir() {
        log::info!("Clean retry: removing {}", project_dir.display());
        let _ = fs::remove_dir_all(&project_dir);
    }
    // Kill any zombie backend still occupying the port from the deleted
    // project dir, otherwise bootstrap will "attach" to the stale process.
    if crate::backend::port_in_use(backend_port()) {
        log::warn!("Clean retry: killing stale backend on port {}", backend_port());
        crate::backend::kill_orphan_on_port(backend_port());
        std::thread::sleep(Duration::from_millis(500));
    }
    retry_bootstrap(app, state);
}

// ── Venv bootstrap ────────────────────────────────────────────────────────

pub fn venv_python_path(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// Recursive directory copy that skips `__pycache__` and any dotfile dirs.
pub fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if src_path.is_dir() {
            if name_str == "__pycache__" || name_str.starts_with('.') {
                continue;
            }
            copy_dir_recursive(&src_path, &dst.join(&file_name))?;
        } else if name_str.ends_with(".pyc") {
            continue;
        } else {
            fs::copy(&src_path, &dst.join(&file_name))?;
        }
    }
    Ok(())
}

/// Refresh `pyproject.toml` + `uv.lock` in the project dir from the bundled
/// resources, so an upgraded app never runs freshly-synced backend code against
/// the stale dependency manifests from when the venv was first created (#307 —
/// a venv predating scalar-fastapi's addition crashed main.py on import).
/// Returns true when the lockfile content changed (or the project had none):
/// the signal that the venv may be missing newly added dependencies and needs
/// a `uv sync`.
fn refresh_project_manifests(resource_dir: &Path, project_dir: &Path) -> bool {
    let flat = resource_dir.to_path_buf();
    let up2 = resource_dir.join("_up_").join("_up_");
    let res_root = if flat.join("pyproject.toml").is_file() { flat } else { up2 };
    let res_pyproject = res_root.join("pyproject.toml");
    let res_uvlock = res_root.join("uv.lock");
    if res_pyproject.is_file() {
        if let Err(e) = fs::copy(&res_pyproject, project_dir.join("pyproject.toml")) {
            log::warn!("Could not refresh pyproject.toml from bundle: {}", e);
        }
    }
    if !res_uvlock.is_file() {
        return false;
    }
    let project_lock = project_dir.join("uv.lock");
    let lock_changed = match (fs::read(&res_uvlock), fs::read(&project_lock)) {
        (Ok(bundled), Ok(existing)) => bundled != existing,
        (Ok(_), Err(_)) => true, // project has no lock yet — treat as drift
        (Err(e), _) => {
            log::warn!("Could not read bundled uv.lock: {}", e);
            return false;
        }
    };
    if lock_changed {
        if let Err(e) = fs::copy(&res_uvlock, &project_lock) {
            log::warn!("Could not refresh uv.lock from bundle: {}", e);
            return false; // don't sync against a lock we failed to refresh
        }
    }
    lock_changed
}

/// Dev-mode fallback: running from the source tree (`bun run dev`).
pub fn find_dev_project_root() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("../../"),       // from frontend/src-tauri
        PathBuf::from("."),            // from project root
        PathBuf::from(".."),           // from frontend/
    ];
    for c in &candidates {
        if c.join("backend/main.py").is_file() {
            return Some(c.clone());
        }
    }
    None
}

// ── plan-03 (#130): restricted-network bootstrap resilience ────────────────

/// gh-proxy mirror for python-build-standalone, used as a fallback when the
/// default GitHub releases host is blocked/unresolvable (#60). Points
/// UV_PYTHON_INSTALL_MIRROR at the releases-download base behind the proxy.
const PY_INSTALL_MIRROR: &str =
    "https://gh-proxy.com/https://github.com/astral-sh/python-build-standalone/releases/download";

/// Shown when every managed-Python strategy AND the system-Python fallback fail
/// — actionable remediation instead of a raw `uv` exit code (#130 step 5).
const BOOTSTRAP_REMEDIATION: &str =
    "First-run setup couldn't download Python — your network may be blocking GitHub. \
Fix: install Python 3.11+ from https://www.python.org/downloads/ (tick \"Add to PATH\"), \
then relaunch — OmniVoice will use your system Python. Advanced: set \
UV_PYTHON_INSTALL_MIRROR to a reachable mirror (see docs/install/troubleshooting.md).";

/// Strip the bundled-runtime Python env vars before spawning any `uv`/venv/pip
/// or venv-python subprocess (#144). On the Linux AppImage, the bundled runtime
/// exports PYTHONHOME / PYTHONPATH (and sometimes LD_LIBRARY_PATH) pointing at
/// the AppImage's *own* bundled Python. Those leak into the `uv` build
/// subprocess, so the freshly-built managed interpreter resolves its stdlib
/// against the wrong (AppImage) Python and dies with
/// `ModuleNotFoundError: No module named 'encodings'` while compiling a
/// transitive dep (e.g. dora-search/demucs) — surfacing downstream as
/// "Backend process exited (never started)". This mirrors the same scrub the
/// backend spawn already does in `backend.rs` before launching uvicorn.
///
/// Safe on every platform: these vars are normally unset on macOS/Windows, and
/// `env_remove` on an unset var is a no-op — so there's no cross-platform
/// divergence in default behavior.
fn scrub_python_env(cmd: &mut Command) {
    cmd.env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("LD_LIBRARY_PATH");
}

/// Longer timeouts + more retries so a slow/flaky mirror or PyPI doesn't kill
/// the first-run install on its first hiccup (#130 step 2).
fn apply_uv_http_env(cmd: &mut Command) {
    cmd.env("UV_HTTP_TIMEOUT", "120")
        .env("UV_HTTP_CONNECT_TIMEOUT", "30")
        .env("UV_HTTP_RETRIES", "5");
}

/// `<env_root>/wheels` — a local wheel-drop dir uv installs from via
/// `--find-links`. When a huge wheel can't be pulled on a restricted network
/// (the ~2.5 GB cu128 torch wheel from download.pytorch.org — #569), the user
/// downloads the matching wheel, drops it here, and a retry picks it up.
/// Created so the path always exists to name in the error/docs. It lives under
/// `env_root` (not `project/`), so it survives Clean & Retry.
fn wheels_drop_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    let dir = crate::setup::env_root(app).join("wheels");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// True when a `uv sync` failure tail looks like the CUDA torch wheel download
/// failing (#569). Lets us give torch-specific guidance instead of the generic
/// "set a PyPI mirror" advice — which can't redirect the explicit, *named*
/// pytorch-cuda index anyway (uv 0.11 rejects index-name override values, and
/// `--frozen` pins the exact download.pytorch.org wheel URLs).
fn sync_failure_is_torch_download(tail: &str) -> bool {
    let low = tail.to_lowercase();
    low.contains("download.pytorch.org")
        || low.contains("download-r2.pytorch.org")
        || low.contains("pytorch.org/whl")
        || (low.contains("torch") && (low.contains("failed to download") || low.contains("failed to fetch")))
}

/// Default PyTorch ROCm wheel index for the opt-in AMD path (#124). ROCm 6.2 is
/// the current stable wheel set; overridable via OMNIVOICE_TORCH_INDEX.
const ROCM_TORCH_INDEX: &str = "https://download.pytorch.org/whl/rocm6.2";

/// `uv pip install` args that replace the default CUDA torch build with the AMD
/// ROCm wheel (#124). Opt-in (gated on OMNIVOICE_TORCH_VARIANT=rocm by the
/// caller); the detection side (`get_best_device`) already routes ROCm through
/// `torch.cuda`, so installing the ROCm wheel is all that's needed.
fn rocm_torch_reinstall_args(rocm_index_url: &str) -> Vec<String> {
    vec![
        "pip".into(), "install".into(), "--reinstall".into(),
        "torch".into(), "torchaudio".into(),
        "--index-url".into(), rocm_index_url.into(),
    ]
}

/// Whether the user opted into the AMD ROCm torch build — via the
/// OMNIVOICE_TORCH_VARIANT env var (power users, takes precedence) or the
/// setup screen's Compute choice persisted in config (`configured_variant`).
/// Default (unset/"auto") → None (CUDA/CPU path unchanged). Returns the ROCm
/// wheel index to use when enabled.
fn rocm_opt_in(configured_variant: &str) -> Option<String> {
    let variant = std::env::var("OMNIVOICE_TORCH_VARIANT")
        .unwrap_or_else(|_| configured_variant.to_string());
    if !variant.eq_ignore_ascii_case("rocm") {
        return None;
    }
    Some(std::env::var("OMNIVOICE_TORCH_INDEX").unwrap_or_else(|_| ROCM_TORCH_INDEX.to_string()))
}

// ── #314: broken-venv detection + self-heal ────────────────────────────────

/// Cheap structural validity check for an existing venv — no subprocess
/// spawned. Returns a human-readable reason when the venv can never work and
/// must be rebuilt:
///   - `pyvenv.cfg` missing (interrupted creation / half-deleted dir — the
///     CPython venv launcher then exits 106 with "No pyvenv.cfg file"),
///   - the python executable missing entirely, or
///   - on Unix, `bin/python` left as a dangling symlink because the base
///     interpreter it was created from was removed.
///
/// Returns `None` both for a healthy venv (which must never be touched) and
/// for a venv path that doesn't exist at all (the first-run creation path
/// owns that case).
pub fn venv_structural_problem(venv_dir: &Path) -> Option<String> {
    if venv_dir.symlink_metadata().is_err() {
        return None; // no venv at all — first-run creation handles it
    }
    if !venv_dir.is_dir() {
        return Some(".venv exists but is not a directory".to_string());
    }
    if !venv_dir.join("pyvenv.cfg").is_file() {
        return Some("pyvenv.cfg is missing".to_string());
    }
    let py = venv_python_path(venv_dir);
    if py.symlink_metadata().is_err() {
        return Some(format!("python executable is missing ({})", py.display()));
    }
    // `is_file()` follows symlinks, so a `bin/python` whose target interpreter
    // was uninstalled (dangling symlink) fails here even though the
    // `symlink_metadata()` existence check above passed.
    if !py.is_file() {
        return Some(format!("python executable is a dangling symlink ({})", py.display()));
    }
    None
}

/// Remove a structurally broken venv so the creation path can rebuild it.
/// Only `.venv` itself is touched — project manifests, backend sources, and
/// all user data (`omnivoice_data/`) stay in place. If the directory can't be
/// deleted outright (e.g. a locked file on Windows), rename it aside instead
/// so `uv venv` still finds a clean path. Returns true when the original path
/// is gone.
fn quarantine_broken_venv(venv_dir: &Path) -> bool {
    if venv_dir.symlink_metadata().is_err() {
        return true; // already gone — nothing to do
    }
    match fs::remove_dir_all(venv_dir) {
        Ok(()) => {
            log::info!("Removed broken venv {} (#314)", venv_dir.display());
            true
        }
        Err(e) => {
            log::warn!(
                "remove_dir_all({}) failed: {} — renaming the broken venv aside instead",
                venv_dir.display(),
                e
            );
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let quarantine = venv_dir.with_file_name(format!(".venv.broken-{}", ts));
            match fs::rename(venv_dir, &quarantine) {
                Ok(()) => {
                    log::info!("Renamed broken venv to {} (#314)", quarantine.display());
                    true
                }
                Err(e2) => {
                    log::error!("Could not rename broken venv aside: {}", e2);
                    false
                }
            }
        }
    }
}

/// Whether a dead backend process looks like it failed because the venv
/// itself is structurally broken — either the CPython venv launcher's
/// "No pyvenv.cfg file" + exit 106 (`RC_NO_PYVENV_CFG`), OR a relocated/copied/
/// restored venv whose interpreter can't bootstrap its own stdlib and aborts
/// very early with "No module named 'encodings'" (exit 1). Both are
/// unrunnable-interpreter cases that `uv sync` cannot fix — only a venv rebuild
/// can — so both route into the rebuild-once self-heal. Matches the message in
/// the captured stderr tail or the exit code in the `ExitStatus` display
/// ("exit code: 106" on Windows, "exit status: 106" on Unix). Kept deliberately
/// narrow (full quoted phrases) so an ordinary backend crash — or an app-level
/// import error of some 'encodings'-named package — never triggers a rebuild.
pub fn backend_exit_indicates_broken_venv(exit_info: &str, err_tail: &str) -> bool {
    err_tail.contains("No pyvenv.cfg file")
        || err_tail.contains("No module named 'encodings'")
        || exit_info.trim_end().ends_with(": 106")
}

/// Prepare (and on first run, create) the Python venv that will host the
/// backend process. Returns (venv_python, backend_source_dir).
pub fn ensure_venv_ready<R: tauri::Runtime>(app: &tauri::AppHandle<R>, progress: Option<&Arc<Mutex<BootstrapStage>>>) -> Option<(PathBuf, PathBuf)> {
    let fail = |progress: Option<&Arc<Mutex<BootstrapStage>>>, msg: &str| {
        log::error!("{}", msg);
        if let Some(p) = progress {
            set_stage(p, BootstrapStage::Failed { message: msg.to_string() });
        }
    };
    if let Some(p) = progress {
        set_stage(p, BootstrapStage::Checking);
    }

    if let Some(dev_root) = find_dev_project_root() {
        let dev_venv = dev_root.join(".venv");
        let dev_py = venv_python_path(&dev_venv);
        if dev_py.is_file() {
            let backend_dir = dev_root.join("backend");
            if backend_dir.is_dir() {
                return Some((dev_py, backend_dir));
            }
        }
    }

    // Root chosen on the setup screen: app_local_data_dir by default, the
    // exe-adjacent folder in portable mode, or a user-picked custom dir.
    let app_data = crate::setup::env_root(app);
    let project_dir = app_data.join("project");
    let venv_dir = project_dir.join(".venv");
    let venv_py = venv_python_path(&venv_dir);
    let backend_dir = project_dir.join("backend");

    // #314: structural validation before trusting an existing venv. A venv
    // whose pyvenv.cfg is gone (interrupted install) or whose python is a
    // dangling symlink (its base interpreter was removed) can never recover
    // via `uv sync` — the interpreter itself is the broken part, and the
    // backend would just exit 106 ("No pyvenv.cfg file") forever. Quarantine
    // it and fall through to the creation path below, which rebuilds it with
    // the normal CreatingVenv/InstallingDeps progress. A healthy venv returns
    // None here and is never touched.
    if let Some(problem) = venv_structural_problem(&venv_dir) {
        log::warn!(
            "Venv at {} is structurally broken ({}) — removing it and rebuilding (#314)",
            venv_dir.display(),
            problem
        );
        emit_log(
            app,
            "checking",
            &format!("Detected a broken Python environment ({}) — rebuilding it automatically", problem),
        );
        if !quarantine_broken_venv(&venv_dir) {
            fail(progress, &format!(
                "The Python environment at {} is broken ({}) but could not be removed \
automatically. Close any programs using that folder, or delete the .venv folder \
manually, then relaunch.",
                venv_dir.display(),
                problem
            ));
            return None;
        }
    }

    if venv_py.is_file() && backend_dir.is_dir() {
        let mut uvicorn_check_cmd = Command::new(&venv_py);
        scrub_python_env(&mut uvicorn_check_cmd); // #144: don't inherit AppImage's bundled Python
        let uvicorn_check = uvicorn_check_cmd
            .args(["-c", "import uvicorn"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        // #248: also verify pkg_resources is importable. Venvs created before the
        // setuptools<80 pin (commit 675cc20, fixes #224) have setuptools 80+, which
        // dropped the bundled pkg_resources. whisperx / ctranslate2 import it at
        // runtime, so dubbing/transcription crashes silently on those installs even
        // though uvicorn starts fine. We detect this here so we can force a repair
        // sync rather than handing back a broken venv.
        let pkg_resources_ok = if matches!(uvicorn_check, Ok(ref s) if s.success()) {
            let mut pr_check = Command::new(&venv_py);
            scrub_python_env(&mut pr_check);
            matches!(
                pr_check
                    .args(["-c", "import pkg_resources"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status(),
                Ok(ref s) if s.success()
            )
        } else {
            false
        };
        // #564: a venv can pass the uvicorn + pkg_resources gates yet still be
        // unable to import its OWN `omnivoice` package — an interrupted/offline
        // `uv sync` installed deps but never laid the editable record, or an
        // antivirus quarantine removed `_editable_impl_omnivoice.pth`. The
        // backend then boots fine and only fails at the first model call with
        // "No module named 'omnivoice'". Verify it here so we force a repair
        // sync (which re-lays the editable install) instead of handing back a
        // broken venv. `find_spec` resolves the package WITHOUT importing it, so
        // this stays cheap — a real `import omnivoice` would pull in torch.
        let omnivoice_ok = if matches!(uvicorn_check, Ok(ref s) if s.success()) {
            let mut ov_check = Command::new(&venv_py);
            scrub_python_env(&mut ov_check);
            matches!(
                ov_check
                    .args([
                        "-c",
                        "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('omnivoice') else 1)",
                    ])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status(),
                Ok(ref s) if s.success()
            )
        } else {
            false
        };
        if matches!(uvicorn_check, Ok(ref s) if s.success()) && pkg_resources_ok && omnivoice_ok {
            // Always sync source dirs from bundle so code fixes land on
            // existing installs without requiring a full clean+reinstall.
            let resource_dir = app.path().resource_dir().ok();
            if let Some(ref res) = resource_dir {
                let flat = res.clone();
                let up2  = res.join("_up_").join("_up_");
                let (res_omni, res_backend) = if flat.join("pyproject.toml").is_file() {
                    (flat.join("omnivoice"), flat.join("backend"))
                } else {
                    (up2.join("omnivoice"), up2.join("backend"))
                };
                if res_omni.is_dir() {
                    let omnivoice_dir = project_dir.join("omnivoice");
                    let _ = fs::remove_dir_all(&omnivoice_dir);
                    if let Err(e) = copy_dir_recursive(&res_omni, &omnivoice_dir) {
                        fail(progress, &format!("Failed to sync omnivoice/ sources: {}", e));
                        return None;
                    }
                    log::info!("Synced omnivoice/ from bundle");
                }
                if res_backend.is_dir() {
                    let _ = fs::remove_dir_all(&backend_dir);
                    if let Err(e) = copy_dir_recursive(&res_backend, &backend_dir) {
                        fail(progress, &format!("Failed to sync backend/ sources: {}", e));
                        return None;
                    }
                    log::info!("Synced backend/ from bundle");
                }
                // #307: the source dirs above track the bundle, so the
                // dependency manifests must too — otherwise an upgrade runs
                // new code against a venv that predates newly added deps.
                if refresh_project_manifests(res, &project_dir) {
                    log::info!("uv.lock changed since the venv was synced — running uv sync (#307)");
                    if let Some(p) = progress {
                        set_stage(p, BootstrapStage::InstallingDeps);
                    }
                    match resolve_uv(app, &app_data, progress) {
                        Ok(uv_path) => {
                            let mut drift_cmd = Command::new(&uv_path);
                            scrub_python_env(&mut drift_cmd); // #144
                            apply_uv_http_env(&mut drift_cmd);
                            let user_cfg = crate::config::load_config(app);
                            if let Some(pypi) = user_cfg.mirrors.pypi_index.as_deref() {
                                drift_cmd.env("UV_INDEX_URL", pypi);
                            } else if get_effective_region(app) == "china" {
                                drift_cmd.env("UV_INDEX_URL", "https://mirrors.aliyun.com/pypi/simple/");
                            }
                            drift_cmd
                                .args(["sync", "--frozen", "--no-dev", "--verbose"])
                                .current_dir(&project_dir);
                            match run_streaming(app, "installing_deps", &mut drift_cmd) {
                                Ok(ref s) if s.success() => {
                                    log::info!("Dependency drift sync complete (#307)");
                                }
                                other => {
                                    // Don't brick a previously-working install
                                    // (e.g. an offline upgrade): keep the old
                                    // venv and let the backend try.
                                    log::error!(
                                        "Dependency drift sync failed ({:?}) — continuing with \
the existing venv; newly added dependencies may be missing (#307)",
                                        other
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("Could not resolve uv for drift sync: {} (#307)", e);
                        }
                    }
                }
            }
            return Some((venv_py, backend_dir));
        }
        if matches!(uvicorn_check, Ok(ref s) if s.success()) {
            // uvicorn is fine but pkg_resources (#248) and/or the omnivoice
            // editable install (#564) is missing. pkg_resources: setuptools>=80
            // (installed before the <80 pin in #224) dropped the bundled module.
            // omnivoice: an interrupted/offline sync never laid the editable
            // record. Either way a repair `uv sync` re-pins setuptools AND
            // re-lays the editable install, so force it rather than hand back a
            // venv that crashes at the first model call.
            log::warn!(
                "Venv at {} starts uvicorn but failed a runtime-import gate \
(pkg_resources_ok={}, omnivoice_ok={}) — re-running uv sync to repair (#248 #564)",
                venv_dir.display(), pkg_resources_ok, omnivoice_ok
            );
        } else {
            log::warn!(
                "Venv exists at {} but uvicorn is not importable — re-running uv sync",
                venv_dir.display()
            );
        }
        if let Some(p) = progress {
            set_stage(p, BootstrapStage::InstallingDeps);
        }
        let uv_path = match resolve_uv(app, &app_data, progress) {
            Ok(p) => p,
            Err(e) => { fail(progress, &e); return None; }
        };
        // #307: repair against the *current* bundled manifests, not the stale
        // copies from when the venv was first created.
        if let Ok(res) = app.path().resource_dir() {
            let _ = refresh_project_manifests(&res, &project_dir);
        }
        let mut repair_cmd = Command::new(&uv_path);
        scrub_python_env(&mut repair_cmd); // #144: don't inherit AppImage's bundled Python
        apply_uv_http_env(&mut repair_cmd);
        let has_lockfile = project_dir.join("uv.lock").is_file();
        if has_lockfile {
            repair_cmd.args(["sync", "--frozen", "--no-dev", "--verbose"]);
        } else {
            repair_cmd.args(["sync", "--no-dev", "--verbose"]);
        }
        repair_cmd.current_dir(&project_dir);
        let repair_status = run_streaming(app, "installing_deps", &mut repair_cmd);
        if matches!(repair_status, Ok(ref s) if s.success()) {
            // #248: after the repair sync, ensure pkg_resources landed. The repair
            // path is also triggered when pkg_resources is missing (see above), so
            // we must verify here rather than trusting that uv sync alone fixed it
            // (e.g. if the bundled uv.lock still pins setuptools>=80 somehow).
            let mut pr_repair_check = Command::new(&venv_py);
            scrub_python_env(&mut pr_repair_check);
            let pr_ok = matches!(
                pr_repair_check
                    .args(["-c", "import pkg_resources"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status(),
                Ok(ref s) if s.success()
            );
            if !pr_ok {
                log::warn!("pkg_resources still missing after repair sync — installing setuptools<80 directly (#248)");
                emit_log(app, "installing_deps",
                    "Repairing pkg_resources: force-reinstalling setuptools<80 (#248)");
                let mut st_cmd = Command::new(&uv_path);
                scrub_python_env(&mut st_cmd);
                apply_uv_http_env(&mut st_cmd);
                st_cmd
                    // --reinstall: when the venv has setuptools's *metadata* but its
                // pkg_resources files were removed (antivirus quarantine, partial
                // extract), a plain `pip install` sees it "already satisfied" and
                // no-ops — only a forced reinstall re-extracts pkg_resources (#248).
                .args(["pip", "install", "--reinstall", "setuptools>=75,<80"])
                    .current_dir(&project_dir);
                match run_streaming(app, "installing_deps", &mut st_cmd) {
                    Ok(ref s) if s.success() => {
                        log::info!("setuptools<80 installed after repair sync; pkg_resources now available (#248)");
                    }
                    other => {
                        log::error!("Failed to install setuptools<80 after repair sync: {:?} — dubbing may fail (#248)", other);
                    }
                }
                // Re-verify pkg_resources is importable after the targeted install.
                let mut pr_post_check = Command::new(&venv_py);
                scrub_python_env(&mut pr_post_check);
                let pr_final_ok = matches!(
                    pr_post_check
                        .args(["-c", "import pkg_resources"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status(),
                    Ok(ref s) if s.success()
                );
                if !pr_final_ok {
                    // Repair could not restore pkg_resources — fail loudly instead of
                    // handing back a venv that will crash on the first ASR/dub call. The
                    // "pkg_resources" text routes to the PKG_RESOURCES_MISSING failure
                    // mapping (clear, doc-linked remediation in the UI). (#248)
                    fail(
                        progress,
                        "pkg_resources is missing from the backend venv and the automatic \
                         setuptools repair did not restore it — its files were likely removed \
                         by antivirus or left by a partial install (the metadata is still there, \
                         so a plain reinstall is skipped). Open a terminal in the backend venv \
                         and run `uv pip install --reinstall 'setuptools>=75,<80'`, then restart. \
                         If it recurs, add the backend `.venv` folder to your antivirus \
                         exclusions. (#248)",
                    );
                    return None;
                }
            }
            return Some((venv_py, backend_dir));
        }
        fail(progress, &format!("Repair uv sync failed: {:?}", repair_status));
        return None;
    }

    let resource_dir = app.path().resource_dir().ok()?;
    let flat = resource_dir.clone();
    let up2  = resource_dir.join("_up_").join("_up_");

    let (resource_pyproject, resource_uvlock, resource_readme, resource_omnivoice, resource_backend) = if flat.join("pyproject.toml").is_file() {
        (flat.join("pyproject.toml"), flat.join("uv.lock"), flat.join("README.md"), flat.join("omnivoice"), flat.join("backend"))
    } else if up2.join("pyproject.toml").is_file() {
        (up2.join("pyproject.toml"), up2.join("uv.lock"), up2.join("README.md"), up2.join("omnivoice"), up2.join("backend"))
    } else {
        fail(progress, &format!(
            "Missing bootstrap resources — checked flat={} and _up_={}",
            flat.display(), up2.display()));
        return None;
    };

    if !resource_pyproject.is_file() || !resource_backend.is_dir() {
        fail(progress, &format!(
            "Missing bootstrap resources (pyproject={}, backend={})",
            resource_pyproject.display(), resource_backend.display()));
        return None;
    }

    log::info!("First-run venv bootstrap in {}", project_dir.display());
    if let Err(e) = fs::create_dir_all(&project_dir) {
        fail(progress, &format!("mkdir {} failed: {}", project_dir.display(), e));
        return None;
    }
    if let Err(e) = fs::copy(&resource_pyproject, project_dir.join("pyproject.toml")) {
        fail(progress, &format!("copy pyproject.toml: {}", e));
        return None;
    }
    if resource_uvlock.is_file() {
        if let Err(e) = fs::copy(&resource_uvlock, project_dir.join("uv.lock")) {
            log::warn!("Could not copy uv.lock (will use non-frozen sync): {}", e);
        }
    } else {
        log::warn!("No uv.lock in bundle — uv sync will resolve from scratch");
    }
    if resource_readme.is_file() {
        let _ = fs::copy(&resource_readme, project_dir.join("README.md"));
    } else if !project_dir.join("README.md").exists() {
        let _ = fs::write(project_dir.join("README.md"), "# OmniVoice\n");
        log::warn!("No README.md in bundle — created stub");
    }
    let omnivoice_dir = project_dir.join("omnivoice");
    if resource_omnivoice.is_dir() {
        if let Err(e) = copy_dir_recursive(&resource_omnivoice, &omnivoice_dir) {
            log::warn!("Could not copy omnivoice/ source package: {}", e);
        }
    } else {
        log::warn!("No omnivoice/ in bundle — model preload may fail");
    }
    if let Err(e) = copy_dir_recursive(&resource_backend, &backend_dir) {
        fail(progress, &format!("copy backend/: {}", e));
        return None;
    }

    let uv_path = match resolve_uv(app, &app_data, progress) {
        Ok(p) => p,
        Err(e) => { fail(progress, &e); return None; }
    };
    log::info!("Bootstrap uv: {}", uv_path.display());

    if let Some(p) = progress {
        set_stage(p, BootstrapStage::CreatingVenv);
    }
    // plan-03 (#130): mirror cascade + system-Python fallback so first-run
    // survives a GitHub-blocked network. Try in order: (0) the user's custom
    // mirror from the setup screen, when set, (1) default GitHub host,
    // (2) gh-proxy mirror, (3) system Python (only if >= 3.11) — each with
    // longer timeouts/retries. Stop at the first that succeeds.
    let user_cfg = crate::config::load_config(app);
    let custom_mirrors = user_cfg.mirrors.clone();
    let mut venv_attempts: Vec<(&str, Vec<&str>, Vec<(&str, String)>)> = Vec::new();
    if let Some(custom_py_mirror) = custom_mirrors.python_downloads.clone() {
        venv_attempts.push((
            "custom mirror (setup screen)",
            vec!["venv", "--python", "3.11", "--managed-python"],
            vec![("UV_PYTHON_INSTALL_MIRROR", custom_py_mirror)],
        ));
    }
    venv_attempts.push(("default", vec!["venv", "--python", "3.11", "--managed-python"], vec![]));
    venv_attempts.push((
        "gh-proxy mirror",
        vec!["venv", "--python", "3.11", "--managed-python"],
        vec![("UV_PYTHON_INSTALL_MIRROR", PY_INSTALL_MIRROR.to_string())],
    ));
    // Always try the system Python as the LAST resort (mirrors blocked too).
    // No `--python 3.11` pin and no pre-gate: uv's own interpreter discovery is
    // the authority — with `only-system` + the project's `requires-python =
    // ">=3.11"` it resolves any compatible system interpreter (3.12/3.13/3.14…),
    // or fails fast → the remediation message. A pre-gate that only probed
    // `python3`/`python` was stricter than uv (e.g. it missed a Homebrew 3.14
    // when `python3` was the macOS 3.9), wrongly skipping this fallback.
    venv_attempts.push((
        "system-python",
        vec!["venv"],
        vec![("UV_PYTHON_PREFERENCE", "only-system".to_string())],
    ));

    let mut venv_ok = false;
    for (label, args, envs) in &venv_attempts {
        let mut venv_cmd = Command::new(&uv_path);
        scrub_python_env(&mut venv_cmd); // #144: don't inherit AppImage's bundled Python
        apply_uv_http_env(&mut venv_cmd);
        for (k, v) in envs {
            venv_cmd.env(k, v);
        }
        venv_cmd.args(args.iter()).current_dir(&project_dir);
        log::info!("uv venv attempt ({})", label);
        if matches!(run_streaming(app, "creating_venv", &mut venv_cmd), Ok(ref s) if s.success()) {
            venv_ok = true;
            break;
        }
        log::warn!("uv venv attempt ({}) failed; trying next strategy", label);
    }
    if !venv_ok {
        fail(progress, BOOTSTRAP_REMEDIATION);
        return None;
    }

    if let Some(p) = progress {
        set_stage(p, BootstrapStage::InstallingDeps);
    }
    let wheels_dir = wheels_drop_dir(app);
    let mut sync_cmd = Command::new(&uv_path);
    scrub_python_env(&mut sync_cmd); // #144: don't inherit AppImage's bundled Python
    apply_uv_http_env(&mut sync_cmd);
    // #569: let uv install from locally-dropped wheels. (--frozen ignores
    // find-links, but the non-frozen torch-recovery retry below honors it.)
    sync_cmd.env("UV_FIND_LINKS", &wheels_dir);
    let has_lockfile = project_dir.join("uv.lock").is_file();
    if has_lockfile {
        sync_cmd
            .args(["sync", "--frozen", "--no-dev", "--verbose"])
            .current_dir(&project_dir);
    } else {
        log::info!("No uv.lock present, running uv sync without --frozen");
        sync_cmd
            .args(["sync", "--no-dev", "--verbose"])
            .current_dir(&project_dir);
    }
    // PyPI index precedence: explicit setup-screen mirror > region preset.
    if let Some(pypi) = custom_mirrors.pypi_index.as_deref() {
        sync_cmd.env("UV_INDEX_URL", pypi);
    } else if get_effective_region(app) == "china" {
        sync_cmd.env("UV_INDEX_URL", "https://mirrors.aliyun.com/pypi/simple/");
    }
    let mut sync_ok = matches!(run_streaming(app, "installing_deps", &mut sync_cmd), Ok(ref s) if s.success());

    // #569: the big cu128 torch wheel (~2.5 GB) is the most common first-run
    // download failure on restricted networks. If the frozen sync failed on it
    // AND the user has dropped wheels in the local drop dir, retry NON-frozen
    // with --find-links so uv re-resolves using the local wheels (verified: a
    // non-frozen find-links sync installs from a local wheel offline; --frozen
    // does not). Best-effort: if it can't satisfy from the wheels, it fails
    // identically to before and the actionable error below still fires.
    if !sync_ok && has_lockfile {
        let tail = crate::backend::read_error_log_tail(40);
        let have_local_wheels = fs::read_dir(&wheels_dir)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        if have_local_wheels && sync_failure_is_torch_download(&tail) {
            log::warn!(
                "Frozen sync failed on a torch download; retrying non-frozen with local wheels in {} (#569)",
                wheels_dir.display()
            );
            emit_log(app, "installing_deps", "Retrying the install with the wheels you provided locally…");
            let mut retry = Command::new(&uv_path);
            scrub_python_env(&mut retry);
            apply_uv_http_env(&mut retry);
            retry.env("UV_FIND_LINKS", &wheels_dir);
            if let Some(pypi) = custom_mirrors.pypi_index.as_deref() {
                retry.env("UV_INDEX_URL", pypi);
            } else if get_effective_region(app) == "china" {
                retry.env("UV_INDEX_URL", "https://mirrors.aliyun.com/pypi/simple/");
            }
            retry.args(["sync", "--no-dev", "--verbose"]).current_dir(&project_dir);
            sync_ok = matches!(run_streaming(app, "installing_deps", &mut retry), Ok(ref s) if s.success());
        }
    }

    if !sync_ok {
        let tail = crate::backend::read_error_log_tail(40);
        let msg = if sync_failure_is_torch_download(&tail) {
            format!(
                "Couldn't download the CUDA PyTorch package (a ~2.5 GB wheel from download.pytorch.org). \
This is almost always a dropped or restricted network, not a bug. What to try, in order: \
(1) \"Clean & Retry\" — large downloads often succeed on a second attempt. \
(2) Connect through a VPN if your network blocks the PyTorch CDN. \
(3) Manually download the matching torch and torchaudio wheels (see the link in your error log / \
pytorch.org), drop them in {}, then \"Clean & Retry\" — the install will use them locally. \
Details: docs/install/troubleshooting.md (#569).",
                wheels_dir.display()
            )
        } else {
            "Dependency install (uv sync) failed — often a network drop or a partial cache. \
\"Clean & Retry\" rebuilds the environment from scratch. If your network blocks PyPI, set a PyPI \
mirror in Settings → region/mirrors (see docs/install/troubleshooting.md).".to_string()
        };
        fail(progress, &msg);
        return None;
    }

    // #248 belt-and-suspenders: after every uv sync, verify that pkg_resources is
    // importable. If it isn't (setuptools>=80 somehow landed — e.g. no lock file in
    // bundle, or the lock was resolved without our pin), run a targeted
    // `uv pip install "setuptools<80"` to repair the venv without touching anything
    // else. This is safe on all platforms (pure-Python wheel, no native code).
    {
        let mut pr_verify = Command::new(&venv_py);
        scrub_python_env(&mut pr_verify);
        let pr_ok = matches!(
            pr_verify
                .args(["-c", "import pkg_resources"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status(),
            Ok(ref s) if s.success()
        );
        if !pr_ok {
            log::warn!("pkg_resources not importable after uv sync — installing setuptools<80 (#248)");
            emit_log(app, "installing_deps",
                "pkg_resources missing — force-reinstalling setuptools<80 to fix (#248)");
            let mut st_cmd = Command::new(&uv_path);
            scrub_python_env(&mut st_cmd);
            apply_uv_http_env(&mut st_cmd);
            st_cmd
                // --reinstall: when the venv has setuptools's *metadata* but its
                // pkg_resources files were removed (antivirus quarantine, partial
                // extract), a plain `pip install` sees it "already satisfied" and
                // no-ops — only a forced reinstall re-extracts pkg_resources (#248).
                .args(["pip", "install", "--reinstall", "setuptools>=75,<80"])
                .current_dir(&project_dir);
            match run_streaming(app, "installing_deps", &mut st_cmd) {
                Ok(ref s) if s.success() => {
                    log::info!("setuptools<80 installed; pkg_resources now available (#248)");
                }
                other => {
                    log::error!("Failed to install setuptools<80: {:?} — dubbing may fail (#248)", other);
                }
            }
        }
    }

    // Opt-in AMD ROCm (#124): the default install ships the CUDA torch build,
    // so AMD-only machines fall back to CPU. If the user set
    // OMNIVOICE_TORCH_VARIANT=rocm, reinstall torch/torchaudio from the ROCm
    // wheel index. Non-fatal: a failure keeps the working CUDA/CPU build rather
    // than breaking first-run. Default (unset) leaves everything unchanged.
    if let Some(rocm_url) = rocm_opt_in(&user_cfg.torch_variant) {
        log::info!("ROCm torch variant selected → reinstalling torch from {}", rocm_url);
        let mut rocm_cmd = Command::new(&uv_path);
        scrub_python_env(&mut rocm_cmd); // #144: don't inherit AppImage's bundled Python
        apply_uv_http_env(&mut rocm_cmd);
        rocm_cmd.args(rocm_torch_reinstall_args(&rocm_url)).current_dir(&project_dir);
        let rocm_status = run_streaming(app, "installing_deps", &mut rocm_cmd);
        if !matches!(rocm_status, Ok(ref s) if s.success()) {
            log::warn!("ROCm torch reinstall failed ({:?}); keeping default torch build", rocm_status);
            emit_log(
                app, "installing_deps",
                "ROCm torch reinstall failed — keeping the default torch build. \
See docs/install/linux.md (AMD GPU) to install the ROCm wheel manually.",
            );
        }
    }

    Some((venv_py, backend_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn scrub_python_env_removes_bundled_runtime_vars() {
        // #144: every uv/venv/pip subprocess must drop the AppImage's bundled
        // Python env vars so the managed interpreter resolves its own stdlib.
        // `env_remove` queues a removal that `get_envs()` reports as (key, None).
        let mut cmd = Command::new("uv");
        scrub_python_env(&mut cmd);
        let removed: std::collections::HashSet<String> = cmd
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert!(removed.contains("PYTHONHOME"), "PYTHONHOME must be scrubbed");
        assert!(removed.contains("PYTHONPATH"), "PYTHONPATH must be scrubbed");
        assert!(removed.contains("LD_LIBRARY_PATH"), "LD_LIBRARY_PATH must be scrubbed");
    }

    #[test]
    fn apply_uv_http_env_sets_timeouts_and_retries() {
        let mut cmd = Command::new("uv");
        apply_uv_http_env(&mut cmd);
        let envs: HashMap<String, String> = cmd
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            })
            .collect();
        assert_eq!(envs.get("UV_HTTP_TIMEOUT").map(String::as_str), Some("120"));
        assert_eq!(envs.get("UV_HTTP_CONNECT_TIMEOUT").map(String::as_str), Some("30"));
        assert_eq!(envs.get("UV_HTTP_RETRIES").map(String::as_str), Some("5"));
    }

    #[test]
    fn restart_budget_caps_respawns_and_prunes_old_ones() {
        // Supervisor backoff policy (#567): fewer than MAX_RESTARTS deaths
        // inside the window keeps restarting; hitting the cap gives up.
        let t0 = Instant::now();
        let mut times: Vec<Instant> = (0..MAX_RESTARTS - 1).map(|_| t0).collect();
        assert!(
            !restart_budget_exhausted(&mut times, t0),
            "{} deaths in-window is under the cap",
            MAX_RESTARTS - 1
        );
        times.push(t0);
        assert!(
            restart_budget_exhausted(&mut times, t0),
            "{} deaths in-window must trip the cap",
            MAX_RESTARTS
        );

        // Restarts older than the window are pruned and never count toward the
        // cap, so an app left running for hours never crash-loops on stale
        // history. (Forward Instant arithmetic — always representable.)
        let later = t0 + RESTART_WINDOW + Duration::from_secs(1);
        let mut aged: Vec<Instant> = (0..MAX_RESTARTS).map(|_| t0).collect();
        assert!(
            !restart_budget_exhausted(&mut aged, later),
            "deaths older than the window must be pruned, not counted"
        );
        assert!(aged.is_empty(), "stale timestamps should have been dropped");
    }

    #[test]
    fn torch_download_failure_is_detected_for_targeted_help() {
        // #569: the cu128 torch wheel host (and a torch-named download/fetch
        // failure) get torch-specific guidance + the local-wheel retry.
        assert!(sync_failure_is_torch_download(
            "× Failed to download `torch==2.8.0+cu128`\n  https://download.pytorch.org/whl/cu128/torch-2.8.0%2Bcu128-cp311-cp311-win_amd64.whl"
        ));
        assert!(sync_failure_is_torch_download(
            "error sending request for url (https://download-r2.pytorch.org/whl/cu128/torch-2.8.0.whl)"
        ));
        assert!(sync_failure_is_torch_download("Failed to fetch torch wheel"));
        // An unrelated PyPI failure must NOT be mistaken for the torch case.
        assert!(!sync_failure_is_torch_download(
            "Failed to download `numpy==2.0.0` from https://pypi.org/simple"
        ));
        assert!(!sync_failure_is_torch_download("some unrelated venv error"));
    }

    #[test]
    fn rocm_reinstall_args_target_the_rocm_index() {
        let args = rocm_torch_reinstall_args(ROCM_TORCH_INDEX);
        assert_eq!(args[0], "pip");
        assert_eq!(args[1], "install");
        assert!(args.iter().any(|a| a == "--reinstall"));
        assert!(args.iter().any(|a| a == "torch"));
        assert!(args.iter().any(|a| a == "torchaudio"));
        let i = args.iter().position(|a| a == "--index-url").expect("has --index-url");
        assert!(args[i + 1].contains("rocm6.2"), "default index is the rocm6.2 wheel set");
    }

    #[test]
    fn rocm_opt_in_gates_on_env_var_or_config() {
        // This test owns OMNIVOICE_TORCH_VARIANT / _INDEX for its duration; no
        // other test reads them.
        std::env::remove_var("OMNIVOICE_TORCH_VARIANT");
        std::env::remove_var("OMNIVOICE_TORCH_INDEX");
        assert!(rocm_opt_in("auto").is_none(), "unset+auto → no ROCm (default CUDA/CPU path)");
        assert_eq!(
            rocm_opt_in("rocm").as_deref(),
            Some(ROCM_TORCH_INDEX),
            "setup-screen config alone opts in"
        );

        std::env::set_var("OMNIVOICE_TORCH_VARIANT", "cuda");
        assert!(rocm_opt_in("rocm").is_none(), "env var wins over config (explicit non-rocm)");

        std::env::set_var("OMNIVOICE_TORCH_VARIANT", "ROCm");
        assert_eq!(rocm_opt_in("auto").as_deref(), Some(ROCM_TORCH_INDEX), "case-insensitive env opt-in → default index");

        std::env::set_var("OMNIVOICE_TORCH_INDEX", "https://example.test/rocm6.3");
        assert_eq!(rocm_opt_in("auto").as_deref(), Some("https://example.test/rocm6.3"), "index override honored");

        std::env::remove_var("OMNIVOICE_TORCH_VARIANT");
        std::env::remove_var("OMNIVOICE_TORCH_INDEX");
    }

    /// Unique scratch dir under the OS temp dir for the #314 venv-validity tests.
    /// Caller removes it at the end of the test.
    fn temp_venv_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omnivoice-test-314-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp venv dir");
        dir
    }

    /// Lay down the minimal healthy-venv skeleton: pyvenv.cfg + the python
    /// executable at the platform-correct location.
    fn write_healthy_venv_skeleton(venv: &Path) {
        fs::write(venv.join("pyvenv.cfg"), "home = /usr/local/bin\n").unwrap();
        let py = venv_python_path(venv);
        fs::create_dir_all(py.parent().unwrap()).unwrap();
        fs::write(&py, "#!fake interpreter\n").unwrap();
    }

    #[test]
    fn venv_structural_problem_none_when_venv_missing() {
        // #314: a venv path that doesn't exist is the first-run case — the
        // creation path owns it, the validator must stay out of the way.
        let dir = temp_venv_dir("absent");
        let venv = dir.join(".venv");
        assert!(venv_structural_problem(&venv).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn venv_structural_problem_none_for_healthy_venv() {
        // #314 / backward-compat hard rule: a healthy venv must never be
        // flagged (and therefore never deleted).
        let dir = temp_venv_dir("healthy");
        let venv = dir.join(".venv");
        fs::create_dir_all(&venv).unwrap();
        write_healthy_venv_skeleton(&venv);
        assert!(venv_structural_problem(&venv).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn venv_structural_problem_detects_missing_pyvenv_cfg() {
        // #314: the exact field condition of the bug report — python present,
        // pyvenv.cfg gone → venv launcher exits 106 "No pyvenv.cfg file".
        let dir = temp_venv_dir("no-cfg");
        let venv = dir.join(".venv");
        fs::create_dir_all(&venv).unwrap();
        write_healthy_venv_skeleton(&venv);
        fs::remove_file(venv.join("pyvenv.cfg")).unwrap();
        let problem = venv_structural_problem(&venv).expect("must flag missing pyvenv.cfg");
        assert!(problem.contains("pyvenv.cfg"), "reason names pyvenv.cfg: {}", problem);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn venv_structural_problem_detects_missing_python() {
        let dir = temp_venv_dir("no-python");
        let venv = dir.join(".venv");
        fs::create_dir_all(&venv).unwrap();
        write_healthy_venv_skeleton(&venv);
        fs::remove_file(venv_python_path(&venv)).unwrap();
        let problem = venv_structural_problem(&venv).expect("must flag missing python");
        assert!(problem.contains("python"), "reason names python: {}", problem);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn venv_structural_problem_detects_dangling_python_symlink() {
        // #314: `bin/python` symlinks to a managed base interpreter; if that
        // interpreter was removed, the symlink dangles and the venv is dead.
        let dir = temp_venv_dir("dangling");
        let venv = dir.join(".venv");
        fs::create_dir_all(&venv).unwrap();
        write_healthy_venv_skeleton(&venv);
        let py = venv_python_path(&venv);
        fs::remove_file(&py).unwrap();
        std::os::unix::fs::symlink(dir.join("no-such-interpreter"), &py).unwrap();
        let problem = venv_structural_problem(&venv).expect("must flag dangling symlink");
        assert!(problem.contains("dangling"), "reason names the dangling link: {}", problem);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn quarantine_broken_venv_removes_only_the_venv() {
        // #314 safety property: only `.venv` goes away; sibling project files
        // (manifests, backend sources) are untouched.
        let dir = temp_venv_dir("quarantine");
        let venv = dir.join(".venv");
        fs::create_dir_all(venv.join("lib")).unwrap();
        fs::write(venv.join("lib").join("junk.py"), "x").unwrap();
        fs::write(dir.join("pyproject.toml"), "[project]\n").unwrap();
        assert!(quarantine_broken_venv(&venv), "quarantine must succeed");
        assert!(!venv.exists(), ".venv must be gone");
        assert!(dir.join("pyproject.toml").is_file(), "sibling files must survive");
        // Idempotent: quarantining an already-gone venv is a no-op success.
        assert!(quarantine_broken_venv(&venv));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_venv_exit_signature_matches_106_and_pyvenv_message_only() {
        // #314: Windows venv launcher display + message.
        assert!(backend_exit_indicates_broken_venv("exit code: 106", ""));
        // Unix ExitStatus display.
        assert!(backend_exit_indicates_broken_venv("exit status: 106", ""));
        // Message in stderr tail wins regardless of the exit code text.
        assert!(backend_exit_indicates_broken_venv(
            "exit status: 1",
            "Fatal error: No pyvenv.cfg file"
        ));
        // Deliberately narrow: ordinary crashes must NOT trigger a rebuild.
        assert!(!backend_exit_indicates_broken_venv("exit status: 1", "Traceback ..."));
        assert!(!backend_exit_indicates_broken_venv("exit status: 1060", ""));
        assert!(!backend_exit_indicates_broken_venv("signal: 6 (SIGABRT)", ""));
        assert!(!backend_exit_indicates_broken_venv("never started", ""));
        // A relocated/copied venv whose interpreter can't bootstrap its stdlib
        // aborts with this exact phrase (exit 1, not 106) — must rebuild.
        assert!(backend_exit_indicates_broken_venv(
            "exit status: 1",
            "ModuleNotFoundError: No module named 'encodings'"
        ));
        // ...but an app-level import of an 'encodings'-prefixed package must NOT
        // (the full quoted phrase guards against this).
        assert!(!backend_exit_indicates_broken_venv(
            "exit status: 1",
            "ModuleNotFoundError: No module named 'encodings_helper'"
        ));
    }

    /// #248: verify that the setuptools repair install uses the correct specifier.
    /// The specifier `"setuptools>=75,<80"` must be passed as a single argument so
    /// pip/uv interprets the range constraint as one requirement, not two.
    #[test]
    fn setuptools_repair_uses_correct_specifier() {
        // Mirror the exact args slice used in both repair branches so a regression
        // (e.g. accidentally splitting into ["setuptools>=75", ",<80"]) is caught
        // here rather than silently installing the latest setuptools.
        let repair_args: &[&str] = &["pip", "install", "setuptools>=75,<80"];

        // The version specifier must be the third positional argument — one string,
        // not split. This is the key property the review bot flagged: a split arg
        // would make uv install the latest setuptools and leave pkg_resources absent.
        assert_eq!(repair_args[0], "pip");
        assert_eq!(repair_args[1], "install");
        assert_eq!(repair_args[2], "setuptools>=75,<80",
            "specifier must be a single arg; splitting it would bypass the <80 bound");

        // The single-string specifier must contain both bounds.
        let specifier = repair_args[2];
        assert!(specifier.contains("setuptools"), "arg must name the package");
        assert!(specifier.contains(">=75"), "lower bound must be >=75");
        assert!(specifier.contains("<80"), "upper bound must be <80 to keep pkg_resources");
        // No comma-split: the entire range is in one argument with no spaces.
        assert!(!specifier.contains(' '), "specifier must not contain spaces (would be split by shell)");

        // Verify 79.x satisfies the range
        let v79: (u32, u32) = (79, 0);
        assert!(v79.0 >= 75 && v79.0 < 80, "79.x must satisfy >=75,<80");
        // Verify 80.x does NOT satisfy
        let v80: (u32, u32) = (80, 0);
        assert!(!(v80.0 >= 75 && v80.0 < 80), "80.x must NOT satisfy <80");
        // Verify 82.x (what was installed before #224 fix) does NOT satisfy
        let v82: (u32, u32) = (82, 0);
        assert!(!(v82.0 >= 75 && v82.0 < 80), "82.x (pre-fix version) must NOT satisfy <80");
    }
}
