# Update channels (Stable / Preview)

OmniVoice Studio auto-updates itself in the background. You choose **which
builds** it offers you with the update channel in **Settings → Updates →
Update channel**.

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

## Your data during updates

Your voices, projects, history, and settings live in a SQLite database
(`omnivoice.db`) outside the app bundle, so replacing the app never touches
them. On the **first launch of an updated build**, if the new version needs a
database schema upgrade, OmniVoice:

1. **Backs up the database first** — a consistent snapshot is written next to
   it as `omnivoice.db.backup-<version>-<n>` before any migration runs. The
   newest **3** backups are kept; older ones are pruned automatically.
   (Databases over 500 MB skip the snapshot, with a log line saying so.)
2. **Stops instead of guessing** — if a migration fails midway, the app does
   *not* start on a half-migrated database and does *not* silently restore
   anything. It shows an error naming the backup path so you (or a support
   thread) decide: retry, report the issue, or roll back by replacing
   `omnivoice.db` with the backup.

**Settings → Updates** shows the timestamp of the latest backup, the release
notes of any available update, and a **What's new** reader for the shipped
changelog — all local, no extra network calls.

The Python environment (`.venv`) is also updated non-destructively: dependency
drift after an app update is reconciled **in place** with `uv sync`, and a
failed sync keeps the previous environment working. The venv is only ever
rebuilt when its interpreter is *confirmed* broken (structural check + a
direct probe) or when you explicitly use **Clean & Retry**.

## For maintainers — how previews are built

Preview builds come from **`main`**, two ways:

- **Nightly (automatic).** A scheduled job (07:00 UTC) rebuilds the rolling
  `preview` prerelease from `main` — but only when `main` actually moved in the
  last day, so idle days cost nothing. Preview is never more than ~24h behind
  `main`.
- **On demand.** **Actions → Desktop Release → Run workflow**, pick a branch
  (usually `main`), set **publish_preview = true**. Useful to cut a preview off
  a feature branch, or to refresh immediately without waiting for the nightly.

Either way it builds the matrix and publishes/updates a single rolling
`preview` **prerelease** — always flagged prerelease, and carrying the same
platform set as stable (both verified in CI after each preview publish) — with
its own signed `latest.json`. The tagged `latest` stable release is never
affected. Preview users get the new build on their next check; stable users see
nothing.

To stop offering previews, delete the `preview` release/tag on GitHub — the
Preview channel then falls back to stable.
