import asyncio
import time
import json

class TaskManager:
    def __init__(self):
        self.queue = None
        self.active_tasks = {}

    def _init_queue(self):
        if self.queue is None:
            self.queue = asyncio.Queue()

    async def add_task(self, task_id, task_type, func, *args, **kwargs):
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
                import inspect
                res = func(*args, **kwargs)
                if inspect.isasyncgen(res):
                    async for update in res:
                        if t.get("cancelled"):
                            await self._push_event(task_id, f"data: {json.dumps({'type': 'cancelled'})}\n\n")
                            t["status"] = "cancelled"
                            break
                        await self._push_event(task_id, update)
                elif inspect.iscoroutine(res):
                    await res
                t["status"] = "done"
            except Exception as e:
                import logging
                logging.getLogger("omnivoice.tasks").exception("Task %s failed", task_id)
                t["status"] = "failed"
                t["error"] = str(e)
                try:
                    await self._push_event(task_id, f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n")
                except Exception as push_err:
                    logging.getLogger("omnivoice.tasks").warning("Failed to push error event for %s: %s", task_id, push_err)
            finally:
                await self._push_event(task_id, None) # EOF
                self.queue.task_done()

task_manager = TaskManager()
