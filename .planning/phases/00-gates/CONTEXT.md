# Phase 0: Gates — Context

**Gathered:** 2026-05-16
**Status:** Ready for planning
**Source:** YOLO/auto mode — synthesized from ROADMAP.md, REQUIREMENTS.md, RESEARCH.md, PATTERNS.md (no conversational discuss-phase)

<domain>
## Phase Boundary

Phase 0 is a **hard pre-condition gate** for the entire v0.3.x stabilization milestone. No other phase opens PRs until Phase 0 merges and proves green on `main`.

**What Phase 0 delivers:**

1. A cross-platform CI smoke matrix that boots the Python backend on macOS-14, Windows-2022, and Ubuntu-22.04 on every PR — closing the "Linux-only CI" gap flagged in PITFALLS #10 (the gap that let multiple "stability" PRs ship with macOS/Windows regressions undetected).
2. A frozen, repo-checked-in `tests/fixtures/omnivoice_data/` regression fixture (~100 KB: empty alembic-stamped SQLite + 1 voice profile + 1-second silent WAV) loaded by every PR smoke test — closing PITFALLS #1 (the "fix-causes-regression" cycle that has burned previous stability passes).
3. A release-time installer smoke test that boots the bundled DMG/MSI/AppImage and pings the `/health` endpoint — catching bundle-only regressions that source-run tests miss.
4. SHA-256 checksums published in every GitHub Release body — defends the `xattr -cr` workaround context for #54 and gives a tamper-detect path for the documented-workaround closures.
5. A PR template that documents the two-RC release cadence and the regression-fixture requirement — institutionalizes the gates so they survive turnover.
6. The three open PRs from the project-status report — #51 (cross-platform bug bash), #53 (SRT import), #61 (lazy ASR) — merged before the CI matrix finalizes. (Per `gh pr view`: #53 and #61 already merged; only #51 remains, mergeable, one inconclusive check needing investigation.)

**What Phase 0 does NOT do:**

- Does not close any user-facing issue directly (it enables every downstream phase to do so safely).
- Does not change product behavior — only `.github/workflows/`, `tests/`, `.github/pull_request_template.md`, and `tests/fixtures/omnivoice_data/`.
- Does not introduce new dependencies beyond what `pyproject.toml` already declares (uses pytest, alembic, soundfile — all present).
- Does not redesign the existing test suite (in `tests/`) — it adds a new `tests/smoke/` module and one fixture directory.

</domain>

<decisions>
## Implementation Decisions

All decisions below are **locked** for this phase — derived from PROJECT.md constraints, ROADMAP.md Phase 0 spec, and the convergent recommendations of PATTERNS.md + RESEARCH.md.

### CI matrix (GATE-02)

- **Runner pins:** `macos-14`, `windows-2022`, `ubuntu-22.04` — exact match to the existing `tauri-cross-platform` matrix at `.github/workflows/ci.yml` L108-121 to keep CI/release uniform.
- **Dep install path:** `uv sync` with `uv.lock` (already canonical — `ci.yml` L28-39, `release.yml` L48-58). NO `pip install -r requirements.txt`.
- **Python pin:** 3.11 (matches `.python-version` and existing CI).
- **New job:** `smoke-matrix` — added to `ci.yml` alongside the existing `test` and `tauri-cross-platform` jobs. Does NOT replace the existing Linux-only Python `test` job; runs as a separate matrix with a narrower scope (`tests/smoke/` only).
- **OS-specific setup:** ffmpeg + libsndfile installed per OS (`brew install ffmpeg` macOS / `choco install ffmpeg` Windows / `apt-get install ffmpeg libsndfile1` Linux). Cache `uv` per `uv.lock` hash.

### Frozen fixture (GATE-01)

- **Location:** `tests/fixtures/omnivoice_data/` — NEW directory (`tests/fixtures/` already exists with JSON fixtures; this extends the convention to binary fixtures).
- **Contents:** (a) empty alembic-stamped `omnivoice.db` SQLite (~50 KB), (b) one `voices/test-voice/profile.json` referencing (c) `voices/test-voice/sample.wav` (1-second 24 kHz mono silence, ~48 KB). Total budget: ≤ 200 KB.
- **No Git LFS** — the fixture is intentionally small so every change goes through PR review (which is the point of GATE-01).
- **Build script:** `scripts/seed-test-fixture.py` — reusable Python that produces the fixture deterministically from alembic + soundfile. Committed alongside the fixture. Used both for initial seed and for future fixture-shape updates.
- **`pyproject.toml` `norecursedirs`:** `omnivoice_data` is excluded from test discovery; `tests/fixtures/omnivoice_data/` is outside that exclude path so no conflict.

### Smoke tests (GATE-01 + GATE-02)

- **In-process smoke** (`tests/smoke/test_boot_smoke.py`, NEW): loads the fixture, sets `OMNIVOICE_MODEL=test` to short-circuit model loads (existing pattern from `tests/test_router_smoke.py`), boots backend via FastAPI's `TestClient`, hits `/health` endpoint, asserts 200 + expected payload shape. Runs on all 3 OSes in the new `smoke-matrix` job. Target: < 30 seconds per OS.
- **Pattern to copy:** `tests/test_router_smoke.py` (60 lines, 12 tests) — direct template.
- **Path setup:** Reuse existing `tests/conftest.py` (puts `backend/` on `sys.path`).

### Installer smoke (GATE-03)

- **Where:** New step in `.github/workflows/release.yml`, runs AFTER `tauri-action` builds each platform's installer, BEFORE the release is published.
- **Per-OS approach** (from RESEARCH.md Pattern 3):
  - **macOS:** `hdiutil attach` the DMG, invoke the bundled `OmniVoice Studio.app/Contents/MacOS/OmniVoice Studio` with `--health-check` flag → waits for backend boot → curls `/health` → asserts 200 → kills process → `hdiutil detach`.
  - **Windows:** `msiexec /i /quiet` install MSI, invoke `OmniVoice Studio.exe --health-check` via Git Bash (`shell: bash`), same poll-curl-kill pattern.
  - **Linux:** Extract AppImage with `--appimage-extract`, run binary under `xvfb-run -a` (per RESEARCH.md Pattern 6), same poll-curl-kill.
- **New `--health-check` CLI flag:** Boots backend, prints health endpoint URL, exits 0 if healthy within 60 s, exits non-zero otherwise. Implemented in the existing entrypoint (no new entrypoint file).
- **Timeout:** 60 s per OS. Failure fails the release job (release is NOT published).
- **Reuse:** `scripts/smoke-test.sh` L187-219 has the boot+poll+timeout pattern in shell — port to workflow steps inline rather than calling the script (so failures show in GitHub Actions log).

### Checksum publishing (GATE-05)

- **Tool:** `softprops/action-gh-release@v2` with `append_body: true` — DO NOT fight `tauri-action`'s release body flow. (`gh release edit` REPLACES; `action-gh-release v2 append_body` actually appends. Verified via the action's issue #646.)
- **Format:** **BOTH** a separate `SHA256SUMS` file in the release assets AND inline in the body. Inline gives a glanceable hash next to download links; the file gives a `shasum -c SHA256SUMS` verification path.
- **Compute:** Native OS tools — `shasum -a 256` (POSIX) / `Get-FileHash -Algorithm SHA256` (Windows PowerShell). No third-party marketplace action.

### PR template (GATE-04)

- **File:** `.github/pull_request_template.md` (lowercase — modify in place; renaming to uppercase would orphan review history per the GitHub-naming caveat in PATTERNS.md).
- **Additions:** Append two short sections to the existing template — (a) "Release-cadence note" (we ship `vX.Y-rcN` → 48h soak → promote; merging during a soak requires explicit OK), (b) "Regression-fixture check" (one-line checklist item: "PR smoke test passes on macOS + Windows + Linux").
- **Do NOT redesign** the existing template structure (emoji-prefixed checkboxes + comment placeholders).

### Open-PR landing order (GATE-06)

- **Order verified by `gh pr view`** (not assumed):
  1. #53 (SRT import) — **already merged** per local `gh pr view 53 → MERGED`. Nothing to do.
  2. #61 (lazy-load ASR) — **already merged** per local `gh pr view 61 → MERGED`. Nothing to do.
  3. #51 (cross-platform bug bash) — **still open**, MERGEABLE, one inconclusive check (`SUCCESS` + `null` rollup). Needs the check investigated/re-run, then merge.
- **Interleave:** Land the new `smoke-matrix` job as a NARROW-SCOPE workflow first (only `tests/smoke/` tests, doesn't run against #51's diff). This avoids gating #51 on a CI matrix that #51's changes might break. Then merge #51 (CI now applies). Then any further tightening of the matrix.

### Branch + commit strategy

- **Branch:** Stay on `ai-gsd-setup` for Phase 0's plan/execute. Open Phase 0's PR from `ai-gsd-setup` directly OR cut a child branch `phase-00-gates` from `ai-gsd-setup` — user choice during execution. Either way, do NOT merge to `main` from Claude's session.
- **Atomic commits:** Each requirement (GATE-01..06) gets its own commit per the GSD execution discipline.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents (gsd-planner, gsd-executor) MUST read these before planning / implementing.**

### Phase artifacts
- `.planning/phases/00-gates/RESEARCH.md` — researched implementation patterns + YAML snippets + 9 cited pitfalls + 10 `[ASSUMED]` flags
- `.planning/phases/00-gates/00-PATTERNS.md` — closest in-repo analogs with file paths + line ranges for every new/modified file

### Project-level
- `.planning/PROJECT.md` — milestone framing, constraints, decisions
- `.planning/REQUIREMENTS.md` § "Gates (Phase 0)" — the 6 GATE-* requirements
- `.planning/ROADMAP.md` § Phase 0 — goal, success criteria, hard-gate semantics
- `.planning/research/PITFALLS.md` — esp. #1 (fixture) and #10 (CI gap) which Phase 0 directly addresses

### In-repo analogs (per PATTERNS.md)
- `.github/workflows/ci.yml` — current Python `test` job (L26-59) + `tauri-cross-platform` matrix (L108-174) — analogs for the new `smoke-matrix` job
- `.github/workflows/release.yml` — current build flow (L48-58) — analog for the new installer-smoke step
- `.github/pull_request_template.md` — existing template (38 lines) — extend in place
- `tests/conftest.py` — `sys.path` setup, reuse as-is
- `tests/test_router_smoke.py` — in-process smoke pattern (60 lines, 12 tests) — copy-paste template for `tests/smoke/test_boot_smoke.py`
- `tests/test_api.py` L31-41 — WAV-generation helper for the fixture's silent sample
- `backend/main.py` L379-389 — `/health` endpoint (the smoke target)
- `scripts/smoke-test.sh` L187-219 — shell boot+poll+timeout pattern — port to workflow YAML
- `scripts/desktop-prod.sh` — current production-launch reference
- `backend.spec` L132 — ships `backend/migrations/` so alembic is available in the bundle; same path for fixture-DB build
- `pyproject.toml` L71 (alembic), L173-183 (`norecursedirs`) — fixture-build deps + non-conflict check
- `omnivoice_data/omnivoice.db` — schema reference (4 tables: voice_profiles, generation_history, dub_history, studio_projects) — fixture derives from this shape

</canonical_refs>

<specifics>
## Specific Implementation Notes (from RESEARCH.md)

- **Action pins (do NOT use `@latest`):** `actions/checkout@v4`, `astral-sh/setup-uv@v3`, `actions/setup-python@v5`, `softprops/action-gh-release@v2`, `coactions/setup-xvfb@v2`. `awalsh128/cache-apt-pkgs-action@latest` is currently pinned to `@latest` in `ci.yml` — RESEARCH.md flagged this as a security pitfall but explicitly OUT OF SCOPE for Phase 0 (don't conflate with this phase).
- **Caching:** `astral-sh/setup-uv@v3` natively supports `enable-cache: true` with `cache-dependency-glob: "uv.lock"` — use this rather than rolling a custom `actions/cache` config.
- **xvfb on Linux:** Use `coactions/setup-xvfb@v2` action wrapper rather than `xvfb-run -a` directly (handles the `DISPLAY` env var lifecycle cleanly).
- **`/health` endpoint contract** (from `backend/main.py` L379-389): expects `GET /health` → `200 OK` with JSON `{"status": "ok", ...}`. Smoke test asserts on status code + the `status` key.
- **`OMNIVOICE_MODEL=test` env var:** Existing convention to short-circuit heavy model loading at boot (per `tests/test_router_smoke.py`). Required for smoke tests to run in < 30s per OS without downloading multi-GB models.

</specifics>

<deferred>
## Deferred Ideas (NOT in Phase 0)

These came up in research but are explicitly out of scope:

- **`awalsh128/cache-apt-pkgs-action@latest` → pinned version** — RESEARCH.md security flag, but it's an existing repo issue not introduced by Phase 0. Tracking issue should be filed separately.
- **Extending `release.yml` `test` job to cross-OS** — RESEARCH.md recommended NO (out of GATE-02 scope; that job's purpose is different).
- **Model-based singing-vs-speech classifier, fancier fixture generators, Tauri sidecar lifecycle audit on macOS-headless** — all deferred to their respective phases.
- **First-PR red rate after Phase 0 lands** — RESEARCH.md predicts 30-50% red rate as previously-untested OS regressions surface. Frame as "regression budget" in the Phase 0 PR description so reviewers expect it; don't let it block the merge.

</deferred>

---

*Phase: 00-gates*
*Context gathered: 2026-05-16 via YOLO auto-mode synthesis (no conversational discuss-phase)*
