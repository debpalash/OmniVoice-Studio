//! Batch watch-folder IPC: native folder pick + polling scan + byte reads.
//!
//! The watcher lives entirely on the client side of the app: the webview asks
//! this module (over Tauri IPC, never HTTP) for directory listings and file
//! bytes, wraps the bytes in a `File`, and uploads them through the existing
//! `POST /batch/enqueue` multipart route. The Python backend only ever sees
//! uploaded bytes — filesystem paths never ride an HTTP request (same posture
//! as `commands::authorize_host_path`).
//!
//! Access model: the folder is picked in a native dialog inside this process
//! and registered under a random session token, together with a `cap_std`
//! directory HANDLE opened at pick time. Scan/read commands resolve entries
//! relative to that handle — no pathname is ever re-resolved after
//! authorization, so swapping the directory (or any component of its path)
//! for a symlink/junction later cannot redirect the watcher, on any OS. The
//! webview cannot point the commands at an arbitrary path; reads are confined
//! to files sitting directly in the folder the user explicitly picked this
//! session (non-recursive by design).

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use cap_std::ambient_authority;
use cap_std::fs::Dir;
use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

/// Upper bound for one `watch_folder_read` IPC transfer. The webview
/// assembles the chunks into a `File` (Blob parts), so a multi-gigabyte video
/// never has to exist as a single contiguous buffer on the Rust side.
const READ_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

/// An authorized watch folder: the directory handle everything resolves
/// against, plus the identity the folder had when the user picked it. The
/// handle is the security boundary (operations can never leave it); the
/// identity check is the LIVENESS signal — when the folder is deleted, moved,
/// or replaced, token resolution fails loudly and the UI stops the watcher
/// instead of polling silently forever.
struct WatchedDir {
    /// Fully-resolved directory path captured at pick time.
    canonical: PathBuf,
    /// Filesystem identity (device, inode) captured at pick time.
    #[cfg(unix)]
    identity: (u64, u64),
    /// Directory handle captured at pick time — all scans/reads go through it.
    handle: Dir,
}

#[cfg(unix)]
fn dir_identity(meta: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

fn authorize_watched_dir(dir: &Path) -> Result<WatchedDir, String> {
    let canonical = fs::canonicalize(dir)
        .map_err(|e| format!("Selected watch folder could not be resolved: {e}"))?;
    if !canonical.is_dir() {
        return Err("Selected watch folder is not a directory".into());
    }
    let handle = Dir::open_ambient_dir(&canonical, ambient_authority())
        .map_err(|e| format!("Selected watch folder could not be opened: {e}"))?;
    #[cfg(unix)]
    let identity = dir_identity(
        &fs::metadata(&canonical)
            .map_err(|e| format!("Selected watch folder could not be inspected: {e}"))?,
    );
    Ok(WatchedDir {
        canonical,
        #[cfg(unix)]
        identity,
        handle,
    })
}

/// Re-verify a watched folder's identity: the stored path must still resolve
/// to the same canonical target (and, on unix, the same device+inode). A
/// deleted, moved, replaced, or recreated directory fails here, which is what
/// stops the watcher loudly in the UI. Reads never depend on this check for
/// confinement — they go through the pinned handle regardless.
fn verify_watched_dir(watched: &WatchedDir) -> Result<(), String> {
    let canonical_now = fs::canonicalize(&watched.canonical)
        .map_err(|_| "Watched folder is no longer accessible".to_string())?;
    if canonical_now != watched.canonical {
        return Err("Watched folder changed identity".into());
    }
    #[cfg(unix)]
    {
        let meta = fs::metadata(&canonical_now)
            .map_err(|_| "Watched folder is no longer accessible".to_string())?;
        if dir_identity(&meta) != watched.identity {
            return Err("Watched folder changed identity".into());
        }
    }
    Ok(())
}

fn registry() -> &'static Mutex<HashMap<String, WatchedDir>> {
    static WATCHED: OnceLock<Mutex<HashMap<String, WatchedDir>>> = OnceLock::new();
    WATCHED.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
pub struct WatchFolderSelection {
    token: String,
    path: String,
}

#[derive(Serialize)]
pub struct WatchEntry {
    name: String,
    size: u64,
    /// Modification time in ms since the Unix epoch (0 when unavailable).
    mtime: u64,
}

fn new_token() -> Result<String, String> {
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).map_err(|e| format!("Secure randomness unavailable: {e}"))?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}

/// Resolve a session token to a clone of its pinned directory handle,
/// re-verifying the folder's liveness/identity on every access.
fn registered_dir(token: &str) -> Result<Dir, String> {
    let map = registry()
        .lock()
        .map_err(|_| "Watch-folder registry poisoned".to_string())?;
    let watched = map
        .get(token)
        .ok_or_else(|| "Watch folder is not authorized".to_string())?;
    verify_watched_dir(watched)?;
    watched
        .handle
        .try_clone()
        .map_err(|e| format!("Watched folder handle could not be reused: {e}"))
}

/// A directory entry name must be a single plain path component — anything
/// that could climb out of the watched folder is rejected. (The `cap_std`
/// handle would also refuse an escape; this keeps the error crisp and the
/// contract explicit.)
fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|c| c.is_control())
    {
        return Err("Invalid watch-folder entry name".into());
    }
    Ok(())
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cap_mtime_ms(meta: &cap_std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| {
            t.into_std()
                .duration_since(UNIX_EPOCH)
                .ok()
        })
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Non-recursive listing of the regular files in the watched folder (name,
/// size, mtime), resolved through the pinned handle. Symlinks are skipped
/// outright — the read path cannot follow them out of the folder anyway, so
/// listing them would only produce entries that can never be ingested.
fn scan_dir(dir: &Dir) -> Result<Vec<WatchEntry>, String> {
    let mut entries = Vec::new();
    let read = dir
        .entries()
        .map_err(|e| format!("Watched folder is unreadable: {e}"))?;
    for item in read.flatten() {
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let Ok(meta) = item.metadata() else { continue };
        let Ok(name) = item.file_name().into_string() else {
            continue; // non-UTF-8 names can't round-trip through IPC; skip
        };
        entries.push(WatchEntry {
            name,
            size: meta.len(),
            mtime: cap_mtime_ms(&meta),
        });
    }
    Ok(entries)
}

/// Read one bounded chunk of a watched file through the pinned directory
/// handle, bound to the settled scan snapshot: the opened file's size and
/// mtime must still match what the stability tracker released, otherwise the
/// file changed (or was replaced) after settling and the read is refused. A
/// symlink pointing outside the watched folder cannot be opened at all —
/// `cap_std` confines resolution to the handle.
fn read_watched_chunk(
    dir: &Dir,
    name: &str,
    offset: u64,
    expected_size: u64,
    expected_mtime: u64,
) -> Result<Vec<u8>, String> {
    validate_entry_name(name)?;
    let mut file = dir
        .open(name)
        .map_err(|e| format!("Watched file could not be opened: {e}"))?
        .into_std();
    let meta = file
        .metadata()
        .map_err(|e| format!("Watched file could not be inspected: {e}"))?;
    if !meta.is_file() {
        return Err("Watched entry is not a regular file".into());
    }
    if meta.len() != expected_size || mtime_ms(&meta) != expected_mtime {
        return Err("Watched file changed after it was scanned".into());
    }
    if offset >= expected_size {
        return Ok(Vec::new());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Watched file could not be read: {e}"))?;
    let len = (expected_size - offset).min(READ_CHUNK_BYTES) as usize;
    let mut buf = vec![0_u8; len];
    file.read_exact(&mut buf)
        .map_err(|e| format!("Watched file could not be read: {e}"))?;
    Ok(buf)
}

/// Open the native folder picker and register the chosen directory for this
/// session. Returns `None` when the user cancels.
#[tauri::command]
pub async fn watch_folder_pick(
    app: tauri::AppHandle,
) -> Result<Option<WatchFolderSelection>, String> {
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|value| value.into_path().ok());
    let Some(dir) = picked else {
        return Ok(None);
    };
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("Selected watch folder is not a directory".into());
    }
    let watched = authorize_watched_dir(&dir)?;
    let display = watched.canonical.to_string_lossy().into_owned();
    let token = new_token()?;
    registry()
        .lock()
        .map_err(|_| "Watch-folder registry poisoned".to_string())?
        .insert(token.clone(), watched);
    Ok(Some(WatchFolderSelection {
        token,
        path: display,
    }))
}

/// List the files currently sitting in the watched folder (non-recursive).
#[tauri::command]
pub fn watch_folder_scan(token: String) -> Result<Vec<WatchEntry>, String> {
    scan_dir(&registered_dir(&token)?)
}

/// Read one chunk (≤ `READ_CHUNK_BYTES`) of a watched file as raw bytes; the
/// webview loops over offsets and assembles the chunks into a `File` for the
/// multipart upload, so neither side ever buffers the whole video at once.
/// `expected_size`/`expected_mtime` are the settled scan snapshot — the read
/// refuses files that changed after settling, and resolution is confined to
/// the directory handle captured when the user picked the folder.
#[tauri::command]
pub fn watch_folder_read(
    token: String,
    name: String,
    offset: u64,
    expected_size: u64,
    expected_mtime: u64,
) -> Result<tauri::ipc::Response, String> {
    let dir = registered_dir(&token)?;
    let bytes = read_watched_chunk(&dir, &name, offset, expected_size, expected_mtime)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Drop a watch-folder authorization (watcher stopped or component unmounted).
#[tauri::command]
pub fn watch_folder_forget(token: String) {
    if let Ok(mut map) = registry().lock() {
        map.remove(&token);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        authorize_watched_dir, mtime_ms, read_watched_chunk, scan_dir, validate_entry_name,
        verify_watched_dir, Dir,
    };
    use cap_std::ambient_authority;
    use std::fs;
    use std::path::PathBuf;

    fn temp_watch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vs-watch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn open_handle(dir: &std::path::Path) -> Dir {
        Dir::open_ambient_dir(dir, ambient_authority()).unwrap()
    }

    fn snapshot(path: &std::path::Path) -> (u64, u64) {
        let meta = fs::metadata(path).unwrap();
        (meta.len(), mtime_ms(&meta))
    }

    #[test]
    fn entry_names_must_be_single_components() {
        assert!(validate_entry_name("clip.mp4").is_ok());
        assert!(validate_entry_name("weird name (1).MOV").is_ok());
        for bad in ["", ".", "..", "a/b.mp4", "a\\b.mp4", "..\\up.mp4", "x\n.mp4"] {
            assert!(validate_entry_name(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn scan_lists_regular_files_with_size_and_mtime_and_skips_dirs() {
        let dir = temp_watch_dir("scan");
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("a.mp4"), b"12345").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();

        let mut entries = scan_dir(&open_handle(&dir)).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Directories are skipped; filtering to *videos* is the frontend's job.
        assert_eq!(names, ["a.mp4", "notes.txt"]);
        assert_eq!(entries[0].size, 5);
        assert!(entries[0].mtime > 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunked_reads_reassemble_the_exact_bytes() {
        let dir = temp_watch_dir("chunks");
        fs::write(dir.join("clip.mp4"), b"0123456789").unwrap();
        let (size, mtime) = snapshot(&dir.join("clip.mp4"));
        let handle = open_handle(&dir);

        // READ_CHUNK_BYTES is far larger than this file, so exercise the
        // offset walk directly: partial reads must line up back to back.
        let whole = read_watched_chunk(&handle, "clip.mp4", 0, size, mtime).unwrap();
        assert_eq!(whole, b"0123456789");
        let tail = read_watched_chunk(&handle, "clip.mp4", 7, size, mtime).unwrap();
        assert_eq!(tail, b"789");
        let past_end = read_watched_chunk(&handle, "clip.mp4", size, size, mtime).unwrap();
        assert!(past_end.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_are_bound_to_the_settled_snapshot() {
        let dir = temp_watch_dir("snapshot");
        fs::write(dir.join("clip.mp4"), b"settled bytes").unwrap();
        let (size, mtime) = snapshot(&dir.join("clip.mp4"));
        let handle = open_handle(&dir);

        // The file is replaced after the scan settled → the read must refuse
        // rather than upload bytes the tracker never saw stabilize.
        fs::write(dir.join("clip.mp4"), b"replaced with something longer").unwrap();
        let err = read_watched_chunk(&handle, "clip.mp4", 0, size, mtime).unwrap_err();
        assert!(err.contains("changed"), "unexpected error: {err}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn authorization_pins_the_directory_identity() {
        let dir = temp_watch_dir("identity");
        let watched = authorize_watched_dir(&dir).unwrap();
        // Untouched directory verifies fine…
        assert!(verify_watched_dir(&watched).is_ok());
        // …and a directory that disappears after authorization is refused.
        fs::remove_dir_all(&dir).unwrap();
        assert!(verify_watched_dir(&watched).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_swapped_for_a_symlink_is_refused_and_never_followed() {
        let dir = temp_watch_dir("dir-swap");
        let elsewhere = temp_watch_dir("dir-swap-target");
        fs::write(elsewhere.join("clip.mp4"), b"outside").unwrap();
        let (size, mtime) = snapshot(&elsewhere.join("clip.mp4"));

        let watched = authorize_watched_dir(&dir).unwrap();
        assert!(verify_watched_dir(&watched).is_ok());

        // Replace the authorized directory itself with a symlink pointing
        // somewhere else. Token resolution refuses (identity check)…
        fs::remove_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &dir).unwrap();
        let err = verify_watched_dir(&watched).unwrap_err();
        assert!(err.contains("identity"), "unexpected error: {err}");
        // …and even the pinned handle cannot reach the swap target: it still
        // points at the ORIGINAL (now unlinked) directory, which is empty.
        assert!(scan_dir(&watched.handle).unwrap().is_empty());
        assert!(read_watched_chunk(&watched.handle, "clip.mp4", 0, size, mtime).is_err());

        let _ = fs::remove_file(&dir);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    #[cfg(unix)]
    #[test]
    fn a_recreated_directory_at_the_same_path_is_refused() {
        let dir = temp_watch_dir("dir-recreate");
        let watched = authorize_watched_dir(&dir).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        fs::create_dir_all(&dir).unwrap(); // same path, different inode
        assert!(verify_watched_dir(&watched).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed_out_of_the_folder() {
        let dir = temp_watch_dir("symlink");
        let secret = std::env::temp_dir().join(format!("vs-secret-{}", std::process::id()));
        fs::write(&secret, b"outside the folder").unwrap();
        std::os::unix::fs::symlink(&secret, dir.join("evil.mp4")).unwrap();
        let meta = fs::metadata(dir.join("evil.mp4")).unwrap();
        let handle = open_handle(&dir);

        // Even with a "correct" snapshot of the symlink target, opening it
        // through the capability handle refuses: resolution may not escape
        // the watched folder.
        let err = read_watched_chunk(&handle, "evil.mp4", 0, meta.len(), mtime_ms(&meta))
            .unwrap_err();
        assert!(err.contains("could not be opened"), "unexpected error: {err}");
        // And the scanner never lists it in the first place.
        assert!(scan_dir(&handle).unwrap().is_empty());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&secret);
    }
}
