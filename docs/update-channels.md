# Update channels (Stable / Preview)

OmniVoice Studio auto-updates itself in the background. You choose **which
builds** it offers you with the update channel in **Settings → About → Update
channel**.

| Channel | What you get | Who it's for |
|---------|--------------|--------------|
| **Stable** (default) | The latest tagged `vX.Y.Z` release. | Everyone. This is the default on every install and every launch. |
| **Preview** | The latest `main` build (a rolling `preview` prerelease). Newer features, less testing. Falls back to a stable release if one is ahead. | Users who want to try fixes/features before they're tagged, and report issues. |

Switching is instant — the next update check (on launch, or via **Check for
updates**) uses your chosen channel. Your projects, voices, settings, and any
in-flight job are untouched; an in-progress dub blocks the install until it
finishes, and your data lives outside the app bundle, so an update never
touches it.

There are **no accounts, no telemetry, and no extra network calls** — both
channels just point the existing signed updater at a different GitHub Releases
manifest:

- Stable → `releases/latest/download/latest.json`
- Preview → `releases/download/preview/latest.json`

Both manifests are signed with the same minisign key, so a tampered build is
rejected regardless of channel.

## For maintainers — cutting a preview build

Preview builds are **manual** (no scheduled spend, nothing auto-published):

1. Go to **Actions → Desktop Release → Run workflow**.
2. Pick the branch to build (usually `main`).
3. Set **publish_preview = true** and run.

This builds the matrix and publishes/updates a single rolling `preview`
**prerelease** with its own signed `latest.json`. The tagged `latest` stable
release is never affected. Preview users get the new build on their next check;
stable users see nothing.

To stop offering previews, delete the `preview` release/tag on GitHub — the
Preview channel then falls back to stable.
