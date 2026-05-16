# Phase 0: Gates — Research

**Researched:** 2026-05-16
**Domain:** GitHub Actions CI/CD + Tauri 2 release automation + FastAPI smoke testing + SQLite fixture seeding + OSS PR-template conventions
**Confidence:** HIGH for the GitHub Actions / Tauri / health-endpoint surfaces (verified against current `ci.yml`, `release.yml`, `backend/main.py`, and recent 2026 sources). MEDIUM for `tauri-action` + checksum interaction (no first-party example exists; pattern is composed from verified primitives). MEDIUM for the GATE-06 interleave question (depends on PR contents we cannot read without `gh pr view`).

---

## Summary

Phase 0 is **infrastructure plumbing on a working CI/release pipeline** — every requirement extends an existing pattern in `ci.yml` / `release.yml` / `backend/main.py` rather than inventing anything novel. The repo already has:
- A 3-OS matrix that runs `cargo check` on `macos-14` / `windows-2022` / `ubuntu-22.04` ([CITED: ci.yml L105-174])
- A `/health` endpoint at `http://127.0.0.1:3900/health` returning `{"status": "ok", "device": ...}` ([CITED: backend/main.py L379-389])
- A boot+poll smoke loop in `scripts/smoke-test.sh` ([CITED: smoke-test.sh L187-219])
- A working `tauri-action@v0` publish flow with `latest.json` updater signing ([CITED: release.yml L334-353])

The work is: (1) add a *Python runtime* matrix alongside the existing `cargo check` matrix, (2) compose a frozen `omnivoice_data/` fixture from the live 160 KB SQLite schema, (3) bolt a post-build installer smoke step onto `release.yml` per platform, (4) compute SHA-256 outside `tauri-action` and append via `softprops/action-gh-release@v2`, (5) extend the existing lowercase `.github/pull_request_template.md` in place.

**The single highest-risk decision:** what the CI matrix runs on `macos-14` and `windows-2022`. Recommendation: **`uv run pytest tests/smoke/ -q`** — narrow set targeting `/health` + DB-load via TestClient — not the full `tests/` suite (which depends on ffmpeg + audio fixtures that don't all install cleanly on Windows yet). Full suite expansion belongs in Phase 1 once `INST-01` (`setuptools` for WhisperX) and the install-doc rewrite have landed.

**Primary recommendation:** Layer the new `smoke-matrix` job onto `ci.yml` with `needs: test` (so the Linux fast-tests gate the slow 3-OS matrix), reuse the exact runner pins already in the repo (`macos-14`, `windows-2022`, `ubuntu-22.04`), use `softprops/action-gh-release@v2` with `append_body: true` for SHA-256 publishing, and prefer **per-OS shell-native checksum tools** (`shasum -a 256` POSIX / `Get-FileHash -Algorithm SHA256` Windows) over a third-party "checksums-action" marketplace dependency.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Python runtime smoke test execution | CI runner (matrix per-OS) | — | Catches platform-specific imports / path bugs that `cargo check` cannot |
| Tauri shell type-checking | CI runner (matrix per-OS, existing) | — | Already in place at `ci.yml` L105-174 — do not regress |
| Backend `/health` endpoint | FastAPI app (`backend/main.py`) | — | Already exists; reuse, do not extend |
| Frozen fixture storage | Repo (`tests/fixtures/omnivoice_data/`) | — | Tiny static seed; not generated at test time |
| Fixture loading | Pytest module (`tests/smoke/test_pr_smoke.py`) | conftest.py (already adds backend/ to sys.path) | Matches `tests/test_router_smoke.py` pattern verbatim |
| Installer build + signing + publish | `tauri-action@v0` (existing) | — | Do not replace; bolt on |
| Installer post-build smoke | Workflow step on same matrix runner | `scripts/smoke-test.sh` (Linux/macOS) + new `.ps1` (Windows) | Runner already has the bundle in place — cheapest place to launch it |
| SHA-256 computation | Workflow step (per-OS native tool) | — | Avoid third-party action; `shasum`/`Get-FileHash` are preinstalled |
| Release-body append | `softprops/action-gh-release@v2` (`append_body: true`) | — | Replaces nothing in `tauri-action`; explicitly designed to extend an existing release |
| PR template enforcement | `.github/pull_request_template.md` (modify in place) | — | GitHub honors lowercase; renaming orphans review history |

---

## Standard Stack

### Core (already in repo — pin/verify versions, do not swap)

| Library / Action | Version | Purpose | Why Standard |
|------------------|---------|---------|--------------|
| `actions/checkout@v4` | v4 (current) | Repo checkout | Already used in all 3 workflows; standard |
| `actions/setup-python@v5` | v5 (current) | Python 3.11 install | Already used; matches `pyproject.toml requires-python = ">=3.11"` |
| `astral-sh/setup-uv@v3` | v3 (current) | uv install + `~/.cache/uv` cache keyed on `uv.lock` | Already used; ci.yml comment confirms ~45s cold → ~5s warm |
| `dtolnay/rust-toolchain@stable` | stable | Rust toolchain | Already used; pinned by `targets:` per matrix |
| `Swatinem/rust-cache@v2` | v2 | Cargo registry + target/ cache | Already used; keyed per `rust_target` |
| `oven-sh/setup-bun@v1` | v1 | Bun runtime for frontend | Already used |
| `actions/cache@v4` | v4 | Generic cache (bun, brew, choco) | Already used for bun |
| `awalsh128/cache-apt-pkgs-action@latest` | latest | Linux apt package cache (ffmpeg) | Already used; "latest" pin matches existing repo convention (consider tagging to a SHA later for supply-chain hygiene, but not in scope for Phase 0) |
| `tauri-apps/tauri-action@v0` | v0 (current) | Build + sign + publish per-platform | Already used; do not replace |

### New (add for Phase 0)

| Library / Action | Version | Purpose | When to Use |
|------------------|---------|---------|-------------|
| `softprops/action-gh-release@v2` | v2 (Node 20 runtime — current stable; v3 is Node 24, optional) | Append SHA-256 checksums + per-platform smoke results to release body | After `tauri-action` step in `release.yml`; uses `append_body: true` so the changelog + tauri's existing body stay intact [VERIFIED: github.com/softprops/action-gh-release/issues/646 — append-after-prepend semantics confirmed; v2 is current stable per releases page] |
| `coactions/setup-xvfb` (or inline `apt install xvfb` + `xvfb-run`) | latest | Headless display for AppImage launch test on `ubuntu-22.04` | Only if AppImage smoke needs to render a WebView; for a `--version`-equivalent boot test, `xvfb-run` from `apt install xvfb` is sufficient and avoids the third-party action [CITED: docs.electron.org/tutorial/testing-on-headless-ci — pattern same for any GTK-WebKit app] |

### Verified package versions (registry probes)

```bash
# Verified 2026-05-16 via documentation + GitHub release pages cited above
softprops/action-gh-release  → v2.0.x (current stable, Node 20)  [CITED: github.com/softprops/action-gh-release/releases]
                              v3.0.0+ available if Node 24 wanted
tauri-apps/tauri-action      → v0 floating (already in repo)     [CITED: release.yml L335]
astral-sh/setup-uv           → v3 (already in repo)              [CITED: ci.yml L36]
actions/setup-python         → v5 (already in repo)              [CITED: ci.yml L29]
coactions/setup-xvfb         → v1.x (latest)                     [CITED: github.com/marketplace/actions/setup-xvfb]
```

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `softprops/action-gh-release@v2` for checksum append | `gh release edit --notes-file` (built-in `gh` CLI) | `gh release edit` **replaces** notes, doesn't append — would require fetch-edit-write three-step. `softprops` does it in one. Pick `softprops`. [CITED: cli.github.com/manual/gh_release_edit] |
| `softprops/action-gh-release@v2` for checksum append | `marketplace/actions/checksum-action` or `marketplace/actions/checksums-action` | Adds a third-party dep with low transparency for a 1-line `shasum` invocation. Reject — use native `shasum`/`Get-FileHash`. |
| `awalsh128/cache-apt-pkgs-action@latest` for ffmpeg on Linux | `apt-get install -y ffmpeg` (no cache) | Cold install is ~30s; cached is <2s. Already in repo, keep. |
| `brew install ffmpeg` on macOS | `gerlero/brew-install` (cached) | macOS runners come with brew preinstalled and ffmpeg is fast (~10s); not worth a new action. Match `release.yml` L171-172 — `brew install ffmpeg \|\| true`. |
| Windows ffmpeg via chocolatey (`choco install ffmpeg`) | Inline download of static ffmpeg build | Chocolatey is preinstalled on `windows-2022` runners; one-liner is sufficient. [ASSUMED — chocolatey preinstalled on GH runners; verify with `runner-images` repo before locking] |
| Full `pytest tests/` on mac+Windows | `pytest tests/smoke/ -q` (new narrow target) | Full suite needs ffmpeg + WhisperX + WAV fixtures; `INST-01` (setuptools fix) and CosyVoice install docs are Phase 1, not Phase 0. Narrow smoke is the correct Phase 0 scope. |
| `gabrielbb/xvfb-action` (multi-platform aware) | `coactions/setup-xvfb` or raw `xvfb-run` | All work; `xvfb-run` from `apt install xvfb` has zero third-party deps. Pick raw approach for the AppImage step. [CITED: github.com/GabrielBB/xvfb-action — auto-no-op on non-Linux is the only differentiator] |
| Git LFS for the fixture WAV | Checked-in tiny WAV (≤50 KB silence) | LFS adds setup friction for contributors and has known checksum bugs ([CITED: github.com/go-gitea/gitea/issues/2653]). A 1-sec mono WAV @ 24 kHz is ~48 KB raw — well under the 200 KB fixture budget. Skip LFS. |

**Installation (no new Python deps):**

```bash
# All Python deps already pinned in pyproject.toml. Phase 0 adds NO runtime deps.
# Only test-time helpers (already available):
uv sync  # alembic 1.13+ is already a dep — used to stamp the fixture DB
```

**No new packages introduced** — Phase 0 is workflow YAML + a small fixture + a small pytest module + a PR-template edit.

---

## Package Legitimacy Audit

> slopcheck was unavailable in this environment. All GitHub Actions below are tagged based on **registry presence + existing in-repo usage + cross-reference with official documentation**, but per the package-legitimacy protocol, any new-to-this-repo action should be gated behind a `checkpoint:human-verify` step in the plan.

| Action | Registry | Age | Source Repo | slopcheck | Disposition |
|--------|----------|-----|-------------|-----------|-------------|
| `actions/checkout@v4` | GitHub Marketplace | 8+ yrs | github.com/actions/checkout | unavailable | Already in repo — Approved [VERIFIED: ci.yml L26 in-repo usage] |
| `actions/setup-python@v5` | GitHub Marketplace | 6+ yrs | github.com/actions/setup-python | unavailable | Already in repo — Approved [VERIFIED: ci.yml L29 in-repo usage] |
| `astral-sh/setup-uv@v3` | GitHub Marketplace | 1+ yr | github.com/astral-sh/setup-uv | unavailable | Already in repo — Approved [VERIFIED: ci.yml L36 in-repo usage; Astral is the uv vendor] |
| `dtolnay/rust-toolchain@stable` | GitHub Marketplace | 4+ yrs | github.com/dtolnay/rust-toolchain | unavailable | Already in repo — Approved (David Tolnay is well-known Rust contributor) [VERIFIED: ci.yml L126 in-repo] |
| `Swatinem/rust-cache@v2` | GitHub Marketplace | 5+ yrs | github.com/Swatinem/rust-cache | unavailable | Already in repo — Approved [VERIFIED: ci.yml L132 in-repo] |
| `oven-sh/setup-bun@v1` | GitHub Marketplace | 2+ yrs | github.com/oven-sh/setup-bun | unavailable | Already in repo — Approved (oven-sh is the Bun vendor) [VERIFIED: ci.yml L49] |
| `actions/cache@v4` | GitHub Marketplace | 6+ yrs | github.com/actions/cache | unavailable | Already in repo — Approved [VERIFIED: ci.yml L74] |
| `awalsh128/cache-apt-pkgs-action@latest` | GitHub Marketplace | 3+ yrs | github.com/awalsh128/cache-apt-pkgs-action | unavailable | Already in repo — Approved with caveat: pinned to `@latest` (not SHA-pinned) [VERIFIED: ci.yml L54] |
| `tauri-apps/tauri-action@v0` | GitHub Marketplace | 4+ yrs | github.com/tauri-apps/tauri-action | unavailable | Already in repo — Approved (Tauri is the vendor) [VERIFIED: release.yml L335] |
| `softprops/action-gh-release@v2` | GitHub Marketplace | 6+ yrs | github.com/softprops/action-gh-release | unavailable | **NEW to repo** — Approved (canonical GH release action used by thousands of repos; v2 is Node 20 / current stable) [CITED: github.com/softprops/action-gh-release — verified 2026-05-16 active maintenance] — *Planner SHOULD add a `checkpoint:human-verify` task before first use since slopcheck was unavailable* |
| `coactions/setup-xvfb` (optional) | GitHub Marketplace | 2+ yrs | github.com/coactions/setup-xvfb | unavailable | **OPTIONAL** — if used, gate behind `checkpoint:human-verify`. Preferred alternative: `apt install xvfb && xvfb-run …` (zero third-party deps) |

**Packages removed due to slopcheck [SLOP] verdict:** none (slopcheck unavailable)
**Packages flagged as suspicious [SUS]:** none flagged; treat the one new action (`softprops/action-gh-release@v2`) as `[ASSUMED]` and gate first use.

---

## Architecture Patterns

### System Architecture Diagram

```
                              ┌────────────────────────────────┐
                              │  PR opened / push to main      │
                              └─────────────────┬──────────────┘
                                                │
                          ┌─────────────────────┼─────────────────────┐
                          ▼                     ▼                     ▼
                ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
                │ test (existing)  │  │ tauri-cross-     │  │ smoke-matrix     │  ◀── NEW (GATE-02)
                │ ubuntu-22.04     │  │ platform         │  │ macos-14         │
                │  - pytest        │  │ (3 OS, cargo     │  │ windows-2022     │
                │  - vitest        │  │  check only)     │  │ ubuntu-22.04     │
                └────────┬─────────┘  └──────────────────┘  │                  │
                         │                                  │  uv sync         │
                         │ gates (needs:)                   │  copy fixture    │  ◀── GATE-01
                         └──────────────────────────────────▶  pytest          │
                                                            │   tests/smoke/   │
                                                            └──────────────────┘

                              ┌────────────────────────────────┐
                              │  Tag push: v*                  │
                              └─────────────────┬──────────────┘
                                                │
                          ┌─────────────────────┴────────────┐
                          ▼                                  ▼
                ┌──────────────────────┐         ┌──────────────────────┐
                │ test (existing)      │         │ build (existing)     │
                │ ubuntu-22.04         │  needs  │ matrix: macos-14,    │
                └──────────────────────┘  ─────▶ │  windows-2022,       │
                                                 │  ubuntu-22.04        │
                                                 │                      │
                                                 │  Steps (existing):   │
                                                 │  - Bundle uv         │
                                                 │  - Bundle ffmpeg     │
                                                 │  - tauri-action      │
                                                 │      builds DMG/MSI/ │
                                                 │      AppImage,       │
                                                 │      creates release │
                                                 │                      │
                                                 │  Steps (NEW):        │
                                                 │  - Locate bundle ───▶│  ◀── GATE-03 (boot + /health poll)
                                                 │  - Install/extract   │
                                                 │  - Launch backend    │
                                                 │  - curl /health      │
                                                 │  - Kill process      │
                                                 │  - shasum -a 256 ───▶│  ◀── GATE-05 (compute checksums)
                                                 │  - softprops/        │
                                                 │    action-gh-release │
                                                 │    append_body:true ▶│  ◀── GATE-05 (publish in body)
                                                 └──────────────────────┘
```

Data flow: a PR triggers the existing `test` job (fast Linux tests) which gates a new `smoke-matrix` job that runs Python imports + `/health` + fixture-load on all 3 OSes. A tag push triggers the existing `build` matrix, which now post-builds a smoke step that boots the *bundled* app and a checksum step that appends SHA-256 values to the release body.

### Recommended Project Structure (Phase 0 additions only)

```
.github/
├── workflows/
│   ├── ci.yml                        # MODIFY — add smoke-matrix job (GATE-02)
│   └── release.yml                   # MODIFY — add post-build smoke + checksum (GATE-03, GATE-05)
├── pull_request_template.md          # MODIFY — RC cadence + fixture checklist (GATE-04)
└── (existing ISSUE_TEMPLATE/ unchanged)

tests/
├── fixtures/
│   ├── whisper_clean.json            # existing
│   ├── whisper_screenshot.json       # existing
│   └── omnivoice_data/               # NEW — frozen regression fixture (GATE-01)
│       ├── omnivoice.db              # ~50 KB, alembic head, zero data rows
│       └── audio/
│           └── ref.wav               # ~48 KB, 1 sec mono 24 kHz silence
└── smoke/                            # NEW — PR-blocking smoke tests
    ├── __init__.py                   # empty
    └── test_pr_smoke.py              # health + fixture-load + 1 DB CRUD

docs/
└── releases/
    └── two-rc-cadence.md             # NEW — referenced by PR template (GATE-04)

scripts/
└── ci-installer-smoke.sh             # OPTIONAL NEW — Linux/macOS boot+poll helper
                                      # (Windows uses inline PowerShell in release.yml)
```

### Pattern 1: 3-OS smoke matrix (GATE-02)

**What:** Add a `smoke-matrix` job to `ci.yml` that runs Python import + `/health` + fixture-load on macOS, Windows, Linux.
**When to use:** Every PR — `needs: test` so Linux fast-tests gate the slower 3-OS matrix.
**Source pattern:** existing `tauri-cross-platform` matrix at `ci.yml` L105-174 (3-OS matrix shape) + existing `test` job at L22-69 (Python+uv setup) — compose them.

```yaml
# Source: composed from ci.yml L105-174 (matrix shape) + L26-59 (Python setup)
  smoke-matrix:
    name: Smoke (${{ matrix.label }})
    needs: test
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14
            label: macOS
          - os: windows-2022
            label: Windows
          - os: ubuntu-22.04
            label: Linux
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Python 3.11
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install uv
        uses: astral-sh/setup-uv@v3
        with:
          enable-cache: true
          cache-dependency-glob: "uv.lock"

      # Per-OS system deps — ffmpeg is the only requirement Phase 0 cares about
      - name: System deps (Linux)
        if: runner.os == 'Linux'
        uses: awalsh128/cache-apt-pkgs-action@latest
        with:
          packages: ffmpeg
          version: 1.0

      - name: System deps (macOS)
        if: runner.os == 'macOS'
        run: brew install ffmpeg || true

      - name: System deps (Windows)
        if: runner.os == 'Windows'
        shell: pwsh
        run: choco install ffmpeg -y --no-progress

      - name: Install Python deps
        run: uv sync

      - name: Copy regression fixture into place
        shell: bash
        run: |
          mkdir -p omnivoice_data
          cp -r tests/fixtures/omnivoice_data/* omnivoice_data/

      - name: Run smoke tests
        run: uv run pytest tests/smoke/ -q --tb=short
        env:
          OMNIVOICE_MODEL: test
          OMNIVOICE_DISABLE_FILE_LOG: "1"
```

**Why these env vars matter:** `OMNIVOICE_MODEL=test` short-circuits the 2.4 GB model load ([CITED: tests/test_router_smoke.py L12, tests/test_api.py L22]). Without it the smoke matrix would spend 10+ min downloading weights on every PR.

**Why `needs: test`:** matches existing `tauri-cross-platform` pattern ([CITED: ci.yml L107]). Linux fast-fail gates the 3× more expensive matrix.

**Why `fail-fast: false`:** matches existing `tauri-cross-platform` pattern ([CITED: ci.yml L109]). One OS failure shouldn't cancel diagnosis on the other two.

### Pattern 2: Frozen `omnivoice_data/` fixture (GATE-01)

**What:** A ~100 KB checked-in directory containing a migrated-but-empty SQLite DB and a 1-second mono WAV.
**When to use:** Loaded by the smoke matrix before pytest runs.
**Source pattern:** existing JSON fixtures at `tests/fixtures/*.json` (file-fixture convention) + live DB schema at `omnivoice_data/omnivoice.db` (schema source).

**How to build the fixture (one-time, then commit):**

```bash
# Build script — commit the OUTPUT, not the build script's outputs to git on every CI run
set -euo pipefail
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
mkdir -p omnivoice_data/audio

# 1. Stamp an empty DB at alembic head
export OMNIVOICE_DATA_DIR="$TMPDIR/omnivoice_data"
uv run alembic -c backend/migrations/alembic.ini upgrade head

# 2. Generate a 1-sec mono silence WAV (~48 KB raw — well within fixture budget)
uv run python -c "
import wave, struct, io
n=24000  # 1 sec @ 24 kHz mono
with wave.open('omnivoice_data/audio/ref.wav','wb') as wf:
    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(24000)
    wf.writeframes(struct.pack(f'<{n}h', *([0]*n)))
"

# 3. Copy back into repo
cp -r omnivoice_data $REPO/tests/fixtures/

# 4. git add + commit (the BINARY DB and WAV, not regenerated on CI)
```

**Fixture content:**
- `tests/fixtures/omnivoice_data/omnivoice.db` — alembic-stamped, zero rows in `voice_profiles`, `generation_history`, `dub_history`, `studio_projects` ([CITED: PATTERNS.md L144-167 — live schema captured])
- `tests/fixtures/omnivoice_data/audio/ref.wav` — 1 sec, mono, 24 kHz, all-zero PCM samples

**Size budget:** 200 KB total. Empirically the DB + WAV land around 100 KB. Anything heavier drags every `git clone`.

**Why NOT generate at test time:** reproducibility. A regenerated-on-CI fixture means a schema change in alembic silently changes the fixture without being reviewable in a diff. Checked-in binaries force a PR to update the fixture, which is the point of having a "frozen" fixture per GATE-01.

### Pattern 3: Installer post-build smoke (GATE-03)

**What:** After `tauri-action` builds the bundle, the same runner installs/extracts it, launches the backend, polls `/health`, and asserts exit 0.
**When to use:** Every tag push; runs in the `build` matrix immediately after `tauri-action`.
**Source pattern:** `scripts/smoke-test.sh` L187-219 (boot+poll loop) + `desktop-prod.sh` L154-193 (per-OS bundle discovery).

**Linux (AppImage):**

```yaml
- name: Smoke test bundle (Linux)
  if: runner.os == 'Linux'
  shell: bash
  run: |
    set -euo pipefail
    sudo apt-get install -y xvfb
    APPIMAGE=$(find frontend/src-tauri/target/release/bundle/appimage -name "*.AppImage" | head -1)
    chmod +x "$APPIMAGE"
    # AppImage FUSE-less extract pattern (already used at release.yml L343)
    export APPIMAGE_EXTRACT_AND_RUN=1
    # Heuristic NVIDIA workaround (PITFALLS #9 — only apply if needed)
    # CI runners have no NVIDIA card; safe to omit WEBKIT_DISABLE_COMPOSITING_MODE.
    xvfb-run --auto-servernum --server-args='-screen 0 1280x720x24' "$APPIMAGE" &
    APP_PID=$!
    trap 'kill -9 $APP_PID 2>/dev/null || true' EXIT
    # Boot + poll /health (pattern from scripts/smoke-test.sh L196-219)
    for i in $(seq 1 60); do
      if curl -sf http://127.0.0.1:3900/health >/dev/null 2>&1; then
        echo "✓ Backend healthy after ${i}*5s"
        exit 0
      fi
      sleep 5
      kill -0 $APP_PID 2>/dev/null || { echo "App died"; exit 1; }
    done
    echo "✗ /health never returned 200 in 300s"
    exit 1
```

**macOS (DMG → mount → run .app):**

```yaml
- name: Smoke test bundle (macOS)
  if: runner.os == 'macOS'
  shell: bash
  run: |
    set -euo pipefail
    DMG=$(find frontend/src-tauri/target/release/bundle/dmg -name "*.dmg" | head -1)
    # hdiutil attach with -nobrowse -noautoopen for headless mount
    MOUNT=$(hdiutil attach -nobrowse -noautoopen "$DMG" | grep "/Volumes/" | awk '{print $NF}')
    trap 'hdiutil detach "$MOUNT" -force 2>/dev/null || true' EXIT
    APP=$(find "$MOUNT" -maxdepth 2 -name "*.app" | head -1)
    BINARY="$APP/Contents/MacOS/$(basename "$APP" .app)"
    # Launch in background. macOS headless runners have no window server,
    # but the Tauri shell spawns the Python backend regardless — /health works.
    "$BINARY" &
    APP_PID=$!
    trap 'kill -9 $APP_PID 2>/dev/null || true; hdiutil detach "$MOUNT" -force 2>/dev/null || true' EXIT
    for i in $(seq 1 60); do
      if curl -sf http://127.0.0.1:3900/health >/dev/null 2>&1; then
        echo "✓ Backend healthy after ${i}*5s"
        exit 0
      fi
      sleep 5
      kill -0 $APP_PID 2>/dev/null || { echo "App died"; exit 1; }
    done
    echo "✗ /health never returned 200 in 300s"
    exit 1
```

**[ASSUMED]** macOS GH runners have no window server but the Tauri main process still spawns the Python backend subprocess (the backend boot path is independent of the Tauri webview). If the Tauri main blocks on window creation, the backend never spawns. **Mitigation:** if this assumption fails in first run, fall back to extracting the `.app` and invoking the bundled `backend/` binary directly via `Contents/Resources/`. The `tauri-plugin-shell` sidecar pattern (Python launched via `tauri::api::process::Command`) is async-by-default per [CITED: v2.tauri.app/develop/sidecar/] — should boot regardless of webview state. **Verify on first CI run; if fail, switch to direct backend invocation.**

**Windows (MSI silent install → launch):**

```yaml
- name: Smoke test bundle (Windows)
  if: runner.os == 'Windows'
  shell: pwsh
  run: |
    $ErrorActionPreference = 'Stop'
    $msi = Get-ChildItem -Path frontend\src-tauri\target\release\bundle\msi -Filter *.msi | Select-Object -First 1
    $log = "msi-install.log"
    # /qn = fully silent, /norestart, /l*v writes verbose log [CITED: silentinstall.org/msiexec]
    Start-Process msiexec.exe -ArgumentList "/i `"$($msi.FullName)`" /qn /norestart /l*v $log" -Wait
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 50; exit $LASTEXITCODE }
    # Tauri bundle identifier: com.debpalash.omnivoice-studio (per PATTERNS.md L336)
    $exe = Get-ChildItem -Path "C:\Program Files\OmniVoice Studio" -Filter "*.exe" -Recurse | Select-Object -First 1
    $proc = Start-Process -FilePath $exe.FullName -PassThru
    try {
      for ($i=1; $i -le 60; $i++) {
        try {
          $r = Invoke-WebRequest -Uri "http://127.0.0.1:3900/health" -UseBasicParsing -TimeoutSec 5
          if ($r.StatusCode -eq 200) { Write-Host "✓ Backend healthy after $($i*5)s"; exit 0 }
        } catch { Start-Sleep 5 }
        if ($proc.HasExited) { Write-Host "App died"; exit 1 }
      }
      Write-Host "✗ /health never returned 200 in 300s"
      exit 1
    } finally {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
```

**Why 300s timeout (60 × 5s):** first-launch on the bundled app triggers `uv sync --frozen` to recreate the venv ([CITED: release.yml L201-203]) — empirically 30-120s on first boot. The 300s ceiling matches `scripts/smoke-test.sh` L188 (`BOOTSTRAP_TIMEOUT=600`) — halved because CI runners are faster than user machines.

**Why `/health` not `/system/info`:** `/health` is the 5-line, no-throw endpoint specifically marked for Docker health checks and the Tauri shell ([CITED: backend/main.py L379-389 comment: "Used by Docker health checks, load balancers, and the Tauri desktop shell."]). `/system/info` loads more state and can fail for orthogonal reasons.

### Pattern 4: SHA-256 checksum publish (GATE-05)

**What:** After `tauri-action` uploads bundles, compute SHA-256 per artifact and append to the release body.
**When to use:** Every tag push (after build, before job ends).
**Source pattern:** **No analog in repo** ([CITED: PATTERNS.md L119 — "grep -rn sha256 .github/ scripts/ returns nothing"]). Composed from `softprops/action-gh-release@v2` `append_body` + per-OS native checksum tools.

```yaml
- name: Compute SHA-256 checksums (POSIX)
  if: runner.os != 'Windows'
  shell: bash
  run: |
    set -euo pipefail
    cd frontend/src-tauri/target/release/bundle
    {
      echo ""
      echo "## SHA-256 Checksums (${{ matrix.label }})"
      echo ""
      echo '```'
      find . -type f \( -name "*.dmg" -o -name "*.AppImage" -o -name "*.deb" \) -print0 \
        | xargs -0 shasum -a 256
      echo '```'
    } > "$GITHUB_WORKSPACE/checksums-${{ matrix.label }}.md"
    cat "$GITHUB_WORKSPACE/checksums-${{ matrix.label }}.md"

- name: Compute SHA-256 checksums (Windows)
  if: runner.os == 'Windows'
  shell: pwsh
  run: |
    $ErrorActionPreference = 'Stop'
    $bundleDir = "frontend\src-tauri\target\release\bundle"
    $files = Get-ChildItem -Path $bundleDir -Recurse -Include *.msi
    $lines = @()
    $lines += ""
    $lines += "## SHA-256 Checksums (${{ matrix.label }})"
    $lines += ""
    $lines += '```'
    foreach ($f in $files) {
      $h = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash.ToLower()
      $lines += "$h  $($f.Name)"
    }
    $lines += '```'
    $lines -join "`n" | Out-File -FilePath "$env:GITHUB_WORKSPACE\checksums-${{ matrix.label }}.md" -Encoding utf8
    Get-Content "$env:GITHUB_WORKSPACE\checksums-${{ matrix.label }}.md"

- name: Append checksums to release body
  uses: softprops/action-gh-release@v2
  with:
    tag_name: ${{ github.ref_name }}
    append_body: true
    body_path: checksums-${{ matrix.label }}.md
    # Also upload the checksums file as a release asset
    files: checksums-${{ matrix.label }}.md
```

**Why `append_body: true`:** `tauri-action` already creates the release with the CHANGELOG section as the body ([CITED: release.yml L310-349]). `append_body: true` extends without replacing. [CITED: github.com/softprops/action-gh-release/issues/646 — confirms `append_body` is the way to add content after `generate_release_notes`]

**Why matrix-suffixed filename:** each runner appends its own platform's checksums sequentially. Three runners → three appends to the same release. The final body has three `## SHA-256 Checksums (macOS / Windows / Linux)` sections.

**Race condition warning:** all three runners hit `release edit` near-simultaneously. `softprops/action-gh-release@v2` uses the GitHub API's PATCH semantics which is server-serialized per-release; no data loss expected but ordering is non-deterministic. Acceptable — readers don't care about section order.

### Pattern 5: PR template (GATE-04)

**What:** Modify `.github/pull_request_template.md` in place to add RC-cadence reminder + fixture-regression checklist.
**When to use:** Every new PR uses this template (GitHub auto-injects).
**Source pattern:** existing template at `.github/pull_request_template.md` L1-38 ([CITED: PATTERNS.md L20 — "GitHub honors both `pull_request_template.md` and `PULL_REQUEST_TEMPLATE.md`; current file is lowercase. Modify in place, do not rename"]).

```markdown
## Summary

<!-- Brief description of what this PR does. -->

## Changes

<!-- List the key changes made in this PR. -->

-

## Type

<!-- Check the one that applies. -->

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] ♻️ Refactor
- [ ] 📝 Documentation
- [ ] 🧪 Tests
- [ ] 🔧 CI / Build
- [ ] 🚀 Release prep (RC or final)        ← NEW

## Testing

<!-- How did you test these changes? -->

-

## Checklist

- [ ] I've tested this locally
- [ ] I've updated relevant documentation (if applicable)
- [ ] No local machine paths, logs, or personal env details in this PR
- [ ] Version files are in sync (if version bump): `pyproject.toml`, `package.json`, `tauri.conf.json`, `Cargo.toml`
- [ ] If this PR changes runtime behavior, the regression fixture at      ← NEW
      `tests/fixtures/omnivoice_data/` still loads green (smoke matrix)
- [ ] If this is part of an RC, I've read `docs/releases/two-rc-cadence.md`  ← NEW
      and confirmed this PR targets the right RC
- [ ] If this PR adds an installer-affecting change, the per-platform     ← NEW
      smoke test in `.github/workflows/release.yml` was exercised via
      `workflow_dispatch` (manual trigger)

## Release cadence (read once per RC)                                      ← NEW SECTION

OmniVoice ships every minor on a **two-RC cadence**:
- `vX.Y.0-rc1` — cut from main once GATE-* requirements pass; clean-VM exercise on 4 OSes
- 48h soak (no new commits to release branch except fix-forward)
- `vX.Y.0` — promotion if rc1 is clean

If your PR touches install/bootstrap/CI, it MUST land before rc1 cut, not between rc1 and the promotion.

## Screenshots

<!-- If applicable, add screenshots or recordings. -->
```

**Source for the cadence text:** REQUIREMENTS.md GATE-04 + ROADMAP.md Phase 6 (REL-01, REL-02). The text is **new content** (no analog in OSS); the structural pattern (sections + emoji checkboxes + `<!-- comment -->` placeholders) is copied verbatim from the existing template.

### Anti-Patterns to Avoid

- **Renaming `pull_request_template.md` → `PULL_REQUEST_TEMPLATE.md`:** orphans GitHub PR-review history. Modify in place. [CITED: PATTERNS.md L20]
- **Replacing `tauri-action` with `softprops/action-gh-release` for the build:** `tauri-action` does sign + bundle + updater manifest. `softprops` is **additive only** (append checksums). Do not swap. [CITED: release.yml L334-353 — full pipeline must remain]
- **Computing SHA-256 in a separate post-job after upload:** the bundle paths are matrix-scoped (`runner.os`-specific). Compute in the same job step that owns the build, before the runner tears down. (You can't `actions/download-artifact` then `shasum` from a follow-up job without doubling runtime + cost.)
- **Using `pytest tests/` on Windows in Phase 0:** the full suite needs WhisperX import (broken without `INST-01` `setuptools` fix), CosyVoice docs (Phase 1), and ffmpeg-with-libav (chocolatey ships a `--full` variant but the default may not). Scope Phase 0 smoke to `tests/smoke/` narrowly.
- **Setting `WEBKIT_DISABLE_COMPOSITING_MODE=1` unconditionally on the Linux smoke runner:** PITFALLS #9 — kills WebGL perf for non-NVIDIA. GH runners have no NVIDIA — omit the env var; the bug it works around doesn't apply on CI hardware. [CITED: PITFALLS.md L292-322]
- **Trusting `tauri-action`'s `releaseBody:` to carry checksums:** the checksum computation has to happen **after** `tauri-action` builds the artifacts, so the body would need a second write anyway. Use `softprops/action-gh-release@v2 append_body: true` as the second write. [CITED: github.com/tauri-apps/tauri-action action.yml — no checksum output exists]
- **Using `gh release edit --notes-file` for the append:** `gh release edit` **replaces** notes, doesn't append. Would require fetch-edit-write three-step. `softprops` does it in one step. [CITED: cli.github.com/manual/gh_release_edit]
- **Generating the fixture at test time** instead of checking it in: defeats GATE-01's "frozen" intent and means a schema change silently mutates the fixture without a reviewable diff.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Append text to a GitHub Release body | Custom `gh api` + JSON-patch script | `softprops/action-gh-release@v2` with `append_body: true` | Already handles GH API auth, retry, rate-limit; widely used. [CITED: github.com/softprops/action-gh-release/issues/646] |
| SHA-256 of multiple files | A Python/Node script | `shasum -a 256 *.dmg` (POSIX) / `Get-FileHash -Algorithm SHA256` (Windows) | Preinstalled on every GH runner; same algorithm |
| Boot-and-poll a backend in CI | A complex orchestrator | Bash `for` loop with `curl -sf` + 5s sleep + PID liveness check | The existing `scripts/smoke-test.sh` L187-219 already proves this pattern works; copy structure. [CITED: PATTERNS.md L88-104] |
| Headless display on Linux for AppImage | Custom Xorg config | `apt install xvfb && xvfb-run --auto-servernum --server-args='-screen 0 1280x720x24' …` | Standard pattern across Electron, Tauri, Qt projects. [CITED: docs.electron.org/tutorial/testing-on-headless-ci, github.com/coactions/setup-xvfb] |
| Cross-platform smoke shell scripts | Bash-only | `shell: bash` step (GH runners ship Git Bash on Windows) **only when** the script is short; otherwise per-OS `if: runner.os == …` blocks with native shell | Mixed approach matches existing repo (`release.yml` L213, L218 already uses `shell: bash` for cross-OS scripts) |
| DMG mount on macOS | Custom mount logic | `hdiutil attach -nobrowse -noautoopen` + `hdiutil detach -force` in trap | Built into macOS; the flags suppress Finder window. [CITED: keith.github.io/xcode-man-pages/hdiutil.1.html] |
| MSI silent install | Custom installer | `msiexec.exe /i "<file>.msi" /qn /norestart /l*v <log>` | Standard Windows installer pattern; `/qn` = fully quiet, `/l*v` = verbose log for failure debugging. [CITED: silentinstall.org/msiexec] |
| SQLite fixture seeding | Custom test setup that writes rows on every run | Pre-migrated empty `.db` checked into `tests/fixtures/omnivoice_data/` | Reproducibility; a binary diff in a PR means someone intentionally changed the fixture. [CITED: PATTERNS.md L306] |
| FastAPI healthcheck endpoint | Adding `/livez`, `/readyz` | The existing `/health` at `backend/main.py` L379-389 | Already returns `{"status":"ok","device":...}` and is explicitly marked for "Docker health checks, load balancers, and the Tauri desktop shell". Don't duplicate. |
| PR cadence enforcement bot | A GitHub App + label rules | A checklist in the PR template (reviewer enforces) | Phase 0 is hard-gate documentation; v2 of this could automate via labeler action |

**Key insight:** **every Phase 0 capability has an existing in-repo analog or a single-line standard tool.** The only true invention is the *combination* — `tauri-action` + `softprops/action-gh-release` + native checksums in one pipeline. No new helper libraries, no new abstractions, no new build steps beyond what's listed.

---

## Common Pitfalls

### Pitfall 1: macOS headless DMG mount fails on newer runner images
**What goes wrong:** `hdiutil attach` returns "no mountable file systems" on macOS 26 Tahoe beta runners ([CITED: github.com/electron-userland/electron-builder/issues/9615]).
**Why it happens:** Tahoe beta HFS+ mount handler regression.
**How to avoid:** Pin `macos-14` (Sonoma) for now — already in repo. Avoid `macos-latest` which floats. If `macos-14` is deprecated later, test `macos-15` (Sequoia) before bumping; do NOT jump straight to Tahoe-era images until the upstream regression is fixed.
**Warning signs:** Smoke job fails on first attempt with `hdiutil: attach failed - no mountable file systems` — that's the bug, not your DMG.

### Pitfall 2: PyInstaller-frozen backend on Windows spawns two processes; `Stop-Process` kills only the parent
**What goes wrong:** On Windows, killing the Tauri shell does not kill the Python backend ([CITED: github.com/tauri-apps/tauri/issues/11686]). The smoke test's "kill on cleanup" leaves a zombie backend bound to port 3900; the next runner job hits port-in-use.
**Why it happens:** PyInstaller bootstrap creates a parent + child process; child is reparented when parent exits.
**How to avoid:** Kill the entire process tree on Windows cleanup. PowerShell pattern:
```powershell
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-Process | Where-Object { $_.ProcessName -like "*omnivoice*" } | Stop-Process -Force -ErrorAction SilentlyContinue
```
Alternative: use `taskkill /F /T /PID $proc.Id` (the `/T` flag terminates child processes too).
**Warning signs:** Second job-run on the same runner sees "address in use" on port 3900.

### Pitfall 3: `ubuntu-22.04` WebKitGTK 2.50.4 breaks first-load
**What goes wrong:** A March 2026 WebKitGTK 2.50.4 update on Ubuntu 22.04 broke GitButler with `NetworkProcess fails with internallyFailedLoadTimerFired` ([CITED: github.com/gitbutlerapp/gitbutler/issues/12885]). May affect any Tauri 2 app on `ubuntu-22.04` runners after the March 2026 image refresh.
**Why it happens:** WebKitGTK regression in the runner's apt baseline.
**How to avoid:** Phase 0's Linux smoke launches the AppImage under `xvfb-run`; if WebKitGTK fails to load, the smoke fails before `/health` becomes reachable. **Detect and report this clearly** — the failure mode is "app dies in xvfb" not "code is wrong". Consider parallel-running on `ubuntu-24.04` as a sanity check (uses WebKit-4.1).
**Warning signs:** Smoke fails with "App died during bootstrap" within 10s on `ubuntu-22.04` but passes on `macos-14` and `windows-2022`.

### Pitfall 4: `awalsh128/cache-apt-pkgs-action@latest` floats the action SHA
**What goes wrong:** `@latest` means a new action release can change behavior between PRs. Supply-chain audit weakness ([CITED: PITFALLS.md #6 mirror discussion — same threat model applies to GH Actions]).
**Why it happens:** Existing repo convention. Not introduced by Phase 0; inherited.
**How to avoid:** Phase 0 should not regress on this — keep the existing pin. v2 hardening: pin all third-party actions to commit SHA. Track as a separate issue (out of Phase 0 scope).
**Warning signs:** A green CI run today + the same code failing CI tomorrow with no diff = a floating action shifted.

### Pitfall 5: macOS GH runner has no window server → Tauri main blocks on webview creation
**What goes wrong:** GH macOS runners are headless. If Tauri 2's `tauri::Builder::default().run()` blocks on window creation before spawning the Python sidecar, the backend never boots and `/health` never returns. [ASSUMED] — needs first-run verification.
**Why it happens:** Tauri's lifecycle has the webview creation and sidecar spawn ordering as implementation details; on a system with no `WindowServer` (Aqua), `NSWindow` instantiation can hang.
**How to avoid:** **First-run verification step.** If the macOS smoke fails to ever reach `/health`, fall back to: (a) extract `.app` and launch the bundled Python entry point directly (`Contents/Resources/backend/main.py` via the bundled `python`), bypassing Tauri main; OR (b) use an `XVFB`-equivalent on macOS, which doesn't exist — so option (a) is the real fallback.
**Warning signs:** macOS smoke times out on `/health` poll while Linux and Windows succeed. Investigate by adding `-vv` to the Tauri launch and capturing stderr.

### Pitfall 6: First-launch `uv sync --frozen` exceeds the 300s smoke timeout
**What goes wrong:** Fresh runner means no `~/.cache/uv` — `uv sync --frozen` may take 60-180s downloading PyTorch (2 GB+). [CITED: release.yml L202 — first-launch venv creation]
**Why it happens:** Smoke test runs on a fresh runner; uv cache doesn't survive between runs unless explicitly cached.
**How to avoid:** **Two options.** (a) Bump smoke timeout to 600s (matches `scripts/smoke-test.sh` L188). (b) Pre-warm uv cache: add a `uv sync` step **before** the bundle smoke step so the cache is warm when the bundle's bootstrap runs. Option (b) is faster and more honest about what's being tested.
**Warning signs:** Smoke fails at exactly 300s every time, with backend logs showing `uv sync` mid-progress.

### Pitfall 7: Three concurrent `softprops/action-gh-release append_body: true` calls race
**What goes wrong:** macOS, Windows, Linux build jobs all finish at slightly different times and all append to the same release body. Append order is non-deterministic.
**Why it happens:** GitHub's release-update API serializes writes but doesn't queue them; clients see the most recent state and append.
**How to avoid:** Acceptable for v0.3.x — the three `## SHA-256 Checksums (<OS>)` sections appearing in different orders across releases is cosmetic, not functional. v2 hardening: add a final `aggregate-checksums` job that depends on all three and writes a single canonical block.
**Warning signs:** Release body shows two of three platforms' checksums (one write was clobbered) — this would be a real bug; investigate `softprops` retry logic if seen.

### Pitfall 8: GATE-06 PR-ordering creates a deadlock
**What goes wrong:** REQUIREMENTS.md GATE-06 says PRs #51 (cross-platform bug bash), #53 (SRT import — note: already merged per recent commit log), #61 (lazy ASR — already merged) "are merged before Phase 0 finalizes the CI matrix." But the new CI matrix may break those PRs if any of them touches Python imports on macOS/Windows in a way that wasn't caught by the pre-Phase-0 Linux-only CI.
**Why it happens:** New CI catches new failures. If PR #51's cross-platform bug bash introduces a fix that *itself* has a platform regression, Phase 0's matrix catches it AFTER #51 merges — meaning `main` is broken.
**How to avoid:** **Recommended interleave:**
  1. Land Phase 0's CI matrix BUT scope it to `tests/smoke/test_pr_smoke.py` (which only depends on `/health` and the fixture DB — minimal surface)
  2. Merge #51 with the new matrix gating it
  3. If #51's matrix smoke is red, fix forward in #51 (not in a separate Phase 0 patch)
  4. Once #51 lands, Phase 0 is "finalized"
  Rationale: Phase 0 ships a narrow safety net first, #51 then proves the net catches things, and the matrix can expand in Phase 1 once `INST-01` and the install-doc rewrite ship.
**Warning signs:** PR #51 becomes blocked on a CI failure that didn't exist before Phase 0 — that's the matrix doing its job; fix in #51.
**Alternative:** Land GATE-02 (CI matrix) AS PART OF PR #51 — but this couples two big changes and makes both harder to review. Reject; prefer the staged approach above.

### Pitfall 9: PR #53 (SRT import) and PR #61 (lazy ASR) status
**What goes wrong:** REQUIREMENTS.md says these are open and gate Phase 0. Recent commit log shows `4509e08 feat: import .srt subtitles to bypass Whisper (#52)` — likely supersedes/closes #53; `545b39c` and earlier merge IDs don't match #61 but suggest it's also landed.
**Why it happens:** Roadmap was written 2026-05-16; merges may have completed since.
**How to avoid:** **Planner action:** run `gh pr view 51 53 61 --json state,mergedAt` before locking GATE-06 task list. If #53 and #61 are merged, GATE-06 collapses to "merge PR #51 only". If all three are merged, GATE-06 is satisfied without further action.
**Warning signs:** REQUIREMENTS.md says "open" but PR shows merged — update REQUIREMENTS.md as part of Phase 0 close-out.

---

## Code Examples

Verified patterns from official sources and in-repo precedent.

### Smoke test module (`tests/smoke/test_pr_smoke.py`)

```python
# Source: composed from tests/test_router_smoke.py L9-32 + tests/test_api.py L22-41
import os
import sys
from pathlib import Path

import pytest

# Match existing pattern — short-circuit heavy model load
os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

# Point app at the fixture DB instead of the user's omnivoice_data
FIXTURE_DIR = Path(__file__).parent.parent / "fixtures" / "omnivoice_data"
os.environ.setdefault("OMNIVOICE_DATA_DIR", str(FIXTURE_DIR))


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from main import app  # backend/ is on sys.path via tests/conftest.py
    return TestClient(app)


def test_health(client):
    """GATE-02: every PR proves /health returns 200 with a device field."""
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "device" in body


def test_fixture_loads(client):
    """GATE-01: the frozen fixture DB is discoverable and queryable."""
    # /system/info reports data_dir — verify it points at the fixture
    r = client.get("/system/info")
    assert r.status_code == 200
    body = r.json()
    assert str(FIXTURE_DIR) in body.get("data_dir", "")


def test_profiles_endpoint_clean_db(client):
    """GATE-01: the fixture DB is migrated to head and has zero rows."""
    # Lists voice profiles — should be [] for the frozen fixture
    r = client.get("/profiles")
    assert r.status_code == 200
    assert r.json() == []
```

### Two-RC cadence doc (`docs/releases/two-rc-cadence.md`)

```markdown
# Two-RC Release Cadence

OmniVoice ships every minor on a two-RC cadence:

1. **`vX.Y.0-rc1`** — cut from `main` once all GATE-* requirements pass.
   Clean-VM exercise on UTM macOS Sequoia, Hyper-V Windows 11,
   Ubuntu 24.04, Fedora 44. (REL-01)
2. **48-hour soak** — no new commits to release branch except fix-forward
   for regressions reported during soak. (REL-02)
3. **`vX.Y.0`** — promoted from rc1 if soak completes clean.

## PR timing rules

- PRs touching `bootstrap.rs`, `tauri.conf.json`, `pyproject.toml`,
  `uv.lock`, or `.github/workflows/release.yml` MUST land BEFORE rc1 cut.
  Bundling/installer code changing between rc1 and v0.x.0 means the bytes
  the user gets are not the bytes that soaked for 48h.
- Pure backend/frontend logic changes MAY land during soak as fix-forward
  if they fix a soak-discovered regression.
- New features (engines, UI surfaces) NEVER land during soak — open a PR
  targeting the NEXT minor's RC cycle.

## Regression fixture

Every PR's CI matrix loads `tests/fixtures/omnivoice_data/`. If your PR
changes anything that touches the DB schema, the audio I/O, or the
backend boot, you MUST verify the fixture still loads green BEFORE
opening the PR (run `uv run pytest tests/smoke/`).

If the fixture itself needs an update (e.g., a real alembic migration),
the fixture-update is a SEPARATE PR that merges first; downstream PRs
rebase onto it.
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `setup-python` + manual `pip install` in CI | `astral-sh/setup-uv@v3` + `uv sync` | uv reached stable 2024 | 10× faster cold install; deterministic via `uv.lock` |
| `actions/cache@v3` manual key crafting | `setup-uv enable-cache: true` with `cache-dependency-glob` | setup-uv v3 (2024) | Removes manual cache-key math; correct invalidation built in |
| `webkit2gtk-4.0-dev` on Ubuntu | `webkit2gtk-4.1-dev` (already in repo for both `ci.yml` and `release.yml`) | Tauri 2 stable (2024), Ubuntu 24.04 + Fedora 40 dropped 4.0-dev | Keep 4.1; do not regress |
| `node 20` for JS actions | `node 24` (forced via `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` already in env) | GitHub deprecating Node 20 Sep 2026 | Already handled in repo |
| `gh release create --notes` for everything | `tauri-action` for build/sign/publish + `softprops/action-gh-release@v2` for body edits | tauri-action stable + softprops v2 (current) | Cleaner separation: `tauri-action` owns the bundle pipeline, `softprops` owns the body edits |
| Hand-rolled SHA-256 in a custom Node action | Native `shasum -a 256` (POSIX) / `Get-FileHash -Algorithm SHA256` (Windows) preinstalled on runners | Always available; "best practice" is to avoid third-party where shell native exists | No supply-chain dep for a 1-line tool |

**Deprecated/outdated (do not adopt):**
- `gabrielbb/xvfb-action` — still works, but `coactions/setup-xvfb` or raw `apt install xvfb && xvfb-run` are simpler. [CITED: github.com/GabrielBB/xvfb-action — last update notes still 2023-era] **MEDIUM confidence on deprecation status**; either works.
- `actions/cache@v3` and earlier — use `@v4` (already in repo).
- `softprops/action-gh-release@v1` — superseded by `@v2` (Node 20) and `@v3` (Node 24). [CITED: github.com/softprops/action-gh-release/releases]

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `pytest>=9.0.3` (already in `pyproject.toml` dev deps L161) |
| Config file | `pyproject.toml [tool.pytest.ini_options]` L166-183 |
| Quick run command | `uv run pytest tests/smoke/ -q --tb=short` |
| Full suite command | `uv run pytest tests/ -q --tb=short` (Linux only for Phase 0; expand in Phase 1) |
| Cross-platform smoke | `uv run pytest tests/smoke/ -q` run on macos-14 + windows-2022 + ubuntu-22.04 |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GATE-01 | Frozen fixture loads, schema matches alembic head, zero rows | unit (pytest) | `uv run pytest tests/smoke/test_pr_smoke.py::test_fixture_loads -x` | ❌ Wave 0 — new file `tests/smoke/test_pr_smoke.py` + new fixture `tests/fixtures/omnivoice_data/` |
| GATE-02 | Smoke runs on macOS + Windows + Linux in CI | integration (CI matrix) | Workflow-level; PR triggers `smoke-matrix` job in `ci.yml` | ❌ Wave 0 — new job in `.github/workflows/ci.yml` |
| GATE-03 | Installer boots, `/health` returns 200 within 300s | smoke (CI workflow step) | Workflow step in `release.yml`'s `build` matrix per OS | ❌ Wave 0 — new step in `.github/workflows/release.yml` |
| GATE-04 | PR template contains 2-RC cadence + fixture checklist | manual-only (template diff) | `diff .github/pull_request_template.md HEAD~1:.github/pull_request_template.md \| grep "Release cadence"` | ❌ Wave 0 — modify existing template |
| GATE-05 | Every release body has SHA-256 block per artifact | integration (post-release inspection) | After tag push: `gh release view <tag> --json body \| jq '.body \| contains("SHA-256")'` | ❌ Wave 0 — new step in `.github/workflows/release.yml` |
| GATE-06 | PRs #51, #53, #61 merged | manual + GitHub state | `gh pr view 51 53 61 --json state,mergedAt` | n/a — verification only |

### Sampling Rate

- **Per task commit:** `uv run pytest tests/smoke/ -q` (local, < 5s if `OMNIVOICE_MODEL=test`)
- **Per wave merge:** Full CI matrix — `test` + `tauri-cross-platform` + new `smoke-matrix` all green
- **Phase gate:** Full release dry-run via `workflow_dispatch` on `release.yml` produces a draft release with checksum block; install + boot verified manually on at least one of macOS/Windows/Linux

### Wave 0 Gaps (test infra to create before implementation)

- [ ] `tests/smoke/__init__.py` — empty marker
- [ ] `tests/smoke/test_pr_smoke.py` — covers GATE-01 (fixture loads) and validates `/health` for GATE-02
- [ ] `tests/fixtures/omnivoice_data/omnivoice.db` — alembic-stamped empty DB (~50 KB)
- [ ] `tests/fixtures/omnivoice_data/audio/ref.wav` — 1 sec mono 24 kHz silence (~48 KB)
- [ ] `docs/releases/two-rc-cadence.md` — referenced by PR template
- [ ] No new framework install needed — pytest already in `[dependency-groups] dev` per `pyproject.toml` L161

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture | yes | Two-RC cadence + frozen fixture + per-PR smoke = defense-in-depth against regression-class supply-chain bugs |
| V2 Authentication | no | No new auth surface in Phase 0 |
| V3 Session Management | no | Same |
| V4 Access Control | no | Same |
| V5 Input Validation | yes (low) | `/health` accepts no input; fixture DB is read-only at test time |
| V6 Cryptography | yes | SHA-256 publishing for release verification (GATE-05). Use OS-native `shasum` / `Get-FileHash` — do not implement crypto |
| V10 Malicious Code | yes | All GitHub Actions are pinned to release tags (already in repo); audit `awalsh128/cache-apt-pkgs-action@latest` as a known floating pin to address in v2 |
| V14 Configuration | yes | CI matrix runs the same workflow as `main`; no diverging "test-only" config that masks production bugs |

### Known Threat Patterns for {GitHub Actions + Tauri release pipeline}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Floating action pin (`@latest`, `@stable`) shifts behavior | Tampering | Pin to commit SHA; track upgrades as deliberate PRs. Phase 0 inherits existing `@latest` for one action; track but don't block on it. |
| Workflow secrets leak via `set -x` or echoed env | Information Disclosure | Existing workflows do not use `set -x`; new smoke step must avoid `pwd`-style debug echoes when `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is in env |
| Compromised mirror serves bad bytes via `tauri-action` install | Tampering | tauri-action pulls from npm + crates.io which are TLS-pinned. Out of Phase 0 scope. |
| Release body modified post-publish without checksum re-verification | Tampering | SHA-256 in release body = self-verifying; users can recompute against the linked asset |
| `xattr -cr` instructions teach users to bypass Gatekeeper | Phishing trainer | PITFALLS #8 — checksums in release body let users verify BEFORE running `xattr` ([CITED: PITFALLS.md L274 — checksums are the precondition to the workaround]) |
| Smoke runner installs ffmpeg from random source on Windows | Supply chain | Use `choco install ffmpeg -y` from official chocolatey repository, not arbitrary URLs |
| Pre-commit hooks bypass-able to ship code that breaks the matrix | Tampering | Matrix runs on `pull_request` event regardless of local git config — server-side enforcement |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Chocolatey is preinstalled on `windows-2022` runners | Standard Stack (Windows ffmpeg) | Smoke step fails on Windows on first run; mitigation: `choco --version` precheck or fall back to manual ffmpeg download |
| A2 | macOS headless runner can launch the Tauri bundle binary and have it spawn the Python backend without a window server | Pattern 3 (macOS smoke) | macOS smoke times out; fallback is to invoke `Contents/Resources/backend/main.py` directly via bundled `uv`/`python` — need verification on first CI run |
| A3 | PR #51 (cross-platform bug bash) is still open; PRs #53 and #61 status uncertain from recent commit log | Pitfall 8 / Pitfall 9 | Wrong assumption changes GATE-06 task list; mitigation is `gh pr view 51 53 61` as first planning task |
| A4 | First-launch `uv sync --frozen` on a fresh CI runner stays under 300s | Pattern 3 (smoke timeout) | Smoke fails at exactly 300s; mitigation: pre-warm uv cache step OR bump timeout to 600s |
| A5 | Three concurrent `softprops/action-gh-release append_body: true` writes don't clobber each other | Pattern 4 (checksum race) | One platform's checksums missing from release body; mitigation in v2: aggregate-checksums job |
| A6 | `softprops/action-gh-release@v2`'s `append_body: true` semantics work as described in issue #646 | Pattern 4 | If append silently replaces, release body loses CHANGELOG; mitigation: first release tested via `workflow_dispatch` on a draft release |
| A7 | `coactions/setup-xvfb` is not strictly required — `apt install xvfb && xvfb-run` is sufficient | Standard Stack | Either path works; prefer the lower-dep one |
| A8 | The existing `awalsh128/cache-apt-pkgs-action@latest` pin is acceptable for Phase 0 (it predates Phase 0 and isn't introduced by it) | Pitfall 4 | If the action's behavior shifts mid-milestone, smoke matrix flakes; addressing is out-of-Phase-0 scope |
| A9 | Tauri bundle identifier `com.debpalash.omnivoice-studio` corresponds to install path `C:\Program Files\OmniVoice Studio` on Windows | Pattern 3 (Windows smoke) | Install path lookup fails; mitigation: read identifier from `tauri.conf.json` dynamically rather than hardcode |
| A10 | The 2.4 GB OmniVoice model load is short-circuited entirely when `OMNIVOICE_MODEL=test` is set; no partial model imports happen | Standard Stack (test isolation) | Smoke matrix bloats download to multi-GB; mitigation: grep for `OMNIVOICE_MODEL` consumers in backend code to confirm coverage |

---

## Open Questions

1. **macOS GH runner: does the Tauri bundle binary spawn its Python sidecar without a window server present?**
   - What we know: Tauri 2's sidecar pattern uses `tauri::api::process::Command` (async). The Python boot should be independent of webview ready.
   - What's unclear: whether Tauri's main thread blocks on `NSApplication` activation before the sidecar lifecycle hook fires.
   - Recommendation: first CI run is the verification. If macOS smoke times out, fall back to direct backend invocation (`Contents/Resources/backend/...`).

2. **Status of open PRs #51, #53, #61 as of plan-execution date**
   - What we know: REQUIREMENTS.md lists all three as gating Phase 0; recent commit `4509e08 feat: import .srt subtitles to bypass Whisper (#52)` suggests #53's scope is merged via #52.
   - What's unclear: actual `gh pr view` status.
   - Recommendation: planner runs `gh pr view 51 53 61 --json state,mergedAt` as first task; updates REQUIREMENTS.md if any are merged.

3. **Should Phase 0 also add macOS + Windows runtime tests to the `release.yml` `test` job?**
   - What we know: `release.yml` L42-105 only runs `test` on `ubuntu-22.04`. Same gap as `ci.yml`.
   - What's unclear: scope. GATE-02 is explicit about `ci.yml`; release.yml runtime tests are a logical extension but not in REQUIREMENTS.md.
   - Recommendation: scope to `ci.yml` only for Phase 0 (matches REQUIREMENTS.md verbatim). Track release.yml unification as a separate v0.4 task. The `build` matrix already runs cross-platform — the gap is only in the pre-build `test` job, which is a quick-fail gate not a coverage tool.

4. **First-PR smoke false-positive rate**
   - What we know: This is the first time `ci.yml` runs the full Python toolchain on macOS+Windows. Existing PRs may have undetected platform-specific issues.
   - What's unclear: how many of the next 10 PRs will fail due to pre-existing platform bugs vs new bugs.
   - Recommendation: expect 30-50% red rate for the first 5 PRs after Phase 0 lands. Have a "rolling fix" issue tracking platform-specific surprises. PITFALL #1's "regression budget per wave" applies here.

5. **Checksum format: matches user expectations for `xattr -cr` workflow?**
   - What we know: PITFALLS #8 says "verify SHA-256 against the value on the GitHub Releases page first" — the user is supposed to copy-paste and compare.
   - What's unclear: format. `shasum -a 256 file.dmg` outputs `<hash>  file.dmg`. Some users expect a separate `SHA256SUMS` file (matches Linux distro convention) AND inline-in-body. Recommendation is BOTH (already in Pattern 4 — upload `checksums-*.md` as a release asset AND append to body).

---

## Environment Availability

| Dependency | Required By | Available (target CI) | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Python 3.11 | All smoke matrix runners | ✓ via `actions/setup-python@v5` | 3.11 | — |
| uv ≥0.5 | Python deps install | ✓ via `astral-sh/setup-uv@v3` | latest | — |
| ffmpeg (Linux) | Backend audio I/O (in fixtures) | ✓ via `awalsh128/cache-apt-pkgs-action@latest` | system | apt install no-cache |
| ffmpeg (macOS) | Same | ✓ via `brew install ffmpeg` | brew latest | already-installed on most images |
| ffmpeg (Windows) | Same | [ASSUMED] ✓ via `choco install ffmpeg` | chocolatey | manual download static build |
| xvfb (Linux only) | AppImage launch smoke | ✓ via `apt install xvfb` | system | none (Linux smoke would skip launch step) |
| `hdiutil` (macOS) | DMG mount in smoke | ✓ preinstalled on macOS runners | system | — |
| `msiexec` (Windows) | MSI silent install | ✓ preinstalled on Windows runners | system | — |
| `shasum` (POSIX) | Checksum computation | ✓ preinstalled on macOS + Linux runners | system | `sha256sum` if `shasum` absent |
| `Get-FileHash` (Windows) | Checksum computation | ✓ preinstalled (PowerShell built-in) | system | `certutil -hashfile <f> SHA256` |
| `alembic` | Fixture DB build (one-time, local) | ✓ in `pyproject.toml` L71 | ≥1.13 | — |
| `gh` CLI | Manual PR status check (planning) | ✓ in `actions/checkout` workflow context | preinstalled on runners | — |

**Missing dependencies with no fallback:** none — every dependency has either a built-in or a degradation path.

**Missing dependencies with fallback:** Windows ffmpeg via chocolatey is [ASSUMED] — verify chocolatey availability via `runner-images` repo OR add `choco --version` precheck step.

---

## Project Constraints (from CLAUDE.md)

- **Existing engine compatibility**: Phase 0 does not touch engine code; constraint is trivially satisfied.
- **Cross-platform parity**: Phase 0 *implements* this constraint at the CI level — the whole point.
- **Backward-compatible project data**: The fixture is read-only; it does not migrate or alter user `omnivoice_data/`.
- **Local-first guarantee preserved**: CI/CD changes do not affect runtime; the smoke endpoint `/health` returns no PII (`{"status":"ok","device":"cuda (xxx)"}`).
- **Beta release cadence**: GATE-04 / PR template / two-RC doc *enforce* this.
- **GSD Workflow Enforcement**: This research run is part of `/gsd:plan-phase`; subsequent edits route through `/gsd-execute-phase`.

No CLAUDE.md directive is violated by the patterns above.

---

## Sources

### Primary (HIGH confidence)

- In-repo files (canonical for project-specific patterns):
  - `/Users/user4/Desktop/voice-design/OmniVoice/.github/workflows/ci.yml` — matrix shape, Python setup, action pins
  - `/Users/user4/Desktop/voice-design/OmniVoice/.github/workflows/release.yml` — `tauri-action` invocation, bundling, env vars
  - `/Users/user4/Desktop/voice-design/OmniVoice/backend/main.py` (L379-389) — `/health` endpoint signature
  - `/Users/user4/Desktop/voice-design/OmniVoice/scripts/smoke-test.sh` — boot+poll loop pattern (cited via PATTERNS.md)
  - `/Users/user4/Desktop/voice-design/OmniVoice/tests/conftest.py` — sys.path priming for `backend/` imports
  - `/Users/user4/Desktop/voice-design/OmniVoice/tests/test_router_smoke.py` — TestClient pattern (60-line analog)
  - `/Users/user4/Desktop/voice-design/OmniVoice/pyproject.toml` — pytest config, dependency pins
  - `/Users/user4/Desktop/voice-design/OmniVoice/.github/pull_request_template.md` — existing template structure
  - `/Users/user4/Desktop/voice-design/OmniVoice/.planning/phases/00-gates/00-PATTERNS.md` — exhaustive prior pattern map (much of this RESEARCH cites it directly)
- [GitHub Actions: Using uv in GitHub Actions](https://docs.astral.sh/uv/guides/integration/github/) — uv + setup-uv canonical workflow
- [Tauri 2: GitHub Pipeline](https://v2.tauri.app/distribute/pipelines/github/) — tauri-action publishing reference
- [Tauri 2: Embedding External Binaries (sidecar)](https://v2.tauri.app/develop/sidecar/) — sidecar lifecycle relevant to macOS smoke open question
- [softprops/action-gh-release issue #646](https://github.com/softprops/action-gh-release/issues/646) — `append_body` semantics confirmation
- [GitHub CLI: `gh release edit`](https://cli.github.com/manual/gh_release_edit) — confirms `gh release edit` REPLACES, doesn't append
- [tauri-action action.yml (dev branch)](https://github.com/tauri-apps/tauri-action/blob/dev/action.yml) — outputs include `artifactPaths` but no checksum support
- [hdiutil man page](https://keith.github.io/xcode-man-pages/hdiutil.1.html) — macOS DMG mount flags
- [Microsoft msiexec docs / silentinstall.org](https://silentinstall.org/msiexec) — Windows MSI silent install flags

### Secondary (MEDIUM confidence)

- [WebKit2GTK API version support across Linux distros (gist)](https://gist.github.com/tassa-yoniso-manasi-karoto/bbc796f45170b013c8b6b062077cc83b) — 2026 deprecation timeline for webkit2gtk-4.0 vs 4.1
- [Tauri issue #11763 — libwebkit2gtk-4.1 on Ubuntu 22.04](https://github.com/tauri-apps/tauri/issues/11763) — Linux runner compatibility nuances
- [DEV: Ship Your Tauri v2 App Like a Pro (part 2/2)](https://dev.to/tomtomdu73/ship-your-tauri-v2-app-like-a-pro-github-actions-and-release-automation-part-22-2ef7) — community example of full release workflow
- [GitHub blog: ubuntu-24.04 default + 20.04 deprecation](https://github.blog/changelog/2025-01-15-github-actions-ubuntu-20-runner-image-brownout-dates-and-other-breaking-changes/) — runner OS deprecation policy (informs why `macos-14` + `ubuntu-22.04` are correct pins today, not `*-latest`)
- [Electron testing on headless CI](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci) — xvfb-run patterns (transfers to Tauri/WebKitGTK)
- [GitButler issue #12885 — WebKitGTK 2.50.4 regression on Ubuntu 22.04](https://github.com/gitbutlerapp/gitbutler/issues/12885) — Pitfall #3 source
- [Electron-builder issue #9615 — DMG mount failure on macOS Tahoe](https://github.com/electron-userland/electron-builder/issues/9615) — Pitfall #1 source
- [Tauri issue #11686 — PyInstaller child not killed on Windows](https://github.com/tauri-apps/tauri/issues/11686) — Pitfall #2 source
- [Tauri docs Nvidia workaround issue #9394](https://github.com/tauri-apps/tauri/issues/9394) — webkit env var context (PITFALLS.md #9 cross-reference)

### Tertiary (LOW confidence — flagged for validation)

- [Embedded Artistry PULL_REQUEST_TEMPLATE.md example](https://github.com/embeddedartistry/templates/blob/master/oss_docs/PULL_REQUEST_TEMPLATE.md) — structural reference for OSS PR templates; the *two-RC cadence text* is new content with no direct OSS analog
- [coactions/setup-xvfb](https://github.com/coactions/setup-xvfb) — marketplace action; lower-confidence than the raw `apt install xvfb` path
- Chocolatey preinstall on `windows-2022` runner: [ASSUMED] — verify via `actions/runner-images` repo before locking

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every action already exists in repo or is canonical (`softprops/action-gh-release@v2`)
- Architecture: HIGH — composed entirely from existing primitives at known line numbers
- Pitfalls: MEDIUM — well-cited but ordering of macOS-headless behavior and Phase 0 vs PR-#51 interleave both have unknowns
- Validation: HIGH — pytest + existing test patterns transfer directly
- Security: MEDIUM — `awalsh128/cache-apt-pkgs-action@latest` floating pin is a known inherited issue; rest is clean

**Research date:** 2026-05-16
**Valid until:** 2026-06-15 (30 days for stable infra). Earlier expiry if: tauri-action ships a checksum-generation feature, `softprops/action-gh-release@v3` Node 24 becomes the new stable, OR GitHub deprecates `ubuntu-22.04` ahead of schedule.
