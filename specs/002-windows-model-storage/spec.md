# Feature Specification: Windows Model Storage & HF Cache

**Feature Branch**: `002-windows-model-storage` | **Created**: 2026-05-29
**Status**: Draft | **Input**: plan-01 (#128); children #117, #118, #64

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Cached models are recognised on Windows (Priority: P1)

A Windows user who already has models on disk (or just finished downloading)
opens OmniVoice. Today, HuggingFace's `scan_cache_dir()` raises `WinError 448
"untrusted mount point"` → the app concludes no models exist → re-downloads in a
5× loop and gives up, leaving the app unusable (#117, #118). After this change,
when `scan_cache_dir()` fails the app falls back to a direct filesystem check of
the canonical HF cache layout, so present models are recognised and not
re-downloaded.

**Why this priority**: This is the crash/loop that makes the app unusable on
Windows — the top first-run blocker. It delivers value on its own.

**Independent Test**: Force `scan_cache_dir()` to raise; with a populated cache
on disk, `is_cached()` / the models list still report the model installed.

**Acceptance Scenarios**:

1. **Given** a populated HF cache and `scan_cache_dir()` raising `WinError 448`,
   **When** the app checks model state, **Then** the cached model is reported
   installed (no re-download offered).
2. **Given** an empty/partial cache and `scan_cache_dir()` raising, **When**
   checked, **Then** the model is correctly reported not-installed.
3. **Given** macOS/Linux where `scan_cache_dir()` works, **When** checked,
   **Then** behaviour is unchanged (no regression).

### Edge Cases

- A `models--…/snapshots/<rev>/` directory that exists but is **empty** (an
  interrupted download) must NOT count as cached.
- The cache directory itself being unreadable → report not-cached, never crash.

## Requirements *(mandatory)*

- **FR-001**: When `scan_cache_dir()` raises, the system MUST fall back to a
  direct filesystem scan of `<cache>/models--<org>--<name>/snapshots/<rev>/` to
  determine whether a repo is cached.
- **FR-002**: The model-list and recommendation endpoints MUST use the same
  fallback so installed models render as installed during a `scan_cache_dir`
  failure.
- **FR-003**: A repo with no files under any snapshot revision MUST be reported
  not-cached.
- **FR-004**: Behaviour on platforms where `scan_cache_dir()` succeeds MUST be
  unchanged.
- **FR-005**: The cache directory resolution MUST honour `HF_HUB_CACHE` /
  `HUGGINGFACE_HUB_CACHE` / `HF_HOME` (already implemented) so a relocated/
  configurable models directory is respected by the fallback too.

## Success Criteria *(mandatory)*

- **SC-001**: With `scan_cache_dir()` forced to raise, a populated repo is
  detected as cached 100% of the time (regression-tested).
- **SC-002**: 0 re-download loops triggered for an already-present model on the
  WinError-448 path.
- **SC-003**: No regression on macOS/Linux model detection.

## Assumptions

- Symlink-disable env (`HF_HUB_DISABLE_SYMLINKS=1`) and `local_dir_use_symlinks=
  False` on Windows are already set (`main.py`, `setup/download.py`) — this spec
  covers the remaining `scan_cache_dir` failure path (fix-sequence step 2).
- The configurable models directory (#64, fix-sequence step 3-4) builds on the
  existing `OMNIVOICE_CACHE_DIR` / `HF_HOME` plumbing and is tracked as the
  remaining cluster item; this PR closes the crash children #117/#118.
