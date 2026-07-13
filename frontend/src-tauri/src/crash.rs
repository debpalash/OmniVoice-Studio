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
//!
//! Markers are **version-gated**: each records the app version that wrote it,
//! and markers from a different release than the running build are ignored on
//! read — an unacknowledged "backend crashed" notice must not resurface after
//! the upgrade that may well have fixed the crash. Stale markers are pruned
//! from disk by the WRITE paths only ([`record_crash`], the ack command):
//! the read path must never write, because it is polled concurrently with
//! the death watchers (see [`get_last_backend_crash`]).

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
    /// App/backend version (lockstep per the versioning rule) that recorded
    /// this marker. `#[serde(default)]` so a legacy marker written before
    /// this field was version-gated still deserializes (as `""`) instead of
    /// discarding the whole store — and `""` never matches the running
    /// version, so legacy markers are treated as stale. That's the safe
    /// default: a marker of unknown provenance may predate the running
    /// build, and a stale post-upgrade crash notice is exactly the bug the
    /// gate exists to prevent.
    #[serde(default)]
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

// ── Version gating ─────────────────────────────────────────────────────────

/// The release part of a version — `"0.3.22-7"` (preview stamp) → `"0.3.22"`.
fn base_version(version: &str) -> &str {
    version.split(['-', '+']).next().unwrap_or(version)
}

/// Whether a marker written by `marker_version` is still current news for an
/// app running `current_version`. Preview builds stamp `X.Y.Z-N` onto the
/// same release, so only the base version has to match. A legacy marker with
/// no recorded version deserializes as `""` and never matches — stale by
/// design (see the `backend_version` field docs).
fn same_release(marker_version: &str, current_version: &str) -> bool {
    !marker_version.is_empty() && base_version(marker_version) == base_version(current_version)
}

/// Drop markers recorded by a different release than `current_version` —
/// after an upgrade they describe a build the user no longer runs (quite
/// possibly the build whose crash the upgrade fixed), so neither the crash
/// notice nor the bug-report prefill should surface them. Returns whether
/// anything was dropped. Pure, like [`push_marker`], so the policy is
/// unit-tested without the filesystem. Only WRITE paths may persist the
/// pruned store — see [`read_notice_from`] for why the read path must not.
pub fn prune_stale_versions(store: &mut CrashStore, current_version: &str) -> bool {
    let before = store.markers.len();
    store.markers.retain(|m| same_release(&m.backend_version, current_version));
    store.markers.len() != before
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
    // A fresh crash also retires markers from older releases: the version
    // gate below would never surface them again, and they shouldn't occupy
    // rotation slots the current release's evidence needs.
    prune_stale_versions(&mut store, env!("CARGO_PKG_VERSION"));
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

/// Read half of [`get_last_backend_crash`], parameterized over path/version
/// so the read-only contract is unit-testable.
///
/// STRICTLY READ-ONLY — stale-version markers are filtered in memory, never
/// pruned to disk here. The frontend polls this command every second for 8 s
/// after a stream drops (#1119's `streamDropError`) — i.e. exactly while the
/// death watcher may be inside `record_crash`'s load→push→save. A
/// load→prune→save here could interleave with that write and clobber the
/// fresh marker with our older snapshot, destroying the only evidence of the
/// crash (Greptile P1 on #1145). Disk cleanup of stale markers happens on
/// the write paths instead ([`record_crash`], `acknowledge_backend_crash`),
/// where a crash-vs-ack collision was already the pre-existing (rare,
/// user-paced) exposure.
pub fn read_notice_from(path: &Path, current_version: &str) -> Option<CrashNotice> {
    let mut store = load_store_from(path);
    prune_stale_versions(&mut store, current_version);
    newest_with_ack(&store).map(|(marker, acknowledged)| CrashNotice { marker, acknowledged })
}

/// Newest backend crash marker, or null when the backend has never crashed.
/// `acknowledged` tells the UI whether the user already viewed/dismissed it.
/// Markers from a different release than this build are ignored, so one
/// stale unacknowledged crash can't resurface after an upgrade (recurrence
/// audit follow-up to #941).
#[tauri::command]
pub fn get_last_backend_crash() -> Option<CrashNotice> {
    read_notice_from(&markers_path(), env!("CARGO_PKG_VERSION"))
}

/// Mark the newest crash as seen. Deliberately does NOT delete the marker —
/// the bug-report prefill still needs the evidence after the user viewed it.
#[tauri::command]
pub fn acknowledge_backend_crash() {
    let path = markers_path();
    let mut store = load_store_from(&path);
    // Same gate as the read path, so the ack lands on the marker the user
    // actually saw — never on a stale one from a previous release.
    let mut dirty = prune_stale_versions(&mut store, env!("CARGO_PKG_VERSION"));
    if let Some(newest_ts) = store.markers.first().map(|m| m.ts) {
        if store.acked_ts < newest_ts {
            store.acked_ts = newest_ts;
            dirty = true;
        }
    }
    if dirty {
        save_store_to(&path, &store);
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
    fn same_release_matches_previews_and_rejects_versionless() {
        // Preview builds stamp X.Y.Z-N (run number) on the same release — a
        // crash under 0.3.22-7 is current news for 0.3.22 and 0.3.22-9 alike.
        assert!(same_release("0.3.22-7", "0.3.22"));
        assert!(same_release("0.3.22", "0.3.22-9"));
        assert!(same_release("0.3.22+meta", "0.3.22"));
        assert!(!same_release("0.3.21", "0.3.22"), "older release is stale");
        assert!(!same_release("", "0.3.22"), "no recorded version = stale");
    }

    #[test]
    fn current_release_markers_survive_the_version_gate() {
        let mut store = CrashStore::default();
        push_marker(&mut store, marker(100)); // backend_version "0.0.0-test"
        assert!(
            !prune_stale_versions(&mut store, "0.0.0"),
            "same release (modulo preview stamp) → nothing pruned"
        );
        let (m, acked) = newest_with_ack(&store).expect("current-release marker surfaces");
        assert_eq!(m.ts, 100);
        assert!(!acked);
    }

    #[test]
    fn different_release_markers_are_ignored_and_pruned() {
        // The post-upgrade scenario: an unacknowledged crash from the build
        // the user just upgraded away from must not surface as if the new
        // build had crashed.
        let mut store = CrashStore::default();
        push_marker(&mut store, marker(100)); // "0.0.0-test" — the old build
        let mut current = marker(50);
        current.backend_version = "9.9.9".into();
        push_marker(&mut store, current);
        assert!(prune_stale_versions(&mut store, "9.9.9"), "stale marker dropped");
        let kept: Vec<&str> = store.markers.iter().map(|m| m.backend_version.as_str()).collect();
        assert_eq!(kept, vec!["9.9.9"], "only the running release's evidence remains");
    }

    #[test]
    fn legacy_versionless_markers_deserialize_and_are_stale() {
        // A marker JSON with no backend_version at all must (a) not wedge
        // deserialization of the whole store and (b) never surface: with no
        // provenance it may predate the running build, and a stale
        // post-upgrade crash notice is exactly the bug the gate prevents.
        let json = r#"{"acked_ts":0,"markers":[{"ts":1,"exit_code":1,"signal":null,"exit_desc":"exit status: 1","uptime_s":5,"last_stderr":""}]}"#;
        let mut store: CrashStore = serde_json::from_str(json).expect("legacy shape still loads");
        assert_eq!(store.markers[0].backend_version, "", "serde default fills the gap");
        assert!(prune_stale_versions(&mut store, "0.3.22"));
        assert!(newest_with_ack(&store).is_none(), "legacy marker never surfaces");
    }

    #[test]
    fn the_read_path_filters_stale_markers_without_touching_the_file() {
        // Greptile P1 on #1145: the frontend polls get_last_backend_crash
        // every second while the death watcher may be mid-record_crash. If
        // the read path persisted its prune, that save could interleave with
        // the watcher's and clobber the brand-new marker with an older
        // snapshot. Contract: reading filters in memory and NEVER writes.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backend_crash_markers.json");
        let mut store = CrashStore::default();
        push_marker(&mut store, marker(100)); // "0.0.0-test" — a stale release
        save_store_to(&path, &store);
        let before = fs::read(&path).unwrap();

        // Stale marker is invisible to the notice…
        assert!(read_notice_from(&path, "9.9.9").is_none());
        // …but the file is byte-identical: the read left the store alone, so
        // a marker recorded concurrently could not have been overwritten.
        assert_eq!(fs::read(&path).unwrap(), before, "read path must not write");

        // And a current-release marker still surfaces over the stale one.
        let mut current = marker(200);
        current.backend_version = "9.9.9".into();
        push_marker(&mut store, current);
        save_store_to(&path, &store);
        let before = fs::read(&path).unwrap();
        let notice = read_notice_from(&path, "9.9.9").expect("current marker surfaces");
        assert_eq!(notice.marker.ts, 200);
        assert!(!notice.acknowledged);
        assert_eq!(fs::read(&path).unwrap(), before, "read path must not write");
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
