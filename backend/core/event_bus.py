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


async def subscribe() -> asyncio.Queue:
    """Register a new listener. Returns a Queue that receives event dicts."""
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
        loop = asyncio.get_running_loop()
        loop.create_task(_broadcast(event_str))
    except RuntimeError:
        # No event loop running (unlikely in FastAPI context but safe)
        logger.debug("No event loop — event dropped: %s", kind)


async def _broadcast(event_str: str) -> None:
    """Push event to all listener queues. Drop if full (slow consumer)."""
    async with _lock:
        dead: list[asyncio.Queue] = []
        for q in _listeners:
            try:
                q.put_nowait(event_str)
            except asyncio.QueueFull:
                # Slow consumer — drop oldest, then push
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
