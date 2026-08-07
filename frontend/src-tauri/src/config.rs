//! Persistent app configuration (region, dictation shortcut) and region helpers.

use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use std::time::Duration;

use serde::{Deserialize, Serialize};

// ── Persistent app config ─────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    /// Region for download mirrors.
    /// "auto" | "global" | "china" | "russia" | "restricted"
    ///
    /// - auto:       probe github.com; use ghproxy if unreachable
    /// - global:     direct downloads (github.com, pypi.org, huggingface.co)
    /// - china:      ghproxy.net + mirrors.aliyun.com + hf-mirror.com
    /// - russia:     ghproxy.net for GitHub; direct for PyPI/HF
    /// - restricted: ghproxy.net for GitHub (catch-all for MENA, Africa, etc.)
    #[serde(default = "default_region")]
    pub region: String,
    /// Accelerator string for the global dictation hotkey, e.g.
    /// "CmdOrCtrl+Shift+Space". Parsed by tauri-plugin-global-shortcut at
    /// register time. Falls back to the platform default when missing or
    /// unparseable.
    #[serde(default = "default_dictation_shortcut")]
    pub dictation_shortcut: String,
    /// When true, the app launches in pill (dictation-only) mode by default —
    /// no main studio window, dock icon hidden on macOS, tray shows only
    /// dictation controls. Equivalent to passing `--pill` on the command line.
    /// CLI flag still takes precedence when explicitly passed.
    #[serde(default = "default_launch_as_widget")]
    pub launch_as_widget: bool,
    /// Updater release channel: "stable" (default) | "preview".
    ///
    /// "preview" makes the auto-updater consult the rolling `preview`
    /// prerelease manifest first (falling back to stable), letting a user opt
    /// into latest-`main` builds. The channel is bound per update check in
    /// `updater_channel.rs` via `UpdaterExt::endpoints`, so switching takes
    /// effect on the very next check — no restart needed. Default stays
    /// stable on every launch.
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
    /// True once the user has confirmed the first-run setup screen (or an
    /// existing pre-setup-screen install was detected and silently migrated).
    /// While false on a machine with no venv, the bootstrap parks in
    /// `AwaitingSetup` and nothing downloads or installs.
    #[serde(default)]
    pub setup_complete: bool,
    /// "installed" (platform dirs, default) | "portable" (everything lives in
    /// `OmniVoiceStudio-Data/` next to the executable / AppImage).
    #[serde(default = "default_install_mode")]
    pub install_mode: String,
    /// Custom root for the managed Python env (`<dir>/project/.venv`).
    /// None → `app_local_data_dir()` (legacy behavior, byte-identical).
    #[serde(default)]
    pub env_dir: Option<String>,
    /// Custom backend data dir (voices/projects/db) → OMNIVOICE_DATA_DIR.
    /// None → backend platform default (env var not set at all).
    #[serde(default)]
    pub data_dir: Option<String>,
    /// Custom model-cache dir → OMNIVOICE_CACHE_DIR (backend maps to HF_HOME,
    /// HF_HUB_CACHE, TORCH_HOME). None → library defaults.
    #[serde(default)]
    pub models_dir: Option<String>,
    /// Where a RELOCATED portable folder lives, when the pointer file beside
    /// the app could not be written (a read-only `/Applications` or
    /// `Program Files` install). Second in `setup::portable_base()`'s
    /// resolution order — recording it here makes the install machine-bound,
    /// which is exactly why the pointer file is tried first.
    #[serde(default)]
    pub portable_dir: Option<String>,
    /// UI locale chosen on the setup screen, mirrored here so the Rust side
    /// (tray menus, dialogs) can localize in the future. The webview keeps its
    /// own copy in localStorage; this field is informational.
    #[serde(default)]
    pub locale: Option<String>,
    /// "auto" (CUDA/MPS/CPU autodetect, default) | "rocm" (AMD wheel reinstall
    /// after sync). Env var OMNIVOICE_TORCH_VARIANT still wins for power users.
    #[serde(default = "default_torch_variant")]
    pub torch_variant: String,
    /// Explicit mirror URLs that take precedence over region presets.
    #[serde(default)]
    pub mirrors: MirrorOverrides,
}

/// Per-source mirror overrides from the setup screen's Advanced section.
/// Each empty/None field falls back to the region preset for that source.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorOverrides {
    /// PyPI simple-index URL → UV_INDEX_URL during `uv sync`.
    #[serde(default)]
    pub pypi_index: Option<String>,
    /// Hugging Face endpoint → HF_ENDPOINT for the backend process.
    #[serde(default)]
    pub hf_endpoint: Option<String>,
    /// python-build-standalone release base → UV_PYTHON_INSTALL_MIRROR.
    #[serde(default)]
    pub python_downloads: Option<String>,
}

pub fn default_region() -> String { "auto".into() }
pub fn default_dictation_shortcut() -> String { "CmdOrCtrl+Shift+Space".into() }
pub fn default_launch_as_widget() -> bool { false }
pub fn default_update_channel() -> String { "stable".into() }
pub fn default_install_mode() -> String { "installed".into() }
pub fn default_torch_variant() -> String { "auto".into() }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            region: default_region(),
            dictation_shortcut: default_dictation_shortcut(),
            launch_as_widget: default_launch_as_widget(),
            update_channel: default_update_channel(),
            setup_complete: false,
            install_mode: default_install_mode(),
            env_dir: None,
            data_dir: None,
            models_dir: None,
            portable_dir: None,
            locale: None,
            torch_variant: default_torch_variant(),
            mirrors: MirrorOverrides::default(),
        }
    }
}

/// A `config.json` inside the exe-adjacent portable folder marks (and wins
/// over) the standard location — so a portable install keeps working when the
/// folder is moved to another machine/disk, with zero state left behind.
fn portable_config_file() -> Option<PathBuf> {
    crate::setup::portable_base()
        .map(|b| b.join("config.json"))
        .filter(|p| p.is_file())
}

pub fn config_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    portable_config_file()
        .or_else(|| app.path().app_local_data_dir().ok().map(|d: PathBuf| d.join("config.json")))
}

pub fn load_config<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppConfig {
    config_path(app)
        .and_then(|p| fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Load config BEFORE Tauri starts (no AppHandle available). Uses the
/// platform-standard local data dir + the bundle identifier directly via
/// `dirs-next`. Mirrors `app_local_data_dir()` behavior so the file written
/// by `save_config` is the same one read here. Used by `run()` to honor the
/// `launch_as_widget` preference at startup without a CLI flag.
pub fn load_config_pre_app() -> AppConfig {
    config_path_pre_app()
        .and_then(|p| fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Also used by `commands::webview_cache_paths` (#879) to locate the WebView2
/// profile cache before an `AppHandle` exists.
pub const BUNDLE_IDENTIFIER: &str = "com.debpalash.omnivoice-studio";

fn config_path_pre_app() -> Option<PathBuf> {
    portable_config_file().or_else(config_path_for_machine)
}

/// The per-user, platform-standard config path — never the portable one.
///
/// `setup::record_portable_dir` needs to write specifically HERE: the portable
/// config lives inside the folder whose location it is trying to record, so
/// storing the pointer there would be unreadable on the next launch.
pub fn config_path_for_machine() -> Option<PathBuf> {
    dirs_next::data_local_dir().map(|d| d.join(BUNDLE_IDENTIFIER).join("config.json"))
}

pub fn save_config<R: tauri::Runtime>(app: &tauri::AppHandle<R>, cfg: &AppConfig) {
    if let Some(p) = config_path(app) {
        let _ = save_config_at(&p, cfg);
    }
}

/// Write the config to an explicit path (used by `complete_setup` to seed the
/// portable folder before `config_path` starts resolving to it).
pub fn save_config_at(path: &PathBuf, cfg: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

// ── Region helpers ────────────────────────────────────────────────────────

pub const VALID_REGIONS: &[&str] = &["auto", "global", "china", "russia", "restricted"];

pub const VALID_CHANNELS: &[&str] = &["stable", "preview"];

/// Resolve a raw GitHub URL through the appropriate mirror for the given region.
/// If the region uses a proxy, prepends the proxy prefix.
#[allow(dead_code)] // Used in cfg(linux) and cfg(windows) FFmpeg download blocks
pub fn resolve_github_url(raw_github_url: &str, region: &str) -> String {
    match region {
        "china" | "russia" | "restricted" => format!("https://ghproxy.net/{}", raw_github_url),
        _ => raw_github_url.to_string(),
    }
}

/// Time a HEAD request to `url`, returning the round-trip latency when it
/// answers with a non-error status inside `timeout`. `None` = unreachable, too
/// slow, or an error status. This is the "ping the mirror" primitive.
fn probe_latency(url: &str, timeout: Duration) -> Option<std::time::Duration> {
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let start = std::time::Instant::now();
    match agent.request("HEAD", url).call() {
        Ok(resp) if resp.status() < 400 => Some(start.elapsed()),
        _ => None,
    }
}

/// Decide the effective region from the two probe latencies. Pure so it can be
/// unit-tested without a network. The direct path is preferred unless the
/// mirror is clearly faster (≥20% quicker): a marginal direct-path win isn't
/// worth routing every download through a third-party proxy, but a throttled or
/// blocked GitHub (slow or no answer) should hand off to the mirror.
fn pick_region(direct: Option<std::time::Duration>, mirror: Option<std::time::Duration>) -> &'static str {
    match (direct, mirror) {
        // Both answered: keep the direct path unless the mirror is ≥20% faster
        // (mirror_ms * 5 <= direct_ms * 4  ⟺  mirror <= 0.8 * direct).
        (Some(d), Some(m)) if m.as_millis().saturating_mul(5) <= d.as_millis().saturating_mul(4) => "restricted",
        (Some(_), _) => "global",
        (None, Some(_)) => "restricted",
        // Neither answered: the proxy is the more-likely-to-work path on a
        // censored/degraded network, and matches the historical fallback.
        (None, None) => "restricted",
    }
}

/// Auto-detect the download region by **racing the direct GitHub path against
/// the ghproxy mirror and using whichever is fastest** — the "ping the mirrors
/// first, pick the fastest" step. On an unthrottled network GitHub itself wins
/// and we stay direct ("global", no proxy hop); on a throttled/blocked network
/// the mirror answers first (or GitHub times out) and we switch ("restricted").
/// Both probes run in parallel, so the check costs one timeout, not two.
pub fn auto_detect_region() -> String {
    log::info!("Auto-detecting region (racing github.com vs ghproxy mirror)...");
    const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
    // Probe the SAME resource through both paths so the latencies compare fairly.
    let direct_h = std::thread::spawn(|| probe_latency("https://github.com", PROBE_TIMEOUT));
    let mirror_h =
        std::thread::spawn(|| probe_latency("https://ghproxy.net/https://github.com", PROBE_TIMEOUT));
    let direct = direct_h.join().ok().flatten();
    let mirror = mirror_h.join().ok().flatten();
    let region = pick_region(direct, mirror);
    log::info!(
        "Region auto-detected: {} (github={:?}, ghproxy={:?})",
        region,
        direct,
        mirror
    );
    region.to_string()
}

/// Get the effective region string, resolving "auto" to a concrete region.
pub fn get_effective_region<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    let region = load_config(app).region;
    if region == "auto" {
        auto_detect_region()
    } else {
        region
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_region(app: tauri::AppHandle) -> String {
    load_config(&app).region
}

#[tauri::command]
pub fn set_region(app: tauri::AppHandle, region: String) -> String {
    let r = if VALID_REGIONS.contains(&region.as_str()) {
        region.as_str()
    } else {
        "auto"
    };
    let mut cfg = load_config(&app);
    cfg.region = r.to_string();
    save_config(&app, &cfg);
    r.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config.json written by any pre-setup-screen build must keep parsing
    /// with all new fields at safe defaults — this is what makes the setup
    /// gate invisible to existing installs.
    #[test]
    fn legacy_config_parses_with_safe_defaults() {
        let legacy = r#"{"region":"china","dictation_shortcut":"CmdOrCtrl+Shift+Space","launch_as_widget":false,"update_channel":"preview"}"#;
        let cfg: AppConfig = serde_json::from_str(legacy).expect("legacy config must parse");
        assert_eq!(cfg.region, "china");
        assert_eq!(cfg.update_channel, "preview");
        assert!(!cfg.setup_complete, "legacy installs must default to setup_complete=false (venv detection migrates them)");
        assert_eq!(cfg.install_mode, "installed");
        assert_eq!(cfg.env_dir, None);
        assert_eq!(cfg.data_dir, None);
        assert_eq!(cfg.models_dir, None);
        assert_eq!(cfg.torch_variant, "auto");
        assert!(cfg.mirrors.pypi_index.is_none());
        assert!(cfg.mirrors.hf_endpoint.is_none());
        assert!(cfg.mirrors.python_downloads.is_none());
    }

    #[test]
    fn config_roundtrips_new_fields() {
        let mut cfg = AppConfig::default();
        cfg.setup_complete = true;
        cfg.install_mode = "portable".into();
        cfg.models_dir = Some("/mnt/big/models".into());
        cfg.mirrors.hf_endpoint = Some("https://hf-mirror.com".into());
        let json = serde_json::to_string(&cfg).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert!(back.setup_complete);
        assert_eq!(back.install_mode, "portable");
        assert_eq!(back.models_dir.as_deref(), Some("/mnt/big/models"));
        assert_eq!(back.mirrors.hf_endpoint.as_deref(), Some("https://hf-mirror.com"));
    }

    use std::time::Duration as D;

    #[test]
    fn pick_region_prefers_direct_when_github_is_fast() {
        // Normal network: GitHub answers quickly → stay direct, no proxy hop.
        assert_eq!(pick_region(Some(D::from_millis(120)), Some(D::from_millis(300))), "global");
        // A marginal mirror win (<20%) is not worth the proxy.
        assert_eq!(pick_region(Some(D::from_millis(300)), Some(D::from_millis(280))), "global");
    }

    #[test]
    fn pick_region_uses_mirror_when_clearly_faster_or_github_down() {
        // Throttled GitHub, snappy mirror (≥20% faster) → use the mirror.
        assert_eq!(pick_region(Some(D::from_millis(2000)), Some(D::from_millis(400))), "restricted");
        // GitHub unreachable but mirror answers → mirror.
        assert_eq!(pick_region(None, Some(D::from_millis(500))), "restricted");
        // GitHub answers, mirror doesn't → direct.
        assert_eq!(pick_region(Some(D::from_millis(800)), None), "global");
        // Neither answers → proxy is the safer bet (matches the old fallback).
        assert_eq!(pick_region(None, None), "restricted");
    }
}

#[tauri::command]
pub fn get_update_channel(app: tauri::AppHandle) -> String {
    load_config(&app).update_channel
}

/// Persist the updater release channel. Unknown values clamp to "stable".
/// Takes effect on the next update check (the channel is read per-check).
#[tauri::command]
pub fn set_update_channel(app: tauri::AppHandle, channel: String) -> String {
    let c = if VALID_CHANNELS.contains(&channel.as_str()) {
        channel.as_str()
    } else {
        "stable"
    };
    let mut cfg = load_config(&app);
    cfg.update_channel = c.to_string();
    save_config(&app, &cfg);
    log::info!("Update channel set to {c}");
    c.to_string()
}
