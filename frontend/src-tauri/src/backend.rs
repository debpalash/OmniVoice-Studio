//! Backend process management: spawn, port probing, log paths.

use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

use crate::bootstrap::{
    BootstrapStage, emit_log, ensure_venv_ready, set_stage,
};
use crate::config::load_config;
use crate::tools::{resolve_ffmpeg, resolve_ffprobe};
use crate::backend_port;

// ── Port probing ──────────────────────────────────────────────────────────

/// Just "something is listening on :port"
pub fn port_in_use(port: u16) -> bool {
    TcpStream::connect_timeout(
        &(std::net::Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Full health check — returns true only if the responder at :port is
/// actually our OmniVoice backend.
pub fn backend_healthy(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/system/info", port);
    match ureq_get_with_timeout(&url, Duration::from_millis(500)) {
        Ok(body) => body.contains("\"model_checkpoint\"") || body.contains("\"data_dir\""),
        Err(_) => false,
    }
}

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
    if let Some(idx) = buf.find("\r\n\r\n") {
        Ok(buf[idx + 4..].to_string())
    } else {
        Err("no body".into())
    }
}

/// Kill whatever process owns the port.
#[cfg(unix)]
pub fn kill_orphan_on_port(port: u16) {
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
pub fn kill_orphan_on_port(_port: u16) {}

// ── Log paths ─────────────────────────────────────────────────────────────

pub fn backend_log_path() -> PathBuf {
    let log_dir = if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home).join("Library/Logs/OmniVoice")
    } else if cfg!(target_os = "windows") {
        let base = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("USERPROFILE").map(|u| format!("{}\\AppData\\Local", u)))
            .unwrap_or_else(|_| "C:\\Temp".to_string());
        PathBuf::from(base).join("OmniVoice").join("Logs")
    } else {
        let base = std::env::var("XDG_STATE_HOME")
            .or_else(|_| std::env::var("HOME").map(|h| format!("{}/.local/state", h)))
            .unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(base).join("OmniVoice")
    };
    let _ = fs::create_dir_all(&log_dir);
    log_dir.join("backend.log")
}

/// Read the last N lines from backend_err.log for diagnostic messages.
pub fn read_error_log_tail(max_lines: usize) -> String {
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

pub fn spawn_backend<R: tauri::Runtime>(app: &tauri::AppHandle<R>, progress: Option<&Arc<Mutex<BootstrapStage>>>) -> Option<Child> {
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
    let err_log_file = fs::File::create(&err_path).ok();

    let mut env: Vec<(String, String)> = vec![("PYTHONUNBUFFERED".into(), "1".into())];
    if cfg!(target_os = "windows") {
        env.push(("TORCHDYNAMO_DISABLE".into(), "1".into()));
        env.push(("HF_HUB_DISABLE_SYMLINKS_WARNING".into(), "1".into()));
        env.push(("HF_HUB_DISABLE_SYMLINKS".into(), "1".into()));
    }
    if let Ok(hf_ep) = std::env::var("HF_ENDPOINT") {
        env.push(("HF_ENDPOINT".into(), hf_ep));
    } else {
        let cfg = load_config(app);
        if cfg.region == "china" {
            env.push(("HF_ENDPOINT".into(), "https://hf-mirror.com".into()));
        }
    }
    let app_data = app.path().app_local_data_dir().unwrap_or_default();
    if let Some(ffmpeg_path) = resolve_ffmpeg(app, &app_data) {
        env.push(("FFMPEG_PATH".into(), ffmpeg_path.to_string_lossy().into()));
    }
    if let Some(ffprobe_path) = resolve_ffprobe(app, &app_data) {
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
