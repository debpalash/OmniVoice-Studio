//! Sidecar detection, FFmpeg/ffprobe resolution, and on-demand downloads.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::config::get_effective_region;
#[allow(unused_imports)] // Used in cfg(linux) and cfg(windows) blocks
use crate::config::resolve_github_url;
use crate::bootstrap::{BootstrapStage, set_stage};

// Version of the Astral `uv` binary we download at first run when no system
// uv is on PATH. Pinned for reproducibility — bump alongside the uv.lock
// when the toolchain needs a newer uv.
pub const UV_VERSION: &str = "0.11.7";

// ── Sidecar detection ─────────────────────────────────────────────────────

/// Look for a sidecar binary bundled alongside the app via Tauri's
/// `bundle.externalBin`. Tauri places the per-target sidecar at the same
/// path as the main app executable on Linux/Windows, and inside
/// `Contents/MacOS/` on macOS .app bundles. The bundled file keeps its
/// `<name>-<target-triple>{.exe}` name.
///
/// Returns `None` in dev (`cargo run`) builds where the sidecar wasn't
/// bundled — the caller then falls back to PATH lookup or other strategies.
pub fn find_bundled_sidecar(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        _ => return None,
    };
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let candidate = dir.join(format!("{}-{}{}", name, triple, ext));
    if !candidate.is_file() {
        return None;
    }
    // build.rs writes a zero-byte placeholder so tauri-build's externalBin
    // existence check passes during dev / `cargo check`. Reject it here so
    // we don't try to exec an empty file — callers fall back to PATH lookup
    // or pip-bundled binaries instead.
    let len = std::fs::metadata(&candidate).ok().map(|m| m.len()).unwrap_or(0);
    if len < 1024 {
        return None;
    }
    Some(candidate)
}

pub fn find_bundled_uv() -> Option<PathBuf> { find_bundled_sidecar("uv") }
pub fn find_bundled_ffmpeg() -> Option<PathBuf> { find_bundled_sidecar("ffmpeg") }
pub fn find_bundled_ffprobe() -> Option<PathBuf> { find_bundled_sidecar("ffprobe") }

// ── On-demand ffmpeg / ffprobe download ───────────────────────────────────
//
// Sources:
//   macOS:   evermeet.cx — individual .zip per binary (x86_64, runs via Rosetta on arm64)
//   Linux:   BtbN/FFmpeg-Builds — single .tar.xz with both binaries
//   Windows: BtbN/FFmpeg-Builds — single .zip with both binaries

/// Download and cache static ffmpeg + ffprobe binaries into `dest`.
/// Idempotent: skips the download when both binaries already exist.
#[allow(unused_variables)] // `region` only used in linux/windows cfg blocks
pub fn install_ffmpeg_standalone(dest: &Path, region: &str) -> io::Result<()> {
    let ffmpeg_bin = dest.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    let ffprobe_bin = dest.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if ffmpeg_bin.is_file() && ffprobe_bin.is_file() {
        return Ok(());
    }
    fs::create_dir_all(dest)?;

    #[cfg(target_os = "macos")]
    {
        // Prefer native arm64 ffmpeg via Homebrew — always latest, includes
        // ffprobe, zero Rosetta overhead on Apple Silicon.
        let brew_candidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
        let brew_path = brew_candidates.iter().find(|p| PathBuf::from(p).is_file());
        if let Some(brew) = brew_path {
            log::info!("Installing ffmpeg via Homebrew (native arm64)");
            let status = Command::new(brew)
                .args(["install", "ffmpeg"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if matches!(status, Ok(ref s) if s.success()) {
                // brew install succeeded — ffmpeg/ffprobe are now on PATH
                // at /opt/homebrew/bin/ or /usr/local/bin/. No need to
                // cache in tools/ — resolve_ffmpeg will find them via PATH.
                return Ok(());
            }
            log::warn!("brew install ffmpeg failed — falling back to evermeet.cx");
        }
        // Fallback: evermeet.cx static binaries (x86_64, runs via Rosetta).
        for (tool, url) in [
            ("ffmpeg", "https://evermeet.cx/ffmpeg/getrelease/zip"),
            ("ffprobe", "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"),
        ] {
            let bin_path = dest.join(tool);
            if bin_path.is_file() {
                continue;
            }
            log::info!("Downloading {} from evermeet.cx", tool);
            let zip_path = dest.join(format!("{}.zip", tool));
            let resp = ureq::get(url)
                .timeout(Duration::from_secs(120))
                .call()
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("{} download: {}", tool, e)))?;
            if resp.status() != 200 {
                return Err(io::Error::new(
                    io::ErrorKind::Other,
                    format!("{} download HTTP {}", tool, resp.status()),
                ));
            }
            let mut zip_file = fs::File::create(&zip_path)?;
            io::copy(&mut resp.into_reader(), &mut zip_file)?;
            drop(zip_file);
            let status = Command::new("unzip")
                .args(["-o", "-j"])
                .arg(&zip_path)
                .arg("-d")
                .arg(dest)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()?;
            let _ = fs::remove_file(&zip_path);
            if !status.success() {
                return Err(io::Error::new(io::ErrorKind::Other, format!("unzip {} failed", tool)));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&bin_path) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&bin_path, perms);
                }
            }
        }
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let url = resolve_github_url(
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
            region,
        );
        log::info!("Downloading ffmpeg from BtbN (linux64)");
        let archive_path = dest.join("ffmpeg.tar.xz");
        let resp = ureq::get(&url)
            .timeout(Duration::from_secs(300))
            .call()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("ffmpeg download: {}", e)))?;
        if resp.status() != 200 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("ffmpeg download HTTP {}", resp.status()),
            ));
        }
        let mut archive_file = fs::File::create(&archive_path)?;
        io::copy(&mut resp.into_reader(), &mut archive_file)?;
        drop(archive_file);
        let status = Command::new("tar")
            .args(["-xJf"])
            .arg(&archive_path)
            .arg("-C")
            .arg(dest)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        let _ = fs::remove_file(&archive_path);
        if !status.success() {
            return Err(io::Error::new(io::ErrorKind::Other, "tar -xJf ffmpeg failed"));
        }
        for entry in fs::read_dir(dest)? {
            let entry = entry?;
            let p = entry.path();
            if p.is_dir() {
                let bin_dir = p.join("bin");
                if bin_dir.is_dir() {
                    for tool in ["ffmpeg", "ffprobe"] {
                        let src = bin_dir.join(tool);
                        if src.is_file() {
                            let dst = dest.join(tool);
                            let _ = fs::rename(&src, &dst).or_else(|_| {
                                fs::copy(&src, &dst).map(|_| ())
                            });
                        }
                    }
                    let _ = fs::remove_dir_all(&p);
                    break;
                }
            }
        }
        for tool in ["ffmpeg", "ffprobe"] {
            let bin = dest.join(tool);
            if bin.is_file() {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&bin) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&bin, perms);
                }
            }
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        use std::io::Read;
        let url = resolve_github_url(
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
            region,
        );
        log::info!("Downloading ffmpeg from BtbN (win64)");
        let resp = ureq::get(&url)
            .timeout(Duration::from_secs(300))
            .call()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("ffmpeg download: {}", e)))?;
        if resp.status() != 200 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("ffmpeg download HTTP {}", resp.status()),
            ));
        }
        let mut buf = Vec::new();
        resp.into_reader().read_to_end(&mut buf)?;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf))
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("zip: {}", e)))?;
        for i in 0..archive.len() {
            let mut file = archive.by_index(i)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("zip entry: {}", e)))?;
            let name = file.name().to_string();
            let basename = name.rsplit('/').next().unwrap_or(&name);
            if basename == "ffmpeg.exe" || basename == "ffprobe.exe" {
                let out_path = dest.join(basename);
                let mut out_file = fs::File::create(&out_path)?;
                io::copy(&mut file, &mut out_file)?;
            }
        }
        return Ok(());
    }

    // Unsupported platform — not an error, caller falls back to PATH / imageio-ffmpeg.
    #[allow(unreachable_code)]
    Ok(())
}

/// Resolve a usable ffmpeg binary. Order: bundled sidecar → cached download
/// in app_data/tools → system PATH → on-demand download from the internet.
pub fn resolve_ffmpeg<R: tauri::Runtime>(app: &tauri::AppHandle<R>, app_data: &Path) -> Option<PathBuf> {
    if let Some(p) = find_bundled_ffmpeg() {
        log::info!("Using bundled ffmpeg at {}", p.display());
        return Some(p);
    }
    let tools_dir = app_data.join("tools");
    let cached = tools_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    if cached.is_file() {
        log::info!("Using cached ffmpeg at {}", cached.display());
        return Some(cached);
    }
    if Command::new("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) {
        log::info!("Using system ffmpeg from PATH");
        return Some(PathBuf::from("ffmpeg"));
    }
    log::info!("No ffmpeg found — auto-installing");
    match install_ffmpeg_standalone(&tools_dir, &get_effective_region(app)) {
        Ok(()) => {
            if cached.is_file() {
                log::info!("Installed ffmpeg to {}", cached.display());
                return Some(cached);
            }
            for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
                if PathBuf::from(p).is_file() {
                    log::info!("Installed ffmpeg at {}", p);
                    return Some(PathBuf::from(p));
                }
            }
            if Command::new("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) {
                return Some(PathBuf::from("ffmpeg"));
            }
            log::warn!("ffmpeg install completed but binary not found");
            None
        }
        Err(e) => {
            log::warn!("ffmpeg install failed: {} — backend will rely on imageio-ffmpeg", e);
            None
        }
    }
}

/// Resolve a usable ffprobe binary. Same cascade as ffmpeg.
pub fn resolve_ffprobe<R: tauri::Runtime>(app: &tauri::AppHandle<R>, app_data: &Path) -> Option<PathBuf> {
    if let Some(p) = find_bundled_ffprobe() {
        log::info!("Using bundled ffprobe at {}", p.display());
        return Some(p);
    }
    let tools_dir = app_data.join("tools");
    let cached = tools_dir.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if cached.is_file() {
        log::info!("Using cached ffprobe at {}", cached.display());
        return Some(cached);
    }
    if Command::new("ffprobe").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) {
        log::info!("Using system ffprobe from PATH");
        return Some(PathBuf::from("ffprobe"));
    }
    if let Ok(()) = install_ffmpeg_standalone(&tools_dir, &get_effective_region(app)) {
        if cached.is_file() {
            log::info!("Installed ffprobe to {}", cached.display());
            return Some(cached);
        }
        for p in ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"] {
            if PathBuf::from(p).is_file() {
                log::info!("Installed ffprobe at {}", p);
                return Some(PathBuf::from(p));
            }
        }
        if Command::new("ffprobe").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) {
            return Some(PathBuf::from("ffprobe"));
        }
    }
    None
}

// ── uv resolution ─────────────────────────────────────────────────────────

/// Resolve a usable `uv` binary. Order: bundled sidecar (shipped with the
/// release installer via `bundle.externalBin`), system PATH (dev / power
/// users), or — last resort — download via the official Astral installer.
pub fn resolve_uv<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    app_data: &Path,
    progress: Option<&Arc<Mutex<BootstrapStage>>>,
) -> Result<PathBuf, String> {
    if let Some(p) = find_bundled_uv() {
        log::info!("Using bundled uv at {}", p.display());
        return Ok(p);
    }
    if Command::new("uv").arg("--version").output().is_ok() {
        log::info!("Using system uv from PATH");
        return Ok(PathBuf::from("uv"));
    }
    if let Some(p) = progress {
        set_stage(p, BootstrapStage::DownloadingUv { percent: None });
    }
    install_uv_standalone(&app_data.join("tools"), &get_effective_region(_app))
        .map_err(|e| format!("uv install failed: {}", e))
}

/// Install `uv` using the **official Astral installer scripts**.
///
/// Unix:    `curl -LsSf https://astral.sh/uv/{version}/install.sh | sh`
/// Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/{version}/install.ps1 | iex"`
///
/// The installer handles platform detection, checksums, and extraction
/// automatically. We control the install directory via `UV_INSTALL_DIR`.
/// Idempotent: if the binary is already present, returns its path immediately.
fn install_uv_standalone(dest: &Path, _region: &str) -> io::Result<PathBuf> {
    let uv_bin = dest.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    if uv_bin.is_file() {
        return Ok(uv_bin);
    }
    fs::create_dir_all(dest)?;
    log::info!("Installing uv {} via official installer into {}", UV_VERSION, dest.display());

    #[cfg(unix)]
    {
        let status = Command::new("sh")
            .args([
                "-c",
                &format!(
                    "curl -LsSf https://astral.sh/uv/{}/install.sh | sh -s -- --no-modify-path",
                    UV_VERSION
                ),
            ])
            .env("UV_INSTALL_DIR", dest)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .status()
            .map_err(|e| io::Error::new(
                io::ErrorKind::Other,
                format!("uv installer launch failed (is curl installed?): {}", e),
            ))?;
        if !status.success() {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("uv installer exited with code {:?}", status.code()),
            ));
        }
    }

    #[cfg(windows)]
    {
        let script = format!(
            "irm https://astral.sh/uv/{}/install.ps1 | iex",
            UV_VERSION
        );
        let status = Command::new("powershell")
            .args(["-ExecutionPolicy", "ByPass", "-c", &script])
            .env("UV_INSTALL_DIR", dest)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .status()
            .map_err(|e| io::Error::new(
                io::ErrorKind::Other,
                format!("uv PowerShell installer failed: {}", e),
            ))?;
        if !status.success() {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("uv installer exited with code {:?}", status.code()),
            ));
        }
    }

    if uv_bin.is_file() {
        log::info!("uv installed successfully at {}", uv_bin.display());
        Ok(uv_bin)
    } else {
        let alt = dest.join("bin").join(if cfg!(windows) { "uv.exe" } else { "uv" });
        if alt.is_file() {
            fs::rename(&alt, &uv_bin)?;
            log::info!("uv moved from bin/ to {}", uv_bin.display());
            return Ok(uv_bin);
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("uv binary not found at {} after installer completed", uv_bin.display()),
        ))
    }
}
