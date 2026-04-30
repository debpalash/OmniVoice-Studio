use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIcon, TrayIconBuilder};

// ── Auto-paste (dictation → ⌘V into active app) ─────────────────────────
use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};

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

// Tray + lifecycle state. `quitting` flips true when the user picks the tray
// "Quit OmniVoice" menu item (or otherwise asks for a real exit) so the
// window CloseRequested handler knows to allow the close instead of hiding.
pub struct AppFlags {
    pub quitting: AtomicBool,
}

// Holds the tray icon handle so we can swap its image (red dot during
// recording) and embedded variants of both icons (compiled in via include_bytes
// — no resource bundling needed).
pub struct TrayHandle {
    pub tray: Mutex<Option<TrayIcon>>,
}

// Current global dictation shortcut. Stored so `set_dictation_shortcut` can
// unregister the old binding before registering the new one.
pub struct DictationShortcutState {
    pub current: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>>,
}

const TRAY_ICON_DEFAULT: &[u8] = include_bytes!("../icons/32x32.png");
const TRAY_ICON_RECORDING: &[u8] = include_bytes!("../icons/tray-recording.png");

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

// ── Persistent app config (region, etc.) ──────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    /// "global" or "china"
    #[serde(default = "default_region")]
    pub region: String,
    /// Accelerator string for the global dictation hotkey, e.g.
    /// "CmdOrCtrl+Shift+Space". Parsed by tauri-plugin-global-shortcut at
    /// register time. Falls back to the platform default when missing or
    /// unparseable.
    #[serde(default = "default_dictation_shortcut")]
    pub dictation_shortcut: String,
}
fn default_region() -> String { "global".into() }
fn default_dictation_shortcut() -> String { "CmdOrCtrl+Shift+Space".into() }
impl Default for AppConfig {
    fn default() -> Self {
        Self {
            region: default_region(),
            dictation_shortcut: default_dictation_shortcut(),
        }
    }
}

fn config_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("config.json"))
}

fn load_config<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppConfig {
    config_path(app)
        .and_then(|p| fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config<R: tauri::Runtime>(app: &tauri::AppHandle<R>, cfg: &AppConfig) {
    if let Some(p) = config_path(app) {
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&p, serde_json::to_string_pretty(cfg).unwrap_or_default());
    }
}

#[tauri::command]
fn get_region(app: tauri::AppHandle) -> String {
    load_config(&app).region
}

#[tauri::command]
fn set_region(app: tauri::AppHandle, region: String) -> String {
    let r = if region == "china" { "china" } else { "global" };
    let mut cfg = load_config(&app);
    cfg.region = r.to_string();
    save_config(&app, &cfg);
    r.to_string()
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
pub struct LogPayload {
    pub stage: String,
    pub line: String,
}

fn emit_log<R: tauri::Runtime>(app: &tauri::AppHandle<R>, stage: &str, line: &str) {
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

/// Return all buffered log lines so the frontend can backfill logs that were
/// emitted before the webview finished loading.
#[tauri::command]
fn get_bootstrap_logs(state: tauri::State<'_, BootstrapState>) -> Vec<LogPayload> {
    state
        .logs
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/// Re-trigger the full bootstrap sequence from the frontend. Resets the stage
/// to `Checking`, clears buffered logs, and spawns a new bootstrap thread.
/// This lets the user retry after a transient failure (network timeout, missing
/// file) without restarting the entire app.
#[tauri::command]
fn retry_bootstrap(app: tauri::AppHandle, state: tauri::State<'_, BootstrapState>) {
    // Reset stage
    if let Ok(mut guard) = state.stage.lock() {
        *guard = BootstrapStage::Checking;
    }
    // Clear old logs
    if let Ok(mut logs) = state.logs.lock() {
        logs.clear();
    }
    // Re-run the bootstrap in a background thread
    let stage_handle = state.stage.clone();
    std::thread::spawn(move || {
        let skip_spawn = std::env::var("TAURI_SKIP_BACKEND").is_ok();
        if skip_spawn {
            log::info!("TAURI_SKIP_BACKEND set — not spawning");
            set_stage(&stage_handle, BootstrapStage::Ready);
            return;
        }
        if backend_healthy(backend_port()) {
            log::info!("Port {} already serving OmniVoice backend — attaching", backend_port());
            set_stage(&stage_handle, BootstrapStage::Ready);
            return;
        }
        if port_in_use(backend_port()) {
            log::warn!("Port {} in use — taking ownership", backend_port());
            kill_orphan_on_port(backend_port());
            std::thread::sleep(Duration::from_millis(500));
        }
        let child = spawn_backend(&app, Some(&stage_handle));
        if let Ok(mut guard) = app.state::<BackendState>().process.lock() {
            *guard = child;
        }
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(300) {
            if backend_healthy(backend_port()) {
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
                let err_tail = read_error_log_tail(30);
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
        let err_tail = read_error_log_tail(20);
        let msg = if err_tail.is_empty() {
            "Backend did not respond within 300 s".to_string()
        } else {
            format!("Backend did not respond within 300 s. Last stderr output:\n{}", err_tail)
        };
        set_stage(&stage_handle, BootstrapStage::Failed { message: msg });
    });
}

/// Like `retry_bootstrap` but first wipes the cached project dir so the
/// venv + dependencies are re-created from scratch. Nuclear option for
/// corrupt-venv situations.
#[tauri::command]
fn clean_and_retry_bootstrap(app: tauri::AppHandle, state: tauri::State<'_, BootstrapState>) {
    // Delete the project dir
    if let Ok(data_dir) = app.path().app_local_data_dir() {
        let project_dir = data_dir.join("project");
        if project_dir.is_dir() {
            log::info!("Clean retry: removing {}", project_dir.display());
            let _ = fs::remove_dir_all(&project_dir);
        }
    }
    // Delegate to the normal retry
    retry_bootstrap(app, state);
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

/// Look for a sidecar binary bundled alongside the app via Tauri's
/// `bundle.externalBin`. Tauri places the per-target sidecar at the same
/// path as the main app executable on Linux/Windows, and inside
/// `Contents/MacOS/` on macOS .app bundles. The bundled file keeps its
/// `<name>-<target-triple>{.exe}` name.
///
/// Returns `None` in dev (`cargo run`) builds where the sidecar wasn't
/// bundled — the caller then falls back to PATH lookup or other strategies.
fn find_bundled_sidecar(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        _ => return None,
    };
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let candidate = dir.join(format!("{}-{}{}", name, triple, ext));
    if !candidate.is_file() {
        return None;
    }
    // build.rs writes a zero-byte placeholder so tauri-build's externalBin
    // existence check passes during dev / `cargo check`. Reject it here so
    // we don't try to exec an empty file — callers fall back to PATH lookup
    // or pip-bundled binaries instead.
    let len = std::fs::metadata(&candidate).ok().map(|m| m.len()).unwrap_or(0);
    if len < 1024 {
        return None;
    }
    Some(candidate)
}

fn find_bundled_uv() -> Option<PathBuf> { find_bundled_sidecar("uv") }
fn find_bundled_ffmpeg() -> Option<PathBuf> { find_bundled_sidecar("ffmpeg") }
fn find_bundled_ffprobe() -> Option<PathBuf> { find_bundled_sidecar("ffprobe") }

// ── On-demand ffmpeg / ffprobe download ───────────────────────────────────
//
// Sources:
//   macOS:   evermeet.cx — individual .zip per binary (x86_64, runs via Rosetta on arm64)
//   Linux:   BtbN/FFmpeg-Builds — single .tar.xz with both binaries
//   Windows: BtbN/FFmpeg-Builds — single .zip with both binaries

/// Download and cache static ffmpeg + ffprobe binaries into `dest`.
/// Idempotent: skips the download when both binaries already exist.
fn install_ffmpeg_standalone(dest: &Path) -> io::Result<()> {
    let ffmpeg_bin = dest.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    let ffprobe_bin = dest.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if ffmpeg_bin.is_file() && ffprobe_bin.is_file() {
        return Ok(());
    }
    fs::create_dir_all(dest)?;

    #[cfg(target_os = "macos")]
    {
        // Prefer native arm64 ffmpeg via Homebrew — always latest, includes
        // ffprobe, zero Rosetta overhead on Apple Silicon.
        let brew_candidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
        let brew_path = brew_candidates.iter().find(|p| PathBuf::from(p).is_file());
        if let Some(brew) = brew_path {
            log::info!("Installing ffmpeg via Homebrew (native arm64)");
            let status = Command::new(brew)
                .args(["install", "ffmpeg"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if matches!(status, Ok(ref s) if s.success()) {
                // brew install succeeded — ffmpeg/ffprobe are now on PATH
                // at /opt/homebrew/bin/ or /usr/local/bin/. No need to
                // cache in tools/ — resolve_ffmpeg will find them via PATH.
                return Ok(());
            }
            log::warn!("brew install ffmpeg failed — falling back to evermeet.cx");
        }
        // Fallback: evermeet.cx static binaries (x86_64, runs via Rosetta).
        for (tool, url) in [
            ("ffmpeg", "https://evermeet.cx/ffmpeg/getrelease/zip"),
            ("ffprobe", "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"),
        ] {
            let bin_path = dest.join(tool);
            if bin_path.is_file() {
                continue;
            }
            log::info!("Downloading {} from evermeet.cx", tool);
            let zip_path = dest.join(format!("{}.zip", tool));
            let resp = ureq::get(url)
                .timeout(Duration::from_secs(120))
                .call()
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("{} download: {}", tool, e)))?;
            if resp.status() != 200 {
                return Err(io::Error::new(
                    io::ErrorKind::Other,
                    format!("{} download HTTP {}", tool, resp.status()),
                ));
            }
            let mut zip_file = fs::File::create(&zip_path)?;
            io::copy(&mut resp.into_reader(), &mut zip_file)?;
            drop(zip_file);
            let status = Command::new("unzip")
                .args(["-o", "-j"])
                .arg(&zip_path)
                .arg("-d")
                .arg(dest)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()?;
            let _ = fs::remove_file(&zip_path);
            if !status.success() {
                return Err(io::Error::new(io::ErrorKind::Other, format!("unzip {} failed", tool)));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&bin_path) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&bin_path, perms);
                }
            }
        }
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        // BtbN .tar.xz — extract with system tar (xz decompression is
        // standard on any Linux distro with coreutils).
        let url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";
        log::info!("Downloading ffmpeg from BtbN (linux64)");
        let archive_path = dest.join("ffmpeg.tar.xz");
        let resp = ureq::get(url)
            .timeout(Duration::from_secs(300))
            .call()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("ffmpeg download: {}", e)))?;
        if resp.status() != 200 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("ffmpeg download HTTP {}", resp.status()),
            ));
        }
        let mut archive_file = fs::File::create(&archive_path)?;
        io::copy(&mut resp.into_reader(), &mut archive_file)?;
        drop(archive_file);
        let status = Command::new("tar")
            .args(["-xJf"])
            .arg(&archive_path)
            .arg("-C")
            .arg(dest)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        let _ = fs::remove_file(&archive_path);
        if !status.success() {
            return Err(io::Error::new(io::ErrorKind::Other, "tar -xJf ffmpeg failed"));
        }
        // BtbN extracts to ffmpeg-master-latest-linux64-gpl/bin/
        // Find the binaries and move them up.
        for entry in fs::read_dir(dest)? {
            let entry = entry?;
            let p = entry.path();
            if p.is_dir() {
                let bin_dir = p.join("bin");
                if bin_dir.is_dir() {
                    for tool in ["ffmpeg", "ffprobe"] {
                        let src = bin_dir.join(tool);
                        if src.is_file() {
                            let dst = dest.join(tool);
                            let _ = fs::rename(&src, &dst).or_else(|_| {
                                fs::copy(&src, &dst).map(|_| ())
                            });
                        }
                    }
                    let _ = fs::remove_dir_all(&p);
                    break;
                }
            }
        }
        // Ensure executable
        for tool in ["ffmpeg", "ffprobe"] {
            let bin = dest.join(tool);
            if bin.is_file() {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&bin) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&bin, perms);
                }
            }
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // BtbN .zip — extract with the zip crate (already a dependency).
        let url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
        log::info!("Downloading ffmpeg from BtbN (win64)");
        let resp = ureq::get(url)
            .timeout(Duration::from_secs(300))
            .call()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("ffmpeg download: {}", e)))?;
        if resp.status() != 200 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("ffmpeg download HTTP {}", resp.status()),
            ));
        }
        let mut buf = Vec::new();
        resp.into_reader().read_to_end(&mut buf)?;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf))
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("zip: {}", e)))?;
        // Extract only ffmpeg.exe and ffprobe.exe from the archive.
        for i in 0..archive.len() {
            let mut file = archive.by_index(i)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("zip entry: {}", e)))?;
            let name = file.name().to_string();
            let basename = name.rsplit('/').next().unwrap_or(&name);
            if basename == "ffmpeg.exe" || basename == "ffprobe.exe" {
                let out_path = dest.join(basename);
                let mut out_file = fs::File::create(&out_path)?;
                io::copy(&mut file, &mut out_file)?;
            }
        }
        return Ok(());
    }

    // Unsupported platform — not an error, caller falls back to PATH / imageio-ffmpeg.
    #[allow(unreachable_code)]
    Ok(())
}

/// Resolve a usable ffmpeg binary. Order: bundled sidecar → cached download
/// in app_data/tools → system PATH → on-demand download from the internet.
fn resolve_ffmpeg(app_data: &Path) -> Option<PathBuf> {
    if let Some(p) = find_bundled_ffmpeg() {
        log::info!("Using bundled ffmpeg at {}", p.display());
        return Some(p);
    }
    let tools_dir = app_data.join("tools");
    let cached = tools_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    if cached.is_file() {
        log::info!("Using cached ffmpeg at {}", cached.display());
        return Some(cached);
    }
    // Check system PATH
    if Command::new("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) {
        log::info!("Using system ffmpeg from PATH");
        return Some(PathBuf::from("ffmpeg"));
    }
    // On-demand install (brew on macOS, BtbN download on Linux/Windows)
    log::info!("No ffmpeg found — auto-installing");
    match install_ffmpeg_standalone(&tools_dir) {
        Ok(()) => {
            // Check cache dir first (BtbN/evermeet downloads land here)
            if cached.is_file() {
                log::info!("Installed ffmpeg to {}", cached.display());
                return Some(cached);
            }
            // brew installs to its own prefix — check well-known locations
            for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
                if PathBuf::from(p).is_file() {
                    log::info!("Installed ffmpeg at {}", p);
                    return Some(PathBuf::from(p));
                }
            }
            // Last try: maybe it's on PATH now
            if Command::new("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) {
                return Some(PathBuf::from("ffmpeg"));
            }
            log::warn!("ffmpeg install completed but binary not found");
            None
        }
        Err(e) => {
            log::warn!("ffmpeg install failed: {} — backend will rely on imageio-ffmpeg", e);
            None
        }
    }
}

/// Resolve a usable ffprobe binary. Same cascade as ffmpeg.
fn resolve_ffprobe(app_data: &Path) -> Option<PathBuf> {
    if let Some(p) = find_bundled_ffprobe() {
        log::info!("Using bundled ffprobe at {}", p.display());
        return Some(p);
    }
    let tools_dir = app_data.join("tools");
    let cached = tools_dir.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if cached.is_file() {
        log::info!("Using cached ffprobe at {}", cached.display());
        return Some(cached);
    }
    if Command::new("ffprobe").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) {
        log::info!("Using system ffprobe from PATH");
        return Some(PathBuf::from("ffprobe"));
    }
    // install_ffmpeg_standalone installs both ffmpeg + ffprobe.
    if let Ok(()) = install_ffmpeg_standalone(&tools_dir) {
        if cached.is_file() {
            log::info!("Installed ffprobe to {}", cached.display());
            return Some(cached);
        }
        for p in ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"] {
            if PathBuf::from(p).is_file() {
                log::info!("Installed ffprobe at {}", p);
                return Some(PathBuf::from(p));
            }
        }
        if Command::new("ffprobe").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) {
            return Some(PathBuf::from("ffprobe"));
        }
    }
    None
}

/// Resolve a usable `uv` binary. Order: bundled sidecar (shipped with the
/// release installer via `bundle.externalBin`), system PATH (dev / power
/// users), or — last resort — download the standalone binary from
/// astral-sh/uv into `app_data/tools`. The download path stays as a
/// fallback so dev builds (which never bundle a sidecar) still bootstrap.
fn resolve_uv<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    app_data: &Path,
    progress: Option<&Arc<Mutex<BootstrapStage>>>,
) -> Result<PathBuf, String> {
    if let Some(p) = find_bundled_uv() {
        log::info!("Using bundled uv at {}", p.display());
        return Ok(p);
    }
    if Command::new("uv").arg("--version").output().is_ok() {
        log::info!("Using system uv from PATH");
        return Ok(PathBuf::from("uv"));
    }
    if let Some(p) = progress {
        set_stage(p, BootstrapStage::DownloadingUv { percent: None });
    }
    install_uv_standalone(&app_data.join("tools"))
        .map_err(|e| format!("uv install failed: {}", e))
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
        // Sanity check: verify uvicorn is importable. If a previous
        // bootstrap created the venv but uv sync failed (e.g. missing
        // lockfile), the venv exists but has no packages installed.
        let uvicorn_check = Command::new(&venv_py)
            .args(["-c", "import uvicorn"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if matches!(uvicorn_check, Ok(ref s) if s.success()) {
            return Some((venv_py, backend_dir));
        }
        // uvicorn not installed — fall through to re-bootstrap.
        log::warn!(
            "Venv exists at {} but uvicorn is not importable — re-running uv sync",
            venv_dir.display()
        );
        if let Some(p) = progress {
            set_stage(p, BootstrapStage::InstallingDeps);
        }
        // Try to repair by running uv sync in the existing project dir.
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

    // Tauri v2 replaces `../` with `_up_/` in bundled resource paths. So
    // `../../pyproject.toml` from tauri.conf.json becomes
    // `$RESOURCE/_up_/_up_/pyproject.toml` on Windows MSI and Linux deb.
    // macOS .app bundles flatten resources into Contents/Resources/ directly.
    // Try both layouts so the bootstrap works across all platforms.
    let flat = resource_dir.clone();
    let up2  = resource_dir.join("_up_").join("_up_");

    let (resource_pyproject, resource_uvlock, resource_readme, resource_omnivoice, resource_backend) = if flat.join("pyproject.toml").is_file() {
        (flat.join("pyproject.toml"), flat.join("uv.lock"), flat.join("README.md"), flat.join("omnivoice"), flat.join("backend"))
    } else if up2.join("pyproject.toml").is_file() {
        (up2.join("pyproject.toml"), up2.join("uv.lock"), up2.join("README.md"), up2.join("omnivoice"), up2.join("backend"))
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
        if let Err(e) = fs::copy(&resource_uvlock, project_dir.join("uv.lock")) {
            log::warn!("Could not copy uv.lock (will use non-frozen sync): {}", e);
        }
    } else {
        log::warn!("No uv.lock in bundle — uv sync will resolve from scratch");
    }
    // README.md is required by hatchling's metadata validator (pyproject.toml
    // declares `readme = "README.md"`). Copy from bundle, or create a stub
    // so `uv sync` never fails on a missing readme.
    if resource_readme.is_file() {
        let _ = fs::copy(&resource_readme, project_dir.join("README.md"));
    } else if !project_dir.join("README.md").exists() {
        let _ = fs::write(project_dir.join("README.md"), "# OmniVoice\n");
        log::warn!("No README.md in bundle — created stub");
    }
    // omnivoice/ Python source package — needed for the editable install
    // so `import omnivoice` works in the bundled backend.
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

    // Bundled sidecar → system PATH → standalone download (see resolve_uv).
    let uv_path = match resolve_uv(app, &app_data, progress) {
        Ok(p) => p,
        Err(e) => { fail(progress, &e); return None; }
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
    let has_lockfile = project_dir.join("uv.lock").is_file();
    if has_lockfile {
        sync_cmd
            .args(["sync", "--frozen", "--no-dev", "--verbose"])
            .current_dir(&project_dir);
    } else {
        // No lockfile — let uv resolve dependencies from pyproject.toml.
        // This is slower but always works.
        log::info!("No uv.lock present, running uv sync without --frozen");
        sync_cmd
            .args(["sync", "--no-dev", "--verbose"])
            .current_dir(&project_dir);
    }
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

/// Read the last N lines from backend_err.log for diagnostic messages.
/// Used to surface the real Python traceback when the backend process dies.
fn read_error_log_tail(max_lines: usize) -> String {
    let err_path = backend_log_path().with_file_name("backend_err.log");
    match fs::read_to_string(&err_path) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let start = lines.len().saturating_sub(max_lines);
            lines[start..].join("\n")
        }
        Err(_) => String::new(),
    }
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

    if let Some(p) = progress {
        set_stage(p, BootstrapStage::StartingBackend);
    }

    let stdout_file = fs::File::create(&log_path).ok();
    // stderr: write to file AND stream to splash events for live debugging.
    // We pipe stderr from the child and spawn a thread that tees each line
    // to both the log file and the Tauri event bus.
    let err_log_file = fs::File::create(&err_path).ok();

    let mut env: Vec<(String, String)> = vec![("PYTHONUNBUFFERED".into(), "1".into())];
    // Windows: Triton doesn't exist, so torch.compile tries to download it
    // and fails. TORCHDYNAMO_DISABLE skips torch.compile entirely. Also
    // disable HF symlinks (NTFS symlinks need Developer Mode / admin).
    if cfg!(target_os = "windows") {
        env.push(("TORCHDYNAMO_DISABLE".into(), "1".into()));
        env.push(("HF_HUB_DISABLE_SYMLINKS_WARNING".into(), "1".into()));
        env.push(("HF_HUB_DISABLE_SYMLINKS".into(), "1".into()));
    }
    // HF_ENDPOINT: prefer system env var, then config region.
    // China region → https://hf-mirror.com (#33).
    if let Ok(hf_ep) = std::env::var("HF_ENDPOINT") {
        env.push(("HF_ENDPOINT".into(), hf_ep));
    } else {
        let cfg = load_config(app);
        if cfg.region == "china" {
            env.push(("HF_ENDPOINT".into(), "https://hf-mirror.com".into()));
        }
    }
    // Resolve ffmpeg / ffprobe: bundled sidecar → cached download →
    // system PATH → on-demand download from evermeet.cx / BtbN.
    let app_data = app.path().app_local_data_dir().unwrap_or_default();
    if let Some(ffmpeg_path) = resolve_ffmpeg(&app_data) {
        env.push(("FFMPEG_PATH".into(), ffmpeg_path.to_string_lossy().into()));
    }
    if let Some(ffprobe_path) = resolve_ffprobe(&app_data) {
        env.push(("FFPROBE_PATH".into(), ffprobe_path.to_string_lossy().into()));
    }
    let mut cmd = Command::new(&python);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let mut child = match cmd
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => {
            log::info!(
                "Backend started via venv python {} (pid {})",
                python.display(),
                c.id()
            );
            c
        }
        Err(e) => {
            log::error!("Failed to spawn backend: {}", e);
            return None;
        }
    };

    // Tee stdout to log file + splash event stream.
    if let Some(stdout_pipe) = child.stdout.take() {
        let app_clone = app.clone();
        let mut out_file = stdout_file;
        std::thread::spawn(move || {
            use std::io::Write;
            let reader = BufReader::new(stdout_pipe);
            for line in reader.lines().flatten() {
                log::info!("[backend_stdout] {}", line);
                emit_log(&app_clone, "starting_backend", &line);
                if let Some(ref mut f) = out_file {
                    let _ = writeln!(f, "{}", line);
                }
            }
        });
    }

    // Tee stderr to both the log file and splash event stream so the user
    // can see what's happening during slow first-run imports.
    if let Some(stderr_pipe) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            let reader = BufReader::new(stderr_pipe);
            let mut log_file = err_log_file;
            for line in reader.lines().flatten() {
                log::info!("[backend_stderr] {}", line);
                emit_log(&app_clone, "starting_backend", &line);
                if let Some(ref mut f) = log_file {
                    let _ = writeln!(f, "{}", line);
                }
            }
        });
    }

    Some(child)
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

// ── Simulate paste (⌘V / Ctrl+V) for auto-typing after dictation ─────────
#[tauri::command]
fn simulate_paste() -> Result<(), String> {
    // Small delay to let the OS refocus the previous app after we minimise
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

// ── Tray icon recording-state swap ──────────────────────────────────────
#[tauri::command]
fn set_tray_recording(
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

// ── Real quit (used by the tray "Quit" item) ─────────────────────────────
// Sets the quitting flag so the window CloseRequested handler stops
// intercepting, then asks the app to exit. Backend shutdown happens in the
// RunEvent::ExitRequested handler at the bottom of run().
#[tauri::command]
fn quit_app(app: tauri::AppHandle, flags: tauri::State<'_, AppFlags>) {
    flags.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

// ── Dictation hotkey: read / change at runtime ──────────────────────────
#[tauri::command]
fn get_dictation_shortcut(app: tauri::AppHandle) -> String {
    load_config(&app).dictation_shortcut
}

#[tauri::command]
fn set_dictation_shortcut(
    app: tauri::AppHandle,
    accelerator: String,
    state: tauri::State<'_, DictationShortcutState>,
) -> Result<String, String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let parsed = Shortcut::from_str(&accelerator)
        .map_err(|e| format!("Invalid shortcut '{accelerator}': {e}"))?;

    let gs = app.global_shortcut();

    // Holding the lock across both calls keeps the stored Shortcut consistent
    // with what the OS actually has registered. We unregister the old binding
    // first (otherwise the new register can fail with "already registered"
    // when the user only changed modifiers), and we keep `prev` around so we
    // can restore it on failure — otherwise a bad accelerator leaves the user
    // with no global shortcut at all.
    let mut slot = state.current.lock().map_err(|_| "shortcut lock poisoned")?;
    let prev = slot.take();
    if let Some(ref p) = prev {
        let _ = gs.unregister(p.clone());
    }
    if let Err(e) = gs.register(parsed.clone()) {
        // Roll back so the previously-working shortcut keeps working.
        if let Some(p) = prev {
            if gs.register(p.clone()).is_ok() {
                *slot = Some(p);
            }
        }
        return Err(format!("Failed to register '{accelerator}': {e}"));
    }
    *slot = Some(parsed);
    drop(slot);

    // Persist so the new shortcut survives a restart.
    let mut cfg = load_config(&app);
    cfg.dictation_shortcut = accelerator.clone();
    save_config(&app, &cfg);
    log::info!("Dictation shortcut updated to {accelerator}");
    Ok(accelerator)
}

// ── Tauri entry ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Single-instance MUST be registered first. When a second copy of the
        // binary launches, the closure runs in the already-running instance:
        // we just surface the existing window and discard the second process.
        // This prevents two backends fighting over port 3900.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!("Second instance attempted — focusing existing window");
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            bootstrap_status,
            get_bootstrap_logs,
            retry_bootstrap,
            clean_and_retry_bootstrap,
            get_region,
            set_region,
            get_sysinfo,
            read_log_tail,
            hf_cache_scan,
            simulate_paste,
            set_tray_recording,
            quit_app,
            get_dictation_shortcut,
            set_dictation_shortcut,
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

            // Lifecycle + tray-handle state — must be managed BEFORE the
            // tray builder runs (the tray menu handler reads AppFlags) and
            // before set_tray_recording can fire from the frontend.
            app.manage(AppFlags {
                quitting: AtomicBool::new(false),
            });
            app.manage(TrayHandle {
                tray: Mutex::new(None),
            });
            app.manage(DictationShortcutState {
                current: Mutex::new(None),
            });

            // ── Global dictation shortcut (user-configurable) ────────────────
            {
                use std::str::FromStr;
                use tauri_plugin_global_shortcut::{
                    GlobalShortcutExt, Shortcut, ShortcutState,
                };

                // Plugin handler: any registered shortcut press emits the
                // dictation event. We only ever bind one shortcut at a time
                // (the active one is tracked in DictationShortcutState), so
                // there's nothing else to disambiguate here.
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app_handle, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                log::info!("Global shortcut triggered: dictation");
                                if let Some(win) = app_handle.get_webview_window("main") {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                                let _ = app_handle.emit("tray-dictate", ());
                            }
                        })
                        .build(),
                )?;

                // Read the user's saved shortcut (or the default) and register
                // it. If the saved string is malformed for any reason, log and
                // fall back to the default so dictation still works.
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

            // ── System tray ──────────────────────────────────────────────────
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

            let tray_menu = MenuBuilder::new(app)
                .item(&show_i)
                .separator()
                .item(&dictate_i)
                .item(&settings_i)
                .separator()
                .item(&quit_i)
                .build()?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .tooltip("OmniVoice Studio")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                #[cfg(not(target_os = "macos"))]
                                let _ = win.set_skip_taskbar(false);
                                let _ = win.set_focus();
                            }
                        }
                        "dictate" => {
                            // Emit to frontend → CaptureButton listens for this
                            let _ = app.emit("tray-dictate", ());
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
                            // Mark quitting so the CloseRequested handler
                            // stops intercepting on the way out, then exit.
                            // Backend shutdown happens in the run-event loop.
                            app.state::<AppFlags>()
                                .quitting
                                .store(true, Ordering::SeqCst);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            // Stash the tray handle so set_tray_recording can swap its icon.
            if let Ok(mut slot) = app.state::<TrayHandle>().tray.lock() {
                *slot = Some(tray);
            }

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
                logs: Arc::new(Mutex::new(Vec::new())),
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
                //
                // FIX(#30): Also check if the child process has died — if so,
                // fail immediately with the actual error instead of waiting
                // the full 300 s for a dead process.
                let start = std::time::Instant::now();
                while start.elapsed() < Duration::from_secs(300) {
                    if backend_healthy(backend_port()) {
                        set_stage(&stage_handle, BootstrapStage::Ready);
                        return;
                    }
                    // Check if backend process crashed
                    let process_dead = if let Ok(mut guard) = app_handle.state::<BackendState>().process.lock() {
                        match guard.as_mut() {
                            Some(child) => match child.try_wait() {
                                Ok(Some(status)) => Some(status.to_string()),
                                Ok(None) => None,        // still running
                                Err(_) => Some("unknown".to_string()),
                            },
                            None => Some("never started".to_string()),
                        }
                    } else {
                        None
                    };
                    if let Some(exit_info) = process_dead {
                        let err_tail = read_error_log_tail(30);
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
                // Timeout — include error log tail for diagnostics
                let err_tail = read_error_log_tail(20);
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
            // Close-to-hide: clicking the X (or Cmd+W on macOS) hides the
            // window instead of tearing the app down, so the tray icon stays
            // useful and the global hotkey keeps working. The user gets a
            // real exit via the tray "Quit" menu (or Cmd+Q on macOS, which
            // triggers RunEvent::ExitRequested directly without firing
            // CloseRequested on individual windows).
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
                    return; // Allow the close — exit handler will reap the backend.
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
            // Real exit: reap the Python backend so we don't orphan a uvicorn
            // process holding port 3900. Previously this lived in the window
            // Destroyed handler, which fired on every close — including the
            // close-to-hide path, which left the user with no backend.
            if let Ok(mut lock) = app_handle.state::<BackendState>().process.lock() {
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
    });
}
