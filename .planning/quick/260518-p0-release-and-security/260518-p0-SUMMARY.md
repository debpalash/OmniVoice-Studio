---
task: 260518-p0
branch: p0/release-and-security
base_commit: ac78417
phase: quick
type: p0-fix
tags: [release, security, ci, loopback, docker]
key-files:
  created:
    - backend/api/dependencies.py
    - tests/test_bind_host.py
    - .planning/quick/260518-p0-release-and-security/260518-p0-SUMMARY.md
  modified:
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
    - frontend/package.json
    - backend/main.py
    - backend/api/routers/system.py
    - deploy/docker-compose.yml
    - README.md
    - tests/test_api.py
    - tests/test_router_smoke.py
    - tests/smoke/test_boot_smoke.py
commits:
  - hash: a5560f5
    type: ci
    scope: typecheck-single-source
  - hash: b74b51c
    type: security
    scope: bind-host-loopback-default
  - hash: e280734
    type: security
    scope: router-level-require-loopback
date: 2026-05-18
---

# P0 — Release Reliability + Security Hardening

Three independent P0 fixes on `p0/release-and-security`, atop `ac78417`. Each lands as its own atomic commit so cherry-picking, reverting, and PR review can address them independently.

## One-liner

Single-source the CI/release typecheck flag, default the backend bind to `127.0.0.1`, and gate every `/system/*` route at the router level with `require_loopback` — closing the trust-boundary gap that PR #81 only patched on `/system/set-env`.

## Commit 1 — `a5560f5` · CI typecheck drift

**Root cause:** `release.yml:98` ran `bunx tsc --noEmit` (no override) while `ci.yml:89` ran `bunx tsc --noEmit --checkJs false`. PRs passed CI; release runs failed the moment a new pre-existing JS-side error landed. v0.3.0 and v0.3.1 release runs broke today.

**Fix:** New `typecheck:ci` script in `frontend/package.json`. Both workflows now call `bun run typecheck:ci` — drift is structurally impossible going forward.

**Files:**
- `frontend/package.json` — add `"typecheck:ci": "tsc --noEmit --checkJs false"`
- `.github/workflows/ci.yml:89` — `bun run typecheck:ci`
- `.github/workflows/release.yml:98` — `bun run typecheck:ci`

**Verification:** `cd frontend && bun run typecheck:ci` → exit 0 (locally, after `bun install`).

## Commit 2 — `b74b51c` · Default bind to loopback

**Root cause:** `backend/main.py:496` used `host="0.0.0.0"` in production. Every router on this process was reachable from the LAN. OmniVoice ships no authentication; the host-side Docker port mapping was the only defence — and only if the user ran under Docker. Bare-metal launches exposed everything by default.

**Fix:** Backend now reads `os.environ.get("OMNIVOICE_BIND_HOST", "127.0.0.1")`. `deploy/docker-compose.yml` sets `OMNIVOICE_BIND_HOST=0.0.0.0` inside both CPU and GPU service blocks so the host-side `127.0.0.1:3900:3900` mapping can forward traffic in — the host mapping is what enforces loopback-only there. README's Docker network-access note expanded to reflect the new override mechanism.

**Files:**
- `backend/main.py` — env-var resolution at the `__main__` uvicorn.run call
- `deploy/docker-compose.yml` — `OMNIVOICE_BIND_HOST=0.0.0.0` added to both services
- `README.md` — Docker section updated
- `tests/test_bind_host.py` (new) — 5 tests:
  1. default-when-unset → `127.0.0.1`
  2. explicit loopback honoured
  3. explicit `0.0.0.0` honoured (Docker path)
  4. source-level guard rejecting any future hardcoded `host="0.0.0.0"` in `uvicorn.run(...)`
  5. source-level guard that `OMNIVOICE_BIND_HOST` reference stays present

**Verification:** `uv run python -m pytest tests/test_bind_host.py -x -q` → 5 passed.

## Commit 3 — `e280734` · Router-level require_loopback

**Root cause:** PR #81 added an inline loopback guard at `/system/set-env` only. The deferred-items file in `.planning/quick/260518-ivy-.../` enumerated 5 sibling POST routes + 4 GET routes on the same router sharing the same defect:

- POST: `/model/unload/{model_id}`, `/system/logs/clear`, `/system/logs/tauri/clear`, `/system/flush-memory`, `/clean-audio`
- GET: `/system/info`, `/system/logs`, `/system/logs/tauri`, `/system/logs/stream`

**Fix:**
- New shared `backend/api/dependencies.py` exposes `require_loopback`.
- `backend/api/routers/system.py` now declares the router with `APIRouter(dependencies=[Depends(require_loopback)])` — one source of truth, every present and future route gated automatically.
- The inline loopback check at `/system/set-env` is removed (redundant). Detail string is now the centralized `"loopback origin required"` (existing tests assert substring `"loopback"`, so they pass unchanged).
- Unused `Request` import dropped.

**Test updates:**
- `tests/test_api.py` `client` fixture now uses `TestClient(app, client=("127.0.0.1", 50000))` so happy-path tests still reach the protected routes.
- `test_set_env_rejects_non_loopback` rewritten — no longer takes the (now-loopback) `client` fixture; builds its own plain `TestClient(app)` to exercise the rejection path.
- New `test_clean_audio_rejects_non_loopback` — samples the previously-open `/clean-audio` POST → 403.
- New `test_system_info_rejects_non_loopback` — samples the previously-leaky `/system/info` GET → 403.
- `tests/test_router_smoke.py` and `tests/smoke/test_boot_smoke.py` fixtures updated to loopback TestClient.

**Verification:**
- `uv run python -m pytest tests/test_api.py -k "loopback or rejects_non" -x -q` → 5 passed.
- `uv run python -m pytest tests/ -q` → 243 passed, 6 skipped, 10 xfailed, 3 xpassed. No new failures.
- `PYTHONPATH=backend uv run python -c "from main import app"` → app imports clean, 150 routes registered.

## Out of scope

- `frontend/media.js:20` hardcoded localhost — Phase 1 plan 01-03 territory.
- Other endpoint routers (`dub_generate.py`, `generation.py`, etc.) — same pattern may apply but only `/system/*` is in this PR's surface.
- Rate-limited LAN access for routes that might legitimately want it (future "control from phone" feature) — defer to the local-token handshake roadmap item.
- Migration tests, ruff/pyright CI gates, community-pr-guard.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Unused `Request` import in `backend/api/routers/system.py`**
- **Found during:** Commit 3, after removing the inline loopback check inside `set_env_var`.
- **Issue:** `Request` was only imported for the inline check; leaving it would surface as a lint warning.
- **Fix:** Dropped `Request` from the `fastapi` import line.
- **Commit:** e280734

**2. [Rule 2 — Critical] Multiple existing test fixtures broken by router-level dependency**
- **Found during:** Commit 3, while running `tests/test_api.py` and discovering `test_model_status`, `test_sysinfo`, `test_router_smoke.py`, `test_boot_smoke.py` would all return 403.
- **Why critical:** A green CI is part of the P0 release-reliability outcome (Commit 1). Shipping Commit 3 with broken existing tests would re-introduce the same release-blocker class.
- **Fix:** Updated the three affected fixtures (`tests/test_api.py::client`, `tests/test_router_smoke.py::client`, `tests/smoke/test_boot_smoke.py::client`) to instantiate `TestClient(app, client=("127.0.0.1", 50000))`. Rewrote `test_set_env_rejects_non_loopback` to build its own plain TestClient since it deliberately needs the non-loopback path.
- **Files modified:** tests/test_api.py, tests/test_router_smoke.py, tests/smoke/test_boot_smoke.py
- **Commit:** e280734

## Self-Check: PASSED

- `backend/api/dependencies.py` — FOUND
- `tests/test_bind_host.py` — FOUND
- `.github/workflows/ci.yml` modified — confirmed by `git show`
- `.github/workflows/release.yml` modified — confirmed
- `frontend/package.json` — `typecheck:ci` script present
- `backend/main.py` — `OMNIVOICE_BIND_HOST` reference present
- `backend/api/routers/system.py` — `APIRouter(dependencies=[Depends(require_loopback)])` present
- `deploy/docker-compose.yml` — `OMNIVOICE_BIND_HOST=0.0.0.0` present in both service blocks
- Commits `a5560f5`, `b74b51c`, `e280734` all present in `git log --oneline -5`
- Tests verified: 243 passed in the full suite; 5 passed in the loopback subset; 5 passed in the bind-host subset.
