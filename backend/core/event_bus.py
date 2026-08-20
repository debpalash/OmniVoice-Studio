"""In-memory pub/sub event bus for real-time UI updates.

Any backend code that mutates sidebar-visible data (projects, profiles,
history) calls ``emit(kind, payload)`` and the WebSocket endpoint fans it
out to all connected frontends.  This replaces the 45 s polling band-aid
with instant push.

Events are fire-and-forget, no persistence needed — the frontend uses
the event as a "hey, refetch this" signal rather than carrying the full
data payload.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

logger = logging.getLogger("omnivoice.events")

# All connected WebSocket listener queues
_listeners: list[asyncio.Queue] = []
_lock = asyncio.Lock()

# The loop that serves /ws/events, captured on first use. Sync FastAPI
# endpoints (rename/delete profile, revoke consent) run in threadpool workers
# where `asyncio.get_running_loop()` raises, which used to silently drop their
# events — the UI then never refetched the voice list (#1158 class).
_serving_loop: asyncio.AbstractEventLoop | None = None


async def subscribe() -> asyncio.Queue:
    """Register a new listener. Returns a Queue that receives event dicts."""
    global _serving_loop
    _serving_loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    async with _lock:
        _listeners.append(q)
    return q


async def unsubscribe(q: asyncio.Queue) -> None:
    """Remove a listener."""
    async with _lock:
        try:
            _listeners.remove(q)
        except ValueError:
            pass


def emit(kind: str, payload: dict[str, Any] | None = None) -> None:
    """Broadcast an event to all connected frontends.

    Safe to call from sync or async context — uses fire-and-forget
    scheduling into the running event loop.

    ``kind`` is one of: projects, profiles, dub_history, export_history,
    generation_history, model_status, glossary.
    """
    event = {
        "kind": kind,
        "ts": time.time(),
        **(payload or {}),
    }
    event_str = json.dumps(event)
    try:
        caller_loop = asyncio.get_running_loop()
    except RuntimeError:
        caller_loop = None
    target_loop = _serving_loop or caller_loop
    if target_loop is None:
        # No serving loop yet — nobody to notify; dropping is correct.
        logger.debug("No event loop — event dropped: %s", kind)
        return
    try:
        if caller_loop is target_loop:
            target_loop.create_task(_broadcast(event_str))
        else:
            # Sync endpoints and async producers on a foreign loop must both
            # hand off: the lock and listener queues belong to serving_loop.
            target_loop.call_soon_threadsafe(_schedule_broadcast, event_str)
    except RuntimeError:
        # The serving loop closed between capture and use (app shutdown).
        logger.debug("Event loop closed — event dropped: %s", kind)


def _schedule_broadcast(event_str: str) -> None:
    """Run `_broadcast` on the serving loop; called via call_soon_threadsafe."""
    asyncio.get_running_loop().create_task(_broadcast(event_str))


async def _broadcast(event_str: str) -> None:
    """Push event to all listener queues. Drop if full (slow consumer)."""
    async with _lock:
        dead: list[asyncio.Queue] = []
        for q in _listeners:
            try:
                q.put_nowait(event_str)
            except asyncio.QueueFull:
                # Slow consumer — drop oldest, then push. Not a race (#1163):
                # every queue op runs on the single event loop (a foreign
                # thread's emit() hands off via call_soon_threadsafe first),
                # and there is no await between the QueueFull and this
                # get_nowait/put_nowait pair — no consumer can interleave, so
                # get_nowait cannot raise QueueEmpty here.
                try:
                    q.get_nowait()
                    q.put_nowait(event_str)
                except Exception:
                    dead.append(q)
        for q in dead:
            try:
                _listeners.remove(q)
            except ValueError:
                pass
