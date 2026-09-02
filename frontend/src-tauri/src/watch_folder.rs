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
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

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

/// Non-recursive listing of the regular files in `dir` (name, size, mtime).
fn scan_dir(dir: &std::path::Path) -> Result<Vec<WatchEntry>, String> {
    let mut entries = Vec::new();
    let read = fs::read_dir(dir).map_err(|e| format!("Watched folder is unreadable: {e}"))?;
    for item in read.flatten() {
        // Never follow a symlink placed inside the authorized directory: it
        // could target an arbitrary file outside the folder the user picked.
        let Ok(meta) = item.path().symlink_metadata() else {
            continue;
        };
        if !meta.file_type().is_file() {
            continue;
        }
        let Ok(name) = item.file_name().into_string() else {
            continue; // non-UTF-8 names can't round-trip through IPC; skip
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(WatchEntry {
            name,
            size: meta.len(),
            mtime,
        });
    }
    Ok(entries)
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

/// Read one file from the watched folder as raw bytes (arrives in the webview
/// as an ArrayBuffer, wrapped into a File for the multipart upload).
fn read_file(dir: &std::path::Path, name: &str) -> Result<Vec<u8>, String> {
    validate_entry_name(name)?;
    let path = dir.join(name);
    let metadata = path
        .symlink_metadata()
        .map_err(|_| "Watched file no longer exists".to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Watched file no longer exists".into());
    }
    fs::read(&path).map_err(|e| format!("Watched file could not be read: {e}"))
}

#[tauri::command]
pub fn watch_folder_read(token: String, name: String) -> Result<tauri::ipc::Response, String> {
    let bytes = read_file(&registered_dir(&token)?, &name)?;
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
    use super::{read_file, scan_dir, validate_entry_name};
    use std::fs;

    #[test]
    fn entry_names_must_be_single_components() {
        assert!(validate_entry_name("clip.mp4").is_ok());
        assert!(validate_entry_name("weird name (1).MOV").is_ok());
        for bad in [
            "",
            ".",
            "..",
            "a/b.mp4",
            "a\\b.mp4",
            "..\\up.mp4",
            "x\n.mp4",
        ] {
            assert!(validate_entry_name(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn scan_lists_regular_files_with_size_and_mtime_and_skips_dirs() {
        let dir = std::env::temp_dir().join(format!("vs-watch-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
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

    #[cfg(unix)]
    #[test]
    fn scan_and_read_reject_symlinks_outside_the_authorized_folder() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("vs-watch-links-{}", std::process::id()));
        let watched = root.join("watched");
        let outside = root.join("private.mp4");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&watched).unwrap();
        fs::write(&outside, b"secret").unwrap();
        symlink(&outside, watched.join("escape.mp4")).unwrap();

        assert!(scan_dir(&watched).unwrap().is_empty());
        assert!(read_file(&watched, "escape.mp4").is_err());

        let _ = fs::remove_dir_all(&root);
    }
}
