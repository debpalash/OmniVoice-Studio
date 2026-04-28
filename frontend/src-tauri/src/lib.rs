use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use serde::Serialize;
use tauri::{Emitter, Manager};

// Unique port range (3900-3902) chosen to avoid common conflicts:
// 8000 collides with Django/Rails/Jupyter/Airflow on most dev machines.
// 3900 is the backend (FastAPI + uvicorn), 3901 is the Vite dev server,
// 3902 is reserved for future IPC / websocket listeners.
fn backend_port() -> u16 {
    std::env::var("OMNIVOICE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3900)
}

// Version of the Astral `uv` binary we download at first run when no system
// uv is on PATH. Pinned for reproducibility — bump alongside the uv.lock
// when the toolchain needs a newer uv.
const UV_VERSION: &str = "0.11.7";

pub struct BackendState {
    pub process: Mutex<Option<Child>>,
}

// ── Bootstrap progress (for the React splash screen) ─────────────────────

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
    /// Fetching the per-platform static ffmpeg binary from the
    /// ffmpeg-static GitHub release. ~30-70 MB.
    DownloadingFfmpeg { percent: Option<u8> },
    /// Venv ready, spawning uvicorn. Should be <5 s.
    StartingBackend,
    /// Backend is listening and healthy. Frontend can leave the splash.
    Ready,
    /// Something blew up; message carries the reason.
    Failed { message: String },
}

pub struct BootstrapState {
    pub stage: Arc<Mutex<BootstrapStage>>,
}

fn set_stage(state: &Arc<Mutex<BootstrapStage>>, stage: BootstrapStage) {
    if let Ok(mut guard) = state.lock() {
        *guard = stage;
    }
}

// ── Splash log + byte-progress event channel ─────────────────────────────
//
// Two Tauri events drive the splash UI's log panel + per-stage progress
// bar. The splash polls `bootstrap_status` for the coarse stage label and
// listens on these for live detail.

#[derive(Clone, Serialize)]
struct LogPayload {
    stage: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    stage: String,
    bytes_done: u64,
    bytes_total: u64,
    percent: Option<u8>,
}

fn emit_log<R: tauri::Runtime>(app: &tauri::AppHandle<R>, stage: &str, line: &str) {
    let _ = app.emit(
        "bootstrap-log",
        LogPayload { stage: stage.to_string(), line: line.to_string() },
    );
}

fn emit_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    stage: &str,
    done: u64,
    total: u64,
) {
    let percent = if total > 0 {
        Some(((done as f64 / total as f64) * 100.0).min(100.0) as u8)
    } else {
        None
    };
    let _ = app.emit(
        "bootstrap-progress",
        ProgressPayload {
            stage: stage.to_string(),
            bytes_done: done,
            bytes_total: total,
            percent,
        },
    );
}

/// Stream stdout+stderr of a long-running subprocess line-by-line into the
/// splash log panel. Replaces blocking `.status()` calls so the user sees
/// `uv sync` chatter during the 5–10 min pip resolve. Returns the exit
/// status once the child exits.
fn run_streaming<R: tauri::Runtime>(
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

#[tauri::command]
fn bootstrap_status(state: tauri::State<'_, BootstrapState>) -> BootstrapStage {
    state
        .stage
        .lock()
        .map(|g| g.clone())
        .unwrap_or(BootstrapStage::Checking)
}

// ── Port probing ──────────────────────────────────────────────────────────

/// Just "something is listening on :port"
fn port_in_use(port: u16) -> bool {
    TcpStream::connect_timeout(
        &(std::net::Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Full health check — returns true only if the responder at :port is
/// actually our OmniVoice backend, not some other app that happens to own
/// the port. We probe `/system/info` and treat any 2xx JSON response with a
/// known field as "this is us, attach instead of spawning."
fn backend_healthy(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/system/info", port);
    match ureq_get_with_timeout(&url, Duration::from_millis(500)) {
        Ok(body) => body.contains("\"model_checkpoint\"") || body.contains("\"data_dir\""),
        Err(_) => false,
    }
}

/// Minimal HTTP GET without pulling `reqwest` — Tauri already transitively
/// ships everything we need, but adding another crate is overkill for
/// one JSON probe. Raw TcpStream + a single GET request does fine.
fn ureq_get_with_timeout(url: &str, timeout: Duration) -> Result<String, String> {
    let url = url.strip_prefix("http://").ok_or("only http:// supported")?;
    let (host_port, path) = match url.find('/') {
        Some(i) => (&url[..i], &url[i..]),
        None => (url, "/"),
    };
    let mut stream = TcpStream::connect_timeout(
        &host_port
            .to_socket_addrs()
            .map_err(|e| e.to_string())?
            .next()
            .ok_or("unresolvable")?,
        timeout,
    )
    .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host_port
    );
    use std::io::{Read, Write};
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    // Strip HTTP headers, return body only — we only need substring search.
    if let Some(idx) = buf.find("\r\n\r\n") {
        Ok(buf[idx + 4..].to_string())
    } else {
        Err("no body".into())
    }
}

// Needed for `to_socket_addrs` (trait).
use std::net::ToSocketAddrs;

/// Kill whatever process owns the port. Used when port is in use but not
/// responding as our backend — likely an orphan from a crashed dev run.
#[cfg(unix)]
fn kill_orphan_on_port(port: u16) {
    if let Ok(out) = Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .output()
    {
        if out.status.success() {
            let pids = String::from_utf8_lossy(&out.stdout);
            for pid in pids.split_whitespace() {
                if let Ok(pid_n) = pid.parse::<i32>() {
                    log::warn!("Killing orphan process {} on port {}", pid_n, port);
                    unsafe {
                        libc::kill(pid_n, libc::SIGKILL);
                    }
                }
            }
        }
    }
}

#[cfg(not(unix))]
fn kill_orphan_on_port(_port: u16) {}

// ── First-run venv bootstrap (uv + `uv sync` against bundled pyproject) ──

/// URL for the standalone `uv` release matching the host platform, plus a
/// flag indicating whether the archive is a .zip (Windows) vs .tar.gz (Unix).
fn uv_download_url() -> Option<(String, bool)> {
    let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        _ => return None,
    };
    let is_zip = cfg!(windows);
    let ext = if is_zip { "zip" } else { "tar.gz" };
    Some((
        format!(
            "https://github.com/astral-sh/uv/releases/download/{}/uv-{}.{}",
            UV_VERSION, triple, ext
        ),
        is_zip,
    ))
}

/// Download and extract the standalone `uv` binary into `dest`. Idempotent:
/// if the binary is already present, returns its path immediately.
fn install_uv_standalone(dest: &Path) -> io::Result<PathBuf> {
    let uv_bin = dest.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    if uv_bin.is_file() {
        return Ok(uv_bin);
    }
    let (url, is_zip) = uv_download_url().ok_or_else(|| {
        io::Error::new(io::ErrorKind::Unsupported, "no uv binary for this platform")
    })?;
    log::info!("Downloading uv: {}", url);
    fs::create_dir_all(dest)?;
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(120))
        .call()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("uv download: {}", e)))?;
    if resp.status() != 200 {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("uv download HTTP {} from {}", resp.status(), url),
        ));
    }
    let mut reader = resp.into_reader();
    if is_zip {
        #[cfg(windows)]
        {
            let mut buf = Vec::new();
            reader.read_to_end(&mut buf)?;
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf))
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("zip: {}", e)))?;
            archive
                .extract(dest)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("zip extract: {}", e)))?;
        }
        #[cfg(not(windows))]
        {
            // Read the stream to avoid an unused-var warning on non-windows.
            let mut _buf = Vec::new();
            reader.read_to_end(&mut _buf)?;
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "zip branch compiled on non-windows platform",
            ));
        }
    } else {
        let gz = flate2::read::GzDecoder::new(reader);
        let mut archive = tar::Archive::new(gz);
        archive.unpack(dest)?;
    }
    // Astral's tarball extracts to `uv-<triple>/uv` on Unix. Find it and
    // move to the stable `dest/uv` path. On Windows the .zip extracts to
    // the root, so `uv.exe` is already at `dest/uv.exe`.
    if uv_bin.is_file() {
        return Ok(uv_bin);
    }
    for entry in fs::read_dir(dest)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            let candidate = p.join(if cfg!(windows) { "uv.exe" } else { "uv" });
            if candidate.is_file() {
                let _ = fs::rename(&candidate, &uv_bin);
                if uv_bin.is_file() {
                    return Ok(uv_bin);
                }
                fs::copy(&candidate, &uv_bin)?;
                return Ok(uv_bin);
            }
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "uv binary not found after extract"))
}

fn venv_python_path(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// Recursive directory copy that skips `__pycache__` and any dotfile dirs.
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
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

/// Prepare (and on first run, create) the Python venv that will host the
/// backend process. Returns (venv_python, backend_source_dir).
///
/// Dev mode wins: if `.venv` exists at the project root, reuse it (matches
/// the behaviour of `bun run dev`). Otherwise copy the bundled pyproject.toml
/// + uv.lock + backend/ from Tauri resources into `app_local_data_dir/project`
/// and run `uv venv` + `uv sync --frozen --no-dev` there. All subprocess
/// stdout/stderr is streamed to the splash log panel via Tauri events.
fn ensure_venv_ready<R: tauri::Runtime>(app: &tauri::AppHandle<R>, progress: Option<&Arc<Mutex<BootstrapStage>>>) -> Option<(PathBuf, PathBuf)> {
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
        return Some((venv_py, backend_dir));
    }

    let resource_dir = app.path().resource_dir().ok()?;

    // Tauri v2 replaces `../` with `_up_/` in bundled resource paths. So
    // `../../pyproject.toml` from tauri.conf.json becomes
    // `$RESOURCE/_up_/_up_/pyproject.toml` on Windows MSI and Linux deb.
    // macOS .app bundles flatten resources into Contents/Resources/ directly.
    // Try both layouts so the bootstrap works across all platforms.
    let flat = resource_dir.clone();
    let up2  = resource_dir.join("_up_").join("_up_");

    let (resource_pyproject, resource_uvlock, resource_backend) = if flat.join("pyproject.toml").is_file() {
        (flat.join("pyproject.toml"), flat.join("uv.lock"), flat.join("backend"))
    } else if up2.join("pyproject.toml").is_file() {
        (up2.join("pyproject.toml"), up2.join("uv.lock"), up2.join("backend"))
    } else {
        fail(progress, &format!(
            "Missing bootstrap resources — checked flat={} and _up_={}\n  pyproject.toml: flat={}, up2={}",
            flat.display(), up2.display(),
            flat.join("pyproject.toml").display(),
            up2.join("pyproject.toml").display()));
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
        let _ = fs::copy(&resource_uvlock, project_dir.join("uv.lock"));
    }
    if let Err(e) = copy_dir_recursive(&resource_backend, &backend_dir) {
        fail(progress, &format!("copy backend/: {}", e));
        return None;
    }

    // Prefer a system `uv` if one is on PATH; otherwise download the
    // standalone binary into `app_data/tools`.
    let uv_path = match Command::new("uv").arg("--version").output() {
        Ok(_) => PathBuf::from("uv"),
        Err(_) => {
            if let Some(p) = progress {
                set_stage(p, BootstrapStage::DownloadingUv { percent: None });
            }
            match install_uv_standalone(&app_data.join("tools")) {
                Ok(p) => p,
                Err(e) => {
                    fail(progress, &format!("uv install failed: {}", e));
                    return None;
                }
            }
        }
    };
    log::info!("Bootstrap uv: {}", uv_path.display());

    if let Some(p) = progress {
        set_stage(p, BootstrapStage::CreatingVenv);
    }
    let mut venv_cmd = Command::new(&uv_path);
    venv_cmd.args(["venv", "--python", "3.11"]).current_dir(&project_dir);
    let status = run_streaming(app, "creating_venv", &mut venv_cmd);
    if !matches!(status, Ok(ref s) if s.success()) {
        fail(progress, &format!("uv venv failed: {:?}", status));
        return None;
    }

    if let Some(p) = progress {
        set_stage(p, BootstrapStage::InstallingDeps);
    }
    let mut sync_cmd = Command::new(&uv_path);
    sync_cmd
        .args(["sync", "--frozen", "--no-dev", "--verbose"])
        .current_dir(&project_dir);
    let sync_status = run_streaming(app, "installing_deps", &mut sync_cmd);
    if !matches!(sync_status, Ok(ref s) if s.success()) {
        fail(progress, &format!("uv sync failed: {:?}", sync_status));
        return None;
    }

    Some((venv_py, backend_dir))
}

/// Dev-mode fallback: running from the source tree (`bun run dev`).
/// Locate `backend/main.py` so we can launch via `uv run uvicorn`.
fn find_dev_project_root() -> Option<PathBuf> {
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

fn backend_log_path() -> PathBuf {
    // Cross-platform log directory:
    //   macOS:   ~/Library/Logs/OmniVoice
    //   Linux:   $XDG_STATE_HOME/OmniVoice  or  ~/.local/state/OmniVoice
    //   Windows: %LOCALAPPDATA%\OmniVoice\Logs
    let log_dir = if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home).join("Library/Logs/OmniVoice")
    } else if cfg!(target_os = "windows") {
        let base = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("USERPROFILE").map(|u| format!("{}\\AppData\\Local", u)))
            .unwrap_or_else(|_| "C:\\Temp".to_string());
        PathBuf::from(base).join("OmniVoice").join("Logs")
    } else {
        // Linux / other Unix
        let base = std::env::var("XDG_STATE_HOME")
            .or_else(|_| std::env::var("HOME").map(|h| format!("{}/.local/state", h)))
            .unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(base).join("OmniVoice")
    };
    let _ = fs::create_dir_all(&log_dir);
    log_dir.join("backend.log")
}

// ── ffmpeg static binary fetch (cross-platform, no extraction) ───────────
//
// We pull a single statically-linked binary per host platform from the
// long-lived `ffmpeg-static` GitHub release (MIT, ffmpeg-6.0). One binary,
// no archive — just download, chmod +x, done. URLs intentionally pinned
// to a specific tag for reproducibility; bump `FFMPEG_TAG` to upgrade.
const FFMPEG_TAG: &str = "b6.0";

fn ffmpeg_download_url() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64")  => Some("ffmpeg-darwin-arm64"),
        ("macos", "x86_64")   => Some("ffmpeg-darwin-x64"),
        ("linux", "x86_64")   => Some("ffmpeg-linux-x64"),
        ("linux", "aarch64")  => Some("ffmpeg-linux-arm64"),
        ("windows", "x86_64") => Some("ffmpeg-win32-x64.exe"),
        _ => None,
    }
}

/// Download the static ffmpeg binary into `app_data/bin/ffmpeg[.exe]`.
/// Idempotent: if the file exists and is executable, no-ops. Streams byte
/// progress to the splash via `bootstrap-progress`.
fn install_ffmpeg<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    dest_dir: &Path,
    progress: Option<&Arc<Mutex<BootstrapStage>>>,
) -> io::Result<PathBuf> {
    let bin_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let final_path = dest_dir.join(bin_name);

    if final_path.is_file() {
        // Treat any non-zero file as good enough — the user can delete it
        // to force a re-download. Avoids bullying users on flaky networks.
        if let Ok(meta) = fs::metadata(&final_path) {
            if meta.len() > 1_000_000 {
                return Ok(final_path);
            }
        }
    }

    let asset = ffmpeg_download_url().ok_or_else(|| {
        io::Error::new(io::ErrorKind::Unsupported, "no ffmpeg binary for this platform")
    })?;
    let url = format!(
        "https://github.com/eugeneware/ffmpeg-static/releases/download/{}/{}",
        FFMPEG_TAG, asset
    );

    fs::create_dir_all(dest_dir)?;
    let tmp_path = dest_dir.join(format!("{}.part", bin_name));
    let _ = fs::remove_file(&tmp_path);

    if let Some(p) = progress {
        set_stage(p, BootstrapStage::DownloadingFfmpeg { percent: Some(0) });
    }
    emit_log(app, "downloading_ffmpeg", &format!("GET {}", url));

    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(300))
        .call()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("ffmpeg download: {}", e)))?;
    if resp.status() != 200 {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("ffmpeg HTTP {} from {}", resp.status(), url),
        ));
    }
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut reader = resp.into_reader();
    let mut out = fs::File::create(&tmp_path)?;
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_emit = Instant::now();
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 { break; }
        use std::io::Write;
        out.write_all(&buf[..n])?;
        done += n as u64;
        if last_emit.elapsed() > Duration::from_millis(150) {
            emit_progress(app, "downloading_ffmpeg", done, total);
            if let Some(p) = progress {
                let pct = if total > 0 {
                    Some(((done as f64 / total as f64) * 100.0) as u8)
                } else { None };
                set_stage(p, BootstrapStage::DownloadingFfmpeg { percent: pct });
            }
            last_emit = Instant::now();
        }
    }
    drop(out);
    emit_progress(app, "downloading_ffmpeg", done, total.max(done));

    fs::rename(&tmp_path, &final_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&final_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&final_path, perms)?;
    }
    emit_log(app, "downloading_ffmpeg",
        &format!("ffmpeg ready at {} ({} bytes)", final_path.display(), done));
    Ok(final_path)
}

/// Resolve the ffmpeg path to inject into the backend env. Order: app-data
/// download (preferred — controlled), bundled resource (legacy), system
/// PATH (None — let the backend find it). Triggers a fresh download into
/// `app_data/bin/` if nothing usable is on disk.
fn ensure_ffmpeg_ready<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    progress: Option<&Arc<Mutex<BootstrapStage>>>,
) -> Option<PathBuf> {
    let app_data = app.path().app_local_data_dir().ok()?;
    let bin_dir = app_data.join("bin");
    let installed = bin_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    if installed.is_file() {
        return Some(installed);
    }
    if let Some(bundled) = find_bundled_ffmpeg(app) {
        return Some(bundled);
    }
    match install_ffmpeg(app, &bin_dir, progress) {
        Ok(p) => Some(p),
        Err(e) => {
            emit_log(app, "downloading_ffmpeg", &format!("ffmpeg fetch failed: {}", e));
            log::warn!("ffmpeg fetch failed: {} — backend will fall back to system PATH", e);
            None
        }
    }
}

/// Stage the bundled ffmpeg binary and return its absolute path. The path is
/// exported via `OMNIVOICE_FFMPEG` so the Python backend uses it over a
/// system install. Returns None if the bundled binary isn't present.
fn find_bundled_ffmpeg<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let candidates = [
        dir.join("bin/ffmpeg"),
        dir.join("binaries/ffmpeg"),
        // Tauri "resources" ships ffmpeg inside the backend folder because
        // top-level `binaries/ffmpeg` hit macOS provenance-xattr permission
        // errors during bundling. Keep it next to the PyInstaller binary.
        dir.join("backend/omnivoice-backend/bin/ffmpeg"),
    ];
    for c in &candidates {
        if c.is_file() {
            return Some(c.clone());
        }
    }
    None
}

// ── Spawn the backend via the bootstrapped venv Python ────────────────────

fn spawn_backend<R: tauri::Runtime>(app: &tauri::AppHandle<R>, progress: Option<&Arc<Mutex<BootstrapStage>>>) -> Option<Child> {
    let log_path = backend_log_path();
    let err_path = log_path.with_file_name("backend_err.log");
    log::info!(
        "Spawning backend — log: {} · err: {}",
        log_path.display(),
        err_path.display(),
    );

    let (python, backend_dir) = match ensure_venv_ready(app, progress) {
        Some(x) => x,
        None => {
            log::error!("Venv bootstrap failed — backend not started");
            return None;
        }
    };

    // Fetch ffmpeg before flipping to StartingBackend so the splash shows
    // the real-time download. Failure isn't fatal — we'll fall back to the
    // system PATH and let the backend log the missing-ffmpeg error itself.
    let ffmpeg_path = ensure_ffmpeg_ready(app, progress);

    if let Some(p) = progress {
        set_stage(p, BootstrapStage::StartingBackend);
    }

    let stdout_file = fs::File::create(&log_path).ok();
    let stderr_file = fs::File::create(&err_path).ok();

    let mut env: Vec<(String, String)> = vec![("PYTHONUNBUFFERED".into(), "1".into())];
    // Windows: Triton doesn't exist, so torch.compile tries to download it
    // and fails. TORCHDYNAMO_DISABLE skips torch.compile entirely. Also
    // disable HF symlinks (NTFS symlinks need Developer Mode / admin).
    if cfg!(target_os = "windows") {
        env.push(("TORCHDYNAMO_DISABLE".into(), "1".into()));
        env.push(("HF_HUB_DISABLE_SYMLINKS_WARNING".into(), "1".into()));
        env.push(("HF_HUB_DISABLE_SYMLINKS".into(), "1".into()));
    }
    if let Some(ff) = ffmpeg_path {
        env.push(("OMNIVOICE_FFMPEG".into(), ff.to_string_lossy().into_owned()));
        let path_sep = if cfg!(windows) { ";" } else { ":" };
        env.push((
            "PATH".into(),
            format!(
                "{}{}{}",
                ff.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                path_sep,
                std::env::var("PATH").unwrap_or_default(),
            ),
        ));
    }

    let mut cmd = Command::new(&python);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let child = cmd
        .args([
            "-m",
            "uvicorn",
            "main:app",
            "--app-dir",
            backend_dir.to_string_lossy().as_ref(),
            "--host",
            "127.0.0.1",
            "--port",
            &backend_port().to_string(),
        ])
        .stdout(stdout_file.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(stderr_file.map(Stdio::from).unwrap_or_else(Stdio::null))
        .spawn();
    match child {
        Ok(c) => {
            log::info!(
                "Backend started via venv python {} (pid {})",
                python.display(),
                c.id()
            );
            Some(c)
        }
        Err(e) => {
            log::error!("Failed to spawn backend: {}", e);
            None
        }
    }
}

// ── Native IPC commands ──────────────────────────────────────────────────
//
// These replace HTTP round-trips for local-only data. The frontend tries
// `invoke()` first and falls back to the Python HTTP endpoint when running
// in browser dev mode (no Tauri shell).

/// System metrics: CPU + RAM. Replaces `GET /sysinfo` (polled every 5 s).
/// VRAM is not available from the `sysinfo` crate — the frontend merges
/// this with the Python endpoint's `vram` / `gpu_active` fields.
#[tauri::command]
fn get_sysinfo() -> SysinfoPayload {
    use sysinfo::System;

    let mut sys = System::new();
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    // CPU usage needs two measurements with a gap to be meaningful. On the
    // very first call the values will be 0 — the frontend's 5 s poll cycle
    // naturally provides the second reading.
    let cpu = sys.global_cpu_usage() as f64;
    let ram = sys.used_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
    let total_ram = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);

    SysinfoPayload {
        cpu: (cpu * 100.0).round() / 100.0,
        ram: (ram * 100.0).round() / 100.0,
        total_ram: (total_ram * 100.0).round() / 100.0,
        // VRAM stays at 0 — Python endpoint provides the real value.
        vram: 0.0,
        gpu_active: false,
    }
}

#[derive(Serialize, Clone)]
struct SysinfoPayload {
    cpu: f64,
    ram: f64,
    total_ram: f64,
    vram: f64,
    gpu_active: bool,
}

/// Tail the last N lines of a log file. Replaces `GET /system/logs` and
/// `GET /system/logs/tauri`. Uses seek-from-end for large files.
#[tauri::command]
fn read_log_tail(source: String, tail: Option<usize>) -> LogTailPayload {
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

#[derive(Serialize, Clone)]
struct LogTailPayload {
    lines: Vec<String>,
    path: String,
    exists: bool,
    total_lines: usize,
}

/// The backend's rolling runtime log — the file Python's RotatingFileHandler
/// writes to. Mirrors the path in `backend/core/config.py`.
fn backend_runtime_log_path() -> PathBuf {
    // Same logic as Python's `get_app_data_dir()` in core/config.py
    let data_dir = if cfg!(target_os = "macos") {
        dirs_data_dir().join("OmniVoice")
    } else if cfg!(target_os = "windows") {
        PathBuf::from(
            std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string()),
        )
        .join("OmniVoice")
    } else {
        // Linux: ~/.omnivoice
        PathBuf::from(
            std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()),
        )
        .join(".omnivoice")
    };
    data_dir.join("omnivoice.log")
}

/// macOS: ~/Library/Application Support
/// Falls back to home dir on other platforms (not used directly there).
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

/// Tauri plugin log file — the file `tauri-plugin-log` writes to.
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
        // Linux: ~/.local/share/<bid>/logs/tauri.log
        PathBuf::from(&home)
            .join(".local/share")
            .join(bid)
            .join("logs")
            .join("tauri.log")
    }
}

/// Walk the HuggingFace Hub cache directory and return per-repo disk usage.
/// Replaces Python's `huggingface_hub.scan_cache_dir()` — 3-5× faster
/// because we avoid Python's GIL and stat() overhead.
#[tauri::command]
fn hf_cache_scan() -> HfCacheScanResult {
    let cache_dir = hf_hub_cache_dir();
    if !cache_dir.is_dir() {
        return HfCacheScanResult {
            repos: vec![],
            cache_dir: cache_dir.to_string_lossy().to_string(),
        };
    }

    // HF cache layout: <cache>/models--<org>--<name>/snapshots/<hash>/files…
    // We walk the top-level model dirs and sum their sizes.
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

            // Convert "models--org--name" → "org/name"
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

#[derive(Serialize, Clone)]
struct HfCacheRepo {
    repo_id: String,
    size_on_disk: u64,
    nb_files: usize,
}

#[derive(Serialize, Clone)]
struct HfCacheScanResult {
    repos: Vec<HfCacheRepo>,
    cache_dir: String,
}

/// Resolve the HuggingFace Hub cache directory. Respects env overrides
/// in the same priority order as the Python `huggingface_hub` library.
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

// ── Tauri entry ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            bootstrap_status,
            get_sysinfo,
            read_log_tail,
            hf_cache_scan,
        ])
        .setup(|app| {
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

            // ── Enable microphone / camera on Linux (WebKitGTK) ──────────
            // WebKitGTK has no browser-style permission dialog; it denies
            // getUserMedia by default. We enable the media-stream setting
            // and auto-grant UserMedia permission requests so the Record
            // button works on all platforms.
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

            // Bootstrap state is published via the `bootstrap_status` Tauri
            // command so the React splash can poll it while we work.
            let bootstrap = BootstrapState {
                stage: Arc::new(Mutex::new(BootstrapStage::Checking)),
            };
            let stage_handle = bootstrap.stage.clone();
            app.manage(bootstrap);
            app.manage(BackendState {
                process: Mutex::new(None),
            });

            // Spawn the bootstrap + backend launch in a background thread so
            // setup() returns immediately and the webview can render the
            // splash screen. Previously this was synchronous, so on first
            // launch the webview was blank for 5-10 minutes.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let skip_spawn = std::env::var("TAURI_SKIP_BACKEND").is_ok();
                if skip_spawn {
                    log::info!("TAURI_SKIP_BACKEND set — not spawning");
                    set_stage(&stage_handle, BootstrapStage::Ready);
                    return;
                }
                if backend_healthy(backend_port()) {
                    log::info!(
                        "Port {} already serving OmniVoice backend — attaching",
                        backend_port()
                    );
                    set_stage(&stage_handle, BootstrapStage::Ready);
                    return;
                }
                if port_in_use(backend_port()) {
                    log::warn!(
                        "Port {} in use — taking ownership (killing whatever's there)",
                        backend_port()
                    );
                    kill_orphan_on_port(backend_port());
                    std::thread::sleep(Duration::from_millis(500));
                }
                let child = spawn_backend(&app_handle, Some(&stage_handle));
                if let Ok(mut guard) = app_handle.state::<BackendState>().process.lock() {
                    *guard = child;
                }
                // Poll the port until the backend actually responds, then flip
                // the splash to Ready. Bounded wait — first-run cold starts
                // on Windows can hit 120+ s while torch imports + JIT compiles
                // CUDA kernels, so we give it 5 min before declaring failure.
                let start = std::time::Instant::now();
                while start.elapsed() < Duration::from_secs(300) {
                    if backend_healthy(backend_port()) {
                        set_stage(&stage_handle, BootstrapStage::Ready);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                set_stage(
                    &stage_handle,
                    BootstrapStage::Failed {
                        message: "Backend did not respond within 300 s".to_string(),
                    },
                );
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Ok(mut lock) = window.state::<BackendState>().process.lock() {
                        if let Some(ref mut child) = *lock {
                            let pid = child.id();
                            log::info!("Shutting down backend (pid {})", pid);

                            // SIGTERM first for graceful Python shutdown, then SIGKILL.
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
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
