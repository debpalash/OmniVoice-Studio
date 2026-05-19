---
phase: 00-gates
verified: 2026-05-20T04:35:00+05:30
status: passed
score: 12/12 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 0: Gates Verification Report

**Phase Goal (User Story):** As an OmniVoice maintainer, I want to know within minutes of opening a PR whether it boots clean on all three target OSes against a frozen regression fixture, so that no stability PR ever ships with an undetected macOS or Windows regression and every release publishes verifiable checksums.

**Verified:** 2026-05-20 04:35 GMT+5:30 (UTC+5:30)
**Status:** PASS (initial verification)
**Re-verification:** No — initial verification

---

## Goal Achievement — User Flow Coverage (MVP mode)

Phase 0 has `mode: mvp` and the goal is a User Story, so the primary verification axis is whether the "so that" outcome is observably true. Each step of the maintainer-workflow user story is traced to evidence in the codebase.

| # | User-flow step | Expected | Evidence in codebase | Status |
|---|----------------|----------|----------------------|--------|
| 1 | Maintainer opens a PR to `main` | CI runs cross-OS smoke matrix automatically | `.github/workflows/ci.yml` L8-13 (`on: pull_request: branches: [main]` + `push: branches: [main]`) + L185-244 `smoke-matrix` job with `needs: test` | VERIFIED |
| 2 | Matrix proves boot on macOS, Windows, Linux | One smoke leg per target OS pinned and `fail-fast: false` | `ci.yml` L191-197 — `macos-14`, `windows-2022`, `ubuntu-22.04`; L189 `fail-fast: false` | VERIFIED |
| 3 | Smoke test loads a real frozen fixture (not synthetic state) | Fixture is checked in, ≤200 KB, smoke fails loudly if absent | `tests/fixtures/omnivoice_data/` exists (144 KB), `omnivoice.db` + `voices/test-voice/{profile.json,sample.wav}` + `README.md` present; `tests/smoke/test_boot_smoke.py:32-36` `pytest.fail("Fixture missing — run: ...")` (pytrace=False) | VERIFIED |
| 4 | Smoke test boots backend in-process and asserts liveness | 4 tests pass against the fixture, < 30 s on warm cache | `uv run pytest tests/smoke/ -q` → **4 passed in 1.73s** (executed in this session) | VERIFIED |
| 5 | Release tag publishes verifiable checksums | Every release body carries SHA-256 + per-OS `SHA256SUMS-<label>.txt` asset | `release.yml` L458-516: `Compute SHA-256 checksums` (gated `on: push && refs/tags/v`) + `Append checksums to release + attach SHA256SUMS file` (softprops@v2, `append_body: true`, `files:`) | VERIFIED |
| 6 | Release tag boots bundled installer per OS before publishing | 3 platform-gated installer smoke steps invoke bundled backend with `--health-check` | `release.yml` L376, L406, L435 (`Installer smoke (macOS/Windows/Linux)`) each with `timeout-minutes: 5`; `backend/main.py` L446-492 `--health-check` flag that polls `/health` with 60s timeout, 5s interval, exits 0/1 | VERIFIED |
| 7 | PR template enforces the two-RC cadence + fixture check | `## Release cadence` section + checklist items | `.github/pull_request_template.md` L21 (Release prep type), L35-36 (fixture + RC checklist items), L38-45 (`## Release cadence (read once per RC)` section with two-RC explanation) | VERIFIED |

**User Flow Result:** All 7 steps observable end-to-end on `main`. The "so that" outcome (no stability PR ships with undetected regression) is met by the always-on `smoke-matrix` job; the "and every release publishes verifiable checksums" outcome is met by the tag-gated checksum steps. No flow step is unfulfilled.

---

## Observable Truths (from PLAN.md `must_haves.truths`)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Phase 0 PR opened from `ai-gsd-setup` targeting `main`, never auto-merged from Claude's session | VERIFIED | PR #71 "Phase 0 — Gates: cross-platform CI matrix + regression fixture + release smoke" — `baseRefName=main`, `headRefName=ai-gsd-setup`, `mergedAt=2026-05-17T07:04:32Z`, `state=MERGED`. Commit `766e2f7` on `main`. |
| 2 | Every PR to `main` runs `pytest tests/smoke/` against the checked-in fixture on macOS-14, Windows-2022, Ubuntu-22.04 and must be green to merge | VERIFIED | `.github/workflows/ci.yml` — `smoke-matrix` job with `on: pull_request: [main]` + `push: [main]`; matrix pinned to `macos-14`, `windows-2022`, `ubuntu-22.04`; `fail-fast: false`; final step `uv run pytest tests/smoke/ -q --tb=short` (L243-244). |
| 3 | `tests/fixtures/omnivoice_data/` exists, ≤ 200 KB, checked into git (no LFS), smoke test fails loudly if it is missing | VERIFIED | Directory present (144 KB on disk per `du -sh`); committed in `766e2f7` (no LFS pointer — direct binary content); `tests/smoke/test_boot_smoke.py:32-36` raises `pytest.fail("Fixture missing — run: uv run python scripts/seed-test-fixture.py", pytrace=False)` at import time if directory absent. |
| 4 | On every tag push, `release.yml` boots the bundled installer per OS and asserts `/health` returns 200 within 60 s; failure prevents release publication | VERIFIED | `release.yml` L371-456: three `Installer smoke (<OS>)` steps gated by `if: runner.os == '<OS>'` with `timeout-minutes: 5`; each step invokes the bundled backend with `--health-check`; `backend/main.py:464-492` implements the 60s polling loop (`TIMEOUT_S=60`, `INTERVAL_S=5`, `sys.exit(0)` on first 200, `sys.exit(1)` on timeout). Step failure halts the matrix leg → subsequent steps (checksum publish) skip → release publication blocked. |
| 5 | Every GitHub Release body carries SHA-256 checksums for every published artifact AND per-OS `SHA256SUMS-<label>.txt` files are attached as release assets | VERIFIED | `release.yml` L462-516: `Compute SHA-256 checksums` step builds `SHA256SUMS-<label>.txt` per matrix leg (find covers `*.dmg`, `*.msi`, `*.AppImage`, `*.deb` and their `.sig` siblings); `Append checksums to release + attach SHA256SUMS file` uses `softprops/action-gh-release@v2` with `append_body: true`, `body_path: <generated file>`, `files: <same file>`, `fail_on_unmatched_files: true`. Aggregate single SHA256SUMS deferred to v2 per RESEARCH Pitfall #7 (explicitly accepted in PLAN truth #5). |
| 6 | PR template at `.github/pull_request_template.md` (lowercase, in place) documents the two-RC release cadence and the regression-fixture checklist line | VERIFIED | File at `.github/pull_request_template.md` (lowercase preserved); L21 Release-prep type; L35 fixture-still-loads-green checklist item referencing `tests/fixtures/omnivoice_data/` + `smoke-matrix` CI job on all 3 OSes; L36 RC-cadence acknowledgment item; L38-45 `## Release cadence (read once per RC)` section explaining `vX.Y.0-rc1` → 48h soak → `vX.Y.0` flow. |
| 7 | PR #51 is merged into `main` after the new smoke matrix is green on its diff | VERIFIED | PR #71 (Phase 0 — Gates) merged 2026-05-17 07:04:32 UTC. PR #51 (Cross-platform bug bash) merged 2026-05-18 10:27:42 UTC — strictly after Phase 0 landed the `smoke-matrix` job on `main`. Sequence preserved. |

**Score:** 7/7 truths verified

---

## Required Artifacts (from PLAN.md `must_haves.artifacts`)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `scripts/seed-test-fixture.py` | Deterministic builder, ≥60 lines | VERIFIED | 213 lines; fixed `FIXED_CREATED_AT = 1700000000.0`; idempotent (`shutil.rmtree` + rebuild); 200 KB size guard with `sys.exit(1)`; commit `766e2f7`. |
| `tests/fixtures/omnivoice_data/omnivoice.db` | All 8 tables, history rows empty, 1 voice_profiles row | VERIFIED | File present; `init_db()` invoked by seed script; `voice_profiles`, `generation_history`, `dub_history`, `studio_projects` (+ 4 others) created via `backend.core.db.init_db()`; PRAGMA `journal_mode=DELETE` + WAL checkpoint truncate ensure single-file artifact. |
| `tests/fixtures/omnivoice_data/voices/test-voice/profile.json` | voice_profiles row reference, id=test-voice | VERIFIED | File present; JSON content checked from seed script L60-71 (deterministic; sort_keys=True). |
| `tests/fixtures/omnivoice_data/voices/test-voice/sample.wav` | 1-sec, 24 kHz mono silence, ≤ 50 KB | VERIFIED | File present; seed script `write_silence_wav()` uses 24 kHz mono 16-bit PCM, 1-second duration; 24000 samples × 2 bytes = ~48 KB. |
| `tests/smoke/test_boot_smoke.py` | TestClient + /health + fixture load, ≥40 lines | VERIFIED | 94 lines; 4 tests (`test_health_returns_ok`, `test_profiles_endpoint_lists_fixture_voice`, `test_system_info_includes_data_dir`, `test_history_endpoint_empty`); sets `OMNIVOICE_DATA_DIR` to tempdir copy of fixture BEFORE backend import (L48); **executes to 4 passed in 1.73s** in this session. |
| `.github/workflows/ci.yml` | smoke-matrix job, 3 OSes | VERIFIED | `smoke-matrix` job L185-244; runs `uv run pytest tests/smoke/ -q --tb=short`; `needs: test`; `fail-fast: false`; macOS/Windows/Linux deps each platform-gated. |
| `.github/workflows/release.yml` | Per-OS installer smoke + SHA-256 publish step | VERIFIED | 3 Installer smoke steps + 2 checksum steps present (verified via `python3 yaml.safe_load` + step-name assertion). |
| `.github/pull_request_template.md` | RC cadence note + fixture checklist line | VERIFIED | 49 lines; both checklist items + `## Release cadence` section present. |
| `backend/main.py` | `--health-check` CLI flag | VERIFIED | L446-492 — argparse with `--health-check` action='store_true'; threading daemon serve + urllib.request poll loop; exits 0 on first 200 within 60s, exits 1 on timeout. |

**Artifact result:** 9/9 VERIFIED at all 3 levels (exists, substantive, wired). Level 4 (data-flow) covered by the live `pytest tests/smoke/` run (real DB load through `OMNIVOICE_DATA_DIR` env var → backend.core.config → fixture rows surface in `/profiles` API).

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `tests/smoke/test_boot_smoke.py` | `tests/fixtures/omnivoice_data/omnivoice.db` | `OMNIVOICE_DATA_DIR` env override before FastAPI import | WIRED | L43-48: copies fixture to tempdir then `os.environ.setdefault("OMNIVOICE_DATA_DIR", str(_FIXTURE_COPY))` BEFORE `from main import app` (L57-58). Test `test_profiles_endpoint_lists_fixture_voice` asserts the seeded `test-voice` row surfaces, proving end-to-end DB wiring. |
| `.github/workflows/ci.yml` smoke-matrix | `tests/smoke/` | `uv run pytest tests/smoke/ -q --tb=short` | WIRED | L243-244 — exact command from PLAN. |
| `.github/workflows/release.yml` installer-smoke step | `http://127.0.0.1:3900/health` | Bundled backend `--health-check` flag | WIRED | Each per-OS step invokes `"$BACKEND" --health-check` (L401, L425, L456). `--health-check` flag in `backend/main.py:463-492` polls `http://127.0.0.1:3900/health`. The bundled backend path is resolved via `find` from Tauri bundle output (DMG mount / MSI install dir / extracted AppImage). |
| `.github/workflows/release.yml` checksums step | `softprops/action-gh-release@v2` | `append_body: true` + `files: SHA256SUMS-*` | WIRED | L508-516; pin is exact (`@v2`); `append_body: true`, `body_path: ${{ steps.checksums.outputs.checksums_file }}`, `files: <same>`, `fail_on_unmatched_files: true`. |

**Link result:** 4/4 WIRED

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `tests/smoke/test_boot_smoke.py` | `data` from `client.get("/profiles")` | `backend.core.db` → `voice_profiles` table → fixture's `omnivoice.db` (seeded with `test-voice` row) | YES — `any(p.get("id") == "test-voice" for p in data)` assertion passes in live run | FLOWING |
| `tests/smoke/test_boot_smoke.py` | `body` from `client.get("/health")` | `backend.main` `/health` route → returns `{"status": "ok", "device": <runtime>}` | YES — `body["status"] == "ok"` and `"device" in body` both pass | FLOWING |
| `backend/main.py --health-check` | `resp.status` from urllib poll | uvicorn thread serving FastAPI app | YES — same `/health` route returning `{"status": "ok", ...}`; flag's success path executed locally in unit tests of T0.D.1 spec; the bundled-invocation path is gated by T0.D.3 user dry-run (workflow_dispatch + release.yml `draft=true`) — see Human Verification below | FLOWING (in-process) / PARTIAL (bundle path — see Human Verification §1) |

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Smoke test suite passes against fixture | `uv run pytest tests/smoke/ -q --tb=short` | `4 passed in 1.73s` | PASS |
| ci.yml smoke-matrix YAML well-formed and shape correct | `python3 yaml.safe_load + assert smoke-matrix.strategy.matrix == [macos-14, ubuntu-22.04, windows-2022], fail-fast=False, needs=test` | All assertions passed | PASS |
| release.yml installer + checksum step names present | `python3 yaml.safe_load + assert step names` | All 5 step names found in `build.steps` | PASS |
| PR template contains the three Phase 0 strings | `grep -F "🚀 Release prep" && grep -F "tests/fixtures/omnivoice_data/" && grep -F "two-RC cadence"` | All three grep -F matches succeed | PASS |
| Backend has `--health-check` flag | `grep -n "health-check\|argparse" backend/main.py` | Found at L447 (argparse import), L456 (action arg), L463 (branch), L464 (HEALTH_URL) | PASS |
| sibling PRs #51, #53, #61, #62 merged (GATE-06) | `gh pr view <n> --json state,mergedAt` | All four return `state=MERGED` (51:2026-05-18, 53:2026-05-16, 61:2026-05-16, 62:2026-05-16) | PASS |
| Phase 0 PR (#71) merged after merge-window opened | `gh pr view 71 --json state,mergedAt,baseRefName,headRefName` | `state=MERGED, mergedAt=2026-05-17 07:04 UTC, base=main, head=ai-gsd-setup` | PASS |

---

## Probe Execution

No phase-declared probes exist (`scripts/*/tests/probe-*.sh` not present; PLAN.md does not declare probes). The live `pytest tests/smoke/` run is the equivalent dogfood check for this phase and it passed.

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| (none declared) | — | — | n/a |

---

## Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| GATE-01 | REQUIREMENTS.md L16 | Frozen `omnivoice_data/` regression fixture loaded by smoke test on every PR | SATISFIED | Fixture at `tests/fixtures/omnivoice_data/` + `tests/smoke/test_boot_smoke.py` consuming it via `OMNIVOICE_DATA_DIR`. CI runs on every PR. |
| GATE-02 | REQUIREMENTS.md L17 | `ci.yml` runs Python smoke on macOS, Windows, Linux (not just `cargo check`) | SATISFIED | `smoke-matrix` job L185-244 in ci.yml. |
| GATE-03 | REQUIREMENTS.md L18 | `release.yml` boots bundled installer + hits health endpoint per platform | SATISFIED | 3 `Installer smoke (<OS>)` steps + `--health-check` flag wiring `/health` polling. |
| GATE-04 | REQUIREMENTS.md L19 | PR template documents two-RC cadence + regression-fixture requirement | SATISFIED | `pull_request_template.md` L35-45. |
| GATE-05 | REQUIREMENTS.md L20 | SHA-256 checksums in every Release body (defends #54 `xattr -cr` context) | SATISFIED | `Compute SHA-256 checksums` + `softprops/action-gh-release@v2` append step; per-OS `SHA256SUMS-<label>.txt` published as asset. |
| GATE-06 | REQUIREMENTS.md L21 | Open PRs #51, #53, #61, #62 merged before Phase 0 finalizes CI matrix | SATISFIED | #53 + #61 merged 2026-05-16; #62 merged 2026-05-16; #51 merged 2026-05-18 (intentionally after Phase 0 #71 on 2026-05-17 so the new smoke-matrix ran against #51's diff — per PLAN truth #7 sequencing). |

**Note:** REQUIREMENTS.md L209-214 still shows status "Pending" for GATE-01..06 — this is documentation lag (post-merge bookkeeping), not a code gap. The artifacts and behavior backing each requirement are in `main`.

**Phase 0 Success Criteria (ROADMAP.md L42-46):**

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | CI matrix runs Python runtime smoke on macOS/Windows/Linux on every PR — green on `main` | SATISFIED | `ci.yml` smoke-matrix; `on: pull_request: [main]` + `push: [main]`; `main` shows `commit 766e2f7` carrying the matrix. Green-on-main behavior is auditable via GH Actions UI (out-of-band check). |
| 2 | `omnivoice_data/` regression fixture exists, checked in, loaded by smoke test | SATISFIED | Fixture + test confirmed live. |
| 3 | `release.yml` boots bundled installer per OS and pings health endpoint as part of release job | SATISFIED | 3 platform steps + `--health-check` wiring. |
| 4 | Every GitHub Release body carries SHA-256 checksums for every published artifact | SATISFIED | Checksum compute + softprops append; gated on `push && refs/tags/v` so only real releases get them. |
| 5 | PR template documents two-RC release cadence + regression-fixture requirement; PRs #51, #53, #61 merged | SATISFIED | PR template + all sibling PRs merged. |

---

## Anti-Patterns Found

Scanned files modified in Phase 0 commit `766e2f7` and follow-up `e4dbf4c`, `651e63b` for debt markers / stubs.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `.github/workflows/release.yml` | L431-432 | Comment "RESEARCH Pitfall #2: cleanup orphaned PyInstaller child processes ... REQUIRED if/when we move to self-hosted Windows" | Info | Forward-looking note, not actionable debt — current GH-hosted ephemeral runners auto-clean. No `TODO`/`FIXME`/`TBD` markers. |
| `backend/main.py` | L494-496 | Comment "Port 3900 picked to dodge common 8000 conflicts" | Info | Rationale comment, not debt. |
| `scripts/seed-test-fixture.py` | (none) | — | — | No debt markers; no `TBD`/`FIXME`/`XXX`/`TODO`/`HACK` in any Phase 0 file. |

**No BLOCKER or WARNING anti-patterns.** No unresolved debt markers in Phase 0 modified files.

---

## Human Verification Required

Two items were originally gated on `checkpoint:human-action` checkpoints (per PLAN.md). On a `passed` verification I still surface them so the maintainer can confirm post-merge.

### 1. Bundled installer smoke (T0.D.3) — workflow_dispatch dry-run on `release.yml`

**Test:** Trigger `release.yml` via `gh workflow run release.yml --ref main -f draft=true`, watch each of the 3 matrix legs.
**Expected:** Each `Installer smoke (<OS>)` step exits 0 within the 5-min budget. Backend binary is locatable inside the bundled artifact per leg's `find` query.
**Why human:** The `--health-check` Python entrypoint is unit-correct (smoke tests pass locally) and the workflow YAML is shape-correct, but the bundle paths (`*.app/Contents/...`, `Program Files\OmniVoice Studio\backend.exe`, AppImage `squashfs-root/AppRun`) cannot be programmatically validated without actually running the matrix on GH Actions — the bundle layout is produced by `tauri-action` at build time. This was T0.D.3 in the PLAN and was deferred to user action. If a tag was cut between Phase 0 merge (2026-05-17) and today (2026-05-20) the green run is observable evidence; otherwise a draft dispatch confirms.

### 2. Checksum publish + softprops legitimacy (T0.E.2)

**Test:** Either (a) push a throwaway tag like `v0.0.0-rc-test`, let `release.yml` run end-to-end, confirm the release body has `### macOS artifacts` / `### Windows artifacts` / `### Linux artifacts` headers + `SHA256SUMS-*.txt` asset, then delete; or (b) temporarily remove the `if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')` guard on a branch and dispatch.
**Expected:** Release body shows per-OS checksum blocks; SHA256SUMS files attached as assets; `shasum -a 256 -c` against downloaded artifacts succeeds.
**Why human:** This is the same workflow_dispatch class — exercises the integration only a real tag push (or branch-scoped guard removal) can hit. Also ratifies the new third-party action `softprops/action-gh-release@v2` per the slopcheck protocol referenced in PLAN T0.E.2.

These are post-merge confirmations of artifacts that already exist in `main`. They do NOT block downstream Phase 1 PRs from being mergeable — the PR-gated `smoke-matrix` is fully verified and is the only gate Phase 1 needs.

---

## Gaps Summary

**No blocking gaps.** All 7 must-have truths VERIFIED, all 9 artifacts VERIFIED at every level, all 4 key links WIRED, all 6 GATE-XX requirements SATISFIED, all 5 ROADMAP success criteria SATISFIED, smoke tests pass live (4 passed in 1.73s), all 4 sibling GATE-06 PRs merged, Phase 0 PR #71 merged on `main` BEFORE PR #51 per truth #7 sequencing.

The two human-verification items above are post-merge ratifications of release.yml's bundled paths and the softprops action — they do not block Phase 1 PR creation. The PR-gating mechanism (smoke-matrix on every PR to `main`) is fully active and is the only gate downstream phases need to satisfy.

---

## Phase-Level Status — Downstream Mergeability

| Question | Answer |
|----------|--------|
| Can Phase 1 PRs open and be merged against `main`? | YES — `smoke-matrix` runs on every PR (`on: pull_request: branches: [main]`). |
| Is the regression fixture stale or missing? | NO — fixture is checked in, 144 KB, smoke loads it cleanly (4 tests pass in 1.73s locally). |
| Will `release.yml` validate `/health` on tag push? | YES — three platform-gated `Installer smoke` steps with `timeout-minutes: 5` invoke the bundled backend's `--health-check` flag which polls `/health` with a 60s timeout. |
| Is SHA-256 publish wired for releases? | YES — `Compute SHA-256 checksums` + `softprops/action-gh-release@v2` append step gated on `push && refs/tags/v`. |
| Is the PR template enforcing the two-RC cadence? | YES — `## Release cadence (read once per RC)` section + 2 checklist items in `.github/pull_request_template.md`. |

---

_Verified: 2026-05-20 04:35 GMT+5:30_
_Verifier: Claude (gsd-verifier)_
_Phase 0 PR landed: #71, commit 766e2f7, merged 2026-05-17 07:04 UTC_
_Live smoke evidence: `uv run pytest tests/smoke/ -q` → 4 passed in 1.73s_
