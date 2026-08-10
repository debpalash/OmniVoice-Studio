//! Sidecar detection, FFmpeg/ffprobe resolution, and on-demand downloads.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::config::get_effective_region;
#[allow(unused_imports)] // Used in cfg(linux) and cfg(windows) blocks
use crate::config::resolve_github_url;
use crate::bootstrap::{BootstrapStage, set_stage};

/// Windows: run a child process with **no console window**.
///
/// A GUI app (no attached console) that spawns a console subprocess makes
/// Windows allocate a fresh console for it — a black `cmd`-style window that
/// flashes on screen for the child's lifetime. During first-run bootstrap we
/// spawn *dozens* of them (`uv venv`, `uv sync`, and a string of short
/// `python -c` capability probes), so the user sees a storm of terminal
/// windows popping up while dependencies install. `CREATE_NO_WINDOW`
/// (0x08000000) runs the child with no console at all; every caller already
/// pipes/among nulls stdout+stderr, so nothing visible or logged is lost.
///
/// This is the single chokepoint every bootstrap/tools spawn routes through,
/// mirroring the flag the backend spawn (`backend.rs`) and the `nvidia-smi`
/// probe (`setup.rs`) already set inline. No-op on macOS/Linux — there is no
/// per-process console to hide there, so behaviour is unchanged on those
/// platforms (default-parity rule: the *visible* default is now identical —
/// no stray windows — across all three).
///
/// Returns the same `&mut Command` so it chains inline:
/// `no_window(Command::new(p).args([..])).output()`.
#[inline]
pub fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

// Version of the Astral `uv` binary we download at first run when no system
// uv is on PATH. Pinned for reproducibility — bump alongside the uv.lock
// when the toolchain needs a newer uv.
pub const UV_VERSION: &str = "0.11.7";

// Version of BtbN/FFmpeg-Builds we download for Linux/Windows ffmpeg first-
// run setup. The string appears *twice* in each URL (once as the release tag,
// once inside the archive filename) — BtbN tags their autobuilds
// `autobuild-YYYY-MM-DD-HH-MM` and the inner filenames use the same datestamp.
// Driving both from one constant means pinning to a specific autobuild is a
// one-line edit: change `"latest"` to e.g. `"autobuild-2026-04-15-12-50"` and
// match the same constant in `.github/workflows/release.yml`
// (FFMPEG_BTBN_VERSION env var). Reproducible installer builds without
// surprise upstream regressions, AV reputation drift, or 2am pages when BtbN
// retags `latest` to a build that fails Windows SmartScreen.
//
// Browse releases: https://github.com/BtbN/FFmpeg-Builds/releases
pub const FFMPEG_BTBN_VERSION: &str = "latest";

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
            &format!(
                "https://github.com/BtbN/FFmpeg-Builds/releases/download/{ver}/ffmpeg-master-{ver}-linux64-gpl.tar.xz",
                ver = FFMPEG_BTBN_VERSION,
            ),
            region,
        );
        log::info!("Downloading ffmpeg from BtbN (linux64) — version={}", FFMPEG_BTBN_VERSION);
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
            &format!(
                "https://github.com/BtbN/FFmpeg-Builds/releases/download/{ver}/ffmpeg-master-{ver}-win64-gpl.zip",
                ver = FFMPEG_BTBN_VERSION,
            ),
            region,
        );
        log::info!("Downloading ffmpeg from BtbN (win64) — version={}", FFMPEG_BTBN_VERSION);
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
    if no_window(Command::new("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null())).status().map(|s| s.success()).unwrap_or(false) {
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
            if no_window(Command::new("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null())).status().map(|s| s.success()).unwrap_or(false) {
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

/// Resolve a usable ffprobe binary. Same cascade as ffmpeg, with one extra
/// step on Linux: probe the relocated .deb path at
/// `/usr/lib/omnivoice-studio/bin/ffprobe` (issue #76, see
/// `frontend/src-tauri/debian/postinst`). The bundled sidecar lookup via
/// `current_exe()` does not find this path because it lives outside the
/// binary's own directory, so we probe it explicitly here.
pub fn resolve_ffprobe<R: tauri::Runtime>(app: &tauri::AppHandle<R>, app_data: &Path) -> Option<PathBuf> {
    if let Some(p) = find_bundled_ffprobe() {
        log::info!("Using bundled ffprobe at {}", p.display());
        return Some(p);
    }
    // Linux .deb install path (#76 — ffprobe relocated out of /usr/bin to
    // avoid overwriting the system binary).
    #[cfg(target_os = "linux")]
    {
        let deb_path = PathBuf::from("/usr/lib/omnivoice-studio/bin/ffprobe");
        if deb_path.is_file() {
            log::info!("Using .deb-bundled ffprobe at {}", deb_path.display());
            return Some(deb_path);
        }
    }
    let tools_dir = app_data.join("tools");
    let cached = tools_dir.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if cached.is_file() {
        log::info!("Using cached ffprobe at {}", cached.display());
        return Some(cached);
    }
    if no_window(Command::new("ffprobe").arg("-version").stdout(Stdio::null()).stderr(Stdio::null())).status().map(|s| s.success()).unwrap_or(false) {
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
        if no_window(Command::new("ffprobe").arg("-version").stdout(Stdio::null()).stderr(Stdio::null())).status().map(|s| s.success()).unwrap_or(false) {
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
    if uv_is_usable(Path::new("uv")) {
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
/// automatically. `UV_UNMANAGED_INSTALL` keeps this app-private tool out of
/// the user's PATH and shell profiles on every platform.
fn install_uv_standalone(dest: &Path, _region: &str) -> io::Result<PathBuf> {
    let uv_bin = dest.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    if uv_is_usable(&uv_bin) {
        return Ok(uv_bin);
    }
    fs::create_dir_all(dest)?;
    log::info!("Installing uv {} via official installer into {}", UV_VERSION, dest.display());

    #[cfg(unix)]
    {
        let output = configure_uv_installer(
            Command::new("sh").args([
                "-c",
                &format!(
                    "curl -LsSf https://astral.sh/uv/{}/install.sh | sh",
                    UV_VERSION
                ),
            ]),
            dest,
        )
        .output()
        .map_err(|e| {
            io::Error::new(
                io::ErrorKind::Other,
                format!("uv installer launch failed (is curl installed?): {}", e),
            )
        })?;
        return finish_uv_install(dest, &uv_bin, output);
    }

    #[cfg(windows)]
    {
        let script = format!(
            "irm https://astral.sh/uv/{}/install.ps1 | iex",
            UV_VERSION
        );
        // Windows: `CREATE_NO_WINDOW` so the uv installer's PowerShell doesn't
        // flash a console window during first-run bootstrap. stdout/stderr are
        // piped, so nothing is lost.
        let mut command = Command::new("powershell");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "ByPass",
            "-c",
            &script,
        ]);
        configure_uv_installer(&mut command, dest);
        let output = no_window(&mut command).output().map_err(|e| {
            io::Error::new(
                io::ErrorKind::Other,
                format!("uv PowerShell installer failed: {}", e),
            )
        })?;
        return finish_uv_install(dest, &uv_bin, output);
    }

    #[allow(unreachable_code)]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unsupported uv install platform",
    ))
}

fn configure_uv_installer<'a>(command: &'a mut Command, dest: &Path) -> &'a mut Command {
    // The official unmanaged mode is designed for app-private/CI installs: it
    // selects the destination and disables PATH, profile, and self-update
    // mutations. Explicitly remove the legacy variable so a parent shell
    // cannot leave the installer in two conflicting modes.
    command
        .env_remove("UV_INSTALL_DIR")
        .env("UV_UNMANAGED_INSTALL", dest)
        .env("UV_NO_MODIFY_PATH", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
}

fn uv_is_usable(path: &Path) -> bool {
    no_window(
        Command::new(path)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )
    .output()
    .map(|output| output.status.success() && uv_version_matches(&output.stdout))
    .unwrap_or(false)
}

fn uv_version_matches(output: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(output) else {
        return false;
    };
    let mut fields = text.split_whitespace();
    fields.next() == Some("uv") && fields.next() == Some(UV_VERSION)
}

fn finish_uv_install(dest: &Path, uv_bin: &Path, output: Output) -> io::Result<PathBuf> {
    finish_uv_install_with_probe(dest, uv_bin, output, uv_is_usable)
}

fn finish_uv_install_with_probe<F>(
    dest: &Path,
    uv_bin: &Path,
    output: Output,
    is_usable: F,
) -> io::Result<PathBuf>
where
    F: Fn(&Path) -> bool,
{
    let alt = dest.join("bin").join(if cfg!(windows) { "uv.exe" } else { "uv" });
    if !is_usable(uv_bin) && is_usable(&alt) {
        fs::rename(&alt, uv_bin).or_else(|_| fs::copy(&alt, uv_bin).map(|_| ()))?;
    }

    // Some installer failures happen after extraction (for example while
    // editing a Windows shell profile). The installed executable is the real
    // postcondition: accepting a verified binary makes first run self-heal in
    // this process instead of requiring a restart. Never accept a partial or
    // corrupt file merely because it exists.
    if is_usable(uv_bin) {
        if output.status.success() {
            log::info!("uv installed successfully at {}", uv_bin.display());
        } else {
            log::warn!(
                "uv installer exited with {:?}, but the installed binary passed validation at {}",
                output.status.code(),
                uv_bin.display()
            );
        }
        return Ok(uv_bin.to_path_buf());
    }

    let detail = installer_output_detail(&output);
    Err(io::Error::new(
        io::ErrorKind::Other,
        if output.status.success() {
            format!(
                "uv installer completed but no usable binary was found at {}{}",
                uv_bin.display(),
                detail
            )
        } else {
            format!("uv installer exited with code {:?}{}", output.status.code(), detail)
        },
    ))
}

fn installer_output_detail(output: &Output) -> String {
    let bytes = if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let text = String::from_utf8_lossy(bytes);
    let mut text = text.trim().to_string();
    if text.is_empty() {
        return String::new();
    }
    for key in ["USERPROFILE", "HOME"] {
        if let Some(home) = std::env::var_os(key).and_then(|value| value.into_string().ok()) {
            text = redact_home_prefix(&text, &home);
        }
    }
    let start = text
        .char_indices()
        .rev()
        .nth(1999)
        .map(|(index, _)| index)
        .unwrap_or(0);
    format!(": {}", &text[start..])
}

fn redact_home_prefix(text: &str, home: &str) -> String {
    if home.len() < 3 {
        return text.to_string();
    }
    let mut redacted = text.replace(home, "~");
    let forward = home.replace('\\', "/");
    let backward = home.replace('/', "\\");
    if forward != home {
        redacted = redacted.replace(&forward, "~");
    }
    if backward != home {
        redacted = redacted.replace(&backward, "~");
    }
    redacted
}

#[cfg(test)]
mod uv_tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn installer_uses_app_private_unmanaged_mode() {
        let mut command = Command::new("installer");
        configure_uv_installer(&mut command, Path::new("private-tools"));
        let envs: std::collections::HashMap<_, _> = command.get_envs().collect();

        assert_eq!(envs.get(OsStr::new("UV_INSTALL_DIR")), Some(&None));
        assert_eq!(
            envs.get(OsStr::new("UV_UNMANAGED_INSTALL")).and_then(|value| *value),
            Some(OsStr::new("private-tools"))
        );
        assert_eq!(
            envs.get(OsStr::new("UV_NO_MODIFY_PATH")).and_then(|value| *value),
            Some(OsStr::new("1"))
        );
    }

    #[test]
    fn uv_version_probe_requires_the_pinned_version() {
        assert!(uv_version_matches(
            format!("uv {} (build-id)\n", UV_VERSION).as_bytes()
        ));
        assert!(!uv_version_matches(b"uv 0.10.0 (older)\n"));
        assert!(!uv_version_matches(b"not-uv 0.11.7\n"));
        assert!(!uv_version_matches(b"uv\n"));
        assert!(!uv_version_matches(&[0xff, 0xfe]));
    }

    #[test]
    fn installer_error_includes_captured_stderr() {
        let output = Output {
            status: failure_status(),
            stdout: Vec::new(),
            stderr: b"profile update denied".to_vec(),
        };
        assert_eq!(installer_output_detail(&output), ": profile update denied");
    }

    #[test]
    fn installer_error_redacts_unix_and_windows_home_paths() {
        assert_eq!(
            redact_home_prefix(
                "installed into /Users/alice/.local/bin",
                "/Users/alice"
            ),
            "installed into ~/.local/bin"
        );
        assert_eq!(
            redact_home_prefix(
                r"installed into C:\Users\alice\.local\bin",
                r"C:\Users\alice"
            ),
            r"installed into ~\.local\bin"
        );
        assert_eq!(
            redact_home_prefix(
                "installed into C:/Users/alice/.local/bin",
                r"C:\Users\alice"
            ),
            "installed into ~/.local/bin"
        );
    }

    #[test]
    fn installer_exit_one_is_accepted_when_downloaded_uv_is_usable() {
        let dest = Path::new("private-tools");
        let uv_bin = dest.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        let output = Output {
            status: failure_status(),
            stdout: Vec::new(),
            stderr: b"later installer step failed".to_vec(),
        };

        let result = finish_uv_install_with_probe(dest, &uv_bin, output, |candidate| {
            candidate == uv_bin
        });

        assert_eq!(result.unwrap(), uv_bin);
    }

    #[test]
    fn successful_installer_without_usable_uv_is_rejected() {
        let dest = Path::new("private-tools");
        let uv_bin = dest.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        let output = Output {
            status: success_status(),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };

        let error = finish_uv_install_with_probe(dest, &uv_bin, output, |_| false)
            .expect_err("installer success is insufficient without a usable binary");

        assert!(error.to_string().contains("no usable binary was found"));
    }

    #[test]
    fn failed_installer_with_unusable_uv_reports_captured_error() {
        let dest = Path::new("private-tools");
        let uv_bin = dest.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        let output = Output {
            status: failure_status(),
            stdout: Vec::new(),
            stderr: b"downloaded executable was corrupt".to_vec(),
        };

        let error = finish_uv_install_with_probe(dest, &uv_bin, output, |_| false)
            .expect_err("an unusable download must not be accepted");

        assert!(error.to_string().contains("downloaded executable was corrupt"));
    }

    #[test]
    fn usable_legacy_bin_location_is_relocated() {
        let unique = format!(
            "voicestudio-uv-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dest = std::env::temp_dir().join(unique);
        let uv_bin = dest.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        let legacy = dest
            .join("bin")
            .join(if cfg!(windows) { "uv.exe" } else { "uv" });
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"verified test executable").unwrap();
        let output = Output {
            status: success_status(),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };

        let result = finish_uv_install_with_probe(&dest, &uv_bin, output, |candidate| {
            candidate.is_file()
        });

        assert_eq!(result.unwrap(), uv_bin);
        assert!(uv_bin.is_file());
        assert!(!legacy.exists());
        fs::remove_dir_all(dest).unwrap();
    }

    #[cfg(unix)]
    fn success_status() -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0)
    }

    #[cfg(windows)]
    fn success_status() -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0)
    }

    #[cfg(unix)]
    fn failure_status() -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(1 << 8)
    }

    #[cfg(windows)]
    fn failure_status() -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(1)
    }
}
