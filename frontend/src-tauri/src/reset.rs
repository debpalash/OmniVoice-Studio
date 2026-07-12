//! Scoped reset — Settings → Storage → "Reset & remove".
//!
//! Factory reset used to mean one thing: clear `localStorage`. That is the
//! *smallest* useful reset and it was the only one, so a user whose install had
//! gone wrong in any deeper way (a half-downloaded model, a wedged sidecar
//! engine, settings they could no longer find) had exactly two options — live
//! with it, or delete everything and start over. This module fills the gap with
//! a scope registry: every distinct thing OmniVoice writes to disk, sized, and
//! individually removable.
//!
//! **Why the shell and not the backend.** Two reasons the backend cannot do
//! this to itself:
//!   1. A loaded model memory-maps its weights straight out of the HF cache. On
//!      Windows those files are locked while mapped, so "delete the models" from
//!      inside the process that mapped them simply fails.
//!   2. `ensure_dirs()` runs at *import* time (backend/core/config.py). Delete
//!      `voices/` or `outputs/` under a live backend and nothing recreates them;
//!      every subsequent write lands in a missing directory.
//!   Plus the in-memory strays: `_dub_jobs`, batch `_jobs`, the media-tools
//!   version cache, the 5-minute storage-report cache — all of them would keep
//!   pointing at paths that no longer exist.
//!
//! So the shell stops the backend, deletes, and starts it again. That restart is
//! also what *repairs* the wipe: the fresh process re-runs `ensure_dirs()` and
//! alembic, so a removed database comes back empty rather than missing. This is
//! the same reason `uninstall.rs` lives here — but uninstall quits afterwards,
//! and a reset must leave the user with a working app.
//!
//! Safety: every target is resolved from the same single source of truth the
//! rest of the app uses (`setup::{resolved,default}_{data,models}_dir`,
//! `backend::backend_log_path`), and nothing is removed unless it sits inside a
//! *validated* root — one that either carries an OmniVoice-owned path component
//! or holds an actual OmniVoice signature file. A custom data dir on an external
//! volume passes on the signature; a mis-set `data_dir: "/"` passes on neither.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::bootstrap::BootstrapState;
use crate::{backend_port, AppFlags};

/// Every scope the UI can offer. Two of them (`ui_prefs`, `history`) own no
/// files — they are listed here so the frontend has one registry to render, but
/// they are cleared frontend-side (localStorage / the history DELETE endpoints)
/// and never reach `reset_purge`.
pub const FRONTEND_SCOPES: [&str; 2] = ["ui_prefs", "history"];

/// Scopes that delete files, in the order they are removed.
pub const DISK_SCOPES: [&str; 7] = [
    "settings", "content", "engines", "tools", "models", "caches", "logs",
];

#[derive(Serialize, Clone, Debug)]
pub struct ResetScope {
    /// Stable id the UI keys off.
    pub key: String,
    /// Concrete paths this scope would remove (empty for frontend-only scopes).
    pub paths: Vec<String>,
    pub size_bytes: u64,
    pub exists: bool,
    /// True only for the Hugging Face cache when it lives OUTSIDE our own tree —
    /// i.e. the standard `~/.cache/huggingface` other ML tools share. On Windows
    /// (and in a portable install) the cache is app-private, so this is false and
    /// the UI shows no scary caveat it doesn't need to.
    pub shared: bool,
    /// Frontend-only scopes need no backend bounce; disk scopes always do.
    pub needs_restart: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ResetReport {
    pub removed: Vec<String>,
    /// Paths that existed but could not be removed (locked, permissions).
    pub failed: Vec<String>,
    /// Paths the safety guard rejected — a bug or a corrupt config, never routine.
    pub refused: Vec<String>,
    pub freed_bytes: u64,
    /// True when the backend was stopped and re-launched.
    pub restarted: bool,
}

/// The four directories every scope is carved out of. Kept as a plain struct so
/// target resolution is pure and unit-testable without an `AppHandle`.
#[derive(Clone, Debug)]
pub struct Roots {
    pub data: PathBuf,
    pub models: PathBuf,
    /// The backend's own log dir — outside DATA_DIR on every platform.
    pub logs: Option<PathBuf>,
    pub temp: PathBuf,
}

/// Recursive size. Symlinks are never followed: the HF cache is a forest of
/// symlinks into `blobs/`, and following them would count the same bytes twice
/// (and could wander clean out of the tree).
fn dir_size(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    if path.is_file() {
        return fs::symlink_metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Children of `dir` whose file name starts with `prefix`. This is how the
/// SQLite trio (`omnivoice.db`, `-wal`, `-shm`) and the rolling logs
/// (`omnivoice.log`, `.log.1`, …) are caught without a glob crate — and why the
/// expansion is re-run at purge time rather than trusting the scan: WAL siblings
/// come and go while the backend is still alive.
fn prefixed_children(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.starts_with(prefix))
                .unwrap_or(false)
        })
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

/// True when the model cache sits inside our own tree, so wiping it cannot touch
/// another tool's downloads: Windows redirects it to
/// `%LOCALAPPDATA%\OmniVoice\hf_cache` (MAX_PATH), and a portable install keeps
/// it under `<portable>/data/models`. Anywhere else it is the shared HF cache.
pub fn models_are_shared(models: &Path, data: &Path) -> bool {
    if models.starts_with(data) {
        return false;
    }
    let owned = ["omnivoice", ".omnivoice"];
    let app_private = models
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .any(|c| owned.iter().any(|o| c.eq_ignore_ascii_case(o)));
    !app_private
}

/// Does this directory actually look like OmniVoice's? Used to clear a *custom*
/// data or model dir — one the user pointed us at, whose path carries no
/// OmniVoice-ish name — without also clearing whatever else a mis-configured
/// path might point at. Presence of our own files is the proof of ownership.
fn has_app_signature(dir: &Path) -> bool {
    for marker in ["omnivoice.db", "prefs.json", "voices", "outputs", "engines"] {
        if dir.join(marker).exists() {
            return true;
        }
    }
    // A Hugging Face cache root: `hub/` or a `models--org--name` snapshot dir.
    if dir.join("hub").is_dir() {
        return true;
    }
    fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("models--"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// A root may only be deleted out of if it is absolute, is not `/` or `$HOME`,
/// is not a bare top-level directory, and is recognizably ours — by name, or by
/// the files it contains. This is the backstop between a corrupt `config.json`
/// and `remove_dir_all`.
pub fn is_valid_root(root: &Path, home: Option<&Path>) -> bool {
    if !root.is_absolute() || root.parent().is_none() {
        return false;
    }
    if home == Some(root) {
        return false;
    }
    // "/Users" or "C:\" — never a data dir, always a catastrophe.
    if root.components().count() < 3 {
        return false;
    }
    crate::uninstall::is_recognizably_ours(root, home) || has_app_signature(root)
}

/// Files and directories a scope owns. Pure: `Roots` in, paths out. Paths that
/// do not exist are included — the caller filters — so the scan can report an
/// empty scope rather than silently omitting it.
pub fn scope_targets(key: &str, roots: &Roots) -> Vec<PathBuf> {
    let data = &roots.data;
    match key {
        // prefs.json only. The user's *storage locations* (config.json, the
        // ~/.config/omnivoice/env file) are deliberately NOT reset: they are
        // install-shape choices, not preferences, and clearing the model-cache
        // pointer would strand gigabytes of already-downloaded weights at a path
        // the app no longer looks in. Same principle as PRESERVED_KEYS on the
        // frontend (the remote-backend URL survives a preference reset).
        "settings" => vec![data.join("prefs.json")],

        // Everything the user made. The database goes with it — history, voice
        // profiles, projects, glossary and pronunciation entries all live in it,
        // and half-deleting it (rows without files) is how you get a library full
        // of broken entries. A fresh backend recreates the schema via alembic.
        "content" => {
            let mut v = vec![
                data.join("voices"),
                data.join("outputs"),
                data.join("dub_jobs"),
                data.join("batch"),
                data.join("preview"),
            ];
            v.extend(prefixed_children(data, "omnivoice.db"));
            v
        }

        // Sidecar engine installs (IndexTTS-2 & friends): a git checkout, a venv
        // and multi-GB weights each, under DATA_DIR/engines/<id>.
        "engines" => vec![data.join("engines")],

        // Checksum-pinned ffmpeg/ffprobe/yt-dlp binaries the app fetched itself.
        "tools" => vec![data.join("media_tools")],

        "models" => vec![roots.models.clone()],

        "caches" => {
            let mut v = vec![data.join("gallery_cache"), data.join("gallery_sources.json")];
            // Scratch dirs the app leaves in the OS temp dir. The `omnivoice`
            // name prefix IS the guard here — these live outside every root.
            v.extend(prefixed_children(&roots.temp, "omnivoice"));
            v
        }

        "logs" => {
            let mut v = vec![
                data.join("crash_log.txt"),
                data.join("error_journal.jsonl"),
            ];
            v.extend(prefixed_children(data, "omnivoice.log"));
            if let Some(logs) = &roots.logs {
                v.push(logs.clone());
            }
            v
        }

        _ => vec![],
    }
}

/// Is this target safe to remove? It must sit inside a validated root — or, for
/// the OS temp scratch dirs which live outside every root, be a direct child of
/// the temp dir carrying our name prefix.
fn target_allowed(path: &Path, roots: &Roots, home: Option<&Path>) -> bool {
    if path.parent() == Some(roots.temp.as_path()) {
        return path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("omnivoice"))
            .unwrap_or(false);
    }
    for root in [Some(&roots.data), Some(&roots.models), roots.logs.as_ref()]
        .into_iter()
        .flatten()
    {
        if path.starts_with(root) && is_valid_root(root, home) {
            return true;
        }
    }
    false
}

fn roots_for(app: &tauri::AppHandle) -> Roots {
    Roots {
        data: crate::setup::resolved_data_dir(app).unwrap_or_else(crate::setup::default_data_dir),
        models: crate::setup::resolved_models_dir(app)
            .unwrap_or_else(crate::setup::default_models_dir),
        logs: crate::backend::backend_log_path()
            .parent()
            .map(|p| p.to_path_buf()),
        temp: std::env::temp_dir(),
    }
}

/// Every scope with its real size — what the confirmation UI renders. Sizes are
/// what make this honest: "Reset everything" next to a number the user can check
/// against the disk beats a wall of adjectives.
#[tauri::command]
pub async fn reset_scan(app: tauri::AppHandle) -> Vec<ResetScope> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots = roots_for(&app);
        let shared = models_are_shared(&roots.models, &roots.data);
        let mut out = Vec::new();

        for key in FRONTEND_SCOPES {
            out.push(ResetScope {
                key: key.to_string(),
                paths: vec![],
                size_bytes: 0,
                exists: true,
                shared: false,
                needs_restart: false,
            });
        }

        for key in DISK_SCOPES {
            let targets = scope_targets(key, &roots);
            let present: Vec<&PathBuf> = targets.iter().filter(|p| p.exists()).collect();
            out.push(ResetScope {
                key: key.to_string(),
                size_bytes: present.iter().map(|p| dir_size(p)).sum(),
                exists: !present.is_empty(),
                paths: present.iter().map(|p| p.to_string_lossy().to_string()).collect(),
                shared: key == "models" && shared,
                needs_restart: true,
            });
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// The destructive core: delete every target of every wanted scope, guarding
/// each path against the validated roots. Pure over the filesystem — no
/// `AppHandle`, no backend — so it can be exercised end-to-end against a real
/// on-disk OmniVoice tree in a test. `reset_purge` is this plus stop-backend
/// before and restart-backend after.
///
/// `wanted` is assumed already filtered to `DISK_SCOPES`; unknown names yield no
/// targets and are harmless.
pub fn purge_scopes(roots: &Roots, wanted: &[String], home: Option<&Path>) -> ResetReport {
    let mut report = ResetReport::default();
    for key in DISK_SCOPES.iter().filter(|k| wanted.iter().any(|w| w == *k)) {
        for path in scope_targets(key, roots) {
            if !path.exists() {
                continue;
            }
            if !target_allowed(&path, roots, home) {
                log::warn!("reset: refusing to delete unrecognized path {}", path.display());
                report.refused.push(path.to_string_lossy().to_string());
                continue;
            }
            let size = dir_size(&path);
            let outcome = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            match outcome {
                Ok(()) => {
                    log::info!("reset[{key}]: removed {}", path.display());
                    report.freed_bytes += size;
                    report.removed.push(path.to_string_lossy().to_string());
                }
                Err(e) => {
                    log::error!("reset[{key}]: failed to remove {}: {e}", path.display());
                    report.failed.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    report
}

/// Delete the selected scopes, then bring the backend back.
///
/// Unknown or frontend-only scope names are ignored rather than erroring: the
/// frontend sends one list for the whole reset, and `ui_prefs` / `history` are
/// its own to handle.
#[tauri::command]
pub async fn reset_purge(app: tauri::AppHandle, scopes: Vec<String>) -> Result<ResetReport, String> {
    let wanted: Vec<String> = scopes
        .into_iter()
        .filter(|s| DISK_SCOPES.contains(&s.as_str()))
        .collect();

    let mut report = ResetReport::default();
    if wanted.is_empty() {
        return Ok(report);
    }

    // Stop the backend first. `set_backend_kill_intended` tells the #941/#567
    // supervisor this death is deliberate, so it neither writes a crash marker
    // nor races us by respawning a backend into the directories we are deleting.
    // Note we do NOT set `flags.quitting` — that is the uninstall path, and it
    // would stop us from starting the backend again at the end.
    crate::bootstrap::set_backend_kill_intended(true);
    crate::backend::kill_orphan_on_port(backend_port());

    let purge_app = app.clone();
    let mut report = tauri::async_runtime::spawn_blocking(move || {
        // Give the process a moment to actually exit and drop its file handles;
        // on Windows a mapped weights file stays locked until it does.
        std::thread::sleep(std::time::Duration::from_millis(600));

        let roots = roots_for(&purge_app);
        let home = dirs_next::home_dir();
        purge_scopes(&roots, &wanted, home.as_deref())
    })
    .await
    .map_err(|e| format!("reset failed: {e}"))?;

    // Back up. The fresh backend re-runs ensure_dirs() and alembic, so a deleted
    // database returns empty instead of missing. If the app is on its way out
    // anyway, don't fight the shutdown.
    let flags = app.state::<AppFlags>();
    if !flags.quitting.load(std::sync::atomic::Ordering::SeqCst) {
        let state = app.state::<BootstrapState>();
        crate::bootstrap::respawn_backend(app.clone(), state.stage.clone(), state.logs.clone());
        report.restarted = true;
    } else {
        crate::bootstrap::set_backend_kill_intended(false);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(tmp: &Path) -> Roots {
        Roots {
            data: tmp.join("OmniVoice"),
            models: tmp.join(".cache/huggingface"),
            logs: Some(tmp.join("Logs/OmniVoice")),
            temp: tmp.join("tmp"),
        }
    }

    #[test]
    fn content_scope_takes_the_database_with_the_media() {
        let dir = tempfile::tempdir().unwrap();
        let r = roots(dir.path());
        fs::create_dir_all(&r.data).unwrap();
        for f in ["omnivoice.db", "omnivoice.db-wal", "omnivoice.db-shm"] {
            fs::write(r.data.join(f), b"x").unwrap();
        }
        let targets = scope_targets("content", &r);
        // Rows and files go together, or the library fills with broken entries.
        for expect in ["voices", "outputs", "dub_jobs", "omnivoice.db", "omnivoice.db-wal"] {
            assert!(
                targets.iter().any(|p| p.ends_with(expect)),
                "content scope must cover {expect}"
            );
        }
    }

    #[test]
    fn settings_scope_spares_the_storage_locations() {
        let dir = tempfile::tempdir().unwrap();
        let r = roots(dir.path());
        let targets = scope_targets("settings", &r);
        assert_eq!(targets, vec![r.data.join("prefs.json")]);
        // Resetting preferences must never move the model cache: config.json and
        // the user env file are install shape, not preference.
        assert!(!targets.iter().any(|p| p.ends_with("config.json")));
    }

    #[test]
    fn logs_scope_reaches_the_backend_log_dir_outside_data() {
        let dir = tempfile::tempdir().unwrap();
        let r = roots(dir.path());
        let targets = scope_targets("logs", &r);
        assert!(targets.iter().any(|p| Some(p.as_path()) == r.logs.as_deref()));
        assert!(targets.iter().any(|p| p.ends_with("crash_log.txt")));
    }

    #[test]
    fn unknown_scope_is_inert() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scope_targets("rm -rf /", &roots(dir.path())).is_empty());
        assert!(scope_targets("ui_prefs", &roots(dir.path())).is_empty());
    }

    #[test]
    fn hf_cache_is_shared_only_when_it_sits_outside_our_tree() {
        // macOS / Linux: the standard cache, shared with every other HF tool.
        assert!(models_are_shared(
            Path::new("/Users/me/.cache/huggingface"),
            Path::new("/Users/me/Library/Application Support/OmniVoice")
        ));
        // Windows: redirected into our own dir to dodge MAX_PATH → app-private.
        assert!(!models_are_shared(
            Path::new("C:/Users/me/AppData/Local/OmniVoice/hf_cache"),
            Path::new("C:/Users/me/AppData/Roaming/OmniVoice")
        ));
        // Portable: models live under the portable data dir → app-private.
        assert!(!models_are_shared(
            Path::new("/Volumes/USB/OmniVoiceStudio/data/models"),
            Path::new("/Volumes/USB/OmniVoiceStudio/data")
        ));
    }

    #[test]
    fn a_custom_data_dir_qualifies_on_its_contents_not_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let custom = dir.path().join("my stuff");
        fs::create_dir_all(&custom).unwrap();
        // Nothing OmniVoice-ish in the name and no signature yet → refuse.
        assert!(!is_valid_root(&custom, None));
        // The app's own database is proof enough that this dir is ours.
        fs::write(custom.join("omnivoice.db"), b"x").unwrap();
        assert!(is_valid_root(&custom, None));
    }

    #[test]
    fn never_root_never_home_never_a_top_level_dir() {
        let home = PathBuf::from("/Users/someone");
        assert!(!is_valid_root(Path::new("/"), Some(&home)));
        assert!(!is_valid_root(&home, Some(&home)));
        assert!(!is_valid_root(Path::new("/Users"), Some(&home)));
        assert!(!is_valid_root(Path::new("relative/omnivoice"), None));
    }

    #[test]
    fn targets_outside_every_root_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let r = roots(dir.path());
        fs::create_dir_all(&r.data).unwrap();
        fs::write(r.data.join("omnivoice.db"), b"x").unwrap();

        assert!(target_allowed(&r.data.join("voices"), &r, None));
        // A path that is not under data, models, or logs — the guard's whole job.
        assert!(!target_allowed(Path::new("/etc/passwd"), &r, None));
        assert!(!target_allowed(&dir.path().join("Documents"), &r, None));
    }

    #[test]
    fn temp_scratch_is_guarded_by_its_name_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let r = roots(dir.path());
        fs::create_dir_all(&r.temp).unwrap();
        assert!(target_allowed(&r.temp.join("omnivoice_dub_42"), &r, None));
        // Somebody else's scratch dir in the same temp root.
        assert!(!target_allowed(&r.temp.join("com.apple.something"), &r, None));
    }

    // ── End-to-end deletion against a real on-disk tree ───────────────────────
    //
    // Everything above tests target RESOLUTION; these run the actual
    // `fs::remove_*` loop against a filesystem that looks like a real install, so
    // the destructive path is exercised for real (not mocked) before it ever
    // touches a user's machine.

    /// Build a tree that mirrors a lived-in OmniVoice install and return `Roots`.
    fn seed_install(base: &Path) -> Roots {
        let data = base.join("OmniVoice");
        let models = base.join(".cache").join("huggingface");
        let logs = base.join("Logs").join("OmniVoice");
        let temp = base.join("tmp");
        let mk = |p: &Path| fs::create_dir_all(p).unwrap();
        let touch = |p: PathBuf, n: usize| {
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, vec![b'x'; n]).unwrap();
        };

        // content
        touch(data.join("voices").join("alice.wav"), 4096);
        touch(data.join("outputs").join("take1.wav"), 8192);
        touch(data.join("dub_jobs").join("job1").join("seg_0.wav"), 2048);
        touch(data.join("preview").join("p.wav"), 512);
        for f in ["omnivoice.db", "omnivoice.db-wal", "omnivoice.db-shm"] {
            touch(data.join(f), 1024);
        }
        // settings + install-shape files that must SURVIVE a settings reset
        touch(data.join("prefs.json"), 200);
        touch(data.join("config.json"), 100);
        // engines / tools / caches / logs
        touch(data.join("engines").join("indextts2").join(".venv").join("pyvenv.cfg"), 64);
        touch(data.join("media_tools").join("ffbin-abc").join("ffmpeg"), 4096);
        touch(data.join("gallery_cache").join("thumb.png"), 256);
        touch(data.join("gallery_sources.json"), 64);
        touch(data.join("crash_log.txt"), 128);
        touch(data.join("error_journal.jsonl"), 128);
        touch(data.join("omnivoice.log"), 512);
        touch(data.join("omnivoice.log.1"), 512);
        mk(&logs);
        touch(logs.join("backend.log"), 256);
        // models (shared HF cache)
        touch(models.join("hub").join("models--org--x").join("snapshot").join("w.bin"), 16384);
        // temp scratch — ours and a stranger's
        touch(temp.join("omnivoice_scratch").join("f"), 128);
        touch(temp.join("com.apple.keep").join("f"), 128);

        Roots { data, models, logs: Some(logs), temp }
    }

    #[test]
    fn everything_scope_wipes_the_install_but_leaves_the_python_env_and_foreign_files() {
        let dir = tempfile::tempdir().unwrap();
        let roots = seed_install(dir.path());

        // A neighbour dir the user also keeps under the same parent, and the
        // managed Python env that a RESET (unlike uninstall) must never remove.
        let neighbour = dir.path().join("Documents");
        fs::create_dir_all(neighbour.join("thesis")).unwrap();
        let env = dir.path().join("com.debpalash.omnivoice-studio");
        fs::create_dir_all(env.join("project").join(".venv")).unwrap();

        // "Everything OmniVoice did" minus the frontend-only scopes.
        let wanted: Vec<String> =
            ["settings", "content", "engines", "tools", "models", "caches", "logs"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        let report = purge_scopes(&roots, &wanted, dir.path().to_str().map(Path::new));

        // The install is gone…
        for gone in [
            roots.data.join("voices"),
            roots.data.join("outputs"),
            roots.data.join("omnivoice.db"),
            roots.data.join("omnivoice.db-wal"),
            roots.data.join("prefs.json"),
            roots.data.join("engines"),
            roots.data.join("media_tools"),
            roots.data.join("gallery_cache"),
            roots.data.join("crash_log.txt"),
            roots.data.join("omnivoice.log"),
            roots.models.clone(),
            roots.logs.clone().unwrap(),
            roots.temp.join("omnivoice_scratch"),
        ] {
            assert!(!gone.exists(), "should have been removed: {}", gone.display());
        }

        // …but the Python env, a stranger's temp dir, and the user's neighbour
        // folder are untouched.
        assert!(env.join("project").join(".venv").exists(), "reset must not touch the venv");
        assert!(roots.temp.join("com.apple.keep").exists(), "another app's scratch is off-limits");
        assert!(neighbour.join("thesis").exists(), "a sibling user folder must survive");

        assert!(report.refused.is_empty(), "nothing legitimate should be refused: {:?}", report.refused);
        assert!(report.failed.is_empty(), "no deletion should fail: {:?}", report.failed);
        assert!(report.freed_bytes > 16_000, "freed byte count should reflect the models blob");
    }

    #[test]
    fn settings_reset_keeps_content_the_env_pointer_and_the_models() {
        let dir = tempfile::tempdir().unwrap();
        let roots = seed_install(dir.path());

        let report = purge_scopes(&roots, &["settings".to_string()], dir.path().to_str().map(Path::new));

        // prefs.json is gone; everything that is data or install-shape stays.
        assert!(!roots.data.join("prefs.json").exists());
        assert!(roots.data.join("config.json").exists(), "storage-location choice must survive");
        assert!(roots.data.join("voices").join("alice.wav").exists(), "voices are not a preference");
        assert!(roots.data.join("omnivoice.db").exists(), "the database is not a preference");
        assert!(roots.models.join("hub").exists(), "a settings reset must not delete model weights");
        assert_eq!(report.removed.len(), 1);
    }

    #[test]
    fn a_poisoned_data_dir_pointing_at_home_deletes_nothing() {
        // If config.json were corrupted to data_dir="$HOME", every target resolves
        // under $HOME and the guard must refuse the lot rather than wipe it.
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        fs::create_dir_all(home.join("Pictures")).unwrap();
        let roots = Roots {
            data: home.clone(),
            models: home.join(".cache/huggingface"),
            logs: Some(home.join("Logs/OmniVoice")),
            temp: home.join("tmp"),
        };
        // Make the resolved targets exist so only the guard stands between them
        // and deletion.
        fs::create_dir_all(home.join("voices")).unwrap();
        fs::write(home.join("prefs.json"), b"x").unwrap();

        let report = purge_scopes(
            &roots,
            &["settings".to_string(), "content".to_string()],
            Some(home.as_path()),
        );

        assert!(home.join("Pictures").exists(), "$HOME contents must be untouched");
        assert!(home.join("prefs.json").exists(), "guard must refuse a data dir that IS $HOME");
        assert!(report.removed.is_empty());
        assert!(!report.refused.is_empty(), "the refusal must be recorded, not silent");
    }
}
