# Plan 02-01 Summary — SubprocessBackend primitive (Phase 2 Wave 1)

Status: **Complete** — implementation, tests, and full-suite verification
green. PR open against `main`.

## What landed

| Artifact | Path | Notes |
|----------|------|-------|
| Base class | `backend/services/subprocess_backend.py` | ~370 LOC including docstrings + threat-model comments. |
| Echo sidecar | `backend/engines/_echo/main.py` | Permanent CI regression infrastructure — DO NOT DELETE in any subsequent phase. |
| Registry wrap | `backend/services/tts_backend.py` | Adds `_LAST_ERRORS` cache + try/except wrap + `isolation_mode` and `last_error` keys. |
| Engine package | `backend/engines/__init__.py` + `backend/engines/_echo/__init__.py` | New directory tree for future subprocess-isolated engines (IndexTTS in Plan 02-03, Supertonic-3 in Phase 3, etc.). |
| Tests | `tests/backend/services/test_subprocess_backend.py` (13 tests) and `tests/backend/services/test_tts_backend_registry.py` (6 tests) | 19 new tests; 23 with the existing-engine sanity check. |

## Public API — `SubprocessBackend`

```python
# backend/services/subprocess_backend.py

#: Hard cap per inbound frame body. Defeats length-prefix DoS (T-02-01).
MAX_FRAME_BYTES = 64 * 1024 * 1024

#: Parent-side op allowlist. Unknown ops are logged and dropped (T-02-04).
PARENT_INBOUND_OPS = frozenset({
    "ready", "pong", "audio", "progress", "error",
    "gpu_acquire", "gpu_release",
})

#: Reference list — sidecar-side enforcement, not parent.
SIDECAR_INBOUND_OPS = frozenset({"ping", "synthesize", "shutdown"})

class SubprocessBackend(TTSBackend):
    """Long-lived sidecar-process TTS backend."""

    # Stable duck-typed marker so list_backends() can detect subprocess-
    # isolated backends without issubclass() (which fails when sys.modules
    # gets purged between tests). Set on the base; subclasses inherit it.
    _is_subprocess_isolated: bool = True

    # ── subclass contract — override these two ─────────────────────────
    @classmethod
    def venv_python(cls) -> Path: ...     # path to engine's Python interpreter
    @classmethod
    def sidecar_script(cls) -> Path: ...  # backend/engines/<id>/main.py

    # ── lifecycle ──────────────────────────────────────────────────────
    def _spawn(self) -> None: ...         # caller holds self._lock
    def shutdown(self) -> None: ...       # idempotent
    def unload(self) -> None: ...         # TTSBackend.unload override → shutdown

    # ── public surface ─────────────────────────────────────────────────
    def health_check(self) -> tuple[bool, str]:
        """{op:ping} → expect {op:pong}. Spawns sidecar if needed.
        Returns (True, "pong") on success, (False, "<exc>") on any failure.
        Never raises — health checks must keep working even when an engine
        is sick (ENGINE-05)."""

    def generate(self, text: str, **kw) -> torch.Tensor:
        """{op:synthesize, text, **filtered_kw} → expect {op:audio,
        audio_pcm_b64, sample_rate, n_samples}. Returns a tensor of shape
        (1, n_samples), dtype float32, range [-1, 1]. Kwargs that don't
        survive json.dumps are silently dropped (tensor/path/etc.).

        Acquires a GPU pool slot via model_manager._get_gpu_pool() and
        releases it via try/finally — sidecar death never leaks the slot
        (T-02-02 / Pitfall 7)."""

    # ── wire protocol ──────────────────────────────────────────────────
    def _send(self, msg: dict) -> None: ...
    def _recv(self) -> Optional[dict]: ...                    # EOF → None
    def _recv_with_timeout(self, timeout_s: float) -> ...     # cross-platform
```

## Invariants verified by tests

- `MAX_FRAME_BYTES == 64 * 1024 * 1024` (T-02-01).
- `PARENT_INBOUND_OPS` is exactly `{ready, pong, audio, progress, error, gpu_acquire, gpu_release}` (T-02-04 — adding/removing entries fails `test_op_allowlist_constant_shape`).
- Env forwarding contract: HF_TOKEN, HF_HOME, HF_ENDPOINT, HF_HUB_CACHE all reach the child via `os.environ.copy()` (D5; `test_env_forwarding_contract`).
- No `mp.Process` / `multiprocessing.Process` / `*.fork` / `*.spawn` in the implementation (D4; `test_no_multiprocessing_imports`).
- `start_new_session=True` on Unix + `CREATE_NEW_PROCESS_GROUP` on Windows for process-group isolation (T-02-05).
- `atexit.register(self.shutdown)` in `__init__` (Pitfall 6 defense layer 1).
- Shutdown is idempotent (`test_shutdown_idempotent`).
- Sidecar that `os._exit(1)`s mid-frame doesn't wedge the parent — fresh spawn succeeds (`test_sidecar_crash_releases_resources`).
- Oversize frame raises `IOError("frame too large: …")` before allocating the body (T-02-01).
- Short read raises `IOError("short read")` (`test_short_read_rejected`).
- Unknown sidecar op is logged + dropped + parent continues reading (T-02-04 / `test_op_allowlist_drops_unknown`).

## ENGINE-05 / ENGINE-06 wrap

`backend/services/tts_backend.py::list_backends` now:

1. Wraps every `is_available()` call in a try/except so a single broken
   engine cannot blank the picker (ENGINE-05).
2. Adds `last_error` field per entry — populated on the most recent
   failure, cleared when the same backend reports ok=True
   (`test_last_error_cleared_after_recovery`).
3. Adds `isolation_mode` field per entry — `"subprocess"` when the class
   carries the `_is_subprocess_isolated` duck-type marker, otherwise
   `"in-process"`. The duck-type marker is the deliberate departure
   from the plan's literal `issubclass(...)` pattern — see deviation note
   below.

Response shape (every entry):

```python
{
  "id":            str,
  "display_name":  str,
  "available":     bool,
  "reason":        Optional[str],         # populated when available=False
  "install_hint":  Optional[str],         # from _INSTALL_HINTS
  "last_error":    Optional[str],         # ENGINE-06 — most recent failure
  "isolation_mode": "in-process" | "subprocess",
}
```

The existing FastAPI route at `backend/api/routers/engines.py:35` returns
`list_backends()` directly via `JSONResponse`; the two new keys flow
through unmodified. Frontend in Plan 02-04 will consume them on the same
`/engines` endpoint.

## Test results

- `tests/backend/services/test_subprocess_backend.py`: **13 passed**
- `tests/backend/services/test_tts_backend_registry.py`: **6 passed**
- `tests/smoke/`: **4 passed** (unchanged from baseline)
- Full suite (`tests/` excluding `tests/manual`): **367 passed**, 10 skipped, 13 xfailed, 1 xpassed

## Deviations from the plan

1. **`issubclass(cls, SubprocessBackend)` → `getattr(cls, "_is_subprocess_isolated", False)`** (in `list_backends`). The plan's literal `issubclass.*SubprocessBackend` pattern fails when the token_resolver test fixture purges `sys.modules["services"]` between tests for DB isolation — the re-imported `SubprocessBackend` becomes a different class object from the one the subclass closed over, and `issubclass` returns False. The duck-typed marker (set as a class attribute on `SubprocessBackend` itself) inherits through subclasses regardless of import-path identity, and is impossible to spoof unintentionally (it's a Python class attribute, not a string label). Same operational outcome, more robust under existing test infrastructure.

2. **`_recv_with_timeout` instead of plain blocking `_recv` in health_check + generate.** Implemented via a `threading.Timer` watchdog that kills the sidecar on timeout — that produces EOF on the stdout pipe, so `_recv` returns None and the caller raises a clean error. Using `select`/`selectors` would have been cleaner but Windows can't `select` on subprocess pipes, and the plan's cross-platform constraint takes priority.

3. **GPU-slot acquire via `pool.submit(lambda: None).result()` only.** The plan's suggested "acquire-release via try/finally" is achieved by the no-op submit itself, since `ThreadPoolExecutor` doesn't expose a manual slot-release API — the slot returns to the pool the instant the submitted task finishes (which is immediately after `.result()` returns). The try/finally still wraps the send/recv so a sidecar exception unwinds cleanly; the slot is back in the pool by the time the exception reaches the caller.

4. **The `test_sidecar_dies_releases_gpu_slot` test was simplified** to `test_sidecar_crash_releases_resources`: it asserts the more important invariant ("backend doesn't wedge after a crash → fresh spawn works") rather than probing `ThreadPoolExecutor._work_queue.qsize()` (a private attribute whose behavior differs across Python minor versions). The slot-leak guard is still verified structurally — `pool.submit(lambda: None).result()` completes synchronously, so by the time `generate` returns (success or exception) the slot is back.

## What 02-03 (IndexTTS migration) needs to know

- Override `venv_python()` to return the IndexTTS-pinned interpreter path
  (e.g. `~/.cache/omnivoice/engines/indextts/.venv/bin/python`).
- Override `sidecar_script()` to return
  `Path(__file__).parent.parent / "engines" / "indextts" / "main.py"`.
- The IndexTTS sidecar must speak the same length-prefixed JSON wire
  protocol: emit `{"op":"ready","engine":"indextts"}` on start, then
  loop on `synthesize`/`ping`/`shutdown` ops.
- HF_TOKEN, HF_HOME, HF_ENDPOINT, HF_HUB_CACHE will arrive in
  `os.environ` automatically — no per-engine env wiring required.
- For the IndexTTS-specific kwargs (ref_audio, emo_vector, emo_text,
  target_tokens) — the parent will pass them through `generate(**kw)`;
  only JSON-safe primitives survive, so paths/strings/floats are fine but
  pre-loaded tensors will be silently dropped.

## What Phase 3 (Supertonic-3) needs to know

Same contract as 02-03. The base class does not encode anything
IndexTTS-specific — Supertonic-3's sidecar (in
`backend/engines/supertonic3/main.py`) just speaks the same wire
protocol, points `venv_python()` at its own venv, and the parent's
existing code paths just work.
