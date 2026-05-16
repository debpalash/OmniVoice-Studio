# Phase 0: Gates — Pattern Map

**Mapped:** 2026-05-16
**Files analyzed:** 5 (3 new, 2 modified)
**Analogs found:** 5 / 5 (all files have at least one strong analog in-repo)
**Scope note:** CI/release/test phase — patterns are narrow and infra-flavored, not feature-flavored.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `.github/workflows/ci.yml` (MODIFY) | CI config | event-driven (PR/push) | itself (extend `tauri-cross-platform` matrix at L105-174) + reuse `test` job Python setup at L22-69 | exact |
| `.github/workflows/release.yml` (MODIFY) | release config | event-driven (tag push) | itself (post-`tauri-action` step at L334-353) + `scripts/smoke-test.sh` Phase 3-4 boot+health pattern (L187-312) | exact |
| `tests/fixtures/omnivoice_data/` (NEW) | test fixture | file-I/O (read-only at test time) | `tests/fixtures/whisper_clean.json` + `whisper_screenshot.json` (L=569B, 1337B) + live `omnivoice_data/omnivoice.db` (160K, 4 tables) | role-match (no SQLite-DB fixture exists yet — invention needed for DB seeding) |
| `tests/smoke/test_pr_smoke.py` (NEW) | pytest module | request-response (TestClient) + subprocess (boot real server) | `tests/test_router_smoke.py` (whole file — 60 lines is the entire pattern) + `scripts/smoke-test.sh` Phase 4 (L226-312) for the boot-server variant | exact for in-process; partial for subprocess-boot variant |
| `.github/PULL_REQUEST_TEMPLATE.md` (MODIFY) | docs template | static | existing `.github/pull_request_template.md` (L1-38) | exact |

Note: GitHub honors both `pull_request_template.md` and `PULL_REQUEST_TEMPLATE.md`; current file is lowercase. **Modify in place, do not rename** (would orphan history).

---

## Pattern Assignments

### `.github/workflows/ci.yml` (MODIFY — add macOS/Windows runtime smoke)

**Analog:** itself — the existing `tauri-cross-platform` matrix is the template for adding Python-on-each-OS.

**Matrix shape to copy** (from `ci.yml` L108-121):
```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - os: macos-14
        label: macOS
        rust_target: aarch64-apple-darwin
      - os: windows-2022
        label: Windows
        rust_target: x86_64-pc-windows-msvc
      - os: ubuntu-22.04
        label: Linux
        rust_target: x86_64-unknown-linux-gnu
runs-on: ${{ matrix.os }}
```
Reuse the exact OS pin set (`macos-14`, `windows-2022`, `ubuntu-22.04`) — keeps release/CI runner matrix uniform and avoids "works in CI fails in release" splits.

**Python setup block to copy** (from `ci.yml` L26-59):
```yaml
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
- name: Install Python deps
  run: uv sync
```
This block is the ONLY supported way to install deps in CI per the comment at L34 ("`enable-cache` persists ~/.cache/uv keyed on uv.lock — turns `uv sync` from ~45s cold to ~5s warm"). Do NOT reach for `pip install -r requirements.txt` — no such file exists.

**ffmpeg pattern (Linux only — needs invention for mac/Windows):**
- Linux: `awalsh128/cache-apt-pkgs-action` at `ci.yml` L52-56 → reuse verbatim.
- macOS: `brew install ffmpeg || true` from `release.yml` L171-172 → reuse verbatim.
- Windows: **no analog exists in repo.** Use `choco install ffmpeg -y` or `Set-Path` to runner-preinstalled ffmpeg. Validate with `ffmpeg -version` before pytest runs.

**Pytest invocation to copy** (from `ci.yml` L61-68):
```yaml
- name: Run pytest
  run: uv run pytest tests/ -q --tb=short
```
For the new smoke matrix step, target the new path: `uv run pytest tests/smoke/ -q --tb=short`.

**Critical gotcha:** `tests/conftest.py` (L1-7) prepends `backend/` to `sys.path`. Any new test under `tests/smoke/` inherits this — `from main import app` works without further fiddling (same trick `test_router_smoke.py` L21 relies on).

**Job dependency pattern:** the existing `tauri-cross-platform` job declares `needs: test` (L107). New smoke matrix should also be `needs: test` so a broken Linux fast-test gates the slower 3-OS matrix.

---

### `.github/workflows/release.yml` (MODIFY — post-build installer smoke + SHA-256 publish)

**Analog A (boot + health-poll pattern):** `scripts/smoke-test.sh` L187-312 — this is the production-tested loop that boots the bundle and asserts `/system/info` returns a JSON body with `device` populated. Port the pattern to a workflow step (or call the script directly on Linux/macOS; Windows needs a `.ps1` translation).

**Health-poll loop to reuse** (from `scripts/smoke-test.sh` L196-219):
```bash
ELAPSED=0
INTERVAL=5
BOOTSTRAP_TIMEOUT=600
while [ $ELAPSED -lt $BOOTSTRAP_TIMEOUT ]; do
    if curl -sf "http://127.0.0.1:3900/system/info" >/dev/null 2>&1; then
        echo "Backend healthy after ${ELAPSED}s"
        break
    fi
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
    if ! kill -0 "$APP_PID" 2>/dev/null; then
        echo "App died during bootstrap"; exit 1
    fi
done
```

**Endpoint choice:** prefer `/health` (`backend/main.py` L379-389) over `/system/info`. `/health` is a 5-line endpoint specifically marked for "Docker health checks, load balancers, and the Tauri desktop shell" — it returns `{"status": "ok", "device": ...}` and never throws. `/system/info` is heavier and pulls config; use it as a secondary check only.

**Where the new step slots in:** AFTER `Build + release (Tauri)` at `release.yml` L334-353, BEFORE the implicit job end. Add a new step per matrix runner that:
1. Locates the just-built bundle (matrix-specific: `.app` on macos-14, `.AppImage` or `.deb` on ubuntu-22.04, `.msi` on windows-2022 — bundles already listed at L114-139).
2. Launches it in background (`scripts/smoke-test.sh` L191-193 has the pattern: `"$BINARY" & APP_PID=$!`).
3. Polls `/health` per snippet above.
4. Kills via the `cleanup()` trap at `smoke-test.sh` L56-67.

**Matrix-specific binary discovery** (already proven in `desktop-prod.sh` L154-193):
- macOS: `frontend/src-tauri/target/release/bundle/macos/OmniVoice Studio.app` → `open` it
- Linux: `find frontend/src-tauri/target/release/bundle/appimage -name "*.AppImage"` → `chmod +x && execute`
- Windows: `frontend/src-tauri/target/release/bundle/msi/*.msi` → install via `msiexec /i ... /quiet` then launch from `Program Files`

**SHA-256 publishing — no analog in repo.** `grep -rn sha256 .github/ scripts/` returns nothing. **Needs invention.** Recommended shape:
```yaml
- name: Compute SHA-256 checksums
  shell: bash
  run: |
    cd path/to/built/artifacts
    shasum -a 256 *.dmg *.msi *.AppImage *.deb > checksums-${{ matrix.label }}.txt
- name: Append checksums to release body
  uses: softprops/action-gh-release@v2
  with:
    tag_name: ${{ github.ref_name }}
    append_body: true
    body_path: checksums-${{ matrix.label }}.txt
    files: checksums-${{ matrix.label }}.txt
```
Note: `tauri-action` already creates the release; use `softprops/action-gh-release` with `append_body: true` rather than fighting tauri-action's `releaseBody` flow at L349. Windows has no `shasum` — use `Get-FileHash -Algorithm SHA256` or `certutil -hashfile <f> SHA256`.

**Changelog extract pattern stays unchanged** — the `Extract CHANGELOG section for tag` step at `release.yml` L310-332 already populates the release body via `tauri-action`. Checksums append on top, not replace.

---

### `tests/fixtures/omnivoice_data/` (NEW — frozen regression fixture)

**Analog A (file-fixture convention):** `tests/fixtures/whisper_clean.json` (569 B) + `tests/fixtures/whisper_screenshot.json` (1337 B). Pattern: small static JSON blobs, checked in, loaded via relative path from a test.

**Analog B (live DB schema to subset):** `omnivoice_data/omnivoice.db` (160 KB total, 4 tables — `voice_profiles`, `generation_history`, `dub_history`, `studio_projects`). Schema captured below for direct fixture-builder use:

```sql
CREATE TABLE voice_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, ref_audio_path TEXT,
    ref_text TEXT DEFAULT '', instruct TEXT DEFAULT '',
    language TEXT DEFAULT 'Auto', created_at REAL,
    locked_audio_path TEXT DEFAULT '', seed INTEGER DEFAULT NULL,
    is_locked INTEGER DEFAULT 0
);
CREATE TABLE generation_history (
    id TEXT PRIMARY KEY, text TEXT, mode TEXT, language TEXT,
    instruct TEXT, profile_id TEXT, audio_path TEXT,
    duration_seconds REAL, generation_time REAL, created_at REAL,
    seed INTEGER DEFAULT NULL,
    FOREIGN KEY (profile_id) REFERENCES voice_profiles(id)
);
-- (dub_history, studio_projects also exist — see /Users/user4/Desktop/voice-design/OmniVoice/omnivoice_data/omnivoice.db)
```

**Smallest meaningful subset (recommendation):**
- 1 row in `voice_profiles` with `ref_audio_path` pointing to a tiny WAV at `tests/fixtures/omnivoice_data/audio/ref.wav` (1 sec, 24 kHz, silence — generate via the `make_wav_bytes` helper at `tests/test_api.py` L31-41, no need to record real audio).
- 0 rows in the three history tables (smoke test should *write* one row, then assert it was written — that's the real CRUD path).
- Schema migrations applied: `backend/migrations/` is referenced in `backend.spec` L132 → use `alembic` (in deps at `pyproject.toml` L71) to stamp the DB at build time.

**Size budget:** Aim < 200 KB total for the fixture dir. The live DB is 160 KB with real data; an empty-but-migrated DB + one 1-sec mono WAV @ 24 kHz (~48 KB) should land near 100 KB. Anything bigger drags `git clone` for every contributor.

**Invention needed:** no existing test loads `omnivoice_data/` as a fixture. `pyproject.toml` L173-183 explicitly `norecursedirs` it (`omnivoice_data`, `backend/omnivoice_data`) — that's a *test discovery* exclude, not a *fixture-loading* block, so it doesn't conflict. New fixture lives at `tests/fixtures/omnivoice_data/`, which is OUTSIDE the excluded paths.

---

### `tests/smoke/test_pr_smoke.py` (NEW — PR-blocking smoke)

**Analog (in-process variant):** `tests/test_router_smoke.py` is the entire pattern — 60 lines, no external imports, FastAPI TestClient + module-scope fixture, one assertion per endpoint. Copy the structure verbatim:

```python
# from tests/test_router_smoke.py L9-22 — reuse as-is
import os
import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app)
```

**`OMNIVOICE_MODEL=test` matters** (set at `test_router_smoke.py` L12 and `test_api.py` L22) — it short-circuits the heavy 2.4 GB OmniVoice model load. Without it, the smoke test would download multiple GB on every CI run.

**WAV-fixture helper to reuse** (from `tests/test_api.py` L31-41):
```python
def make_wav_bytes(duration_s=1.0, sample_rate=24000, channels=1) -> bytes:
    """Create a valid WAV file in memory for testing."""
    n_samples = int(duration_s * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack(f"<{n_samples}h", *([0] * n_samples)))
    buf.seek(0)
    return buf.read()
```
Use this to materialize the fixture WAV at test-collection time if you want to avoid checking in the binary. Either approach is acceptable; checked-in is more reproducible.

**Smoke assertions to copy** (`test_router_smoke.py` L26-32):
```python
def test_system_info_smoke(client):
    r = client.get("/system/info")
    assert r.status_code == 200
    body = r.json()
    assert "data_dir" in body
    assert "device" in body
```

**Phase 0 smoke must add:** load the fixture DB, hit `/health`, hit at least one generation-adjacent endpoint that touches the DB (e.g. list profiles via `backend/api/routers/profiles.py`), assert no crash. Do NOT do a real model generation in the PR smoke — that belongs in release.yml, not ci.yml.

**Conftest pattern already set up:** `tests/conftest.py` L1-7 puts `backend/` on `sys.path`. Reuse — no new conftest needed in `tests/smoke/`.

**Pytest invocation:** the new file is discovered by `testpaths = ["tests"]` at `pyproject.toml` L172 automatically; no config change needed.

---

### `.github/PULL_REQUEST_TEMPLATE.md` (MODIFY — RC cadence + fixture requirement)

**Analog:** existing `.github/pull_request_template.md` L1-38. Modify in place (do not rename to uppercase — `git mv` orphans review history on GitHub).

**Sections to extend** (current file has Summary, Changes, Type, Testing, Checklist, Screenshots — keep all six):

Add to `## Type` (current L13-21):
```markdown
- [ ] 🚀 Release prep (RC or final)
```

Add to `## Checklist` (current L28-33):
```markdown
- [ ] If this PR changes runtime behavior, the regression fixture at `tests/fixtures/omnivoice_data/` still loads green
- [ ] If this is part of an RC, I've read `docs/releases/two-rc-cadence.md` and confirmed this PR targets the right RC
- [ ] If this PR adds an installer-affecting change, the per-platform smoke test in `.github/workflows/release.yml` was exercised via `workflow_dispatch`
```

Add a new section before `## Screenshots`:
```markdown
## Release cadence (read once per RC)

OmniVoice ships every minor on a **two-RC cadence**:
- `vX.Y.0-rc1` — cut from main once GATE-* requirements pass; clean-VM exercise on 4 OSes
- 48h soak (no new commits to release branch except fix-forward)
- `vX.Y.0` — promotion if rc1 is clean

If your PR touches install/bootstrap/CI, it MUST land before rc1 cut, not between rc1 and the promotion.
```

No prose analog exists for the cadence copy itself — it's new content driven by REQUIREMENTS.md GATE-04 + roadmap Phase 6. The structural pattern (sections with `<!-- comment -->` placeholders + emoji-prefixed checkboxes) is copied verbatim from the existing template.

---

## Shared Patterns

### Backend boot + health check
**Source:** `backend/main.py` L379-389 (`/health` endpoint) + `scripts/smoke-test.sh` L187-312 (poll loop + endpoint coverage)
**Apply to:** `release.yml` post-build smoke step AND any subprocess-mode tests in `tests/smoke/`
**Why:** `/health` is the canonical "is the backend up" probe; `scripts/smoke-test.sh` is the production-tested loop with crash-detection and timeout handling. Don't reinvent either.

### Test isolation env vars
**Source:** `tests/test_router_smoke.py` L12-13, `tests/test_api.py` L22
**Apply to:** every file under `tests/smoke/`
```python
os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")
```
Without these, CI smoke pulls multi-GB model weights and writes to a file log path that doesn't exist on the runner.

### Cross-OS shell normalization in workflows
**Source:** `release.yml` L213 (`shell: bash`) + L218 (`set -euo pipefail`)
**Apply to:** every new step in the smoke matrix that uses bash. Without `shell: bash`, Windows runners default to PowerShell and bash heredocs/`case` blocks silently fail.

### `needs:` chaining for fast-fail
**Source:** `ci.yml` L107 (`needs: test`) and `release.yml` L108 (`needs: test`)
**Apply to:** new smoke matrix should also be `needs: test` so a unit-test break gates the heavier 3-OS smoke job.

### uv caching keyed on `uv.lock`
**Source:** `ci.yml` L35-39, `release.yml` L54-58
**Apply to:** any new job that runs `uv sync`. Always include:
```yaml
- uses: astral-sh/setup-uv@v3
  with:
    enable-cache: true
    cache-dependency-glob: "uv.lock"
```

---

## No Analog Found

| Item | Reason | Suggested approach |
|------|--------|--------------------|
| **SHA-256 checksum generation + release-body append** | `grep -rn sha256 .github/ scripts/` returns nothing | Use `shasum -a 256` (POSIX) / `Get-FileHash -Algorithm SHA256` (Windows) + `softprops/action-gh-release@v2` with `append_body: true`. Documented in release.yml pattern section above. |
| **Windows ffmpeg install in CI** | `release.yml` macOS uses `brew install ffmpeg`; Linux uses `awalsh128/cache-apt-pkgs-action`; Windows has no precedent | `choco install ffmpeg -y` on `windows-2022` (chocolatey is preinstalled on GH runners). Cache via `actions/cache` keyed on `runner.os + ffmpeg-version` if cold install is slow. |
| **SQLite fixture seeding for tests** | `tests/fixtures/` contains only JSON; no test touches `omnivoice.db` today | Ship a pre-migrated empty `.db` (~50 KB) built once by running `alembic upgrade head` against an empty file; commit the resulting binary. Alternative: build it at test-session start via a `conftest.py` fixture (slower but no binary in git). Recommend the former for reproducibility. |
| **Installer-bundle launch in release CI** | `scripts/smoke-test.sh` launches the *debug* binary from `target/debug/`; release.yml has never launched the *release* bundle | Patterns to adapt: `desktop-prod.sh` L154-193 (per-OS bundle discovery), `smoke-test.sh` L187-219 (boot + poll). Net-new: Windows `msiexec /i ... /quiet` install + post-install launch path. |
| **Workflow-step PowerShell variant of bash smoke loop** | All existing bash scripts are POSIX-only; nothing in repo targets Windows shell | Either translate the L196-219 loop to PowerShell `Invoke-WebRequest` + `Start-Sleep`, OR use `shell: bash` (GitHub runners ship Git Bash on Windows — works but slower). |

---

## Metadata

**Analog search scope:**
- `.github/workflows/` (3 files: ci.yml, release.yml, docker.yml)
- `.github/` (ISSUE_TEMPLATE/, pull_request_template.md)
- `scripts/` (16 files; focused on smoke-test.sh, desktop-prod.sh, package_for_friend.sh)
- `tests/` (21 .py files; focused on conftest.py, test_router_smoke.py, test_api.py)
- `tests/fixtures/` (2 JSON files)
- `backend/main.py` (health endpoint at L379-389)
- `backend/api/routers/system.py` (system info + sysinfo at L118-154, L340-368)
- `backend/api/routers/` (24 routers — confirmed `/health` is in main.py not a router)
- `backend.spec` (PyInstaller — confirms `backend/migrations/` ships in frozen bundle, relevant for fixture DB migration)
- `pyproject.toml` (pytest config, deps; confirmed alembic is available for DB seeding)
- `omnivoice_data/omnivoice.db` (live DB; introspected schema for fixture sizing)

**Files NOT analogous (intentionally skipped):**
- `tests/test_api.py` — too heavy; full mock-the-model coverage suite, not the smoke pattern. Only the `make_wav_bytes` helper is cited.
- `tests/test_issue_fixes.py` and other domain tests — feature tests, not smoke.
- `frontend/src-tauri/` Rust code — Phase 0 does not modify Rust.
- `backend/services/` — Phase 0 does not modify backend logic, only its boot surface (`/health`).

**Key live data points (for planner):**
- Backend port: 3900 (`backend/main.py` L428 comment; `lib.rs::BACKEND_PORT` mirror)
- Backend health URL: `http://127.0.0.1:3900/health`
- Tauri bundle identifier: `com.debpalash.omnivoice-studio`
- macOS bundle path: `frontend/src-tauri/target/{debug,release}/bundle/macos/OmniVoice Studio.app`
- Existing live DB: `omnivoice_data/omnivoice.db` (160 KB, 4 tables, schema captured above)
- Existing PR template path: `.github/pull_request_template.md` (lowercase — keep)
