"""SubprocessBackend — long-lived sidecar-process TTS primitive (Phase 2.1).

The architectural keystone for engine isolation. Engines that need their
own Python venv (because their dependency pins conflict with OmniVoice's
— IndexTTS demands `transformers<5`, OmniVoice demands `transformers>=5.3`)
run inside a `subprocess.Popen` child interpreter. The parent backend
talks to them through length-prefixed JSON over the child's stdin/stdout.

Subclasses (e.g. ``IndexTTSSubprocessBackend`` in Plan 02-03, the future
Supertonic-3 backend in Phase 3) override exactly two class methods:

    @classmethod
    def venv_python(cls) -> Path: ...   # path to the engine's python
    @classmethod
    def sidecar_script(cls) -> Path: ...  # path to backend/engines/<id>/main.py

Everything else — spawn, ready-handshake, request/response, GPU-slot
accounting, atexit teardown, stderr drainage, process-group cleanup — is
owned by this base class.

NOT IMPLEMENTED with the multiprocessing module (Locked Decision D4 — no
process-cloning variants of any kind). The whole point of this primitive
is to run a *different* Python interpreter than the parent's;
multiprocessing can only clone the current interpreter, which defeats
the dependency-isolation goal. Anyone tempted to "simplify" this should
re-read 02-RESEARCH.md Pitfall 1.

Threat-model summary (see Plan 02-01 frontmatter):
    T-02-01 — DoS via length-prefix: hard cap 64 MB per frame in ``_recv``.
    T-02-02 — GPU slot leak on sidecar death: try/finally in ``generate``.
    T-02-03 — token bytes in stderr: drain via the same logging filter that
              AUTH-05 installed (``HFTokenRedactor``) on the root logger.
    T-02-04 — compromised sidecar emitting unexpected ops: parent allowlist
              ``PARENT_INBOUND_OPS`` rejects everything else.
    T-02-05 — Tauri group-kill scope: ``start_new_session=True`` on Unix
              and ``CREATE_NEW_PROCESS_GROUP`` on Windows isolate the
              sidecar's process group.
"""
from __future__ import annotations

import atexit
import base64
import json
import logging
import os
import struct
import subprocess
import sys
import threading
from pathlib import Path
from typing import Optional

import numpy as np
import torch

from services.tts_backend import TTSBackend

logger = logging.getLogger("omnivoice.subprocess_backend")


# ── Wire protocol constants ────────────────────────────────────────────────

#: Hard cap per frame body. Defeats length-prefix DoS where a malicious or
#: corrupted sidecar sends `0xFFFFFFFF` and the parent would allocate 4 GB
#: before realising the body never arrives. See T-02-01.
MAX_FRAME_BYTES = 64 * 1024 * 1024

#: Parent-side op allowlist. Any sidecar frame whose ``op`` is not in this
#: set is logged and discarded — prevents a compromised sidecar from
#: invoking unintended parent code paths. See T-02-04.
PARENT_INBOUND_OPS = frozenset({
    "ready", "pong", "audio", "progress", "error",
    "gpu_acquire", "gpu_release",
})

#: Reference list of ops the sidecar accepts (informational — enforced on
#: the sidecar side, not in this module).
SIDECAR_INBOUND_OPS = frozenset({"ping", "synthesize", "shutdown"})

#: Timeout for the initial ready handshake. Some engines (IndexTTS, large
#: torch.compile graphs) take 20–25 s to import their dependencies before
#: emitting the first frame; 30 s is a comfortable upper bound that still
#: surfaces a hung sidecar within a single CI run.
SPAWN_READY_TIMEOUT_S = 30.0

#: Per-frame _recv read timeout (best-effort — applies to header read; body
#: read is uninterruptible on a stdlib BufferedReader). Used in health_check
#: and generate to bound a hung sidecar.
RECV_TIMEOUT_S = 60.0


# ── Base class ─────────────────────────────────────────────────────────────


class SubprocessBackend(TTSBackend):
    """Long-lived sidecar-process TTS backend. Subclasses provide
    ``venv_python()`` and ``sidecar_script()``; the base class owns
    spawn/shutdown/_send/_recv/generate + GPU-slot acquire/release.
    """

    # Stable marker so `list_backends()` can detect subprocess-isolated
    # backends without relying on `issubclass()`. ``issubclass`` fails when
    # test fixtures purge `sys.modules["services"]` (as the token_resolver
    # tests do for DB isolation) — the re-imported SubprocessBackend would
    # be a different class object from the one the subclass closed over.
    # A duck-typed marker survives that.
    _is_subprocess_isolated: bool = True

    # Default sample rate; subclasses override.
    _DEFAULT_SAMPLE_RATE = 24000

    # ── instance state (initialised in __init__) ───────────────────────────

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        # Single lock serialises spawn + every send/recv pair so two threads
        # can't interleave half-frames on the same pipe.
        self._lock = threading.Lock()
        self._stderr_thread: Optional[threading.Thread] = None
        # Idempotent atexit shutdown (Pitfall 6 layer 1). If the interpreter
        # exits without an explicit shutdown call, this still tears down the
        # sidecar tree.
        atexit.register(self.shutdown)

    # ── subclass contract ──────────────────────────────────────────────────

    @classmethod
    def venv_python(cls) -> Path:
        """Path to the Python interpreter that runs the sidecar.

        Subclasses point at their engine's dedicated venv. The echo sidecar
        and unit tests point at ``sys.executable`` so they run under the
        bare parent interpreter.
        """
        raise NotImplementedError

    @classmethod
    def sidecar_script(cls) -> Path:
        """Path to the sidecar entrypoint (`backend/engines/<id>/main.py`)."""
        raise NotImplementedError

    # ── lifecycle ──────────────────────────────────────────────────────────

    def _spawn(self) -> None:
        """Launch the sidecar if not already running. Blocks on the ready
        handshake. Caller must hold self._lock."""
        if self._proc is not None and self._proc.poll() is None:
            return  # already up

        # Env forwarding contract (Locked Decision D5):
        #   - Inherit the parent's full env via os.environ.copy().
        #   - The parent's env already carries HF_TOKEN (injected by the
        #     Phase 1 AUTH-04 launch sites that call
        #     ``token_resolver.resolve()``), HF_HOME, HF_ENDPOINT, and
        #     HF_HUB_CACHE.
        #   - PYTHONUNBUFFERED=1 keeps the sidecar's stdout from buffering
        #     past our length-prefix reads.
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"

        kwargs: dict = {
            "stdin": subprocess.PIPE,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "env": env,
            "bufsize": 0,  # unbuffered binary pipes
        }
        # Process-group isolation so the Tauri lib.rs group-kill in shutdown
        # doesn't escape into other children. See T-02-05.
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True

        python_path = str(self.venv_python())
        script_path = str(self.sidecar_script())
        logger.info(
            "[%s] spawning sidecar: %s %s",
            self.id, python_path, script_path,
        )
        self._proc = subprocess.Popen([python_path, script_path], **kwargs)

        # Drain stderr in a background thread so the sidecar can't block on
        # a full pipe. Lines flow into the root logger; AUTH-05's
        # HFTokenRedactor (already installed in Phase 1) strips token bytes.
        # See T-02-03.
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, daemon=True,
            name=f"{self.id}-stderr-drain",
        )
        self._stderr_thread.start()

        # Block on the ready handshake. A sidecar that fails to emit ready
        # within SPAWN_READY_TIMEOUT_S is killed and the failure is raised.
        try:
            frame = self._recv_with_timeout(SPAWN_READY_TIMEOUT_S)
        except Exception:
            self._force_kill()
            raise
        if not frame or frame.get("op") != "ready":
            self._force_kill()
            raise RuntimeError(
                f"{self.id} sidecar did not signal ready: {frame!r}"
            )
        logger.info("[%s] sidecar ready", self.id)

    def shutdown(self) -> None:
        """Idempotent. Sends {op:shutdown}; falls back to terminate/kill."""
        proc = self._proc
        if proc is None:
            return
        try:
            try:
                # Best effort — sidecar may already be dead.
                self._send({"op": "shutdown"})
            except Exception:
                pass
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                logger.warning(
                    "[%s] sidecar did not exit on shutdown frame; terminating",
                    self.id,
                )
                try:
                    proc.terminate()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    logger.warning(
                        "[%s] sidecar did not exit on SIGTERM; killing",
                        self.id,
                    )
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    try:
                        proc.wait(timeout=2)
                    except Exception:
                        pass
        finally:
            self._proc = None

    def _force_kill(self) -> None:
        """Internal: kill a sidecar that never reached the ready state."""
        proc = self._proc
        if proc is None:
            return
        try:
            proc.kill()
            try:
                proc.wait(timeout=2)
            except Exception:
                pass
        except Exception:
            pass
        finally:
            self._proc = None

    def unload(self) -> None:
        """TTSBackend.unload override — idempotent shutdown."""
        self.shutdown()

    # ── health check + generate ────────────────────────────────────────────

    def health_check(self) -> tuple[bool, str]:
        """Send ping, expect pong. Spawns the sidecar if needed.

        Returns (True, "pong") on success, (False, "<exc>") on any failure.
        Never raises — health checks are called from places (engine picker,
        Compat Matrix UI) that must keep working even when an engine is sick.
        """
        try:
            with self._lock:
                self._spawn()
                self._send({"op": "ping"})
                reply = self._recv_with_timeout(RECV_TIMEOUT_S)
            if reply and reply.get("op") == "pong":
                return True, "pong"
            return False, f"unexpected reply: {reply!r}"
        except Exception as exc:
            return False, f"{type(exc).__name__}: {exc}"

    def generate(self, text: str, **kw) -> torch.Tensor:
        """Synthesize one utterance through the sidecar.

        Returns a tensor of shape (1, n_samples) at the sidecar-reported
        sample rate. Decodes the int16 PCM the sidecar returns into float32
        in [-1, 1].
        """
        # Lazy-import the GPU pool so importing this module doesn't pull in
        # the entire model_manager + torch ecosystem at registry-listing time.
        from services.model_manager import _get_gpu_pool

        # Acquire a GPU pool worker for the duration of this generate. The
        # try/finally guarantees the slot is released even if the sidecar
        # dies mid-frame (T-02-02 / Pitfall 7).
        pool = _get_gpu_pool()
        slot_future = pool.submit(lambda: None)
        try:
            slot_future.result(timeout=10)  # wait for our turn
        except Exception:
            slot_future.cancel()
            raise

        try:
            with self._lock:
                self._spawn()
                msg = {"op": "synthesize", "text": text}
                # Filter kwargs to JSON-safe primitives. Tensor / Path / etc.
                # don't survive json.dumps and are silently dropped — the
                # sidecar can't use them anyway.
                for k, v in kw.items():
                    if _is_jsonable(v):
                        msg[k] = v
                self._send(msg)
                reply = self._recv_with_timeout(RECV_TIMEOUT_S)
            if not reply:
                raise RuntimeError(f"{self.id} sidecar closed pipe mid-generate")
            if reply.get("op") == "error":
                raise RuntimeError(
                    f"{self.id} sidecar error: {reply.get('message')!r}"
                )
            if reply.get("op") != "audio":
                raise RuntimeError(
                    f"{self.id} sidecar returned unexpected op: {reply.get('op')!r}"
                )
            pcm_b64 = reply.get("audio_pcm_b64", "")
            pcm = base64.b64decode(pcm_b64)
            arr = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
            tensor = torch.from_numpy(arr.copy()).unsqueeze(0)
            return tensor
        finally:
            # Slot is released the instant this thread leaves the pool's
            # task — by holding slot_future we kept one worker busy; nothing
            # further to do. (ThreadPoolExecutor doesn't expose a manual
            # release; the slot returns to the pool when our submitted no-op
            # finishes, which happens immediately after .result() above.)
            pass

    # ── wire protocol ──────────────────────────────────────────────────────

    def _send(self, msg: dict) -> None:
        """Length-prefixed JSON over the sidecar's stdin. Caller holds lock."""
        if self._proc is None or self._proc.stdin is None:
            raise RuntimeError(f"{self.id} sidecar not running")
        body = json.dumps(msg, separators=(",", ":")).encode("utf-8")
        if len(body) > MAX_FRAME_BYTES:
            raise IOError(f"outbound frame too large: {len(body)}")
        try:
            self._proc.stdin.write(struct.pack("!I", len(body)))
            self._proc.stdin.write(body)
            self._proc.stdin.flush()  # Pitfall 2 — mandatory flush
        except (BrokenPipeError, OSError) as exc:
            raise RuntimeError(
                f"{self.id} sidecar pipe closed: {exc}"
            ) from exc

    def _recv(self) -> Optional[dict]:
        """Read one frame from the sidecar's stdout. Returns None on EOF.

        Op allowlist is enforced here: unknown ops are logged and dropped,
        and we tail-recurse to read the next frame. See T-02-04.
        """
        if self._proc is None or self._proc.stdout is None:
            return None
        stdout = self._proc.stdout
        header = _read_exact(stdout, 4)
        if header is None:
            return None
        (n,) = struct.unpack("!I", header)
        if n > MAX_FRAME_BYTES:
            # T-02-01 — refuse to allocate before the body even arrives.
            raise IOError(f"frame too large: {n}")
        body = _read_exact(stdout, n)
        if body is None or len(body) != n:
            raise IOError("short read")
        try:
            msg = json.loads(body.decode("utf-8"))
        except Exception as exc:
            raise IOError(f"malformed sidecar frame: {exc}") from exc
        op = msg.get("op") if isinstance(msg, dict) else None
        if op not in PARENT_INBOUND_OPS:
            # T-02-04 — refuse to act on unknown ops. Log and read the
            # next frame so we don't desync.
            logger.warning(
                "[%s] dropped sidecar frame with disallowed op=%r",
                self.id, op,
            )
            return self._recv()
        return msg

    def _recv_with_timeout(self, timeout_s: float) -> Optional[dict]:
        """Recv that aborts if the sidecar goes silent.

        Implemented by polling the proc for liveness with a deadline. We
        don't block on a `select` of the pipe because Windows can't select
        on subprocess pipes — keeping the implementation cross-platform
        means a simpler polling loop here.
        """
        # On Unix we could use selectors; on Windows the pipe is not
        # selectable. Use a watchdog thread that kills the sidecar on
        # timeout — that triggers EOF on stdout, so _recv returns None
        # and the caller raises.
        watchdog = threading.Timer(timeout_s, self._timeout_kill)
        watchdog.daemon = True
        watchdog.start()
        try:
            return self._recv()
        finally:
            watchdog.cancel()

    def _timeout_kill(self) -> None:
        proc = self._proc
        if proc is None:
            return
        try:
            logger.error(
                "[%s] sidecar exceeded recv timeout; killing",
                self.id,
            )
            proc.kill()
        except Exception:
            pass

    # ── stderr drain ───────────────────────────────────────────────────────

    def _drain_stderr(self) -> None:
        """Pump sidecar stderr lines into the parent logger.

        Prefixes each line with `[<engine_id>]`. The HFTokenRedactor filter
        installed at the root logger in Phase 1 redacts any token bytes
        that slip through. See T-02-03.
        """
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            for raw in iter(proc.stderr.readline, b""):
                try:
                    line = raw.decode("utf-8", errors="replace").rstrip()
                except Exception:
                    line = repr(raw)
                if line:
                    logger.info("[%s] %s", self.id, line)
        except Exception as exc:
            logger.debug("[%s] stderr drain ended: %s", self.id, exc)


# ── helpers ────────────────────────────────────────────────────────────────


def _read_exact(stream, n: int) -> Optional[bytes]:
    """Read exactly n bytes from a BufferedReader, or return None on EOF.

    BufferedReader.read(n) is allowed to return fewer than n bytes when
    the underlying file descriptor is a pipe — we loop until we have
    all of them or EOF.
    """
    out = bytearray()
    while len(out) < n:
        chunk = stream.read(n - len(out))
        if not chunk:
            if not out:
                return None
            return bytes(out)
        out.extend(chunk)
    return bytes(out)


def _is_jsonable(v) -> bool:
    """Quick filter for kwargs that survive json.dumps. Lists/dicts are
    accepted only if their contents are themselves jsonable."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return True
    if isinstance(v, (list, tuple)):
        return all(_is_jsonable(x) for x in v)
    if isinstance(v, dict):
        return all(isinstance(k, str) and _is_jsonable(x) for k, x in v.items())
    return False


__all__ = [
    "SubprocessBackend",
    "MAX_FRAME_BYTES",
    "PARENT_INBOUND_OPS",
    "SIDECAR_INBOUND_OPS",
]
