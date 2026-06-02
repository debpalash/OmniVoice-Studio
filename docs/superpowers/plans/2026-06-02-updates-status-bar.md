# Updates-in-Status-Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the auto-update pill out of the floating top-right `UpdateBadge` into the `LogsFooter` status bar — a persistent version chip plus an "Updates" tab whose panel shows the live update action, a stable/preview channel switcher, and a GitHub-sourced releases (changelog/history) list.

**Architecture:** Pure presentation/data logic lives in framework-free helpers (`utils/updatePresentation.js`) that are unit-tested directly. Thin React components (`UpdateStatusChip`, `UpdatesPanel`) consume those helpers and the existing `updaterSlice`. A new transient `releasesSlice` holds the GitHub releases list, fetched via a new Rust `list_releases` command (reqwest → GitHub Releases API, channel-filtered). The channel value is lifted into a store slice so the Settings switcher and the panel switcher stay in sync.

**Tech Stack:** React + zustand (frontend), Tauri v2 + reqwest/serde (Rust), vitest/jsdom (tests), i18next (21 locales). Spec: `docs/superpowers/specs/2026-06-02-updates-status-bar-design.md`.

---

## File structure

**Create**
- `frontend/src/utils/updatePresentation.js` — pure helpers: chip presentation, release filtering/marking.
- `frontend/src/utils/updatePresentation.test.js` — unit tests for the helpers.
- `frontend/src/store/releasesSlice.ts` — transient releases list + load action.
- `frontend/src/store/releasesSlice.test.ts` — slice tests.
- `frontend/src/components/UpdateStatusChip.jsx` + `.css` — the bar chip.
- `frontend/src/components/UpdatesPanel.jsx` + `.css` — the expanded panel body.
- `frontend/src-tauri/src/` change to `updater_channel.rs` — `list_releases` command.

**Modify**
- `frontend/src/store/updaterSlice.ts` — add `appVersion` + `setAppVersion`; add channel state `updateChannel`/`setUpdateChannelValue`.
- `frontend/src/utils/updater.js` — add `loadReleases(channel)` + `fetchAppVersion()` wrappers.
- `frontend/src/components/LogsFooter.jsx` — add `updates` tab to `SOURCES`, render `UpdatesPanel`, mount `UpdateStatusChip` in `.logs-footer__right`.
- `frontend/src/App.jsx` — remove floating `<UpdateBadge/>`; fetch app version on boot.
- `frontend/src/pages/Settings.jsx` — bind the About-tab channel switcher to the store value (auto-sync).
- `frontend/src/i18n/locales/*.json` (21 files) — add `updates.*` keys.
- `frontend/src-tauri/src/lib.rs` — register `list_releases` in `generate_handler!`.

**Retire**
- `frontend/src/components/UpdateBadge.jsx` + `.css` — deleted after Task 8 (logic absorbed by `UpdateStatusChip`).

---

## Task 1: Pure presentation helpers

**Files:**
- Create: `frontend/src/utils/updatePresentation.js`
- Test: `frontend/src/utils/updatePresentation.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// frontend/src/utils/updatePresentation.test.js
import { describe, it, expect } from 'vitest';
import { chipPresentation, prepareReleases } from './updatePresentation';

describe('chipPresentation', () => {
  it('idle → version chip', () => {
    expect(chipPresentation('idle', { appVersion: '0.3.0' }))
      .toMatchObject({ variant: 'idle', label: 'v0.3.0', icon: 'check' });
  });
  it('idle with unknown version → hidden', () => {
    expect(chipPresentation('idle', { appVersion: null })).toBeNull();
  });
  it('checking keeps prior idle chip visible (not hidden)', () => {
    expect(chipPresentation('checking', { appVersion: '0.3.0' }))
      .toMatchObject({ variant: 'idle', label: 'v0.3.0' });
  });
  it('available → update label', () => {
    expect(chipPresentation('available', { appVersion: '0.3.0', version: '0.4.0' }))
      .toMatchObject({ variant: 'available', label: '0.4.0', icon: 'up' });
  });
  it('downloading → percent', () => {
    expect(chipPresentation('downloading', { progress: 42 }))
      .toMatchObject({ variant: 'downloading', label: '42%', icon: 'spin' });
  });
  it('ready → restart', () => {
    expect(chipPresentation('ready', {})).toMatchObject({ variant: 'ready', icon: 'restart' });
  });
  it('error → failed', () => {
    expect(chipPresentation('error', {})).toMatchObject({ variant: 'error', icon: 'alert' });
  });
});

describe('prepareReleases', () => {
  const raw = [
    { version: '0.4.0', name: 'v0.4.0', date: '2026-06-01', prerelease: true, notes: 'a' },
    { version: '0.3.0', name: 'v0.3.0', date: '2026-05-20', prerelease: false, notes: 'b' },
    { version: '0.2.7', name: 'v0.2.7', date: '2026-05-03', prerelease: false, notes: 'c' },
  ];
  it('stable hides prereleases', () => {
    const out = prepareReleases(raw, 'stable', '0.3.0');
    expect(out.map(r => r.version)).toEqual(['0.3.0', '0.2.7']);
  });
  it('preview includes prereleases', () => {
    const out = prepareReleases(raw, 'preview', '0.3.0');
    expect(out.map(r => r.version)).toEqual(['0.4.0', '0.3.0', '0.2.7']);
  });
  it('marks the running version current', () => {
    const out = prepareReleases(raw, 'stable', '0.3.0');
    expect(out.find(r => r.version === '0.3.0').current).toBe(true);
    expect(out.find(r => r.version === '0.2.7').current).toBe(false);
  });
  it('tolerates empty/nullish input', () => {
    expect(prepareReleases(null, 'stable', '0.3.0')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bun run test src/utils/updatePresentation.test.js`
Expected: FAIL — "Failed to resolve import './updatePresentation'".

- [ ] **Step 3: Write the implementation**

```js
// frontend/src/utils/updatePresentation.js
/**
 * Pure, framework-free mappings for the status-bar update surface.
 * Kept free of React/Tauri so it is unit-testable in isolation.
 */

/**
 * Map updater state to the bar chip's presentation, or null to hide it.
 * `icon` is a stable token the component maps to a lucide icon.
 */
export function chipPresentation(status, { appVersion = null, version = null, progress = 0 } = {}) {
  switch (status) {
    case 'available':
      return { variant: 'available', label: version || '', icon: 'up' };
    case 'downloading':
      return { variant: 'downloading', label: `${Math.round(progress)}%`, icon: 'spin' };
    case 'ready':
      return { variant: 'ready', label: '', icon: 'restart' };
    case 'error':
      return { variant: 'error', label: '', icon: 'alert' };
    case 'idle':
    case 'checking':
    default:
      // Up to date (or mid-check): show the current version chip, or hide if unknown.
      return appVersion ? { variant: 'idle', label: `v${appVersion}`, icon: 'check' } : null;
  }
}

/** Filter a releases array by channel, sort newest-first, and mark the running version. */
export function prepareReleases(releases, channel, appVersion) {
  if (!Array.isArray(releases)) return [];
  const includePre = channel === 'preview';
  return releases
    .filter((r) => includePre || !r.prerelease)
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .map((r) => ({ ...r, current: !!appVersion && r.version === appVersion }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bun run test src/utils/updatePresentation.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/updatePresentation.js frontend/src/utils/updatePresentation.test.js
git commit -m "feat(update): pure chip + release presentation helpers"
```

---

## Task 2: Extend updaterSlice (app version + channel)

**Files:**
- Modify: `frontend/src/store/updaterSlice.ts`
- Test: `frontend/src/store/updaterSlice.test.ts` (append)

- [ ] **Step 1: Add the failing test (append to the existing `describe('updaterSlice', …)` block)**

```ts
  it('tracks app version', () => {
    const { get } = harness();
    expect(get().appVersion).toBeNull();
    get().setAppVersion('0.3.0');
    expect(get().appVersion).toBe('0.3.0');
  });

  it('holds the update channel, defaulting to stable', () => {
    const { get } = harness();
    expect(get().updateChannel).toBe('stable');
    get().setUpdateChannelValue('preview');
    expect(get().updateChannel).toBe('preview');
    get().setUpdateChannelValue('bogus');     // normalized
    expect(get().updateChannel).toBe('stable');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bun run test src/store/updaterSlice.test.ts`
Expected: FAIL — `appVersion`/`updateChannel` undefined.

- [ ] **Step 3: Implement — edit `frontend/src/store/updaterSlice.ts`**

Add the import at the top:

```ts
import { normalizeChannel } from '../utils/updateChannel';
```

Add to the `UpdaterSlice` interface (after `updateError`):

```ts
  appVersion: string | null;
  updateChannel: 'stable' | 'preview';
  setAppVersion: (v: string | null) => void;
  setUpdateChannelValue: (ch: string) => void;
```

Add to the returned object (after `dismissUpdate`):

```ts
  appVersion: null,
  updateChannel: 'stable',
  setAppVersion: (v) => set({ appVersion: v }),
  setUpdateChannelValue: (ch) => set({ updateChannel: normalizeChannel(ch) }),
```

(`normalizeChannel` returns `'stable'` for unknown values — see `frontend/src/utils/updateChannel.js`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bun run test src/store/updaterSlice.test.ts`
Expected: PASS (existing 5 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/updaterSlice.ts frontend/src/store/updaterSlice.test.ts
git commit -m "feat(update): app version + channel in updaterSlice"
```

---

## Task 3: releasesSlice (transient releases list)

**Files:**
- Create: `frontend/src/store/releasesSlice.ts`
- Test: `frontend/src/store/releasesSlice.test.ts`
- Modify: `frontend/src/store/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/store/releasesSlice.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createReleasesSlice } from './releasesSlice';

function harness(loader) {
  let state: any = {};
  const set = (p: any) => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; };
  state = createReleasesSlice(set as any, (() => state) as any, {} as any);
  state.__loader = loader;            // test seam: injected fetcher
  return { get: () => state };
}

describe('releasesSlice', () => {
  it('starts idle/empty', () => {
    const { get } = harness();
    expect(get().releases).toEqual([]);
    expect(get().releasesStatus).toBe('idle');
  });

  it('loadReleases → loaded on success', async () => {
    const data = [{ version: '0.3.0', name: 'v0.3.0', date: '2026-05-20', prerelease: false, notes: 'x' }];
    const { get } = harness();
    await get().loadReleases('stable', () => Promise.resolve(data));
    expect(get().releasesStatus).toBe('loaded');
    expect(get().releases).toEqual(data);
  });

  it('loadReleases → error on failure (keeps app usable)', async () => {
    const { get } = harness();
    await get().loadReleases('stable', () => Promise.reject(new Error('offline')));
    expect(get().releasesStatus).toBe('error');
    expect(get().releases).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bun run test src/store/releasesSlice.test.ts`
Expected: FAIL — cannot resolve `./releasesSlice`.

- [ ] **Step 3: Implement the slice**

```ts
// frontend/src/store/releasesSlice.ts
import type { StateCreator } from 'zustand';
import { listReleases } from '../utils/updater';

export interface ReleaseInfo {
  version: string;
  name: string;
  date: string;
  prerelease: boolean;
  notes: string;
}
export type ReleasesStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface ReleasesSlice {
  releases: ReleaseInfo[];
  releasesStatus: ReleasesStatus;
  /** Load releases for a channel. `loader` is injectable for tests; defaults to the Tauri command. */
  loadReleases: (channel: string, loader?: (ch: string) => Promise<ReleaseInfo[]>) => Promise<void>;
}

export const createReleasesSlice: StateCreator<ReleasesSlice, [], [], ReleasesSlice> = (set) => ({
  releases: [],
  releasesStatus: 'idle',
  loadReleases: async (channel, loader = listReleases) => {
    set({ releasesStatus: 'loading' });
    try {
      const data = await loader(channel);
      set({ releases: Array.isArray(data) ? data : [], releasesStatus: 'loaded' });
    } catch {
      set({ releases: [], releasesStatus: 'error' });
    }
  },
});
```

- [ ] **Step 4: Compose it into the root store — edit `frontend/src/store/index.ts`**

Add near the other slice imports:

```ts
import type { ReleasesSlice } from './releasesSlice';
import { createReleasesSlice } from './releasesSlice';
```

Add `ReleasesSlice` to the `AppStore` union:

```ts
export type AppStore = PrefsSlice & GlossarySlice & UiSlice & DubSlice & GenerateSlice & PillSlice & StoriesSlice & UpdaterSlice & GallerySlice & ReleasesSlice;
```

Add the spread inside the store creator, next to `createUpdaterSlice` (it is transient — do NOT add it to `partialize`):

```ts
      ...createReleasesSlice(set, get, api),  // transient — not in partialize
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd frontend && bun run test src/store/releasesSlice.test.ts && bun run typecheck:ci`
Expected: PASS (3 tests) + typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store/releasesSlice.ts frontend/src/store/releasesSlice.test.ts frontend/src/store/index.ts
git commit -m "feat(update): transient releasesSlice composed into store"
```

---

## Task 4: Rust `list_releases` command

**Files:**
- Modify: `frontend/src-tauri/src/updater_channel.rs`
- Modify: `frontend/src-tauri/src/lib.rs`

> Note: Rust has no unit test in this repo's JS-centric flow. Verify by `cargo check` and a manual run; the frontend tests mock `listReleases`, so the JS side is covered independently.

- [ ] **Step 1: Add the command to `frontend/src-tauri/src/updater_channel.rs`**

Append (the file already uses `reqwest`/`serde` for `check_update`; reuse the same crates):

```rust
use serde::Serialize;

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
    let client = reqwest::Client::new();
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
```

(If `use serde::Serialize;` or `serde_json` is already imported at the top of the file, do not duplicate the `use`.)

- [ ] **Step 2: Register it — edit `frontend/src-tauri/src/lib.rs`**

In the `tauri::generate_handler![ … ]` list (around line 100, next to `updater_channel::check_update`), add:

```rust
            updater_channel::list_releases,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd frontend/src-tauri && cargo check`
Expected: compiles (warnings ok). If `serde_json` is not yet a dependency, add `serde_json = "1"` under `[dependencies]` in `frontend/src-tauri/Cargo.toml` (it is already a transitive dep of tauri; prefer the existing version) and re-run.

- [ ] **Step 4: Commit**

```bash
git add frontend/src-tauri/src/updater_channel.rs frontend/src-tauri/src/lib.rs frontend/src-tauri/Cargo.toml
git commit -m "feat(update): list_releases Tauri command (GitHub releases)"
```

---

## Task 5: Frontend updater wrappers (`loadReleases`, `fetchAppVersion`)

**Files:**
- Modify: `frontend/src/utils/updater.js`
- Test: `frontend/src/utils/updater.test.js` (append)

- [ ] **Step 1: Add failing tests (append to the existing describe in `updater.test.js`)**

```js
describe('listReleases / fetchAppVersion', () => {
  beforeEach(() => { window.__TAURI_INTERNALS__ = {}; });
  afterEach(() => { delete window.__TAURI_INTERNALS__; });

  it('listReleases returns [] when not in Tauri', async () => {
    delete window.__TAURI_INTERNALS__;
    const { listReleases } = await import('./updater');
    expect(await listReleases('stable')).toEqual([]);
  });

  it('fetchAppVersion returns null when not in Tauri', async () => {
    delete window.__TAURI_INTERNALS__;
    const { fetchAppVersion } = await import('./updater');
    expect(await fetchAppVersion()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bun run test src/utils/updater.test.js`
Expected: FAIL — `listReleases`/`fetchAppVersion` are not exported.

- [ ] **Step 3: Implement — append to `frontend/src/utils/updater.js`**

```js
/** Fetch the project's releases (changelog/history) via the Rust command. [] outside Tauri / on error. */
export async function listReleases(channel) {
  if (!isTauri()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  const data = await invoke('list_releases', { channel });
  return Array.isArray(data) ? data : [];
}

/** Current app version via Tauri, or null outside a packaged build. */
export async function fetchAppVersion() {
  if (!isTauri()) return null;
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bun run test src/utils/updater.test.js`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/updater.js frontend/src/utils/updater.test.js
git commit -m "feat(update): listReleases + fetchAppVersion wrappers"
```

---

## Task 6: `UpdateStatusChip` component

**Files:**
- Create: `frontend/src/components/UpdateStatusChip.jsx`, `frontend/src/components/UpdateStatusChip.css`

> Logic is already covered by `updatePresentation.test.js` (Task 1). This component is the thin view; no new unit test required, but it must typecheck and build.

- [ ] **Step 1: Implement the component**

```jsx
// frontend/src/components/UpdateStatusChip.jsx
// Persistent update indicator that lives in the LogsFooter bar (replaces the
// old floating UpdateBadge). Shows current version when idle; morphs into
// available / downloading / ready / error. Click opens the Updates panel.
import { useTranslation } from 'react-i18next';
import { Check, ArrowUp, Loader, RotateCw, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../store';
import { chipPresentation } from '../utils/updatePresentation';
import { installUpdate } from '../utils/updater';
import './UpdateStatusChip.css';

const ICONS = { check: Check, up: ArrowUp, spin: Loader, restart: RotateCw, alert: AlertTriangle };

export default function UpdateStatusChip({ onOpen }) {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.updateStatus);
  const version = useAppStore((s) => s.updateVersion);
  const appVersion = useAppStore((s) => s.appVersion);
  const progress = useAppStore((s) => s.updateProgress);

  const p = chipPresentation(status, { appVersion, version, progress });
  if (!p) return null;
  const Icon = ICONS[p.icon] || Check;

  const labelText = {
    idle: p.label,
    available: t('update.available', { version: p.label }),
    downloading: t('update.downloading', { pct: p.label.replace('%', '') }),
    ready: t('update.restart'),
    error: t('update.failed'),
  }[p.variant];

  // ready/error stay one-click (preserve today's behavior); others open the panel.
  const onClick = () => {
    if (p.variant === 'ready') { installUpdate(useAppStore.getState()); return; }
    onOpen?.();
  };

  return (
    <button
      type="button"
      className={`update-chip update-chip--${p.variant}`}
      onClick={onClick}
      title={t('updates.tab')}
    >
      <Icon size={12} className={p.icon === 'spin' ? 'spinner' : ''} />
      <span className="update-chip__label">{labelText}</span>
    </button>
  );
}
```

```css
/* frontend/src/components/UpdateStatusChip.css */
.update-chip {
  display: inline-flex; align-items: center; gap: 4px;
  height: 20px; padding: 0 8px;
  background: none; border: 1px solid transparent; border-radius: 999px;
  font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
  color: var(--text-dim, #a89984);
}
.update-chip:hover { color: #ebdbb2; }
.update-chip--idle { opacity: 0.75; }
.update-chip--available { color: #b8bb26; border-color: rgba(184, 187, 38, 0.5); }
.update-chip--downloading { color: #83a598; }
.update-chip--ready { color: #b8bb26; border-color: rgba(184, 187, 38, 0.6); }
.update-chip--error { color: #fb4934; border-color: rgba(251, 73, 52, 0.5); }
.update-chip .spinner { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 2: Verify build + typecheck**

Run: `cd frontend && bun run typecheck:ci && bun run build`
Expected: exit 0; build OK.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/UpdateStatusChip.jsx frontend/src/components/UpdateStatusChip.css
git commit -m "feat(update): UpdateStatusChip bar indicator"
```

---

## Task 7: `UpdatesPanel` component

**Files:**
- Create: `frontend/src/components/UpdatesPanel.jsx`, `frontend/src/components/UpdatesPanel.css`

- [ ] **Step 1: Implement the panel**

```jsx
// frontend/src/components/UpdatesPanel.jsx
// Body of the LogsFooter "Updates" tab: live update row + channel switcher +
// GitHub releases (changelog/history) list. Data is transient (releasesSlice).
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RotateCw, AlertTriangle, RefreshCw, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store';
import { installUpdate, checkForUpdate } from '../utils/updater';
import { prepareReleases } from '../utils/updatePresentation';
import { setChannel } from '../utils/channelControl';
import './UpdatesPanel.css';

export default function UpdatesPanel() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.updateStatus);
  const version = useAppStore((s) => s.updateVersion);
  const error = useAppStore((s) => s.updateError);
  const progress = useAppStore((s) => s.updateProgress);
  const appVersion = useAppStore((s) => s.appVersion);
  const channel = useAppStore((s) => s.updateChannel);
  const releases = useAppStore((s) => s.releases);
  const releasesStatus = useAppStore((s) => s.releasesStatus);
  const loadReleases = useAppStore((s) => s.loadReleases);
  const dismissUpdate = useAppStore((s) => s.dismissUpdate);
  const dubStep = useAppStore((s) => s.dubStep);

  useEffect(() => { loadReleases(channel); }, [channel, loadReleases]);

  const busy = dubStep === 'generating';
  const onInstall = () => {
    if (busy) { toast(t('update.busy'), { icon: '⏳' }); return; }
    installUpdate(useAppStore.getState());
  };
  const rows = prepareReleases(releases, channel, appVersion);

  return (
    <div className="updates-panel">
      <div className="updates-panel__live">
        {status === 'available' && (
          <button className="updates-panel__cta" onClick={onInstall}>
            <Download size={13} /> {t('update.available', { version: version || '' })} · {t('update.install')}
          </button>
        )}
        {status === 'downloading' && (
          <span className="updates-panel__progress">
            {t('update.downloading', { pct: Math.round(progress) })}
            <span className="updates-panel__bar"><span style={{ width: `${progress}%` }} /></span>
          </span>
        )}
        {status === 'ready' && (
          <button className="updates-panel__cta" onClick={onInstall}>
            <RotateCw size={13} /> {t('update.restart')}
          </button>
        )}
        {status === 'error' && (
          <span className="updates-panel__err">
            <AlertTriangle size={13} /> {error || t('update.failed')}
            <button className="updates-panel__link" onClick={onInstall}>{t('update.retry')}</button>
            <button className="updates-panel__icon" onClick={dismissUpdate} aria-label={t('update.dismiss')}><X size={13} /></button>
          </span>
        )}
        {(status === 'idle' || status === 'checking') && (
          <span className="updates-panel__ok">
            {t('updates.up_to_date', { version: appVersion || '' })}
            <button className="updates-panel__link" onClick={() => checkForUpdate(useAppStore.getState())}>
              <RefreshCw size={12} /> {t('updates.check_now')}
            </button>
          </span>
        )}
      </div>

      <div className="updates-panel__channel">
        <span>{t('about.update_channel')}</span>
        <div className="updates-panel__seg">
          {['stable', 'preview'].map((c) => (
            <button
              key={c}
              className={`updates-panel__segbtn ${channel === c ? 'is-active' : ''}`}
              onClick={() => setChannel(useAppStore.getState(), c)}
            >
              {t(`about.channel_${c}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="updates-panel__releases">
        <div className="updates-panel__rel-head">{t('updates.releases')}</div>
        {releasesStatus === 'error' && (
          <div className="updates-panel__rel-empty">
            {t('updates.load_error')}
            <button className="updates-panel__link" onClick={() => loadReleases(channel)}>{t('updates.retry_load')}</button>
          </div>
        )}
        {releasesStatus === 'loading' && <div className="updates-panel__rel-empty">{t('updates.loading')}</div>}
        {releasesStatus === 'loaded' && rows.length === 0 && (
          <div className="updates-panel__rel-empty">{t('updates.none')}</div>
        )}
        {rows.map((r) => (
          <div key={r.version} className={`updates-panel__rel ${r.current ? 'is-current' : ''}`}>
            <div className="updates-panel__rel-row">
              <span className="updates-panel__rel-ver">v{r.version}</span>
              {r.current && <span className="updates-panel__rel-tag">{t('updates.current')}</span>}
              {r.prerelease && <span className="updates-panel__rel-pre">{t('updates.prerelease')}</span>}
              <span className="updates-panel__rel-date">{r.date}</span>
            </div>
            {r.notes && <pre className="updates-panel__rel-notes">{r.notes}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}
```

```css
/* frontend/src/components/UpdatesPanel.css */
.updates-panel { padding: 8px 12px; overflow-y: auto; font-size: 12px; color: #d5c4a1; }
.updates-panel__live { display: flex; align-items: center; min-height: 26px; }
.updates-panel__cta {
  display: inline-flex; align-items: center; gap: 6px;
  background: rgba(184,187,38,0.14); border: 1px solid rgba(184,187,38,0.5);
  color: #b8bb26; border-radius: 999px; padding: 3px 10px; font: inherit; cursor: pointer;
}
.updates-panel__ok, .updates-panel__err, .updates-panel__progress { display: inline-flex; align-items: center; gap: 8px; }
.updates-panel__err { color: #fb4934; }
.updates-panel__link { background: none; border: none; color: #83a598; cursor: pointer; font: inherit; display: inline-flex; align-items: center; gap: 3px; }
.updates-panel__icon { background: none; border: none; color: #fb4934; cursor: pointer; padding: 0 2px; }
.updates-panel__bar { display: inline-block; width: 80px; height: 3px; background: rgba(255,255,255,0.12); border-radius: 2px; overflow: hidden; }
.updates-panel__bar span { display: block; height: 100%; background: #b8bb26; }
.updates-panel__channel { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.updates-panel__seg { display: inline-flex; border: 1px solid var(--chrome-border, #3a3a3a); border-radius: 6px; overflow: hidden; }
.updates-panel__segbtn { background: none; border: none; color: var(--text-dim, #a89984); padding: 2px 10px; font: inherit; cursor: pointer; }
.updates-panel__segbtn.is-active { background: rgba(131,165,152,0.18); color: #ebdbb2; }
.updates-panel__rel-head { font-weight: 600; color: var(--text-dim, #a89984); margin: 6px 0 4px; }
.updates-panel__rel-empty { color: var(--text-dim, #a89984); display: inline-flex; gap: 8px; align-items: center; padding: 6px 0; }
.updates-panel__rel { border-top: 1px solid var(--chrome-border, #2a2a2a); padding: 6px 0; }
.updates-panel__rel.is-current { background: rgba(184,187,38,0.06); }
.updates-panel__rel-row { display: flex; align-items: center; gap: 8px; }
.updates-panel__rel-ver { font-weight: 600; }
.updates-panel__rel-tag { font-size: 10px; color: #b8bb26; border: 1px solid rgba(184,187,38,0.5); border-radius: 999px; padding: 0 6px; }
.updates-panel__rel-pre { font-size: 10px; color: #d79921; border: 1px solid rgba(215,153,33,0.5); border-radius: 999px; padding: 0 6px; }
.updates-panel__rel-date { margin-left: auto; color: var(--text-dim, #a89984); }
.updates-panel__rel-notes { white-space: pre-wrap; overflow-wrap: break-word; margin: 4px 0 0; font-size: 11px; line-height: 1.4; color: #bdae93; }
```

- [ ] **Step 2: Create the shared channel helper `frontend/src/utils/channelControl.js`** (used by panel + Settings so logic isn't duplicated)

```js
// frontend/src/utils/channelControl.js
import { isTauri } from './updater';
import { normalizeChannel } from './updateChannel';

/** Set the update channel: update the store and persist via Tauri. Returns the normalized channel. */
export async function setChannel(store, ch) {
  const next = normalizeChannel(ch);
  store.setUpdateChannelValue(next);
  if (!isTauri()) return next;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_update_channel', { channel: next });
  return next;
}

/** Read the persisted channel from Tauri into the store on boot. */
export async function syncChannel(store) {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const ch = await invoke('get_update_channel');
    store.setUpdateChannelValue(ch);
  } catch { /* keep default */ }
}
```

- [ ] **Step 3: Verify build + typecheck**

Run: `cd frontend && bun run typecheck:ci && bun run build`
Expected: exit 0; build OK.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/UpdatesPanel.jsx frontend/src/components/UpdatesPanel.css frontend/src/utils/channelControl.js
git commit -m "feat(update): UpdatesPanel (live row + channel + releases list)"
```

---

## Task 8: Mount in LogsFooter; remove floating badge; boot wiring

**Files:**
- Modify: `frontend/src/components/LogsFooter.jsx`
- Modify: `frontend/src/App.jsx`
- Delete: `frontend/src/components/UpdateBadge.jsx`, `frontend/src/components/UpdateBadge.css`

- [ ] **Step 1: Add the Updates tab + chip to `LogsFooter.jsx`**

a) Add imports at the top:

```jsx
import { Download } from 'lucide-react';
import UpdatesPanel from './UpdatesPanel';
import UpdateStatusChip from './UpdateStatusChip';
```

b) Add the tab to the `SOURCES` array (after the `tauri` entry, ~line 27):

```jsx
  { id: 'updates', label: 'Updates', icon: Download },
```

c) Render the panel body. Find where the body switches on `active` (the place that renders backend/frontend/tauri log bodies). Add a branch so that when `active === 'updates'` (and not collapsed) it renders `<UpdatesPanel />` instead of the log list. Concretely, wrap the existing log-body render so:

```jsx
{!collapsed && active === 'updates'
  ? <UpdatesPanel />
  : (/* existing log-lines body JSX unchanged */)}
```

d) Mount the chip in the right cluster. Inside `<div className="logs-footer__right">` (~line 375), before the existing `{!collapsed && (<div className="logs-footer__actions"> … )}`, add:

```jsx
          <UpdateStatusChip onOpen={() => openTo('updates')} />
```

`openTo` already exists (`const openTo = (id) => { setActive(id); setCollapsed(false); };`, ~line 263) and works collapsed or expanded.

e) The Updates tab pill must not try to render error/warn log badges. The `SourcePill` for `updates` should render with zero counts — pass `counts={{ error: 0, warn: 0, total: 0 }}` for that source (the existing pill already hides badges when counts are 0).

- [ ] **Step 2: Remove the floating badge + wire boot — edit `frontend/src/App.jsx`**

a) Delete the import `import UpdateBadge from './components/UpdateBadge';` (~line 29).
b) Delete the `<UpdateBadge />` render (~line 852).
c) In the boot effect that calls `checkForUpdate` (~line 397–406), also fetch the app version and sync the channel. Add these imports at the top:

```jsx
import { fetchAppVersion } from './utils/updater';
import { syncChannel } from './utils/channelControl';
```

And inside that effect, alongside the existing `checkForUpdate(useAppStore.getState())`:

```jsx
    fetchAppVersion().then((v) => useAppStore.getState().setAppVersion(v));
    syncChannel(useAppStore.getState());
```

- [ ] **Step 3: Delete the retired files**

```bash
git rm frontend/src/components/UpdateBadge.jsx frontend/src/components/UpdateBadge.css
```

(Note: `frontend/src/utils/updater.test.js` and `updaterSlice.test.ts` do not import UpdateBadge, so they are unaffected. If any other file imports `UpdateBadge`, grep and remove those references: `grep -rl UpdateBadge frontend/src`.)

- [ ] **Step 4: Verify**

Run: `cd frontend && grep -rl UpdateBadge src || echo "no refs"; bun run typecheck:ci && bun run build`
Expected: "no refs"; typecheck exit 0; build OK.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/LogsFooter.jsx frontend/src/App.jsx
git commit -m "feat(update): mount chip+panel in LogsFooter, retire floating UpdateBadge"
```

---

## Task 9: Bind Settings channel switcher to the store (auto-sync)

**Files:**
- Modify: `frontend/src/pages/Settings.jsx`

- [ ] **Step 1: Replace the local channel state with the store + shared helper**

In `Settings.jsx` (About tab, ~lines 1069–1102):

a) Remove the local `const [updateChannel, setUpdateChannelState] = useState('stable')` and read from the store instead:

```jsx
const updateChannel = useAppStore((s) => s.updateChannel);
```

b) Replace the body of `changeChannel` to use the shared helper (keeps Settings and the panel in sync):

```jsx
import { setChannel } from '../utils/channelControl';
// ...
const changeChannel = useCallback(async (ch) => {
  try {
    const next = await setChannel(useAppStore.getState(), ch);
    toast.success(t('about.channel_set', { channel: t(`about.channel_${next}`) }));
  } catch (e) {
    toast.error(`Failed to set channel: ${e?.message || e}`);
  }
}, [t]);
```

c) The existing on-mount `invoke('get_update_channel')` effect can be removed (App.jsx now calls `syncChannel` on boot). If you keep it, have it call `useAppStore.getState().setUpdateChannelValue(ch)` instead of local state.

- [ ] **Step 2: Verify**

Run: `cd frontend && bun run typecheck:ci && bun run build`
Expected: exit 0; build OK.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat(update): Settings channel switcher shares store value (auto-sync)"
```

---

## Task 10: i18n — add `updates.*` keys to all 21 locales

**Files:**
- Modify: `frontend/src/i18n/locales/*.json` (all 21)

- [ ] **Step 1: Add the English keys to `frontend/src/i18n/locales/en.json`**

Insert a new top-level `"updates"` block (e.g. right after the existing `"update"` block, ~line 12):

```json
  "updates": {
    "tab": "Updates",
    "up_to_date": "Up to date · v{{version}}",
    "check_now": "Check now",
    "releases": "Releases",
    "current": "current",
    "prerelease": "preview",
    "loading": "Loading releases…",
    "none": "No releases found",
    "load_error": "Couldn't load releases (offline?)",
    "retry_load": "Retry"
  },
```

- [ ] **Step 2: Backfill the other 20 locales with the repo's translation script**

Only `en.json` is edited by hand. The repo's existing backfill script (`scripts/translate_all.py` — `deep_translator`/GoogleTranslator, source `en.json` → fills any keys missing from each `frontend/src/i18n/locales/{lang}.json`; the same pipeline used for #205) propagates the new `updates.*` block to all 20 other locales:

```bash
cd /Users/user4/orca/workspaces/OmniVoice/main-2
uv run python scripts/translate_all.py
```

> Note: only the `updates.*` keys are new for this feature — the components reuse the already-present `update.*` and `about.channel_*` keys (verified against `en.json`), so the script only needs to add the 10 new strings. After it runs, spot-check the CJK locales (`zh-CN`, `zh-TW`, `ja`, `ko`) render the new strings; every locale must have all 10 `updates.*` keys (parity check in Step 3).

- [ ] **Step 3: Verify parity + CJK guard**

Run:
```bash
cd frontend && node -e "const fs=require('fs');const g=require('./src/i18n/locales/en.json').updates;const files=fs.readdirSync('src/i18n/locales').filter(f=>f.endsWith('.json'));let bad=0;for(const f of files){const u=require('./src/i18n/locales/'+f).updates||{};for(const k of Object.keys(g)){if(!(k in u)){console.log('MISSING',f,k);bad++}}}console.log(bad?('FAIL '+bad):'PARITY OK')"
cd /Users/user4/orca/workspaces/OmniVoice/main-2 && uv run python -m pytest tests/test_no_hardcoded_cjk.py -q
```
Expected: "PARITY OK"; CJK guard passes (no hardcoded CJK outside the i18n layer — all new strings are in locale files).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/i18n/locales
git commit -m "i18n(update): add updates.* keys across 21 locales"
```

---

## Task 11: Full verification + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite**

```bash
cd /Users/user4/orca/workspaces/OmniVoice/main-2/frontend
bun run test            # vitest — all suites incl. new helper/slice tests
bun run typecheck:ci    # tsc gate
bun run build           # production build
cd ../ && uv run python -m pytest tests/test_no_hardcoded_cjk.py -q
```
Expected: vitest all green (existing + new); typecheck exit 0; build OK; CJK guard passes.

- [ ] **Step 2: Manual smoke (packaged build, optional but recommended)**

Run: `bun run desktop-prod:upgrade` (uses `--keep-data` — does NOT wipe user data). In the running app: the floating pill is gone; the `LogsFooter` right side shows `v<version> ✓`; clicking it opens the Updates tab; the channel switcher flips stable/preview and reloads the releases list; toggling channel in Settings → About updates the panel too.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/updates-status-bar
gh pr create --base main --title "feat(update): move update pill into status bar + Updates panel (changelog/channel/history)" --body-file <(echo "Implements docs/superpowers/specs/2026-06-02-updates-status-bar-design.md. Moves the floating UpdateBadge into the LogsFooter as a persistent version chip + an Updates tab (live update action, stable/preview channel switcher synced with Settings, GitHub-sourced releases list). Adds Rust list_releases command. i18n across 21 locales. Tests: chip/release helpers, releasesSlice, updater wrappers.")
```

---

## Self-review

**Spec coverage:**
- Persistent chip (idle→error states) → Tasks 1, 6. ✓
- Updates tab/panel (live row + channel + releases) → Tasks 3, 5, 7, 8. ✓
- GitHub releases (live, channel-filtered, offline-safe) → Tasks 4, 5, 7. ✓
- Channel switcher coexists/synced with Settings → Tasks 2, 7 (`channelControl`), 9. ✓
- Remove floating badge → Task 8. ✓
- i18n 21 locales + CJK guard → Task 10. ✓
- Cross-platform parity (pure FE + platform-agnostic Rust) → inherent; verified by build (Task 11). ✓
- Tests for helpers/slices/wrappers → Tasks 1, 2, 3, 5. ✓

**Placeholder scan:** No "TBD"/"add error handling"-style gaps; every code step shows real code. The one tooling-dependent step (Task 10 Step 2, locale backfill) gives an explicit fallback (hand-translate the 10 strings) and a parity check.

**Type consistency:** `chipPresentation`/`prepareReleases` (Task 1) ↔ consumed in Tasks 6/7. `ReleaseInfo` shape matches between Rust `list_releases` (Task 4: version/name/date/prerelease/notes), `releasesSlice` (Task 3), and `prepareReleases` (Task 1). `setUpdateChannelValue` (Task 2) used by `channelControl` (Task 7) + Settings (Task 9). `loadReleases(channel, loader?)` signature consistent (Tasks 3, 7). `listReleases`/`fetchAppVersion` (Task 5) used in Tasks 3/8.
