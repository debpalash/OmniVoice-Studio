"""HuggingFace download progress — one monkey-patch, every `hf_hub_download`
reports bytes downloaded through a central callback.

Pattern lifted from jamiepine/voicebox's `backend/utils/hf_progress.py`:
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

import itertools
import logging
import threading
from typing import Callable, Optional

logger = logging.getLogger("omnivoice.hf_progress")

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
    with _listener_lock:
        listeners = list(_listeners.values())
    for cb in listeners:
        try:
            cb(event)
        except Exception as e:  # noqa: BLE001
            logger.debug("hf_progress listener raised: %s", e)


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

            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                # Emit once on construction so the UI can show the file
                # before a single byte is read. Some tqdm variants don't
                # populate `desc` / `n` as attributes — use getattr so a
                # patched tqdm never crashes the whole model load.
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
                    # Never let progress telemetry break a real download.
                    pass

            def update(self, n=1):
                super().update(n)
                try:
                    desc = getattr(self, "desc", None)
                    total = int(getattr(self, "total", 0) or 0)
                    done = int(getattr(self, "n", 0) or 0)
                    pct = (done / total) if total > 0 else 0.0
                    _emit({
                        "filename": str(desc or "download"),
                        "downloaded": done,
                        "total": total,
                        "pct": pct,
                        "phase": "done" if (total > 0 and done >= total) else "progress",
                    })
                except Exception:
                    pass

        # Stash the original for inspection / uninstall, then swap.
        hf_tqdm_module._omnivoice_original_tqdm = original  # type: ignore[attr-defined]
        hf_tqdm_module.tqdm = TrackedTqdm  # type: ignore[assignment]
        _installed = True
        logger.info("hf_progress: installed tqdm patch on huggingface_hub.utils.tqdm")
