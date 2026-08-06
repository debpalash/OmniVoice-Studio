//! First-run install setup: the pre-bootstrap configuration surface.
//!
//! Nothing downloads or installs until the user confirms an [`InstallPlan`]
//! via `complete_setup`. The module is split into:
//!   - requirements: minimum-disk constants (measured, with headroom)
//!   - disk:         per-path free-space / writability probing
//!   - paths:        portable-base + platform default dir resolution
//!   - plan:         InstallPlan validation + application
//!   - commands:     the three Tauri IPC entry points
//!
//! Resolution helpers (`env_root`, `resolved_data_dir`, `resolved_models_dir`)
//! are consumed by `bootstrap.rs` / `backend.rs` so the chosen layout is the
//! single source of truth for every later spawn.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::bootstrap::{set_stage, BootstrapStage, BootstrapState};
use crate::config::{self, MirrorOverrides};

// ── Requirements ──────────────────────────────────────────────────────────

pub const GIB: u64 = 1024 * 1024 * 1024;

/// Python environment (venv + torch/whisperx/demucs wheels). Measured at
/// 7.8 GiB on Linux x64 CUDA (v0.3.5); rounded up for pip build temp files.
pub const REQUIRED_ENV_BYTES: u64 = 9 * GIB;

/// Default model set (TTS checkpoint + whisper + demucs in the HF cache).
/// Measured at 6.1 GiB after a full clone+dub session; headroom for revisions.
pub const REQUIRED_MODELS_BYTES: u64 = 7 * GIB;

/// Voice data, generation outputs, SQLite DB. Grows with use; 1 GiB floor so
/// a first session never hits a full disk mid-render.
pub const REQUIRED_DATA_BYTES: u64 = GIB;

/// Folder created next to the executable / AppImage in portable mode. The
/// whole install (env + models + voices + config) lives inside it, so moving
/// `app + this folder` together relocates the install.
pub const PORTABLE_DIR_NAME: &str = "OmniVoiceStudio-Data";

// ── Disk probing ──────────────────────────────────────────────────────────

mod disk {
    use super::*;

    /// The chosen directory usually doesn't exist yet — walk up to the
    /// nearest ancestor that does, since that's where space/permissions live.
    pub fn nearest_existing(path: &Path) -> PathBuf {
        let mut cur = path.to_path_buf();
        while !cur.exists() {
            match cur.parent() {
                Some(p) => cur = p.to_path_buf(),
                None => break,
            }
        }
        cur
    }

    pub fn available_bytes(path: &Path) -> Option<u64> {
        fs4::available_space(nearest_existing(path)).ok()
    }

    /// Stable identity of the filesystem holding `path`, so requirements for
    /// dirs that share a disk are summed before comparing against free space.
    #[cfg(unix)]
    pub fn fs_key(path: &Path) -> Option<String> {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(nearest_existing(path)).ok().map(|m| format!("dev:{}", m.dev()))
    }

    #[cfg(not(unix))]
    pub fn fs_key(path: &Path) -> Option<String> {
        // Windows: the drive prefix (`C:\`) identifies the volume.
        nearest_existing(path)
            .components()
            .next()
            .map(|c| format!("vol:{}", c.as_os_str().to_string_lossy().to_uppercase()))
    }

    /// Probe writability of the nearest existing ancestor with a real write —
    /// permission bits lie (ACLs, read-only mounts, translocation), a temp
    /// file doesn't. Never creates the target dir itself; that only happens
    /// on `complete_setup`.
    pub fn writable(path: &Path) -> bool {
        let base = nearest_existing(path);
        if !base.is_dir() {
            return false;
        }
        let probe = base.join(format!(".omnivoice-write-test-{}", std::process::id()));
        match fs::write(&probe, b"ok") {
            Ok(()) => {
                let _ = fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    }
}

// ── Path resolution ───────────────────────────────────────────────────────

/// Directory that would hold a portable install: next to the executable —
/// or next to the `.AppImage` file on Linux (the mounted exe path is an
/// ephemeral squashfs mount, useless as an anchor).
pub fn portable_base() -> Option<PathBuf> {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        return Path::new(&appimage).parent().map(|p| p.join(PORTABLE_DIR_NAME));
    }
    let exe = std::env::current_exe().ok()?;
    let mut anchor = exe.parent()?.to_path_buf();
    // macOS: step out of `Foo.app/Contents/MacOS` so the data folder sits
    // beside the .app bundle, not inside it (inside breaks code signing).
    if let Some(app_bundle) = anchor
        .ancestors()
        .find(|a| a.extension().map(|e| e == "app").unwrap_or(false))
    {
        anchor = app_bundle.parent()?.to_path_buf();
    }
    Some(anchor.join(PORTABLE_DIR_NAME))
}

/// Mirror of `backend/core/config.py::get_app_data_dir()` platform defaults —
/// shown in the UI so the user sees concrete paths, never "(default)".
pub fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs_next::home_dir().unwrap_or_default().join("Library/Application Support/OmniVoice")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("OmniVoice")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs_next::home_dir().unwrap_or_default().join(".omnivoice")
    }
}

/// Default HF model cache (mirrors huggingface_hub + the backend's Windows
/// MAX_PATH redirect in `backend/core/config.py`).
pub fn default_models_dir() -> PathBuf {
    if let Ok(hf_home) = std::env::var("HF_HOME") {
        return PathBuf::from(hf_home);
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("OmniVoice")
            .join("hf_cache")
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs_next::home_dir().unwrap_or_default().join(".cache/huggingface")
    }
}

/// Root that holds the managed Python project (`<root>/project/.venv`).
/// Single source of truth for bootstrap + clean-retry + backend spawn.
pub fn env_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    let cfg = config::load_config(app);
    if cfg.install_mode == "portable" {
        if let Some(base) = portable_base() {
            return base.join("env");
        }
    }
    if let Some(dir) = cfg.env_dir.as_deref().filter(|s| !s.is_empty()) {
        return PathBuf::from(dir);
    }
    app.path().app_local_data_dir().unwrap_or_default()
}

/// User-chosen backend data dir (voices/projects/db) → `OMNIVOICE_DATA_DIR`.
/// `None` = backend platform default; we deliberately don't set the env var
/// then, so legacy installs keep byte-identical behavior.
pub fn resolved_data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let cfg = config::load_config(app);
    if cfg.install_mode == "portable" {
        return portable_base().map(|b| b.join("data"));
    }
    cfg.data_dir.as_deref().filter(|s| !s.is_empty()).map(PathBuf::from)
}

/// User-chosen model cache dir → `OMNIVOICE_CACHE_DIR` (backend maps it to
/// HF_HOME / HF_HUB_CACHE / TORCH_HOME). Same `None` = default contract.
pub fn resolved_models_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let cfg = config::load_config(app);
    if cfg.install_mode == "portable" {
        return portable_base().map(|b| b.join("data").join("models"));
    }
    cfg.models_dir.as_deref().filter(|s| !s.is_empty()).map(PathBuf::from)
}

// ── uv volume co-location ─────────────────────────────────────────────────

/// Env overrides for every `uv` invocation so its heavy state (wheel cache,
/// managed Python) lives on the **same volume as the managed env**.
///
/// uv's defaults put both under the OS cache/data roots on the system drive
/// (`%LOCALAPPDATA%\uv\…`, `~/.cache/uv`, `~/.local/share/uv`). When the user
/// roots the install on another drive (custom env dir or portable mode on
/// D:), every wheel — torch alone is multi-GB — is downloaded and unpacked
/// on the SYSTEM drive first and then cross-volume **copied** (hardlinks
/// can't cross volumes) into the venv: the system drive silently needs as
/// much space as the whole install and fills up even though the user chose
/// D: precisely because C: was tight (Discord report, tarbol6457).
///
/// Rules:
/// - only fires when the env root's volume differs from the OS cache root's
///   volume (the proxy for uv's default cache location) — default installs
///   are byte-identical;
/// - an explicit `UV_CACHE_DIR` / `UV_PYTHON_INSTALL_DIR` from the user's
///   environment always wins (we never override either).
///
/// The dirs live under the env root (`<env_root>/uv-cache`, `uv-python`), so
/// they survive Clean & Retry (which only removes `project/`) and are removed
/// with the install.
pub fn uv_env_overrides_for(env_root: &Path) -> Vec<(&'static str, PathBuf)> {
    let same_volume = match dirs_next::cache_dir() {
        Some(cache_root) => match (disk::fs_key(env_root), disk::fs_key(&cache_root)) {
            (Some(a), Some(b)) => a == b,
            // Can't identify one of the volumes — keep uv's state with the
            // env root; co-locating is always correct, just possibly redundant.
            _ => false,
        },
        None => false,
    };
    if same_volume {
        return Vec::new();
    }
    let mut out = Vec::new();
    if std::env::var_os("UV_CACHE_DIR").is_none() {
        out.push(("UV_CACHE_DIR", env_root.join("uv-cache")));
    }
    if std::env::var_os("UV_PYTHON_INSTALL_DIR").is_none() {
        out.push(("UV_PYTHON_INSTALL_DIR", env_root.join("uv-python")));
    }
    out
}

/// [`uv_env_overrides_for`] with the env root resolved from the live config.
pub fn uv_env_overrides<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<(&'static str, PathBuf)> {
    uv_env_overrides_for(&env_root(app))
}

// ── First-run detection ───────────────────────────────────────────────────

/// True only when there is nothing to attach to and the user has never
/// completed (or implicitly owned) an install:
///   - `setup_complete` in config       → returning user
///   - dev tree with a `.venv`          → contributor running from source
///   - existing bootstrapped venv       → pre-setup-screen install (already
///     owned; `migrate_existing_install_if_needed` marks it complete).
///
/// Pure read — safe from `get_setup_state` and any future informational
/// caller. The migration write lives in `migrate_existing_install_if_needed`
/// and only runs on the bootstrap thread.
pub fn is_first_run<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let cfg = config::load_config(app);
    if cfg.setup_complete {
        return false;
    }
    if let Some(dev_root) = crate::bootstrap::find_dev_project_root() {
        if crate::bootstrap::venv_python_path(&dev_root.join(".venv")).is_file() {
            return false;
        }
    }
    let existing_venv = crate::bootstrap::venv_python_path(&env_root(app).join("project").join(".venv"));
    !existing_venv.is_file()
}

/// Pre-setup-screen install detected (venv on disk, `setup_complete` still
/// false): mark it complete instead of re-asking questions whose answers are
/// already on disk. Called once, explicitly, from the bootstrap thread —
/// keeping `is_first_run` side-effect-free for read-only IPC callers.
pub fn migrate_existing_install_if_needed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let mut cfg = config::load_config(app);
    if cfg.setup_complete {
        return;
    }
    let existing_venv = crate::bootstrap::venv_python_path(&env_root(app).join("project").join(".venv"));
    if existing_venv.is_file() {
        log::info!("Existing pre-setup-screen install detected — marking setup complete");
        cfg.setup_complete = true;
        config::save_config(app, &cfg);
    }
}

// ── IPC payloads ──────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub first_run: bool,
    /// "linux" | "macos" | "windows" — lets the UI hide platform-specific
    /// opt-ins (e.g. the Linux-only ROCm torch variant) per the
    /// cross-platform parity rule: identical defaults everywhere,
    /// platform-only choices never shown where they can't work.
    pub os: &'static str,
    pub defaults: SetupDefaults,
    pub portable: PortableSupport,
    pub requirements: Requirements,
    pub hardware: HardwareInfo,
}

/// What the machine offers, shown on the Compute card so the accelerator
/// choice is informed rather than a guess. Detection is best-effort and
/// must never block setup: every probe degrades to None/CPU.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    /// Marketing name when detectable ("NVIDIA GeForce RTX 4070 …").
    pub gpu: Option<String>,
    /// "cuda" | "rocm" | "amd" | "mps" | "cpu" — which torch path this maps
    /// to. "rocm" means an AMD GPU *with verified ROCm userspace* (safe to
    /// pre-select the ROCm wheels); "amd" means an AMD GPU was found but the
    /// ROCm runtime wasn't — the UI offers ROCm without pre-selecting it.
    pub kind: String,
    /// Human OS name: distro PRETTY_NAME on Linux ("CachyOS", "Ubuntu 24.04"),
    /// "macOS" / "Windows" elsewhere. The install matrix (OS family × distro
    /// × arch × GPU vendor) is what users file bug reports with — show it.
    pub os_name: String,
    /// "x86_64" | "aarch64" | … — Apple Silicon vs Intel mac, ARM Linux
    /// (Asahi/Jetson) vs x64 all behave differently for wheels.
    pub arch: &'static str,
    pub cpu_cores: usize,
    pub ram_gb: f64,
}

/// Distro-aware OS label. Linux reads /etc/os-release PRETTY_NAME (falls
/// back to NAME, then "Linux"); macOS/Windows are just themselves.
fn os_pretty_name() -> String {
    #[cfg(target_os = "linux")]
    {
        if let Ok(body) = fs::read_to_string("/etc/os-release") {
            for key in ["PRETTY_NAME=", "NAME="] {
                if let Some(line) = body.lines().find(|l| l.starts_with(key)) {
                    let v = line[key.len()..].trim().trim_matches('"');
                    if !v.is_empty() {
                        return v.to_string();
                    }
                }
            }
        }
        "Linux".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "macOS".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "Windows".to_string()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        std::env::consts::OS.to_string()
    }
}

/// ROCm userspace present? A PCI vendor ID alone doesn't mean the HIP/ROCm
/// runtime is installed — without it the ROCm torch wheels can't run. Cheap
/// probes only: the canonical install prefix, or `rocminfo` on PATH.
#[cfg(target_os = "linux")]
fn rocm_userspace_present() -> bool {
    if Path::new("/opt/rocm").is_dir() {
        return true;
    }
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|p| p.join("rocminfo").is_file())
    })
}

fn detect_hardware() -> HardwareInfo {
    use std::process::Command;
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let ram_gb = {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        (sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0) * 10.0).round() / 10.0
    };
    let os_name = os_pretty_name();
    let arch = std::env::consts::ARCH;
    let base = move |gpu: Option<String>, kind: &str| HardwareInfo {
        gpu,
        kind: kind.into(),
        os_name: os_name.clone(),
        arch,
        cpu_cores: cores,
        ram_gb,
    };

    // NVIDIA: nvidia-smi ships with the driver on Linux + Windows. It runs
    // in a helper thread with a short timeout: this probe sits inside the
    // IPC the setup screen awaits on mount, and a wedged driver can hang
    // nvidia-smi indefinitely — degrading to CPU beats hanging first-run.
    // (On timeout the helper thread is abandoned; it exits with the process.)
    let nvidia_name = {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut smi = Command::new("nvidia-smi");
            smi.args(["--query-gpu=name", "--format=csv,noheader"]);
            // Windows: a GUI app spawning a console binary flashes a cmd
            // window — on the very first screen a user ever sees.
            // CREATE_NO_WINDOW stops it.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                smi.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            let _ = tx.send(smi.output());
        });
        match rx.recv_timeout(std::time::Duration::from_secs(3)) {
            Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty()),
            _ => None,
        }
    };
    if let Some(name) = nvidia_name {
        return base(Some(name), "cuda");
    }

    // Apple Silicon → MPS.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return base(Some("Apple Silicon".into()), "mps");
    }

    // AMD on Linux: a DRM card with vendor 0x1002. Only report "rocm" (and
    // let the UI pre-select the ROCm wheels) when the ROCm userspace is
    // actually installed — vendor ID alone doesn't imply HIP/libamdhip64,
    // and ROCm torch on a stock distro silently falls back to CPU. Without
    // the runtime it's "amd": informational, ROCm offered but not chosen.
    // No marketing name without lspci, so stay generic.
    #[cfg(target_os = "linux")]
    {
        if let Ok(entries) = fs::read_dir("/sys/class/drm") {
            for e in entries.flatten() {
                let vendor = e.path().join("device").join("vendor");
                if let Ok(v) = fs::read_to_string(&vendor) {
                    if v.trim() == "0x1002" {
                        let kind = if rocm_userspace_present() { "rocm" } else { "amd" };
                        return base(Some("AMD GPU".into()), kind);
                    }
                }
            }
        }
    }

    base(None, "cpu")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupDefaults {
    pub install_mode: String,
    pub env_dir: String,
    pub data_dir: String,
    pub models_dir: String,
    pub region: String,
    pub update_channel: String,
    pub torch_variant: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSupport {
    pub available: bool,
    pub base_dir: Option<String>,
    /// Machine-readable reason when unavailable: "not_writable" | "no_anchor".
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirements {
    pub env_bytes: u64,
    pub models_bytes: u64,
    pub data_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetCheck {
    pub path: String,
    pub exists: bool,
    pub writable: bool,
    pub free_bytes: Option<u64>,
    pub fs_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub install_mode: String,
    #[serde(default)]
    pub env_dir: Option<String>,
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub models_dir: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub update_channel: Option<String>,
    #[serde(default)]
    pub torch_variant: Option<String>,
    #[serde(default)]
    pub mirrors: Option<MirrorOverrides>,
}

// ── Plan validation + application ─────────────────────────────────────────

fn none_if_default(chosen: &Option<String>, default: &Path) -> Option<String> {
    chosen
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| Path::new(s) != default)
        .map(str::to_string)
}

/// Loopback-only exception to the HTTPS requirement: a local registry/cache
/// (devpi, bazel-remote, …) can't MITM itself. Host must be exactly
/// localhost / 127.0.0.1 / [::1], optionally followed by a port or path —
/// `http://localhost.evil.com` must NOT match.
fn is_loopback_http(u: &str) -> bool {
    ["http://localhost", "http://127.0.0.1", "http://[::1]"].iter().any(|prefix| {
        u.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(':') || rest.starts_with('/'))
    })
}

/// Mirrors feed `UV_PYTHON_INSTALL_MIRROR` / `UV_INDEX_URL` / `HF_ENDPOINT` —
/// the supply chain for the Python runtime, every wheel, and model weights.
/// Plaintext http:// would let anyone on the network swap those payloads, so
/// HTTPS is required (loopback excepted for local registries).
fn valid_mirror(url: &Option<String>) -> Result<Option<String>, String> {
    match url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(u) if u.starts_with("https://") || is_loopback_http(u) => Ok(Some(u.to_string())),
        Some(u) if u.starts_with("http://") => Err(format!(
            "Plaintext http:// mirrors are not allowed (packages could be tampered with in transit) — use https:// — got: {u}"
        )),
        Some(u) => Err(format!("Mirror URL must start with https:// — got: {u}")),
    }
}

/// (target dir, bytes required there) for the chosen layout.
fn space_targets(plan: &InstallPlan, env_default: &Path) -> Vec<(PathBuf, u64)> {
    if plan.install_mode == "portable" {
        // Everything shares one folder → one combined requirement.
        let base = portable_base().unwrap_or_default();
        return vec![(base, REQUIRED_ENV_BYTES + REQUIRED_MODELS_BYTES + REQUIRED_DATA_BYTES)];
    }
    let dir_of = |s: &Option<String>, d: &Path| {
        s.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| d.to_path_buf())
    };
    vec![
        (dir_of(&plan.env_dir, env_default), REQUIRED_ENV_BYTES),
        (dir_of(&plan.data_dir, &default_data_dir()), REQUIRED_DATA_BYTES),
        (dir_of(&plan.models_dir, &default_models_dir()), REQUIRED_MODELS_BYTES),
    ]
}

/// Authoritative install gate: group targets by filesystem, sum what each
/// volume must hold, and refuse the plan when any volume falls short. The UI
/// runs the same math for live feedback; this is the backstop that actually
/// "won't let install".
fn check_space(targets: &[(PathBuf, u64)]) -> Result<(), String> {
    use std::collections::HashMap;
    let mut by_fs: HashMap<String, (PathBuf, u64)> = HashMap::new();
    for (dir, need) in targets {
        let key = disk::fs_key(dir).unwrap_or_else(|| dir.to_string_lossy().into_owned());
        let entry = by_fs.entry(key).or_insert_with(|| (dir.clone(), 0));
        entry.1 += need;
    }
    for (dir, need) in by_fs.values() {
        let free = disk::available_bytes(dir)
            .ok_or_else(|| format!("Could not determine free space for {}", dir.display()))?;
        if free < *need {
            return Err(format!(
                "Not enough free space on the disk holding {}: needs ~{:.1} GB, only {:.1} GB available.",
                dir.display(),
                *need as f64 / GIB as f64,
                free as f64 / GIB as f64,
            ));
        }
    }
    Ok(())
}

fn check_writable(targets: &[(PathBuf, u64)]) -> Result<(), String> {
    for (dir, _) in targets {
        if !disk::writable(dir) {
            return Err(format!("Directory is not writable: {}", dir.display()));
        }
    }
    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_setup_state(app: tauri::AppHandle) -> SetupState {
    let cfg = config::load_config(&app);
    let env_default = app.path().app_local_data_dir().unwrap_or_default();

    let portable = match portable_base() {
        Some(base) if disk::writable(&base) => PortableSupport {
            available: true,
            base_dir: Some(base.to_string_lossy().into_owned()),
            reason: None,
        },
        Some(base) => PortableSupport {
            available: false,
            base_dir: Some(base.to_string_lossy().into_owned()),
            reason: Some("not_writable".into()),
        },
        None => PortableSupport { available: false, base_dir: None, reason: Some("no_anchor".into()) },
    };

    SetupState {
        first_run: is_first_run(&app),
        os: std::env::consts::OS,
        defaults: SetupDefaults {
            install_mode: cfg.install_mode,
            env_dir: env_default.to_string_lossy().into_owned(),
            data_dir: default_data_dir().to_string_lossy().into_owned(),
            models_dir: default_models_dir().to_string_lossy().into_owned(),
            region: cfg.region,
            update_channel: cfg.update_channel,
            torch_variant: cfg.torch_variant,
        },
        portable,
        requirements: Requirements {
            env_bytes: REQUIRED_ENV_BYTES,
            models_bytes: REQUIRED_MODELS_BYTES,
            data_bytes: REQUIRED_DATA_BYTES,
        },
        hardware: detect_hardware(),
    }
}

#[tauri::command]
pub fn check_install_target(path: String) -> TargetCheck {
    let p = PathBuf::from(path.trim());
    TargetCheck {
        exists: p.exists(),
        writable: disk::writable(&p),
        free_bytes: disk::available_bytes(&p),
        fs_key: disk::fs_key(&p),
        path: p.to_string_lossy().into_owned(),
    }
}

/// Validate the plan, persist it, then start the (until now deliberately
/// parked) bootstrap. Any `Err` keeps the app in `AwaitingSetup` with the
/// message surfaced on the setup screen — nothing was installed.
#[tauri::command]
pub fn complete_setup(
    app: tauri::AppHandle,
    state: tauri::State<'_, BootstrapState>,
    plan: InstallPlan,
) -> Result<(), String> {
    if !matches!(plan.install_mode.as_str(), "installed" | "portable") {
        return Err(format!("Unknown install mode: {}", plan.install_mode));
    }
    if plan.install_mode == "portable" && portable_base().map(|b| disk::writable(&b)) != Some(true) {
        return Err("Portable mode is unavailable: the folder next to the app is not writable.".into());
    }

    let mirrors = match &plan.mirrors {
        None => MirrorOverrides::default(),
        Some(m) => MirrorOverrides {
            pypi_index: valid_mirror(&m.pypi_index)?,
            hf_endpoint: valid_mirror(&m.hf_endpoint)?,
            python_downloads: valid_mirror(&m.python_downloads)?,
        },
    };

    let env_default = app.path().app_local_data_dir().unwrap_or_default();
    let targets = space_targets(&plan, &env_default);
    check_writable(&targets)?;
    check_space(&targets)?;

    let mut cfg = config::load_config(&app);
    cfg.setup_complete = true;
    cfg.install_mode = plan.install_mode.clone();
    cfg.env_dir = none_if_default(&plan.env_dir, &env_default);
    cfg.data_dir = none_if_default(&plan.data_dir, &default_data_dir());
    cfg.models_dir = none_if_default(&plan.models_dir, &default_models_dir());
    cfg.mirrors = mirrors;
    if let Some(region) = plan.region.as_deref().filter(|r| config::VALID_REGIONS.contains(r)) {
        cfg.region = region.to_string();
    }
    if let Some(channel) = plan.update_channel.as_deref().filter(|c| config::VALID_CHANNELS.contains(c)) {
        cfg.update_channel = channel.to_string();
    }
    if let Some(variant) = plan.torch_variant.as_deref().filter(|v| ["auto", "rocm"].contains(v)) {
        // ROCm wheels exist for Linux only — clamp anywhere else so a stray
        // payload can't configure an install that has no wheels to pull.
        cfg.torch_variant = if variant == "rocm" && !cfg!(target_os = "linux") {
            "auto".to_string()
        } else {
            variant.to_string()
        };
    }
    cfg.locale = plan.locale.clone().filter(|l| !l.is_empty());

    if plan.install_mode == "portable" {
        // Create the portable folder and seed config.json INSIDE it first, so
        // `config_path` resolves portable from here on and the whole install
        // (env + data + config) travels as one folder.
        let base = portable_base().ok_or("Portable anchor disappeared")?;
        fs::create_dir_all(&base).map_err(|e| format!("Could not create {}: {e}", base.display()))?;
        config::save_config_at(&base.join("config.json"), &cfg)?;
    } else {
        for (dir, _) in &targets {
            fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        }
    }
    // The plan must actually persist before bootstrap starts — a swallowed
    // write error here would bootstrap into a stale layout from disk while
    // the UI reports success.
    let cfg_path = config::config_path(&app).ok_or("Could not resolve the config file path")?;
    config::save_config_at(&cfg_path, &cfg)?;

    // Custom paths are home-relative PII — log default-vs-custom flags, not
    // the raw locations.
    let custom = |v: &Option<String>| if v.is_some() { "custom" } else { "default" };
    log::info!(
        "Setup complete (mode={}, env={}, data={}, models={}) — starting bootstrap",
        cfg.install_mode,
        custom(&cfg.env_dir),
        custom(&cfg.data_dir),
        custom(&cfg.models_dir),
    );

    // `--setup` re-entry: a backend from the previous configuration may
    // still be serving. retry_bootstrap would attach to it and the new
    // env/mirror/layout settings would never apply — tear it down so the
    // restart spawns with the just-saved plan. (No-op on a true first run:
    // nothing is listening yet.)
    if crate::backend::port_in_use(crate::backend_port()) {
        log::info!(
            "Backend still running on port {} — restarting it so the new setup applies",
            crate::backend_port()
        );
        crate::backend::kill_orphan_on_port(crate::backend_port());
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    set_stage(&state.stage, BootstrapStage::Checking);
    crate::bootstrap::retry_bootstrap(app, state);
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// D:-install class (tarbol6457): one test fn (not several) because it
    /// mutates process env vars and Rust tests run in parallel.
    #[test]
    fn uv_env_overrides_colocate_only_across_volumes_and_respect_user_env() {
        // Same volume as uv's default cache root → no overrides: default
        // installs must stay byte-identical.
        let cache_root = dirs_next::cache_dir().expect("cache dir");
        assert!(
            uv_env_overrides_for(&cache_root).is_empty(),
            "env root on the default-cache volume must not be redirected"
        );

        // A root whose volume can't match anything real. On Windows an
        // unmapped drive letter is a different volume by fs_key; on Unix,
        // fs_key(nonexistent-with-no-real-ancestor) still resolves via
        // nearest_existing to `/` — so instead simulate by comparing keys.
        let env_root = PathBuf::from(if cfg!(windows) {
            "Q:\\omnivoice-test-fake-root" // unmapped drive letter → distinct volume key
        } else {
            "/omnivoice-test-fake-root" // resolves to `/` — a different device than
                                        // the user cache root on macOS (sealed system
                                        // volume) and on split-partition Linux
        });
        let keys_differ = disk::fs_key(&env_root) != disk::fs_key(&cache_root);
        let overrides = uv_env_overrides_for(&env_root);
        if keys_differ {
            assert!(
                overrides.iter().any(|(k, v)| *k == "UV_CACHE_DIR" && v.starts_with(&env_root)),
                "cross-volume env root must pin UV_CACHE_DIR under the env root, got {overrides:?}"
            );
            assert!(
                overrides.iter().any(|(k, v)| *k == "UV_PYTHON_INSTALL_DIR" && v.starts_with(&env_root)),
                "cross-volume env root must pin UV_PYTHON_INSTALL_DIR under the env root"
            );

            // An explicit user UV_CACHE_DIR always wins — never overridden.
            std::env::set_var("UV_CACHE_DIR", cache_root.join("user-pinned"));
            let with_user = uv_env_overrides_for(&env_root);
            assert!(
                !with_user.iter().any(|(k, _)| *k == "UV_CACHE_DIR"),
                "user-pinned UV_CACHE_DIR must be respected"
            );
            std::env::remove_var("UV_CACHE_DIR");
        }
    }

    #[test]
    fn nearest_existing_walks_up_to_a_real_dir() {
        let tmp = std::env::temp_dir();
        let ghost = tmp.join("omnivoice-no-such-dir").join("deeper").join("still-deeper");
        let found = disk::nearest_existing(&ghost);
        assert!(found.exists(), "must resolve to an existing ancestor");
        assert!(ghost.starts_with(&found));
    }

    #[test]
    fn available_bytes_reports_space_for_temp_dir() {
        let free = disk::available_bytes(&std::env::temp_dir());
        assert!(free.is_some(), "temp dir must report free space");
        assert!(free.unwrap() > 0);
    }

    #[test]
    fn fs_key_is_stable_and_groups_same_volume() {
        let tmp = std::env::temp_dir();
        let a = disk::fs_key(&tmp);
        let b = disk::fs_key(&tmp.join("does-not-exist-yet"));
        assert!(a.is_some());
        assert_eq!(a, b, "child of the same volume must share the fs key");
    }

    #[test]
    fn writable_accepts_temp_and_rejects_nonsense() {
        assert!(disk::writable(&std::env::temp_dir().join("new-subdir-not-created")));
        #[cfg(unix)]
        assert!(
            !disk::writable(Path::new("/proc/omnivoice-definitely-not-writable")),
            "procfs is not writable"
        );
    }

    #[test]
    fn space_targets_portable_collapses_to_one_combined_requirement() {
        let plan = InstallPlan {
            install_mode: "portable".into(),
            env_dir: None, data_dir: None, models_dir: None,
            region: None, locale: None, update_channel: None,
            torch_variant: None, mirrors: None,
        };
        let targets = space_targets(&plan, Path::new("/unused"));
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].1, REQUIRED_ENV_BYTES + REQUIRED_MODELS_BYTES + REQUIRED_DATA_BYTES);
    }

    #[test]
    fn space_targets_installed_checks_each_location() {
        let plan = InstallPlan {
            install_mode: "installed".into(),
            env_dir: Some("/x/env".into()),
            data_dir: Some("/y/data".into()),
            models_dir: None, // default
            region: None, locale: None, update_channel: None,
            torch_variant: None, mirrors: None,
        };
        let targets = space_targets(&plan, Path::new("/default-env"));
        assert_eq!(targets.len(), 3);
        assert_eq!(targets[0], (PathBuf::from("/x/env"), REQUIRED_ENV_BYTES));
        assert_eq!(targets[1], (PathBuf::from("/y/data"), REQUIRED_DATA_BYTES));
        assert_eq!(targets[2].1, REQUIRED_MODELS_BYTES);
        assert_eq!(targets[2].0, default_models_dir());
    }

    #[test]
    fn check_space_sums_requirements_sharing_a_volume() {
        // Both targets resolve to the temp-dir volume; an absurd combined
        // requirement must fail even when each alone might pass.
        let tmp = std::env::temp_dir();
        let huge = 1024 * 1024 * GIB; // 1 EiB — no consumer disk has this
        let res = check_space(&[(tmp.clone(), huge), (tmp.join("sub"), huge)]);
        assert!(res.is_err(), "1 EiB×2 on one volume must be rejected");
        let msg = res.unwrap_err();
        assert!(msg.contains("Not enough free space"), "msg: {msg}");
    }

    #[test]
    fn check_space_accepts_tiny_requirements() {
        assert!(check_space(&[(std::env::temp_dir(), 1)]).is_ok());
    }

    #[test]
    fn mirror_validation_requires_https_scheme() {
        assert_eq!(valid_mirror(&None).unwrap(), None);
        assert_eq!(valid_mirror(&Some("  ".into())).unwrap(), None);
        assert_eq!(
            valid_mirror(&Some("https://hf-mirror.com".into())).unwrap().as_deref(),
            Some("https://hf-mirror.com")
        );
        assert!(valid_mirror(&Some("ftp://nope".into())).is_err());
        assert!(valid_mirror(&Some("hf-mirror.com".into())).is_err());
        // Plaintext http:// is a MITM supply-chain path — rejected.
        assert!(valid_mirror(&Some("http://mirrors.example.com/pypi".into())).is_err());
        // …except explicit loopback (local registry/cache).
        assert_eq!(
            valid_mirror(&Some("http://localhost:8081/simple".into())).unwrap().as_deref(),
            Some("http://localhost:8081/simple")
        );
        assert_eq!(
            valid_mirror(&Some("http://127.0.0.1/simple".into())).unwrap().as_deref(),
            Some("http://127.0.0.1/simple")
        );
        // Loopback-lookalike hosts must not slip through.
        assert!(valid_mirror(&Some("http://localhost.evil.com/simple".into())).is_err());
        assert!(valid_mirror(&Some("http://127.0.0.1.evil.com".into())).is_err());
    }

    #[test]
    fn none_if_default_strips_defaults_and_blanks() {
        let d = Path::new("/default/dir");
        assert_eq!(none_if_default(&None, d), None);
        assert_eq!(none_if_default(&Some("".into()), d), None);
        assert_eq!(none_if_default(&Some("/default/dir".into()), d), None);
        assert_eq!(none_if_default(&Some("/custom".into()), d), Some("/custom".into()));
    }

    #[test]
    fn detect_hardware_never_panics_and_reports_the_full_matrix() {
        let hw = detect_hardware();
        assert!(["cuda", "rocm", "amd", "mps", "cpu"].contains(&hw.kind.as_str()), "kind: {}", hw.kind);
        assert!(hw.ram_gb >= 0.0);
        assert!(!hw.os_name.is_empty(), "os_name must always resolve (distro or OS family)");
        assert!(!hw.arch.is_empty(), "arch must always resolve");
        #[cfg(target_arch = "x86_64")]
        assert_eq!(hw.arch, "x86_64");
    }

    #[test]
    fn requirements_match_measured_reality() {
        // Guard against accidental edits: env ≥ measured 7.8 GiB, models ≥
        // measured 6.1 GiB — shrinking below measurements would let installs
        // start that are guaranteed to die mid-download.
        assert!(REQUIRED_ENV_BYTES >= 8 * GIB);
        assert!(REQUIRED_MODELS_BYTES >= 7 * GIB);
        assert!(REQUIRED_DATA_BYTES >= GIB / 2);
    }
}
