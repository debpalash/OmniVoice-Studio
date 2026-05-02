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
    if let Ok(data_dir) = app.path().app_local_data_dir() {
        let project_dir = data_dir.join("project");
        if project_dir.is_dir() {
            log::info!("Clean retry: removing {}", project_dir.display());
            let _ = fs::remove_dir_all(&project_dir);
        }
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

    let app_data = app.path().app_local_data_dir().ok()?;
    let project_dir = app_data.join("project");
    let venv_dir = project_dir.join(".venv");
    let venv_py = venv_python_path(&venv_dir);
    let backend_dir = project_dir.join("backend");

    if venv_py.is_file() && backend_dir.is_dir() {
        let uvicorn_check = Command::new(&venv_py)
            .args(["-c", "import uvicorn"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if matches!(uvicorn_check, Ok(ref s) if s.success()) {
            return Some((venv_py, backend_dir));
        }
        log::warn!(
            "Venv exists at {} but uvicorn is not importable — re-running uv sync",
            venv_dir.display()
        );
        if let Some(p) = progress {
            set_stage(p, BootstrapStage::InstallingDeps);
        }
        let uv_path = match resolve_uv(app, &app_data, progress) {
            Ok(p) => p,
            Err(e) => { fail(progress, &e); return None; }
        };
        let mut repair_cmd = Command::new(&uv_path);
        let has_lockfile = project_dir.join("uv.lock").is_file();
        if has_lockfile {
            repair_cmd.args(["sync", "--frozen", "--no-dev", "--verbose"]);
        } else {
            repair_cmd.args(["sync", "--no-dev", "--verbose"]);
        }
        repair_cmd.current_dir(&project_dir);
        let repair_status = run_streaming(app, "installing_deps", &mut repair_cmd);
        if matches!(repair_status, Ok(ref s) if s.success()) {
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
    let mut venv_cmd = Command::new(&uv_path);
    venv_cmd.args(["venv", "--python", "3.11", "--managed-python"]).current_dir(&project_dir);
    let status = run_streaming(app, "creating_venv", &mut venv_cmd);
    if !matches!(status, Ok(ref s) if s.success()) {
        fail(progress, &format!("uv venv failed: {:?}", status));
        return None;
    }

    if let Some(p) = progress {
        set_stage(p, BootstrapStage::InstallingDeps);
    }
    let mut sync_cmd = Command::new(&uv_path);
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
    let effective_region = get_effective_region(app);
    if effective_region == "china" {
        sync_cmd.env("UV_INDEX_URL", "https://mirrors.aliyun.com/pypi/simple/");
    }
    let sync_status = run_streaming(app, "installing_deps", &mut sync_cmd);
    if !matches!(sync_status, Ok(ref s) if s.success()) {
        fail(progress, &format!("uv sync failed: {:?}", sync_status));
        return None;
    }

    Some((venv_py, backend_dir))
}
