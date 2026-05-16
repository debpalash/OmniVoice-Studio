---
phase: 00-gates
plan: 00
type: execute
wave: 1
mode: mvp
depends_on: []
files_modified:
  - scripts/seed-test-fixture.py
  - tests/fixtures/omnivoice_data/omnivoice.db
  - tests/fixtures/omnivoice_data/voices/test-voice/profile.json
  - tests/fixtures/omnivoice_data/voices/test-voice/sample.wav
  - tests/fixtures/omnivoice_data/README.md
  - tests/smoke/__init__.py
  - tests/smoke/test_boot_smoke.py
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - .github/pull_request_template.md
  - backend/main.py
autonomous: false
requirements: [GATE-01, GATE-02, GATE-03, GATE-04, GATE-05, GATE-06]

must_haves:
  truths:
    - "Phase 0 PR is open on GitHub from `ai-gsd-setup` (or child `phase-00-gates`) targeting `main`, never auto-merged from Claude's session"
    - "Every PR to `main` runs `pytest tests/smoke/` against the checked-in fixture on macOS-14, Windows-2022, and Ubuntu-22.04 and must be green to merge"
    - "A `tests/fixtures/omnivoice_data/` directory exists, totals ≤ 200 KB, is checked into git (no LFS), and the smoke test fails loudly if it is missing"
    - "On every tag push, `release.yml` boots the bundled installer per OS and asserts `/health` returns 200 within 60 s; failure prevents release publication"
    - "Every GitHub Release body carries SHA-256 checksums for every published artifact AND per-OS `SHA256SUMS-<label>.txt` files are attached as release assets (one per matrix leg — singular aggregate file deferred to v2 hardening per RESEARCH Pitfall #7)"
    - "PR template at `.github/pull_request_template.md` (lowercase, in place) documents the two-RC release cadence and the regression-fixture checklist line"
    - "PR #51 is merged into `main` after the new smoke matrix is green on its diff"
  artifacts:
    - path: "scripts/seed-test-fixture.py"
      provides: "Deterministic builder for tests/fixtures/omnivoice_data/"
      min_lines: 60
    - path: "tests/fixtures/omnivoice_data/omnivoice.db"
      provides: "Empty schema-initialized SQLite (no rows in history tables)"
      contains: "voice_profiles, generation_history, dub_history, studio_projects"
    - path: "tests/fixtures/omnivoice_data/voices/test-voice/profile.json"
      provides: "One voice_profiles row reference"
      contains: "test-voice"
    - path: "tests/fixtures/omnivoice_data/voices/test-voice/sample.wav"
      provides: "1-second 24 kHz mono silence, ≤ 50 KB"
    - path: "tests/smoke/test_boot_smoke.py"
      provides: "In-process FastAPI TestClient hit on /health + fixture-DB load"
      min_lines: 40
    - path: ".github/workflows/ci.yml"
      provides: "smoke-matrix job (macOS/Windows/Linux) running tests/smoke/"
    - path: ".github/workflows/release.yml"
      provides: "Per-OS installer smoke + SHA-256 publish step"
    - path: ".github/pull_request_template.md"
      provides: "RC cadence note + regression-fixture checklist line"
    - path: "backend/main.py"
      provides: "--health-check CLI flag (boots, polls /health, exits 0)"
      contains: "--health-check"
  key_links:
    - from: "tests/smoke/test_boot_smoke.py"
      to: "tests/fixtures/omnivoice_data/omnivoice.db"
      via: "OMNIVOICE_DATA_DIR env override before FastAPI import"
      pattern: "OMNIVOICE_DATA_DIR.*tests/fixtures/omnivoice_data"
    - from: ".github/workflows/ci.yml smoke-matrix"
      to: "tests/smoke/"
      via: "uv run pytest tests/smoke/ -q --tb=short"
      pattern: "pytest tests/smoke/"
    - from: ".github/workflows/release.yml installer-smoke step"
      to: "http://127.0.0.1:3900/health"
      via: "curl -sf in poll loop after launching bundle"
      pattern: "/health"
    - from: ".github/workflows/release.yml checksums step"
      to: "softprops/action-gh-release@v2"
      via: "append_body: true + files: SHA256SUMS"
      pattern: "softprops/action-gh-release"
---

<objective>
Phase 0 — Gates: the hard pre-condition gate for v0.3.x stabilization.

Lay six pieces of CI/release infrastructure (cross-platform smoke matrix, frozen regression fixture, installer smoke, SHA-256 checksums, PR template, open-PR landing) so every downstream phase ships on a runway that catches macOS/Windows regressions before they hit users.

Purpose: closes the gap that let multiple "stability" PRs ship with macOS/Windows regressions undetected (PITFALLS #1, #10). After Phase 0 merges and proves green on `main`, all other phases can open PRs.

Output: the seven artifacts in `must_haves.artifacts` above; PR #51 merged; Phase 0 PR opened (NOT merged from Claude's session — that's an explicit user action).
</objective>

## Phase Goal

**As a** OmniVoice maintainer, **I want to** know within minutes of opening a PR whether it boots clean on all three target OSes against a frozen regression fixture, **so that** no stability PR ever ships with an undetected macOS or Windows regression and every release publishes verifiable checksums.

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/00-gates/CONTEXT.md
@.planning/phases/00-gates/RESEARCH.md
@.planning/phases/00-gates/00-PATTERNS.md
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md

<!-- In-repo analogs the executor will copy from -->
@.github/workflows/ci.yml
@.github/workflows/release.yml
@.github/pull_request_template.md
@tests/conftest.py
@tests/test_router_smoke.py
@backend/main.py
@backend/core/db.py
@scripts/smoke-test.sh
</context>

<interfaces>
<!-- Key contracts the executor needs without re-exploring the codebase. -->

**FastAPI `/health` endpoint** — `backend/main.py` L379-389:
- Route: `GET /health` (server bound to `0.0.0.0:3900`)
- Response: `{"status": "ok", "device": <str>}` where device is `"cpu"`, `"cuda (...)"`, or `"mps"`
- Smoke test asserts `r.status_code == 200` and `"status" in r.json()` (do not assert exact `device` value — varies per runner)

**Backend entrypoint** — `backend/main.py` L425-430 (current):
```
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3900)
```
The new `--health-check` flag must be added INSIDE this `__main__` block (no new entrypoint file). On `--health-check`: spawn `uvicorn.run` in a daemon thread, poll `http://127.0.0.1:3900/health` with a 60 s timeout (5 s interval), print "OK" + exit 0 on success, print error + exit 1 on timeout or non-200.

**Test isolation env vars** (set BEFORE any `from main import app`):
```
OMNIVOICE_MODEL=test            # short-circuits 2.4 GB OmniVoice model load
OMNIVOICE_DISABLE_FILE_LOG=1    # don't write file logs to missing paths
OMNIVOICE_DATA_DIR=<fixture>    # points DB_PATH at the fixture's omnivoice.db
```
The first two are copied from `tests/test_router_smoke.py` L12-13. `OMNIVOICE_DATA_DIR` is the existing env var that `backend/core/config.py` reads to locate `omnivoice.db` (verify by `grep -n OMNIVOICE_DATA_DIR backend/core/config.py` before relying on the name — if the env var name differs, monkey-patch `core.config.DB_PATH` inside a pytest fixture instead).

**DB schema initializer** — `backend/core/db.py` L178 `init_db()`:
- Idempotent (uses `CREATE TABLE IF NOT EXISTS`)
- Reads target path from `backend.core.config.DB_PATH` at call time
- Creates all 8 tables: `voice_profiles`, `generation_history`, `dub_history`, `studio_projects`, `export_history`, `glossary_terms`, `jobs`, `job_events`
- NOTE: alembic `versions/` directory is empty (`.gitkeep` only) — do NOT use `alembic upgrade head`; call `init_db()` directly. CONTEXT.md's reference to "alembic-stamped" is superseded by this finding; record this in the fixture README.

**Conftest sys.path setup** — `tests/conftest.py` L1-7: prepends `backend/` to `sys.path`. `tests/smoke/` inherits this automatically (no per-subdir conftest needed). `from main import app` works.

**Cross-OS shell normalization** — every new workflow step that uses bash MUST declare `shell: bash` (Windows runners default to PowerShell). Pair with `set -euo pipefail` per `release.yml` L218.
</interfaces>

<tasks>

<!-- ═════════════════════════════════════════════════════════════════════ -->
<!--  SLICE A — In-process smoke baseline (local-only; unblocks Slice B)  -->
<!-- ═════════════════════════════════════════════════════════════════════ -->

<task type="auto" id="T0.A.1">
  <name>T0.A.1 — Build the fixture seed script</name>
  <files>scripts/seed-test-fixture.py, tests/fixtures/omnivoice_data/voices/test-voice/profile.json (regenerated), tests/fixtures/omnivoice_data/voices/test-voice/sample.wav (regenerated), tests/fixtures/omnivoice_data/omnivoice.db (regenerated), tests/fixtures/omnivoice_data/README.md</files>
  <behavior>
    - Running `uv run python scripts/seed-test-fixture.py` from repo root produces a deterministic fixture under `tests/fixtures/omnivoice_data/` with no other side effects.
    - The script is idempotent: re-running over an existing fixture replaces it cleanly.
    - Total fixture-directory size on disk ≤ 200 KB (verify with `du -sh tests/fixtures/omnivoice_data/`).
    - SQLite file contains all 8 tables created by `backend/core/db.py::init_db()`, with ZERO rows in history tables and exactly ONE row in `voice_profiles`.
  </behavior>
  <action>
    Create `scripts/seed-test-fixture.py` (Python ≥3.11) that does the following, in this order:

    1. Compute `FIX = repo_root / "tests/fixtures/omnivoice_data"`. If `FIX` exists, `shutil.rmtree(FIX)`. Re-create it plus `FIX / "voices/test-voice"`.

    2. Generate `FIX/voices/test-voice/sample.wav` — 1-second, 24 kHz, mono, 16-bit PCM silence. Use the in-stdlib `wave` + `struct` pattern from `tests/test_api.py` L31-41 (`make_wav_bytes`). Write file directly (don't use the in-memory helper as-is; reimplement inline to keep this script standalone — no test imports). Expected size ≈ 48 KB.

    3. Write `FIX/voices/test-voice/profile.json` with the minimal voice_profiles shape per the schema in `backend/core/db.py` L39-50:
       ```
       {
         "id": "test-voice",
         "name": "Test Voice (silence)",
         "ref_audio_path": "voices/test-voice/sample.wav",
         "ref_text": "silence",
         "instruct": "",
         "language": "Auto",
         "created_at": 1700000000.0,
         "locked_audio_path": "",
         "seed": null,
         "is_locked": 0
       }
       ```
       Use a fixed `created_at` (NOT `time.time()`) so the fixture is byte-deterministic for git diffs.

    4. Build `FIX/omnivoice.db`:
       - Insert `backend/` onto `sys.path` (mirror `tests/conftest.py` L1-7).
       - Set env `OMNIVOICE_DISABLE_FILE_LOG=1` BEFORE importing anything from backend.
       - `import core.config as cfg; cfg.DB_PATH = str(FIX / "omnivoice.db")` (monkey-patch the module-level constant — `init_db` reads it at call time per `backend/core/db.py` L13-14).
       - `from core.db import init_db, db_conn; init_db()` — creates all 8 tables.
       - Open `db_conn()` and `INSERT INTO voice_profiles` with the same fields as the JSON above (deterministic created_at).
       - Commit + close.

    5. Write `FIX/README.md` (5-10 lines): explains "this is a frozen regression fixture for PR smoke tests; do not edit by hand — regenerate via `uv run python scripts/seed-test-fixture.py`; alembic versions/ is empty so we use `backend.core.db.init_db()` directly; size budget ≤ 200 KB."

    6. At end of script, `print` the total bytes of `FIX/` (use `os.walk` + `sum(getsize)`) and `sys.exit(1)` if > 200 * 1024.

    Commit message: `test(00-gates): add seed-test-fixture.py + regression fixture (GATE-01)`
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && rm -rf tests/fixtures/omnivoice_data && uv run python scripts/seed-test-fixture.py && du -sh tests/fixtures/omnivoice_data/ && python3 -c "import sqlite3; c = sqlite3.connect('tests/fixtures/omnivoice_data/omnivoice.db'); print(sorted(r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\"))); print('profiles:', c.execute('SELECT id, name FROM voice_profiles').fetchall())"</automated>
  </verify>
  <done>Script exits 0; `du` prints ≤ 200 KB; SQLite table list includes voice_profiles, generation_history, dub_history, studio_projects (plus the other 4); voice_profiles contains exactly one row with id='test-voice'.</done>
</task>

<task type="auto" id="T0.A.2">
  <name>T0.A.2 — Write the PR smoke test</name>
  <files>tests/smoke/__init__.py, tests/smoke/test_boot_smoke.py</files>
  <behavior>
    - `uv run pytest tests/smoke/ -q --tb=short` returns 0 and runs in < 30 s on a warm uv cache.
    - All assertions pass against the fixture produced by T0.A.1.
    - Test fails (clearly) if `tests/fixtures/omnivoice_data/` is missing — surfaces "fixture missing — run scripts/seed-test-fixture.py" message.
  </behavior>
  <action>
    Create `tests/smoke/__init__.py` (empty file, so pytest treats `tests/smoke/` as a package).

    Create `tests/smoke/test_boot_smoke.py` modeled directly on `tests/test_router_smoke.py` L9-32:

    1. At module top (BEFORE any backend imports), set:
       ```
       os.environ.setdefault("OMNIVOICE_MODEL", "test")
       os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")
       ```

    2. Compute `FIXTURE = Path(__file__).resolve().parents[1] / "fixtures/omnivoice_data"`. If `not FIXTURE.exists()`, `pytest.fail("Fixture missing — run: uv run python scripts/seed-test-fixture.py")` at import time (so the failure is loud, not deferred).

    3. Point the backend at the fixture BEFORE importing app: `os.environ.setdefault("OMNIVOICE_DATA_DIR", str(FIXTURE))`. The env var name is verified — `backend/core/config.py:5` reads `custom_dir = os.environ.get("OMNIVOICE_DATA_DIR")`. No monkey-patch fallback needed.

    4. Module-scope `client` fixture: `from fastapi.testclient import TestClient; from main import app; return TestClient(app)` — verbatim from `test_router_smoke.py` L17-22.

    5. Tests (target: 4 tests, ALL must pass):
       - `test_health_returns_ok(client)`: `r = client.get("/health"); assert r.status_code == 200; body = r.json(); assert body["status"] == "ok"; assert "device" in body`
       - `test_profiles_endpoint_lists_fixture_voice(client)`: `r = client.get("/profiles"); assert r.status_code == 200; data = r.json(); assert isinstance(data, list); assert any(p.get("id") == "test-voice" for p in data), f"expected fixture profile, got {data}"`
       - `test_system_info_includes_data_dir(client)`: `r = client.get("/system/info"); assert r.status_code == 200; assert "data_dir" in r.json()` (smoke that the data-dir wiring resolved).
       - `test_history_endpoint_empty(client)`: `r = client.get("/history"); assert r.status_code == 200; assert r.json() == []` (validates fixture has zero history rows AND the endpoint walks the fixture DB).

    Do NOT add subprocess-boot variants (those belong in release.yml installer smoke, not PR smoke).

    Commit message: `test(00-gates): add tests/smoke/test_boot_smoke.py (GATE-01)`
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && uv run pytest tests/smoke/ -q --tb=short</automated>
  </verify>
  <done>4 passing tests, exit 0, total time < 30 s on a warm cache.</done>
</task>

<task type="checkpoint:human-verify" id="T0.A.3" gate="blocking">
  <name>T0.A.3 — User: confirm local smoke is green before touching CI</name>
  <what-built>Slice A delivers the fixture (T0.A.1) and the in-process smoke test (T0.A.2) entirely locally. No CI changes yet.</what-built>
  <how-to-verify>
    1. Run: `uv run pytest tests/smoke/ -q --tb=short` from repo root.
    2. Confirm: 4 passed, no warnings about missing fixture, total time well under 30 s.
    3. Run: `du -sh tests/fixtures/omnivoice_data/` — confirm ≤ 200 KB.
    4. Run: `git status --short tests/ scripts/` — confirm the expected files are staged/present.
    5. Optional: open `tests/fixtures/omnivoice_data/omnivoice.db` in `sqlite3` CLI and run `.tables` — should list all 8.
  </how-to-verify>
  <resume-signal>Type "approved" to proceed to Slice B (CI matrix), or describe issues.</resume-signal>
</task>

<!-- ═════════════════════════════════════════════════════════════════════ -->
<!--  SLICE B — Cross-platform CI matrix (GATE-02)                        -->
<!-- ═════════════════════════════════════════════════════════════════════ -->

<task type="auto" id="T0.B.1">
  <name>T0.B.1 — Add smoke-matrix job to ci.yml (3 OSes)</name>
  <files>.github/workflows/ci.yml</files>
  <behavior>
    - New `smoke-matrix` job runs on `macos-14`, `windows-2022`, `ubuntu-22.04` on every PR to main and push to main.
    - Each matrix leg installs Python 3.11 + uv (cache enabled) + ffmpeg + libsndfile, then runs `uv run pytest tests/smoke/ -q --tb=short`.
    - Job declares `needs: test` so the existing Linux fast-tests gate the slower 3-OS matrix.
    - `fail-fast: false` so a Windows-only failure doesn't mask a macOS-only failure.
    - All third-party actions are pinned to a stable major (`@v4`, `@v3`, `@v5`); leave the existing `awalsh128/cache-apt-pkgs-action@latest` alone (CONTEXT.md decisions, out-of-scope item).
  </behavior>
  <action>
    Edit `.github/workflows/ci.yml`. Append a new `smoke-matrix` job AFTER the existing `tauri-cross-platform` job (after current EOF). The job is structurally a hybrid of the `test` job (Python setup at L26-59) and the `tauri-cross-platform` matrix (L105-121 OS pins, `fail-fast: false` shape).

    Use this skeleton (copy verbatim, then fine-tune per the existing `ci.yml` style):

    ```yaml
      # ── Cross-platform Python runtime smoke (Phase 0 GATE-02) ───────────────
      # Loads the frozen tests/fixtures/omnivoice_data/ fixture and boots the
      # FastAPI app in-process via TestClient on macOS/Windows/Linux. Catches
      # platform-specific Python import / path bugs that the Linux-only `test`
      # job above misses. Narrow scope (tests/smoke/ only) — full pytest stays
      # on Linux until Phase 1's INST-01 lands setuptools for WhisperX.
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

          # ffmpeg + libsndfile are needed by soundfile / audio fixtures even
          # though the silence WAV doesn't decode anything heavy — keeps test
          # collection from import-erroring on optional audio modules.
          - name: System deps (macOS)
            if: runner.os == 'macOS'
            run: brew install ffmpeg libsndfile || true

          - name: System deps (Windows)
            if: runner.os == 'Windows'
            shell: bash
            run: |
              choco install ffmpeg -y --no-progress
              ffmpeg -version

          - name: System deps (Linux)
            if: runner.os == 'Linux'
            uses: awalsh128/cache-apt-pkgs-action@latest
            with:
              packages: ffmpeg libsndfile1
              version: 1.0

          - name: Install Python deps
            run: uv sync

          - name: Run smoke tests
            run: uv run pytest tests/smoke/ -q --tb=short
    ```

    Do NOT modify the existing `test` or `tauri-cross-platform` jobs. Keep all existing comments. The new job is purely additive.

    Commit message: `ci(00-gates): add cross-platform smoke matrix (GATE-02)`
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && python3 -c "import yaml; d = yaml.safe_load(open('.github/workflows/ci.yml')); assert 'smoke-matrix' in d['jobs'], 'smoke-matrix job missing'; sm = d['jobs']['smoke-matrix']; assert sm['needs'] == 'test'; oses = sorted(m['os'] for m in sm['strategy']['matrix']['include']); assert oses == ['macos-14', 'ubuntu-22.04', 'windows-2022'], oses; assert sm['strategy']['fail-fast'] is False; print('ci.yml smoke-matrix shape OK')"</automated>
  </verify>
  <done>YAML parses; `smoke-matrix` job present with `needs: test`, all 3 OS pins exact, `fail-fast: false`, runs `uv run pytest tests/smoke/`.</done>
</task>

<task type="auto" id="T0.B.2">
  <name>T0.B.2 — Commit Slices A+B and push to ai-gsd-setup</name>
  <files>(no file edits — git operations only)</files>
  <behavior>
    - Three atomic commits land on `ai-gsd-setup` in order: fixture/script → smoke test → CI matrix.
    - Push to origin succeeds with no force-push.
  </behavior>
  <action>
    Stage and commit in three separate `git add` + `git commit` invocations (do NOT bundle):

    1. `git add scripts/seed-test-fixture.py tests/fixtures/omnivoice_data/` then commit with message `test(00-gates): add seed-test-fixture.py + regression fixture (GATE-01)`.
    2. `git add tests/smoke/` then commit with message `test(00-gates): add tests/smoke/test_boot_smoke.py (GATE-01)`.
    3. `git add .github/workflows/ci.yml` then commit with message `ci(00-gates): add cross-platform smoke matrix (GATE-02)`.

    Then `git push origin ai-gsd-setup` (no `--force`). Do NOT open the PR yet — that's T0.G.1 after all slices land.

    If any commit fails a pre-commit hook, fix the underlying issue and create a NEW commit (per CLAUDE Git Safety Protocol — never `--amend`).
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && git log --oneline -5 ai-gsd-setup | head -5 && git status --short</automated>
  </verify>
  <done>Three new commits at HEAD with the conventional-commit prefixes above; working tree clean; `origin/ai-gsd-setup` includes them.</done>
</task>

<task type="checkpoint:human-verify" id="T0.B.3" gate="blocking">
  <name>T0.B.3 — User: confirm smoke-matrix is green on all 3 OSes</name>
  <what-built>Slice B pushed the new `smoke-matrix` job to `ai-gsd-setup`. GitHub Actions will run it on the push event (and on any open PR from that branch).</what-built>
  <how-to-verify>
    1. Run: `gh run list --branch ai-gsd-setup --workflow ci.yml --limit 3` and pick the latest run.
    2. Run: `gh run view <run-id>` — confirm `Smoke (macOS)`, `Smoke (Windows)`, `Smoke (Linux)` are ALL green.
    3. If any leg is red, paste the failing step's log into the next turn. Common first-PR failures: missing ffmpeg path on Windows (try `where ffmpeg` step), libsndfile linking on macOS arm64, file-encoding mismatch on Windows (set `PYTHONUTF8=1`).
    4. Expect total wall time ≈ 5-10 min cold, ≈ 2-3 min warm (uv cache).
  </how-to-verify>
  <resume-signal>Type "approved" to proceed to Slice D (release.yml installer smoke), or paste the failing leg's log for triage. Note: per the dependency graph in `<verification>`, Slice C (PR #51 landing) runs LAST — after Slice G merges the smoke-matrix into `main` — not after Slice B.</resume-signal>
</task>

<!-- ═════════════════════════════════════════════════════════════════════ -->
<!--  SLICE C — PR #51 landing (GATE-06)                                  -->
<!--  NOTE: runs LAST per CONTEXT.md L86 — depends on T0.G.2 completing   -->
<!-- ═════════════════════════════════════════════════════════════════════ -->

<task type="auto" id="T0.C.1">
  <name>T0.C.1 — Investigate PR #51 inconclusive check</name>
  <files>(no file edits — gh CLI investigation only)</files>
  <behavior>
    - Reports definitively whether the inconclusive check is transient or a real regression.
    - Decides one of: re-run (transient), block on a fix (real regression), or escalate to user (ambiguous).
  </behavior>
  <action>
    **Step 0 — GATE-06 prereq check (RESEARCH Pitfall #9).** Before touching #51, confirm sibling PRs #53 and #61 are merged. Run:

    ```
    gh pr view 53 61 --json number,state,mergedAt --jq '.[] | select(.state != "MERGED") | "OPEN: \(.number)"'
    ```

    If output is non-empty, STOP and surface to user via T0.C.2 checkpoint with the open PR numbers — GATE-06 cannot lock until all three are merged.

    Then run: `gh pr checks 51 --json name,conclusion,bucket,link,detailsUrl`.

    Triage rules:
    - If all checks are `success` or `skipped`: nothing to do, mark slice as ready for T0.C.2.
    - If exactly one check is `null` / `pending` / `neutral`: `gh run rerun <id> --failed` against that workflow run; wait ~5 min; re-check. If it goes green, proceed.
    - If a check is genuinely `failure`: capture the failing step name + first 50 log lines via `gh run view <id> --log-failed | head -100`, summarize, and surface to the user via the T0.C.2 checkpoint below. Do NOT attempt to fix PR #51's diff yourself — it's outside Phase 0 scope.

    Do not merge anything in this task. Just report state.
  </action>
  <verify>
    <automated>gh pr checks 51 --json conclusion 2>&1 | head -20</automated>
  </verify>
  <done>Report posted in the executor's task output: either "all green, ready to merge" or "needs user input — &lt;reason&gt;".</done>
</task>

<task type="checkpoint:human-action" id="T0.C.2" gate="blocking">
  <name>T0.C.2 — [user-required] Rebase + merge PR #51</name>
  <what-built>Slice B's smoke matrix is green on `ai-gsd-setup`. **Prereq: T0.G.2 must complete first** so the smoke-matrix lives on `main` and applies to #51's checks (Truth 7: "PR #51 is merged into main AFTER the new smoke matrix is green on its diff").</what-built>
  <how-to-verify>
    USER MUST EXECUTE (Claude cannot merge to main):

    **Prereq verify (do this FIRST):** Confirm Phase 0 PR (opened by T0.G.1, merged by T0.G.2) is already in `main`:
    ```
    git fetch origin main && git log origin/main --oneline | grep -E "smoke-matrix|Phase 0" | head -3
    ```
    If empty, STOP — go back and complete Slice G first. Truth 7 requires the matrix to be on `main` before #51 merges.

    Then:
    1. Run: `gh pr view 51 --web` to review the diff one more time.
    2. Re-trigger CI on #51 so the now-on-`main` smoke-matrix runs against #51's diff: comment `/rerun` or push an empty commit to the branch.
    3. Run: `gh pr checks 51` — confirm green, INCLUDING the new `smoke-matrix` job on all three OSes.
    4. If #51 is behind main, request a rebase: `gh pr edit 51` or comment "/rebase". Wait for green.
    5. Merge: `gh pr merge 51 --squash --delete-branch` (or `--merge` per repo convention).
    6. Confirm: `gh pr view 51 --json state` shows `"MERGED"`.

    Reason this is user-required: pushing to or merging into `main` is explicitly out of Claude's session per CLAUDE.md / CONTEXT.md.
  </how-to-verify>
  <resume-signal>Type "merged" (or "deferred — &lt;reason&gt;" if you want to land PR #51 later) to close out Phase 0.</resume-signal>
</task>

<!-- ═════════════════════════════════════════════════════════════════════ -->
<!--  SLICE D — Installer smoke for release (GATE-03)                     -->
<!-- ═════════════════════════════════════════════════════════════════════ -->

<task type="auto" id="T0.D.1">
  <name>T0.D.1 — Add `--health-check` CLI flag to backend entrypoint</name>
  <files>backend/main.py</files>
  <behavior>
    - `python backend/main.py --health-check` boots the FastAPI app on port 3900, polls `http://127.0.0.1:3900/health` every 5 s up to 60 s, prints `OK` + exits 0 on first 200 response.
    - On timeout or non-200, prints a clear error to stderr and exits 1.
    - Default invocation (`python backend/main.py` with no args) behavior is UNCHANGED — still runs `uvicorn.run(app, host="0.0.0.0", port=3900)` until interrupted.
    - No new dependencies introduced (use stdlib `argparse`, `threading`, `urllib.request`, `time`, `sys`).
  </behavior>
  <action>
    Modify `backend/main.py` around L425-430 (the `if __name__ == "__main__":` block). Replace ONLY that block with:

    ```python
    if __name__ == "__main__":
        import argparse
        import sys
        import threading
        import time
        import urllib.request
        import uvicorn

        parser = argparse.ArgumentParser(prog="omnivoice-backend")
        parser.add_argument(
            "--health-check",
            action="store_true",
            help="Boot the server, poll /health, exit 0 on success / 1 on timeout. "
                 "Used by the release-time installer smoke step in .github/workflows/release.yml.",
        )
        args, _unknown = parser.parse_known_args()

        if args.health_check:
            HEALTH_URL = "http://127.0.0.1:3900/health"
            TIMEOUT_S = 60
            INTERVAL_S = 5

            def _serve():
                # log_level="warning" silences the per-request access log spam
                # so the smoke output stays readable in GH Actions.
                uvicorn.run(app, host="127.0.0.1", port=3900, log_level="warning")

            t = threading.Thread(target=_serve, daemon=True)
            t.start()

            elapsed = 0
            while elapsed < TIMEOUT_S:
                try:
                    with urllib.request.urlopen(HEALTH_URL, timeout=2) as resp:
                        if resp.status == 200:
                            print(f"OK — /health responded 200 after {elapsed}s", flush=True)
                            sys.exit(0)
                except Exception:
                    pass
                time.sleep(INTERVAL_S)
                elapsed += INTERVAL_S

            print(
                f"FAIL — /health did not respond 200 within {TIMEOUT_S}s",
                file=sys.stderr, flush=True,
            )
            sys.exit(1)

        # Port 3900 picked to dodge common 8000 conflicts (Django/Rails/Jupyter).
        # Rust sidecar launcher in lib.rs::BACKEND_PORT must stay in sync.
        uvicorn.run(app, host="0.0.0.0", port=3900)
    ```

    Preserve the trailing comment about port 3900 + lib.rs::BACKEND_PORT (do not delete it).

    Commit message: `feat(00-gates): add --health-check CLI flag to backend entrypoint (GATE-03)`
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && timeout 75 uv run python backend/main.py --health-check; echo "exit=$?"</automated>
  </verify>
  <done>Command prints `OK — /health responded 200 after Ns` (N ≤ 60) and exits 0. If it hangs &gt; 75 s the wrapper `timeout` kills it (still a fail). If exit 1 with "FAIL" line, investigate boot — likely a missing dep in the dev environment, not in this task's scope.</done>
</task>

<task type="auto" id="T0.D.2">
  <name>T0.D.2 — Add per-OS installer-smoke step to release.yml</name>
  <files>.github/workflows/release.yml</files>
  <behavior>
    - On every tag push (and `workflow_dispatch`), the `build` matrix runs an installer-smoke step AFTER `Build + release (Tauri)` (currently L334-353) on each of macos-14 / windows-2022 / ubuntu-22.04.
    - Per OS: locate the just-built bundle → install/mount → launch with `--health-check` → assert exit 0 → clean up. Failure fails the matrix leg and blocks release publication (because subsequent steps depend on success).
    - Timeout per OS: 60 s for health-check + reasonable mount/install overhead — wrap whole step in `timeout-minutes: 5`.
  </behavior>
  <action>
    Edit `.github/workflows/release.yml`. AFTER the `Build + release (Tauri)` step (currently ending at L353), and BEFORE the implicit job end, INSERT three new steps gated by `runner.os`. Each step is matrix-leg-specific.

    Place this block as the next step after L353:

    ```yaml
          # ── Installer smoke (Phase 0 GATE-03) ─────────────────────────────
          # Boot the just-built bundle on this matrix leg, poll /health, fail
          # the release if it doesn't come up. Catches bundle-only regressions
          # (PyInstaller missing-module, Tauri sidecar path mismatch, etc.)
          # that the in-process smoke matrix on ci.yml cannot see.
          - name: Installer smoke (macOS)
            if: runner.os == 'macOS'
            timeout-minutes: 5
            shell: bash
            run: |
              set -euo pipefail
              DMG=$(find frontend/src-tauri/target/${{ matrix.rust_target }}/release/bundle/dmg -name "*.dmg" | head -1)
              echo "Smoke-testing DMG: $DMG"
              MOUNT=$(hdiutil attach -nobrowse -readonly "$DMG" | tail -1 | awk '{print $3}')
              APP=$(find "$MOUNT" -maxdepth 2 -name "*.app" | head -1)
              # RESEARCH Pitfall #5: do NOT launch the Tauri WebView shell on a headless runner — it hangs.
              # The `--health-check` flag lives in backend/main.py (Python), not the Rust WebView main.
              # Strategy: invoke the bundled Python backend directly, bypassing Tauri's window code.
              BACKEND=$(find "$APP/Contents" -type f \( -name 'backend' -o -name 'backend.app' -o -name 'main.py' \) -perm +111 2>/dev/null | head -1)
              if [ -z "$BACKEND" ]; then
                # Fallback: try the PyInstaller sidecar location Tauri uses.
                BACKEND=$(find "$APP/Contents/Resources" -type f \( -name 'backend*' -o -name 'omnivoice*' \) -perm +111 2>/dev/null | head -1)
              fi
              if [ -z "$BACKEND" ]; then
                echo "FAIL — could not locate bundled backend binary in $APP. Contents:"
                find "$APP/Contents" -type f -perm +111 | head -30
                hdiutil detach "$MOUNT" || true
                exit 1
              fi
              echo "Launching bundled backend: $BACKEND --health-check"
              "$BACKEND" --health-check
              EXIT=$?
              hdiutil detach "$MOUNT" || true
              exit $EXIT

          - name: Installer smoke (Windows)
            if: runner.os == 'Windows'
            timeout-minutes: 5
            shell: bash
            run: |
              set -euo pipefail
              MSI=$(find frontend/src-tauri/target/${{ matrix.rust_target }}/release/bundle/msi -name "*.msi" | head -1)
              echo "Smoke-testing MSI: $MSI"
              # /quiet = no UI, /norestart = don't reboot the runner if a dep asks
              msiexec.exe //i "$(cygpath -w "$MSI")" //quiet //norestart
              # Tauri installs to "Program Files\OmniVoice Studio\..." by default. Backend is a sidecar binary
              # (RESEARCH Pitfall #5) — not the Tauri WebView .exe — so locate by name pattern.
              BACKEND=$(find "/c/Program Files/OmniVoice Studio" -type f \( -name 'backend.exe' -o -name 'omnivoice-backend.exe' -o -name 'main.exe' \) 2>/dev/null | head -1)
              if [ -z "$BACKEND" ]; then
                echo "FAIL — bundled backend .exe not found under C:/Program Files/OmniVoice Studio. Contents:"
                find "/c/Program Files/OmniVoice Studio" -type f -name '*.exe' | head -20
                exit 1
              fi
              echo "Launching bundled backend: $BACKEND --health-check"
              "$BACKEND" --health-check &
              BACKEND_PID=$!
              # Wait for completion (--health-check is a short-lived, exits-after-200 invocation)
              wait $BACKEND_PID
              EXIT=$?
              # RESEARCH Pitfall #2: cleanup orphaned PyInstaller child processes on port 3900.
              # Safe on GH-hosted ephemeral runners; REQUIRED if/when we move to self-hosted Windows.
              taskkill //F //T //PID $BACKEND_PID 2>/dev/null || echo "backend process already exited cleanly"
              exit $EXIT

          - name: Installer smoke (Linux)
            if: runner.os == 'Linux'
            timeout-minutes: 5
            shell: bash
            run: |
              set -euo pipefail
              # Use the AppImage — single-file, no installer needed.
              APPIMAGE=$(find frontend/src-tauri/target/${{ matrix.rust_target }}/release/bundle/appimage -name "*.AppImage" | head -1)
              echo "Smoke-testing AppImage: $APPIMAGE"
              chmod +x "$APPIMAGE"
              # GH runners have no FUSE — extract before running (mirrors APPIMAGE_EXTRACT_AND_RUN=1 used at build time).
              EXTRACT_DIR="$(mktemp -d)"
              cd "$EXTRACT_DIR"
              "$APPIMAGE" --appimage-extract >/dev/null
              # Tauri's AppRun lives at squashfs-root/AppRun; the actual binary is in squashfs-root/usr/bin/
              BIN=$(find squashfs-root -type f -name "OmniVoice Studio" -o -name "omnivoice-studio" 2>/dev/null | head -1)
              if [ -z "$BIN" ]; then
                BIN="$EXTRACT_DIR/squashfs-root/AppRun"
              fi
              echo "Launching under xvfb-run: $BIN --health-check"
              sudo apt-get install -y xvfb >/dev/null 2>&1 || true
              xvfb-run -a "$BIN" --health-check
    ```

    Notes for the executor:
    - The bundle paths are CONTEXT.md / PATTERNS.md sourced; if `tauri-action` resolves to a different output dir, adjust the `find` roots after a dry-run (T0.D.3 catches this).
    - The macOS step uses `find ... | head -1` — if there are multiple DMGs, that picks the first; OK for now.
    - The Linux step assumes `xvfb` is needed; the binary may exit cleanly without a display if `--health-check` does not touch the WebView (the Python backend doesn't), but `xvfb-run` is cheap insurance.
    - DO NOT add steps that touch the `latest.json` updater payload — `tauri-action` owns that.

    Commit message: `ci(00-gates): add per-OS installer smoke to release.yml (GATE-03)`
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && python3 -c "import yaml; d = yaml.safe_load(open('.github/workflows/release.yml')); steps = d['jobs']['build']['steps']; names = [s.get('name', '') for s in steps]; assert 'Installer smoke (macOS)' in names, names; assert 'Installer smoke (Windows)' in names; assert 'Installer smoke (Linux)' in names; print('release.yml installer-smoke steps present')"</automated>
  </verify>
  <done>YAML parses; all three `Installer smoke (...)` steps present in `build` job; each gated by `runner.os`; each has `timeout-minutes: 5`.</done>
</task>

<task type="checkpoint:human-action" id="T0.D.3" gate="blocking">
  <name>T0.D.3 — [user-required] Dry-run installer smoke via workflow_dispatch</name>
  <what-built>Slice D wired the `--health-check` flag (T0.D.1) and the per-OS installer-smoke steps (T0.D.2). Now we exercise it without cutting a real release.</what-built>
  <how-to-verify>
    USER MUST EXECUTE (running release.yml requires push permissions to actions):
    1. Push these commits to `ai-gsd-setup` (or the working branch).
    2. Run: `gh workflow run release.yml --ref ai-gsd-setup -f draft=true`
       (`workflow_dispatch` is enabled per release.yml L24-29; `draft=true` keeps it from publishing.)
    3. Watch: `gh run watch` (or `gh run list --workflow release.yml --limit 1` → `gh run view <id>`).
    4. Confirm: for each of the 3 matrix legs, the `Installer smoke (<OS>)` step exits 0 and the prior `Build + release (Tauri)` step is green.
    5. If a smoke step fails: capture `gh run view <id> --log-failed` for the failing leg, paste in next turn. Common first-run failures: bundle path mismatch (adjust `find` root), missing xvfb on Linux runner, MSI install location differs from "Program Files\OmniVoice Studio" (adjust `EXE` resolution).

    Reason this is user-required: `workflow_dispatch` is per-user gated; Claude cannot trigger it from this session without your auth.
  </how-to-verify>
  <resume-signal>Type "approved" to proceed to Slice E (checksums), or paste the failing leg's log for triage.</resume-signal>
</task>

<!-- ═════════════════════════════════════════════════════════════════════ -->
<!--  SLICE E — SHA-256 checksums in release body (GATE-05)               -->
<!-- ═════════════════════════════════════════════════════════════════════ -->

<task type="auto" id="T0.E.1">
  <name>T0.E.1 — Compute + publish SHA-256 checksums in release.yml</name>
  <files>.github/workflows/release.yml</files>
  <behavior>
    - On every tag push (NOT `workflow_dispatch` — see condition below), each matrix leg computes SHA-256 of every artifact it built, writes `SHA256SUMS-<label>.txt`, AND appends the same content to the release body.
    - A separate `SHA256SUMS-<label>.txt` file is attached as a release asset (so users can `shasum -c SHA256SUMS-macOS.txt` to verify).
    - The append uses `softprops/action-gh-release@v2` with `append_body: true` — does NOT replace `tauri-action`'s release body or `Extract CHANGELOG section`'s contents.
    - Skipped on `workflow_dispatch` runs (no release to attach to).
  </behavior>
  <action>
    Edit `.github/workflows/release.yml`. AFTER the new installer-smoke step from T0.D.2, INSERT two new steps:

    ```yaml
          # ── Compute SHA-256 checksums (Phase 0 GATE-05) ───────────────────
          # Native OS tools: shasum -a 256 (POSIX) / Get-FileHash (Windows).
          # Writes SHA256SUMS-<label>.txt for the user-verifiable path AND
          # captures the content into $GITHUB_OUTPUT for body append.
          - name: Compute SHA-256 checksums
            if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
            id: checksums
            shell: bash
            run: |
              set -euo pipefail
              BUNDLE_DIR="frontend/src-tauri/target/${{ matrix.rust_target }}/release/bundle"
              OUT="SHA256SUMS-${{ matrix.label }}.txt"

              # Gather artifact paths per matrix leg's `bundles` (msi/app/dmg/deb/appimage/updater).
              # `find` is portable across all three runners (Git Bash on Windows).
              mapfile -t ARTIFACTS < <(find "$BUNDLE_DIR" -type f \
                \( -name "*.dmg" -o -name "*.app.tar.gz" -o -name "*.app.tar.gz.sig" \
                   -o -name "*.msi" -o -name "*.msi.sig" \
                   -o -name "*.AppImage" -o -name "*.AppImage.sig" \
                   -o -name "*.deb" \) 2>/dev/null | sort)

              if [ ${#ARTIFACTS[@]} -eq 0 ]; then
                echo "FAIL — no artifacts found under $BUNDLE_DIR"
                find "$BUNDLE_DIR" -type f | head -50
                exit 1
              fi

              # shasum is available on macOS by default, on ubuntu-22.04 (perl pkg),
              # and on windows-2022 Git Bash. Falls back to sha256sum on Linux.
              if command -v shasum >/dev/null 2>&1; then
                HASHER="shasum -a 256"
              else
                HASHER="sha256sum"
              fi

              {
                echo "### ${{ matrix.label }} artifacts"
                echo ""
                echo '```'
                for f in "${ARTIFACTS[@]}"; do
                  # Strip the long bundle prefix from the printed path for readability;
                  # the hash itself is computed against the full file.
                  ( cd "$(dirname "$f")" && $HASHER "$(basename "$f")" )
                done
                echo '```'
                echo ""
              } | tee "$OUT"

              echo "checksums_file=$OUT" >> "$GITHUB_OUTPUT"

          - name: Append checksums to release + attach SHA256SUMS file
            if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
            uses: softprops/action-gh-release@v2
            with:
              tag_name: ${{ github.ref_name }}
              append_body: true
              body_path: ${{ steps.checksums.outputs.checksums_file }}
              files: ${{ steps.checksums.outputs.checksums_file }}
              fail_on_unmatched_files: true
    ```

    Notes:
    - `softprops/action-gh-release@v2` is NEW to the repo — flagged by RESEARCH.md Package Legitimacy Audit; T0.E.2 is a checkpoint that handles slopcheck verification (slopcheck was unavailable when RESEARCH.md was written).
    - The `if:` condition prevents this step from running on `workflow_dispatch` (no release exists for an arbitrary ref).
    - `fail_on_unmatched_files: true` makes it fail loudly if the file path didn't resolve, vs. silently appending nothing.

    Commit message: `ci(00-gates): publish SHA-256 checksums in release body + as asset (GATE-05)`
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && python3 -c "import yaml; d = yaml.safe_load(open('.github/workflows/release.yml')); steps = d['jobs']['build']['steps']; names = [s.get('name', '') for s in steps]; assert 'Compute SHA-256 checksums' in names; assert 'Append checksums to release + attach SHA256SUMS file' in names; sof = next(s for s in steps if s.get('name') == 'Append checksums to release + attach SHA256SUMS file'); assert sof['uses'] == 'softprops/action-gh-release@v2'; assert sof['with']['append_body'] is True; print('checksum steps OK')"</automated>
  </verify>
  <done>YAML parses; both new steps present with correct `if:` gating, correct action pin, `append_body: true`, `fail_on_unmatched_files: true`.</done>
</task>

<task type="checkpoint:human-verify" id="T0.E.2" gate="blocking">
  <name>T0.E.2 — [user-required] Verify softprops/action-gh-release@v2 legitimacy + dry-run on draft release</name>
  <what-built>Slice E added SHA-256 publishing using `softprops/action-gh-release@v2` — a third-party action NEW to this repo (RESEARCH.md flagged this for human-verify since slopcheck was unavailable).</what-built>
  <how-to-verify>
    USER MUST EXECUTE:
    1. **Legitimacy check:** open https://github.com/softprops/action-gh-release in browser. Confirm: 4k+ stars, active maintenance, owner `softprops` (Mario Pareja, well-known GH community member), v2 release notes mention `append_body`. If anything looks off, type "abort" instead of "approved".

    2. **Dry-run on draft release:** the SHA-256 steps are gated on `github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')`, so a `workflow_dispatch` won't exercise them. Two options:
       a. (Lower risk) Temporarily remove the `if:` guard on a branch, run `gh workflow run release.yml --ref ai-gsd-setup -f draft=true`, confirm the checksum content prints in the runner log + the `softprops` step uploads to the draft release (you can manually delete the draft after). Then restore the guard.
       b. (Higher risk) Push a throwaway tag like `v0.0.0-rc-test`, let it run end-to-end, then `gh release delete v0.0.0-rc-test --yes` and `git push --delete origin v0.0.0-rc-test`.

    3. **Verify the release body shows checksums** under each matrix leg's `### macOS artifacts` / `### Windows artifacts` / `### Linux artifacts` header.

    4. **Verify the SHA256SUMS-*.txt files** are attached as release assets and that `shasum -a 256 -c SHA256SUMS-macOS.txt` (run locally against the downloaded artifact) succeeds.

    Reason this is user-required: same as T0.D.3 (workflow_dispatch + tag push need your auth) AND it ratifies the new third-party action per the slopcheck protocol.
  </how-to-verify>
  <resume-signal>Type "approved" to proceed to Slice F (PR template), or "abort — &lt;reason&gt;" to stop here.</resume-signal>
</task>

<!-- ═════════════════════════════════════════════════════════════════════ -->
<!--  SLICE F — PR template (GATE-04)                                     -->
<!-- ═════════════════════════════════════════════════════════════════════ -->

<task type="auto" id="T0.F.1">
  <name>T0.F.1 — Extend pull_request_template.md with RC cadence + fixture checklist</name>
  <files>.github/pull_request_template.md</files>
  <behavior>
    - Existing sections (Summary, Changes, Type, Testing, Checklist, Screenshots) are PRESERVED with no edits to their wording or emoji conventions.
    - One line added to `## Type` for release-prep.
    - Two new checklist items added to `## Checklist`.
    - One new section `## Release cadence (read once per RC)` inserted BEFORE the existing `## Screenshots` section, explaining the two-RC cadence.
    - File remains lowercase `pull_request_template.md` (renaming to uppercase orphans review history per PATTERNS.md L20).
  </behavior>
  <action>
    Modify `.github/pull_request_template.md` in place via small, surgical edits (DO NOT rewrite the file):

    1. In `## Type` (current L13-21), append after the last checkbox (line with `- [ ] 🔧 CI / Build`):
       ```
       - [ ] 🚀 Release prep (RC or final)
       ```

    2. In `## Checklist` (current L28-33), append after the last existing checkbox (the version-sync line):
       ```
       - [ ] If this PR changes runtime behavior, the regression fixture at `tests/fixtures/omnivoice_data/` still loads green on the `smoke-matrix` CI job (macOS + Windows + Linux)
       - [ ] If this is part of a release, I've read the "Release cadence" section below and confirmed this PR targets the right RC
       ```

    3. Insert a new section BEFORE the existing `## Screenshots` section (currently L35):
       ```
       ## Release cadence (read once per RC)

       OmniVoice ships every minor on a **two-RC cadence**:
       - `vX.Y.0-rc1` — cut from `main` once all GATE-* requirements pass; clean-VM exercise on 4 OSes (per `REL-01`)
       - 48-hour soak (no new commits to release branch except fix-forward)
       - `vX.Y.0` — promotion if rc1 is clean

       If your PR touches install / bootstrap / CI, it MUST land before rc1 cut, not between rc1 and the promotion. During a soak, any merge needs explicit OK from the release captain.

       ```

    Do NOT delete or reword the existing six sections. Do NOT change emoji choices. Do NOT rename the file.

    Commit message: `docs(00-gates): document RC cadence + regression-fixture check in PR template (GATE-04)`
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && grep -F "🚀 Release prep" .github/pull_request_template.md && grep -F "tests/fixtures/omnivoice_data/" .github/pull_request_template.md && grep -F "two-RC cadence" .github/pull_request_template.md && test "$(grep -c '^## ' .github/pull_request_template.md)" -ge 7</automated>
    <manual>Open a throwaway draft PR (`gh pr create --draft --title 'test template render' --body ''`) — the new checklist items and "Release cadence" section should render visibly in the GitHub UI. Close the draft when done: `gh pr close <num> --delete-branch`.</manual>
  </verify>
  <done>All three grep -F calls match; section count ≥ 7 (original 6 + new "Release cadence"); manual draft-PR render confirms visual layout.</done>
</task>

<task type="auto" id="T0.F.2">
  <name>T0.F.2 — Commit PR template changes</name>
  <files>.github/pull_request_template.md</files>
  <behavior>
    - Single atomic commit on `ai-gsd-setup` carrying ONLY the pull_request_template.md edits from T0.F.1.
    - No co-mingling with other Slice F or Slice G files.
  </behavior>
  <action>
    Stage and commit:
    ```
    git add .github/pull_request_template.md
    git commit -m "docs(00-gates): document RC cadence + regression-fixture check in PR template (GATE-04)"
    ```
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && git log -1 --name-only --pretty=format:'%s' | head -5 | grep -E "GATE-04|pull_request_template"</automated>
  </verify>
  <done>Single commit on `ai-gsd-setup` whose only file is `.github/pull_request_template.md` and whose message references GATE-04.</done>
</task>

<!-- ═════════════════════════════════════════════════════════════════════ -->
<!--  SLICE G — Open Phase 0 PR (must merge BEFORE Slice C, per CONTEXT.md L86) -->
<!-- ═════════════════════════════════════════════════════════════════════ -->

<task type="auto" id="T0.G.1">
  <name>T0.G.1 — Open the Phase 0 PR against main</name>
  <files>(no file edits — `gh pr create` only)</files>
  <behavior>
    - A draft-or-ready PR exists on GitHub from `ai-gsd-setup` (or `phase-00-gates`) targeting `main`, carrying Slices A/B/D/E/F.
    - PR body summarizes GATE-01..06 coverage so the human reviewer (T0.G.2) can verify against requirements without re-reading the plan.
    - The new `smoke-matrix` job runs against the PR's own diff — this is the dogfood check: if the matrix is broken, this PR fails first.
  </behavior>
  <action>
    Push the branch first (if not already pushed):
    ```
    git push -u origin ai-gsd-setup
    ```

    Open the PR. Use HEREDOC for the body so backticks and newlines survive:
    ```
    gh pr create \
      --base main \
      --head ai-gsd-setup \
      --title "Phase 0 — Gates: cross-platform CI matrix + regression fixture + release smoke" \
      --body "$(cat <<'EOF'
    ## Summary

    Phase 0 of the v0.3.x stabilization milestone — lays the CI/release runway so all downstream stability fixes ship with macOS/Windows regressions caught before they hit users.

    ## Requirements covered

    - **GATE-01** — `tests/fixtures/omnivoice_data/` checked-in regression fixture (≤200 KB, no LFS) + `tests/smoke/test_boot_smoke.py` runs against it.
    - **GATE-02** — new `smoke-matrix` job in `.github/workflows/ci.yml` runs on `macos-14`, `windows-2022`, `ubuntu-22.04` for every PR to `main`.
    - **GATE-03** — `.github/workflows/release.yml` boots the bundled installer per OS and asserts `--health-check` → `/health` 200 within 60 s.
    - **GATE-04** — `.github/pull_request_template.md` (lowercase, in place) documents two-RC release cadence + regression-fixture check.
    - **GATE-05** — `release.yml` publishes SHA-256 checksums inline in the release body AND as per-OS `SHA256SUMS-<label>.txt` release assets.
    - **GATE-06** — gated on PR #51 landing AFTER this PR merges (Slice C, T0.C.2). #53 + #61 verified merged in T0.C.1 step 0.

    ## Dogfood check

    The new `smoke-matrix` runs against THIS PR's diff. If you see it green on all three OSes in the PR checks, the matrix itself is wired correctly.

    ## Test plan

    - [ ] All three legs of \`smoke-matrix\` (macOS / Windows / Linux) are green on this PR's checks.
    - [ ] Local: \`uv run pytest tests/smoke/ -q\` passes (4 tests, < 30 s on warm cache).
    - [ ] Fixture size: \`du -sh tests/fixtures/omnivoice_data/\` ≤ 200 KB.
    - [ ] (Optional) workflow_dispatch dry-run of \`release.yml\` per T0.D.3 confirms installer smoke steps work end-to-end.

    ## Not in this PR (deferred to Slice C, post-merge)

    - PR #51 (cross-platform bug bash) lands AFTER this merges so the new \`smoke-matrix\` job applies to its diff (per CONTEXT.md L86 interleave decision).

    🤖 Generated with [Claude Code](https://claude.com/claude-code)
    EOF
    )"
    ```

    Capture the PR URL the command prints — needed for the verify step.
  </action>
  <verify>
    <automated>cd /Users/user4/Desktop/voice-design/OmniVoice && gh pr list --head ai-gsd-setup --base main --state open --json number,title,url --jq '.[0] | "PR #\(.number): \(.title) — \(.url)"'</automated>
  </verify>
  <done>`gh pr list` reports exactly one open PR from `ai-gsd-setup` → `main` whose title contains "Phase 0 — Gates". PR URL captured for T0.G.2.</done>
</task>

<task type="checkpoint:human-action" id="T0.G.2" gate="blocking">
  <name>T0.G.2 — [user-required] Verify Phase 0 PR smoke-matrix green, then merge</name>
  <what-built>T0.G.1 opened the Phase 0 PR. The new `smoke-matrix` job is running against the PR's own diff (dogfood check). All other GATE-* artifacts are present in the PR.</what-built>
  <how-to-verify>
    USER MUST EXECUTE (Claude cannot merge to main per CLAUDE.md + CONTEXT.md):

    1. Open the PR URL printed by T0.G.1 in browser.
    2. Wait for the new `smoke-matrix` job to complete on all 3 OSes (macOS, Windows, Linux). Each leg should be < 5 min on warm cache.
    3. Verify each leg shows: 4 tests passed, fixture loaded, no missing-module errors.
    4. Skim the PR diff one more time:
       - `tests/fixtures/omnivoice_data/` is checked into git (NOT LFS).
       - `.github/workflows/ci.yml` smoke-matrix job is present and matrix runners are `macos-14`/`windows-2022`/`ubuntu-22.04` exactly.
       - `.github/workflows/release.yml` has the 3 `Installer smoke (*)` steps + the checksum compute + softprops-attach step.
       - `.github/pull_request_template.md` is still lowercase (NOT renamed to uppercase — protects review history per PATTERNS.md L20).
       - `backend/main.py` has the `--health-check` flag.
    5. Merge: `gh pr merge <PR#> --squash --delete-branch` (or `--merge` per repo convention).
    6. Confirm: `gh pr view <PR#> --json state` shows `"MERGED"`.

    AFTER merge, `main` carries the new smoke-matrix. NOW Slice C (PR #51 landing) is unblocked.

    Reason this is user-required: pushing-to / merging-into `main` is explicitly out of Claude's session per CLAUDE.md and CONTEXT.md "no destructive operations / no merging to main from Claude's session".
  </how-to-verify>
  <resume-signal>Type "merged" to proceed to Slice C (PR #51 land), or "abort — &lt;reason&gt;" to stop here. If the matrix failed, type "matrix-broken" and surface the failing leg + log excerpt.</resume-signal>
</task>

</tasks>

<verification>
Backward-derivation: each `must_haves.truths` entry traces to the slice(s) that deliver it.

| Truth | Delivering slice(s) | Evidence in plan |
|---|---|---|
| 1. Phase 0 PR open, never auto-merged from Claude's session | Slice G (T0.G.1 opens, T0.G.2 is checkpoint:human-action) | T0.G.1 `<action>` runs `gh pr create` only; T0.G.2 `<resume-signal>` requires human "merged" input |
| 2. Every PR to main runs smoke on macos-14/windows-2022/ubuntu-22.04 | Slice B (T0.B.1 adds matrix, T0.B.2 commits) | matrix in T0.B.1 action; runners pinned per CONTEXT.md decision |
| 3. tests/fixtures/omnivoice_data/ ≤ 200 KB, in git, smoke fails loud if missing | Slice A (T0.A.1 builds, T0.A.2 asserts) | T0.A.1 step 6 size guard; T0.A.2 step 2 `pytest.fail` |
| 4. release.yml installer smoke + /health within 60 s on tag push | Slice D (T0.D.1 CLI flag, T0.D.2 release step) | T0.D.2 per-OS steps; timeout-minutes: 5 each |
| 5. Per-OS SHA256SUMS-*.txt assets + inline body | Slice E (T0.E.1 compute + attach) | T0.E.1 uses softprops@v2 + append_body: true + files: |
| 6. PR template documents RC cadence + fixture line | Slice F (T0.F.1 edits, T0.F.2 commits) | T0.F.1 action steps 1-3; T0.F.2 atomic commit |
| 7. PR #51 merged AFTER new smoke matrix is green on its diff | Slice C, gated on Slice G complete | T0.C.2 prereq-verify block requires `Phase 0` commit in `main` first |

Pitfall coverage:
- #1 (cross-OS regression) → Slices A+B close it (fixture + matrix).
- #2 (Windows orphan process on port 3900) → T0.D.2 Windows step ends with `taskkill //F //T`.
- #5 (Tauri-on-headless-macOS hang) → T0.D.2 macOS step bypasses WebView, invokes bundled Python backend directly with `find` fallback.
- #7 (softprops race on parallel matrix legs) → per-OS `SHA256SUMS-<label>.txt` files avoid the race; aggregate file deferred to v2.
- #9 (GATE-06 sibling PRs not verified) → T0.C.1 step 0 runs `gh pr view 53 61` first.
- #10 (Linux-only CI gap) → Slice B closes it.

CONTEXT.md decisions honored:
- Runners pinned to macos-14/windows-2022/ubuntu-22.04 — yes (T0.B.1 matrix).
- Fixture ≤ 200 KB at `tests/fixtures/omnivoice_data/` — yes (T0.A.1 step 6 guard, T0.A.3 check).
- `OMNIVOICE_MODEL=test` env shortcut — yes (T0.A.2 step 1).
- `--health-check` CLI flag on `backend/main.py` — yes (T0.D.1).
- Lowercase `pull_request_template.md` modified in place — yes (T0.F.1 action explicit).
- No auto-merge from Claude's session — yes (T0.C.2 and T0.G.2 are `checkpoint:human-action`; T0.G.1 only opens, never merges).
- Smoke-matrix lands BEFORE PR #51 — yes (Slice G merges first, then Slice C; T0.C.2 prereq-verify enforces).

Dependency graph:
```
T0.A.1 → T0.A.2 → T0.A.3
                   ↓
T0.B.1 → T0.B.2 → T0.B.3
                   ↓
T0.D.1 → T0.D.2 → T0.D.3
                   ↓
T0.E.1 → T0.E.2
   ↓
T0.F.1 → T0.F.2
   ↓
T0.G.1 → T0.G.2  ◀── all of A-F land in this PR
   ↓
T0.C.1 → T0.C.2  ◀── runs LAST (Slice C deliberately re-ordered after Slice G per CONTEXT.md L86)
```

If any truth is unmet after T0.C.2 closes "merged", Phase 0 is not complete; re-open the failing slice and iterate.
</verification>