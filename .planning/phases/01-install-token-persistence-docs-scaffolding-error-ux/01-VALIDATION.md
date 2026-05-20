# Phase 1: Install + Token Persistence + Docs Scaffolding + Error UX — Validation

**Derived:** 2026-05-18 (revision pass 1, addressing checker B-1)
**Source:** `01-RESEARCH.md` § Validation Architecture
**Nyquist mode:** ENABLED (per `.planning/config.json workflow.nyquist_validation: true`)

This document operationalizes the Validation Architecture section of `01-RESEARCH.md` into:
1. A test-pyramid layout binding each requirement cluster to specific test files.
2. Coverage targets per cluster (AUTH, INST, DOCS).
3. The per-plan artifact list that each PLAN must produce to satisfy this validation strategy.
4. Sampling rates and gate thresholds.

---

## 1. Test Pyramid Layout

```
                    ┌──────────────────────────────────────┐
                    │  Manual / Smoke (3 platforms)        │  Phase 6 RC1 click-through
                    │  Phase 0 GATE-02 / GATE-03 release   │  ~5 % of total verification
                    └──────────────────────────────────────┘
                  ┌──────────────────────────────────────────┐
                  │  Acceptance (CI gates)                   │  ~15 % of total
                  │  - scripts/validate-install-docs.py      │
                  │  - validator self-tests (B-5)            │
                  │  - GATE-02 cross-platform Python smoke   │
                  │  - .github/workflows/ci.yml validate-docs│
                  └──────────────────────────────────────────┘
              ┌────────────────────────────────────────────────┐
              │  Integration                                   │  ~30 % of total
              │  - subprocess env injection (AUTH-04, INST-12) │
              │  - alembic upgrade head on v0.2.7 fixture DB   │
              │  - FastAPI TestClient round-trips on settings  │
              │    routers (hf-token + perf)                   │
              │  - frontend component tests (ApiKeysPanel,     │
              │    PerformancePanel, ErrorBoundary)            │
              └────────────────────────────────────────────────┘
        ┌──────────────────────────────────────────────────────────┐
        │  Unit                                                    │  ~50 % of total
        │  - token_resolver priority + cascade + on_401            │
        │  - settings_store round-trip + Fernet encryption         │
        │  - logging filter redaction (caplog assertion)           │
        │  - error_docs_map lookup + default fallback              │
        │  - links.py URL resolution (Tauri-first / pyproject fb)  │
        │  - gatekeeper_detect (cross-platform branches)           │
        │  - ffmpeg_utils.resolve_ffprobe env-first / PATH-fallback│
        │  - apiBase context resolution (Tauri vs browser vs SSR)  │
        │  - errorDocsMap.ts openDocsFor + key drift sentinel      │
        │  - AppRun shell unit test (W-1, mocks pkg-config)        │
        │  - validate-install-docs.py self-tests (B-5)             │
        └──────────────────────────────────────────────────────────┘
```

**Target distribution:** roughly 50 % unit / 30 % integration / 15 % acceptance / 5 % manual. Manual is deliberately small because the user has explicitly bounded "Claude must automate everything possible" — manual exists only where it cannot be automated within Phase 1 scope (visual UI verification, real-VM AppImage launch, real .app Gatekeeper interaction).

---

## 2. Requirement Cluster Coverage Targets

### Cluster AUTH (AUTH-01 — AUTH-06)

**Owner:** Plan 01-01.

| Requirement | Test Level | Test File | Status After Phase 1 |
|-------------|-----------|-----------|----------------------|
| AUTH-01 (3-source resolver) | unit | `tests/backend/services/test_token_resolver.py::test_resolve_priority`, `::test_resolve_skips_empty`, `::test_resolve_returns_none_when_all_empty` | green |
| AUTH-02 (encrypted SQLite) | unit + integration | `tests/backend/services/test_settings_store.py` (round-trip + raw-bytes-encrypted assertion + alembic-upgrade-on-v0.2.7-fixture) | green |
| AUTH-03 (Settings panel + login() defensive write) | unit (backend) + component (frontend) | `tests/backend/services/test_token_resolver.py::test_save_writes_both`, `frontend/src/components/settings/ApiKeysPanel.test.jsx` | green |
| AUTH-04 (subprocess env injection) | integration | `tests/backend/test_engine_spawn_token.py` (mocks Popen, asserts HF_TOKEN in env kwarg) | green |
| AUTH-05 (logging filter) | unit | `tests/backend/core/test_logging_filter.py` (caplog asserts no `hf_*` reaches handlers) | green |
| AUTH-06 (on-401 cascade) | unit | `tests/backend/services/test_token_resolver.py::test_resolve_skips_401`, `::test_on_401_cascade` | green |

**Coverage target:** 100 % line coverage on `backend/services/token_resolver.py` + `backend/services/settings_store.py` + `backend/core/logging_filter.py`. Measured via `uv run pytest --cov=backend/services/token_resolver --cov=backend/services/settings_store --cov=backend/core/logging_filter tests/backend/`.

**Property-level coverage:** every public function in the resolver `<interfaces>` block has at least one test asserting return-value shape.

### Cluster INST (INST-01 — INST-06, INST-12)

**Owner split:** Plan 01-02 (INST-02, INST-03 docs, INST-05, INST-06, INST-12); Plan 01-03 (INST-01 verification, INST-03 backend, INST-04).

| Requirement | Test Level | Test File / Gate | Status After Phase 1 |
|-------------|-----------|------------------|----------------------|
| INST-01 (setuptools pin) | unit + acceptance | `tests/backend/test_pyproject.py::test_setuptools_pinned` + Phase 0 GATE-02 Py 3.12 smoke | green |
| INST-02 (README split) | acceptance | `grep -q "docs/install/macos.md" README.md` (verify step in Plan 01-02 Task 1) + manual review at PR | green |
| INST-03 (macOS Gatekeeper) | unit (backend) + manual (frontend) | `tests/backend/core/test_gatekeeper_detect.py` (5 cases) + manual click-through on quarantined .app at Phase 6 rc1 | green at code level; manual deferred |
| INST-04 (AppImage launcher) | unit (shell) + manual (real AppImage) | `frontend/src-tauri/appimage/AppRun.test.sh` (4 cases per W-1) + manual Fedora 44 / Ubuntu 24.04 launch at Phase 6 rc1 | green at code level; manual deferred |
| INST-05 (templated badges) | acceptance | manual README review at PR (template URL renders via shields.io) | green at template; rendering manually verified |
| INST-06 (docs drift CI) | acceptance + unit | `scripts/validate-install-docs.py` (CI step) + `tests/scripts/test_validate_install_docs.py` (B-5 self-tests, 10 cases) | green |
| INST-12 (torch.compile toggle) | unit + integration + component | `tests/backend/test_perf_settings.py` (7 cases — incl. cross-platform branches) + `frontend/src/components/settings/PerformancePanel.test.jsx` (3 cases) | green |

**Coverage target:** the validator script itself reaches 100 % branch coverage (its skip-marker / prompt-prefix-strip / CRLF / whitespace / true-diff branches are explicitly tested per B-5). All other INST artifacts get smoke-level coverage (file existence + key behavior). Bundler-side artifacts (postinst, postrm, AppRun, tauri.conf.json relocations) get manual verification at Phase 6 rc1 against real installers because real .deb / .app / .AppImage builds are out of scope for CI in Phase 1 — GATE-03 (Phase 0) is the entry point for installer-build CI; this phase's validation depends on that being in place.

### Cluster DOCS (DOCS-01 — DOCS-05)

**Owner:** Plan 01-02.

| Requirement | Test Level | Test File / Gate | Status After Phase 1 |
|-------------|-----------|------------------|----------------------|
| DOCS-01 (troubleshooting top 10) | acceptance | manual review at PR (10 entries enumerated in Plan 01-02 Task 1 Step 6) | green at content; manual reviewed |
| DOCS-02 (error → docs map) | unit (Python + TS) | `tests/backend/core/test_error_docs_map.py` + `frontend/src/utils/errorDocsMap.test.ts` | green |
| DOCS-03 (CosyVoice guide) | acceptance | file existence + heading audit at PR | green |
| DOCS-04 (diarization guide) | acceptance | file existence + heading audit at PR | green |
| DOCS-05 (HF token guide) | acceptance | file existence + section completeness audit at PR | green |

**Coverage target:** all 5 docs files exist with at least the heading set documented in Plan 01-02. The validator script gates only the install-command code blocks; prose drift is manual-review.

---

## 3. Plan-to-Artifact Binding

Each plan in Phase 1 MUST produce the following artifacts to satisfy this validation strategy. The plan-checker's gate is: every test-file artifact listed below must appear in at least one plan's `files_modified` AND in its `must_haves.artifacts`.

### Plan 01-01 must produce:
- `tests/backend/services/test_token_resolver.py` ≥ 80 lines
- `tests/backend/services/test_settings_store.py` ≥ 30 lines
- `tests/backend/core/test_logging_filter.py` ≥ 25 lines
- `tests/backend/test_engine_spawn_token.py` ≥ 1 test class

### Plan 01-02 must produce:
- `tests/scripts/test_validate_install_docs.py` ≥ 80 lines (B-5 — 10 cases)
- `tests/backend/core/test_error_docs_map.py`
- `tests/backend/core/test_links.py` (B-6 — owner test for links.py)
- `tests/backend/test_perf_settings.py` (B-2/B-7 — INST-12 toggle backend tests)
- `frontend/src/utils/errorDocsMap.test.ts`
- `frontend/src/components/settings/ApiKeysPanel.test.jsx`
- `frontend/src/components/settings/PerformancePanel.test.jsx`

### Plan 01-03 must produce:
- `tests/backend/services/test_ffmpeg_utils.py` (W-2)
- `tests/backend/core/test_gatekeeper_detect.py`
- `tests/backend/test_pyproject.py` (INST-01 no-regression)
- `frontend/src/utils/apiBase.test.ts`
- `frontend/src-tauri/appimage/AppRun.test.sh` (W-1 — shell unit test)

---

## 4. Sampling Rate

- **Per task commit:** Quick run for the touched module (e.g. `pytest tests/backend/services/test_token_resolver.py -x`).
- **Per wave merge:** Full backend suite + frontend lint + `python scripts/validate-install-docs.py` + validator self-tests + AppRun shell tests.
- **Phase gate (handoff to `/gsd:verify-work`):** Full pytest suite green + full frontend bun test green + validator gate green + manual click-through on 3 platforms.

---

## 5. Gate Thresholds

| Gate | Threshold | Failure Action |
|------|-----------|----------------|
| Unit suite green | 100 % pass | block phase completion |
| Integration suite green | 100 % pass | block phase completion |
| Validator self-tests | 10/10 pass (B-5) | block phase completion |
| AppRun shell tests | 4/4 pass (W-1) | block phase completion |
| `validate-install-docs.py` | exit 0 | block PR merge |
| Test coverage on AUTH-cluster files | ≥ 90 % line | warn at phase review |
| Manual click-through on 3 platforms (Phase 6) | 3/3 | block release rc1 → v0.3.0 promotion |

---

## 6. Wave 0 Gaps Closed By This Phase

Per RESEARCH.md § Validation Architecture, all Wave 0 gaps below MUST be closed in Phase 1:

- [x] `tests/backend/services/test_token_resolver.py` (Plan 01-01)
- [x] `tests/backend/services/test_settings_store.py` (Plan 01-01)
- [x] `tests/backend/core/test_logging_filter.py` (Plan 01-01)
- [x] `tests/backend/test_engine_spawn_token.py` (Plan 01-01)
- [x] `tests/backend/core/test_gatekeeper_detect.py` (Plan 01-03)
- [x] `frontend/src/utils/errorDocsMap.test.ts` (Plan 01-02)
- [x] CI step `python scripts/validate-install-docs.py` (Plan 01-02 Task 1 Step 14)
- [x] vitest setup (decided + documented in Plan 01-02 SUMMARY)
- [x] Validator self-tests `tests/scripts/test_validate_install_docs.py` (Plan 01-02, per B-5)
- [x] Links resolver test `tests/backend/core/test_links.py` (Plan 01-02, per B-6)
- [x] AppRun shell test `frontend/src-tauri/appimage/AppRun.test.sh` (Plan 01-03, per W-1)
- [x] ffmpeg_utils test `tests/backend/services/test_ffmpeg_utils.py` (Plan 01-03, per W-2)
- [x] Perf settings test `tests/backend/test_perf_settings.py` (Plan 01-02, per B-2/B-7)

---

## 7. Out of Scope For This Validation

These items are explicitly NOT validated in Phase 1:
- Real Apple notarization / signed-binary path (deferred to v2 `SIGN-V2-01`).
- Real .deb install on a fresh Ubuntu 24.04 VM (covered by Phase 0 GATE-03 release.yml).
- Real AppImage launch on Fedora 44 (covered by Phase 0 GATE-03 release.yml).
- Cross-machine `omnivoice_data/` migration (documented limitation per RESEARCH.md Open Question #5).
- Mirror cascade for `uv venv` (Phase 3 INST-07..11).
- pen-test review of Fernet key derivation (Phase 6).

---

*VALIDATION.md derived during revision pass 1, 2026-05-18, addressing checker B-1.*
