use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

pub struct BackendState {
    pub process: Mutex<Option<Child>>,
}

/// Returns true if something is already listening on 127.0.0.1:port
fn port_in_use(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Locate the project root (contains `backend/` dir).
/// - In dev: `src-tauri/` is at `frontend/src-tauri`, so root = `../../`
/// - In production .app bundle: we ship a `backend/` resource, or the user
///   controls CWD via a wrapper script. We try several candidates.
fn find_project_root() -> Option<PathBuf> {
    let candidates = [
        // Dev: running from frontend/src-tauri
        PathBuf::from("../../"),
        // Dev: running from project root (bun desktop)
        PathBuf::from("."),
        // Homebrew/user install: backend next to the .app
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|p| {
                // Inside .app bundle: Contents/MacOS/app → go up to .app/../
                p.parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.parent())
                    .and_then(|p| p.parent())
                    .map(|d| d.to_path_buf())
            })
            .unwrap_or_default(),
    ];
    for c in &candidates {
        if c.join("backend").is_dir() && c.join("backend/main.py").is_file() {
            return Some(c.clone());
        }
    }
    None
}

/// Find `uv` binary — check common locations if not on PATH.
fn find_uv() -> String {
    // Check PATH first
    if Command::new("uv").arg("--version").output().is_ok() {
        return "uv".to_string();
    }
    // Common install locations on macOS
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{}/.local/bin/uv", home),
        format!("{}/.cargo/bin/uv", home),
        "/opt/homebrew/bin/uv".to_string(),
        "/usr/local/bin/uv".to_string(),
    ];
    for c in &candidates {
        if PathBuf::from(c).exists() {
            return c.clone();
        }
    }
    "uv".to_string() // fallback — let it fail with a clear message
}

/// Create a log file for backend output visible in Console.app / filesystem.
fn backend_log_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let log_dir = PathBuf::from(&home).join("Library/Logs/OmniVoice");
    let _ = fs::create_dir_all(&log_dir);
    log_dir.join("backend.log")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.handle().plugin(tauri_plugin_dialog::init())?;
            app.handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Only spawn if the backend isn't already running (e.g. manual `uv run`)
            let skip_spawn = std::env::var("TAURI_SKIP_BACKEND").is_ok() || port_in_use(8000);
            let child = if skip_spawn {
                log::info!("Backend already running or skipped — not spawning");
                None
            } else {
                match find_project_root() {
                    Some(root) => {
                        let uv = find_uv();
                        let log_path = backend_log_path();
                        log::info!(
                            "Spawning backend: {} run uvicorn ... (cwd: {}, log: {})",
                            uv,
                            root.display(),
                            log_path.display()
                        );

                        // Open log file for stdout/stderr — visible in ~/Library/Logs/OmniVoice/
                        let log_file = fs::File::create(&log_path).ok();
                        let stderr_file = fs::File::create(
                            log_path.with_file_name("backend_err.log"),
                        )
                        .ok();

                        let result = Command::new(&uv)
                            .args([
                                "run",
                                "uvicorn",
                                "main:app",
                                "--app-dir",
                                "backend",
                                "--host",
                                "0.0.0.0",
                                "--port",
                                "8000",
                            ])
                            .current_dir(&root)
                            .stdout(
                                log_file
                                    .map(Stdio::from)
                                    .unwrap_or_else(Stdio::null),
                            )
                            .stderr(
                                stderr_file
                                    .map(Stdio::from)
                                    .unwrap_or_else(Stdio::null),
                            )
                            .spawn();

                        match result {
                            Ok(child) => {
                                log::info!(
                                    "Backend started (pid {})",
                                    child.id()
                                );
                                Some(child)
                            }
                            Err(e) => {
                                log::error!(
                                    "Failed to spawn backend: {}. Is `uv` installed?",
                                    e
                                );
                                // Don't panic — app can still open and show an error state
                                None
                            }
                        }
                    }
                    None => {
                        log::warn!(
                            "Could not find project root (backend/ dir). Backend not started."
                        );
                        None
                    }
                }
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

                            // Send SIGTERM first for graceful shutdown (Python cleanup handlers)
                            #[cfg(unix)]
                            {
                                unsafe {
                                    libc::kill(pid as i32, libc::SIGTERM);
                                }
                                // Give it 2s to shut down gracefully
                                let start = std::time::Instant::now();
                                loop {
                                    match child.try_wait() {
                                        Ok(Some(_)) => break,
                                        Ok(None)
                                            if start.elapsed()
                                                < std::time::Duration::from_secs(2) =>
                                        {
                                            std::thread::sleep(
                                                std::time::Duration::from_millis(100),
                                            );
                                        }
                                        _ => {
                                            log::warn!("Backend didn't exit in 2s, force-killing");
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
                            let _ = child.wait(); // reap zombie
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
