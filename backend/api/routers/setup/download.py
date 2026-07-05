"""Model download and deletion endpoints.

Extracted from the monolithic ``setup.py``.

- ``GET  /setup/download-stream``  — SSE for HF tqdm progress
- ``POST /models/install``         — start background model download
- ``DELETE /models/{repo_id}``     — remove cached model from disk
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core import prefs
from utils import hf_progress
from utils import download_aggregator
# Weight-floor scan (MM2-07 / #352) lives in ``models.py`` — the lowest module in
# the setup import graph — so install-time validation here, the first-run
# install-state detector (#622), and load-time repair share one set of floors and
# can't drift apart. ``_MIN_WEIGHT_BYTES``/``_WEIGHT_FLOORS`` re-exported for tests.
from .models import (  # noqa: F401
    KNOWN_MODELS,
    invalidate_cache,
    snapshot_has_weights,
    disk_space_error,
    _MIN_WEIGHT_BYTES,
    _WEIGHT_FLOORS,
)

logger = logging.getLogger("omnivoice.setup.download")
router = APIRouter()

# Cooldown: prevent rapid re-install after a failure. Maps repo_id → last_fail_time.
_install_cooldowns: dict[str, float] = {}
_COOLDOWN_SECS = 60.0
# Evict cooldown entries older than this so the dict can't grow unbounded across
# a long-lived process (MM2-06). Anything past the cooldown window is dead state.
_COOLDOWN_TTL_SECS = 3600.0


def _sweep_cooldowns(now: float) -> None:
    """Drop cooldown entries older than the TTL (MM2-06). Keeps the dict bounded
    — without this it accumulated one entry per ever-failed repo forever."""
    stale = [k for k, t in _install_cooldowns.items() if (now - t) > _COOLDOWN_TTL_SECS]
    for k in stale:
        _install_cooldowns.pop(k, None)

# Repo_ids the user asked to cancel (FDL-11). Checked between retry attempts.
# Note: a single in-flight snapshot_download/Xet fetch is not interruptible
# mid-file in hf_hub 1.7.2 — cancel stops further retries, marks the row
# cancelled, and clears the cooldown so a cancel isn't rate-limited.
_cancelled: set[str] = set()


def _download_max_workers() -> int:
    """Parallel-FILES worker count for snapshot_download (FDL-02). Default 8 —
    don't crank it: Xet already parallelises *within* each file via concurrent
    byte-range gets, so a high count just multiplies buffer pressure. Override
    via prefs / OMNIVOICE_DOWNLOAD_MAX_WORKERS for power users."""
    raw = prefs.resolve("download_max_workers", env="OMNIVOICE_DOWNLOAD_MAX_WORKERS", default=8)
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return 8


def _download_endpoint() -> "str | None":
    """Optional HF endpoint override (FDL-10 mirror path, opt-in). Returned as a
    per-call ``endpoint=`` rather than a process-wide HF_ENDPOINT mutation. A
    mirror routes through the classic LFS path (no Xet) — documented in
    docs/downloading-models.md."""
    ep = prefs.resolve("hf_endpoint", env="HF_ENDPOINT", default=None)
    return ep or None


def apply_xet_env() -> None:
    """Apply opt-in Xet tuning knobs to the environment before a download
    (FDL-04). Both default OFF; env wins over the prefs store. high-performance
    can *hurt* low-RAM machines (needs lots of RAM/bandwidth); HDD-sequential
    avoids parallel-write thrash on spinning disks. Idempotent."""
    import os as _os
    high_perf = prefs.resolve("xet_high_performance", env="HF_XET_HIGH_PERFORMANCE", default=False)
    if _truthy(high_perf):
        _os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
    hdd_seq = prefs.resolve("xet_hdd_sequential_write", env="HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY", default=False)
    if _truthy(hdd_seq):
        _os.environ["HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY"] = "1"


def _truthy(v) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


class _InstallCancelled(Exception):
    """Raised inside the install worker when the user cancels (FDL-11)."""


def compute_plan(plan_files) -> dict:
    """Summarise a snapshot_download(dry_run=True) result into the install_plan
    payload (FDL-05): total bytes, bytes already cached (skipped), bytes that
    will actually download, and file counts. ``will_download`` defaults to
    ``not is_cached`` for forward-compat with older DryRunFileInfo shapes."""
    total = sum(int(getattr(f, "file_size", 0) or 0) for f in plan_files)
    cached = sum(
        int(getattr(f, "file_size", 0) or 0)
        for f in plan_files if getattr(f, "is_cached", False)
    )
    will = [
        f for f in plan_files
        if getattr(f, "will_download", not getattr(f, "is_cached", False))
    ]
    to_dl = sum(int(getattr(f, "file_size", 0) or 0) for f in will)
    n_files = len(plan_files)
    n_cached = sum(1 for f in plan_files if getattr(f, "is_cached", False))
    return {
        "total_bytes": total,
        "cached_bytes": cached,
        "to_download_bytes": to_dl,
        "n_files": n_files,
        "n_cached": n_cached,
    }


def _segmented_enabled() -> bool:
    """IDM-style multi-connection accelerator (FDL-09), default **ON**. The app
    forces the legacy-LFS path (HF_HUB_DISABLE_XET=1) for clear progress, but that
    path is single-stream and slow — this restores parallel byte-range speed AND
    real live progress, and falls back to snapshot_download on any error so it
    can never compromise a correct install. Default-on so first-run downloads are
    fast out of the box (pairs with an HF token for higher rate limits); set
    OMNIVOICE_SEGMENTED_DOWNLOAD=0 to force the single-stream path."""
    return _truthy(prefs.resolve(
        "segmented_downloader", env="OMNIVOICE_SEGMENTED_DOWNLOAD", default=True,
    ))


def _xet_active() -> bool:
    """True only when hf_xet is installed AND not disabled. The app sets
    HF_HUB_DISABLE_XET=1 by default, so this is normally False — which is when
    the segmented accelerator pays off."""
    import importlib.util
    if importlib.util.find_spec("hf_xet") is None:
        return False
    return os.environ.get("HF_HUB_DISABLE_XET", "").strip().lower() not in {"1", "true", "yes", "on"}


def _repo_cancelled(repo_id: str) -> bool:
    return repo_id in _cancelled


def _segmented_snapshot(repo_id: str, *, endpoint: "str | None") -> str:
    """Fetch every file of a repo via the segmented downloader into the HF
    cache, mirroring hf_hub_download's blob+snapshot+refs layout so the result
    is indistinguishable from snapshot_download (FDL-09) — keeping /models
    install-state, is_cached, and delete working. Feeds real bytes to the
    aggregator. Raises on any error; the caller falls back to snapshot_download.
    """
    import asyncio as _asyncio
    from huggingface_hub import HfApi, constants as _C
    from huggingface_hub.file_download import (
        hf_hub_url, get_hf_file_metadata, repo_folder_name, _create_symlink,
    )
    from services.segmented_download import segmented_download
    from services.token_resolver import resolve as _resolve_token

    token = _resolve_token()
    api = HfApi(endpoint=endpoint, token=token)
    info = api.repo_info(repo_id, repo_type="model")
    commit = info.sha
    files = [s.rfilename for s in (info.siblings or [])]
    if not commit or not files:
        raise RuntimeError("repo_info returned no commit/siblings")

    repo_dir = os.path.join(_C.HF_HUB_CACHE, repo_folder_name(repo_id=repo_id, repo_type="model"))
    blobs_dir = os.path.join(repo_dir, "blobs")
    snap_dir = os.path.join(repo_dir, "snapshots", commit)
    refs_dir = os.path.join(repo_dir, "refs")
    for d in (blobs_dir, snap_dir, refs_dir):
        os.makedirs(d, exist_ok=True)

    for rel in files:
        if _repo_cancelled(repo_id):
            raise _InstallCancelled()
        url = hf_hub_url(repo_id, rel, endpoint=endpoint, revision=commit)
        meta = get_hf_file_metadata(url, token=token)
        etag = (meta.etag or "").strip('"')
        if not etag:
            raise RuntimeError(f"no etag for {rel}")
        blob_path = os.path.join(blobs_dir, etag)
        pointer = os.path.join(snap_dir, rel)
        os.makedirs(os.path.dirname(pointer), exist_ok=True)
        if not os.path.exists(blob_path):
            _asyncio.run(segmented_download(
                meta.location or url, blob_path,
                token=token, expected_size=meta.size, expected_etag=etag,
                on_bytes=lambda d, k=rel: download_aggregator.add_bytes(repo_id, k, d),
                cancel_check=lambda: _repo_cancelled(repo_id),
            ))
        if not os.path.lexists(pointer):
            _create_symlink(blob_path, pointer, new_blob=True)

    # refs/main → commit so scan_cache_dir maps the revision correctly.
    try:
        with open(os.path.join(refs_dir, "main"), "w") as f:
            f.write(commit)
    except OSError:
        pass
    return snap_dir


# ── SSE Download Stream ───────────────────────────────────────────────────

def _safe_put(queue: asyncio.Queue, event) -> None:
    """Non-blocking enqueue — drop oldest on overflow rather than block."""
    try:
        queue.put_nowait(event)
    except asyncio.QueueFull:
        try:
            queue.get_nowait()
            queue.put_nowait(event)
        except Exception:
            pass


# Minimum size for "this snapshot actually contains model weights". An
# interrupted snapshot_download can leave config/tokenizer files but no
# weights; the install then looks complete and synthesis later fails with
# "does not appear to have a file named pytorch_model.bin or
# model.safetensors" (#352). 5 MB clears every weight format we ship
# (safetensors/bin shards, onnx, pt, gguf) without false-positiving on
# config-only aux repos.
def _validate_snapshot_has_weights(repo_id: str, snapshot_path: str) -> None:
    """Raise OSError when a finished snapshot has no plausible weight file —
    surfaces the truncated-download class (#352) at install time, where the
    retry loop and the UI's re-download path can deal with it, instead of at
    first synthesis with an opaque transformers error.

    Delegates the weight check to ``models.snapshot_has_weights`` (single source of
    the floors); only the install-time error message lives here."""
    if snapshot_has_weights(snapshot_path):
        return
    biggest = 0
    try:
        for root, _dirs, files in os.walk(snapshot_path, followlinks=True):
            for f in files:
                try:
                    biggest = max(biggest, os.path.getsize(os.path.join(root, f)))
                except OSError:
                    continue
    except OSError:
        pass
    raise OSError(
        f"{repo_id}: download finished but no model weights were found in the "
        "snapshot (largest file "
        f"{biggest} bytes). The download was likely interrupted — delete the "
        "model in Settings → Models and install it again."
    )


@router.get("/setup/download-stream")
async def setup_download_stream():
    """SSE: forward every HuggingFace download tqdm update as a JSON event."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    loop = asyncio.get_running_loop()

    def listener(event):
        try:
            loop.call_soon_threadsafe(_safe_put, queue, event)
        except RuntimeError:
            pass

    listener_id = hf_progress.register_listener(listener)

    async def gen():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            hf_progress.unregister_listener(listener_id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ── Install ────────────────────────────────────────────────────────────────

class InstallModelRequest(BaseModel):
    repo_id: str


@router.post("/models/install")
async def install_model(req: InstallModelRequest):
    """Download one HF repo snapshot; progress goes through the shared
    ``/setup/download-stream`` SSE feed."""
    if req.repo_id not in [m["repo_id"] for m in KNOWN_MODELS]:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown model: {req.repo_id!r}. Known: "
                + ", ".join(m["repo_id"] for m in KNOWN_MODELS)
            ),
        )
    # Cooldown guard — don't retry if the same model just failed.
    import time as _time_check
    _sweep_cooldowns(_time_check.time())  # bound the dict (MM2-06)
    last_fail = _install_cooldowns.get(req.repo_id)
    if last_fail and (_time_check.time() - last_fail) < _COOLDOWN_SECS:
        remaining = int(_COOLDOWN_SECS - (_time_check.time() - last_fail))
        raise HTTPException(
            status_code=429,
            detail=(
                f"Model {req.repo_id!r} install failed recently. "
                f"Retry in {remaining}s or check your network."
            ),
        )
    loop = asyncio.get_running_loop()

    def _do():
        token = hf_progress.current_repo_id.set(req.repo_id)
        _cancelled.discard(req.repo_id)  # clear any stale cancel from a prior run
        hf_progress.emit({
            "repo_id": req.repo_id,
            "filename": req.repo_id,
            "downloaded": 0, "total": 0, "pct": 0.0,
            "phase": "install_start",
        })
        try:
            from huggingface_hub import snapshot_download
            from huggingface_hub.utils import (
                HfHubHTTPError,
                LocalEntryNotFoundError,
            )
            logger.info("model install starting: %s", req.repo_id)
            # Apply opt-in Xet tuning knobs (high-perf / HDD) before downloading.
            apply_xet_env()
            # Drive snapshot_download explicitly (FDL-02): pass our progress-
            # emitting tqdm subclass so progress is deterministic + Xet-aware
            # (Xet feeds bytes into whatever tqdm_class is supplied), bound the
            # parallel-files worker count, and honour an optional mirror endpoint.
            dl_kwargs: dict = {
                "repo_id": req.repo_id,
                "max_workers": _download_max_workers(),
            }
            _tqdm_cls = hf_progress.tracked_tqdm_class()
            if _tqdm_cls is not None:
                dl_kwargs["tqdm_class"] = _tqdm_cls
            _endpoint = _download_endpoint()
            if _endpoint:
                dl_kwargs["endpoint"] = _endpoint
            if sys.platform == "win32":
                dl_kwargs["local_dir_use_symlinks"] = False

            # Emit a 'resolving' heartbeat every 2s while snapshot_download
            # resolves repo metadata (before any tqdm bars appear).
            import threading
            import time as _t
            _resolving = threading.Event()

            def _heartbeat():
                _step = 0
                while not _resolving.is_set():
                    _resolving.wait(2.0)
                    if _resolving.is_set():
                        break
                    _step += 1
                    hf_progress.emit({
                        "repo_id": req.repo_id,
                        "filename": req.repo_id,
                        "downloaded": 0, "total": 0, "pct": 0.0,
                        "phase": "resolving",
                        "step": _step,
                    })

            hb = threading.Thread(target=_heartbeat, daemon=True)
            hb.start()

            # Pre-flight (FDL-05): a dry-run resolve gives the UI an accurate
            # denominator — total bytes, bytes already cached (skipped), and the
            # bytes that will actually download — BEFORE any byte flows. Seeds
            # the overall aggregator so its bar/ETA are correct from the first
            # event. Degrades gracefully (totals=None) on older/gated repos.
            _preflight_kwargs = {"repo_id": req.repo_id, "dry_run": True}
            if _endpoint:
                _preflight_kwargs["endpoint"] = _endpoint
            try:
                _plan = snapshot_download(**_preflight_kwargs)
                _summary = compute_plan(_plan)
                # Disk-space guard (before a single byte flows): the preflight
                # gives an exact "to download" size, so reject an install that
                # would overrun the cache volume — with the numbers named —
                # instead of failing mid-download with a cryptic OSError. No-op
                # when it fits or the size is unknown. Same on every platform.
                _disk_err = disk_space_error(_summary["to_download_bytes"])
                if _disk_err:
                    logger.info("model install %s: rejected — %s", req.repo_id, _disk_err)
                    _resolving.set()  # stop the heartbeat thread before we bail
                    hf_progress.emit({
                        "repo_id": req.repo_id,
                        "filename": req.repo_id,
                        "downloaded": 0, "total": 0, "pct": 0.0,
                        "phase": "install_error",
                        "error": _disk_err,
                    })
                    # A disk-full is not a transient network failure — don't set
                    # a cooldown (freeing space, not waiting, is the fix). The
                    # outer finally still cleans up the aggregator + context.
                    return
                download_aggregator.start(
                    req.repo_id,
                    total_bytes=_summary["to_download_bytes"],
                    files_total=max(0, _summary["n_files"] - _summary["n_cached"]),
                )
                hf_progress.emit({
                    "repo_id": req.repo_id,
                    "filename": req.repo_id,
                    "phase": "install_plan",
                    **_summary,
                })
            except Exception as _pf_err:
                # No preflight (older/gated repo, mirror without dry-run, etc.):
                # fall back to today's fill-in-as-files-appear behaviour.
                logger.info("model install %s: preflight unavailable (%s)", req.repo_id, _pf_err)
                download_aggregator.start(req.repo_id)
                hf_progress.emit({
                    "repo_id": req.repo_id,
                    "filename": req.repo_id,
                    "phase": "install_plan",
                    "total_bytes": None,
                    "cached_bytes": None,
                    "to_download_bytes": None,
                    "n_files": None,
                    "n_cached": None,
                })

            _max_attempts = 5
            _attempt = 0
            while True:
                if req.repo_id in _cancelled:
                    raise _InstallCancelled()
                _attempt += 1
                try:
                    # Segmented accelerator (FDL-09, default ON): parallel
                    # byte-range fetch with real live progress, for the
                    # legacy-LFS path. Any failure falls through to
                    # snapshot_download — the accelerator can never compromise a
                    # correct install.
                    _snapshot_path = None
                    if _attempt == 1 and _segmented_enabled() and not _xet_active():
                        try:
                            _snapshot_path = _segmented_snapshot(req.repo_id, endpoint=_endpoint)
                        except _InstallCancelled:
                            raise
                        except Exception as _seg_err:
                            logger.info(
                                "segmented download for %s failed (%s); falling back to snapshot_download",
                                req.repo_id, _seg_err,
                            )
                            _snapshot_path = None
                    if _snapshot_path is None:
                        _snapshot_path = snapshot_download(**dl_kwargs)
                    _validate_snapshot_has_weights(req.repo_id, _snapshot_path)
                    break
                except (HfHubHTTPError, LocalEntryNotFoundError, OSError) as net_err:
                    if _attempt >= _max_attempts:
                        raise
                    _backoff = min(30, 2 ** _attempt)
                    logger.info(
                        "model install %s: attempt %d/%d failed (%s); retry in %ds",
                        req.repo_id, _attempt, _max_attempts, net_err, _backoff,
                    )
                    hf_progress.emit({
                        "repo_id": req.repo_id,
                        "filename": req.repo_id,
                        "downloaded": 0, "total": 0, "pct": 0.0,
                        "phase": "install_retry",
                        "attempt": _attempt,
                        "error": str(net_err),
                    })
                    _t.sleep(_backoff)
            # Stop heartbeat once download completes
            _resolving.set()
            # Flush the overall bar to 100% with the true byte total (FDL-06):
            # under Xet the per-file byte bars don't surface completion, so the
            # aggregator can sit below 100% even though every file landed.
            download_aggregator.complete(req.repo_id)
            logger.info("model install done: %s", req.repo_id)
            hf_progress.emit({
                "repo_id": req.repo_id,
                "filename": req.repo_id,
                "downloaded": 0, "total": 0, "pct": 1.0,
                "phase": "install_done",
            })
            _install_cooldowns.pop(req.repo_id, None)  # success clears any cooldown (MM2-06)
            invalidate_cache()
        except _InstallCancelled:
            _resolving.set()
            logger.info("model install cancelled: %s", req.repo_id)
            # A cancel is user intent, not a failure — don't set a cooldown.
            _install_cooldowns.pop(req.repo_id, None)
            hf_progress.emit({
                "repo_id": req.repo_id,
                "filename": req.repo_id,
                "downloaded": 0, "total": 0, "pct": 0.0,
                "phase": "install_cancelled",
            })
        except Exception as e:
            _resolving.set()
            logger.info("model install failed for %s: %s", req.repo_id, e)
            import time as _time_fail
            _install_cooldowns[req.repo_id] = _time_fail.time()
            # #874: when the install failed because the configured HF mirror is
            # unreachable, name the mirror + the setting instead of leaking the
            # raw connectivity error. #959: likewise for the SOCKS-proxy class
            # (missing socksio fails the download's session construction).
            # No-op for every other failure.
            from core.failure import append_hint
            hf_progress.emit({
                "repo_id": req.repo_id,
                "filename": req.repo_id,
                "downloaded": 0, "total": 0, "pct": 0.0,
                "phase": "install_error",
                "error": append_hint(str(e)),
            })
        finally:
            _cancelled.discard(req.repo_id)
            download_aggregator.finish(req.repo_id)
            hf_progress.current_repo_id.reset(token)

    loop.create_task(asyncio.to_thread(_do))
    return {"status": "install_started", "repo_id": req.repo_id}


@router.post("/models/install/cancel")
async def cancel_install(req: InstallModelRequest):
    """Request cancellation of an in-flight install (FDL-11).

    Best-effort: stops further retry attempts and marks the row cancelled. A
    single in-flight snapshot_download/Xet fetch isn't interruptible mid-file
    in hf_hub 1.7.2, so an already-streaming file finishes; the cancel takes
    effect at the next retry boundary. Clears the cooldown so the user can
    immediately restart."""
    _cancelled.add(req.repo_id)
    _install_cooldowns.pop(req.repo_id, None)
    return {"cancelling": req.repo_id}


# ── Delete ─────────────────────────────────────────────────────────────────

@router.delete("/models/{repo_id:path}")
def delete_model(repo_id: str):
    """Remove every cached revision of a repo from the HF cache."""
    hf_progress.emit({
        "repo_id": repo_id,
        "filename": repo_id,
        "downloaded": 0, "total": 0, "pct": 0.0,
        "phase": "delete_start",
    })
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        commits = [
            rev.commit_hash
            for entry in info.repos if entry.repo_id == repo_id
            for rev in entry.revisions
        ]
        if not commits:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Model {repo_id!r} isn't installed. Nothing to delete — "
                    "run POST /models/install first if you want a fresh download."
                ),
            )
        strategy = info.delete_revisions(*commits)
        strategy.execute()
        hf_progress.emit({
            "repo_id": repo_id,
            "filename": repo_id,
            "downloaded": 0, "total": 0, "pct": 1.0,
            "phase": "delete_done",
            "freed_bytes": strategy.expected_freed_size,
        })
        invalidate_cache()
        return {
            "deleted": True,
            "repo_id": repo_id,
            "freed_bytes": strategy.expected_freed_size,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Could not delete {repo_id}: {e}. "
                "Close any process using the model (e.g. the app's main dub job) and retry."
            ),
        )
