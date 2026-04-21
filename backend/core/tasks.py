import asyncio
import time
import json
import logging

from core import job_store

logger = logging.getLogger("omnivoice.tasks")


class TaskManager:
    """In-memory task dispatcher with SQLite-backed metadata.

    The dispatcher itself (queue + worker + listeners) stays in-memory for
    speed, but every state transition and every SSE event is mirrored to
    `jobs` / `job_events`. That means:

      - clients can reconnect via `/tasks/stream/{id}?after_seq=N` and catch up
      - restart recovers: orphaned `running` jobs are flipped to `failed`
      - `GET /jobs` works across restarts
    """

    def __init__(self):
        self.queue = None
        self.active_tasks = {}

    def _init_queue(self):
        if self.queue is None:
            self.queue = asyncio.Queue()

    async def add_task(self, task_id, task_type, func, *args, project_id=None, meta=None, **kwargs):
        self._init_queue()
        task_obj = {
            "status": "pending",
            "type": task_type,
            "created_at": time.time(),
            "history": [],
            "listeners": [],
            "listeners_lock": asyncio.Lock(),
            "error": None,
            "cancelled": False,
        }
        self.active_tasks[task_id] = task_obj
        try:
            job_store.create(task_id, type=task_type, project_id=project_id, meta=meta)
        except Exception:
            logger.exception("job_store.create failed (non-fatal); in-memory task still runs")
        await self.queue.put((task_id, func, args, kwargs))

    def cancel_task(self, task_id):
        if task_id in self.active_tasks:
            self.active_tasks[task_id]["cancelled"] = True
            return True
        return False

    def is_cancelled(self, task_id):
        t = self.active_tasks.get(task_id)
        return t["cancelled"] if t else False

    async def add_listener(self, task_id, q):
        t = self.active_tasks.get(task_id)
        if not t:
            return False
        async with t["listeners_lock"]:
            t["listeners"].append(q)
        return True

    async def remove_listener(self, task_id, q):
        t = self.active_tasks.get(task_id)
        if not t:
            return
        async with t["listeners_lock"]:
            if q in t["listeners"]:
                t["listeners"].remove(q)

    async def _push_event(self, task_id, event_str):
        t = self.active_tasks.get(task_id)
        if t is None:
            return
        if event_str is not None:
            t["history"].append(event_str)
            try:
                seq = job_store.append_event(task_id, event_str)
                # Stash the seq on the in-memory copy too, mainly for tests.
                t.setdefault("event_seqs", []).append(seq)
            except Exception:
                # Never let disk writes break the live stream.
                logger.exception("job_store.append_event failed; event delivered to listeners only")
        # Snapshot listeners under lock so concurrent add/remove can't mutate mid-iteration.
        async with t["listeners_lock"]:
            listeners = list(t["listeners"])
        for q in listeners:
            await q.put(event_str)

    async def worker(self):
        self._init_queue()
        while True:
            task_id, func, args, kwargs = await self.queue.get()
            t = self.active_tasks.get(task_id)
            if not t:
                self.queue.task_done()
                continue

            t["status"] = "running"
            try:
                job_store.mark_running(task_id)
            except Exception:
                logger.exception("job_store.mark_running failed (non-fatal)")
            try:
                import inspect
                res = func(*args, **kwargs)
                if inspect.isasyncgen(res):
                    async for update in res:
                        if t.get("cancelled"):
                            await self._push_event(task_id, f"data: {json.dumps({'type': 'cancelled'})}\n\n")
                            t["status"] = "cancelled"
                            try: job_store.mark_cancelled(task_id)
                            except Exception: logger.exception("job_store.mark_cancelled failed")
                            break
                        await self._push_event(task_id, update)
                elif inspect.iscoroutine(res):
                    await res
                if t["status"] != "cancelled":
                    t["status"] = "done"
                    try: job_store.mark_done(task_id)
                    except Exception: logger.exception("job_store.mark_done failed")
            except Exception as e:
                logger.exception("Task %s failed", task_id)
                t["status"] = "failed"
                t["error"] = str(e)
                try:
                    job_store.mark_failed(task_id, str(e))
                except Exception:
                    logger.exception("job_store.mark_failed failed")
                try:
                    await self._push_event(task_id, f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n")
                except Exception as push_err:
                    logger.warning("Failed to push error event for %s: %s", task_id, push_err)
            finally:
                await self._push_event(task_id, None)  # EOF
                self.queue.task_done()

task_manager = TaskManager()
