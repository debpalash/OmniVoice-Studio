# SUMMARY — model-management v2 cleanup (mm2)

**Date:** 2026-06-13 · **Scope:** all 3 tiers (MM2-01..09). Backend-only; no frontend, no on-disk model-state change, no new deps.

## Tier 1 — correctness
- **MM2-01 (VRAM leak on engine switch):** `get_active_tts_backend()` now caches one instance per configured backend id and calls the outgoing engine's `unload()` before switching. Added `reset_active_backend()` for shutdown/tests. The `model=` OmniVoice fast-path still returns a fresh view over the shared singleton (no double-load) but a switch *away from* another engine still releases it. `tts_backend.py`.
- **MM2-02 (per-engine unload()):** `OmniVoiceBackend.unload()` drops the local ref + the shared `model_manager.model` singleton + `free_vram()` (idempotent, preload-safe, best-effort — no async lock from the sync path). `SubprocessBackend.unload()` routes to `unload_sidecar(self.id)` (busy sidecars skipped) and is inherited by every subprocess engine.
- **MM2-03 (honest ASR row):** `/model/loaded` ASR row now reports the pipe's actual device and carries a `note: "released with the TTS model"` so the disabled unload button is explained rather than silent.

## Tier 2 — single lifecycle surface
- **MM2-04 (`services/model_lifecycle.py`):** new facade owns `list_loaded()` / `unload(id)` / `unload_all()` / `free_vram()` across in-process TTS+ASR, diarization, and sidecars. `system.py` `/model/loaded` + `/model/unload` are now thin delegations; **response shapes preserved exactly** (`{models,count}`, `{unloaded,success,...}`, 400 on unknown id) — frontend untouched.
- **MM2-05 (unified idle config):** removed the duplicated `_IDLE_TIMEOUT_SECONDS`; the in-process idle timeout and the sidecar idle timeout both resolve per-tick via `prefs.resolve(... env=...)` (env wins, settings can tune without restart). New keys: `idle_timeout_seconds` (`OMNIVOICE_IDLE_TIMEOUT_S`), `sidecar_idle_timeout_seconds` (`OMNIVOICE_SIDECAR_IDLE_TIMEOUT_S`). `<=0` still disables sidecar reaping.

## Tier 3 — robustness & observability
- **MM2-06 (bounded cooldowns):** `_install_cooldowns` is swept (TTL 1h) on each install check and cleared on success — can no longer grow unbounded.
- **MM2-07 (per-role weight floor):** `_validate_snapshot_has_weights` uses per-extension floors (tensor formats keep 5 MB; `.onnx` floor 64 KB) **OR** the original ≥5 MB catch — strictly more lenient, so a small-but-complete ONNX model is no longer false-flagged as truncated while a 0/KB partial is still rejected (#352 intact).
- **MM2-08 (sidecar VRAM self-report):** the parent can't see a child's VRAM, so the GPU sidecar (`engines/indextts`) now reports `vram_mb` in its `pong` (CUDA/MPS-aware, 0 on CPU); the parent stashes the last-known figure and `list_live_sidecars()` surfaces it. CPU/absent sidecars honestly report 0.
- **MM2-09 (cache-fallback logging):** the `is_cached` `scan_cache_dir → on-disk` fallback now logs at WARNING with the exception type (was DEBUG/invisible) — the #117/#118 WinError-448 path is triagable from logs.

## Out of scope (as planned, not done)
GPU-pool per-engine sizing (`_GPU_VRAM_PER_JOB_GB`) and torch.compile tuning — perf, not cleanup; risk regressing #278/#315.

## Verification
- New `tests/test_mm2_lifecycle.py` — 15 tests (reuse/switch-unload/reset/idempotent-unload, facade list/unload/unknown/sidecars shapes + honest ASR, env-wins idle config, cooldown sweep, per-role weight floor ×3).
- Affected existing: `test_engines.py`, `test_subprocess_reaper.py`, `test_model_load_timeout.py`, `test_model_manager_preload.py` — green (no regressions).
- **Full suite: 1379 passed, 0 failed.** Live: facade endpoints return preserved shapes; engine switch calls the previous engine's `unload()` exactly once.

## Test placement note
MM2 tests live at top-level `tests/` (not `tests/backend/`) on purpose: adding files under `tests/backend/` reorders collection and can expose a pre-existing `sys.modules`-isolation leak in other backend fixtures (the issue debugged in the FDL PR). Top-level placement keeps `tests/backend/` order identical.

## Docs-sync
The new idle-timeout settings keys are internal env/prefs knobs with no UI surface, so no README/docs change is required by the docs-sync rule. If a future Settings panel exposes them, document there.
