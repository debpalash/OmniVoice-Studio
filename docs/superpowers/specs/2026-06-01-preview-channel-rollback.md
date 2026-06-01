# Preview channel: versioning + rollback — design spec

- **Date:** 2026-06-01
- **Status:** Phase A implemented; Phase B = proposed design, pending review
- **Ships on:** v0.3.0 line

## Problem

The Preview update channel (Settings → About → Update channel → Preview) builds
from `main` and publishes to a rolling `preview` GitHub prerelease. But two gaps
make it not actually work as an update channel:

1. **No versioning.** Every preview build stamped the static `tauri.conf.json`
   version (`0.3.0`). Tauri's updater only offers an update when the manifest
   version is **semver-greater** than the installed one, so `0.3.0 == 0.3.0` →
   "no update." Preview users install once and never receive the next preview.
2. **No rollback.** The Tauri updater only moves forward. There is no way to
   return to an earlier preview build (e.g., when a fresh `main` build
   regresses) without a manual reinstall.

## Phase A — forward versioning (DONE)

`release.yml` stamps each preview build, on the `workflow_dispatch +
publish_preview` path only, with a unique monotonic semver prerelease:

```
<base>-preview.<github.run_number>     e.g. 0.3.0-preview.42
```

via an ephemeral, never-committed rewrite of `tauri.conf.json`'s `version`
(Tauri reads the bundle + updater version from there). Properties:

- **Monotonic** (`run_number` only increases) → `…preview.43 > …preview.42`, so
  the updater offers each newer preview.
- **Prerelease of the current target** → when stable `0.3.0` ships,
  `0.3.0 > 0.3.0-preview.N`, so preview users **converge to stable** (matches
  the channel's preview→stable fallback).
- **No `+build` metadata** — kept out to avoid `+`-in-filename / MSI edge cases.
  Commit traceability lives in the release notes (the `preview-notes` job
  already renders the commit range + Contributors).

### Known caveat (Windows MSI)

The Windows MSI `ProductVersion` is a 4-field numeric (`a.b.c.d`) and **strips
the semver prerelease** → every preview MSI reports `0.3.0`. The Tauri updater
compares the **full** semver from `latest.json` (so it still *offers* the new
preview and runs the new MSI), but `msiexec` installing an MSI whose
`ProductVersion` is unchanged is a "reinstall," not an "upgrade." **Action:**
verify Windows preview→preview actually replaces files in testing. macOS/Linux
replace the bundle wholesale and are unaffected. If Windows misbehaves, the
fallback is a numeric scheme (`0.3.<run_number>`) at the cost of clean
convergence — decide after a real Windows test.

## Phase B — version catalog + rollback (PROPOSED)

### Publish model: per-version prereleases

Each preview build publishes a **distinct** prerelease tagged
`preview-<version>` (e.g. `preview-0.3.0-preview.42`), self-contained: signed
artifacts + its own `latest.json`. Separately, the rolling `preview` tag's
`latest.json` **mirrors the newest** so the default forward-update keeps reading
a stable URL (`releases/download/preview/latest.json`).

- **Retention:** keep the last ~10 `preview-*` releases; a cleanup step prunes
  older releases + tags. These releases *are* the rollback catalog — so unlike
  Phase A's tidy-up instinct, we deliberately **keep** old artifacts.

### App side: a "Preview builds" picker

In Settings → About → Update channel (shown when on Preview):

- List available builds from the GitHub Releases API (prereleases matching
  `preview-*`): version, date, commit range, and an **alembic-head** marker
  (see Data safety).
- Each row → **Install**. Choosing an *older* build is the rollback.
- **Install path** reuses the Rust updater commands from #199, extended with:
  - an explicit endpoint (`…/preview-<chosen>/latest.json`), and
  - **`allow_downgrades`** (Tauri `UpdaterBuilder::version_comparator`, e.g.
    `|current, candidate| candidate != current`) so it installs even when the
    target is older than the running version.
- Every build is minisign-signed → rollback installs are verified too.

### ⚠️ Data safety: DB schema + rollback

Alembic migrations are forward-only and tested for **upgrade**. Rolling the app
back across a migration means an *older* app meets a `omnivoice_data` DB at a
**newer** schema head than it expects — which can break (the inverse of the
"backward-compatible data" constraint). Mitigations, in order of effort:

1. **Tag each preview with its alembic head** (a build-time `alembic heads`
   captured into the release notes / a sidecar field). The picker marks builds
   as "safe to roll back to" (same head) vs "data-incompatible (newer schema)."
2. **Warn on cross-schema rollback** in the picker; require explicit confirm.
3. (Later) implement + test alembic **downgrade** paths for the affected
   revisions so rollback is truly safe.

Phase B should at least do (1)+(2); (3) is per-migration follow-up work.

## Implementation outline (Phase B)

- `release.yml`: per-version `preview-<version>` publish + mirror newest →
  rolling `preview/latest.json`; retention/prune step; capture alembic head.
- `backend`: small endpoint to expose the running alembic head (for the picker's
  safety check), or read it client-side from the release metadata.
- `frontend/src-tauri` (`updater_channel.rs`): `install_specific(version)` with
  endpoint override + `allow_downgrades`; `list_preview_builds()` via GH API.
- `frontend` (Settings): the "Preview builds" picker + rollback confirm dialog;
  i18n (en + zh-CN, then backfill the rest).

## Open decisions

1. Base scheme: **`0.3.0-preview.N`** (chosen) vs `0.3.1-preview.N`.
2. Retention count (proposed **10**).
3. Whether to gate rollback across alembic heads behind a hard block or a
   confirm-with-warning (proposed: confirm-with-warning + a clear marker).
