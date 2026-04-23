use std::fs;
use std::io::{self, Read};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

// Unique port range (3900-3902) chosen to avoid common conflicts:
// 8000 collides with Django/Rails/Jupyter/Airflow on most dev machines.
// 3900 is the backend (FastAPI + uvicorn), 3901 is the Vite dev server,
// 3902 is reserved for future IPC / websocket listeners.
const BACKEND_PORT: u16 = 3900;

// Version of the Astral `uv` binary we download at first run when no system
// uv is on PATH. Pinned for reproducibility — bump alongside the uv.lock
// when the toolchain needs a newer uv.
const UV_VERSION: &str = "0.11.7";

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
/// and run `uv venv` + `uv sync --frozen --no-dev` there.
fn ensure_venv_ready<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<(PathBuf, PathBuf)> {
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
    let resource_pyproject = resource_dir.join("pyproject.toml");
    let resource_uvlock = resource_dir.join("uv.lock");
    let resource_backend = resource_dir.join("backend");
    if !resource_pyproject.is_file() || !resource_backend.is_dir() {
        log::warn!(
            "Missing bootstrap resources (pyproject={}, backend={})",
            resource_pyproject.display(),
            resource_backend.display()
        );
        return None;
    }

    log::info!("First-run venv bootstrap in {}", project_dir.display());
    if let Err(e) = fs::create_dir_all(&project_dir) {
        log::error!("mkdir {} failed: {}", project_dir.display(), e);
        return None;
    }
    if let Err(e) = fs::copy(&resource_pyproject, project_dir.join("pyproject.toml")) {
        log::error!("copy pyproject.toml: {}", e);
        return None;
    }
    if resource_uvlock.is_file() {
        let _ = fs::copy(&resource_uvlock, project_dir.join("uv.lock"));
    }
    if let Err(e) = copy_dir_recursive(&resource_backend, &backend_dir) {
        log::error!("copy backend/: {}", e);
        return None;
    }

    // Prefer a system `uv` if one is on PATH; otherwise download the
    // standalone binary into `app_data/tools`.
    let uv_path = match Command::new("uv").arg("--version").output() {
        Ok(_) => PathBuf::from("uv"),
        Err(_) => match install_uv_standalone(&app_data.join("tools")) {
            Ok(p) => p,
            Err(e) => {
                log::error!("uv install failed: {}", e);
                return None;
            }
        },
    };
    log::info!("Bootstrap uv: {}", uv_path.display());

    let status = Command::new(&uv_path)
        .args(["venv", "--python", "3.11"])
        .current_dir(&project_dir)
        .status();
    if !matches!(status, Ok(s) if s.success()) {
        log::error!("uv venv failed: {:?}", status);
        return None;
    }

    let sync_status = Command::new(&uv_path)
        .args(["sync", "--frozen", "--no-dev"])
        .current_dir(&project_dir)
        .status();
    if !matches!(sync_status, Ok(s) if s.success()) {
        log::error!("uv sync failed: {:?}", sync_status);
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

// ── Spawn the backend via the bootstrapped venv Python ────────────────────

fn spawn_backend<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<Child> {
    let log_path = backend_log_path();
    let err_path = log_path.with_file_name("backend_err.log");
    log::info!(
        "Spawning backend — log: {} · err: {}",
        log_path.display(),
        err_path.display(),
    );

    let (python, backend_dir) = match ensure_venv_ready(app) {
        Some(x) => x,
        None => {
            log::error!("Venv bootstrap failed — backend not started");
            return None;
        }
    };

    let stdout_file = fs::File::create(&log_path).ok();
    let stderr_file = fs::File::create(&err_path).ok();

    let mut env: Vec<(String, String)> = vec![("PYTHONUNBUFFERED".into(), "1".into())];
    if let Some(ff) = find_bundled_ffmpeg(app) {
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
            &BACKEND_PORT.to_string(),
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
            // 2. Port already serving a healthy OmniVoice backend → attach so
            //    you can keep a manual `uv run uvicorn` running alongside
            //    `bun run tauri dev`.
            // 3. Otherwise → spawn (kill orphan first if port held by corpse).
            //    spawn_backend triggers the first-run venv bootstrap if needed.
            let skip_spawn = std::env::var("TAURI_SKIP_BACKEND").is_ok();
            let child = if skip_spawn {
                log::info!("TAURI_SKIP_BACKEND set — not spawning");
                None
            } else if backend_healthy(BACKEND_PORT) {
                log::info!(
                    "Port {} already serving OmniVoice backend — attaching",
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
