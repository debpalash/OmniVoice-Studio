# Implementation Plan: Windows Model Storage & HF Cache (plan-01)

**Branch**: `002-windows-model-storage` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

## Summary

Close the Windows `WinError 448` re-download loop (#117/#118). Much of plan-01's
fix-sequence already ships (symlink-disable env in `main.py`,
`local_dir_use_symlinks=False` in `setup/download.py`, `OMNIVOICE_CACHE_DIR` →
`HF_HOME`/`HF_HUB_CACHE` override, `os.environ.copy()` subprocess forwarding).
The unfixed defect is fix-sequence **step 2**: the three `scan_cache_dir()` call
sites in `setup/models.py` swallow the WinError and report "not cached", so the
app re-downloads. This PR makes them fall back to a direct filesystem scan.

## Constitution Check

| Principle | Status |
|-----------|--------|
| I. Local-First | ✅ no network/telemetry added |
| II. First-Run Works | ✅ (implements) — removes the Windows first-run loop |
| III. Cross-Platform Parity | ✅ fallback only triggers when scan_cache_dir raises (Windows); mac/Linux unchanged |
| IV. Backward-Compatible | ✅ no schema/data change; honours existing cache env |
| V. Root-Cause + Regression Tests | ✅ cluster master; ships fail-before/pass-after tests |

## Change sites (`backend/api/routers/setup/models.py`)

1. `_repo_dir_name(repo_id)` — `org/name` → `models--org--name`.
2. `_is_cached_on_disk(repo_id)` — walks `<cache>/models--…/snapshots/<rev>/`,
   cached iff a revision dir has files. The `is_cached()` fallback.
3. `_scan_cache_on_disk()` — filesystem equivalent of `scan_cache_dir()` returning
   `{repo_id: {size_on_disk, last_accessed, nb_files}}`. The `list_models()` /
   `recommendations()` fallback.
4. Wire the fallback into the `except` of `is_cached()`, `list_models()`,
   `recommendations()`.

## Out of scope (remaining cluster item)

Configurable models directory UI (#64, fix-sequence step 3-4) — the env plumbing
exists; a Settings field + persistence + startup read is the follow-up that
closes #64 within the v0.3.0 line.

## Tests

`tests/test_hf_cache_fallback.py` — scan_cache_dir forced to raise: cached repo
detected, uncached repo not, empty snapshot not counted, disk scan reports
size/files. Fail-before/pass-after.
