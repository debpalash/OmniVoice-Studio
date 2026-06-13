"""HuggingFace download progress — one monkey-patch, every `hf_hub_download`
reports bytes downloaded through a central callback.

`huggingface_hub` uses tqdm for progress bars; we subclass it, intercept
`update()` calls, and forward (filename, downloaded_bytes, total_bytes) to
whatever callback is registered. No changes to calling sites across
transformers / mlx_whisper / diffusers / accelerate — they all route through
`hf_hub_download`, which uses the patched tqdm.

Usage:
    from utils.hf_progress import install, register_listener, unregister_listener

    install()  # once at app startup
    listener_id = register_listener(lambda ev: print(ev))
    # …models download, listener fires…
    unregister_listener(listener_id)
"""
from __future__ import annotations

import contextvars
import itertools
import logging
import threading
from typing import Callable, Optional

logger = logging.getLogger("omnivoice.hf_progress")

# Context-scoped active repo_id. Set in the install/delete handler so every
# tqdm event fired while a snapshot_download runs can be stamped with the
# originating repo, letting the frontend route per-file events to the right
# row instead of heuristically matching filename substrings.
current_repo_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "omnivoice_hf_progress_repo_id", default=None,
)

# Event shape forwarded to listeners. Typed loosely on purpose — SSE encodes
# it as JSON so consumers read the dict directly.
#   {
#     "filename": str,        # desc on the tqdm bar, usually the HF file path
#     "downloaded": int,      # bytes pulled so far
#     "total": int | None,    # total bytes or None if unknown
#     "pct": float,           # 0.0-1.0 (or 0.0 if total unknown)
#     "phase": "start"|"progress"|"done",
#   }
ProgressEvent = dict
Listener = Callable[[ProgressEvent], None]

_listeners: dict[int, Listener] = {}
_listener_lock = threading.Lock()
_listener_counter = itertools.count(1)
_installed = False
_install_lock = threading.Lock()

# Set by install() to the TrackedTqdm subclass so call sites can drive it
# explicitly via snapshot_download(tqdm_class=...) instead of relying solely on
# the global monkey-patch. Xet feeds bytes into whatever tqdm_class is passed,
# so this is also the xet-aware progress hook (FDL-02).
_tracked_tqdm_class: Optional[type] = None


def tracked_tqdm_class() -> Optional[type]:
    """Return the progress-emitting tqdm subclass (or None if install() hasn't
    run / huggingface_hub's tqdm couldn't be patched). Pass it as
    ``snapshot_download(tqdm_class=...)`` to drive progress deterministically."""
    return _tracked_tqdm_class


# Optional sink fed every per-file (repo_id, filename, downloaded, total) byte
# update — used by utils.download_aggregator to build the overall aggregate bar
# (FDL-06). Kept as a setter to avoid a circular import (this module must not
# import the aggregator). Signature: fn(repo_id, filename, downloaded, total).
_byte_sink: Optional[Callable] = None


def set_byte_sink(fn: Optional[Callable]) -> None:
    global _byte_sink
    _byte_sink = fn


def register_listener(cb: Listener) -> int:
    """Register a callback that receives progress events. Returns an id that
    can be passed to `unregister_listener` when the listener is done."""
    with _listener_lock:
        lid = next(_listener_counter)
        _listeners[lid] = cb
        return lid


def unregister_listener(lid: int) -> None:
    with _listener_lock:
        _listeners.pop(lid, None)


def _emit(event: ProgressEvent) -> None:
    """Fan out to all registered listeners. Never raise — a bad listener
    shouldn't break a download."""
    # Stamp the active repo_id so frontends can route events to the right
    # row. Only set when this emit is happening inside an install handler.
    rid = current_repo_id.get()
    if rid is not None and "repo_id" not in event:
        event = {**event, "repo_id": rid}
    with _listener_lock:
        listeners = list(_listeners.values())
    for cb in listeners:
        try:
            cb(event)
        except Exception as e:  # noqa: BLE001
            logger.debug("hf_progress listener raised: %s", e)


def emit(event: ProgressEvent) -> None:
    """Public emit — lets non-tqdm operations (delete, verify, etc.) push
    lifecycle events onto the same SSE stream."""
    _emit(event)


class SafeFileWrapper:
    def __init__(self, fp):
        self.fp = fp
        self._is_safe_wrapper = True
    def write(self, s):
        try:
            self.fp.write(s)
        except OSError:
            pass
    def flush(self):
        try:
            getattr(self.fp, 'flush', lambda: None)()
        except OSError:
            pass
    def __getattr__(self, name):
        return getattr(self.fp, name)

def install() -> None:
    """Monkey-patch `huggingface_hub`'s tqdm so every download reports to our
    listeners. Safe to call multiple times — second call is a no-op."""
    global _installed
    with _install_lock:
        if _installed:
            return
        # `huggingface_hub.utils.__init__` does `from .tqdm import tqdm`,
        # which shadows the `tqdm` SUBMODULE with the CLASS of the same name
        # when accessed via attribute lookup. Pull the real module out of
        # sys.modules after an explicit import so we patch the right thing.
        try:
            import sys
            import huggingface_hub.utils.tqdm  # noqa: F401
            hf_tqdm_module = sys.modules.get("huggingface_hub.utils.tqdm")
            if hf_tqdm_module is None:
                raise ImportError("huggingface_hub.utils.tqdm not in sys.modules after import")
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "hf_progress.install: huggingface_hub.utils.tqdm missing (%s); "
                "progress tracking disabled.", e,
            )
            return

        original = getattr(hf_tqdm_module, "tqdm", None)
        if original is None or not isinstance(original, type):
            logger.warning("hf_progress.install: no `tqdm` class on the module; aborting")
            return

        class TrackedTqdm(original):  # type: ignore[misc,valid-type]
            """tqdm subclass that emits a progress event on every update."""

            _last_emit_time: float = 0.0

            @staticmethod
            def status_printer(file):
                if file is not None and not getattr(file, "_is_safe_wrapper", False):
                    file = SafeFileWrapper(file)
                try:
                    return original.status_printer(file)
                except Exception:
                    return lambda s: None

            def __init__(self, *args, **kwargs):
                if 'file' in kwargs and kwargs['file'] is not None and not getattr(kwargs['file'], "_is_safe_wrapper", False):
                    kwargs['file'] = SafeFileWrapper(kwargs['file'])
                try:
                    super().__init__(*args, **kwargs)
                except OSError:
                    pass

                if hasattr(self, 'fp') and getattr(self, 'fp', None) is not None and not getattr(self.fp, "_is_safe_wrapper", False):
                    self.fp = SafeFileWrapper(self.fp)

                import time as _t
                self._last_emit_time = _t.monotonic()
                try:
                    desc = getattr(self, "desc", None)
                    total = int(getattr(self, "total", 0) or 0)
                    _emit({
                        "filename": str(desc or "download"),
                        "downloaded": 0,
                        "total": total,
                        "pct": 0.0,
                        "phase": "start",
                    })
                except Exception:
                    pass

            def _emit_progress(self):
                """Emit current state as a progress event."""
                try:
                    desc = getattr(self, "desc", None)
                    total = int(getattr(self, "total", 0) or 0)
                    done = int(getattr(self, "n", 0) or 0)
                    pct = (done / total) if total > 0 else 0.0
                    # Pull rate from tqdm's own calculations if available
                    rate = None
                    try:
                        rate = self.format_dict.get("rate")
                    except Exception:
                        pass
                    event = {
                        "filename": str(desc or "download"),
                        "downloaded": done,
                        "total": total,
                        "pct": pct,
                        "phase": "done" if (total > 0 and done >= total) else "progress",
                    }
                    if rate and rate > 0:
                        event["rate"] = rate  # bytes/sec from tqdm
                    _emit(event)
                    # Feed the overall aggregator (FDL-06), if wired.
                    self._feed_sink(done, total, complete=False)
                except Exception:
                    pass

            def _feed_sink(self, done, total, *, complete: bool):
                """Forward a byte/count update to the overall aggregator sink.

                Passes the tqdm `unit` so the aggregator can tell a byte bar
                (unit 'B') from the "Fetching N files" count bar, and a stable
                per-bar key (id(self)) because every per-file byte bar shares
                the default desc 'download' under Xet — keying by desc would
                collapse them into one.
                """
                sink = _byte_sink
                if sink is None:
                    return
                rid = current_repo_id.get()
                if not rid:
                    return
                try:
                    unit = getattr(self, "unit", None)
                    sink(rid, id(self), unit, int(done or 0), int(total or 0), complete)
                except Exception:
                    pass

            def update(self, n=1):
                try:
                    super().update(n)
                except OSError:
                    pass
                import time as _t
                now = _t.monotonic()
                # Throttle: emit at most every 0.3s to avoid flooding SSE
                if (now - self._last_emit_time) >= 0.3:
                    self._last_emit_time = now
                    self._emit_progress()

            def display(self, msg=None, pos=None):
                """tqdm calls display() on its refresh cycle; piggyback for
                periodic emits even when update() intervals are large."""
                import time as _t
                now = _t.monotonic()
                if (now - self._last_emit_time) >= 0.5:
                    self._last_emit_time = now
                    self._emit_progress()
                try:
                    return super().display(msg, pos)
                except OSError:
                    pass

            def close(self):
                # Credit the file's full size to the aggregator on close. Under
                # Xet a per-file byte bar often never increments `n` (Xet fetches
                # chunks out-of-band), so completion is the only reliable signal
                # that the file's bytes landed. Harmless for classic LFS bars
                # (n already == total).
                try:
                    total = int(getattr(self, "total", 0) or 0)
                    if total > 0:
                        self._feed_sink(total, total, complete=True)
                except Exception:
                    pass
                try:
                    super().close()
                except OSError:
                    pass

        # Stash the original for inspection / uninstall, then swap.
        hf_tqdm_module._omnivoice_original_tqdm = original  # type: ignore[attr-defined]
        hf_tqdm_module.tqdm = TrackedTqdm  # type: ignore[assignment]
        global _tracked_tqdm_class
        _tracked_tqdm_class = TrackedTqdm
        _installed = True
        logger.info("hf_progress: installed tqdm patch on huggingface_hub.utils.tqdm")
