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
//! and registered under a random session token. Scan/read commands resolve the
//! directory from that token, so the webview cannot point them at an arbitrary
//! path — reads are confined to files sitting directly in a folder the user
//! explicitly picked this session (non-recursive by design).

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

/// Upper bound for one `watch_folder_read` IPC transfer. The webview
/// assembles the chunks into a `File` (Blob parts), so a multi-gigabyte video
/// never has to exist as a single contiguous buffer on the Rust side.
const READ_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

fn registry() -> &'static Mutex<HashMap<String, PathBuf>> {
    static WATCHED: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
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

fn registered_dir(token: &str) -> Result<PathBuf, String> {
    registry()
        .lock()
        .map_err(|_| "Watch-folder registry poisoned".to_string())?
        .get(token)
        .cloned()
        .ok_or_else(|| "Watch folder is not authorized".to_string())
}

/// A directory entry name must be a single plain path component — anything
/// that could climb out of the watched folder is rejected.
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

/// Non-recursive listing of the regular files in `dir` (name, size, mtime).
/// Symlinks are skipped outright — the read path refuses to follow them, so
/// listing them would only produce entries that can never be ingested.
fn scan_dir(dir: &Path) -> Result<Vec<WatchEntry>, String> {
    let mut entries = Vec::new();
    let read = fs::read_dir(dir).map_err(|e| format!("Watched folder is unreadable: {e}"))?;
    for item in read.flatten() {
        // DirEntry::file_type does NOT traverse symlinks, unlike metadata().
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
            mtime: mtime_ms(&meta),
        });
    }
    Ok(entries)
}

/// Open a file inside the watched folder WITHOUT following symlinks, and
/// validate the opened handle (not the pathname) so a swap between the scan
/// and the read cannot redirect the read outside the authorized folder.
fn open_watched_file(path: &Path) -> Result<fs::File, String> {
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the reparse point itself rather than its target; the handle
        // metadata check below then rejects it.
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = opts
        .open(path)
        .map_err(|e| format!("Watched file could not be opened: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Watched file could not be inspected: {e}"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Watched entry is not a regular file".into());
    }
    Ok(file)
}

/// Read one bounded chunk of a watched file, bound to the settled scan
/// snapshot: the opened handle's size and mtime must still match what the
/// stability tracker released, otherwise the file changed (or was replaced)
/// after settling and the read is refused.
fn read_watched_chunk(
    dir: &Path,
    name: &str,
    offset: u64,
    expected_size: u64,
    expected_mtime: u64,
) -> Result<Vec<u8>, String> {
    validate_entry_name(name)?;
    let path = dir.join(name);
    let mut file = open_watched_file(&path)?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Watched file could not be inspected: {e}"))?;
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
    let token = new_token()?;
    registry()
        .lock()
        .map_err(|_| "Watch-folder registry poisoned".to_string())?
        .insert(token.clone(), dir.clone());
    Ok(Some(WatchFolderSelection {
        token,
        path: dir.to_string_lossy().into_owned(),
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
/// refuses files that changed after settling, and never follows symlinks.
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
    use super::{mtime_ms, read_watched_chunk, scan_dir, validate_entry_name};
    use std::fs;
    use std::path::PathBuf;

    fn temp_watch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vs-watch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
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

        let mut entries = scan_dir(&dir).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Directories are skipped; filtering to *videos* is the frontend's job.
        assert_eq!(names, ["a.mp4", "notes.txt"]);
        assert_eq!(entries[0].size, 5);
        assert!(entries[0].mtime > 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_fails_on_missing_directory() {
        assert!(scan_dir(std::path::Path::new("/definitely-not-a-real-dir-vs")).is_err());
    }

    #[test]
    fn chunked_reads_reassemble_the_exact_bytes() {
        let dir = temp_watch_dir("chunks");
        fs::write(dir.join("clip.mp4"), b"0123456789").unwrap();
        let (size, mtime) = snapshot(&dir.join("clip.mp4"));

        // READ_CHUNK_BYTES is far larger than this file, so exercise the
        // offset walk directly: partial reads must line up back to back.
        let whole = read_watched_chunk(&dir, "clip.mp4", 0, size, mtime).unwrap();
        assert_eq!(whole, b"0123456789");
        let tail = read_watched_chunk(&dir, "clip.mp4", 7, size, mtime).unwrap();
        assert_eq!(tail, b"789");
        let past_end = read_watched_chunk(&dir, "clip.mp4", size, size, mtime).unwrap();
        assert!(past_end.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_are_bound_to_the_settled_snapshot() {
        let dir = temp_watch_dir("snapshot");
        fs::write(dir.join("clip.mp4"), b"settled bytes").unwrap();
        let (size, mtime) = snapshot(&dir.join("clip.mp4"));

        // The file is replaced after the scan settled → the read must refuse
        // rather than upload bytes the tracker never saw stabilize.
        fs::write(dir.join("clip.mp4"), b"replaced with something longer").unwrap();
        let err = read_watched_chunk(&dir, "clip.mp4", 0, size, mtime).unwrap_err();
        assert!(err.contains("changed"), "unexpected error: {err}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed() {
        let dir = temp_watch_dir("symlink");
        let secret = std::env::temp_dir().join(format!("vs-secret-{}", std::process::id()));
        fs::write(&secret, b"outside the folder").unwrap();
        std::os::unix::fs::symlink(&secret, dir.join("evil.mp4")).unwrap();
        let meta = fs::metadata(dir.join("evil.mp4")).unwrap();

        // Even with a "correct" snapshot of the symlink target, the no-follow
        // open must refuse it (O_NOFOLLOW → ELOOP).
        let err =
            read_watched_chunk(&dir, "evil.mp4", 0, meta.len(), mtime_ms(&meta)).unwrap_err();
        assert!(
            err.contains("could not be opened") || err.contains("not a regular file"),
            "unexpected error: {err}"
        );
        // And the scanner never lists it in the first place.
        assert!(scan_dir(&dir).unwrap().is_empty());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&secret);
    }
}
