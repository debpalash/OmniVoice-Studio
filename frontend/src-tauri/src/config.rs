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
}

pub fn default_region() -> String { "auto".into() }
pub fn default_dictation_shortcut() -> String { "CmdOrCtrl+Shift+Space".into() }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            region: default_region(),
            dictation_shortcut: default_dictation_shortcut(),
        }
    }
}

pub fn config_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d: PathBuf| d.join("config.json"))
}

pub fn load_config<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppConfig {
    config_path(app)
        .and_then(|p| fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config<R: tauri::Runtime>(app: &tauri::AppHandle<R>, cfg: &AppConfig) {
    if let Some(p) = config_path(app) {
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&p, serde_json::to_string_pretty(cfg).unwrap_or_default());
    }
}

// ── Region helpers ────────────────────────────────────────────────────────

pub const VALID_REGIONS: &[&str] = &["auto", "global", "china", "russia", "restricted"];

/// Resolve a raw GitHub URL through the appropriate mirror for the given region.
/// If the region uses a proxy, prepends the proxy prefix.
#[allow(dead_code)] // Used in cfg(linux) and cfg(windows) FFmpeg download blocks
pub fn resolve_github_url(raw_github_url: &str, region: &str) -> String {
    match region {
        "china" | "russia" | "restricted" => format!("https://ghproxy.net/{}", raw_github_url),
        _ => raw_github_url.to_string(),
    }
}

/// Probe github.com reachability with a fast HEAD request.
/// Returns the effective region: "global" if reachable, "restricted" if not.
pub fn auto_detect_region() -> String {
    log::info!("Auto-detecting region (probing github.com)...");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(4))
        .build();
    match agent.request("HEAD", "https://github.com").call() {
        Ok(resp) if resp.status() < 400 => {
            log::info!("github.com reachable — using global region");
            "global".to_string()
        }
        _ => {
            log::info!("github.com unreachable — using restricted region (ghproxy mirror)");
            "restricted".to_string()
        }
    }
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
