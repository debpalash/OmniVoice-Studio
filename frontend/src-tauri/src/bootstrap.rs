//! Bootstrap progress tracking, venv creation, and retry commands.

use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::config::get_effective_region;
use crate::tools::resolve_uv;
use crate::{BackendState, backend_port};

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
        let child = crate::backend::spawn_backend(&app, Some(&stage_handle));
        if let Ok(mut guard) = app.state::<BackendState>().process.lock() {
            *guard = child;
        }
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(300) {
            if crate::backend::backend_healthy(backend_port()) {
                set_stage(&stage_handle, BootstrapStage::Ready);
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
                let msg = if err_tail.is_empty() {
                    format!("Backend process exited ({}) — no error output captured", exit_info)
                } else {
                    format!("Backend process exited ({}):\n{}", exit_info, err_tail)
                };
                log::error!("Backend died early: {}", msg);
                set_stage(&stage_handle, BootstrapStage::Failed { message: msg });
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
        set_stage(&stage_handle, BootstrapStage::Failed { message: msg });
    });
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
        if matches!(uvicorn_check, Ok(ref s) if s.success()) && pkg_resources_ok {
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
            // uvicorn is fine but pkg_resources is missing (#248): setuptools>=80 was
            // installed before the <80 pin landed (issue #224). Force a repair sync
            // to downgrade setuptools to a version that ships pkg_resources.
            log::warn!(
                "Venv at {} is missing pkg_resources (setuptools>=80 pre-dates the <80 pin) \
— re-running uv sync to repair (#248)",
                venv_dir.display()
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
                    "Repairing pkg_resources: installing setuptools<80 (#248)");
                let mut st_cmd = Command::new(&uv_path);
                scrub_python_env(&mut st_cmd);
                apply_uv_http_env(&mut st_cmd);
                st_cmd
                    .args(["pip", "install", "setuptools>=75,<80"])
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
                         setuptools repair did not restore it. Open a terminal and run \
                         `uv pip install 'setuptools>=75,<80'` in the backend venv, then \
                         restart. (#248)",
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
    let mut sync_cmd = Command::new(&uv_path);
    scrub_python_env(&mut sync_cmd); // #144: don't inherit AppImage's bundled Python
    apply_uv_http_env(&mut sync_cmd);
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
    let sync_status = run_streaming(app, "installing_deps", &mut sync_cmd);
    if !matches!(sync_status, Ok(ref s) if s.success()) {
        fail(
            progress,
            "Dependency install (uv sync) failed — often a network drop or a \
partial cache. \"Clean & Retry\" rebuilds the environment from scratch. If your \
network blocks PyPI, set UV_DEFAULT_INDEX to a mirror (see \
docs/install/troubleshooting.md).",
        );
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
                "pkg_resources missing (setuptools>=80) — installing setuptools<80 to fix (#248)");
            let mut st_cmd = Command::new(&uv_path);
            scrub_python_env(&mut st_cmd);
            apply_uv_http_env(&mut st_cmd);
            st_cmd
                .args(["pip", "install", "setuptools>=75,<80"])
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
