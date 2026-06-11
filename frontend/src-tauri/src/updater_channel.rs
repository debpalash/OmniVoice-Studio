//! Channel-aware auto-update (Stable / Preview).
//!
//! The bundled `tauri-plugin-updater` reads its endpoints from
//! `tauri.conf.json` (the stable channel) and *neither* the JS `check()` nor
//! the plugin's registration `Builder` can change them at runtime. To let a
//! user opt into preview (latest-`main`) builds we go through the only
//! runtime-endpoint API: `AppHandle::updater_builder().endpoints(...)`
//! (`UpdaterExt`). The check + download/install below mirror the plugin's own
//! command implementation, so the default ("stable") path behaves identically
//! to the JS flow it replaces. The preview path additionally consults *both*
//! manifests and ranks builds with [`cross_channel_cmp`] so preview users are
//! always offered the newest build across channels (#326).

use std::cmp::Ordering;

use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

const STABLE_MANIFEST: &str =
    "https://github.com/debpalash/OmniVoice-Studio/releases/latest/download/latest.json";
const PREVIEW_MANIFEST: &str =
    "https://github.com/debpalash/OmniVoice-Studio/releases/download/preview/latest.json";

/// Cross-channel ordering of OmniVoice build versions (#326).
///
/// Preview builds are published as `X.Y.Z-N` (e.g. `0.3.5-41`): base `X.Y.Z`
/// is the latest stable tag at build time and `-N` counts `main` builds
/// *after* that tag — so a preview build is **newer** than the stable release
/// sharing its base. That is the opposite of semver's pre-release rule
/// (`0.3.5-41 < 0.3.5`), which is what the updater plugin's default
/// comparator uses and why preview-channel users on stable `0.3.5` were told
/// "you already have the latest version".
///
/// Rules:
/// 1. A higher base version (major.minor.patch) always wins.
/// 2. Equal base: a suffixed (preview) build outranks the bare stable it was
///    built on top of.
/// 3. Equal base, both suffixed: semver pre-release comparison, which is
///    numeric-aware (`-9 < -41 < -42`, `-preview.4 < -preview.5`).
fn cross_channel_cmp(a: &Version, b: &Version) -> Ordering {
    (a.major, a.minor, a.patch)
        .cmp(&(b.major, b.minor, b.patch))
        .then_with(|| match (a.pre.is_empty(), b.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => a.pre.cmp(&b.pre),
        })
}

/// Whether `remote` should be offered to a user currently running `current`,
/// under cross-channel ordering. Strict: equal builds are never re-offered,
/// so a preview user can't ping-pong between the two manifests.
fn remote_is_newer(remote: &Version, current: &Version) -> bool {
    cross_channel_cmp(remote, current) == Ordering::Greater
}

/// Build an updater bound to a single manifest. `cross_channel` swaps the
/// plugin's default comparator (plain semver `remote > current`) for
/// [`remote_is_newer`]; the preview channel needs that both to accept
/// `0.3.5-41` while on stable `0.3.5` and to *reject* stable `0.3.5` while on
/// `0.3.5-41` (the default would offer it — a downgrade under our scheme).
fn build_updater(app: &AppHandle, manifest: &str, cross_channel: bool) -> Result<Updater, String> {
    let url: tauri::Url = manifest
        .parse()
        .map_err(|e| format!("updater endpoint parse: {e}"))?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("updater endpoints: {e}"))?;
    if cross_channel {
        builder = builder
            .version_comparator(|current, release| remote_is_newer(&release.version, &current));
    }
    builder.build().map_err(|e| format!("updater build: {e}"))
}

/// Of two available updates, keep the newest under cross-channel ordering.
/// `a` (the earlier-checked manifest, i.e. preview) wins ties.
fn newest_of(a: Update, b: Update) -> Update {
    match (Version::parse(&a.version), Version::parse(&b.version)) {
        (Ok(va), Ok(vb)) if remote_is_newer(&vb, &va) => b,
        (Err(_), Ok(_)) => b,
        _ => a,
    }
}

/// Find the newest applicable update for a channel.
///
/// - `stable`: the tagged `releases/latest` manifest with the plugin's
///   default semver comparison — behavior unchanged.
/// - `preview`: consult **both** the rolling preview manifest and the stable
///   manifest, and offer whichever build is newest under
///   [`cross_channel_cmp`]. The plugin's own multi-endpoint list can't do
///   this — it stops at the first manifest that parses and uses later
///   endpoints only as network fallbacks — so a reachable preview manifest
///   used to hide a newer stable release entirely (#326).
///
/// A manifest fetch error is non-fatal as long as the other manifest answers;
/// an error is returned only when every manifest fails.
async fn best_update(app: &AppHandle, channel: &str) -> Result<Option<Update>, String> {
    if channel != "preview" {
        return build_updater(app, STABLE_MANIFEST, false)?
            .check()
            .await
            .map_err(|e| e.to_string());
    }

    let mut best: Option<Update> = None;
    let mut any_ok = false;
    let mut first_err: Option<String> = None;
    for manifest in [PREVIEW_MANIFEST, STABLE_MANIFEST] {
        match build_updater(app, manifest, true)?.check().await {
            Ok(candidate) => {
                any_ok = true;
                best = match (best.take(), candidate) {
                    (Some(a), Some(b)) => Some(newest_of(a, b)),
                    (a, b) => b.or(a),
                };
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e.to_string());
                }
            }
        }
    }
    if !any_ok {
        return Err(first_err.unwrap_or_else(|| "update check failed".to_string()));
    }
    Ok(best)
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
    Ok(best_update(&app, &channel).await?.map(|u| UpdateMeta {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download + install the available update for the given channel, emitting
/// `update://progress` events as bytes arrive. On success the caller (JS)
/// relaunches — keeping the "don't interrupt an in-flight dub" gate on the JS
/// side, exactly as the badge flow already does.
#[tauri::command]
pub async fn install_update(app: AppHandle, channel: String) -> Result<(), String> {
    let update = best_update(&app, &channel)
        .await?
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

// ── GitHub releases (changelog/history panel) ─────────────────────────────

const RELEASES_API: &str =
    "https://api.github.com/repos/debpalash/OmniVoice-Studio/releases?per_page=30";

#[derive(Serialize)]
pub struct ReleaseInfo {
    pub version: String,
    pub name: String,
    pub date: String,
    pub prerelease: bool,
    pub notes: String,
}

/// Fetch the project's GitHub releases for the changelog/history panel.
/// `channel` is accepted for symmetry with the other update commands; channel
/// filtering is applied on the frontend (prepareReleases) so this returns all.
#[tauri::command]
pub async fn list_releases(_channel: String) -> Result<Vec<ReleaseInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();
    let resp = client
        .get(RELEASES_API)
        .header("User-Agent", "OmniVoice-Studio")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("releases request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("releases request status {}", resp.status()));
    }
    let arr: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("releases parse failed: {e}"))?;
    let mut out = Vec::new();
    if let Some(items) = arr.as_array() {
        for it in items {
            let tag = it.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
            out.push(ReleaseInfo {
                version: tag.trim_start_matches('v').to_string(),
                name: it
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(tag)
                    .to_string(),
                date: it
                    .get("published_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(10)
                    .collect(),
                prerelease: it.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false),
                notes: it.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    /// Documents the #326 root cause: under plain semver (the plugin's
    /// default comparator) a preview build is a *pre-release* of its base and
    /// sorts below the stable release, so once stable caught up the preview
    /// channel reported "up to date".
    #[test]
    fn plain_semver_ranks_preview_below_equal_base_stable() {
        assert!(v("0.3.5-41") < v("0.3.5"));
    }

    /// The bug case: user on stable 0.3.5, preview manifest advertises
    /// 0.3.5-41 (a `main` build 4 days newer) → must be offered.
    #[test]
    fn preview_ahead_of_equal_base_stable_is_offered() {
        assert!(remote_is_newer(&v("0.3.5-41"), &v("0.3.5")));
    }

    /// Equal base the other way: stable 0.3.5 is the tag the 0.3.5-41
    /// preview was built on top of — offering it would be a downgrade.
    #[test]
    fn equal_base_stable_is_not_offered_to_preview_user() {
        assert!(!remote_is_newer(&v("0.3.5"), &v("0.3.5-41")));
    }

    /// Preview behind stable: when stable passes the newest preview build,
    /// the preview user gets the stable release (never stuck).
    #[test]
    fn stable_that_passed_preview_is_offered() {
        assert!(remote_is_newer(&v("0.3.6"), &v("0.3.5-41")));
        assert!(!remote_is_newer(&v("0.3.5-41"), &v("0.3.6")));
    }

    /// Preview-to-preview moves forward, with numeric (not lexicographic)
    /// build-counter comparison, and dotted pre-release forms work too.
    #[test]
    fn newer_preview_builds_are_offered_numerically() {
        assert!(remote_is_newer(&v("0.3.5-42"), &v("0.3.5-41")));
        assert!(!remote_is_newer(&v("0.3.5-9"), &v("0.3.5-41")));
        assert!(remote_is_newer(&v("0.3.0-preview.5"), &v("0.3.0-preview.4")));
        assert!(!remote_is_newer(&v("0.3.0-preview.4"), &v("0.3.0-preview.5")));
    }

    /// Strict ordering: the exact same build (either channel) is never
    /// re-offered, so a preview user can't ping-pong between manifests.
    #[test]
    fn equal_versions_are_not_offered() {
        assert!(!remote_is_newer(&v("0.3.5"), &v("0.3.5")));
        assert!(!remote_is_newer(&v("0.3.5-41"), &v("0.3.5-41")));
        assert_eq!(cross_channel_cmp(&v("0.3.5-41"), &v("0.3.5-41")), Ordering::Equal);
    }

    /// The base version always dominates the suffix.
    #[test]
    fn base_version_dominates_suffix() {
        assert!(remote_is_newer(&v("0.4.0"), &v("0.3.9-7")));
        assert!(remote_is_newer(&v("0.3.6-1"), &v("0.3.5")));
        assert!(!remote_is_newer(&v("0.3.4-99"), &v("0.3.5")));
    }
}
