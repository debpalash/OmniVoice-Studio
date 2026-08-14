//! Backend-lifecycle fault-injection harness.
//!
//! Runs `spawn_backend_and_wait` / `supervise_backend` against REAL dying
//! child processes (via the `OMNIVOICE_BACKEND_CMD` seam) and asserts the
//! user receives the CORRECT NAMED DIAGNOSIS — not merely that recovery
//! happened. Diagnosis quality is the bar: 61% of the historical "can't
//! reach the backend" class was closed undiagnosed.
//!
//! The scenario "backend" is this test binary re-invoking itself
//! (`scenario_child`), so exit codes, Unix signals, and pipe-close ordering
//! are the genuine OS articles on all three platforms — no system python,
//! no mocks of the behaviors under test.
//!
//! Every test mutates process-global state (env vars, the crash store, the
//! kill-intended flag), so they hold one mutex AND CI runs this binary with
//! `--test-threads=1`.

use std::io::{Read, Write};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::Listener;
use tauri::Manager;

use app_lib::bootstrap::{
    spawn_backend_and_wait, BootstrapStage, BootstrapState, LogPayload,
    set_backend_kill_intended,
};
use app_lib::{AppFlags, BackendState, CaptureDispatchState};

static HARNESS: Mutex<()> = Mutex::new(());

// ── Scenario child ────────────────────────────────────────────────────────

/// Not a real test: when `OMNIVOICE_SCENARIO` is set, this plays the backend
/// — optionally serving minimal HTTP on `OMNIVOICE_PORT`, printing a stderr
/// script, then dying the scripted death. A no-op in a normal test pass.
#[test]
fn scenario_child() {
    if std::env::var("OMNIVOICE_SCENARIO").is_err() {
        return;
    }
    let get = |k: &str| std::env::var(k).unwrap_or_default();
    let get_ms = |k: &str| get(k).parse::<u64>().ok();

    if let Some(delay) = get_ms("OMNIVOICE_SCENARIO_START_DELAY_MS") {
        std::thread::sleep(Duration::from_millis(delay));
    }

    // Serve /system/info + /profiles (the two probes behind backend_ready)
    // and /startup/progress (marker-stamped) for the given window; 0 = serve
    // forever.
    if let Some(serve_ms) = get_ms("OMNIVOICE_SCENARIO_SERVE_MS") {
        let port: u16 = get("OMNIVOICE_PORT").parse().expect("OMNIVOICE_PORT");
        let progress_only = get("OMNIVOICE_SCENARIO_PROGRESS_ONLY") == "1";
        let listener = std::net::TcpListener::bind(("127.0.0.1", port)).expect("bind scenario port");
        listener.set_nonblocking(true).unwrap();
        let deadline = if serve_ms == 0 {
            None
        } else {
            Some(Instant::now() + Duration::from_millis(serve_ms))
        };
        loop {
            if let Some(d) = deadline {
                if Instant::now() >= d {
                    break;
                }
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 512];
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let resp = if req.starts_with("GET /startup/progress") {
                        let body = r#"{"status": "starting", "step": "ml_imports", "label": "Loading ML runtime (PyTorch)_"}"#;
                        format!(
                            "HTTP/1.1 200 OK\r\nx-omnivoice-backend: 0.0.0\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(), body
                        )
                    } else if progress_only {
                        "HTTP/1.1 503 X\r\nContent-Length: 0\r\n\r\n".to_string()
                    } else if req.starts_with("GET /system/info") {
                        let body = r#"{"data_dir": "/x", "app_version": "0.0.0"}"#;
                        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}", body.len(), body)
                    } else {
                        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]".to_string()
                    };
                    let _ = stream.write_all(resp.as_bytes());
                }
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }

    let stderr_script = get("OMNIVOICE_SCENARIO_STDERR");
    if !stderr_script.is_empty() {
        // \n-encoded so a multi-line traceback fits in one env var.
        eprintln!("{}", stderr_script.replace("\\n", "\n"));
        let _ = std::io::stderr().flush();
        // Let the shell's drainer thread pull the pipe before death.
        std::thread::sleep(Duration::from_millis(150));
    }

    #[cfg(unix)]
    if get("OMNIVOICE_SCENARIO_SIGNAL") == "9" {
        unsafe { libc::raise(libc::SIGKILL) };
    }
    if let Some(code) = get_ms("OMNIVOICE_SCENARIO_EXIT") {
        std::process::exit(code as i32);
    }
    // Scripted to serve forever / be killed externally: idle out.
    std::thread::sleep(Duration::from_secs(600));
}

// ── Harness plumbing ──────────────────────────────────────────────────────

struct Scenario<'a> {
    stderr: &'a str,
    exit: Option<i32>,
    signal9: bool,
    serve_ms: Option<u64>,
    progress_only: bool,
}

impl Default for Scenario<'_> {
    fn default() -> Self {
        Scenario { stderr: "", exit: None, signal9: false, serve_ms: None, progress_only: false }
    }
}

const SCENARIO_ENV: &[&str] = &[
    "OMNIVOICE_SCENARIO",
    "OMNIVOICE_SCENARIO_STDERR",
    "OMNIVOICE_SCENARIO_EXIT",
    "OMNIVOICE_SCENARIO_SIGNAL",
    "OMNIVOICE_SCENARIO_SERVE_MS",
    "OMNIVOICE_SCENARIO_PROGRESS_ONLY",
    "OMNIVOICE_SCENARIO_START_DELAY_MS",
    "OMNIVOICE_BACKEND_CMD",
    "OMNIVOICE_LOG_DIR",
    "OMNIVOICE_PORT",
    "OMNIVOICE_STARTUP_BUDGET_S",
    "OMNIVOICE_SUPERVISOR_POLL_MS",
];

struct TestApp {
    app: tauri::App<tauri::test::MockRuntime>,
    stage: Arc<Mutex<BootstrapStage>>,
    logs: Arc<Mutex<Vec<LogPayload>>>,
    _logdir: tempfile::TempDir,
    _guard: MutexGuard<'static, ()>,
}

impl TestApp {
    fn new(scenario: &Scenario) -> Self {
        let guard = HARNESS.lock().unwrap_or_else(|e| e.into_inner());
        for k in SCENARIO_ENV {
            std::env::remove_var(k);
        }
        // Reset the retry-flow flag a previous scenario may have left set.
        set_backend_kill_intended(false);

        let logdir = tempfile::tempdir().expect("logdir");
        std::env::set_var("OMNIVOICE_LOG_DIR", logdir.path());
        // Fresh ephemeral port per scenario.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        std::env::set_var("OMNIVOICE_PORT", port.to_string());
        std::env::set_var("OMNIVOICE_STARTUP_BUDGET_S", "6");
        std::env::set_var("OMNIVOICE_SUPERVISOR_POLL_MS", "100");

        let exe = std::env::current_exe().expect("current_exe");
        std::env::set_var(
            "OMNIVOICE_BACKEND_CMD",
            serde_json::to_string(&[
                exe.to_string_lossy().as_ref(),
                "scenario_child",
                "--exact",
                "--nocapture",
            ])
            .unwrap(),
        );
        std::env::set_var("OMNIVOICE_SCENARIO", "1");
        if !scenario.stderr.is_empty() {
            std::env::set_var("OMNIVOICE_SCENARIO_STDERR", scenario.stderr);
        }
        if let Some(code) = scenario.exit {
            std::env::set_var("OMNIVOICE_SCENARIO_EXIT", code.to_string());
        }
        if scenario.signal9 {
            std::env::set_var("OMNIVOICE_SCENARIO_SIGNAL", "9");
        }
        if let Some(ms) = scenario.serve_ms {
            std::env::set_var("OMNIVOICE_SCENARIO_SERVE_MS", ms.to_string());
        }
        if scenario.progress_only {
            std::env::set_var("OMNIVOICE_SCENARIO_PROGRESS_ONLY", "1");
        }

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(BackendState { process: Mutex::new(None), spawned_at: Mutex::new(None) });
        app.manage(AppFlags {
            quitting: AtomicBool::new(false),
            dictating: AtomicBool::new(false),
            capture: Mutex::new(CaptureDispatchState { ready: false, pending: None }),
        });
        let stage = Arc::new(Mutex::new(BootstrapStage::Checking));
        let logs: Arc<Mutex<Vec<LogPayload>>> = Arc::new(Mutex::new(Vec::new()));
        app.manage(BootstrapState { stage: stage.clone(), logs: logs.clone() });
        TestApp { app, stage, logs, _logdir: logdir, _guard: guard }
    }

    fn handle(&self) -> tauri::AppHandle<tauri::test::MockRuntime> {
        self.app.handle().clone()
    }

    /// Run the bootstrap on a thread; the returned closure joins it with a
    /// hard timeout so a wiring regression fails red instead of hanging CI.
    fn run_bootstrap(&self) -> std::thread::JoinHandle<()> {
        let handle = self.handle();
        let stage = self.stage.clone();
        std::thread::spawn(move || spawn_backend_and_wait(&handle, &stage))
    }

    fn stage_snapshot(&self) -> BootstrapStage {
        self.stage.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn failed_message(&self) -> Option<String> {
        match self.stage_snapshot() {
            BootstrapStage::Failed { message } => Some(message),
            _ => None,
        }
    }

    fn markers(&self) -> app_lib::crash::CrashStore {
        app_lib::crash::load_store_from(&app_lib::crash::markers_path())
    }

    fn record_events(&self, name: &'static str) -> Arc<Mutex<Vec<String>>> {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        self.app.handle().listen(name, move |_ev| {
            seen2.lock().unwrap_or_else(|e| e.into_inner()).push(name.to_string());
        });
        seen
    }

    fn kill_tracked_child(&self) {
        let state = self.app.state::<BackendState>();
        let guard = state.process.lock();
        if let Ok(mut guard) = guard {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    fn quit(&self) {
        self.app
            .state::<AppFlags>()
            .quitting
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        self.quit(); // stop any still-running supervisor loop promptly
        self.kill_tracked_child();
        for k in SCENARIO_ENV {
            std::env::remove_var(k);
        }
        set_backend_kill_intended(false);
    }
}

fn wait_until(timeout: Duration, mut pred: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn join_with_timeout(h: std::thread::JoinHandle<()>, timeout: Duration, what: &str) {
    let start = Instant::now();
    while !h.is_finished() {
        assert!(
            start.elapsed() < timeout,
            "{what}: bootstrap thread still running after {timeout:?} — a lifecycle \
             regression is hanging instead of diagnosing"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = h.join();
}

// ── Scenarios ─────────────────────────────────────────────────────────────

/// S1 — the backend exits EXIT_PORT_IN_USE: the user must read a port
/// conflict (in the exact phrasing BootstrapSplash.detectHints localizes),
/// not a traceback whose one meaningful line is an OS-translated errno.
#[test]
fn port_conflict_is_named_as_a_port_conflict() {
    let t = TestApp::new(&Scenario {
        stderr: "FATAL: port is already in use",
        exit: Some(app_lib::backend::EXIT_PORT_IN_USE),
        ..Default::default()
    });
    let h = t.run_bootstrap();
    join_with_timeout(h, Duration::from_secs(30), "port conflict");

    let msg = t.failed_message().expect("stage must be Failed");
    assert!(
        msg.contains("is already in use, so the backend could not"),
        "diagnosis must carry the detectHints-matchable port phrasing, got: {msg}"
    );
    let store = t.markers();
    assert_eq!(store.markers.len(), 1, "one real death → one marker");
    assert_eq!(store.markers.last().unwrap().exit_code, Some(app_lib::backend::EXIT_PORT_IN_USE));
}

/// S3 — generic startup traceback: the Failed message must carry the stderr
/// tail INCLUDING the chained-traceback root cause, and the marker must
/// record the death's shape.
#[test]
fn generic_traceback_surfaces_the_root_cause() {
    let t = TestApp::new(&Scenario {
        stderr: "Traceback (most recent call last):\\n  File \"main.py\", line 1\\nImportError: libcublas.so.12: cannot open shared object file\\n\\nThe above exception was the direct cause of the following exception:\\n\\nTraceback (most recent call last):\\n  File \"wrapper.py\", line 9\\nRuntimeError: failed to initialize CUDA backend",
        exit: Some(1),
        ..Default::default()
    });
    let h = t.run_bootstrap();
    join_with_timeout(h, Duration::from_secs(30), "generic traceback");

    let msg = t.failed_message().expect("stage must be Failed");
    assert!(msg.contains("Backend process exited"), "got: {msg}");
    assert!(
        msg.contains("libcublas.so.12"),
        "the root-cause line must survive into the diagnosis, got: {msg}"
    );
    let store = t.markers();
    assert_eq!(store.markers.len(), 1);
    let m = store.markers.last().unwrap();
    assert_eq!(m.exit_code, Some(1));
    assert!(m.last_stderr.contains("Traceback"), "marker carries the evidence");
    assert!(m.last_stderr.contains("libcublas.so.12"));
}

/// S4 — spawn failure (the program does not exist): the spawn diagnostic
/// must reach the user, and NO crash marker is written — nothing ever ran.
#[test]
fn spawn_failure_diagnoses_and_writes_no_bogus_marker() {
    let t = TestApp::new(&Scenario::default());
    // Point the seam at a program that cannot exist.
    let missing = t._logdir.path().join("no-such-backend");
    std::env::set_var(
        "OMNIVOICE_BACKEND_CMD",
        serde_json::to_string(&[missing.to_string_lossy().as_ref()]).unwrap(),
    );
    let h = t.run_bootstrap();
    join_with_timeout(h, Duration::from_secs(30), "spawn failure");

    let msg = t.failed_message().expect("stage must be Failed");
    assert!(
        msg.contains("Failed to launch the backend process"),
        "spawn_failure_diagnostic must reach the user, got: {msg}"
    );
    assert_eq!(
        t.markers().markers.len(),
        0,
        "never-started is not a crash — no marker may be written"
    );
}

/// S5 — slow start past the budget: the timeout diagnosis must name the
/// budget and carry the last stderr, and no death marker exists (the
/// process is alive, just slow).
#[test]
fn slow_start_times_out_with_the_last_stderr() {
    let t = TestApp::new(&Scenario {
        stderr: "Loading checkpoint shards_ 10%",
        serve_ms: None,
        ..Default::default()
    });
    // The child prints, then idles far past the 6s budget without serving.
    let h = t.run_bootstrap();
    join_with_timeout(h, Duration::from_secs(60), "slow start");

    let msg = t.failed_message().expect("stage must be Failed");
    assert!(msg.contains("did not respond within 6 s"), "got: {msg}");
    assert!(
        msg.contains("Loading checkpoint shards"),
        "the last stderr must ride along so triage sees WHERE it was, got: {msg}"
    );
    assert_eq!(t.markers().markers.len(), 0, "no death → no marker");
}

/// S6 — post-Ready crash loop: markers are recorded BEFORE each restart,
/// restarts are announced, and budget exhaustion lands on a Failed message
/// naming the pattern and the last exit.
#[test]
fn crash_loop_exhausts_the_budget_with_a_named_diagnosis() {
    let t = TestApp::new(&Scenario {
        stderr: "RuntimeError: CUDA error: out of memory",
        exit: Some(1),
        serve_ms: Some(1500),
        ..Default::default()
    });
    let restarts = t.record_events("backend-restarting");
    let gave_up = t.record_events("backend-restart-failed");
    let h = t.run_bootstrap();

    assert!(
        wait_until(Duration::from_secs(20), || matches!(
            t.stage_snapshot(),
            BootstrapStage::Ready | BootstrapStage::StartingBackend | BootstrapStage::Failed { .. }
        )),
        "backend never reached Ready"
    );
    join_with_timeout(h, Duration::from_secs(120), "crash loop");

    let msg = t.failed_message().expect("budget exhaustion must land on Failed");
    assert!(msg.contains("kept crashing"), "got: {msg}");
    assert!(msg.contains("exit code 1"), "the last death must be named, got: {msg}");
    assert_eq!(restarts.lock().unwrap().len(), 3, "3 respawns before giving up");
    assert_eq!(gave_up.lock().unwrap().len(), 1);
    let store = t.markers();
    assert!(
        !store.markers.is_empty(),
        "every real death records forensics BEFORE the restart decision"
    );
    assert!(
        store.markers.iter().all(|m| m.exit_code == Some(1)),
        "markers carry the actual exit"
    );
    assert!(
        store.markers.last().unwrap().last_stderr.contains("out of memory"),
        "the OOM evidence must be in the marker"
    );
}

/// S7 (unix) — SIGKILL (the OS OOM killer's signature): the death must be
/// named as signal 9, not exit-code noise.
#[cfg(unix)]
#[test]
fn sigkill_is_named_as_signal_nine() {
    let t = TestApp::new(&Scenario {
        signal9: true,
        serve_ms: Some(1500),
        ..Default::default()
    });
    let h = t.run_bootstrap();
    join_with_timeout(h, Duration::from_secs(120), "sigkill loop");

    let msg = t.failed_message().expect("stage must be Failed");
    assert!(msg.contains("signal 9"), "signal deaths must be named, got: {msg}");
    let store = t.markers();
    let m = store.markers.last().expect("marker written");
    assert_eq!(m.exit_code, None);
    assert_eq!(m.signal, Some(9));
}

/// S8 — a deliberate kill (Retry/Clean&Retry owns the respawn): the
/// supervisor must yield silently — no crash marker, no restart, the stage
/// never Failed.
#[test]
fn deliberate_kill_yields_without_a_crash_marker() {
    let t = TestApp::new(&Scenario {
        serve_ms: Some(0), // serve forever
        ..Default::default()
    });
    let restarts = t.record_events("backend-restarting");
    let h = t.run_bootstrap();

    assert!(
        wait_until(Duration::from_secs(20), || matches!(
            t.stage_snapshot(),
            BootstrapStage::Ready
        )),
        "backend never reached Ready"
    );
    let before = t.markers().markers.len();
    set_backend_kill_intended(true);
    t.kill_tracked_child();
    join_with_timeout(h, Duration::from_secs(30), "deliberate kill");

    assert_eq!(t.markers().markers.len(), before, "no marker for an intentional kill");
    assert_eq!(restarts.lock().unwrap().len(), 0, "no respawn — the retry flow owns it");
    assert!(
        matches!(t.stage_snapshot(), BootstrapStage::Ready),
        "the stage must never flip to Failed for a deliberate replace"
    );
}

/// S9 — early-bind narration + a deferred-startup FATAL: the splash log
/// narrates the step the backend reported, and when it dies the named step
/// reaches both the user-facing diagnosis and the crash forensics.
#[test]
fn deferred_startup_failure_names_the_step() {
    let t = TestApp::new(&Scenario {
        stderr: "Traceback (most recent call last):\\n  File \"main.py\"\\nImportError: torch\\nFATAL: backend startup failed during 'ml_imports': ImportError: torch",
        exit: Some(1),
        serve_ms: Some(1500),
        progress_only: true, // /startup/progress answers; health probes do not
        ..Default::default()
    });
    let h = t.run_bootstrap();
    join_with_timeout(h, Duration::from_secs(60), "deferred FATAL");

    let msg = t.failed_message().expect("stage must be Failed");
    assert!(
        msg.contains("FATAL: backend startup failed during 'ml_imports'"),
        "the named step must reach the user, got: {msg}"
    );
    let store = t.markers();
    assert!(store
        .markers
        .last()
        .expect("marker written")
        .last_stderr
        .contains("failed during 'ml_imports'"));
    let logs = t.logs.lock().unwrap_or_else(|e| e.into_inner());
    assert!(
        logs.iter().any(|l| l.line.contains("Startup: Loading ML runtime")),
        "the launch poll must narrate the step the backend reported; logs: {:?}",
        logs.iter().map(|l| &l.line).collect::<Vec<_>>()
    );
}
