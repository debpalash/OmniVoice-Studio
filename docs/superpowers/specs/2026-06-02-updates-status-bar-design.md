# Updates in the status bar — design spec

**Date:** 2026-06-02
**Status:** Approved (brainstorm) → ready for implementation plan
**Branch:** `feat/updates-status-bar`

## Problem / goal

The auto-update surface is a floating pill (`UpdateBadge`) fixed at top-right. The
user wants updates to live in the **bottom status bar** (`LogsFooter`): a persistent
version indicator plus an **Updates tab/panel** that exposes the changelog, the
stable/preview channel switcher, and update/release history — so updates have a
permanent, discoverable home instead of a transient floating pill.

## Decisions (from brainstorm)

1. **Placement:** a persistent **version chip** on the right of the always-visible
   28px `LogsFooter` bar, plus an **"Updates" tab** that expands the footer into an
   **Updates panel**. Clicking the chip opens the panel.
2. **Idle behavior:** the chip is **always on** — shows `v<current> ✓` when up to
   date and morphs into available / downloading / ready / error states.
3. **Data source:** **GitHub Releases (live)**, fetched through a Rust command.
   Changelog and "history" **unify into one Releases list** (release history with
   the running version marked "current"). This is *not* a personal install log.
4. **Channel switcher:** the panel gets an editable stable/preview switcher that
   **coexists with the existing Settings → About switcher**; both read/write the
   same Rust `get_update_channel` / `set_update_channel`, kept in sync via a single
   store-held `updateChannel` value.

## Existing code this builds on

- `frontend/src/components/LogsFooter.jsx` / `.css` — the bottom bar. Fixed,
  `z-index: 40`, 28px collapsed, expands 180–720px. Tabs come from a `SOURCES`
  array rendered as `.logs-footer__pill` buttons; active tab persists to
  localStorage `omnivoice.logs.active`. Body renders per active tab; the
  Notifications tab is the precedent for a non-log custom tab body. Sets CSS var
  `--logs-footer-height`.
- `frontend/src/components/UpdateBadge.jsx` / `.css` — current floating pill,
  mounted at `App.jsx` (`<UpdateBadge/>`). Renders available / downloading / ready
  / error (idle+checking → null). **Current `main` adds a dismiss (X) button on the
  error state + a `dismissUpdate` store action + `update.dismiss` key** — must be
  preserved.
- `frontend/src/store/updaterSlice.ts` — `updateStatus | updateVersion |
  updateNotes | updateProgress | updateError`; setters
  `setUpdateChecking/Available/Idle/Progress/Ready/Error` + `dismissUpdate`. **Not
  persisted.** No history field.
- `frontend/src/utils/updater.js` — `isTauri()`, `currentChannel()`
  (`invoke('get_update_channel')`), `checkForUpdate(store)`
  (`invoke('check_update',{channel})`), `installUpdate(store)`
  (`invoke('install_update',{channel})`, listens `update://progress`, `relaunch()`).
- `frontend/src/utils/updateChannel.js` — `UPDATE_CHANNELS = ['stable','preview']`,
  `normalizeChannel()`.
- `frontend/src/pages/Settings.jsx` (About tab) — existing channel `Segmented`
  (`changeChannel` → `set_update_channel`), endpoint display, "Check for updates".
- Rust (`src-tauri/src`) — commands `get_update_channel`, `set_update_channel`,
  `check_update`, `install_update`. **New:** `list_releases`.
- `CHANGELOG.md` exists at repo root but is not surfaced (not used by this design;
  release notes come from GitHub).

## Architecture

### A. Bar chip — `UpdateStatusChip`
New component rendered on the **right** side of `LogsFooter`'s top bar (near the
Discord/donate cluster). Subscribes to `updaterSlice`. State → presentation:

| `updateStatus` | chip |
|---|---|
| `idle` (up to date) | `v<current> ✓` (subtle/dim) |
| `available` | `⬆ <version> · Update` (click row installs in panel) |
| `downloading` | `↺ Updating <pct>%` |
| `ready` | `↺ Restart` |
| `error` | `⚠ Failed · Retry` (+ dismiss preserved) |
| `checking` | brief `… Checking` (or stay on prior chip) |

- Click → open the footer to the Updates tab (`openTo('updates')`).
- **Current version source:** `@tauri-apps/api/app` `getVersion()` on mount, stored
  in `updaterSlice.appVersion` (fallback: hidden chip in non-Tauri/dev where version
  is unknown). The chip is the *indicator only*; primary actions live in the panel
  (Install is reachable from chip via opening panel; Retry/Restart may act inline to
  preserve today's one-click behavior — see Open Questions resolved below).

### B. Updates panel — `UpdatesPanel`
Rendered as the footer body when `active === 'updates'`. Sections top→bottom:

1. **Live row** — mirrors chip state with the actionable control:
   - available → `Update available · <v>` + **Install** (gated while `dubStep ===
     'generating'`, same toast as today).
   - downloading → progress bar + %; ready → **Restart**; error → message +
     **Retry** + **Dismiss**; idle → `Up to date · v<current>` + **Check now**.
2. **Channel** — `Segmented` stable/preview bound to store `updateChannel`; onChange
   → `set_update_channel` + refetch releases. Stays in sync with Settings.
3. **Releases list** — scrollable; each row: version, date, `prerelease` tag,
   expandable notes. The **running version** is marked `current`. Loading and
   empty/offline states handled (see Data).

### C. Data — `list_releases` Rust command + `releasesSlice`
- **Rust** `list_releases(channel) -> Vec<ReleaseInfo>`: GET
  `https://api.github.com/repos/{owner}/{repo}/releases` via existing `reqwest`
  (no auth; `User-Agent` set). Map to `{ version, name, date, prerelease, notes }`.
  **Stable** channel filters out `prerelease`; **preview** includes them. Sorted
  newest first. Short in-memory cache (e.g. 5 min) to avoid refetch spam.
- **Frontend** transient `releasesSlice` (NOT persisted): `releases`,
  `releasesStatus: 'idle'|'loading'|'loaded'|'error'`, `loadReleases(channel)`
  (calls the command; sets error on failure). Fetched lazily when the panel first
  opens and on channel change.
- **Offline / failure:** panel shows "Couldn't load releases (offline?)" + a retry
  button. The live update flow (`check_update`/`install_update`) and the rest of the
  app are unaffected. Non-Tauri/dev → releases unavailable, panel shows the same
  empty state; live update no-ops as today.

### D. Removals / moves
- Remove floating `<UpdateBadge/>` from `App.jsx`.
- `UpdateBadge`'s state logic moves into `UpdateStatusChip` (incl. dismiss + dub-busy
  gating). `UpdateBadge.jsx`/`.css` retired (or renamed to the chip). The existing
  `update.*` i18n keys are reused.

## State / store

- `updaterSlice`: add `appVersion: string | null` + `setAppVersion`. Everything else
  unchanged (still not persisted).
- New `updateChannelSlice` (or fold into updaterSlice): `updateChannel:
  'stable'|'preview'`, `setUpdateChannel(ch)` (writes via Rust). Settings + panel both
  bind here → single source of truth, auto-synced.
- New `releasesSlice` (transient): releases + status + `loadReleases`.

## i18n (hard rule)

New `updates.*` keys added to **all 21 locale files** (parity enforced; CJK guard
stays green — no hardcoded user-facing strings). Reuse `update.*` and
`about.channel_*` where possible. New keys (indicative): `updates.tab`,
`updates.up_to_date`, `updates.check_now`, `updates.current`, `updates.releases`,
`updates.prerelease`, `updates.load_error`, `updates.retry_load`,
`updates.installed_version`.

## Cross-platform parity (strict rule)

The chip + panel are pure frontend; `list_releases` is platform-agnostic Rust. The
feature is **default-on** and behaves identically on macOS / Windows / Linux. No
OS-gated default behavior. Updater itself remains Tauri-only (no-ops in dev/web) —
the chip degrades to hidden/version-only there, identically across platforms.

## Testing

- vitest: chip state→presentation mapping for all six states; panel render with a
  mock releases array (current-version marking, prerelease filtering by channel);
  channel switch calls `set_update_channel` + triggers reload; releases load-error →
  offline empty state; dub-busy gating on Install.
- Keep the existing `updater.test.js` (#216 guard) + `updaterSlice.test.ts` green.
- i18n parity test + CJK guard must pass.

## Out of scope (YAGNI)

- Personal install-history log ("you installed X on date Y").
- Per-release manual download / rollback / downgrade.
- Rich markdown rendering of notes beyond the current plain/`pre-wrap` treatment.
- Auto-refresh/polling of the releases list (fetch on open + channel change only).

## Open questions — resolved

- **Chip vs panel for one-click actions:** chip shows state; Restart/Retry remain
  one-click from the chip (preserve today's behavior); Install opens the panel (it's
  the consequential action and benefits from showing notes first).
- **Changelog vs history:** unified into the Releases list (GitHub source decision).
- **Version chip when version unknown (dev/web):** hidden.
