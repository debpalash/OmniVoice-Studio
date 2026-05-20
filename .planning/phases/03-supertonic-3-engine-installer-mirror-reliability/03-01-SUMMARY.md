# Plan 03-01 Summary: Supertonic-3 Engine on SubprocessBackend

**Phase:** 3 — Supertonic-3 + Installer Mirror Reliability
**Plan:** 03-01 (Wave 1)
**Branch:** `worktree-agent-afdff0f3019e7724d`
**Base commit:** `84fffa5` (Phase 2 fully merged)
**Status:** Wave 1 implementation complete; PR open, awaiting review (no auto-merge).

## What shipped

A 7th opt-in TTS engine built on the Phase 2 `SubprocessBackend` primitive:

| Surface | File | Purpose |
|---|---|---|
| Engine class | `backend/engines/supertonic3/backend.py` | `Supertonic3Backend(SubprocessBackend)` — license-gated, CPU-only, SHA-pinned |
| Sidecar | `backend/engines/supertonic3/sidecar.py` | Length-prefixed JSON-over-stdio entry point; `--selftest` mode for release-prep |
| Constants | `backend/engines/supertonic3/constants.py` | `PINNED_REVISION_SHA = "724fb5abbf5502583fb520898d45929e62f02c0b"` (40 hex chars) + voice presets + license URLs |
| Package init | `backend/engines/supertonic3/__init__.py` | Re-exports `Supertonic3Backend` |
| Registry wiring | `backend/services/tts_backend.py` | `_LAZY_REGISTRY["supertonic3"]` entry + install hint |
| License helpers | `backend/services/settings_store.py` | `get_license_accepted` / `set_license_accepted` (with re-read invariant) |
| API endpoint | `backend/api/routers/settings.py` | `POST/GET /api/settings/license` (loopback-gated + engine_id allow-list) |
| Optional dep | `pyproject.toml` | `[project.optional-dependencies] supertonic = ["supertonic==1.3.1"]` |
| Lockfile | `uv.lock` | +supertonic 1.3.1; no other pin movement |
| Resolver script | `scripts/resolve_supertonic3_sha.py` | Release-prep helper — picks the latest commit on `main` whose tree touches ONNX weights / tokenizer |
| Frontend dialog | `frontend/src/components/SupertonicLicenseDialog.jsx` + `.css` | MIT (code) + OpenRAIL-M (model) modal with Accept gate |
| Frontend wiring | `frontend/src/components/EngineCompatibilityMatrix.jsx` | Surfaces an "Accept license" button on rows whose `reason` mentions "license not accepted" + opens the dialog |
| Tests | `tests/test_supertonic3.py` (13 tests, 10 non-network + 3 OMNIVOICE_SMOKE-gated) | Covers TTS-01..06 |
| Fixture | `tests/conftest.py` | `mock_settings_store` in-memory replacement so license-gate tests don't touch SQLite |

## Requirements coverage

| Requirement | Test |
|---|---|
| **TTS-01** — `_REGISTRY["supertonic3"]` resolves to `Supertonic3Backend(SubprocessBackend)` | `test_registry_contains_supertonic3`, `test_pep562_lazy_import` |
| **TTS-02** — `[project.optional-dependencies] supertonic` pinned; default install does not pull it; exactly one onnxruntime row | `test_optional_dep_pin`, `test_lockfile_no_onnxruntime_double_install`, `test_optional_dep_missing` |
| **TTS-03** — `PINNED_REVISION_SHA` is 40 hex chars and lives on the HF commit log | `test_pinned_sha_format`, `test_sha_resolves` (OMNIVOICE_SMOKE-gated) |
| **TTS-04** — `is_available()` message never contains "cuda" or "mps" | `test_cpu_only_honest` |
| **TTS-05** — License dialog gates first use; acceptance persists; `is_available()` is False until accepted | `test_license_gate`, frontend `SupertonicLicenseDialog.jsx` |
| **TTS-06** — 3 langs × 3 sec smoke generates 44.1 kHz mono float32 with no onnxruntime-gpu row | `test_smoke_3langs_3sec` (OMNIVOICE_SMOKE-gated) |

## Package legitimacy (Task 1 gate)

Verified before `uv add`:

1. **PyPI publisher** (https://pypi.org/pypi/supertonic/json) — author emails `ato@supertone.ai`, `juheon@supertone.ai`, `hyeongju@supertone.ai`; Project URLs point to `github.com/supertone-inc/supertonic-py` (note: `-py` suffix; the README also references `github.com/supertone-inc/supertonic`).
2. **Requires-Dist** declares only `onnxruntime`, `numpy`, `soundfile`, `huggingface-hub` (no `onnxruntime-gpu`).
3. **npm cross-ecosystem** — `npm view supertonic` returns the JS variant `supertonic@0.0.1` under the same maintainer `ato_sup <ato@supertone.ai>`. Same publisher, not a typosquat.
4. **Wheel inspection** — `unzip -l supertonic-1.3.1-py3-none-any.whl` shows pure-Python sources; no postinstall scripts, no `subprocess`/`exec` at module top level. `supertonic/config.py::MODEL_CONFIGS["supertonic-3"]["revision"]` itself pins the HF model to `724fb5abbf5502583fb520898d45929e62f02c0b` — we re-pin to the same SHA in `constants.py` for double assurance.

**Resume signal:** `approved 1.3.1`.

## Model SHA pin (TTS-03)

`PINNED_REVISION_SHA = "724fb5abbf5502583fb520898d45929e62f02c0b"`

This is the "Initial Supertonic 3 release" commit on `Supertone/supertonic-3`. Verified via the HuggingFace model API:

```
$ curl https://huggingface.co/api/models/Supertone/supertonic-3/revision/724fb5abbf5502583fb520898d45929e62f02c0b
sha: 724fb5abbf5502583fb520898d45929e62f02c0b
```

Identical to the SHA hard-coded inside `supertonic==1.3.1` (`supertonic.config.MODEL_CONFIGS`), so the sidecar's `snapshot_download(revision=...)` resolves to the same weights the SDK was validated against. Bumps go through `scripts/resolve_supertonic3_sha.py` — picks the latest commit on `main` whose tree contains `.onnx` / `tokenizer.json` (filters out README polish that doesn't change inference).

## License attribution (TTS-05)

| Component | License | URL |
|---|---|---|
| Inference SDK code (`supertonic` Python wheel) | MIT | https://github.com/supertone-inc/supertonic/blob/main/LICENSE |
| Model weights (`Supertone/supertonic-3` on HF) | OpenRAIL-M | https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE |

The frontend `SupertonicLicenseDialog.jsx` renders both as anchor tags (`target="_blank" rel="noopener noreferrer"`); Accept POSTs to `/api/settings/license` which writes through `settings_store.set_license_accepted("supertonic3", True)`. The settings table row key is `supertonic3_license_accepted = "1"`. The API endpoint allow-lists `engine_id="supertonic3"` server-side (frontend hard-codes the same; defense in depth).

## Threat model dispositions (mitigated)

| ID | Threat | Mitigation |
|---|---|---|
| T-03-01 | PyPI tampering / typosquat | Pre-install Task 1 human-verify checkpoint (publisher, repo, npm, wheel). Resume signal recorded above. |
| T-03-02 | HF model tampering | Sidecar passes `revision=PINNED_REVISION_SHA` to `snapshot_download`. SHA verified via HF model API. |
| T-03-03 | Token leak via env passthrough | SubprocessBackend.start() forwards HF_TOKEN/HF_ENDPOINT/HF_HUB_CACHE via `os.environ.copy()` (Phase 2 contract). Sidecar logs to stderr only, never echoes env. |
| T-03-04 | License gate as elevation-of-privilege | Accepted — honest-acknowledgment, not a security boundary. Endpoint is loopback-gated; engine_id is allow-listed. |
| T-03-05 | onnxruntime double-install | `test_lockfile_no_onnxruntime_double_install` asserts exactly one `onnxruntime` row, zero `onnxruntime-gpu` rows. `uv pip list` post-sync confirms. |

## Decisions / deviations from the plan

1. **`SettingsEngines.jsx` does not exist as a separate file in the current tree.** The plan's `files_modified` listed it; the equivalent panel in this tree is `frontend/src/components/EngineCompatibilityMatrix.jsx` (already a per-engine row table used by `pages/Settings.jsx`). I wired the license dialog there instead of creating a duplicate component — matches the plan's intent (license dialog appears on first enable of Supertonic-3) without introducing parallel UI surfaces.
2. **Test `test_registry_contains_supertonic3`** uses duck-typed structural checks (`__name__`, `_is_subprocess_isolated`, `hasattr`) instead of `issubclass(cls, TTSBackend)`. The `tests/backend/services/test_token_resolver.py` fixture aggressively purges `sys.modules["services.*"]` between scenarios, which produces a freshly-imported `TTSBackend` class object while the cached `Supertonic3Backend` still closes over the previous one — `issubclass` then returns False even though the class is correct. The duck-typed checks survive that re-import drift (same pattern `list_backends()` uses to detect SubprocessBackend subclasses).
3. **No dedicated venv for Supertonic-3.** Unlike IndexTTS, the `supertonic` SDK's 4 deps (`onnxruntime`, `numpy`, `soundfile`, `huggingface_hub`) live happily in the OmniVoice parent venv. `Supertonic3Backend.venv_python()` returns `sys.executable` — same Python the rest of OmniVoice runs in. Subprocess isolation is for parity with the Phase 2 pattern (crashes contained, sidecar can cold-start without blocking the API), not for dependency isolation.

## Test results

- `uv run pytest tests/test_supertonic3.py -v` — **10 passed, 3 skipped** (skips are OMNIVOICE_SMOKE-gated network tests).
- `uv run pytest tests/smoke/ -q` — **4 passed**.
- `uv run pytest tests/ -q --ignore=tests/manual` — **412 passed, 13 skipped, 13 xfailed, 1 xpassed, 0 failed** (baseline preserved; full Phase 2 suite still green alongside the new engine).

## Files touched (plan front-matter cross-check)

- `pyproject.toml` ✓
- `uv.lock` ✓
- `backend/engines/__init__.py` — already existed, no edit needed (subpackages register themselves)
- `backend/engines/supertonic3/__init__.py` ✓
- `backend/engines/supertonic3/constants.py` ✓
- `backend/engines/supertonic3/backend.py` ✓
- `backend/engines/supertonic3/sidecar.py` ✓
- `backend/services/tts_backend.py` ✓ (lazy-registry + install-hint additions; no SubprocessBackend touch — Phase 4 plan owns that surface)
- `backend/services/settings_store.py` ✓ (license helpers)
- `backend/api/routers/settings.py` ✓ (`/license` POST + GET, loopback-gated + allow-list)
- `scripts/resolve_supertonic3_sha.py` ✓
- `frontend/src/components/SupertonicLicenseDialog.jsx` ✓
- `frontend/src/components/SupertonicLicenseDialog.css` ✓
- `frontend/src/components/SettingsEngines.jsx` — n/a in this tree; equivalent integration landed in `EngineCompatibilityMatrix.jsx` (decision #1 above)
- `tests/test_supertonic3.py` ✓
- `tests/conftest.py` ✓ (`mock_settings_store` fixture)

## Next steps (deferred to subsequent waves)

1. **Wave 2** — Installer mirror reliability (INST-07..11) — `bootstrap.rs` mirror cascade, `mirrors.json` resource. Out of scope for Plan 03-01.
2. **Wave 2** — User-facing model-download progress (Pitfall 7). The sidecar already emits `progress` frames; surfacing them in the dub pipeline UI is a follow-up.
3. **TTS-06 smoke under CI** — Currently `OMNIVOICE_SMOKE=1` gated locally. Adding a nightly job that runs the 3-language smoke with HF auth would close the loop on TTS-06's "no onnxruntime-gpu in `uv pip list`" assertion across all release platforms.
