"""event_bus.emit must deliver from threadpool threads (sync FastAPI endpoints).

PUT /profiles/{id} (rename), DELETE /profiles/{id}, and DELETE .../consent are
sync endpoints, so Starlette runs their bodies in a threadpool worker with no
running event loop. event_bus.emit() used to call asyncio.get_running_loop()
and silently drop the event (DEBUG log only) from exactly those threads, which
reached users as "I renamed a voice and the list went stale / looked empty"
(the frontend only refetches the voice list on the WS "profiles" event).

The test drives the real failure shape: subscribe on the serving loop, call
emit() from a plain thread (as the threadpool does), and assert the event
arrives in the listener queue.
"""

from __future__ import annotations

import asyncio
import json
import threading

import pytest


@pytest.fixture
def bus():
    """Resolve the module per test — binding it at collection lets another
    suite's `sys.modules` rebinding make this exercise a different object."""
    return __import__("core.event_bus", fromlist=["emit"])


def test_emit_from_thread_reaches_serving_loop(bus, tmp_path):
    loop = asyncio.new_event_loop()
    received: list[str] = []
    started = threading.Event()
    done = threading.Event()

    def run_loop():
        asyncio.set_event_loop(loop)
        loop.run_until_complete(_serve(bus, received, started, done))

    t = threading.Thread(target=run_loop, name="test-serving-loop")
    t.start()
    try:
        assert started.wait(2.0), "serving loop never subscribed"

        # The bug's exact context: no running loop in this thread, like a
        # Starlette threadpool worker executing a sync endpoint body.
        def sync_endpoint_body():
            bus.emit("profiles", {"action": "updated", "id": "abc123"})

        worker = threading.Thread(target=sync_endpoint_body, name="threadpool-worker")
        worker.start()
        worker.join(2.0)

        assert done.wait(2.0), (
            "emit() from a threadpool thread was dropped — the WS 'profiles' "
            "event never reached the serving loop's listener queue"
        )
        payload = json.loads(received[0])
        assert payload["kind"] == "profiles"
        assert payload["action"] == "updated"
        assert payload["id"] == "abc123"
    finally:
        loop.call_soon_threadsafe(done.set)
        t.join(2.0)
        loop.close()


def test_emit_from_foreign_running_loop_reaches_serving_loop(bus):
    """An async producer may run on a worker loop, but listener state belongs
    to the WebSocket serving loop and must only be touched there."""
    serving_loop = asyncio.new_event_loop()
    serving_loop.set_debug(True)
    received: list[str] = []
    started = threading.Event()
    done = threading.Event()

    async def serve_with_waiter_ready():
        q = await bus.subscribe()
        started.set()
        try:
            received.append(await asyncio.wait_for(q.get(), 0.5))
        except asyncio.TimeoutError:
            pass
        finally:
            done.set()
            await bus.unsubscribe(q)

    def run_serving_loop():
        asyncio.set_event_loop(serving_loop)
        serving_loop.run_until_complete(serve_with_waiter_ready())

    serving_thread = threading.Thread(
        target=run_serving_loop, name="test-serving-loop"
    )
    serving_thread.start()
    try:
        assert started.wait(2.0), "serving loop never subscribed"

        async def foreign_async_caller():
            assert asyncio.get_running_loop() is not serving_loop
            bus.emit("profiles", {"action": "updated", "id": "foreign-loop"})

        asyncio.run(foreign_async_caller())

        assert done.wait(2.0), (
            "emit() ran listener delivery on the caller's foreign loop"
        )
        assert received, "foreign-loop event never reached the serving loop"
        payload = json.loads(received[0])
        assert payload["id"] == "foreign-loop"
    finally:
        serving_loop.call_soon_threadsafe(done.set)
        serving_thread.join(2.0)
        serving_loop.close()


async def _serve(bus, received: list[str], started: threading.Event, done: threading.Event):
    q = await bus.subscribe()
    started.set()
    # Await the event itself (no sleep-polling): a failure surfaces as
    # asyncio.TimeoutError, which fails the test with a clear traceback.
    try:
        received.append(await asyncio.wait_for(q.get(), 2.0))
    finally:
        done.set()
        await bus.unsubscribe(q)
