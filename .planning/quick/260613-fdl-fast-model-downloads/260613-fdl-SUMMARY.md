# SUMMARY — FDL Waves 0–2 (fast model downloads)

**Date:** 2026-06-13 · **Scope shipped:** W0 (spike), W1 (maximize Xet), W2 (accurate progress). W3/W4 deferred.

## What landed

**W0 — spike (FDL-00).** Classified all 25 `models.yaml` repos via the HF API `xetEnabled` field → **25/25 Xet-backed** (incl. both first-run defaults). See `260613-fdl-SPIKE.md`. Verdict: Wave 3 (segmented accelerator) is **LOW priority** — Xet already gives parallel chunked transfer for every shipped model. Detection caveat recorded: `repo_info` siblings on hf_hub **1.7.2** expose no xet metadata; classify via the `xetEnabled` API field, not siblings.

**W1 — maximize + guarantee Xet (FDL-01..04).**
- `pyproject.toml`: pinned `huggingface_hub>=1.7` + `hf-xet>=1.1` explicitly (was transitive/unpinned); no `hf_transfer`. Resolves to hf_hub 1.7.2 / hf-xet 1.4.2, single version.
- `download.py`: `install_model` now drives `snapshot_download` with explicit `tqdm_class` (our progress-emitting subclass), `max_workers` (prefs `download_max_workers`, default 8), and `endpoint` (prefs `hf_endpoint` — W4 hook). `apply_xet_env()` applies opt-in `HF_XET_HIGH_PERFORMANCE` + `HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY` (both default OFF, env wins).
- `system.py`: `/system/info` now returns `fast_download {xet_enabled, xet_version, high_performance}`; logged once at startup.

**W2 — accurate downloaded/remaining + speed (FDL-05..07).**
- Preflight `snapshot_download(dry_run=True)` → `compute_plan()` → `install_plan` SSE event with `total_bytes / cached_bytes / to_download_bytes / n_files / n_cached` **before bytes flow**. Degrades to totals=None on gated/older repos.
- New `utils/download_aggregator.py`: one source of truth for overall progress. Fed by a byte-sink on the patched tqdm; distinguishes byte bars (unit 'B', keyed by bar id) from the "Fetching N files" count bar; emits one throttled `aggregate` event (bytes_done/total/windowed rate/eta/files).
- Frontend `Settings.jsx` + `setup.ts`: overall bar driven by the aggregate; bar % = `max(byte%, file%)`; shows cached-skip + files-progress; `⚡ fast download` badge from `/system/info`. i18n keys added to `en.json`.

## Rebase reconciliation (main disabled Xet)
Rebasing onto latest main surfaced that main now sets **`HF_HUB_DISABLE_XET=1`** (main.py) — a deliberate choice to force the classic LFS path because Xet's progress bypasses the tqdm hook (the exact limitation found here). Reconciled rather than fought:
- `fast_download` status now reports the **runtime truth**: `xet_installed` + `xet_active` (active = installed AND not disabled) + `xet_enabled` alias. Default `xet_active=false`; the ⚡ badge only shows when Xet actually runs. Startup log: `downloads: Xet disabled → legacy LFS …`.
- Docs rewritten: default backend is **legacy LFS for accurate progress**; Xet is opt-in via `HF_HUB_DISABLE_XET=0` (coarser progress). The hf-xet pin stays (harmless; ready for a future Xet progress hook).
- Net: W2's progress is the value either way; W1's "maximize Xet" is dormant by main's design, not removed.

## Decisions / "use judgment" notes
- **Xet progress limitation (verified by live smoke).** Under Xet + hf_hub 1.7.2 the per-file **byte** bars never advance `n` and never `close()` through our tqdm (Xet fetches chunks out-of-band). Only the **file-count bar** is live. So: mid-download the overall bar is **file-granular** (moves 0→N files), and `complete()` flushes `bytes_done` to the exact preflight total on success (verified: final `74420620/74420620`, files 4/4). True live byte-speed is only available on classic-LFS/mirror repos (W4). This is a real constraint, not a bug — documented here and worth surfacing in W4 docs.
- Per-file detail kept inline (existing single-line summary, now aggregate-sourced) rather than a new collapsible panel — limited risk; can revisit.

## Drive-by fix
- `download.py` imported no `os`, but `_validate_snapshot_has_weights` uses `os.walk` → latent `NameError` on every install. Added `import os`.

## Verification
- `tests/backend/setup/test_download_preflight.py` — 10 pass (compute_plan splits, aggregator byte/count routing, close-credit, windowed rate/eta, registry feed + finish noop).
- `pytest -k "download or install or model or engine or setup"` — 149 passed, 7 skipped, 0 failed.
- `frontend typecheck:ci` — exit 0.
- Live smoke (real install of `mlx-community/whisper-tiny-mlx`, then deleted): `install_plan` exact; aggregate files 0→1→4; final bytes==total; `/system/info` + startup log correct.

## W4 — mirror + cancel + docs (FDL-10..12, shipped)
- **Mirror (FDL-10):** `snapshot_download(endpoint=…)` honours prefs `hf_endpoint` / env `HF_ENDPOINT` on both preflight and download — per-call, no process-wide mutation. Documented as the classic-LFS (non-Xet) path that restores continuous byte-speed.
- **Cancel (FDL-11):** `POST /models/install/cancel {repo_id}` sets a cancel flag checked at each retry boundary → emits `install_cancelled`, clears the cooldown (cancel ≠ failure). Limitation: an in-flight single-file fetch isn't interruptible in hf_hub 1.7.2; cancel lands at the next retry boundary. Frontend treats `install_cancelled` as a terminator (clears row + refetch).
- **Docs (FDL-12):** `docs/downloading-models.md` (Xet fast path, progress semantics incl. the byte-speed limitation, opt-in tuning knobs, mirror/restricted-network, cancel, troubleshooting) + README pointer. Docs-sync rule satisfied in-PR.

## W3 — opt-in segmented accelerator (FDL-08/09, shipped)
Reprioritised from LOW to HIGH after the rebase: since main forces Xet off, the default path is single-stream legacy LFS, so a segmented downloader is the way to get **both** parallel speed and live byte progress.
- `services/segmented_download.py`: async multi-connection Range downloader for one file — parallel byte-ranges, resume (`.part` + manifest), per-segment short-read truncation guard, optional sha256/etag verify, cancel, single-stream fallback when the server won't range. **Auth-safe**: the HF `Authorization` header goes only to `huggingface.co`/`hf.co`; never forwarded to a CDN host on redirect (unit-tested).
- Dispatch (`download.py`): opt-in via prefs `segmented_downloader` / env `OMNIVOICE_SEGMENTED_DOWNLOAD` (default OFF). When on and Xet inactive, fetches each repo file into the HF cache mirroring `hf_hub_download` (blobs + snapshot symlinks + `refs/main`), feeding **real bytes** to the aggregator. Any failure falls back to `snapshot_download` — the accelerator can never break a correct install.
- Verified live (accelerator ON): real mid-download byte progress (1.5 KB → 71 MB, rate ramping to **16.6 MB/s**), final `bytes_done == total`, `/models` shows `installed: True`, delete frees the right bytes.
- Fixed a `complete()` double-count (was adding a full total on top of accumulated segmented bytes → 2×); now replaces byte bars so the sum is exactly total.
- Tests: `tests/backend/services/test_segmented_download.py` (7 cases) covering parallel range reassembly, single-stream fallback, the auth header reaching only the HF host (never a CDN), size/truncation rejection, cancellation, and byte-callback totals — plus an aggregator double-count regression.
