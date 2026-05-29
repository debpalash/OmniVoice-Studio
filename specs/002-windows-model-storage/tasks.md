# Tasks: Windows Model Storage & HF Cache (plan-01)

**Branch**: `002-windows-model-storage` | Closes #117, #118 (crash). Addresses #128; #64 follow-up.
**TDD**: tests written and confirmed RED before the fix.

## Phase 1: Regression tests (RED)

- [x] T001 `tests/test_hf_cache_fallback.py`: scan_cache_dir forced to raise →
  (a) populated repo detected as cached, (b) uncached repo not, (c) empty
  snapshot not counted, (d) disk scan reports size/files. Confirmed RED.

## Phase 2: Disk fallback (GREEN)

- [x] T002 `setup/models.py`: add `_repo_dir_name`, `_is_cached_on_disk`,
  `_scan_cache_on_disk`.
- [x] T003 Wire fallback into the `except` of `is_cached`, `list_models`,
  `recommendations`. Tests GREEN (4/4).

## Phase 3: Verify

- [x] T004 No regression on the non-Windows path (fallback only on raise).
- [ ] T005 Full backend suite green before PR.

## Out of scope (tracked)

- [ ] #64 configurable models directory: Settings field + persistence + startup
  read on top of the existing `OMNIVOICE_CACHE_DIR`/`HF_HOME` plumbing.
