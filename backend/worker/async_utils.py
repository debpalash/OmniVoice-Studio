"""Cancellation helpers for work that cannot be stopped mid-call."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, TypeVar

_Result = TypeVar("_Result")


async def drain_task(task: asyncio.Task[Any]) -> None:
    """Wait for ``task`` even if the waiter is cancelled again."""
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            continue
        except BaseException:
            break
    if task.done():
        try:
            task.result()
        except BaseException:
            pass


async def to_thread_and_drain_on_cancel(
    function: Callable[..., _Result], /, *args: Any
) -> _Result:
    """Run a blocking call without detaching it when its waiter is cancelled."""
    thread_task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(thread_task)
    except asyncio.CancelledError:
        await drain_task(thread_task)
        raise


async def to_thread_and_defer_cancellation(
    function: Callable[..., _Result], /, *args: Any
) -> tuple[_Result, bool]:
    """Finish a durable call and report cancellation after its result is known.

    Authority writes need their event-loop publication even when the HTTP
    caller disappears while SQLite is committing. Returning the cancellation
    flag lets the caller publish that result first, then propagate cancellation.
    """
    thread_task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(thread_task), False
    except asyncio.CancelledError:
        await drain_task(thread_task)
        return thread_task.result(), True


__all__ = [
    "drain_task",
    "to_thread_and_defer_cancellation",
    "to_thread_and_drain_on_cancel",
]
