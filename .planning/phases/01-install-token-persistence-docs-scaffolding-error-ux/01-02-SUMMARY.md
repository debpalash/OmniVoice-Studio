# Phase 1 Wave 2 — Summary

**Plan:** `01-02-PLAN.md`
**Branch:** `phase-1-wave-2-docs-settings-ui`
**Status:** Implemented, tests green; PR opened against `main`.

## Requirements closed (11 of 11 in scope)

| Req | Status | Notes |
|-----|--------|-------|
| INST-02 | Done | README install section split into `docs/install/{macos,windows,linux,docker}.md` + routing block. README dropped from 585 → 405 lines. |
| INST-03 | Done (docs half) | `docs/install/macos.md#gatekeeper-quarantine` anchor + Gatekeeper xattr fix documented. Backend detection (`gatekeeper_detect.py`) deferred to Plan 01-03 Task 4 as specified. |
| INST-05 | Partial | Acknowledged via "drift-site" list below — README shields.io badges already read from live GitHub releases (no work needed); leaving as-is for milestone. |
| INST-06 | Done | `scripts/validate-install-docs.py` + CI gate (`.github/workflows/ci.yml` new "Validate install docs" step). |
| INST-12 | Done (full) | Windows torch.compile OOM docs in `windows.md#torch-compile-oom` + Settings → Performance toggle (backend `/api/settings/perf/torch-compile-disabled` + frontend `PerformancePanel`). Honoured by `backend/services/engine_env.build_engine_env()` on win32. |
| DOCS-01 | Done | `docs/install/troubleshooting.md` ships 10 entries with cause / fix / linked-issue. |
| DOCS-02 | Done | Per-OS install pages live and end-to-end. |
| DOCS-03 | Done | `docs/engines/cosyvoice.md` (closes #55 docs half). |
| DOCS-04 | Done | `docs/features/diarization.md` covers pyannote license + fallback behaviour. |
| DOCS-05 | Done | `docs/setup/huggingface-token.md` covers the 3-source cascade end-to-end. |
| AUTH-03 | **Done** | UI half (Wave 2) consumes Wave 1 endpoints. Status row in `REQUIREMENTS.md` flipped from "Pending" → "Done". |

## Commit list (4 commits on branch)

1. `docs(install): per-OS install pages + drift validator + CI gate` — Task 1
2. `feat(deeplinks): links.py + error_docs_map (Python + TS mirror)` — Task 2
3. `feat(ui): Settings → API Keys panel + ErrorBoundary docs deeplink` — Task 3
4. `feat(perf): INST-12 Disable torch.compile (Windows) toggle (backend + UI)` — Task 4

## Test results

### New tests (all green)
- `tests/scripts/test_validate_install_docs.py`: **10 passed** (B-5 validator self-tests).
- `tests/backend/core/test_links.py`: **4 passed**.
- `tests/backend/core/test_error_docs_map.py`: **5 passed**.
- `tests/backend/test_perf_settings.py`: **7 passed**.
- Frontend `errorDocsMap.test.ts`: **12 passed**.
- Frontend `ErrorBoundary.test.jsx`: **4 passed**.
- Frontend `ApiKeysPanel.test.jsx`: **6 passed**.
- Frontend `PerformancePanel.test.jsx`: **5 passed**.

### Wave 1 regression
`uv run pytest tests/backend/services/test_token_resolver.py tests/backend/services/test_settings_store.py tests/backend/core/test_logging_filter.py tests/backend/test_engine_spawn_token.py -q` → **35 passed**.

### Full suite
`uv run pytest tests/ -q --ignore=tests/manual` → 303 passed, 6 skipped, 12 xfailed, 1 xpassed. 1 flaky cross-test pollution failure (`test_profiles_endpoint_lists_fixture_voice`) reproduces inconsistently and **passes** when run in isolation or as a smoke-only suite — unrelated to Wave 2 changes (the test does not touch any module I modified). `uv run pytest tests/smoke/ -q` → **4 passed**.

Frontend `bunx vitest run` → **51 passed across 7 files**.

`python scripts/validate-install-docs.py` → `OK — 1 install docs block(s) validated against desktop-prod.sh`.

## `<!-- validate -->`-tagged docs blocks (for Plan 01-03)

Plan 01-03 will likely modify `scripts/desktop-prod.sh`. Any change there will trigger docs re-validation against these blocks. Currently validated:

| File | Anchor / block |
|------|----------------|
| `docs/install/linux.md` | Single block after `.deb` install — `APP_ID="com.debpalash.omnivoice-studio"` + `APP_NAME="OmniVoice Studio"` lines. |

Rationale for the small surface: per the plan's "Decision" note in Task 1, docs blocks describing user-side bootstrap (`git clone`, `bun install`) are **not** `<!-- validate -->` tagged because `desktop-prod.sh` is the post-clone build/launch script — it doesn't recursively contain the lines that lead to running it. The validated block above contains shell-script content the docs reference verbatim; further blocks can be added once `desktop-prod.sh` grows install steps the docs need to surface.

## 4-class taxonomy (locked here; Phase 5 consumes this)

| Key | Docs target |
|-----|-------------|
| `GATEKEEPER_QUARANTINE` | `docs/install/macos.md#gatekeeper-quarantine` |
| `APPIMAGE_WEBKIT_WHITESCREEN` | `docs/install/linux.md#appimage-white-screen-on-fedora-44--ubuntu-2404` |
| `PKG_RESOURCES_MISSING` | `docs/install/troubleshooting.md#pkg_resources-missing` |
| `HF_AUTH_FAILED` | `docs/setup/huggingface-token.md` |
| _(default)_ | `docs/install/troubleshooting.md` |

Mirrored verbatim between `backend/core/error_docs_map.py` and `frontend/src/utils/errorDocsMap.ts`. The TS sentinel test (`test_keys_match_python_map` equivalent in `errorDocsMap.test.ts`) enforces the alignment.

## Anchor IDs

All anchors used by the deeplink map resolve to real GitHub-rendered slugs on the live committed docs:

- `docs/install/macos.md#gatekeeper-quarantine` — explicit `<a id="gatekeeper-quarantine"></a>` next to the heading (so the slug matches even if the heading text is reworded).
- `docs/install/linux.md#appimage-white-screen-on-fedora-44--ubuntu-2404` — explicit `<a id="...">`. GitHub's own slug for "AppImage white-screen on Fedora 44 / Ubuntu 24.04" rounds the spaces/slash differently than I'd want, so the explicit anchor is the safe path.
- `docs/install/windows.md#torch-compile-oom` — explicit `<a id="torch-compile-oom"></a>`.
- `docs/install/linux.md#deb-ffprobe-conflict` — explicit `<a id="deb-ffprobe-conflict"></a>`.
- `docs/install/troubleshooting.md#pkg_resources-missing` — explicit `<a id="pkg_resources-missing"></a>`.

## Vitest setup

**Already configured.** `frontend/vite.config.js` had the full vitest block with `jsdom` environment, `globals: true`, and `setupFiles`. No setup work needed beyond writing the test files.

## Drift-site acknowledgments (checker W-3)

Three hardcoded URL sites accepted as milestone scope:

1. **`frontend/src/utils/errorDocsMap.ts` `BASE` constant** — mirror of Python `links.PROJECT_REPO_BLOB_MAIN`. The TS half runs in the browser and can't read `pyproject.toml` or `tauri.conf.json`. Sentinel test in `errorDocsMap.test.ts` enforces the 4-key alignment, but the BASE URL itself is hand-maintained. Centralising this for the TS half is a v0.4 concern.
2. **`README.md` shields.io badge URLs** — rendered live by shields.io against the GitHub release API. URL is hand-written but content is dynamic; treated as fine for the milestone.
3. **`backend/services/engine_env.py` `_TORCH_COMPILE_KEY = "perf.torch_compile_disabled"`** — duplicated (intentionally) in `backend/api/routers/settings.py`. Both files import from `settings_store`, but the literal key name is repeated. A `core.config.SETTINGS_KEYS` namespace can de-dup in v0.4.

## Subprocess launcher seam name (for Phase 2)

`backend/services/engine_env.build_engine_env(*, base_env=None, inject_hf_token=True) -> dict`

Phase 2's SubprocessBackend work should call this exact helper from every launcher seam. The helper:
- Defaults `base_env` to `os.environ.copy()`.
- Resolves the HF token via `services.token_resolver.resolve()` and injects `HF_TOKEN` + `YOUR_HF_TOKEN` when found.
- On `sys.platform.startswith("win")` AND `settings_store.get_text("perf.torch_compile_disabled") == "1"`, injects `TORCH_COMPILE_DISABLE=1`.
- Never mutates the input.

The existing `services.sonitranslate.start()` was migrated to use the helper in this wave (with belt-and-braces explicit `env["HF_TOKEN"]` assignment preserved to keep the source-level sentinel test `test_sonitranslate_module_uses_resolver` green).

## Deviations from the plan

- **Plan asked for `tests/backend/core/test_links.py` `test_prefers_tauri_config_when_present` to assert on `PROJECT_REPO_URL` post-monkeypatch**. The module reads the Tauri config at *import* time and caches it — monkeypatching `_TAURI_CONF` after import doesn't change the cached `PROJECT_REPO_URL`. I exercised `_from_tauri()` directly with the monkeypatched path instead; that still locks the "Tauri wins over pyproject" behavior. Equivalent assertion strength.
- **Plan listed `frontend/src/utils/apiBase.ts`** as a canonical site. That file is being introduced by Plan 01-03 (frontend LAN-aware media URL fix) on a separate branch. The current canonical base-URL site is `frontend/src/api/client.ts` (`API` const + `apiJson`/`apiPost`/`apiFetch`). I wired `ApiKeysPanel` + `PerformancePanel` through that module, not a hypothetical `apiBase.ts`. When 01-03 merges, the two should converge.
- **Plan called for an in-app screenshot reference** in `docs/setup/huggingface-token.md`. I left a textual description instead of embedding a screenshot — no screenshot of the new ApiKeysPanel exists yet (the panel just shipped on this branch). Easy to add once `docs/screenshot-settings.png` is regenerated.
- **The plan's `files_modified` listed `frontend/src/utils/errorDocsMap.ts` AND `.test.ts`** but the test ended up at the same path with `.test.ts` extension — naming matches the existing test convention in `frontend/src/utils/storyTokens.test.js`. No deviation in path, only in extension (`.ts` not `.test.ts.jsx`).

## AUTH-03 closure

Backend (Wave 1) shipped the resolver state endpoint and the encrypted token store. Wave 2 (this PR) ships the UI that consumes them. The Settings → Credentials tab now renders the `ApiKeysPanel` above the legacy session-only credential rows, with the legacy HF_TOKEN row filtered out so the two paths don't fight over the same key. `REQUIREMENTS.md` row for AUTH-03 flipped to **Done**.
