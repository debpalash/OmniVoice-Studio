//! Backend process management: spawn, port probing, log paths.

use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
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
        Ok(body) => is_omnivoice_body(&body),
        Err(_) => false,
    }
}

fn is_omnivoice_body(body: &str) -> bool {
    body.contains("\"model_checkpoint\"") || body.contains("\"data_dir\"")
}

/// The `app_version` reported by the OmniVoice backend at :port.
/// `None` when nothing OmniVoice answers there (port free, or a foreign
/// process). `Some("")` when it IS our backend but predates the
/// `app_version` field — callers treat that as stale.
pub fn running_backend_version(port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{}/system/info", port);
    let body = ureq_get_with_timeout(&url, Duration::from_millis(500)).ok()?;
    if !is_omnivoice_body(&body) {
        return None;
    }
    Some(parse_app_version(&body).unwrap_or_default())
}

/// Extract `"app_version": "X"` from a /system/info body. String-sniff on one
/// field (consistent with `backend_healthy`) — no JSON dependency needed.
fn parse_app_version(body: &str) -> Option<String> {
    let key = "\"app_version\"";
    let rest = &body[body.find(key)? + key.len()..];
    let rest = rest[rest.find(':')? + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// Whether a running backend's version matches THIS app build, comparing
/// **base** versions (any `-N` pre-release suffix stripped from both sides) so
/// a preview build `0.3.10-4` still attaches to its `0.3.10` backend.
///
/// Why this exists (the "bound port blocked the newer version" report): an
/// orphaned backend from a *previous* version keeps answering health checks
/// after an update, so "healthy" alone made the new UI silently attach to old
/// backend code — every fix in the update appeared to change nothing. A
/// version-mismatched (or unversioned) OmniVoice responder is stale by
/// definition; callers kill it and spawn the bundled backend instead.
pub fn same_app_version(running: &str) -> bool {
    fn base(v: &str) -> &str {
        v.split('-').next().unwrap_or(v).trim()
    }
    !running.is_empty() && base(running) == base(env!("CARGO_PKG_VERSION"))
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
pub fn kill_orphan_on_port(port: u16) {
    // `netstat -ano` lists listening sockets with their owning PID.
    // Parse the output to find the process listening on exactly `port`.
    let out = match Command::new("netstat").args(["-ano", "-p", "TCP"]).output() {
        Ok(o) => o,
        Err(_) => return,
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    // Match the local address ending in ":PORT" exactly to avoid false
    // positives (e.g. :3900 must not match port 39000).
    let port_suffix = format!(":{}", port);
    for line in stdout.lines() {
        if !line.to_uppercase().contains("LISTENING") {
            continue;
        }
        // Local address is the second whitespace-delimited field.
        // Format: "  TCP    0.0.0.0:3900           0.0.0.0:0   LISTENING   1234"
        let local_addr = line.split_whitespace().nth(1).unwrap_or("");
        if !local_addr.ends_with(&port_suffix) {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if let Some(pid_str) = parts.last() {
            if let Ok(pid) = pid_str.parse::<u32>() {
                log::warn!("Killing orphan process {} on port {} (Windows)", pid, port);
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
        }
    }
}

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

/// Human-readable diagnostic for a failed `Command::spawn()` of the backend.
///
/// #144 / #127: when the bundled venv Python can't exec (the common Linux/
/// AppImage failure — missing system lib, stale venv, arch mismatch) the
/// process "never started" and we previously surfaced "no error output
/// captured". Writing this to backend_err.log lets read_error_log_tail show the
/// real OS error + an actionable hint instead.
fn spawn_failure_diagnostic(python: &Path, err: &std::io::Error) -> String {
    // Platform-specific tail (cfg! resolves to this build's target OS, i.e. the
    // OS it runs on) — don't show AppImage/loader wording to macOS/Windows users.
    let os_hint = if cfg!(target_os = "linux") {
        "On Linux (especially the AppImage) this usually means the bundled venv \
         Python can't execute — a missing system library or a stale/incomplete \
         venv. If it persists, run the app from a terminal to see the \
         dynamic-loader error."
    } else if cfg!(target_os = "macos") {
        "On macOS this usually means the bundled venv Python can't execute (a \
         stale/incomplete venv, or the interpreter got quarantined)."
    } else if cfg!(target_os = "windows") {
        "On Windows this usually means the bundled venv Python is missing or was \
         blocked (antivirus / SmartScreen), or the venv is stale/incomplete."
    } else {
        "This usually means the bundled venv Python can't execute, or the venv is \
         stale/incomplete."
    };
    format!(
        "Failed to launch the backend process.\n\
         Tried to run: {}\n\
         Interpreter present on disk: {}\n\
         OS error: {}\n\n\
         {} Use \"Clean & Retry\" to rebuild the environment.",
        python.display(),
        python.exists(),
        err,
        os_hint,
    )
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
    // Pin the child's OMNIVOICE_PORT to the value Rust resolved so Python's
    // network_share.backend_port() always agrees with the uvicorn --port we
    // pass below — otherwise a user-set OMNIVOICE_PORT would change the
    // LAN-share/Tailscale target while the listener stayed on the Rust port.
    env.push(("OMNIVOICE_PORT".into(), backend_port().to_string()));
    if cfg!(target_os = "windows") {
        env.push(("TORCHDYNAMO_DISABLE".into(), "1".into()));
        env.push(("HF_HUB_DISABLE_SYMLINKS_WARNING".into(), "1".into()));
        env.push(("HF_HUB_DISABLE_SYMLINKS".into(), "1".into()));
    }
    // HF endpoint precedence: process env (power user) > setup-screen custom
    // mirror > region preset.
    let cfg = load_config(app);
    if let Ok(hf_ep) = std::env::var("HF_ENDPOINT") {
        env.push(("HF_ENDPOINT".into(), hf_ep));
    } else if let Some(hf_mirror) = cfg.mirrors.hf_endpoint.as_deref() {
        env.push(("HF_ENDPOINT".into(), hf_mirror.into()));
    } else if cfg.region == "china" {
        env.push(("HF_ENDPOINT".into(), "https://hf-mirror.com".into()));
    }
    // Storage layout chosen on the setup screen. Unset (None) means platform
    // default — we deliberately don't set the env vars then, so legacy
    // installs keep byte-identical behavior. Process env still wins so a
    // power user can relocate per-launch.
    if std::env::var("OMNIVOICE_DATA_DIR").is_err() {
        if let Some(data_dir) = crate::setup::resolved_data_dir(app) {
            env.push(("OMNIVOICE_DATA_DIR".into(), data_dir.to_string_lossy().into()));
        }
    }
    if std::env::var("OMNIVOICE_CACHE_DIR").is_err() {
        if let Some(models_dir) = crate::setup::resolved_models_dir(app) {
            env.push(("OMNIVOICE_CACHE_DIR".into(), models_dir.to_string_lossy().into()));
        }
    }
    let app_data = app.path().app_local_data_dir().unwrap_or_default();
    if let Some(ffmpeg_path) = resolve_ffmpeg(app, &app_data) {
        env.push(("FFMPEG_PATH".into(), ffmpeg_path.to_string_lossy().into()));
    }
    if let Some(ffprobe_path) = resolve_ffprobe(app, &app_data) {
        let ffprobe_str: String = ffprobe_path.to_string_lossy().into();
        env.push(("FFPROBE_PATH".into(), ffprobe_str.clone()));
        // Issue #76: OMNIVOICE_FFPROBE_PATH is the canonical name going
        // forward — explicit, namespaced, and unambiguously the path of a
        // file (not a PATH-style command name). FFPROBE_PATH stays for
        // backward compat with prior backend releases.
        env.push(("OMNIVOICE_FFPROBE_PATH".into(), ffprobe_str));
    }
    let mut cmd = Command::new(&python);
    cmd.env_remove("PYTHONHOME").env_remove("PYTHONPATH").env_remove("LD_LIBRARY_PATH");
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
            // #144/#127: surface WHY it never started. Write the diagnostic to
            // backend_err.log so the bootstrap's read_error_log_tail shows the
            // real exec error instead of "no error output captured".
            let diag = spawn_failure_diagnostic(&python, &e);
            log::error!("{}", diag);
            let _ = fs::write(&err_path, &diag);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn spawn_failure_diagnostic_surfaces_path_error_and_hint() {
        let err = io::Error::new(io::ErrorKind::NotFound, "No such file or directory");
        let diag = spawn_failure_diagnostic(Path::new("/no/such/python"), &err);
        assert!(diag.contains("/no/such/python"), "must name the interpreter path");
        assert!(diag.contains("No such file or directory"), "must include the OS error");
        assert!(diag.contains("Interpreter present on disk: false"));
        assert!(diag.contains("Clean & Retry"), "must give an actionable hint");
    }

    // ── stale-backend detection (the "bound port blocked the newer version"
    //    report: a healthy orphan from a previous version must NOT be
    //    attached to) ─────────────────────────────────────────────────────

    #[test]
    fn parse_app_version_reads_system_info_shape() {
        let body = r#"{"app_version":"0.3.9","data_dir":"/x","model_checkpoint":"k2"}"#;
        assert_eq!(parse_app_version(body).as_deref(), Some("0.3.9"));
        // whitespace after the colon is fine
        assert_eq!(
            parse_app_version(r#"{ "app_version" :  "1.2.3" }"#).as_deref(),
            Some("1.2.3")
        );
        // pre-app_version backends and foreign bodies yield None
        assert_eq!(parse_app_version(r#"{"data_dir":"/x"}"#), None);
        assert_eq!(parse_app_version("<html>not json</html>"), None);
    }

    #[test]
    fn same_app_version_matches_current_build_and_rejects_stale() {
        let ours = env!("CARGO_PKG_VERSION");
        assert!(same_app_version(ours), "own version must attach");
        // preview stamp of the same base still attaches
        assert!(same_app_version(&format!("{}-7", ours)));
        // a different (older) release is stale
        assert!(!same_app_version("0.0.1"));
        // unversioned (pre-app_version backend) is stale by definition
        assert!(!same_app_version(""));
    }
}
