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
/// actually our VoiceStudio backend.
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

/// The `app_version` reported by the VoiceStudio backend at :port.
/// `None` when nothing VoiceStudio answers there (port free, or a foreign
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
/// version-mismatched (or unversioned) VoiceStudio responder is stale by
/// definition; callers kill it and spawn the bundled backend instead.
pub fn same_app_version(running: &str) -> bool {
    fn base(v: &str) -> &str {
        v.split('-').next().unwrap_or(v).trim()
    }
    !running.is_empty() && base(running) == base(env!("CARGO_PKG_VERSION"))
}

/// Deep health probe for the attach-to-a-running-backend shortcut.
///
/// `/health` and `/system/info` keep answering from a backend whose install
/// was deleted out from under it (files unlinked on disk, code already in
/// memory) — that zombie passes the version check and then 500s every real
/// route, so the UI looks alive but nothing works. Probe a DB-touching
/// endpoint and require an actual `200` status line before attaching;
/// anything else (500, timeout, refused) means the responder is not a
/// backend worth keeping.
pub fn backend_deep_healthy(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/profiles", port);
    match raw_http_get(&url, Duration::from_millis(1500)) {
        Ok(resp) => parse_http_status(&resp) == Some(200),
        Err(_) => false,
    }
}

/// Status code from a raw HTTP response ("HTTP/1.1 200 OK" → 200).
fn parse_http_status(response: &str) -> Option<u16> {
    let line = response.lines().next()?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn ureq_get_with_timeout(url: &str, timeout: Duration) -> Result<String, String> {
    let buf = raw_http_get(url, timeout)?;
    if let Some(idx) = buf.find("\r\n\r\n") {
        Ok(buf[idx + 4..].to_string())
    } else {
        Err("no body".into())
    }
}

/// One raw loopback HTTP GET, returning the FULL response (status line +
/// headers + body). Kept dependency-free on purpose — see module docs.
fn raw_http_get(url: &str, timeout: Duration) -> Result<String, String> {
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
    Ok(buf)
}

/// Exit code `backend/main.py` uses when it could not bind the port (#1223).
/// Keep in sync with `_EXIT_PORT_IN_USE` there.
pub const EXIT_PORT_IN_USE: i32 = 78;

/// Kill whoever holds `port`, then confirm it actually came free.
///
/// #1223: every caller used to kill-then-sleep-then-spawn unconditionally, so
/// a holder we cannot kill — a different user's process, a `taskkill` blocked
/// by policy, a socket sitting in TIME_WAIT that the Windows `netstat`
/// LISTENING filter can't even see — was indistinguishable from success. The
/// backend then died on the bind with a raw errno and the user got "Backend
/// died (exit code 1)".
///
/// Returns true when the port is free afterwards. Polls rather than sleeping a
/// flat interval: the common case (our own orphan) frees in well under 500ms,
/// and the uncommon case deserves longer than one guess.
pub fn free_port_or_report(port: u16) -> bool {
    kill_orphan_on_port(port);
    for _ in 0..20 {
        if !port_in_use(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log::error!(
        "Port {} is still held after attempting to kill its owner — the \
         backend cannot bind it. Another application (or a process owned by a \
         different user) is using the port.",
        port
    );
    false
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
    // no_window: this orphan-kill probe runs on every launch; without it a
    // netstat console window flashes each time the app starts.
    let out = match crate::tools::no_window(Command::new("netstat").args(["-ano", "-p", "TCP"])).output() {
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
                let _ = crate::tools::no_window(
                    Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]),
                )
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
///
/// Whole-file view — bootstrap phases (uv sync et al.) that predate any
/// backend run use this. Anything reporting on a specific backend process
/// (crash markers, death diagnostics) must use [`read_error_log_tail_for_run`]
/// instead: the file outlives runs, so an unbounded tail can attribute one
/// run's output to another (#1510).
pub fn read_error_log_tail(max_lines: usize) -> String {
    let err_path = backend_log_path().with_file_name("backend_err.log");
    read_error_log_tail_at(&err_path, 0, max_lines)
}

// ── Per-run crash evidence (#1510) ────────────────────────────────────────
//
// backend_err.log is one file shared by every backend run in an app session,
// and it used to be TRUNCATED on each spawn. Both properties destroyed crash
// evidence: a respawn wiped the dead process's final words, and any tail read
// after the replacement started could attach the new run's healthy startup to
// the old run's crash marker — exactly the undiagnosable report in #1510.
// The file is append-only now, each spawn records where its run begins, and
// death paths read only their own run's slice.

/// Byte offset in backend_err.log where the CURRENT run's output begins.
/// Set by `spawn_backend` before the child starts writing.
static ERR_LOG_RUN_START: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Rotate once the shared file gets this big (append-only would otherwise
/// grow across runs forever). Generous: evidence beats disk here.
const ERR_LOG_ROTATE_BYTES: u64 = 1024 * 1024;

/// Where the current backend run's slice of backend_err.log begins.
pub fn err_log_run_start() -> u64 {
    ERR_LOG_RUN_START.load(std::sync::atomic::Ordering::SeqCst)
}

/// Last N lines of the CURRENT run's slice of backend_err.log.
///
/// This is the reader every death path must use: it cannot see another run's
/// output, so a crash marker carries the dying process's words or nothing.
pub fn read_error_log_tail_for_run(max_lines: usize) -> String {
    let err_path = backend_log_path().with_file_name("backend_err.log");
    read_error_log_tail_at(&err_path, err_log_run_start(), max_lines)
}

/// Tail of `path` starting at byte `start` (whole file when `start` is 0 or
/// no longer valid — an externally replaced/shrunk file must degrade to the
/// old whole-file behaviour, never to a silent empty capture).
fn read_error_log_tail_at(path: &Path, start: u64, max_lines: usize) -> String {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let start = usize::try_from(start).unwrap_or(0);
    let slice = if start > 0 && start <= content.len() && content.is_char_boundary(start) {
        &content[start..]
    } else {
        &content[..]
    };
    let lines: Vec<&str> = slice.lines().collect();
    let from = lines.len().saturating_sub(max_lines);
    lines[from..].join("\n")
}

/// Open backend_err.log for a new run: append-only (a respawn must not
/// destroy the previous run's evidence), rotated when oversized, with the
/// run's start offset returned for `ERR_LOG_RUN_START`.
fn open_err_log_for_run(err_path: &Path) -> (Option<fs::File>, u64) {
    let len = fs::metadata(err_path).map(|m| m.len()).unwrap_or(0);
    if len > ERR_LOG_ROTATE_BYTES {
        let rotated = err_path.with_file_name("backend_err.log.1");
        // Rename preferred (keeps the old evidence in .1); on failure —
        // e.g. the file is still held open on Windows — fall back to
        // truncating, which is exactly the pre-#1510 behaviour.
        if fs::rename(err_path, &rotated).is_err() {
            let file = fs::File::create(err_path).ok();
            return (file, 0);
        }
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(err_path)
        .ok();
    let start = fs::metadata(err_path).map(|m| m.len()).unwrap_or(0);
    (file, start)
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

/// Analytics env for the spawned backend: destination override + install channel.
///
/// `core/analytics.py` ships an in-repo publishable default token (#1193), and
/// reads `POSTHOG_PROJECT_TOKEN` from its environment as the OVERRIDE. release.yml
/// passes the `POSTHOG_PROJECT_TOKEN` secret to the tauri-action step as
/// `VITE_POSTHOG_KEY`, and that step compiles this binary as well as the frontend
/// bundle — so `option_env!` bakes it in on the builds that ship it, and we hand
/// it to the child process here so a baked release token wins over the in-repo
/// default.
///
/// Two properties this preserves, both load-bearing:
///   * **Since #1193 there is always a destination**: `core/analytics.py` now
///     carries the in-repo publishable default token, so even when nothing is
///     baked in here (a source-built shell) the backend can run its
///     consent-gated analytics. What this function adds on top is *override*
///     precedence — a baked release token replaces the in-repo default.
///   * **A real process env var wins over both**, so a developer can point a
///     local run at their own PostHog project without recompiling.
///
/// It also stamps `OMNIVOICE_INSTALL_CHANNEL=installer` (#1193): anyone running
/// through this desktop shell is on the "installer" channel — the backend's
/// `install_channel()` reads it (docker is detected via its own marker; bare
/// `uvicorn` runs report "source").
///
/// This only supplies a *destination* and a channel label. Consent is a separate
/// gate the backend checks in prefs (default off) — a token alone never causes a
/// single event.
fn analytics_env(baked_token: Option<&str>, baked_host: Option<&str>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut pass = |name: &str, baked: Option<&str>| {
        if std::env::var(name).is_ok() {
            return; // caller's environment wins
        }
        if let Some(v) = baked.map(str::trim).filter(|v| !v.is_empty()) {
            out.push((name.to_string(), v.to_string()));
        }
    };
    pass("POSTHOG_PROJECT_TOKEN", baked_token);
    pass("POSTHOG_HOST", baked_host);
    pass("OMNIVOICE_INSTALL_CHANNEL", Some("installer"));
    out
}

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
    // Append + per-run offset, never truncate: the previous run's stderr is
    // crash evidence until someone reads it (#1510).
    let (err_log_file, err_log_start) = open_err_log_for_run(&err_path);
    ERR_LOG_RUN_START.store(err_log_start, std::sync::atomic::Ordering::SeqCst);
    if let Some(ref f) = err_log_file {
        use std::io::Write;
        let mut f = f;
        let _ = writeln!(
            f,
            "──── backend run starting (unix {}s) ────",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        );
    }

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
        // #1153 class: the Intel Fortran runtime in MKL (numpy/scipy) aborts
        // the whole backend with `forrtl: error (200)` when a console
        // CLOSE/LOGOFF event reaches the child. Belt (this env var disables
        // that handler) and suspenders (CREATE_NO_WINDOW below means no
        // console gets the event at all). Process env wins for power users.
        if std::env::var("FOR_DISABLE_CONSOLE_CTRL_HANDLER").is_err() {
            env.push(("FOR_DISABLE_CONSOLE_CTRL_HANDLER".into(), "1".into()));
        }
        // #1155: without UTF-8 mode the child's stdio + default file
        // encoding is cp1252, and a library print of Vietnamese/CJK user
        // text raised UnicodeEncodeError mid-synthesis. macOS/Linux are
        // UTF-8 already — this brings Windows to parity.
        if std::env::var("PYTHONUTF8").is_err() {
            env.push(("PYTHONUTF8".into(), "1".into()));
        }
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
    // Analytics destination (#1123) — see analytics_env() below for why.
    env.extend(analytics_env(option_env!("VITE_POSTHOG_KEY"), option_env!("VITE_POSTHOG_HOST")));
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000) | CREATE_NEW_PROCESS_GROUP (0x00000200).
        // The backend used to inherit the app's console context, so OS console
        // CLOSE/LOGOFF events could reach it and MKL's Fortran runtime aborted
        // the process (`forrtl: error (200)`, exit 2 / 0xC000013A — #1153
        // class). No console + own process group = no console events, ever.
        // stdout/stderr are piped above, so nothing is lost. Same flag the
        // nvidia-smi probe already uses (setup.rs).
        cmd.creation_flags(0x0800_0000 | 0x0000_0200);
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
            // Append (not overwrite): the run header above already marks this
            // run's slice, and earlier runs' evidence stays intact.
            if let Ok(mut f) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&err_path)
            {
                use std::io::Write;
                let _ = writeln!(f, "{}", diag);
            }
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

    // #1123 shipped backend analytics that could never run: core/analytics.py reads
    // POSTHOG_PROJECT_TOKEN from the runtime environment, and nothing on the user's
    // machine ever set it. These pin the wiring that fixes it. Since #1193 the
    // backend also carries an in-repo default token, so what's pinned here is the
    // OVERRIDE precedence (baked > in-repo default, process env > baked) plus the
    // "installer" channel marker this shell stamps on the child.

    /// The env-var tests below mutate process-global state; keep them off each
    /// other's toes (cargo runs tests in threads by default).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn a_baked_token_reaches_the_spawned_backend() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("POSTHOG_PROJECT_TOKEN");
        std::env::remove_var("POSTHOG_HOST");
        std::env::remove_var("OMNIVOICE_INSTALL_CHANNEL");

        let env = analytics_env(Some("phc_baked"), Some("https://eu.i.posthog.com"));

        // The baked release token must reach the child, where it overrides the
        // backend's in-repo default destination (#1193).
        assert!(env.contains(&("POSTHOG_PROJECT_TOKEN".into(), "phc_baked".into())));
        assert!(env
            .contains(&("POSTHOG_HOST".into(), "https://eu.i.posthog.com".into())));
    }

    #[test]
    fn a_source_build_passes_no_destination_but_still_marks_the_channel() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("POSTHOG_PROJECT_TOKEN");
        std::env::remove_var("POSTHOG_HOST");
        std::env::remove_var("OMNIVOICE_INSTALL_CHANNEL");

        // No secret at compile time (anyone building the shell from source), and
        // the empty string CI hands over when the secret is simply absent: no
        // POSTHOG_* is passed (the backend falls back to its in-repo default,
        // #1193) — but running under this shell is still the "installer" channel.
        for env in [analytics_env(None, None), analytics_env(Some(""), Some("   "))] {
            assert_eq!(
                env,
                vec![("OMNIVOICE_INSTALL_CHANNEL".to_string(), "installer".to_string())]
            );
        }
    }

    #[test]
    fn the_process_environment_beats_the_baked_token() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("POSTHOG_PROJECT_TOKEN", "phc_developers_own_project");
        std::env::set_var("OMNIVOICE_INSTALL_CHANNEL", "source");
        let env = analytics_env(Some("phc_baked"), None);
        // Don't override what the caller deliberately set — the child inherits it.
        assert!(env.iter().all(|(k, _)| k != "POSTHOG_PROJECT_TOKEN"));
        assert!(env.iter().all(|(k, _)| k != "OMNIVOICE_INSTALL_CHANNEL"));
        std::env::remove_var("POSTHOG_PROJECT_TOKEN");
        std::env::remove_var("OMNIVOICE_INSTALL_CHANNEL");
    }

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
    fn parse_http_status_reads_the_status_line_only() {
        assert_eq!(super::parse_http_status("HTTP/1.1 200 OK\r\nX: 500\r\n\r\nbody"), Some(200));
        assert_eq!(
            super::parse_http_status("HTTP/1.1 500 Internal Server Error\r\n\r\nInternal Server Error"),
            Some(500)
        );
        assert_eq!(super::parse_http_status("garbage"), None);
        assert_eq!(super::parse_http_status(""), None);
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

    // ── Per-run crash evidence (#1510) ───────────────────────────────────
    // The reported failure shape: a crash marker whose stderr tail was the
    // REPLACEMENT process's healthy startup, because the shared err log was
    // truncated on respawn and read unbounded afterwards.

    #[test]
    fn a_respawn_preserves_the_previous_runs_evidence() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backend_err.log");

        let (file, start) = open_err_log_for_run(&path);
        assert_eq!(start, 0);
        writeln!(file.unwrap(), "run1: fatal abort, last words").unwrap();

        // Respawn: pre-#1510 this truncated the file (File::create), turning
        // the dead run's final output into nothing.
        let (file2, start2) = open_err_log_for_run(&path);
        let content = fs::read_to_string(&path).unwrap();
        assert!(
            content.contains("run1: fatal abort"),
            "respawn destroyed the previous run's evidence: {content:?}"
        );
        assert_eq!(
            start2 as usize,
            content.len(),
            "run2 must begin at the old EOF"
        );
        drop(file2);
    }

    #[test]
    fn a_run_bounded_tail_cannot_show_another_runs_output() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backend_err.log");

        let (file, _) = open_err_log_for_run(&path);
        writeln!(file.unwrap(), "run1: Traceback — the actual crash").unwrap();
        let (file2, start2) = open_err_log_for_run(&path);
        writeln!(file2.unwrap(), "run2: OmniVoice model loaded successfully.").unwrap();

        // The dead run's slice: only its own words.
        let run1 = read_error_log_tail_at(&path, 0, 10);
        assert!(run1.contains("the actual crash"));
        // The replacement's slice: its startup, and NEVER run1's crash —
        // and, symmetrically, a marker bounded to run1's slice could never
        // have contained run2's healthy startup (the #1510 report).
        let run2 = read_error_log_tail_at(&path, start2, 10);
        assert!(run2.contains("model loaded successfully"));
        assert!(
            !run2.contains("the actual crash"),
            "run-bounded tail leaked another run's output: {run2:?}"
        );
    }

    #[test]
    fn an_invalid_offset_degrades_to_the_whole_file_not_to_silence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backend_err.log");
        fs::write(&path, "only line\n").unwrap();
        // Offset beyond EOF (file replaced/shrunk externally): evidence
        // beats precision — degrade to the whole file, never to "".
        assert_eq!(read_error_log_tail_at(&path, 10_000, 10), "only line");
    }

    #[test]
    fn an_oversized_log_rotates_instead_of_growing_forever() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backend_err.log");
        fs::write(&path, "x".repeat((ERR_LOG_ROTATE_BYTES + 1) as usize)).unwrap();

        let (_file, start) = open_err_log_for_run(&path);
        assert_eq!(start, 0, "a rotated log starts the new run at offset 0");
        let rotated = path.with_file_name("backend_err.log.1");
        assert!(
            rotated.exists(),
            "old evidence must survive rotation in the sibling file"
        );
    }
}
