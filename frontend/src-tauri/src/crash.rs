//! Backend crash forensics (#941).
//!
//! When the backend PROCESS dies (native CUDA abort, OOM kill, DLL crash),
//! the user used to see only "Can't reach the local OmniVoice backend" — and
//! the evidence (exit code, stderr tail) evaporated with the process. Every
//! such report was undiagnosable without asking for logs nobody sends.
//!
//! This module makes every backend death self-documenting: the death watchers
//! in `bootstrap.rs` (the startup health poll and the post-Ready supervisor)
//! call [`record_crash`] with the exit status and captured stderr tail, which
//! persists a small JSON **crash marker** next to the backend logs. The
//! frontend reads the newest marker via the `get_last_backend_crash` command
//! to replace the vague unreachable-toast with the honest story ("the backend
//! crashed (exit code X)…"), and the bug-report prefill attaches it so the
//! next #941-class GitHub issue arrives WITH the evidence.
//!
//! Only the last [`MAX_MARKERS`] crashes are kept. Acknowledgment is a
//! persisted timestamp (not deletion!) so viewing the crash details doesn't
//! destroy the evidence a subsequent bug report needs.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;

use serde::{Deserialize, Serialize};

/// How many crash markers to retain (newest first).
pub const MAX_MARKERS: usize = 3;

// ── Exit-status decomposition ──────────────────────────────────────────────

/// Structured view of how the backend child ended: the numeric exit code (or
/// Unix signal) for the marker, plus the human-readable `ExitStatus` display
/// for logs and bootstrap messages.
#[derive(Clone, Debug, PartialEq)]
pub struct BackendExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub description: String,
}

impl BackendExit {
    pub fn from_status(status: ExitStatus) -> Self {
        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            status.signal()
        };
        #[cfg(not(unix))]
        let signal = None;
        BackendExit { code: status.code(), signal, description: status.to_string() }
    }

    /// For deaths we can't decompose (`try_wait` errored).
    pub fn unknown(description: &str) -> Self {
        BackendExit { code: None, signal: None, description: description.to_string() }
    }

    /// Short human label — "exit code 3221226505" / "signal 6" — for messages.
    pub fn label(&self) -> String {
        match (self.code, self.signal) {
            (Some(c), _) => format!("exit code {}", c),
            (None, Some(s)) => format!("signal {}", s),
            (None, None) => self.description.clone(),
        }
    }
}

// ── Marker model ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CrashMarker {
    /// Unix seconds when the death was detected.
    pub ts: u64,
    /// Process exit code, when the OS reported one.
    pub exit_code: Option<i32>,
    /// Unix signal that killed the process (None on Windows / normal exits).
    pub signal: Option<i32>,
    /// Human-readable `ExitStatus` display ("exit status: 134", …).
    pub exit_desc: String,
    /// App/backend version (lockstep per the versioning rule).
    pub backend_version: String,
    /// Seconds the backend had been running when it died.
    pub uptime_s: u64,
    /// Tail of backend_err.log captured at death time.
    pub last_stderr: String,
}

/// The single on-disk store: newest-first markers plus the acknowledgment
/// watermark. One file keeps rotation + ack updates atomic-ish and avoids
/// filename collisions for same-second crashes.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CrashStore {
    /// `ts` of the newest marker the user has acknowledged (seen). Markers
    /// with `ts <= acked_ts` are "old news" for UI purposes but are retained
    /// for bug-report attachment.
    #[serde(default)]
    pub acked_ts: u64,
    /// Newest first, capped at [`MAX_MARKERS`].
    #[serde(default)]
    pub markers: Vec<CrashMarker>,
}

/// Prepend `marker` and keep only the newest [`MAX_MARKERS`]. Pure so the
/// rotation policy is unit-tested without touching the filesystem.
pub fn push_marker(store: &mut CrashStore, marker: CrashMarker) {
    store.markers.insert(0, marker);
    store.markers.truncate(MAX_MARKERS);
}

/// Newest marker + whether the user has already acknowledged it.
pub fn newest_with_ack(store: &CrashStore) -> Option<(CrashMarker, bool)> {
    store.markers.first().map(|m| (m.clone(), m.ts <= store.acked_ts))
}

// ── Persistence ────────────────────────────────────────────────────────────

/// The marker store lives next to the backend logs (same rationale: it's
/// forensic output of the backend process, discoverable alongside
/// backend.log / backend_err.log).
pub fn markers_path() -> PathBuf {
    crate::backend::backend_log_path().with_file_name("backend_crash_markers.json")
}

pub fn load_store_from(path: &Path) -> CrashStore {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_store_to(path: &Path, store: &CrashStore) {
    match serde_json::to_string_pretty(store) {
        Ok(json) => {
            if let Err(e) = fs::write(path, json) {
                log::warn!("Could not persist crash marker to {}: {}", path.display(), e);
            }
        }
        Err(e) => log::warn!("Could not serialize crash marker: {}", e),
    }
}

fn now_unix_s() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Build a marker for a death detected right now.
pub fn marker_now(exit: &BackendExit, uptime_s: u64, last_stderr: String) -> CrashMarker {
    CrashMarker {
        ts: now_unix_s(),
        exit_code: exit.code,
        signal: exit.signal,
        exit_desc: exit.description.clone(),
        backend_version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_s,
        last_stderr,
    }
}

/// Persist an unexpected backend death. Called by the death watchers in
/// `bootstrap.rs` AFTER they have ruled out intentional shutdowns (app quit,
/// deliberate retry/clean-retry kills).
pub fn record_crash(marker: CrashMarker) {
    log::error!(
        "Backend process died unexpectedly ({}, uptime {} s). Crash marker written. Stderr tail:\n{}",
        marker.exit_desc,
        marker.uptime_s,
        if marker.last_stderr.is_empty() { "<none captured>" } else { &marker.last_stderr },
    );
    let path = markers_path();
    let mut store = load_store_from(&path);
    push_marker(&mut store, marker);
    save_store_to(&path, &store);
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Newest crash marker + its acknowledgment state, as returned to the
/// frontend (`get_last_backend_crash`).
#[derive(Clone, Debug, Serialize)]
pub struct CrashNotice {
    #[serde(flatten)]
    pub marker: CrashMarker,
    pub acknowledged: bool,
}

/// Newest backend crash marker, or null when the backend has never crashed.
/// `acknowledged` tells the UI whether the user already viewed/dismissed it.
#[tauri::command]
pub fn get_last_backend_crash() -> Option<CrashNotice> {
    let store = load_store_from(&markers_path());
    newest_with_ack(&store).map(|(marker, acknowledged)| CrashNotice { marker, acknowledged })
}

/// Mark the newest crash as seen. Deliberately does NOT delete the marker —
/// the bug-report prefill still needs the evidence after the user viewed it.
#[tauri::command]
pub fn acknowledge_backend_crash() {
    let path = markers_path();
    let mut store = load_store_from(&path);
    if let Some(newest_ts) = store.markers.first().map(|m| m.ts) {
        if store.acked_ts < newest_ts {
            store.acked_ts = newest_ts;
            save_store_to(&path, &store);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(ts: u64) -> CrashMarker {
        CrashMarker {
            ts,
            exit_code: Some(1),
            signal: None,
            exit_desc: format!("exit status: 1 (#{ts})"),
            backend_version: "0.0.0-test".into(),
            uptime_s: 42,
            last_stderr: "Traceback…".into(),
        }
    }

    #[test]
    fn rotation_keeps_only_the_last_three_newest_first() {
        // #941: write 4 markers → only the newest MAX_MARKERS survive.
        let mut store = CrashStore::default();
        for ts in [1, 2, 3, 4] {
            push_marker(&mut store, marker(ts));
        }
        assert_eq!(store.markers.len(), MAX_MARKERS);
        let kept: Vec<u64> = store.markers.iter().map(|m| m.ts).collect();
        assert_eq!(kept, vec![4, 3, 2], "newest first, oldest dropped");
    }

    #[test]
    fn ack_semantics_survive_newer_crashes() {
        let mut store = CrashStore::default();
        push_marker(&mut store, marker(100));
        // Fresh crash → unacknowledged.
        let (m, acked) = newest_with_ack(&store).expect("has a marker");
        assert_eq!(m.ts, 100);
        assert!(!acked, "a fresh crash must be unacknowledged");
        // Viewing acks the newest…
        store.acked_ts = 100;
        assert!(newest_with_ack(&store).unwrap().1, "viewed crash is acknowledged");
        // …but a NEWER crash re-arms the notice, and the marker itself is
        // retained (evidence survives the ack — bug reports still attach it).
        push_marker(&mut store, marker(200));
        let (m2, acked2) = newest_with_ack(&store).unwrap();
        assert_eq!(m2.ts, 200);
        assert!(!acked2, "a newer crash must surface again");
        assert_eq!(store.markers.len(), 2, "ack never deletes markers");
    }

    #[test]
    fn store_roundtrips_through_json_and_defaults_when_missing() {
        let dir = std::env::temp_dir().join(format!("omnivoice-test-941-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("backend_crash_markers.json");

        // Missing file → default store, never an error (first run).
        assert_eq!(load_store_from(&path), CrashStore::default());
        // Corrupt file → default store (a truncated write must not wedge the
        // whole forensics path).
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load_store_from(&path), CrashStore::default());

        let mut store = CrashStore::default();
        push_marker(
            &mut store,
            CrashMarker {
                ts: 1,
                exit_code: None,
                signal: Some(6), // SIGABRT — the native-CUDA-abort shape
                exit_desc: "signal: 6 (SIGABRT)".into(),
                backend_version: "0.3.10".into(),
                uptime_s: 7,
                last_stderr: "CUDA error: an illegal memory access".into(),
            },
        );
        store.acked_ts = 0;
        save_store_to(&path, &store);
        let loaded = load_store_from(&path);
        assert_eq!(loaded, store, "Option fields (code=None, signal=Some) must roundtrip");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backend_exit_labels_code_signal_and_unknown() {
        let coded = BackendExit { code: Some(-1073740791), signal: None, description: "x".into() };
        assert_eq!(coded.label(), "exit code -1073740791");
        let signaled = BackendExit { code: None, signal: Some(9), description: "x".into() };
        assert_eq!(signaled.label(), "signal 9");
        let unknown = BackendExit::unknown("try_wait error: gone");
        assert_eq!(unknown.label(), "try_wait error: gone");
    }

    #[cfg(unix)]
    #[test]
    fn backend_exit_decomposes_real_exit_statuses() {
        use std::os::unix::process::ExitStatusExt;
        // Normal exit with code 3.
        let e = BackendExit::from_status(ExitStatus::from_raw(3 << 8));
        assert_eq!(e.code, Some(3));
        assert_eq!(e.signal, None);
        // Killed by SIGABRT (6) — code is None, signal carries the story.
        let k = BackendExit::from_status(ExitStatus::from_raw(6));
        assert_eq!(k.code, None);
        assert_eq!(k.signal, Some(6));
        assert_eq!(k.label(), "signal 6");
    }
}
