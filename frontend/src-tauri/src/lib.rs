use std::fs;
use std::io::{self, Read};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const BACKEND_PORT: u16 = 8000;

// GH Releases uploader repo. Used to construct the tarball download URL for
// the first-run bootstrap when the installer ships without a bundled backend.
const BACKEND_RELEASE_REPO: &str = "debpalash/OmniVoice-Studio";

pub struct BackendState {
    pub process: Mutex<Option<Child>>,
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

// ── Backend path resolution ───────────────────────────────────────────────

/// Look for a frozen PyInstaller bundle in three places, in priority order:
///   1. Tauri resource dir (legacy path: backend bundled into the installer).
///   2. Per-user app data dir (new path: backend downloaded on first run).
///   3. Dev fallback (`../../dist/omnivoice-backend/`) — PyInstaller local run.
fn find_bundled_backend<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<PathBuf> {
    let exe_name = backend_exe_name();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().resource_dir() {
        roots.push(d);
    }
    if let Ok(d) = app.path().app_local_data_dir() {
        roots.push(d);
    }
    roots.push(PathBuf::from("../../dist"));
    for root in roots {
        let candidates = [
            root.join(format!("backend/omnivoice-backend/{}", exe_name)),
            root.join("backend/omnivoice-backend").join(&exe_name),
            root.join("omnivoice-backend").join(&exe_name),
            root.join(format!("omnivoice-backend/{}", exe_name)),
        ];
        for c in &candidates {
            if c.is_file() {
                return Some(c.clone());
            }
        }
    }
    None
}

fn backend_exe_name() -> String {
    if cfg!(windows) {
        "omnivoice-backend.exe".into()
    } else {
        "omnivoice-backend".into()
    }
}

// ── First-run backend bootstrap (download + extract) ──────────────────────

/// Triple that matches the release-asset naming used by release.yml — see
/// the `package-backend-tarball` step. Kept in lock-step with that
/// matrix.rust_target value.
fn release_asset_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        _ => None,
    }
}

fn backend_download_url() -> Option<String> {
    let triple = release_asset_triple()?;
    let version = env!("CARGO_PKG_VERSION");
    Some(format!(
        "https://github.com/{}/releases/download/v{}/omnivoice-backend_{}_{}.tar.gz",
        BACKEND_RELEASE_REPO, version, version, triple
    ))
}

/// Download the backend tarball and extract it under the per-user app-local
/// data dir. Blocks the caller. Returns the path where the backend was
/// extracted (parent of the omnivoice-backend directory) on success.
fn download_and_extract_backend<R: tauri::Runtime>(app: &tauri::App<R>) -> io::Result<PathBuf> {
    let url = backend_download_url()
        .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "no release asset for this platform"))?;
    let dest_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    fs::create_dir_all(&dest_root)?;

    log::info!("Fetching backend tarball: {}", url);
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(60 * 30))
        .call()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("download: {}", e)))?;
    if resp.status() != 200 {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("download HTTP {} from {}", resp.status(), url),
        ));
    }

    let mut reader = resp.into_reader();
    let gz = flate2::read::GzDecoder::new(LogReader::new(&mut reader));
    let mut archive = tar::Archive::new(gz);
    archive.unpack(&dest_root)?;
    log::info!("Backend extracted under {}", dest_root.display());
    Ok(dest_root)
}

/// Wraps a Read impl and logs progress every ~64 MB. Gives the user some
/// feedback in the tauri log while the download runs.
struct LogReader<'a, R: Read> {
    inner: &'a mut R,
    so_far: u64,
    next_log: u64,
}

impl<'a, R: Read> LogReader<'a, R> {
    fn new(inner: &'a mut R) -> Self {
        Self { inner, so_far: 0, next_log: 64 * 1024 * 1024 }
    }
}

impl<'a, R: Read> Read for LogReader<'a, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.so_far += n as u64;
        if self.so_far >= self.next_log {
            log::info!("Backend download: {} MB received", self.so_far / (1024 * 1024));
            self.next_log += 64 * 1024 * 1024;
        }
        Ok(n)
    }
}

fn ensure_backend_ready<R: tauri::Runtime>(app: &tauri::App<R>) -> bool {
    if find_bundled_backend(app).is_some() {
        return true;
    }
    if release_asset_triple().is_none() {
        log::warn!("No release asset known for this platform; skipping auto-download.");
        return false;
    }
    log::info!("Backend not found locally — starting first-run download.");
    match download_and_extract_backend(app) {
        Ok(_) => find_bundled_backend(app).is_some(),
        Err(e) => {
            log::error!("Backend auto-download failed: {}", e);
            false
        }
    }
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

fn find_uv() -> String {
    if Command::new("uv").arg("--version").output().is_ok() {
        return "uv".to_string();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    for cand in [
        format!("{}/.local/bin/uv", home),
        format!("{}/.cargo/bin/uv", home),
        "/opt/homebrew/bin/uv".to_string(),
        "/usr/local/bin/uv".to_string(),
    ] {
        if PathBuf::from(&cand).exists() {
            return cand;
        }
    }
    "uv".to_string()
}

fn backend_log_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let log_dir = PathBuf::from(&home).join("Library/Logs/OmniVoice");
    let _ = fs::create_dir_all(&log_dir);
    log_dir.join("backend.log")
}

/// Stage the bundled ffmpeg binary and return its absolute path. The path is
/// exported via `OMNIVOICE_FFMPEG` so the Python backend uses it over a
/// system install. Returns None if the bundled binary isn't present.
fn find_bundled_ffmpeg<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<PathBuf> {
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

// ── Spawn the backend (bundled first, uv-fallback in dev) ─────────────────

fn spawn_backend<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<Child> {
    let log_path = backend_log_path();
    let err_path = log_path.with_file_name("backend_err.log");
    log::info!(
        "Spawning backend — log: {} · err: {}",
        log_path.display(),
        err_path.display(),
    );

    let stdout_file = fs::File::create(&log_path).ok();
    let stderr_file = fs::File::create(&err_path).ok();

    // Common env: unbuffered Python stdout, bundled ffmpeg path if we have one.
    let mut env: Vec<(String, String)> = vec![
        ("PYTHONUNBUFFERED".into(), "1".into()),
    ];
    if let Some(ff) = find_bundled_ffmpeg(app) {
        env.push(("OMNIVOICE_FFMPEG".into(), ff.to_string_lossy().into_owned()));
        env.push((
            "PATH".into(),
            format!(
                "{}:{}",
                ff.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                std::env::var("PATH").unwrap_or_default(),
            ),
        ));
    }

    // ── Production path — bundled PyInstaller binary ──
    if let Some(bin) = find_bundled_backend(app) {
        log::info!("Using bundled backend: {}", bin.display());
        let mut cmd = Command::new(&bin);
        for (k, v) in &env {
            cmd.env(k, v);
        }
        let child = cmd
            .stdout(stdout_file.map(Stdio::from).unwrap_or_else(Stdio::null))
            .stderr(stderr_file.map(Stdio::from).unwrap_or_else(Stdio::null))
            .spawn();
        return match child {
            Ok(c) => {
                log::info!("Bundled backend started (pid {})", c.id());
                Some(c)
            }
            Err(e) => {
                log::error!("Failed to spawn bundled backend: {}", e);
                None
            }
        };
    }

    // ── Dev fallback — uv run uvicorn over the source tree ──
    log::info!("Bundled backend not found — falling back to `uv run uvicorn`");
    let root = match find_dev_project_root() {
        Some(r) => r,
        None => {
            log::warn!("Could not find project root; backend not started.");
            return None;
        }
    };
    let uv = find_uv();
    let mut cmd = Command::new(&uv);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let child = cmd
        .args([
            "run", "uvicorn",
            "main:app",
            "--app-dir", "backend",
            "--host", "127.0.0.1",
            "--port", &BACKEND_PORT.to_string(),
        ])
        .current_dir(&root)
        .stdout(stdout_file.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(stderr_file.map(Stdio::from).unwrap_or_else(Stdio::null))
        .spawn();
    match child {
        Ok(c) => {
            log::info!("Dev backend started via uv (pid {})", c.id());
            Some(c)
        }
        Err(e) => {
            log::error!("Failed to spawn dev backend: {}. Is `uv` installed?", e);
            None
        }
    }
}

// ── Tauri entry ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.handle().plugin(tauri_plugin_dialog::init())?;
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            app.handle().plugin(tauri_plugin_process::init())?;
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

            // ── Port-reuse dance ──
            // 1. TAURI_SKIP_BACKEND=1 → never spawn (for devs running uvicorn manually).
            // 2. Packaged build (bundled binary present) → always own the sidecar:
            //    kill whatever's on 8000 and spawn our child. Attaching to an
            //    external backend looks fine at launch but leaves us stranded
            //    when that process dies — user sees silent "Load failed" errors
            //    and we can't recover.
            // 3. Dev build (no bundled binary) + port already healthy → attach
            //    so you can keep a manual `uv run uvicorn` running alongside
            //    `bun run tauri dev`.
            // 4. Otherwise → spawn (kill orphan first if port held by corpse).
            let skip_spawn = std::env::var("TAURI_SKIP_BACKEND").is_ok();
            if !skip_spawn {
                // First-run bootstrap: the installer ships without the
                // PyInstaller backend so it fits under GH Releases' 2 GB
                // per-asset cap. Download + extract it into the per-user
                // app data dir if we don't have it yet. Blocking — the
                // webview stays on the initial loader until this resolves.
                let _ = ensure_backend_ready(app);
            }
            let has_bundled = find_bundled_backend(app).is_some();
            let child = if skip_spawn {
                log::info!("TAURI_SKIP_BACKEND set — not spawning");
                None
            } else if !has_bundled && backend_healthy(BACKEND_PORT) {
                log::info!(
                    "Dev mode: port {} already serving OmniVoice backend — attaching",
                    BACKEND_PORT
                );
                None
            } else {
                if port_in_use(BACKEND_PORT) {
                    log::warn!(
                        "Port {} in use — taking ownership (killing whatever's there)",
                        BACKEND_PORT
                    );
                    kill_orphan_on_port(BACKEND_PORT);
                    std::thread::sleep(Duration::from_millis(500));
                }
                spawn_backend(app)
            };

            app.manage(BackendState {
                process: Mutex::new(child),
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
