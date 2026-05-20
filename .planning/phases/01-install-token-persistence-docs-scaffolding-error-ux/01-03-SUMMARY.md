---
phase: 01-install-token-persistence-docs-scaffolding-error-ux
plan: 03
wave: 3
status: complete
date: 2026-05-20
issues_closed:
  - "#54 macOS Gatekeeper .dmg quarantine"
  - "#56 AppImage Fedora white-screen"
  - "#76 .deb ffprobe conflict on Ubuntu 26.04"
  - "#80 Docker LAN frontend"
requirements_satisfied:
  - INST-01 (no-regression assert)
  - INST-03 (backend half — Gatekeeper probe)
  - INST-04 (AppImage launcher conditional)
---

# Phase 1 Wave 3 — Summary

## What shipped

### Task 1 — AppRun strategy spike + AppImage launcher (issue #56)

**Decision:** `.planning/decisions/apprun-strategy.md` — chose **Strategy B**:
custom AppRun source at `frontend/src-tauri/appimage/AppRun` injected into
Tauri's AppImage staging dir via `beforeBundleCommand` (which Tauri 2 supports
as a sibling of `beforeBuildCommand`).

Tauri 2 does not have a first-class `appRun` template config key today
(tracking: tauri-apps/tauri#7616). The `beforeBundleCommand` hook is the
documented escape hatch and runs after `cargo build` but before
`appimagetool` packs the .AppDir — exactly the right injection point.

**Files:**

- `frontend/src-tauri/appimage/AppRun` — conditional launcher; sets
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` only on broken WebKit ranges
  (`2.44.x`, `2.46.x`, plus the `0.0` fallback when pkg-config is missing).
- `frontend/src-tauri/appimage/AppRun.test.sh` — 4-case shell unit test
  (per checker W-1): broken 2.44, broken 2.46, healthy 2.48, pkg-config
  absent. All pass.
- `scripts/inject-apprun.sh` — glob the .AppDir under
  `target/{release,debug}/bundle/appimage/*.AppDir/`, overwrite its AppRun
  with our source. No-op when no AppDir exists (macOS/Windows builds).
- `frontend/src-tauri/tauri.conf.json` — `beforeBundleCommand` set to
  `bash ../../scripts/inject-apprun.sh`.

### Task 2 — .deb ffprobe relocation (issue #76)

**Mechanism:** `tauri.linux.conf.json` `bundle.linux.deb.files` map relocates
the bundled ffprobe binary to `/usr/lib/omnivoice-studio/bin/ffprobe`. The
postinst script defensively removes any legacy `/usr/bin/ffprobe` **only when
`dpkg -S /usr/bin/ffprobe` confirms our package owns it** — never wipes a
user's distro-provided ffprobe (Pitfall #7 + Runtime State Inventory).

**Files:**

- `frontend/src-tauri/tauri.linux.conf.json` — `deb.files` map +
  `preInstallScript` / `postInstallScript` / `postRemoveScript` paths.
- `frontend/src-tauri/debian/preinst` — `mkdir -p /usr/lib/omnivoice-studio/bin`.
- `frontend/src-tauri/debian/postinst` — owner-check + cleanup of legacy
  `/usr/bin/ffprobe` (only when `dpkg -S` reports omnivoice-studio).
- `frontend/src-tauri/debian/postrm` — `rm -f` + `rmdir` of the relocated
  path on purge/remove.
- `frontend/src-tauri/src/tools.rs` — `resolve_ffprobe()` now probes
  `/usr/lib/omnivoice-studio/bin/ffprobe` on Linux before falling back to
  the cached/PATH paths.
- `frontend/src-tauri/src/backend.rs` — backend subprocess env now carries
  both `FFPROBE_PATH` (legacy, backward compat) and
  `OMNIVOICE_FFPROBE_PATH` (canonical, namespaced).
- `backend/services/ffmpeg_utils.py` — new `resolve_ffprobe()` function
  with env-first / PATH-fallback cascade; `find_ffprobe()` retained as
  legacy wrapper.
- `tests/backend/services/test_ffmpeg_utils.py` — 6 tests for the cascade
  (all pass).

### Task 3 — Centralised `apiBase.ts` (issue #80)

**Grep sweep result (Assumption A4 confirmed):** the *only* hardcoded
`localhost:3900` / `127.0.0.1:3900` reference in `frontend/src/` was
`frontend/src/utils/media.js:20`. After the patch the only matches are
docstring comments inside `apiBase.ts` itself (verifying the contract) and
one comment line in `media.js` documenting the issue number.

**Mechanism:** `apiBase.ts` exports a 4-branch resolver:
1. `VITE_OMNIVOICE_API` override (Docker / dev).
2. Tauri webview → `http://localhost:3900`.
3. Plain browser → `${window.location.protocol}//${window.location.hostname}:3900`
   (this is the #80 fix — the page's origin/host follows).
4. SSR / no-window fallback → `http://localhost:3900`.

A small testing hook (`_setEnvOverrideForTesting`) works around vitest 4.x's
known limitation where `vi.stubEnv` does not propagate to dynamically
imported modules' `import.meta.env` (https://github.com/vitest-dev/vitest
discussion: per-module env snapshot).

**Files:**

- `frontend/src/utils/apiBase.ts` — new (the resolver).
- `frontend/src/utils/apiBase.test.ts` — 6 tests (override, trailing-slash
  strip, Tauri context, LAN browser, HTTPS LAN, BACKEND_PORT constant).
- `frontend/src/utils/media.js` — `_PREVIEW_API` now imported from apiBase.

### Task 4 — macOS Gatekeeper detection + INST-01 verification (#54)

**Backend probe:** `backend/core/gatekeeper_detect.py` walks up from
`sys.executable` to find the `.app` bundle root, then runs `xattr -l` and
greps for `com.apple.quarantine`. Detection only — never auto-runs
`xattr -cr` (Anti-Pattern per RESEARCH.md: the app itself is quarantined
and cannot fix its own state).

**Startup wiring:** `backend/main.py` `lifespan` now calls
`gatekeeper_detect.quarantine_status()` and, on detection, logs a
structured warning and emits a `system_error` event via the existing
event bus with `error_class="GATEKEEPER_QUARANTINE"`. The React
ErrorBoundary's deeplink mapping (shipped by Wave 2 in
`frontend/src/utils/errorDocsMap.ts`) consumes this class.

**REST surface:** `GET /system/quarantine-status` returns the structured
status dict for first-load polling by the frontend.

**INST-01 no-regression:** `tests/backend/test_pyproject.py` asserts
`setuptools>=75.0` is still pinned in `[project.dependencies]` (PR #62).
Companion `scripts/smoke-test.sh` line was added so the user-observable
shape ("`pkg_resources` + `whisperx` import OK") gets exercised on each
release.

**Files:**

- `backend/core/gatekeeper_detect.py` — new.
- `backend/api/routers/system.py` — new `/system/quarantine-status` endpoint.
- `backend/main.py` — gatekeeper probe in lifespan startup.
- `tests/backend/core/test_gatekeeper_detect.py` — 7 tests (all pass).
- `tests/backend/test_pyproject.py` — INST-01 setuptools pin assertion.
- `scripts/smoke-test.sh` — new check_endpoint for quarantine-status +
  inline pkg_resources/whisperx import probe.

## Test results

| Suite | Result |
|---|---|
| `tests/backend/services/test_ffmpeg_utils.py` | 6/6 pass |
| `tests/backend/core/test_gatekeeper_detect.py` | 7/7 pass |
| `tests/backend/test_pyproject.py` | 1/1 pass |
| `bash frontend/src-tauri/appimage/AppRun.test.sh` | 4/4 pass |
| `cd frontend && bun run test apiBase` | 6/6 pass |
| `cd frontend && bun run test` (all frontend) | 30/30 pass |
| `uv run pytest tests/ -q` (full backend) | see PR body |

## Grep-sweep result

```
$ grep -rnE '(localhost|127\.0\.0\.1):3900' frontend/src/ \
    --include='*.{js,jsx,ts,tsx}' | grep -v apiBase.ts | grep -v apiBase.test.ts
frontend/src/utils/media.js:21:// (issue #80) get window.location.hostname:3900 instead of localhost:3900.
```

Only a comment line remains — Assumption A4 (single-site hardcode at
`media.js:20`) confirmed.

## Deviations from plan

1. **AppRun strategy spike was code-inspected + documented from public
   Tauri docs, not from a live `cargo tauri build` run.** Rationale:
   running the full Tauri AppImage build requires Linux (or a Docker
   cross-build). The strategy is well-documented in Tauri 2's reference
   and only the `inject-apprun.sh` mechanism needs validation in
   Phase 6's GATE-03 release.yml smoke. The decision doc explicitly
   calls this out.

2. **ffprobe path environment variable kept as a dual export** —
   `OMNIVOICE_FFPROBE_PATH` (canonical, namespaced, per plan) plus
   `FFPROBE_PATH` (legacy alias, backward compat with prior backend
   builds and older Tauri shells). The plan required `OMNIVOICE_FFPROBE_PATH`;
   we exceed that by keeping the legacy alias to avoid breaking any
   external script that already reads `FFPROBE_PATH`.

3. **vitest env-stub workaround** — vitest 4.x does not propagate
   `vi.stubEnv` to dynamically imported modules' `import.meta.env`.
   We exposed a `_setEnvOverrideForTesting()` hook on `apiBase.ts`
   to keep the test's contract assertion meaningful. Production code
   path is unchanged; only the test reaches the hook.

## Tauri config JSON paths (for Phase 6 release verification)

- AppImage launcher injection:
  `tauri.conf.json` → `build.beforeBundleCommand` → `bash ../../scripts/inject-apprun.sh`
- .deb ffprobe relocation:
  `tauri.linux.conf.json` → `bundle.linux.deb.files["/usr/lib/omnivoice-studio/bin/ffprobe"]`
  → `binaries/ffprobe-x86_64-unknown-linux-gnu`
- .deb maintainer scripts:
  `tauri.linux.conf.json` → `bundle.linux.deb.{preInstallScript,postInstallScript,postRemoveScript}`
  → `../debian/{preinst,postinst,postrm}` (paths relative to the JSON file).
