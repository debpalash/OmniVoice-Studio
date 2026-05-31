//! Channel-aware auto-update (Stable / Preview).
//!
//! The bundled `tauri-plugin-updater` reads its endpoints from
//! `tauri.conf.json` (the stable channel) and *neither* the JS `check()` nor
//! the plugin's registration `Builder` can change them at runtime. To let a
//! user opt into preview (latest-`main`) builds we go through the only
//! runtime-endpoint API: `AppHandle::updater_builder().endpoints(...)`
//! (`UpdaterExt`). The check + download/install below mirror the plugin's own
//! command implementation, so the default ("stable") path behaves identically
//! to the JS flow it replaces — only *which manifest* is consulted changes.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

const STABLE_MANIFEST: &str =
    "https://github.com/debpalash/OmniVoice-Studio/releases/latest/download/latest.json";
const PREVIEW_MANIFEST: &str =
    "https://github.com/debpalash/OmniVoice-Studio/releases/download/preview/latest.json";

/// Endpoints for a channel. Preview tries the rolling `preview` manifest first,
/// then falls back to stable so a preview user still receives a newer *stable*
/// release if one is ahead of the latest preview. Any unknown channel → stable.
fn channel_endpoints(channel: &str) -> Vec<tauri::Url> {
    let raw = if channel == "preview" {
        vec![PREVIEW_MANIFEST, STABLE_MANIFEST]
    } else {
        vec![STABLE_MANIFEST]
    };
    raw.iter().filter_map(|u| u.parse().ok()).collect()
}

#[derive(Serialize, Clone)]
pub struct UpdateMeta {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    downloaded: usize,
    total: Option<u64>,
}

/// Non-blocking availability check for the given channel. Returns the update
/// metadata when a newer build exists, or `None` when already up to date.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    channel: String,
) -> Result<Option<UpdateMeta>, String> {
    let updater = app
        .updater_builder()
        .endpoints(channel_endpoints(&channel))
        .map_err(|e| format!("updater endpoints: {e}"))?
        .build()
        .map_err(|e| format!("updater build: {e}"))?;
    match updater.check().await {
        Ok(Some(u)) => Ok(Some(UpdateMeta {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Download + install the available update for the given channel, emitting
/// `update://progress` events as bytes arrive. On success the caller (JS)
/// relaunches — keeping the "don't interrupt an in-flight dub" gate on the JS
/// side, exactly as the badge flow already does.
#[tauri::command]
pub async fn install_update(app: AppHandle, channel: String) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .endpoints(channel_endpoints(&channel))
        .map_err(|e| format!("updater endpoints: {e}"))?
        .build()
        .map_err(|e| format!("updater build: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;

    let mut downloaded: usize = 0;
    let app_for_chunk = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk;
                let _ = app_for_chunk
                    .emit("update://progress", ProgressPayload { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
