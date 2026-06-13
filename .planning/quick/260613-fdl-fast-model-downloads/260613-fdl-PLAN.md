---
phase: 260613-fdl
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - pyproject.toml
  - backend/api/routers/setup/download.py
  - backend/api/routers/setup/models.py
  - backend/utils/hf_progress.py
  - backend/utils/download_aggregator.py        # NEW
  - backend/services/segmented_download.py       # NEW
  - backend/api/routers/system.py
  - frontend/src/pages/Settings.jsx
  - frontend/src/api/setup.ts
  - docs/downloading-models.md                    # NEW (docs-sync rule)
  - tests/backend/setup/test_download_preflight.py # NEW
  - tests/backend/services/test_segmented_download.py # NEW
autonomous: true
requirements:
  # ── Wave 0 — Spike / gate ───────────────────────────────────────────────────
  - FDL-00  # Classify all catalog repos Xet-backed vs legacy-LFS; the result sizes Wave 3
  # ── Wave 1 — Maximize + guarantee the Xet fast path (default, no new deps) ───
  - FDL-01  # Explicitly pin huggingface_hub>=1.7 + hf-xet in pyproject (today transitive/unpinned)
  - FDL-02  # Drive snapshot_download with explicit max_workers + tqdm_class + endpoint (not implicit monkeypatch)
  - FDL-03  # /system/info reports fast_download {xet_enabled, xet_version, high_performance}; logged at startup
  - FDL-04  # Opt-in HF_XET_HIGH_PERFORMANCE + HDD sequential-write toggles via prefs (env wins)
  # ── Wave 2 — Accurate downloaded/remaining + speed (the user-visible win) ────
  - FDL-05  # dry_run preflight -> emit install_plan {total_bytes, cached_bytes, to_download_bytes, n_files, n_cached}
  - FDL-06  # Backend aggregate tracker -> single 'aggregate' event {bytes_done, total_bytes, rate, eta, files_done/total}
  - FDL-07  # Frontend overall bar: speed + downloaded/remaining + ETA from aggregate; per-file detail collapsible; cached-skip shown
  # ── Wave 3 — Opt-in IDM-style accelerator for legacy-LFS repos ───────────────
  - FDL-08  # Custom httpx segmented downloader: parallel Range GETs, resume, auth-safe redirect, etag/sha verify, cancel (default OFF)
  - FDL-09  # Dispatch: accelerator ON + repo is LFS (not Xet) -> segmented path; else xet. Same aggregate progress + weight validation
  # ── Wave 4 — Opt-in mirror path + docs ───────────────────────────────────────
  - FDL-10  # Opt-in HF_ENDPOINT mirror setting (prefs); documented as classic-LFS fallback (no Xet); pairs with FDL-08
  - FDL-11  # Cancel-in-flight endpoint + cooldown interplay (composes with MM2-06 bounded cooldowns)
  - FDL-12  # docs/downloading-models.md (speed, fast-download status, HDD/high-perf toggles, mirror/restricted-network) + README pointer

must_haves:
  truths:
    - "Xet is the default download backend and is provably engaged: /system/info reports fast_download.xet_enabled=true with the hf_xet version, and a Xet-backed repo downloads via parallel chunk range-gets (not single-stream LFS)."
    - "Before any bytes flow, the UI shows an accurate denominator: total bytes to download, bytes already cached (skipped), and file count — sourced from snapshot_download(dry_run=True), not guessed from the first tqdm bar."
    - "During a download the UI shows ONE overall progress bar with instantaneous speed (sampled over a window, not a single file's rate), bytes downloaded / bytes remaining, and ETA — accurate even while Xet fetches many chunks/files in parallel."
    - "hf_transfer is NOT used or enabled anywhere (deprecated, breaks progress); the fast path is Xet only."
    - "The custom segmented downloader is OPT-IN (default off), only engages for non-Xet/legacy-LFS repos, never forwards the HF Authorization header to the redirected CDN host, verifies the downloaded file against its expected size/etag before marking complete, resumes a partial .part file, and can be cancelled mid-flight."
    - "Default download behavior is identical on macOS, Windows, Linux (Xet path, pure-Python). Every accelerator/mirror/high-perf knob is behind an explicit opt-in (Settings toggle or env var) per the cross-platform-parity strict rule — no bundled per-OS binary, no platform-divergent default."
    - "No new on-disk model-state format; existing HF cache layout and already-installed models are untouched; the segmented downloader writes into the same HF cache blob/snapshot structure (or hands off to it) so a model it fetches is indistinguishable from one snapshot_download fetched."
    - "uv run pytest tests/backend/setup/test_download_preflight.py tests/backend/services/test_segmented_download.py passes; existing download/install tests stay green."
    - "pyproject pins huggingface_hub>=1.7 and hf-xet explicitly; uv.lock resolves with single versions (uv tree shows no duplicate huggingface_hub)."
  artifacts:
    - path: "backend/utils/download_aggregator.py"
      provides: "Per-repo byte aggregator: sums bytes across parallel files/chunks, samples rate over a window, emits one 'aggregate' event"
      contains: "class DownloadAggregator AND def snapshot"
    - path: "backend/services/segmented_download.py"
      provides: "Opt-in multi-connection Range downloader for legacy-LFS repos (auth-safe, resume, verify, cancel)"
      contains: "async def segmented_download AND Range"
    - path: "backend/api/routers/setup/download.py"
      provides: "Driven snapshot_download (max_workers+tqdm_class+endpoint), dry_run preflight, dispatch to segmented path, cancel endpoint"
      contains: "dry_run AND tqdm_class"
    - path: "docs/downloading-models.md"
      provides: "User docs for download speed, fast-download status, HDD/high-perf toggles, mirror/restricted-network"
      contains: "Xet"
  key_links:
    - from: "install_model (download.py:122)"
      to: "snapshot_download(dry_run=True) preflight"
      via: "compute total/cached/remaining before the real download; emit 'install_plan'"
      pattern: "dry_run\\s*=\\s*True"
    - from: "snapshot_download / segmented_download byte updates"
      to: "DownloadAggregator -> single 'aggregate' SSE event"
      via: "tqdm_class forwards bytes into the aggregator; segmented path calls aggregator.add() directly"
      pattern: "aggregate"
    - from: "dispatch in install_model"
      to: "segmented_download vs snapshot_download"
      via: "prefs accelerator toggle AND repo-is-LFS classification (FDL-00 helper)"
      pattern: "segmented_download"
    - from: "system_info (system.py:245)"
      to: "fast_download status block"
      via: "probe hf_xet import + version + HF_XET_HIGH_PERFORMANCE"
      pattern: "fast_download"

---

<objective>
Make model downloads as fast as possible AND show accurate speed / downloaded / remaining / ETA.

**Framing (validated by research — see 260613-fdl-RESEARCH below):** HuggingFace's **hf-xet** backend ALREADY implements the "IDM/uGet technique" — content-defined chunking, parallel byte-range fetches with adaptive concurrency, dedup, and automatic resume — and does it auth-safely. It ships by default in modern `huggingface_hub` and `hf_xet` is already installed here (huggingface_hub 1.7.2). HF closed the multi-connection-downloader feature request as "solved by Xet." So we do NOT build a custom segmented downloader as the default path; that would be redundant and would violate the cross-platform-parity rule.

What's actually missing:
1. **We don't drive Xet well.** `install_model` calls `snapshot_download(**dl_kwargs)` with no `max_workers`, no `tqdm_class`, no `dry_run`, and no explicit dependency pin — progress rides on a global tqdm monkeypatch.
2. **No pre-flight total**, so "downloaded/remaining" has no denominator until files appear, and aggregate speed is summed frontend-side from per-file events (inaccurate under parallel fetch).
3. **Legacy non-Xet (LFS) repos get zero intra-file parallelism** — this is the one place a real IDM-style multi-connection fetch still helps, so we add it as an OPT-IN accelerator.

Five waves, in order (each independently shippable, continuous-to-main per v0.3.0 cadence):
- **Wave 0 — Spike/gate (FDL-00):** classify every catalog repo Xet vs LFS. Sizes Wave 3's value; if ~all repos are Xet-backed, Wave 3 is low-priority polish.
- **Wave 1 — Maximize + guarantee Xet (FDL-01..04):** pin deps, drive snapshot_download explicitly, surface fast-download status, opt-in high-perf/HDD knobs. No new deps, all platforms.
- **Wave 2 — Accurate progress (FDL-05..07):** dry_run preflight + backend aggregate tracker + overall UI bar (speed/remaining/ETA). The biggest user-visible win.
- **Wave 3 — Opt-in segmented accelerator (FDL-08..09):** custom httpx Range downloader for LFS repos. Default OFF, opt-in toggle.
- **Wave 4 — Mirror path + docs (FDL-10..12):** opt-in HF_ENDPOINT, cancel endpoint, docs-sync.

Out of scope / explicitly rejected (call out, do NOT do):
- **hf_transfer / HF_HUB_ENABLE_HF_TRANSFER** — deprecated, breaks progress callbacks. Never enable.
- **Bundling aria2c** — per-OS GPLv2 binary + parity burden; the custom httpx path covers the same need without a binary.
- **Making the segmented downloader the default** — redundant vs Xet, violates parity rule. Always opt-in.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md
@.planning/quick/260613-fdl-fast-model-downloads/260613-fdl-RESEARCH.md

# Files under edit (read before editing)
@backend/api/routers/setup/download.py
@backend/api/routers/setup/models.py
@backend/utils/hf_progress.py
@backend/api/routers/system.py
@frontend/src/pages/Settings.jsx

# Reference only — patterns, do NOT modify
@backend/core/prefs.py
@frontend/src/api/setup.ts
@frontend/src/api/hooks.ts

<interfaces>
<!-- Verified during planning against the live env (huggingface_hub 1.7.2, hf_xet installed). -->

huggingface_hub 1.7.2 snapshot_download params (confirmed via inspect):
  repo_id, repo_type, revision, cache_dir, local_dir, library_name, library_version,
  user_agent, etag_timeout, force_download, token, local_files_only,
  allow_patterns, ignore_patterns, max_workers, tqdm_class, headers, endpoint, dry_run
  - dry_run=True -> returns per-file info incl. size + cached/not-cached (use for FDL-05 preflight).
  - tqdm_class=<cls> -> drives the AGGREGATE bar; Xet feeds bytes into it (this is the xet-aware progress hook).
  - max_workers -> parallel FILES (default 8); orthogonal to Xet intra-file chunk parallelism.
  - endpoint -> per-call HF endpoint override (FDL-10 mirror, instead of process-wide HF_ENDPOINT).

backend/utils/hf_progress.py (existing):
  - Monkeypatches huggingface_hub.utils.tqdm.tqdm -> TrackedTqdm (install() at startup).
  - register_listener/unregister_listener; emit(event); current_repo_id contextvar stamps events.
  - TrackedTqdm.update()/display() emit per-file {filename, downloaded, total, pct, rate, phase} throttled ~0.3s.
  - GAP: per-file only, no aggregate, no preflight total. Wave 2 adds the aggregator on top (keep TrackedTqdm; feed it).

backend/api/routers/setup/download.py (existing):
  - install_model (line 122): snapshot_download(**dl_kwargs) inside asyncio.to_thread; 5-retry backoff; heartbeat;
    _validate_snapshot_has_weights (line 55); _install_cooldowns (line 27, see MM2-06 for bounding).
  - SSE feed: GET /setup/download-stream (line 80) forwards hf_progress events.

backend/core/prefs.py:
  - resolve(key, *, env=None, default=None) (line 75) — env wins, then store, then default. Use for all new toggles.

Xet env knobs (research): HF_XET_HIGH_PERFORMANCE=1 (opt-in max throughput; needs RAM/bandwidth),
  HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY=1 (HDD), HF_XET_NUM_CONCURRENT_RANGE_GETS (default 16),
  HF_XET_DATA_PROGRESS_UPDATE_INTERVAL (200ms). hf_xet is 64-bit only.
</interfaces>
</context>

<tasks>

<!-- ════════════ WAVE 0 — SPIKE / GATE ════════════ -->

<task type="auto">
  <name>Task 0 (FDL-00): Classify catalog repos Xet vs LFS</name>
  <files>.planning/quick/260613-fdl-fast-model-downloads/260613-fdl-SPIKE.md</files>
  <action>
For every repo in backend/config/models.yaml (25 entries), determine whether it's Xet-backed or legacy Git-LFS. Use huggingface_hub: `HfApi().repo_info(repo_id, files_metadata=True)` and inspect each LFS blob for xet info, OR call the model-info endpoint and check the `xetEnabled`/blob `xet` field. For gated/unavailable repos, record "unknown (gated/offline)".
Write 260613-fdl-SPIKE.md: a table repo_id | role | backend (xet|lfs|unknown) | size, plus a one-line GO/LOW-PRIORITY verdict for Wave 3:
  - If the majority of *user-facing default* models (OmniVoice TTS, the default ASR) are Xet-backed -> Wave 3 is LOW priority (xet already fast); still build it for the LFS long tail.
  - If many defaults are still LFS -> Wave 3 is HIGH priority.
This is read-only network classification — do not download anything (use repo_info, not snapshot_download).
  </action>
  <verify>
    <automated>test -f .planning/quick/260613-fast-model-downloads/260613-fdl-SPIKE.md || test -f .planning/quick/260613-fdl-fast-model-downloads/260613-fdl-SPIKE.md && echo "spike written"</automated>
  </verify>
  <done>SPIKE.md lists every catalog repo with its storage backend and a GO/LOW-PRIORITY verdict for Wave 3.</done>
</task>

<!-- ════════════ WAVE 1 — MAXIMIZE + GUARANTEE THE XET FAST PATH ════════════ -->

<task type="auto">
  <name>Task 1 (FDL-01): Pin huggingface_hub + hf-xet explicitly</name>
  <files>pyproject.toml</files>
  <action>
Today huggingface_hub arrives transitively (1.7.2) and hf_xet is present but unpinned. Add explicit runtime pins so the fast path can never silently disappear on a resolve:
  - huggingface_hub>=1.7 (keep compatible with transformers>=5.3.0 already in deps)
  - hf-xet>=1.1 (the Xet backend; 64-bit only — fine for all OmniVoice targets)
Do NOT add hf_transfer. Run `uv sync` then `uv tree huggingface_hub` to confirm a single resolved version (no duplicate). If a transitive constraint conflicts, prefer the higher version and note it in the SUMMARY.
  </action>
  <verify>
    <automated>grep -n "huggingface_hub\|hf-xet\|hf_xet\|hf-transfer\|hf_transfer" pyproject.toml</automated>
    <automated>uv run python -c "import huggingface_hub,hf_xet; print('hub',huggingface_hub.__version__,'xet ok')"</automated>
  </verify>
  <done>pyproject pins huggingface_hub>=1.7 and hf-xet; no hf_transfer; uv resolves cleanly with one huggingface_hub.</done>
</task>

<task type="auto">
  <name>Task 2 (FDL-02): Drive snapshot_download explicitly</name>
  <files>backend/api/routers/setup/download.py</files>
  <action>
In install_model's _do() (line ~148), build dl_kwargs with explicit, intentional args instead of the bare call:
  - tqdm_class=<the TrackedTqdm class> so progress is deterministic and xet-aware rather than relying solely on the global monkeypatch. Expose TrackedTqdm from hf_progress (add a getter, e.g. hf_progress.tracked_tqdm_class()).
  - max_workers: keep default 8 (don't crank — xet does intra-file parallelism; high max_workers multiplies buffer pressure). Make it prefs-overridable: prefs.resolve("download_max_workers", env="OMNIVOICE_DOWNLOAD_MAX_WORKERS", default=8).
  - endpoint=prefs.resolve("hf_endpoint", env="HF_ENDPOINT", default=None) — wires FDL-10 mirror without process-wide env.
  - Keep the existing 5-retry backoff, heartbeat, and _validate_snapshot_has_weights.
Do not remove the global monkeypatch (other libs — transformers/mlx_whisper — still rely on it); this task just makes the install path drive its own tqdm_class explicitly.
  </action>
  <verify>
    <automated>grep -n "tqdm_class\|max_workers\|endpoint" backend/api/routers/setup/download.py</automated>
    <automated>uv run pytest tests/ -k "download or install" -q 2>&amp;1 | tail -15</automated>
  </verify>
  <done>install_model drives snapshot_download with explicit tqdm_class + max_workers + endpoint; retry/validate intact; tests green.</done>
</task>

<task type="auto">
  <name>Task 3 (FDL-03, FDL-04): fast_download status + opt-in xet knobs</name>
  <files>backend/api/routers/system.py, backend/api/routers/setup/download.py</files>
  <action>
- FDL-03: add a fast_download block to GET /system/info (system.py:245): {xet_enabled: bool, xet_version: str|None, high_performance: bool}. Probe by importing hf_xet (xet_enabled), reading its version, and reading the HF_XET_HIGH_PERFORMANCE env/pref. Must never throw (system_info is called on every Settings load). Log the same line once at startup ("fast download: Xet on (hf_xet X.Y), high_perf=...").
- FDL-04: opt-in knobs via prefs, applied at process/download setup (env wins):
    high_performance = prefs.resolve("xet_high_performance", env="HF_XET_HIGH_PERFORMANCE", default=False)
    hdd_sequential   = prefs.resolve("xet_hdd_sequential_write", env="HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY", default=False)
  When set, export the corresponding HF_XET_* env before the snapshot/segmented download runs. Both default OFF (high-perf can hurt low-RAM machines — surface that as a tooltip in Wave 2 UI).
  </action>
  <verify>
    <automated>curl -s http://127.0.0.1:3900/system/info | python3 -c "import json,sys; print(json.load(sys.stdin).get('fast_download'))" 2>/dev/null || grep -n "fast_download" backend/api/routers/system.py</automated>
  </verify>
  <done>/system/info reports fast_download truthfully; high-perf + HDD knobs resolve via prefs with env precedence, default off; startup logs Xet status.</done>
</task>

<!-- ════════════ WAVE 2 — ACCURATE DOWNLOADED/REMAINING + SPEED ════════════ -->

<task type="auto">
  <name>Task 4 (FDL-05): dry_run preflight -> install_plan event</name>
  <files>backend/api/routers/setup/download.py</files>
  <action>
Before the real download in install_model, run snapshot_download(repo_id, dry_run=True, endpoint=...) on the worker thread. From the returned per-file info compute: total_bytes, cached_bytes (files already present), to_download_bytes, n_files, n_cached. Emit a new phase event:
  {repo_id, phase:"install_plan", total_bytes, cached_bytes, to_download_bytes, n_files, n_cached}
This gives the UI an accurate denominator and a "M GB already cached, N GB to download" line BEFORE bytes flow. Wrap dry_run in try/except — if it fails (older/gated repo), emit install_plan with totals=None and fall back to today's behavior (denominator fills in as files appear). dry_run must respect the 'resolving' heartbeat (it can take a couple seconds).
  </action>
  <verify>
    <automated>grep -n "dry_run\|install_plan\|to_download_bytes" backend/api/routers/setup/download.py</automated>
    <automated>uv run pytest tests/backend/setup/test_download_preflight.py -q 2>&amp;1 | tail -15</automated>
  </verify>
  <done>An install emits install_plan with accurate total/cached/remaining before download; dry_run failure degrades gracefully to old behavior.</done>
</task>

<task type="auto">
  <name>Task 5 (FDL-06): Backend aggregate progress tracker</name>
  <files>backend/utils/download_aggregator.py, backend/utils/hf_progress.py</files>
  <action>
New backend/utils/download_aggregator.py: a per-repo DownloadAggregator that owns the TRUTH for overall progress, so the frontend stops summing potentially-misrouted per-file events.
  - Seeded by the install_plan totals (total_bytes, n_files).
  - add(filename, bytes_delta) / set_file(filename, downloaded, total): track bytes per file; bytes_done = sum.
  - Rate: sampled over a sliding window (e.g. last ~5-10s of (t, bytes_done) samples), not a single tqdm bar's rate. eta = remaining / rate.
  - snapshot() -> {repo_id, bytes_done, total_bytes, rate, eta_seconds, files_done, files_total, phase}.
  - Emits one throttled (~0.3-0.5s) phase:"aggregate" event via hf_progress.emit().
Wire it: hf_progress's TrackedTqdm._emit_progress already has per-file (filename, downloaded, total) — also feed those into the active repo's aggregator (look up by current_repo_id). The segmented downloader (Wave 3) calls aggregator.add() directly. Keep the per-file events too (UI detail view) — aggregate is additive, not a replacement.
  </action>
  <verify>
    <automated>uv run python -c "from utils.download_aggregator import DownloadAggregator as A; a=A('r',total_bytes=100,files_total=2); a.set_file('f1',50,50); a.set_file('f2',25,50); s=a.snapshot(); print(s['bytes_done'], s['total_bytes'])"</automated>
  </verify>
  <done>DownloadAggregator sums bytes across parallel files, samples rate over a window, emits a single 'aggregate' event; fed by both tqdm and the segmented path.</done>
</task>

<task type="auto">
  <name>Task 6 (FDL-07): Frontend overall progress bar</name>
  <files>frontend/src/pages/Settings.jsx, frontend/src/api/setup.ts</files>
  <action>
- setup.ts: extend SetupProgressEvent phase union with "install_plan" | "aggregate" and their fields (total_bytes, cached_bytes, to_download_bytes, n_files, n_cached, bytes_done, rate, eta_seconds, files_done, files_total).
- Settings.jsx ModelStoreTab: when an aggregate event arrives for a repo, render ONE overall progress row: a bar (bytes_done/total_bytes), instantaneous speed (format rate as MB/s), "X.X GB of Y.Y GB" downloaded/remaining, and ETA (mm:ss from eta_seconds). Seed the denominator from install_plan (show "M GB cached, N GB to download" before bytes flow). Keep the existing per-file rows as a collapsible "details" section instead of the primary display. Show a small "⚡ fast download" badge when /system/info fast_download.xet_enabled is true.
- Prefer the backend aggregate's rate/eta over the frontend's own per-file ETA computation (Settings.jsx ~614-631) — replace that local ETA math with the aggregate fields; keep a fallback if no aggregate event has arrived yet.
  </action>
  <verify>
    <automated>cd frontend && bun run typecheck 2>&amp;1 | tail -15</automated>
    <automated>grep -n "aggregate\|install_plan\|eta_seconds\|fast download" frontend/src/pages/Settings.jsx frontend/src/api/setup.ts</automated>
  </verify>
  <done>UI shows one overall bar with live speed + downloaded/remaining + ETA from the aggregate event; per-file detail collapsible; fast-download badge; typecheck passes.</done>
</task>

<!-- ════════════ WAVE 3 — OPT-IN IDM-STYLE SEGMENTED ACCELERATOR (LFS REPOS) ════════════ -->

<task type="auto">
  <name>Task 7 (FDL-08): Custom httpx segmented downloader</name>
  <files>backend/services/segmented_download.py, tests/backend/services/test_segmented_download.py</files>
  <action>
New backend/services/segmented_download.py — an OPT-IN multi-connection Range downloader for ONE file (the IDM/uGet technique) used only for legacy-LFS repos where Xet gives no intra-file parallelism. httpx is already a dep.
Contract (async def segmented_download(url, dest, *, token, expected_size, expected_etag=None, num_connections=8, chunk_aggregator=None, cancel_event=None)):
  1. HEAD (or GET Range: bytes=0-0) the resolve URL to learn size + Accept-Ranges + the redirect target. If server doesn't honor Range (Accept-Ranges != bytes) -> fall back to a single streamed GET (still works, just not parallel).
  2. AUTH SAFETY (critical): send Authorization: Bearer <token> ONLY to the huggingface.co host. When the resolve URL 302-redirects to the CDN (cloudfront/etc.), do NOT forward Authorization to the CDN host — the presigned URL already carries auth. Follow redirects manually so you control header propagation per-host.
  3. Split expected_size into num_connections ranges; download each with Range: bytes=start-end concurrently (asyncio + httpx.AsyncClient). Write to dest+".part" at the right offsets (preallocate, or per-range temp files then concat).
  4. RESUME: if dest+".part" exists with a sidecar manifest of completed ranges, skip completed ranges.
  5. CANCEL: check cancel_event between chunks; on cancel, leave the .part for resume and raise CancelledError.
  6. VERIFY: after assembly, check size == expected_size and (if given) sha256/etag matches; only then atomically rename .part -> dest. On mismatch, raise (caller's retry/validate handles it).
  7. PROGRESS: call chunk_aggregator.add(filename, bytes_delta) as ranges complete bytes (feeds DownloadAggregator).
Tests (use a local mock HTTP server / httpx MockTransport): honors Range + parallel assembly == single-GET bytes; falls back when Accept-Ranges absent; does NOT send Authorization to a different host on redirect; resumes from a partial .part; cancels and leaves resumable state; size/etag mismatch raises.
  </action>
  <verify>
    <automated>uv run pytest tests/backend/services/test_segmented_download.py -q 2>&amp;1 | tail -20</automated>
    <automated>grep -n "Authorization\|Range\|cancel_event\|expected_size" backend/services/segmented_download.py</automated>
  </verify>
  <done>segmented_download fetches a file via parallel ranges, is auth-safe across the CDN redirect, resumes, cancels, and verifies size/etag before commit; all tests pass.</done>
</task>

<task type="auto">
  <name>Task 8 (FDL-09): Dispatch — accelerator for LFS repos only</name>
  <files>backend/api/routers/setup/download.py, backend/api/routers/setup/models.py</files>
  <action>
- models.py: add a small helper is_xet_backed(repo_id) -> bool|None (reuse FDL-00's classification approach; cache result). Used to decide the path.
- download.py install_model dispatch:
    accelerator_on = prefs.resolve("segmented_downloader", env="OMNIVOICE_SEGMENTED_DOWNLOAD", default=False)
    if accelerator_on and is_xet_backed(repo_id) is False:
        -> resolve each LFS file's URL via hf_hub_url + HfApi file metadata, download via segmented_download into the HF cache layout (or download to a temp dir then place via the cache API so the result is a normal cache entry), feeding the same DownloadAggregator. Run _validate_snapshot_has_weights at the end.
    else:
        -> existing snapshot_download path (xet).
  IMPORTANT: the segmented result MUST land in the same HF cache structure so /models install-state, delete, and is_cached() all keep working (truth: "indistinguishable from snapshot_download"). If matching the blob/snapshot symlink layout is too fiddly, the safe fallback is: segmented-download to a temp file, then hand the bytes to huggingface_hub so it finalizes the cache entry. Document the chosen approach in SUMMARY.
  Default OFF -> zero behavior change unless the user opts in.
  </action>
  <verify>
    <automated>grep -n "segmented_downloader\|is_xet_backed\|segmented_download" backend/api/routers/setup/download.py backend/api/routers/setup/models.py</automated>
    <automated>uv run pytest tests/ -k "download or install or model" -q 2>&amp;1 | tail -20</automated>
  </verify>
  <done>With the toggle ON, LFS repos download via the segmented path into the normal HF cache; Xet repos and the default (toggle OFF) use snapshot_download; install-state/delete unaffected.</done>
</task>

<!-- ════════════ WAVE 4 — MIRROR PATH + CANCEL + DOCS ════════════ -->

<task type="auto">
  <name>Task 9 (FDL-10, FDL-11): Mirror opt-in + cancel endpoint</name>
  <files>backend/api/routers/setup/download.py</files>
  <action>
- FDL-10: the endpoint= wiring from Task 2 already reads prefs hf_endpoint. Surface it as a setting and document (Task 10) that a mirror routes through the CLASSIC LFS path (no Xet) — so it pairs naturally with the FDL-08 segmented accelerator for speed on mirrors. No process-wide HF_ENDPOINT mutation; per-call endpoint only.
- FDL-11: add POST /models/install/cancel {repo_id} that sets the repo's cancel_event (segmented path) and, for the snapshot path, best-effort marks the install cancelled (snapshot_download isn't trivially cancellable mid-file — at minimum stop retries and emit install_cancelled). Compose with MM2-06: on success OR cancel, clear the _install_cooldowns entry so a cancelled download isn't rate-limited. Emit phase:"install_cancelled".
  </action>
  <verify>
    <automated>grep -n "install/cancel\|cancel_event\|install_cancelled\|hf_endpoint" backend/api/routers/setup/download.py</automated>
  </verify>
  <done>Per-call mirror endpoint wired (opt-in); cancel endpoint stops the segmented path and clears cooldown; emits install_cancelled.</done>
</task>

<task type="auto">
  <name>Task 10 (FDL-12): Docs — downloading-models.md + README pointer</name>
  <files>docs/downloading-models.md, README.md</files>
  <action>
Per the docs-sync hard rule, document the user-facing surface introduced here:
  - How fast downloads work (Xet on by default; what the ⚡ badge means; how to check via Settings/system info).
  - Advanced toggles: high-performance mode (warn: needs RAM/bandwidth, can hurt low-RAM machines), HDD sequential-write, max workers, segmented accelerator (opt-in, for legacy-LFS repos), and the mirror/restricted-network HF_ENDPOINT setting (note: mirror = classic LFS, no Xet; pair with the accelerator).
  - A short troubleshooting section (slow downloads, stuck at resolving, restricted networks/China).
Add a one-line pointer from README.md to docs/downloading-models.md. Do NOT enable any opt-in by default in docs examples.
  </action>
  <verify>
    <automated>test -f docs/downloading-models.md && grep -n "Xet\|HF_ENDPOINT\|high-performance\|segmented" docs/downloading-models.md | head</automated>
    <automated>grep -n "downloading-models" README.md</automated>
  </verify>
  <done>docs/downloading-models.md covers speed, status, all opt-in knobs, mirror/restricted-network, troubleshooting; README links it; no opt-in shown as default.</done>
</task>

</tasks>

<verification>
Gate per wave; full set before the last PR:
1. `uv run pytest tests/backend/setup/test_download_preflight.py tests/backend/services/test_segmented_download.py tests/ -k "download or install or model" -q` — green.
2. Live smoke (backend running): an install emits install_plan (accurate total/cached/remaining) THEN aggregate events with rising bytes_done + a non-zero rate + decreasing ETA; on completion bytes_done == total_bytes.
3. /system/info reports fast_download.xet_enabled=true with a version.
4. Auth-safety unit test proves Authorization is NOT sent to a non-huggingface.co host on redirect.
5. Default-off proof: with no opt-in set, an install uses snapshot_download (xet) — `OMNIVOICE_SEGMENTED_DOWNLOAD` unset means the segmented path is never taken.
6. `uv tree huggingface_hub` shows one version; no hf_transfer anywhere (`grep -ri hf_transfer backend/` is empty).
7. `cd frontend && bun run typecheck` passes.
8. Cross-platform parity: the default path (Xet, pure-Python) is identical on all 3 OSes; every accelerator/mirror/high-perf knob is opt-in (Settings/env). No bundled binary added.
</verification>

<success_criteria>
- Fast: Xet is pinned, engaged, and driven with explicit args; high-perf/HDD knobs available opt-in; legacy-LFS repos can use the opt-in segmented accelerator for real multi-connection speed.
- Accurate: UI shows pre-flight total/cached/remaining, then one overall bar with live speed + downloaded/remaining + ETA sourced from a backend aggregate (not frontend guesswork).
- Safe & compatible: no hf_transfer; segmented downloader is opt-in, auth-safe, resumable, verified, cancellable, and lands in the normal HF cache; default behavior identical on all 3 OSes; no new on-disk model state; existing installs untouched.
- All listed tests + typecheck pass; docs updated in the same PR (docs-sync rule).
</success_criteria>

<risks>
- **Segmented downloader auth leak (FDL-08) — highest risk.** Forwarding the HF Authorization header to the CDN host on redirect would leak the token. Mitigation: manual redirect handling, per-host header allow-list (Authorization only to huggingface.co), and a dedicated unit test asserting no Authorization on the CDN hop. This is a must-have truth, not optional.
- **Cache-layout mismatch (FDL-09).** If the segmented path writes files outside the HF cache blob/snapshot structure, /models install-state + delete + is_cached() break. Mitigation: prefer the temp-file-then-hand-to-huggingface_hub finalization approach over hand-rolling the symlink/blob layout; assert is_cached(repo_id) is true after a segmented install in a test.
- **dry_run cost/availability (FDL-05).** dry_run adds a metadata round-trip and may not exist for gated/older repos. Mitigation: try/except -> totals=None fallback to current fill-in-as-you-go behavior; keep the resolving heartbeat so the UI isn't blank during preflight.
- **Aggregate vs per-file double-count (FDL-06).** Feeding both tqdm per-file events and the aggregator risks the UI showing two competing numbers. Mitigation: aggregate is the single source of truth for the overall bar; per-file events only drive the collapsible detail view; the frontend's old per-file ETA math is removed (Task 6).
- **High-performance mode hurting low-RAM machines (FDL-04).** HF_XET_HIGH_PERFORMANCE can need ~tens of GB RAM. Mitigation: default OFF, opt-in only, tooltip warning in the UI.
- **Mirror + Xet confusion (FDL-10).** Users may expect Xet speed through a mirror; mirrors fall back to classic LFS. Mitigation: document explicitly; that's exactly why the segmented accelerator pairs with the mirror path.
- **Scope: do not let the segmented path become default.** It's opt-in for LFS repos only. Xet stays the default; making it default would regress dedup + violate the parity rule.
</risks>

<output>
Write 260613-fdl-SPIKE.md (Task 0) and 260613-fdl-SUMMARY.md when done. SUMMARY must record: the Xet-vs-LFS catalog breakdown and how it changed Wave 3 priority; the cache-finalization approach chosen for the segmented path (and the is_cached-after-segmented test result); the exact new SSE event shapes (install_plan, aggregate); which opt-in prefs keys + env vars were added; and the auth-safety test output. Note any "use judgment" decision an executor made.

Docs-sync (CLAUDE.md hard rule): docs/downloading-models.md + README pointer ship in the SAME PR as the user-facing toggles (Task 10). If the Settings UI gains the new toggles, the docs describing them land together.
</output>
