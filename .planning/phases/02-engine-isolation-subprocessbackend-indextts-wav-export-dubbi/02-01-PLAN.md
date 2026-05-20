---
phase: 02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - backend/services/subprocess_backend.py
  - backend/services/tts_backend.py
  - backend/engines/__init__.py
  - backend/engines/_echo/__init__.py
  - backend/engines/_echo/main.py
  - tests/backend/services/test_subprocess_backend.py
  - tests/backend/services/test_tts_backend_registry.py
autonomous: true
requirements:
  - ENGINE-01
  - ENGINE-05

must_haves:
  truths:
    - "Echo sidecar spawns from backend/engines/_echo/.venv-less stub (system python), handshakes ready, accepts {op:synthesize}, returns 1 s of int16 silence, exits cleanly on {op:shutdown}"
    - "Parent SIGTERM (atexit) reliably tears down the sidecar process group with zero zombies 5 s later"
    - "When KittenTTSBackend.is_available() raises an exception, list_backends() still returns the other 8 engine entries (graceful-degradation wrap)"
    - "Engine registry response shape includes last_error and isolation_mode keys for the Compat Matrix UI to consume in 02-04"
    - "Subprocess env forwarding contract honored: HF_TOKEN (from Phase 1 token_resolver), HF_HOME, HF_ENDPOINT, HF_HUB_CACHE all reach the child via os.environ.copy()"
    - "No fenced code path uses mp.Process or mp.fork — subprocess.Popen exclusively, with start_new_session=True on Unix and CREATE_NEW_PROCESS_GROUP on Windows"
    - "Frame protocol caps incoming length-prefix at 64 MB; oversize frame raises IOError before allocation (DoS guard)"
  artifacts:
    - path: "backend/services/subprocess_backend.py"
      provides: "SubprocessBackend base class — spawn/shutdown/_send/_recv/generate + GPU slot acquire-release"
      min_lines: 140
      contains: "class SubprocessBackend"
    - path: "backend/engines/_echo/main.py"
      provides: "Permanent regression-test echo sidecar"
      min_lines: 40
      contains: "op.*synthesize"
    - path: "backend/services/tts_backend.py"
      provides: "list_backends() wrapped with try/except per engine; adds _LAST_ERRORS dict and isolation_mode in response"
      contains: "_LAST_ERRORS"
    - path: "tests/backend/services/test_subprocess_backend.py"
      provides: "Round-trip + zombie + env-forwarding + oversize-frame tests"
      min_lines: 100
      contains: "test_echo_round_trip"
    - path: "tests/backend/services/test_tts_backend_registry.py"
      provides: "list_backends() resilience + isolation_mode + last_error shape tests"
      min_lines: 50
  key_links:
    - from: "backend/services/subprocess_backend.py::SubprocessBackend._spawn"
      to: "subprocess.Popen"
      via: "env=os.environ.copy() (forwards HF_TOKEN+HF_HOME+HF_ENDPOINT+HF_HUB_CACHE); PYTHONUNBUFFERED=1; start_new_session/CREATE_NEW_PROCESS_GROUP"
      pattern: "subprocess\\.Popen\\([\\s\\S]*env=.*environ"
    - from: "backend/services/subprocess_backend.py::SubprocessBackend.__init__"
      to: "atexit.register"
      via: "self.shutdown registered for graceful teardown on parent exit (Pitfall 6 defense layer 1)"
      pattern: "atexit\\.register\\(self\\.shutdown"
    - from: "backend/services/subprocess_backend.py::SubprocessBackend.generate"
      to: "backend/services/model_manager.py::_get_gpu_pool"
      via: "try/finally pool slot acquire/release so sidecar death never leaks a slot (Pitfall 7)"
      pattern: "_get_gpu_pool|_gpu_pool"
    - from: "backend/services/tts_backend.py::list_backends"
      to: "backend/services/subprocess_backend.py::SubprocessBackend"
      via: "issubclass check to populate isolation_mode key (in-process vs subprocess) for ENGINE-06 UI"
      pattern: "issubclass.*SubprocessBackend"

threat_model:
  trust_boundaries:
    - "parent backend ↔ engine sidecar (stdio pipes only — no network listener; sidecar inputs come exclusively from parent stdin)"
  threats:
    - id: T-02-01
      category: Denial of Service
      component: backend/services/subprocess_backend.py::_recv (length-prefix framing)
      disposition: mitigate
      mitigation: "Hard cap 64 MB per frame in _recv before allocating body buffer; oversize frame raises IOError and kills sidecar — guards against malicious or corrupted length-prefix triggering 4 GB allocation"
    - id: T-02-02
      category: Denial of Service
      component: backend/services/model_manager.py::_get_gpu_pool (slot accounting)
      disposition: mitigate
      mitigation: "GPU slot is acquired and released in a try/finally surrounding _send/_recv; sidecar process death triggers the finally so slot returns to the pool — no permanent leak after crash (Pitfall 7)"
    - id: T-02-03
      category: Information Disclosure
      component: backend/services/subprocess_backend.py (stderr capture)
      disposition: mitigate
      mitigation: "Parent reads sidecar stderr via background thread that prefixes lines with [<engine_id>] and routes through the same logging filter that AUTH-05 installed in Phase 1 (HFTokenRedactor) — no token bytes reach disk via sidecar stderr"
    - id: T-02-04
      category: Tampering
      component: backend/services/subprocess_backend.py::_recv op-allowlist
      disposition: mitigate
      mitigation: "Parent ignores any sidecar message whose 'op' is not in {ready, pong, audio, progress, error, gpu_acquire, gpu_release}; unknown ops are logged and discarded — prevents a compromised sidecar from invoking unintended parent code paths"
    - id: T-02-05
      category: Elevation of Privilege
      component: subprocess spawn (start_new_session / CREATE_NEW_PROCESS_GROUP)
      disposition: mitigate
      mitigation: "Sidecar runs in its own process group so SIGTERM-with-grace from Tauri (lib.rs:567-595) can group-kill the sidecar tree without escaping into other backend children (Pitfall 6 defense layer 2)"
---

<objective>
Land the durable `SubprocessBackend` primitive — the architectural keystone Phases 3, 4 and 5 plug into. Ship an echo sidecar at `backend/engines/_echo/main.py` as permanent CI regression infrastructure, the base class at `backend/services/subprocess_backend.py`, and the engine-registry graceful-degradation wrap that closes ENGINE-05 (one broken engine cannot take down the picker). No IndexTTS migration in this plan — that lives in 02-03; this plan is the foundation 02-03 builds on.

Purpose: Closing #42 in 02-03 requires a tested process-isolation primitive. Building primitive + first migrant in one plan is the "scavenger hunt" anti-pattern — primitive needs to exist, have tests, and have a CI regression engine before any production engine sits on top of it. The echo sidecar is permanent test infra so the primitive doesn't decay between phases.

Output: ~150 LOC `subprocess_backend.py` + ~50 LOC echo sidecar + ~30 LOC modification to `tts_backend.list_backends()` + ~150 LOC of tests. Zero new Python dependencies. Backward-compatible with every existing in-process engine (untouched).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/STATE.md
@.planning/phases/02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi/02-RESEARCH.md
@.planning/phases/01-install-token-persistence-docs-scaffolding-error-ux/01-01-PLAN.md

@CLAUDE.md
@backend/services/tts_backend.py
@backend/services/sonitranslate.py
@backend/services/gpu_sandbox.py
@backend/services/model_manager.py
@backend/api/routers/engines.py

<interfaces>
<!-- Contracts this plan creates. Plan 02-03 (IndexTTS migration) and Plan 02-04 (UI) consume these. -->

```python
# backend/services/subprocess_backend.py — public API
from __future__ import annotations
import subprocess, threading
from pathlib import Path
from typing import Optional
import torch
from backend.services.tts_backend import TTSBackend

# Op allowlist (T-02-04). Parent rejects any sidecar message whose op is not in this set.
PARENT_INBOUND_OPS = frozenset({"ready", "pong", "audio", "progress", "error", "gpu_acquire", "gpu_release"})
SIDECAR_INBOUND_OPS = frozenset({"ping", "synthesize", "shutdown"})

# Hard cap to defeat length-prefix DoS (T-02-01).
MAX_FRAME_BYTES = 64 * 1024 * 1024

class SubprocessBackend(TTSBackend):
    """Long-lived sidecar-process TTS backend. Subclasses provide venv_python()
    and sidecar_script(); base class owns spawn/shutdown/_send/_recv/generate
    + GPU slot acquire-release.
    """
    _proc: Optional[subprocess.Popen]
    _lock: threading.Lock
    _stderr_thread: Optional[threading.Thread]

    @classmethod
    def venv_python(cls) -> Path: ...
    @classmethod
    def sidecar_script(cls) -> Path: ...

    def _spawn(self) -> None: ...
    def shutdown(self) -> None: ...
    def health_check(self) -> tuple[bool, str]:
        """Sends {op:ping}, expects {op:pong}. Spawns sidecar if not running."""
    def generate(self, text: str, **kw) -> torch.Tensor: ...

    # Wire protocol
    def _send(self, msg: dict) -> None: ...
    def _recv(self) -> Optional[dict]: ...
```

```python
# backend/services/tts_backend.py — additions
_LAST_ERRORS: dict[str, str] = {}   # NEW — module-level last-error cache for ENGINE-06 UI

def list_backends() -> list[dict]:
    """Returns one entry per registered backend. Each entry shape:
        {
          "id": str,
          "display_name": str,
          "available": bool,
          "reason": Optional[str],       # error message when available=False
          "install_hint": Optional[str],
          "last_error": Optional[str],   # NEW — cached most-recent failure (ENGINE-06)
          "isolation_mode": "in-process" | "subprocess",  # NEW — for ENGINE-06 UI
        }
    Guarantees: no single backend's is_available() exception can prevent the list from returning.
    """
```

```python
# backend/engines/_echo/main.py — sidecar contract (parent side reference)
# Op flow expected by parent on first spawn:
#   1. Sidecar -> parent: {"op": "ready", "engine": "_echo"}
#   2. Parent -> sidecar: {"op": "synthesize", "text": "...", "sample_rate": 24000}
#   3. Sidecar -> parent: {"op": "audio", "audio_pcm_b64": <1 s int16 silence>, "sample_rate": 24000}
#   4. Parent -> sidecar: {"op": "shutdown"}
#   5. Sidecar exits with code 0
```
</interfaces>

<existing_state>
- `backend/services/sonitranslate.py:130-182` is the lifecycle reference (long-lived subprocess.Popen + env=os.environ.copy() + manual stdin/stdout pipes). DO NOT touch sonitranslate.py in this phase (D1 locked decision — defer SoniTranslate refactor to v0.4).
- `backend/services/gpu_sandbox.py` is the multiprocessing.Pipe + pickled-tensor reference. Phase 2 uses `subprocess.Popen` instead (locked decision D3/D4) because IndexTTS needs a different venv's interpreter, which `mp.Process` cannot deliver. gpu_sandbox.py is untouched.
- `backend/services/tts_backend.py:34-91` defines the `TTSBackend(ABC)` shape. `is_available()` returns `tuple[bool, str]`. `_REGISTRY` is the module-level dict. `list_backends()` is the function that enumerates the registry — its current implementation does NOT wrap `is_available()` in try/except, which is the ENGINE-05 root cause.
- `backend/services/model_manager.py:45-98` exposes `_get_gpu_pool()` returning a `ThreadPoolExecutor`. Use `pool.submit(lambda: None).result()` as a slot-grant primitive (acquires a worker thread for the generation's duration, releases on exit).
- `backend/services/tts_backend.py:711-812` has the existing IndexTTS2Backend — DO NOT MODIFY in this plan. 02-03 rewires it; this plan does not touch it.
- Phase 1's token_resolver.py and HFTokenRedactor logging filter are already shipped (Plan 01-01). This plan does NOT call token_resolver directly — it relies on the AUTH-04 subprocess env injection that Plan 01-01 Task 3 patched into engine launch sites. SubprocessBackend MUST be one of those sites: 02-03 will rely on this plan's `os.environ.copy()` carrying the resolver-injected HF_TOKEN. Verify via the env-forwarding test below.
- `backend/api/routers/engines.py` already calls `tts_backend.list_backends()` (line 35). Changes to the list_backends() response shape land here automatically — frontend in 02-04 consumes via the same `/engines` endpoint.
- `backend/engines/` directory does not exist yet. Create with `__init__.py`. `backend/engines/_echo/` is the first occupant.
</existing_state>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Echo sidecar + SubprocessBackend base class</name>
  <files>backend/services/subprocess_backend.py, backend/engines/__init__.py, backend/engines/_echo/__init__.py, backend/engines/_echo/main.py, tests/backend/services/test_subprocess_backend.py</files>
  <behavior>
    `tests/backend/services/test_subprocess_backend.py`:
    - `test_echo_round_trip`: spawn EchoBackend → assert ready handshake within 5 s → call generate("hello") → assert returned tensor has shape (1, 24000), dtype float32, near-zero amplitude (silence).
    - `test_no_zombie_after_shutdown`: spawn → record child PID via `backend._proc.pid` → call backend.shutdown() → assert psutil cannot find that PID after 3 s grace.
    - `test_atexit_cleanup`: spawn → simulate Python interpreter exit by calling `atexit._run_exitfuncs()` manually in a subprocess test harness → assert sidecar exits within 3 s.
    - `test_env_forwarding_contract`: set HF_TOKEN=hf_test_abc and HF_HOME=/tmp/hf_test_home and HF_ENDPOINT=https://hf-mirror.com and HF_HUB_CACHE=/tmp/hf_cache in the test environment → spawn echo sidecar that has been modified to echo back its env via a {op:probe_env} test-only op → assert all four keys arrive in the child env exactly. (Locked decision D5.)
    - `test_oversize_frame_rejected`: feed a length-prefix of 100 MB to `_recv` via a mocked stream → assert `IOError("frame too large")`. (T-02-01.)
    - `test_short_read_rejected`: feed a length-prefix of 100 bytes followed by 50 bytes of body and EOF → assert `IOError("short read")`.
    - `test_sidecar_dies_releases_gpu_slot`: spawn → kill -9 the sidecar mid-generate → assert the `_get_gpu_pool()` count returns to baseline within 2 s (try/finally guards Pitfall 7).
    - `test_op_allowlist`: send an unknown op like `{"op":"exfiltrate"}` from the sidecar (via a test-only echo sidecar variant) → parent logs WARNING but does not crash and does not echo the unknown payload anywhere. (T-02-04.)
    - `test_health_check_pings`: call `backend.health_check()` → returns `(True, "pong")` after a successful ping round-trip.
  </behavior>
  <action>
    Step 1 — Create `backend/engines/__init__.py` (empty), `backend/engines/_echo/__init__.py` (empty), and `backend/engines/_echo/main.py`:
      - Module docstring: "Permanent CI regression-test sidecar. DO NOT delete — keeps SubprocessBackend round-trip working as a green build gate."
      - `send(obj)` / `recv()` helpers: stdlib-only, length-prefixed JSON over `sys.stdin.buffer` / `sys.stdout.buffer`. Always `flush()` after writing the body (Pitfall 2).
      - `main()` loop:
        1. Emit `{"op":"ready","engine":"_echo"}`.
        2. Loop reading frames. Dispatch on op:
           - `ping` → emit `{"op":"pong"}`.
           - `synthesize` → build 1 second of int16 zeros at the requested sample_rate (default 24000) → emit `{"op":"audio","audio_pcm_b64":<base64 of zeros>,"sample_rate":sr,"n_samples":sr}`.
           - `probe_env` (TEST ONLY — only registered when `OMNIVOICE_ECHO_TEST_MODE=1`) → emit `{"op":"probe_env_result","keys":{"HF_TOKEN":os.environ.get("HF_TOKEN"),"HF_HOME":...,"HF_ENDPOINT":...,"HF_HUB_CACHE":...}}`.
           - `shutdown` → break loop, return 0.
           - Unknown → emit `{"op":"error","stage":"dispatch","message":f"unknown op: {op}"}` and continue.
      - Exit code 0 on shutdown, 1 on uncaught exception with traceback emitted via `{"op":"error"}` frame.
      - DO NOT import torch in the echo sidecar — use raw `struct.pack` + `b"\x00\x00" * n_samples` for the int16 silence. Keeps echo sidecar runnable under system Python without a venv (which is the whole point of the test infrastructure — the echo sidecar must spawn even when no engine venv exists).

    Step 2 — Create `backend/services/subprocess_backend.py` per the `<interfaces>` API:
      - Module docstring per RESEARCH.md "SubprocessBackend base class skeleton" section. Explicitly forbid `mp.Process` / `mp.fork` / `mp.spawn` in the docstring; explain why (Pitfall 1 — sidecars need a *different* interpreter's binary; mp.Process can't deliver that).
      - Constants: `MAX_FRAME_BYTES = 64 * 1024 * 1024`, `PARENT_INBOUND_OPS = frozenset({"ready","pong","audio","progress","error","gpu_acquire","gpu_release"})`.
      - `class SubprocessBackend(TTSBackend)`:
        - `__init__`: `self._proc = None`, `self._lock = threading.Lock()`, `self._stderr_thread = None`, `atexit.register(self.shutdown)`.
        - `venv_python()` and `sidecar_script()`: raise `NotImplementedError`. Subclasses MUST override.
        - `_spawn(self)`:
          - If `self._proc and self._proc.poll() is None`, return early.
          - `env = os.environ.copy()` then `env["PYTHONUNBUFFERED"] = "1"`. This satisfies D5 (forwards HF_TOKEN injected by AUTH-04 + HF_HOME/HF_ENDPOINT/HF_HUB_CACHE inherited from `backend/main.py:64-65`).
          - Build Popen kwargs: `stdin=PIPE, stdout=PIPE, stderr=PIPE, env=env`. On `sys.platform != "win32"` set `start_new_session=True`; on Windows set `creationflags=subprocess.CREATE_NEW_PROCESS_GROUP`. (T-02-05.)
          - Launch: `self._proc = subprocess.Popen([str(self.venv_python()), str(self.sidecar_script())], **kwargs)`.
          - Start the stderr drain thread: `threading.Thread(target=self._drain_stderr, daemon=True).start()`. Drain reads sidecar stderr line-by-line, prefixes with `[<self.id>] `, and emits via `logger.info()` — Phase 1's HFTokenRedactor on the root logger filters secrets out. (T-02-03.)
          - Block on first frame with 30 s timeout. If frame op != "ready", raise `RuntimeError(f"{self.id} sidecar did not signal ready: {frame!r}")`.
        - `_send(self, msg)`:
          - `body = json.dumps(msg, separators=(",", ":")).encode("utf-8")`
          - `self._proc.stdin.write(struct.pack("!I", len(body))); self._proc.stdin.write(body); self._proc.stdin.flush()` — flush is mandatory (Pitfall 2).
        - `_recv(self)`:
          - `header = self._proc.stdout.read(4)`; if `len(header) < 4`, return None (EOF).
          - `(n,) = struct.unpack("!I", header)`.
          - If `n > MAX_FRAME_BYTES`, raise `IOError(f"frame too large: {n}")`. (T-02-01.)
          - Read body in a loop until n bytes have been received (raw `.read()` on a pipe can return fewer bytes than asked); if EOF before n, raise `IOError("short read")`.
          - Parse JSON. If parsed op is not in `PARENT_INBOUND_OPS`, log a warning and recurse `_recv()` to drop the frame. (T-02-04.)
          - Return dict.
        - `health_check(self) -> tuple[bool, str]`:
          - Acquire `self._lock`. Call `_spawn()`. Send `{"op":"ping"}`. Receive. Return `(True, "pong")` on success, `(False, str(e))` on any exception.
        - `generate(self, text, **kw) -> torch.Tensor`:
          - Acquire `self._lock`. Call `_spawn()`.
          - Acquire GPU slot via `_get_gpu_pool()` — submit a no-op future and call `.result()` to grab a worker thread for the duration. Wrap in try/finally so a sidecar exception still releases the slot (Pitfall 7, T-02-02).
          - Filter kwargs to JSON-serializable only (str/int/float/bool/list/dict/None); silently drop tensor or path kwargs that don't survive JSON.
          - Send `{"op":"synthesize","text":text, **filtered_kw}`. Recv response. If op != "audio", raise `RuntimeError`.
          - Decode `audio_pcm_b64`: `pcm = base64.b64decode(response["audio_pcm_b64"])`; `arr = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0`; return `torch.from_numpy(arr).unsqueeze(0)`.
        - `shutdown(self)`:
          - If not self._proc, return.
          - Try `self._send({"op":"shutdown"})` (best effort — sidecar may already be dead).
          - `self._proc.wait(timeout=3)`; on `TimeoutExpired` → `self._proc.terminate()`; wait 2 s; on `TimeoutExpired` → `self._proc.kill()`.
          - Set `self._proc = None`. Make shutdown idempotent.
        - `_drain_stderr(self)`: read sidecar stderr lines via `self._proc.stderr`; for each line, `logger.info("[%s] %s", self.id, line.rstrip())`. Exit thread on EOF.

    Step 3 — Define an `_EchoBackend(SubprocessBackend)` subclass IN THE TEST FILE (not in production code, to keep _REGISTRY clean):
      - `id = "_echo"`, `display_name = "Echo (test)"`.
      - `venv_python()` returns `Path(sys.executable)` — echo sidecar runs under the parent's Python so the test does not require a separate venv.
      - `sidecar_script()` returns `Path(__file__).parent.parent.parent / "backend" / "engines" / "_echo" / "main.py"`.
      - `is_available(cls)` returns `(True, "ok")` if the script file exists.

    Step 4 — Write all 9 tests listed in `<behavior>`. Use `pytest-timeout 30` per test (already pinned per RESEARCH.md A1).
      - For `test_no_zombie_after_shutdown`: use `psutil.pid_exists(pid)` not `os.kill(pid, 0)` — psutil is cross-platform; `os.kill` semantics differ on Windows.
      - For `test_sidecar_dies_releases_gpu_slot`: use a small `OMNIVOICE_ECHO_CRASH=1` env var that the echo sidecar reads and self-`os._exit(1)`s after one frame; assert `_get_gpu_pool()._work_queue.qsize()` (or comparable) is back to baseline.
      - For `test_op_allowlist`: create a variant `_misbehaving_sidecar.py` adjacent that emits `{"op":"exfiltrate"}` instead of `ready` — parent must log a warning and not crash.

    Cross-platform notes: tests use `pytest.skipif(sys.platform == "win32", ...)` ONLY where genuinely required (none of the above are Unix-specific). The whole point of `subprocess.Popen` + `CREATE_NEW_PROCESS_GROUP` is to land green on macOS, Linux, AND Windows in CI.
  </action>
  <verify>
    <automated>uv run pytest tests/backend/services/test_subprocess_backend.py -x -v --timeout=30</automated>
  </verify>
  <done>
    All 9 tests in `test_subprocess_backend.py` pass green on CI matrix (macOS, Linux, Windows). `backend/services/subprocess_backend.py` exists with `SubprocessBackend` exported. `backend/engines/_echo/main.py` exists and survives a manual `python backend/engines/_echo/main.py < /dev/null` (graceful exit, no crash). No `mp.Process` / `mp.fork` / `mp.spawn` appears in `subprocess_backend.py` (`grep -nE "mp\\.(Process|fork|spawn)" backend/services/subprocess_backend.py` returns zero lines).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: list_backends() graceful-degradation wrap + isolation_mode + last_error</name>
  <files>backend/services/tts_backend.py, tests/backend/services/test_tts_backend_registry.py</files>
  <behavior>
    `tests/backend/services/test_tts_backend_registry.py`:
    - `test_list_backends_resilient`: register a fake `BrokenBackend` whose `is_available(cls)` raises `RuntimeError("kaboom")` → call `list_backends()` → assert the response contains an entry for "broken" with `available=False`, `reason="RuntimeError: kaboom"`, AND `last_error="RuntimeError: kaboom"` AND the response also still contains all other in-tree engines. The exception MUST NOT propagate.
    - `test_list_backends_shape`: assert every entry in the response has exactly these keys: `{id, display_name, available, reason, install_hint, last_error, isolation_mode}`. Forbid extra/missing keys.
    - `test_isolation_mode_in_process_vs_subprocess`: register a `class FakeSubBackend(SubprocessBackend)` stub (subclass of SubprocessBackend created in 02-01 Task 1) → assert its entry has `isolation_mode == "subprocess"`. The pre-existing OmniVoiceBackend entry has `isolation_mode == "in-process"`.
    - `test_last_error_cached_across_calls`: register a backend whose `is_available()` raises on first call but returns `(True, "ok")` on second call → first `list_backends()` populates `_LAST_ERRORS["flaky"]`; second `list_backends()` clears it (`_LAST_ERRORS.pop("flaky", None)`). The `last_error` field reflects the most recent FAILURE, not a stale entry after a subsequent success.
    - `test_existing_engines_still_listed`: assert `len(list_backends()) >= 8` (the in-tree count: OmniVoice, VoxCPM2, MossTTSNano, KittenTTS, MLXAudio, CosyVoice, IndexTTS2, plus any others currently registered) — the wrap MUST NOT silently drop entries.
  </behavior>
  <action>
    Step 1 — Edit `backend/services/tts_backend.py`:
      - Near the top of the module (after imports, before `_REGISTRY`), declare `_LAST_ERRORS: dict[str, str] = {}`. Module-level dict caching the most-recent failure per backend id. Reused by ENGINE-06 UI in 02-04.
      - Find the existing `list_backends()` function (per RESEARCH.md it's at the bottom of the file — confirm via `grep -n "def list_backends" backend/services/tts_backend.py`).
      - Rewrite per the contract in `<interfaces>`:
        ```
        from backend.services.subprocess_backend import SubprocessBackend  # at top of file with other imports
        def list_backends() -> list[dict]:
            out = []
            for bid, cls in _REGISTRY.items():
                try:
                    ok, msg = cls.is_available()
                except Exception as e:
                    ok, msg = False, f"{type(e).__name__}: {e}"
                if not ok:
                    _LAST_ERRORS[bid] = msg
                else:
                    _LAST_ERRORS.pop(bid, None)
                isolation = "subprocess" if issubclass(cls, SubprocessBackend) else "in-process"
                out.append({
                    "id": bid,
                    "display_name": cls.display_name,
                    "available": ok,
                    "reason": None if ok else msg,
                    "install_hint": _INSTALL_HINTS.get(bid),
                    "last_error": _LAST_ERRORS.get(bid),
                    "isolation_mode": isolation,
                })
            return out
        ```
      - DO NOT modify the IndexTTS2Backend class or any other existing backend. The wrap is purely at the list_backends() call site.
      - Handle the potential circular import: SubprocessBackend imports `from backend.services.tts_backend import TTSBackend`. If tts_backend.py then imports `from backend.services.subprocess_backend import SubprocessBackend` at module top, Python's import machinery may break. Resolution: import `SubprocessBackend` LAZILY inside `list_backends()` (one local import — cheap, avoids the cycle). Document the pattern in a comment.

    Step 2 — Verify the existing FastAPI route at `backend/api/routers/engines.py:35` already returns `tts_backend.list_backends()` unmodified. The added keys (`last_error`, `isolation_mode`) flow through `JSONResponse` by default. Frontend in 02-04 consumes via the same endpoint. If the response payload is currently transformed/whitelisted in `engines.py`, extend the whitelist to include the two new keys.

    Step 3 — Write tests per `<behavior>`. For `test_list_backends_resilient`:
      - Add `BrokenBackend` to `_REGISTRY` via a context manager fixture that registers + tears down to avoid polluting other tests.
      - Use `pytest.fixture(autouse=False)` so the registration is opt-in per test.
    For `test_isolation_mode_in_process_vs_subprocess`:
      - Define a `FakeSubBackend(SubprocessBackend)` whose `is_available(cls)` returns `(True, "ok")` and `venv_python()` returns `Path(sys.executable)` (no real spawn needed — we never call generate() in this test).
    For `test_last_error_cached_across_calls`:
      - Use a stateful `is_available` whose first call raises and second returns ok (via `unittest.mock.Mock` with `side_effect=[Exception(...), (True, "ok")]`).
  </action>
  <verify>
    <automated>uv run pytest tests/backend/services/test_tts_backend_registry.py -x -v --timeout=30</automated>
  </verify>
  <done>
    All 5 tests in `test_tts_backend_registry.py` pass. `grep -n "_LAST_ERRORS" backend/services/tts_backend.py` shows the dict declaration + reads/writes. `grep -n "isolation_mode" backend/services/tts_backend.py` shows the field is populated. The existing `/engines` HTTP endpoint round-trips the two new keys (manual `curl http://localhost:3900/engines` from a running backend shows `last_error` and `isolation_mode` for every entry). Boot the backend with `IndexTTS2Backend.is_available` monkeypatched to raise → confirm the engine picker still shows all other engines (smoke verification — not part of the automated test gate).
  </done>
</task>

</tasks>

<verification>
  After both tasks:
  - `uv run pytest tests/backend/services/test_subprocess_backend.py tests/backend/services/test_tts_backend_registry.py -x --timeout=30` → all green
  - `grep -nE "mp\\.(Process|fork|spawn)" backend/services/subprocess_backend.py | grep -v '^[[:space:]]*#'` → 0 lines (locked decision D4)
  - `grep -n "atexit.register" backend/services/subprocess_backend.py` → at least 1 match (Pitfall 6 layer 1)
  - `grep -n "os.environ.copy" backend/services/subprocess_backend.py` → at least 1 match (D5 env forwarding)
  - `grep -nE "(start_new_session|CREATE_NEW_PROCESS_GROUP)" backend/services/subprocess_backend.py` → at least 2 matches (Unix + Windows branches of T-02-05)
  - `grep -n "MAX_FRAME_BYTES\\s*=\\s*64" backend/services/subprocess_backend.py` → at least 1 match (T-02-01)
  - Manually start the backend and `curl http://localhost:3900/engines` → response includes `last_error` and `isolation_mode` keys for every entry
</verification>

<success_criteria>
1. SubprocessBackend primitive exists, is tested, and the echo sidecar serves as permanent CI regression infrastructure (deletion of either file should fail CI immediately via the round-trip test).
2. ENGINE-05 closed: one engine's broken `is_available()` cannot blank the picker. The wrap is in `list_backends()` itself, not added to each engine — defense at the right architectural layer.
3. ENGINE-06 data shape ready for consumption by 02-04's UI: `last_error` and `isolation_mode` populated on every list entry.
4. D5 env forwarding contract verified by `test_env_forwarding_contract` — HF_TOKEN (from AUTH-04 in Plan 01-01), HF_HOME, HF_ENDPOINT, HF_HUB_CACHE all reach the child env. 02-03 (IndexTTS) relies on this.
5. Cross-platform parity preserved: every Popen flag, every test, runs green on macOS Apple Silicon, macOS Intel, Linux, and Windows in CI.
6. Zero new Python dependencies: `uv pip list` post-task shows the same package list as before.
7. SoniTranslate untouched (D1 locked decision): `git diff backend/services/sonitranslate.py` is empty after both tasks.
</success_criteria>

<output>
Create `.planning/phases/02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi/02-01-SUMMARY.md` when done. Include:
- Exact public API of `SubprocessBackend` (signatures + docstring snippets) so 02-03 (IndexTTS) and Phase 3 (Supertonic-3) authors don't need to re-read the source.
- Confirmation of `MAX_FRAME_BYTES`, the op allowlist, and the env-forwarding invariant.
- Note: the echo sidecar at `backend/engines/_echo/main.py` is permanent infrastructure — DO NOT delete in any subsequent phase.
- Any deviations from RESEARCH.md skeleton (if the LOC count, lock granularity, or GPU slot strategy diverged in practice).
</output>
</content>
</invoke>