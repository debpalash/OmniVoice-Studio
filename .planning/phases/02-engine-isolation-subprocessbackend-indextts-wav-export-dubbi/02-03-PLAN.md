---
phase: 02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi
plan: 03
type: execute
wave: 2
depends_on:
  - 02-01
files_modified:
  - backend/engines/indextts/__init__.py
  - backend/engines/indextts/main.py
  - backend/engines/indextts/bootstrap.py
  - backend/services/tts_backend.py
  - tests/backend/services/test_indextts_sidecar.py
  - tests/backend/services/test_indextts_backward_compat.py
autonomous: true
requirements:
  - ENGINE-02
  - ENGINE-03
  - ENGINE-04
  - ENGINE-07

must_haves:
  truths:
    - "IndexTTS now runs in its own subprocess + dedicated venv with transformers<5; OmniVoice parent process continues to pin transformers>=5.3 unaffected (closes #42 real fix, not graceful-degradation wrap)"
    - "Same Python session that loads OmniVoiceBackend can also drive IndexTTS via the sidecar — one generation on each, no AttributeError, no OffloadedCache ImportError (ENGINE-04)"
    - "Existing IndexTTS user with OMNIVOICE_INDEXTTS_DIR set and $HF_HOME/hub/models--IndexTeam--IndexTTS-2/ populated reaches a working generation with ZERO re-download AND ZERO re-install (ENGINE-07)"
    - "Backward-compat venv probe runs in order: (1) ${OMNIVOICE_INDEXTTS_DIR}/.venv → (2) engines/indextts/.venv → (3) bootstrap engines/indextts/.venv via bundled uv venv + uv pip install -e ${OMNIVOICE_INDEXTTS_DIR}"
    - "Sidecar inherits HF_HOME / HF_HUB_CACHE / HF_ENDPOINT / HF_TOKEN from parent env exactly (D5 contract from 02-01 verified end-to-end against IndexTTS)"
    - "IndexTTS2Backend is now a thin SubprocessBackend subclass — the old in-process import-and-load path is removed; the old class's emotion/duration kwargs are preserved as JSON-serializable fields in the synthesize op"
  artifacts:
    - path: "backend/engines/indextts/main.py"
      provides: "IndexTTS sidecar entry point — loads IndexTTS2 once on ready, JSON-stdio loop dispatches ping/synthesize/shutdown"
      min_lines: 100
      contains: "from indextts.infer_v2 import IndexTTS2"
    - path: "backend/engines/indextts/bootstrap.py"
      provides: "Per-engine venv probe + lazy bootstrap via bundled uv (engines/indextts/.venv or ${OMNIVOICE_INDEXTTS_DIR}/.venv reuse)"
      min_lines: 60
      contains: "def resolve_indextts_venv"
    - path: "backend/services/tts_backend.py"
      provides: "IndexTTS2Backend rewritten as a SubprocessBackend subclass; old import-and-load body removed"
      contains: "class IndexTTS2Backend(SubprocessBackend)"
    - path: "tests/backend/services/test_indextts_sidecar.py"
      provides: "Sidecar import-isolation + coexistence-with-OmniVoice + HF_HOME inheritance tests"
      min_lines: 80
    - path: "tests/backend/services/test_indextts_backward_compat.py"
      provides: "Venv-probe priority + cache-reuse tests for ENGINE-07"
      min_lines: 50
  key_links:
    - from: "backend/services/tts_backend.py::IndexTTS2Backend"
      to: "backend/services/subprocess_backend.py::SubprocessBackend"
      via: "class IndexTTS2Backend(SubprocessBackend) — inheritance, no other code"
      pattern: "class IndexTTS2Backend\\(SubprocessBackend\\)"
    - from: "backend/services/tts_backend.py::IndexTTS2Backend.venv_python"
      to: "backend/engines/indextts/bootstrap.py::resolve_indextts_venv"
      via: "delegates to the probe-then-bootstrap function — backward-compat with existing installs"
      pattern: "resolve_indextts_venv"
    - from: "backend/engines/indextts/main.py"
      to: "indextts.infer_v2.IndexTTS2"
      via: "load model once after ready handshake; pass cfg_path/model_dir from env"
      pattern: "from indextts\\.infer_v2 import IndexTTS2"
    - from: "backend/engines/indextts/bootstrap.py"
      to: "bundled uv (via tools.rs find_bundled_uv or system PATH fallback)"
      via: "uv venv + uv pip install -e ${OMNIVOICE_INDEXTTS_DIR} when no existing venv found"
      pattern: "uv.*venv"

threat_model:
  trust_boundaries:
    - "OmniVoice parent ↔ IndexTTS sidecar (inherits 02-01 stdio op-allowlist + frame DoS cap)"
    - "IndexTTS sidecar ↔ filesystem (reads from OMNIVOICE_INDEXTTS_DIR + HF cache; writes to tempfile only)"
  threats:
    - id: T-02-08
      category: Information Disclosure
      component: backend/engines/indextts/main.py (HF_TOKEN handling)
      disposition: mitigate
      mitigation: "Sidecar never logs os.environ contents and never includes env vars in error frames. If indextts library logs HF_TOKEN internally, the parent's stderr-drain thread routes sidecar stderr through the root logger which carries Phase 1's HFTokenRedactor filter. Defense-in-depth across the boundary."
    - id: T-02-09
      category: Tampering
      component: backend/engines/indextts/bootstrap.py (uv pip install -e)
      disposition: accept
      mitigation: "Bootstrap installs indextts from a user-controlled local directory (OMNIVOICE_INDEXTTS_DIR). The user already trusts that directory's contents (it's their own clone). No transitive supply-chain check beyond what uv lock provides for indextts's own dependencies. v0.4 milestone can add hash-pinned indextts requirements; v0.3 accepts."
    - id: T-02-10
      category: Denial of Service
      component: backend/engines/indextts/main.py (model load)
      disposition: mitigate
      mitigation: "First-launch model load is ~20 s cold (Pitfall 8). Sidecar emits {op:progress} frames during load so the parent can surface 'loading…' state to the UI; the Compat Matrix in 02-04 reads these. No infinite hang — load times out at 120 s (10x normal) and the sidecar exits with an error frame."
    - id: T-02-11
      category: Tampering
      component: backend/engines/indextts/main.py (filesystem temp file)
      disposition: mitigate
      mitigation: "Sidecar writes intermediate WAVs to tempfile.NamedTemporaryFile(suffix='.wav') and unlinks them before responding. No persistent state outside the HF cache. Failure to unlink (OSError) is logged but does not break the response — pytmp cleanup at process exit catches stragglers."
---

<objective>
Migrate IndexTTS off the in-process import path and onto a dedicated subprocess + venv via the `SubprocessBackend` primitive shipped in 02-01. This is the closure of issue #42 — the canonical `OffloadedCache` ImportError driven by transformers v4↔v5 incompatibility. The migration MUST be transparent to existing users with `OMNIVOICE_INDEXTTS_DIR` set: no re-download of the ~6 GB model weights, no re-install of the IndexTTS package, no user-visible disruption beyond a one-time first-launch venv probe.

Purpose: Phase 2's keystone. Closes ENGINE-02 / ENGINE-03 / ENGINE-04 / ENGINE-07 in one focused migration. The IndexTTS2Backend class shrinks from ~100 lines of in-process model loading to ~30 lines of `SubprocessBackend` configuration — the bulk of the new code is the sidecar entry point (`engines/indextts/main.py`) which runs inside a different venv with a different `transformers` pin.

Output: Sidecar entry point + venv-probe bootstrap helper + rewritten `IndexTTS2Backend` + integration tests proving (a) import isolation works, (b) IndexTTS coexists with in-process engines in one session, (c) existing users don't re-download or re-install. Wave 2 because depends on 02-01's primitive being green; runs alongside 02-02 (BUG-01 / WAV fix, different files, parallelizable but assigned to Wave 1).
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
@.planning/phases/02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi/02-01-PLAN.md

@CLAUDE.md
@backend/services/tts_backend.py
@backend/services/subprocess_backend.py
@backend/services/sonitranslate.py
@backend/main.py
@frontend/src-tauri/src/tools.rs

<interfaces>
<!-- IndexTTS2Backend's new shape (rewritten as SubprocessBackend subclass) and the bootstrap helper API. -->

```python
# backend/services/tts_backend.py — replaces lines 711-812 IndexTTS2Backend
from backend.services.subprocess_backend import SubprocessBackend
from backend.engines.indextts.bootstrap import resolve_indextts_venv, INDEXTTS_SIDECAR_SCRIPT

class IndexTTS2Backend(SubprocessBackend):
    id = "indextts2"
    display_name = "IndexTTS2 (emotion control, duration control, zero-shot)"

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        """Returns (True, "ok") iff (a) a venv exists or can be bootstrapped,
        AND (b) the sidecar script file exists. Does NOT spawn the sidecar —
        spawn happens lazily on first generate()/health_check() per Pitfall 8.
        Health-checking the sidecar requires user action (Settings → 'Test engine')
        per Open Question #2 resolution."""

    @classmethod
    def venv_python(cls) -> Path:
        return resolve_indextts_venv()

    @classmethod
    def sidecar_script(cls) -> Path:
        return INDEXTTS_SIDECAR_SCRIPT
```

```python
# backend/engines/indextts/bootstrap.py — new
from pathlib import Path

INDEXTTS_SIDECAR_SCRIPT: Path  # absolute path to backend/engines/indextts/main.py

def resolve_indextts_venv() -> Path:
    """Returns absolute path to the sidecar's Python executable.

    Probes in priority order (Open Question #1 resolution):
      1. ${OMNIVOICE_INDEXTTS_DIR}/.venv/bin/python (or Scripts/python.exe) if it
         exists AND `import indextts` succeeds when invoked
      2. engines/indextts/.venv/bin/python (or Scripts/python.exe) if it exists
         AND `import indextts` succeeds when invoked
      3. Bootstrap engines/indextts/.venv via the bundled `uv venv` + `uv pip
         install -e ${OMNIVOICE_INDEXTTS_DIR}` (requires OMNIVOICE_INDEXTTS_DIR set;
         if unset, raises a clear error pointing at install docs)

    Raises:
      RuntimeError if no working venv can be located AND OMNIVOICE_INDEXTTS_DIR
      is unset, with a message linking to the IndexTTS install doc.
    """

def is_indextts_installed() -> bool:
    """Quick check used by is_available(): venv exists at one of the probe paths."""
```

```python
# backend/engines/indextts/main.py — sidecar entry point (op contract)
# Op flow expected by parent:
#   1. Sidecar -> parent: {"op":"ready","engine":"indextts2","sample_rate":24000}
#      (model NOT loaded yet — lazy on first synthesize per Pitfall 8)
#   2. Optional: parent -> sidecar: {"op":"ping"} -> {"op":"pong"}
#   3. Parent -> sidecar: {"op":"synthesize","text":"...","ref_audio":"/path","emotion":...,"duration":...}
#      Sidecar emits one or more {"op":"progress","stage":"loading_model","percent":N} during cold load
#      Then: {"op":"audio","audio_pcm_b64":<b64 int16 PCM>,"sample_rate":24000}
#   4. Parent -> sidecar: {"op":"shutdown"} -> exit code 0
```
</interfaces>

<existing_state>
- 02-01's `SubprocessBackend` primitive is shipped and tested. This plan inherits the wire protocol (length-prefixed JSON, op allowlist, 64 MB frame cap), the GPU slot acquire-release (Pitfall 7), the atexit cleanup (Pitfall 6), and the env-forwarding contract (D5 — HF_TOKEN/HF_HOME/HF_ENDPOINT/HF_HUB_CACHE).
- The existing `backend/services/tts_backend.py:711-812` IndexTTS2Backend class has:
  - `id = "indextts2"`, `display_name = "IndexTTS2 (emotion control, duration control, zero-shot)"` — preserve these verbatim.
  - `is_available()` at lines 749-780 detects the transformers conflict via try/except around the in-process import; per ENGINE-03 it must be replaced with a "venv exists" check (no in-process import attempt — the entire point is that the parent's transformers v5 cannot coexist with IndexTTS's transformers v4).
  - `generate()` at lines 793-897 currently calls `self._model.infer(...)` after an in-process load — this body is REMOVED entirely. The inherited `SubprocessBackend.generate()` handles dispatch; the sidecar handles model.infer().
  - emotion/duration kwargs (the `EmotionRef`, `tone`, `length`, etc. parameters) need to survive the JSON serialization — they are all primitives or simple dicts.
- `backend/main.py:64-65` already sets `HF_HOME` and `HF_HUB_CACHE` at backend startup. SubprocessBackend's `env=os.environ.copy()` (from 02-01) carries these to the sidecar — no extra wiring needed.
- Phase 1's `token_resolver.py` AUTH-04 patched subprocess launch sites to inject `HF_TOKEN` into the env. Verify in test 4 below that SubprocessBackend benefits from that patch — if `token_resolver.resolve()` returns a token at parent startup and the resolver populates `os.environ["HF_TOKEN"]`, the sidecar inherits it. If the resolver does NOT populate os.environ (it may return ResolvedToken without setting env), this plan's bootstrap must wrap the spawn to set `env["HF_TOKEN"] = resolved.token` explicitly — confirm by reading Plan 01-01's actual implementation during Task 1.
- Bundled `uv` is at the path returned by `frontend/src-tauri/src/tools.rs::find_bundled_uv`; the Python side discovers it via `OMNIVOICE_BUNDLED_UV` env var set by Tauri at backend launch, OR falls back to `shutil.which("uv")` for development mode. Confirm the env-var name by reading `lib.rs` / `tools.rs` during Task 2.
- `engines/sonitranslate/.venv` is the existing precedent for the `engines/<id>/.venv` convention. DO NOT modify `services/sonitranslate.py` (D1).
- Phase 0's regression fixture lives at `omnivoice_data/` per ROADMAP.md GATE-01. Whether it includes IndexTTS-2 model weights is unknown — likely NOT (6 GB is too large to check in). The backward-compat test mocks the HF cache by setting `HF_HOME` to a temp directory pre-populated with a marker file (per RESEARCH.md Pitfall 4 / Open Question #1).
</existing_state>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: IndexTTS sidecar entry point + bootstrap venv probe</name>
  <files>backend/engines/indextts/__init__.py, backend/engines/indextts/main.py, backend/engines/indextts/bootstrap.py, tests/backend/services/test_indextts_backward_compat.py</files>
  <behavior>
    `tests/backend/services/test_indextts_backward_compat.py`:
    - `test_venv_probe_prefers_omnivoice_indextts_dir`: monkeypatch `OMNIVOICE_INDEXTTS_DIR` to a tmp directory; pre-create `{dir}/.venv/bin/python` (or Scripts/python.exe on Windows) as a real symlink to `sys.executable`; pre-create a stub `indextts` package importable from that venv → call `resolve_indextts_venv()` → returns the OMNIVOICE_INDEXTTS_DIR/.venv/bin/python path.
    - `test_venv_probe_falls_back_to_engines_path`: OMNIVOICE_INDEXTTS_DIR unset; pre-create `backend/engines/indextts/.venv/bin/python` symlinked to sys.executable with a stub indextts → resolver returns the engines/.venv path.
    - `test_venv_probe_bootstraps_when_neither_exists`: monkeypatch both probe paths to be absent; monkeypatch `subprocess.run` to capture the `uv venv` and `uv pip install` calls → resolver invokes uv venv at `engines/indextts/.venv` and uv pip install -e at `${OMNIVOICE_INDEXTTS_DIR}` (or raises if OMNIVOICE_INDEXTTS_DIR unset).
    - `test_venv_probe_raises_clear_error_when_no_install_possible`: both probe paths absent AND OMNIVOICE_INDEXTTS_DIR unset → `RuntimeError` whose message contains both "OMNIVOICE_INDEXTTS_DIR" and a docs link (e.g. `docs/engines/indextts.md` — even if that file is Phase 6's deliverable, the link string is in the error).
    - `test_is_indextts_installed_no_spawn`: when the venv exists at a probe path, `is_indextts_installed()` returns True WITHOUT spawning the sidecar Python (verify via process-count comparison before/after).
    - `test_hf_home_marker_present_after_bootstrap`: pre-populate `${HF_HOME}/hub/models--IndexTeam--IndexTTS-2/MARKER` with a known string → call `is_indextts_installed()` then `resolve_indextts_venv()` → the marker file is untouched after both calls (NO re-download, NO HF cache mutation — ENGINE-07).
  </behavior>
  <action>
    Step 1 — Create `backend/engines/indextts/__init__.py` (empty) and `backend/engines/indextts/main.py`:
      - Module docstring: "IndexTTS-2 sidecar entry point. Runs inside engines/indextts/.venv with transformers<5, isolated from the OmniVoice parent process which pins transformers>=5.3. Closes issue #42."
      - Forbid imports from `backend.services` or any parent-package code — the sidecar runs under a different venv where backend imports may not resolve. Use stdlib + the indextts library only.
      - Implement `send(obj)` / `recv()` using stdlib (struct + json + sys.stdin.buffer/sys.stdout.buffer). DO NOT reuse SubprocessBackend's helpers — sidecar must be standalone-runnable.
      - `main()`:
        1. Try to import indextts. On failure, emit `{op:"error","stage":"import","message":...,"traceback":...}` and exit 1. (This is the path that surfaces the transformers conflict if the venv is misconfigured.)
        2. Emit `{op:"ready","engine":"indextts2","sample_rate":24000}` BEFORE model load (Pitfall 8 — ready is the spawn handshake, model loads lazily on first synthesize).
        3. Enter stdin-frame loop. Dispatch:
           - `ping` → `{op:"pong"}`
           - `synthesize`:
             - First call: emit progress frames at `loading_model` stage 0%, 50%, 100% while constructing IndexTTS2 from `os.environ["OMNIVOICE_INDEXTTS_DIR"]/checkpoints/config.yaml`. Cache the model in a module-level variable.
             - Run `model.infer(spk_audio_prompt=msg.get("ref_audio"), text=msg["text"], output_path=tmp_wav, verbose=False, **{k:v for k,v in msg.items() if k in EMOTION_KWARGS_ALLOWLIST})`. Emotion kwargs allowlist matches the kwargs the old in-process IndexTTS2Backend.generate accepted at tts_backend.py:793-897.
             - Read tmp_wav via torchaudio.load, downmix to mono if multi-channel, encode int16 PCM bytes + base64.
             - Emit `{op:"audio","audio_pcm_b64":...,"sample_rate":int(sr)}`.
             - Unlink tmp_wav.
           - `shutdown` → break loop, return 0.
           - Other ops → `{op:"error","stage":"dispatch","message":"unknown op: {op}"}`.
        4. On any uncaught exception inside the dispatch loop, emit `{op:"error","stage":<current_op>,"message":...,"traceback":...}` and CONTINUE the loop (the sidecar should survive a single bad call). If the model itself is corrupted (load failed catastrophically), exit 1 on the load failure.

    Step 2 — Create `backend/engines/indextts/bootstrap.py`:
      - `INDEXTTS_SIDECAR_SCRIPT: Path` — module-level constant computed once via `Path(__file__).parent / "main.py"`.
      - `def _venv_python_path(venv_dir: Path) -> Path`: returns `venv_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")`.
      - `def _venv_can_import_indextts(python_path: Path) -> bool`:
        - Runs `subprocess.run([str(python_path), "-c", "import indextts.infer_v2"], capture_output=True, timeout=10)` and returns `proc.returncode == 0`. Bounded timeout — never hangs.
      - `def resolve_indextts_venv() -> Path`:
        - Probe 1: `omv_dir = os.environ.get("OMNIVOICE_INDEXTTS_DIR")`; if set, check `{omv_dir}/.venv/bin/python` (or Scripts/python.exe) — if exists AND `_venv_can_import_indextts` returns True, return that path.
        - Probe 2: `engines_venv = Path(__file__).parent / ".venv"`; if exists AND can import, return its python path.
        - Probe 3: Bootstrap. If `OMNIVOICE_INDEXTTS_DIR` unset, raise `RuntimeError("IndexTTS not installed: set OMNIVOICE_INDEXTTS_DIR or follow docs/engines/indextts.md")`. Else:
          - Locate uv: `os.environ.get("OMNIVOICE_BUNDLED_UV")` first, then `shutil.which("uv")`. If neither available, raise `RuntimeError("uv not available — required to bootstrap IndexTTS venv")`.
          - Run `subprocess.run([uv, "venv", str(engines_venv)], check=True, timeout=120)`.
          - Run `subprocess.run([uv, "pip", "install", "--python", str(_venv_python_path(engines_venv)), "-e", str(omv_dir)], check=True, timeout=900)`. This is the long step (cold install).
          - Verify with `_venv_can_import_indextts`; on failure raise RuntimeError with the install command's stderr captured.
          - Return the new venv's python path.
      - `def is_indextts_installed() -> bool`:
        - Returns True if either Probe 1 OR Probe 2 path has a Python executable present (file existence only — no import probe; the import probe runs at resolve time, not at every is_available() call which fires on every Settings page render).
      - Cache the resolved path in a module-level variable; clear with `invalidate()` for tests.

    Step 3 — Write `tests/backend/services/test_indextts_backward_compat.py` per `<behavior>`. Use `pytest`'s `monkeypatch` and `tmp_path` heavily. For the `_venv_can_import_indextts` probe, in tests, the stub indextts package can be as small as `mkdir -p {tmpdir}/site-packages/indextts && touch {tmpdir}/site-packages/indextts/__init__.py && touch {tmpdir}/site-packages/indextts/infer_v2.py` — the import only needs to succeed at `import indextts.infer_v2`, the test doesn't care about the contents.
  </action>
  <verify>
    <automated>uv run pytest tests/backend/services/test_indextts_backward_compat.py -x -v --timeout=120</automated>
  </verify>
  <done>
    All 6 tests in `test_indextts_backward_compat.py` pass. `backend/engines/indextts/main.py` exists and is runnable standalone (`python backend/engines/indextts/main.py` exits gracefully on stdin EOF with code 1, since indextts isn't installed in the parent venv — that's expected behavior; the error frame to stdout is the signal). `backend/engines/indextts/bootstrap.py` exports `resolve_indextts_venv`, `is_indextts_installed`, and `INDEXTTS_SIDECAR_SCRIPT`.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Rewire IndexTTS2Backend onto SubprocessBackend + coexistence integration test</name>
  <files>backend/services/tts_backend.py, tests/backend/services/test_indextts_sidecar.py</files>
  <behavior>
    `tests/backend/services/test_indextts_sidecar.py`:
    - `test_indextts2backend_is_subprocess_subclass`: `issubclass(IndexTTS2Backend, SubprocessBackend)` is True. The class has `venv_python`, `sidecar_script`, `is_available` — and no `_model` attribute (the old in-process state is gone).
    - `test_is_available_no_spawn`: monkeypatch `is_indextts_installed` to return True → `IndexTTS2Backend.is_available()` returns `(True, "ok")` WITHOUT spawning any subprocess (verify via psutil child-process count before/after).
    - `test_is_available_no_venv`: monkeypatch `is_indextts_installed` to return False → `is_available()` returns `(False, msg)` where msg references `OMNIVOICE_INDEXTTS_DIR` or `docs/engines/indextts.md`.
    - `test_list_backends_includes_indextts_with_subprocess_isolation_mode`: call `tts_backend.list_backends()` → IndexTTS2 entry has `isolation_mode == "subprocess"` (verifies the 02-01 list_backends wrap correctly reports the class hierarchy).
    - `test_synthesize_via_mocked_sidecar`: monkeypatch `IndexTTS2Backend.venv_python` to return `Path(sys.executable)` and `sidecar_script` to return a path to a MINIMAL test-only sidecar that pretends to be indextts (loads no real model — emits `ready` then on synthesize emits 1 s of 0.5-amplitude sine wave as int16 PCM b64) → call `backend.generate(text="hello", ref_audio="/tmp/x.wav")` → returns torch.Tensor shape (1, 24000) float32 with `abs(t).max() > 0.3`.
    - `test_coexist_with_omnivoice_in_one_session` (ENGINE-04): in the SAME Python interpreter, instantiate `OmniVoiceBackend` (in-process — actually imports `transformers >= 5.3`) AND call IndexTTS2 via the mocked sidecar above. Both succeed. No `ImportError`, no `AttributeError`, no `OffloadedCache` issue — because IndexTTS runs in a different process. This is the headline #42 closure test.
    - `test_env_forwarding_to_indextts_sidecar`: set `HF_TOKEN=hf_test`, `HF_HOME=/tmp/hf`, `HF_ENDPOINT=https://mirror.example` in the parent env → spawn the mocked sidecar (test-only variant that has a `probe_env` op like the echo sidecar) → all three env vars arrive in the child env (D5 verified for IndexTTS specifically).
  </behavior>
  <action>
    Step 1 — Edit `backend/services/tts_backend.py` lines 711-897 (the IndexTTS2Backend class):
      - DELETE the entire old class body (in-process import attempt, lazy model load, generate body).
      - REPLACE with the new shape per `<interfaces>`:
        ```
        from backend.services.subprocess_backend import SubprocessBackend
        from backend.engines.indextts.bootstrap import (
            resolve_indextts_venv,
            is_indextts_installed,
            INDEXTTS_SIDECAR_SCRIPT,
        )

        class IndexTTS2Backend(SubprocessBackend):
            id = "indextts2"
            display_name = "IndexTTS2 (emotion control, duration control, zero-shot)"

            @classmethod
            def is_available(cls) -> tuple[bool, str]:
                if not is_indextts_installed():
                    return (False, (
                        "IndexTTS-2 venv not found. Set OMNIVOICE_INDEXTTS_DIR to "
                        "your IndexTTS clone and restart OmniVoice (or follow "
                        "docs/engines/indextts.md)."
                    ))
                if not INDEXTTS_SIDECAR_SCRIPT.exists():
                    return (False, "IndexTTS sidecar script missing — reinstall OmniVoice.")
                return (True, "ok")

            @classmethod
            def venv_python(cls) -> Path:
                return resolve_indextts_venv()

            @classmethod
            def sidecar_script(cls) -> Path:
                return INDEXTTS_SIDECAR_SCRIPT
        ```
      - Preserve the old class's docstring (the long help string about install instructions) by attaching it to the new class — users grepping for "transformers<5" should still find a comment explaining the choice. Update the docstring's "Use uv pip install -e ." line to "Set OMNIVOICE_INDEXTTS_DIR; OmniVoice will create engines/indextts/.venv lazily."

    Step 2 — Verify `_INSTALL_HINTS` dict still contains an entry for `"indextts2"` (or add one). The hint should point at `docs/engines/indextts.md`.

    Step 3 — Verify the import at the top of `tts_backend.py`:
      - `from backend.services.subprocess_backend import SubprocessBackend` — this was added in 02-01 Task 2 (the list_backends wrap needed it). Confirm the import is at the TOP of the file (module level), not lazy inside `list_backends`. If 02-01 left it as lazy-only-inside-list_backends, lift it to module level here so `class IndexTTS2Backend(SubprocessBackend)` can be defined. Resolution to circular-import risk: SubprocessBackend imports `from backend.services.tts_backend import TTSBackend` and we import `SubprocessBackend` here — this is a real cycle. Break it by reorganizing: SubprocessBackend imports TTSBackend lazily inside its method bodies (it only needs the TTSBackend type for `TTSBackend.__subclasshook__` purposes and inheritance); IndexTTS2Backend imports SubprocessBackend at module load. Alternative: move the `TTSBackend` base class into a separate module (`backend/services/tts_backend_base.py`) — bigger refactor, defer if avoidable. Pick the minimal lazy-import resolution.

    Step 4 — Write `tests/backend/services/test_indextts_sidecar.py`:
      - For tests that need a working sidecar without the real indextts model, create a fixture `mock_indextts_sidecar.py` under `tests/fixtures/` that mimics the IndexTTS protocol — emits `ready`, accepts `synthesize` and returns a synthetic 1 s sine wave, accepts `shutdown` and exits cleanly. Then monkeypatch `IndexTTS2Backend.sidecar_script` (classmethod) via `monkeypatch.setattr(IndexTTS2Backend, "sidecar_script", classmethod(lambda cls: Path("tests/fixtures/mock_indextts_sidecar.py")))`.
      - For `test_coexist_with_omnivoice_in_one_session`: import `OmniVoiceBackend` (it lives in `tts_backend.py:93-167` — does NOT touch IndexTTS). Call its `is_available()` and confirm True. Then instantiate IndexTTS2Backend (which uses the mock sidecar) and call generate(). Assert both succeeded in the same test function. This is the headline test — if it passes, ENGINE-04 closes.

    Step 5 — Manual smoke (not gated): boot the backend with real IndexTTS installed and `OMNIVOICE_INDEXTTS_DIR` set. Generate one IndexTTS sample via the existing `/api/tts/generate` endpoint. Verify the generated WAV decodes (depends on 02-02's `_safe_torchaudio_save` being merged; if 02-02 hasn't merged, the sidecar's int16 PCM output still produces a valid in-memory tensor for the parent — the WAV-write step downstream is the 02-02 concern). Document in SUMMARY whether IndexTTS audio ultimately flows through 02-02's helper at the parent's write boundary.
  </action>
  <verify>
    <automated>uv run pytest tests/backend/services/test_indextts_sidecar.py -x -v --timeout=60</automated>
  </verify>
  <done>
    All 7 tests in `test_indextts_sidecar.py` pass. `IndexTTS2Backend` is now a `SubprocessBackend` subclass and the old in-process model loading code is removed from `tts_backend.py` (~80 LOC deleted). `grep -n "self\\._model" backend/services/tts_backend.py` returns zero matches inside the `IndexTTS2Backend` class. The headline `test_coexist_with_omnivoice_in_one_session` test passes — proving ENGINE-04 / issue #42 is closed at the integration level.
  </done>
</task>

</tasks>

<verification>
  After both tasks:
  - `uv run pytest tests/backend/services/test_indextts_sidecar.py tests/backend/services/test_indextts_backward_compat.py -x --timeout=120` → all green
  - `grep -n "from backend.services.subprocess_backend import SubprocessBackend" backend/services/tts_backend.py` → at least 1 line (the import landed at module level)
  - `grep -n "class IndexTTS2Backend(SubprocessBackend)" backend/services/tts_backend.py` → exactly 1 line (single class declaration with new base)
  - `grep -nE "from indextts\\." backend/services/tts_backend.py` → 0 lines (in-process import was removed; the only place that imports indextts is now the sidecar entry point)
  - `grep -nE "from indextts\\." backend/engines/indextts/main.py` → at least 1 line (sidecar imports indextts in its own venv)
  - End-to-end smoke (manual, not gated): with real IndexTTS installed locally, boot the backend → call `/engines` → IndexTTS2 entry has `available=true, isolation_mode="subprocess"` → call generate via `/api/tts/generate` → returns audio. `psutil` shows `engines/indextts/.venv/bin/python` is alive after generate AND is gone within 5 s of backend shutdown.
  - `git diff backend/services/sonitranslate.py` is empty (D1 locked decision honored — SoniTranslate refactor deferred to v0.4)
  - `git diff backend/services/gpu_sandbox.py` is empty (D4 locked decision — gpu_sandbox.py is the multiprocessing.Pipe reference and is NOT modified by Phase 2)
</verification>

<success_criteria>
1. ENGINE-03 closed: issue #42 has a real fix, not a graceful-degradation wrap. IndexTTS runs in its own venv with `transformers<5` while OmniVoice parent uses `transformers>=5.3`. The two cannot collide because they live in different OS processes.
2. ENGINE-04 closed: `test_coexist_with_omnivoice_in_one_session` proves the in-process OmniVoiceBackend and the subprocess IndexTTS2Backend can both serve `generate()` from the same Python session — no module-clash exception.
3. ENGINE-02 closed: the bootstrap probe inherits HF_HOME from the parent env (via SubprocessBackend's `env=os.environ.copy()` from 02-01) and reuses existing cached weights at `$HF_HOME/hub/models--IndexTeam--IndexTTS-2/`. The cache-marker test (`test_hf_home_marker_present_after_bootstrap`) proves no re-download occurs.
4. ENGINE-07 closed: existing user upgrade path is transparent. The venv-probe prefers `${OMNIVOICE_INDEXTTS_DIR}/.venv` first; only bootstraps `engines/indextts/.venv` if no existing one is found. `uv pip install -e ${OMNIVOICE_INDEXTTS_DIR}` reuses the user's clone — no re-clone, no re-download.
5. D1 honored: SoniTranslate untouched. D4 honored: gpu_sandbox.py untouched. D5 verified: HF_TOKEN/HF_HOME/HF_ENDPOINT/HF_HUB_CACHE all reach the IndexTTS sidecar env.
6. Zero new Python dependencies in the parent venv. The sidecar's transformers<5 dependency lives inside the IndexTTS clone's own pyproject.toml — managed by uv pip install -e — not OmniVoice's.
7. Cross-platform parity preserved: the bootstrap probe handles both Unix `bin/python` and Windows `Scripts/python.exe` layouts. CI matrix green on all three OSes.
</success_criteria>

<output>
Create `.planning/phases/02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi/02-03-SUMMARY.md` when done. Include:
- Exact LOC count of the new IndexTTS2Backend class (target: ≤30 LOC for the class body, excluding docstring).
- Whether the lazy-import resolution at SubprocessBackend↔TTSBackend module boundary was needed (yes/no), and if yes, where the lazy import landed.
- Path probed by `resolve_indextts_venv` in development vs production — does the bundled uv path differ?
- Confirmation that `tests/fixtures/mock_indextts_sidecar.py` exists as test infrastructure and matches the IndexTTS op contract.
- Any deviation from the RESEARCH.md sidecar entry-point skeleton (extra ops added, kwargs renamed, etc.) so the Phase 3 Supertonic-3 author can pattern-match.
</output>
</content>
</invoke>