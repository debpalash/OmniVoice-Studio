# Phase 2: Engine Isolation (SubprocessBackend → IndexTTS + WAV-export dubbing fix) — Research

**Researched:** 2026-05-18
**Domain:** Per-engine process isolation, Python multiprocessing on Apple Silicon, WAV serialization correctness, sidecar lifecycle
**Confidence:** HIGH on subprocess primitive + WAV-fix dimensions; MEDIUM on the MPS-spawn quirk (mitigated by an empirical first-launch probe rather than a documentation claim).

---

## Summary

Phase 2 builds the durable architectural primitive Phases 3 and 4 plug into: `backend/services/subprocess_backend.py`, a `~150 LOC` base class that runs an engine in its own dedicated venv as a long-lived sidecar process, communicates over a length-prefixed JSON-over-stdio channel, and marshals audio as int16 PCM bytes (not pickled tensors). Two existing patterns in-tree are the source material — `backend/services/gpu_sandbox.py` (proves `multiprocessing` works against engine code on this codebase, but is fork-once-per-call and same-venv) and `backend/services/sonitranslate.py:130-182` (proves long-lived `subprocess.Popen` + dedicated `engines/<id>/.venv` lifecycle works, but speaks Gradio HTTP, not OmniVoice's TTSBackend ABC). `SubprocessBackend` lifts the lifecycle half of SoniTranslate into a base class and gives it a `TTSBackend`-shaped surface so SoniTranslate, IndexTTS, Supertonic-3 (Phase 3), and GGUF/Singing (Phase 4) all inherit one tested implementation.

The keystone unlock is **#42**: IndexTTS pins `transformers<5`; OmniVoice pins `transformers>=5.3` for `HiggsAudioV2TokenizerModel`. Both transformers versions cannot coexist in one Python process — it's an `ImportError: cannot import name 'OffloadedCache' from 'transformers.cache_utils'`. The error materializes at *import time* of `indextts.infer_v2`, which means the current `is_available()` wrap in `tts_backend.py:749-780` only sees the conflict if it's run *after* OmniVoice's `transformers>=5.3` is loaded — i.e. it surfaces the right diagnostic, but no in-process fix exists. Per-engine venv is the **only** correct fix; nothing else (sys.path shims, lazy import, importlib reload) survives `transformers` v4↔v5's incompatible C extension boundary. [VERIFIED: gh issue #42 body + the canonical `from transformers.cache_utils import OffloadedCache` traceback].

**Primary recommendation — single-track Day-1 POC then 4 deliverable waves:**

- **Day 1 (POC, not a wave):** Ship `subprocess_backend.py` + `engines/_echo/main.py` echo sidecar + 1 round-trip test. The echo sidecar accepts `{"text": "..."}` and returns 1 second of int16 silence; the test asserts spawn → ready → generate → exit cleanly. ~150 LOC code + ~80 LOC test. Proves IPC + lifecycle + slop-detection before anything real ships.
- **Wave 1 (ENGINE-01, ENGINE-05, BUG-01):** Land `SubprocessBackend` for real, wire `is_available()` graceful-degradation wrap (ENGINE-05 — table-stakes; one engine's broken state cannot take down the registry), and fix WAV-export #48 with a `_safe_torchaudio_save()` helper at all 7 known write sites + `soundfile.info()` post-write validation in a new regression test. BUG-01 ships in parallel because it shares the `tests/test_audio_io.py` infrastructure and is too small to wave on its own.
- **Wave 2 (ENGINE-02, ENGINE-03, ENGINE-04, ENGINE-07):** Migrate IndexTTS. `engines/indextts/.venv` bootstrap (reuses `tools.rs:find_bundled_uv`), `engines/indextts/main.py` sidecar entry point (~120 LOC: load model on `ready`, generate on `synthesize`, JSON-stdio loop), `IndexTTS2Backend` becomes a thin `SubprocessBackend` subclass. Backward-compat probe: if an existing user has `OMNIVOICE_INDEXTTS_DIR` set and `checkpoints/` exists, reuse the venv at `${OMNIVOICE_INDEXTTS_DIR}/.venv` if present, else create `engines/indextts/.venv` and `pip install -e ${OMNIVOICE_INDEXTTS_DIR}` (no model re-download — `HF_HOME` is propagated to the child env).
- **Wave 3 (ENGINE-06, INST-13):** Frontend Engine Compatibility Matrix UI (install state + GPU compat + isolation mode + last error). INST-13 (dictation-widget Settings checkbox — backend already shipped in Phase 0) lands alongside because it touches the same Settings panel and would otherwise be a stranded half-requirement.
- **Wave 4 (defer SoniTranslate refactor):** **DO NOT refactor SoniTranslate into `SubprocessBackend` in this phase.** SoniTranslate speaks Gradio, not the TTSBackend ABC. Forcing it through `SubprocessBackend` would invent a Gradio-shaped subclass for one consumer. Track in a v0.4 cleanup; v0.3.0 priority is closing #42 and #48, not refactoring a path that already works.

---

## User Constraints (from CONTEXT.md)

> No CONTEXT.md was produced from `/gsd:discuss-phase` for Phase 2. Treat the following as effective constraints, sourced from CLAUDE.md, ROADMAP.md Phase 2 success criteria, REQUIREMENTS.md ENGINE-01..07/BUG-01, and the Architect/Critic council notes in the research brief.

### Locked Decisions

1. **Build `SubprocessBackend` primitive in `backend/services/subprocess_backend.py`.** Not `backend/engines/_subprocess.py` despite REQUIREMENTS.md ENGINE-01's parenthetical — research brief specifies the `services/` path. Reason: it's a service primitive, not an engine; engines under `backend/engines/<id>/` import *from* it.
2. **IndexTTS is the first migrant.** Closes #42 with a real fix, not a graceful-degradation wrap (ENGINE-03).
3. **Per-engine venv at `engines/<id>/.venv`.** Same convention as `engines/sonitranslate/.venv` already in-tree. `uv venv` + `uv pip install -e <engine_repo>` — no `uv sync --all-extras` (the latter is the root cause of #42 per the issue body).
4. **`HF_HOME` propagation is mandatory** (ENGINE-02, ENGINE-07). Existing IndexTTS users with `~/.cache/huggingface/hub/IndexTeam/IndexTTS-2/` MUST NOT re-download. Child process inherits parent env via `subprocess.Popen(env=os.environ.copy())` — already the pattern in `sonitranslate.py:142-145`.
5. **One engine's broken state cannot prevent app boot** (ENGINE-05). Wrap every `is_available()` call in a try/except that returns `(False, last_error)` on raise — already partially done in `tts_backend.py:773-780` for IndexTTS specifically; generalize.
6. **No new Python runtime dependency.** All Phase 2 work uses stdlib (`multiprocessing`, `subprocess`, `json`, `struct`), existing transitive `soundfile`, and existing `torch`/`torchaudio`. New dep would violate CLAUDE.md "Installation" — *No new Python dependencies needed for Capabilities 1, 2, 3, 5*.
7. **Cross-platform parity is non-negotiable** (CLAUDE.md "Constraints"). The subprocess primitive must work on macOS (Apple Silicon + Intel), Windows x64, Linux. Implication: `mp.get_context("spawn")` semantics, not fork-only.
8. **Existing engine compatibility** (CLAUDE.md "Constraints"). Users with already-installed IndexTTS must NOT have to reinstall. Honor `OMNIVOICE_INDEXTTS_DIR` if set; create our managed venv only if no existing one is detected.
9. **`is_available()` keeps its `(bool, str)` shape.** Adding `last_error` is implemented by recording the most-recent reason in a module-level dict, not by changing the ABC signature (which would ripple through 9 backends).

### Claude's Discretion

- IPC choice: JSON-over-stdio vs HTTP-loopback vs `multiprocessing.Pipe`. **Recommendation:** JSON-over-stdio with length prefix. Reasoning: zero ports to fight on, no firewall/AV interaction (Windows pain), no Gradio install required (SoniTranslate's HTTP path costs ~15 GB of deps for what's an RPC primitive). HTTP makes sense only when the engine *ships* an HTTP server (SoniTranslate, GPT-SoVITS); for engines we wrap from a Python package (IndexTTS, Supertonic-3, future), stdio is leaner and Windows-safe.
- Tensor marshaling: PCM int16 bytes vs pickled tensors vs raw float32 bytes. **Recommendation:** int16 PCM bytes + sample-rate header. Halves the wire size vs float32, sidesteps pickle's cross-venv version-compat hazard (parent has torch 2.x; sidecar may have a different torch), trivially convertible to torch at the parent. Lossy at -96 dB; for TTS output destined for WAV-at-16-bit anyway, indistinguishable.
- Sidecar discovery convention: `engines/<id>/.venv/bin/python` (Unix) / `engines/<id>/.venv/Scripts/python.exe` (Windows). Resolver helper at `subprocess_backend.py::_resolve_engine_python(engine_id)`.
- Health-check protocol: parent sends `{"op": "ping"}`, sidecar replies `{"ok": true, "version": "..."}`. Used for `SubprocessBackend.health_check()` (idempotent, called by the registry + the Compatibility Matrix UI).
- VRAM coordination strategy: **share `_gpu_pool` semaphore via a tokenized slot grant**, not a separate queue. When a SubprocessBackend wants to run, it acquires one slot from the existing `_gpu_pool` (model_manager.py:46). The slot count is unchanged (`clamp(1, free_GB//2.5, 4)`); the sidecar holds the slot while its child generates and releases on response. The slot is NOT released for the sidecar's idle/load period — only for the actual GPU-busy window — measured via a `{"op": "gpu_acquire"}` round-trip from sidecar to parent immediately before the model.forward() call. Effort cost: ~20 LOC in the base class.
- Echo sidecar at `backend/engines/_echo/main.py` is permanent test-infra, not throwaway. Lives forever as the regression-fixture engine the CI smoke test exercises.

### Deferred Ideas (OUT OF SCOPE for Phase 2)

- SoniTranslate refactor into `SubprocessBackend`. Track for v0.4. SoniTranslate already works; lifting it in this phase risks regression on a path users rely on for video dubbing.
- Migrating any engine other than IndexTTS to subprocess isolation. Per CLAUDE.md "Out of Scope" — *Full subprocess migration for all engines | Risk-bounded to IndexTTS this milestone; other engines stay in-process pending evidence of clashes*.
- Bundled IndexTTS installer (auto-clone + auto-install). User still runs `git clone index-tts/index-tts && uv pip install -e .` manually; OmniVoice creates `engines/indextts/.venv` only on user opt-in or detects an existing install. Auto-install is a Phase 3 / Phase 4 conversation, not this phase.
- Restartable sidecar / health-recovery loop. If the sidecar dies, surface "engine crashed — restart from Settings → Engines" in the UI. No auto-respawn — auto-respawn can mask an actual crash loop.
- Sidecar logging aggregation (multiplex sidecar stderr into the main backend log). Each sidecar writes its own log under `omnivoice_data/logs/engines/<id>.log`; main backend log captures the parent-side `[indextts] sidecar exited code=1` only. Aggregation deferred to v0.4.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ENGINE-01 | `backend/services/subprocess_backend.py` implements per-engine subprocess + dedicated venv with `mp.get_context("spawn")` IPC; verified on macOS Apple Silicon | Section: SubprocessBackend Primitive Design + Section: MPS / spawn quirk |
| ENGINE-02 | Per-engine venv bootstrap reuses `gpu_sandbox.py` patterns and inherits `HF_HOME` | Section: SubprocessBackend Primitive Design + Section: IndexTTS Sidecar Migration |
| ENGINE-03 | IndexTTS migrated to `SubprocessBackend` — closes #42 real fix | Section: IndexTTS Sidecar Migration |
| ENGINE-04 | Regression test loads IndexTTS + at least one in-process engine, runs a generation on each, asserts no AttributeError | Section: IndexTTS Sidecar Migration + Section: Validation Architecture |
| ENGINE-05 | `TTSBackend.is_available()` wrapped — one broken engine can't block boot | Section: Engine Registry Shape |
| ENGINE-06 | Frontend Engine Compatibility Matrix UI | Section: Engine Registry Shape (data shape only — UI is in plan) |
| ENGINE-07 | Existing IndexTTS users don't reinstall | Section: IndexTTS Sidecar Migration — Backward-Compat |
| BUG-01 | WAV-export corruption fixed and regression-tested | Section: WAV-Export #48 Fix |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Subprocess lifecycle (spawn/health/shutdown) | Backend service (`subprocess_backend.py`) | — | Pure Python orchestration; no UI logic. Mirrors the lifecycle half of `sonitranslate.py`. |
| Per-engine venv bootstrap | Backend service + bundled `uv` (via `tools.rs::find_bundled_uv`) | — | Uses existing `uv` sidecar discovery; no new Rust code. |
| IPC marshaling (text/kwargs in, audio out) | Backend service + sidecar entry point | — | JSON-over-stdio, length-prefixed; pure stdlib both sides. |
| Engine sidecar entry point (`engines/<id>/main.py`) | Engine package (per-engine) | Backend service (provides protocol) | One file per engine. Loads model on `ready`; loops on stdin. |
| VRAM slot coordination | Backend service (extend `model_manager._gpu_pool`) | Engine sidecar (requests slot at generate-time) | Single source of truth for slot count; sidecar requests via stdio. |
| Engine registry status (last error) | Backend service (`tts_backend.list_backends()` extension) | Frontend (Compat Matrix UI) | Module-level dict caches last reason; UI reads via `/engines/list` endpoint. |
| `is_available()` graceful-degradation wrap | Backend service (in `tts_backend.list_backends()`) | — | One try/except inside the loop; never raises out. |
| WAV-export safety helper | Backend service (`audio_io.py` new module) | — | `_safe_torchaudio_save(path, tensor, sr)` — handles dtype/contiguity/range/validation. |
| Soundfile post-write validation (regression test) | Test suite (`tests/test_audio_io.py`) | — | Asserts `sf.info()` returns sane values after every write. |
| Sidecar SIGTERM on app exit | Backend (process group) + Tauri (`lib.rs::ExitRequested`) | — | Tauri already SIGTERMs the backend; the backend's atexit hook SIGTERMs its sidecars. |
| Engine Compatibility Matrix UI | Frontend (React Settings panel) | Backend (existing `/engines/list` route) | Data already shaped at backend; UI only consumes. |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `multiprocessing` (stdlib) | Py 3.11+ | `get_context("spawn")` ContextManager; consistent start method cross-platform | spawn is the default on macOS since Py 3.8 and on Windows always; using `get_context("spawn")` explicitly on Linux too gives one code path for all platforms. [VERIFIED: docs.python.org/3/library/multiprocessing.html#contexts-and-start-methods] [CITED: https://docs.python.org/3/library/multiprocessing.html] |
| `subprocess` (stdlib) | Py 3.11+ | `Popen(..., env=...)` for long-lived sidecars with HF_HOME inheritance | Already the pattern in `sonitranslate.py:148`. No new dep. |
| `json` (stdlib) | Py 3.11+ | IPC envelope serialization (`{"op": "synthesize", "text": "...", "sample_rate": 24000}`) | Cross-venv safe (unlike pickle), human-debuggable in logs, supported by every Python version we'll ship into. |
| `struct` (stdlib) | Py 3.11+ | 4-byte length-prefix for stdio frames | Avoids the "did the sidecar buffer flush?" newline-delimited-JSON hazard. `pack("!I", len(payload))` + `payload`. |
| `soundfile` | ≥0.12.x (already transitive via dub_core path) [VERIFIED: backend/api/routers/dub_core.py:438 uses `sf.write`] | `sf.info(path)` post-write validation in regression tests | Canonical libsndfile binding for Python; already imported in dub_core. [CITED: https://python-soundfile.readthedocs.io/en/0.13.1/] |
| `torch` / `torchaudio` | already pinned | Tensor → int16 PCM conversion at the IPC boundary | Already the project's audio runtime. `tensor.clamp(-1,1).mul(32767).to(torch.int16).contiguous().cpu().numpy().tobytes()` is the canonical recipe. |
| Bundled `uv` sidecar | Already shipped (CLAUDE.md Capability 3) | Per-engine `uv venv` + `uv pip install -e` | Tauri-resolved via `tools.rs::find_bundled_uv` already in-tree. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pytest` + `pytest-asyncio` | already pinned | All Phase 2 unit + integration tests | Required by Phase 0 CI gate. |
| `pytest-timeout` | already pinned [VERIFIED: in dev-dependencies — confirm in lockfile] | Hard-cap sidecar spawn tests at 30s | Avoids CI hangs if sidecar startup wedges. |
| `psutil` (already runtime dep via Capability 2 plan) | already pinned | Verify child PID dead after parent SIGTERM in tests | Already approved; no new dep. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| JSON-over-stdio | HTTP loopback (Gradio-style, like SoniTranslate) | HTTP costs: bind a port (collision risk), enable a server (Windows Firewall prompts), one more package (`uvicorn` or `aiohttp`) in every sidecar venv. Only worth it when the engine *ships* an HTTP server. |
| JSON-over-stdio | `multiprocessing.Pipe` + pickled tensors (like `gpu_sandbox.py`) | Pickled tensors require torch version-compat across venvs. We can't guarantee IndexTTS's pinned torch matches OmniVoice's. Pickle would silently break at the version boundary. |
| Length-prefixed framing | Newline-delimited JSON | Newline-delimited JSON loses to flush-buffer races on Windows; length prefix is foolproof. Cost: 4 bytes per frame. |
| `subprocess.Popen` (current `sonitranslate.py`) | `multiprocessing.Process` (current `gpu_sandbox.py`) | `Popen` is the right primitive when the child runs in a *different* Python interpreter (different venv = different sys.path). `multiprocessing.Process` only works when the child shares the parent's interpreter binary. Phase 2 needs `Popen`. |
| Migrate SoniTranslate into `SubprocessBackend` now | Defer to v0.4 | SoniTranslate's HTTP/Gradio interface doesn't map to TTSBackend's `(text, ref_audio) -> tensor`. Forcing the fit invents a Gradio-shaped subclass for one consumer. Not the right time. |
| Restartable / auto-respawn sidecar | Manual restart only | Auto-respawn masks a crash loop. v0.3 is a stabilization milestone — surface failures, don't paper over them. |

**Installation:** No new Python dependencies. All Phase 2 work uses stdlib + existing transitive deps.

**Version verification:**
```bash
uv pip list | grep -iE "soundfile|torch|psutil"    # expect already-pinned versions
```

---

## Package Legitimacy Audit

No new external packages are introduced in Phase 2. Stdlib (`multiprocessing`, `subprocess`, `json`, `struct`) is exempt from registry verification. Pre-existing transitive deps (`soundfile`, `torch`, `torchaudio`, `psutil`) were vetted in Phase 1's audit and Phase 0's lockfile gate.

| Package | Registry | Disposition |
|---------|----------|-------------|
| `soundfile` | PyPI — libsndfile binding, 8+ yrs, 50M+ downloads/mo, github.com/bastibe/python-soundfile | Approved (already transitive) |
| `torchaudio` | PyPI — pytorch/audio, official PyTorch sub-project | Approved (already pinned) |
| `psutil` | PyPI — 12+ yrs, 100M+ downloads/mo, giampaolo/psutil | Approved (already pinned via Capability 2) |
| `uv` (bundled binary, not Python pkg) | github.com/astral-sh/uv | Approved (CLAUDE.md Capability 3) |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

---

## Architecture Patterns

### System Architecture Diagram

```
                       ┌──────────────────────────────────────────────┐
                       │              OmniVoice backend (parent)       │
                       │                                              │
                       │  ┌─────────────────────────────────────────┐ │
                       │  │  tts_backend.py — _REGISTRY              │ │
                       │  │  ┌─────────────────────────────────────┐ │ │
                       │  │  │ IndexTTS2Backend (subprocess proxy) │ │ │
                       │  │  │   └→ inherits SubprocessBackend     │ │ │
                       │  │  │      (services/subprocess_backend.py)│ │ │
                       │  │  └─────────────────┬───────────────────┘ │ │
                       │  └────────────────────│─────────────────────┘ │
                       │                       │ JSON-over-stdio        │
                       │                       │ length-prefixed        │
                       │                       │ (4-byte BE u32 + body) │
                       │  ┌────────────────────│─────────────────────┐ │
                       │  │ model_manager._gpu_pool — slot grant     │ │
                       │  │ {"op":"gpu_acquire"} ↔ {"slot":"granted"} │ │
                       │  └──────────────────────────────────────────┘ │
                       └───────────────────────│──────────────────────┘
                                               │
                                               │ Popen(env=os.environ.copy())
                                               │ env carries HF_HOME, HF_TOKEN,
                                               │ OMNIVOICE_INDEXTTS_DIR
                                               ▼
                       ┌──────────────────────────────────────────────┐
                       │  engines/indextts/.venv/bin/python            │
                       │  engines/indextts/main.py (sidecar entry)     │
                       │  ┌─────────────────────────────────────────┐ │
                       │  │  transformers<5 (isolated from parent)   │ │
                       │  │  indextts.infer_v2.IndexTTS2             │ │
                       │  │  loaded once on {"op":"ready"} ack       │ │
                       │  └─────────────────────────────────────────┘ │
                       │  stdin loop:                                  │
                       │    read 4-byte length → read body            │
                       │    dispatch: ping | ready | synthesize | shutdown │
                       │  audio out: int16 PCM bytes + sample_rate    │
                       └──────────────────────────────────────────────┘

                  ─── WAV-export #48 path (independent of subprocess work) ───

  ┌──────────────────────┐    _safe_torchaudio_save     ┌─────────────────────────┐
  │ 7 known write sites: │  ─────────────────────────►  │  audio_io.py             │
  │ generation.py:148,   │  enforces:                   │  - .cpu().contiguous()   │
  │ generation.py:162,   │  - tensor on CPU             │  - float32 in [-1,1]     │
  │ openai_compat.py:155,│  - contiguous memory layout  │  - encoding="PCM_16"     │
  │ openai_compat.py:160,│  - clamp to [-1,1]           │  - bits_per_sample=16    │
  │ batch.py:341,        │  - explicit encoding         │  - post-write sf.info()  │
  │ dub_generate.py:289, │  - matched sample-width      │    sanity check in test  │
  │ dub_generate.py:328, │                              └─────────────────────────┘
  │ dub_generate.py:390, │
  │ dub_generate.py:508, │
  │ dub_core.py:438      │
  └──────────────────────┘
```

### Recommended Project Structure
```
backend/
├── services/
│   ├── subprocess_backend.py   # NEW — SubprocessBackend base class (~150 LOC)
│   ├── audio_io.py             # NEW — _safe_torchaudio_save helper (~40 LOC)
│   ├── tts_backend.py          # MODIFIED — IndexTTS2Backend rewired; is_available wrap
│   ├── model_manager.py        # MODIFIED — _gpu_pool slot-grant protocol
│   └── sonitranslate.py        # UNTOUCHED in Phase 2 (deferred to v0.4)
├── engines/
│   ├── _echo/
│   │   └── main.py             # NEW — echo sidecar for CI regression
│   └── indextts/
│       └── main.py             # NEW — IndexTTS sidecar entry point (~120 LOC)
tests/
├── test_subprocess_backend.py  # NEW — round-trip, spawn-death, sigterm tests
├── test_audio_io.py            # NEW — WAV header validation, dtype/contig tests
└── fixtures/
    └── ref_3s.wav              # frozen reference (Phase 0 fixture, reused)
```

### Pattern 1 — Length-Prefixed JSON Frames Over Stdio

**What:** Each IPC message is `pack("!I", len(body))` followed by `body` = UTF-8-encoded JSON.

**When to use:** All parent↔sidecar communication. NOT for the audio bytes themselves — they go *inside* a frame as a base64-encoded field, because we already have a frame protocol and JSON is the only thing that nests cleanly.

**Example:**
```python
# Source: this codebase, derived from sonitranslate.py:148 + gpu_sandbox.py:106
import struct, json, sys

def send_frame(stream, obj: dict) -> None:
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("!I", len(body)))
    stream.write(body)
    stream.flush()

def recv_frame(stream) -> dict | None:
    header = stream.read(4)
    if len(header) < 4:
        return None                       # EOF — sidecar exited
    (n,) = struct.unpack("!I", header)
    if n > 64 * 1024 * 1024:              # 64 MB hard cap — guards against runaway
        raise IOError(f"frame too large: {n}")
    body = stream.read(n)
    if len(body) < n:
        raise IOError("short read")
    return json.loads(body)
```

### Pattern 2 — int16 PCM Wire Format

**What:** Audio crosses the IPC boundary as int16 little-endian PCM bytes, not pickled tensors.

**Why:** (1) Halves wire size vs float32; (2) sidesteps cross-venv pickle hazards (the sidecar's torch may differ from the parent's); (3) trivially convertible at both ends; (4) the eventual on-disk format is 16-bit WAV anyway.

**Example:**
```python
# In the sidecar (after model inference):
import struct, base64
import torch

def encode_audio(tensor: torch.Tensor, sample_rate: int) -> dict:
    # Expect (1, n) or (n,) float32 in [-1, 1]
    if tensor.ndim == 2:
        tensor = tensor.squeeze(0)
    pcm = (
        tensor.detach().clamp(-1.0, 1.0)
        .mul(32767.0)
        .to(torch.int16)
        .cpu()
        .contiguous()
        .numpy()
        .tobytes()
    )
    return {
        "audio_pcm_b64": base64.b64encode(pcm).decode("ascii"),
        "sample_rate": sample_rate,
        "n_samples": len(pcm) // 2,
    }

# In the parent:
import numpy as np, torch, base64

def decode_audio(msg: dict) -> tuple[torch.Tensor, int]:
    pcm = base64.b64decode(msg["audio_pcm_b64"])
    arr = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return torch.from_numpy(arr).unsqueeze(0), int(msg["sample_rate"])
```

### Pattern 3 — `_safe_torchaudio_save()` Helper

**What:** A single, audited write path that all 7 corruption-suspect call sites delegate to.

**Why:** torchaudio.save behaviour has shifted between versions — 2.9+ delegates to TorchCodec which expects float32 in [-1, 1]; older versions accept int16/float32 with implicit conversion. Mixing tensors that are non-contiguous, on-GPU, out-of-range, or wrong-dtype can produce WAVs that decode silently as silence, white-noise blasts, or corrupted-header errors. [VERIFIED: pytorch/audio issue #430; CITED: https://docs.pytorch.org/audio/stable/generated/torchaudio.save.html].

**Example:**
```python
# backend/services/audio_io.py — NEW
import torch
import torchaudio

def _safe_torchaudio_save(
    path_or_buf,
    tensor: torch.Tensor,
    sample_rate: int,
    *,
    format: str = "wav",
    bits_per_sample: int = 16,
) -> None:
    """Single audited WAV/audio write path. Closes BUG-01 / issue #48.

    Guarantees:
      • tensor is on CPU (torchaudio cannot serialize CUDA tensors)
      • tensor is contiguous (non-contiguous = silent corruption on some backends)
      • tensor is float32 in [-1, 1] (clamped, not normalized — caller is responsible
        for level)
      • 2D shape (channels, samples) — 1D inputs get unsqueezed
      • explicit encoding + bits_per_sample so torchcodec/sox/ffmpeg backend choice
        doesn't drift the format silently
    """
    if tensor.is_cuda or tensor.device.type == "mps":
        tensor = tensor.cpu()
    if tensor.dtype != torch.float32:
        tensor = tensor.to(torch.float32)
    tensor = tensor.clamp(-1.0, 1.0)
    if tensor.ndim == 1:
        tensor = tensor.unsqueeze(0)
    if not tensor.is_contiguous():
        tensor = tensor.contiguous()
    torchaudio.save(
        path_or_buf,
        tensor,
        sample_rate,
        format=format,
        encoding="PCM_S" if bits_per_sample <= 16 else "PCM_F",
        bits_per_sample=bits_per_sample,
    )
```

### Anti-Patterns to Avoid

- **Pickling torch tensors across the IPC boundary.** The sidecar may pin a different torch version. Pickle silently breaks.
- **Newline-delimited JSON over stdio on Windows.** Buffer flushes are unreliable across `subprocess.Popen` pipes on Windows when the child uses `print()`. Use length prefixes.
- **`multiprocessing.Process` for sidecars.** Only works when child shares the parent's Python interpreter. We explicitly want a *different* venv's interpreter — that's the whole point. Use `subprocess.Popen([engine_python, "main.py"])`.
- **Auto-respawn on sidecar death.** Masks a crash loop. Surface "engine crashed — restart from Settings → Engines" instead.
- **One sidecar per `generate()` call.** Spawning a Python process + loading a 2 GB model per call is ~30 s overhead. Sidecars are *long-lived* — spawn on first `generate`, keep until app exit.
- **Forgetting `flush=True` / explicit `stream.flush()` in the sidecar.** Without flush, the parent blocks on `read(4)` indefinitely. Every `send_frame` must flush.
- **Forking after model load.** macOS spawn-default is correct here; explicitly call `mp.get_context("spawn")` so dev-on-Linux doesn't masquerade as cross-platform safe.
- **Sharing `_gpu_pool` workers between in-process generations and sidecar requests by accident.** The slot must be acquired *before* the sidecar dispatches to the model, released *after* the response is sent — not held for the whole sidecar lifetime.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-platform process start | Custom `os.fork()` wrapper | `subprocess.Popen(..., start_new_session=True)` (Unix) + `creationflags=subprocess.CREATE_NEW_PROCESS_GROUP` (Windows) | Already cross-platform; fork doesn't exist on Windows; spawn-default handles macOS correctly. |
| Length-prefixed JSON framing | Hand-roll a tag-length-value protocol | The 20-line pattern above + `struct.pack/unpack` | TLV protocols always grow features (CRC, version negotiation). Length-prefixed JSON is enough. |
| WAV header validation in tests | Hand-parse RIFF chunks | `soundfile.info(path)` — returns frames, samplerate, channels, format, subtype | libsndfile is the canonical Python WAV reader. [VERIFIED: python-soundfile docs] |
| Tensor → PCM conversion | Custom int16 conversion | `tensor.clamp(-1,1).mul(32767).to(torch.int16).contiguous().cpu().numpy().tobytes()` | The standard ML-audio recipe. Anything else risks silent clipping or endianness bugs. |
| Engine venv creation | `python -m venv` + manual pip wiring | `uv venv` + `uv pip install -e <path>` | Project ships `uv` already (`tools.rs`); reusing it gets us hash-locked, fast installs, and Phase 3's mirror cascade for free. |
| Sidecar SIGTERM-on-app-exit | Custom atexit hook + signal handling | Existing pattern in `sonitranslate.py:175-180` lifted into `SubprocessBackend.shutdown()` + atexit registry at backend startup | Already works in-tree; generalize the existing code, don't invent. |

**Key insight:** *The two existing patterns in-tree — `gpu_sandbox.py` and `sonitranslate.py` — together contain ~85% of `SubprocessBackend`. Phase 2's job is not to invent a new primitive, it's to **lift the lifecycle half of `sonitranslate.py` into a base class**, swap its HTTP/Gradio surface for JSON-over-stdio, and adopt the spawn-safe defaults already validated by `gpu_sandbox.py`.*

---

## Runtime State Inventory

> This phase is not a rename/refactor — it's a primitive addition + bug fix. Runtime state surface is therefore limited, but the IndexTTS migration touches enough live state to warrant explicit answers.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Existing IndexTTS users have model weights cached under `$HF_HOME/hub/models--IndexTeam--IndexTTS-2/` (~6 GB) | NONE — child sidecar inherits `HF_HOME` via `os.environ.copy()`; reads same cache; no re-download. Verified via Phase 0's regression fixture. |
| Live service config | None — IndexTTS has no live service config in OmniVoice's DB or external services | NONE |
| OS-registered state | No Windows Task Scheduler / launchd / systemd registration uses the IndexTTS or SubprocessBackend names | NONE |
| Secrets/env vars | `OMNIVOICE_INDEXTTS_DIR` (existing — user-set), `OMNIVOICE_INDEXTTS_FP16` (existing). Phase 1 introduces `HF_TOKEN` subprocess injection (AUTH-04) — Phase 2's sidecars MUST receive it. | Verify `subprocess_backend.py` calls `os.environ.copy()` BEFORE applying any per-engine env tweaks, so the parent's `HF_TOKEN` + `HF_HOME` propagate. (One-line invariant in the spawn helper.) |
| Build artifacts | Stale `__pycache__` in the *parent* venv's IndexTTS install will NOT cause issues if `OMNIVOICE_INDEXTTS_DIR` is repointed to the sidecar-managed venv. But: if a user previously did `uv pip install -e .` in the parent venv (the very mistake #42 describes), there may be a half-broken IndexTTS install in the parent. Phase 2 doesn't auto-clean — surface a Settings → Engines diagnostic if both parent and sidecar have IndexTTS imports resolvable. | Implement diagnostic, not auto-clean. Auto-deleting parent-venv packages is too aggressive for a stabilization phase. |

**Canonical post-migration check:** *After IndexTTS migrates to subprocess isolation, an existing IndexTTS user with model weights cached at `$HF_HOME/hub/models--IndexTeam--IndexTTS-2/` and `OMNIVOICE_INDEXTTS_DIR=~/index-tts` will reach a working generation on first launch with zero re-downloads and zero re-installs.* This is the ENGINE-07 acceptance bar.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `uv` (bundled sidecar binary) | Per-engine venv bootstrap | ✓ | shipped by Tauri bundler [VERIFIED: `tools.rs::find_bundled_uv`] | System `uv` if `find_bundled_uv` returns None; surface clear error if neither. |
| Python ≥3.11 (system or managed) | All sidecars | ✓ in CI; user-side via Phase 1 install docs | matches parent venv requirement | None — sidecar venv creation fails fast if no Python available; surface installer docs link. |
| `git` | Cloning index-tts repo if user hasn't | platform-dependent | any | Phase 1's `xattr -cr` / Gatekeeper docs already cover the "git missing on first-launch macOS" path. Defer to Phase 1's error-docs map. |
| `transformers<5` | IndexTTS sidecar | resolved at `uv pip install -e .` time | per IndexTTS's pin | NONE — this is the entire point of the sidecar. |
| Existing IndexTTS install (`OMNIVOICE_INDEXTTS_DIR`) | Backward-compat path | optional | user-controlled | If unset, Phase 2 still works — sidecar uses `engines/indextts/` cloned/installed via the existing "Install IndexTTS" UI button. |

**Missing dependencies with no fallback:** None — every required dep is either bundled or stdlib.
**Missing dependencies with fallback:** None — no degraded mode for Phase 2.

---

## Common Pitfalls

### Pitfall 1 — `mp.get_context("spawn")` semantics on Apple Silicon for CUDA-free child processes

**What goes wrong:** On macOS, spawn has been the default since Python 3.8 [VERIFIED: https://docs.python.org/3/library/multiprocessing.html]. However, the well-known fragility is that *fork after model load* on macOS will crash on first GPU op (the libdispatch warning every macOS PyTorch user has seen). Phase 2 is *not affected by this directly* because Phase 2 uses `subprocess.Popen` (a fully separate Python interpreter from a different venv), not `multiprocessing.Process` (same interpreter). The "MPS spawn quirk" the Architect flagged is a **non-issue for the path we chose**, because we never call `mp.fork()` or `mp.spawn()` after touching torch.

**Why it happens:** The Architect's open question conflated two patterns: (1) `multiprocessing.get_context("spawn")` for in-interpreter parallelism (`gpu_sandbox.py`'s pattern), and (2) `subprocess.Popen([different_venv_python, ...])` for sidecars (`sonitranslate.py`'s pattern). Phase 2 uses pattern (2). Pattern (2) has no spawn-vs-fork issue at all — it's a brand-new OS process with a brand-new interpreter.

**How to avoid:** Explicitly choose `subprocess.Popen` for the sidecar lifecycle (`subprocess_backend.py`), and only use `multiprocessing.get_context("spawn")` if/when a future feature needs in-interpreter child processes. Document this choice in `subprocess_backend.py`'s module docstring so the next contributor doesn't reach for `mp.Process` thinking it's equivalent.

**Warning signs:** A regression test that calls `mp.set_start_method("fork")` anywhere in the test suite. Forbid this in CI — fork is unsafe on macOS-with-libdispatch and is being phased out on Linux in Py 3.14 per [PEP 745 / discuss.python.org thread](https://discuss.python.org/t/switching-default-multiprocessing-context-to-spawn-on-posix-as-well/21868).

### Pitfall 2 — Sidecar blocks parent on un-flushed stdout

**What goes wrong:** Sidecar writes a response with `print()` or `sys.stdout.write()` without `flush()`; Python's buffered IO holds the bytes; parent's `read(4)` blocks indefinitely. Looks like a hang.

**Why it happens:** `subprocess.PIPE` is line-buffered by default on text streams and block-buffered on binary streams. When the sidecar uses `sys.stdout.buffer` (binary), it block-buffers at 8 KB.

**How to avoid:** Every `send_frame()` ends with `stream.flush()`. Set `PYTHONUNBUFFERED=1` in the child env at `Popen` time as defense-in-depth.

**Warning signs:** First-spawn integration test takes >5 s. Add `pytest-timeout` per-test cap at 30 s — surfaces hangs as test failures, not CI wedges.

### Pitfall 3 — `torchaudio.save` silently produces corrupt WAVs

**What goes wrong:** Issue #48. Several configurations produce a file that doesn't play: (a) tensor with `.cuda()` or `.mps()` device, (b) non-contiguous tensor (after `transpose`/`narrow`), (c) values outside [-1, 1], (d) wrong dtype (int16 saved as if float32). The newest torchaudio (2.9+) delegates to TorchCodec which is even stricter about float32-in-range. [CITED: pytorch/audio#430, pytorch/audio#252, https://docs.pytorch.org/audio/stable/generated/torchaudio.save.html]

**Why it happens:** The 7 in-tree call sites all assume `audio_tensor` is correctly-shaped CPU float32; in practice, some come from RVC post-processing (non-contiguous after slicing), some from `torch.nn.functional.interpolate` (sometimes returns non-contiguous), some from `torch.cat` over GPU tensors that weren't `.cpu()`'d.

**How to avoid:** Centralize on `_safe_torchaudio_save()` (Pattern 3 above). Make the 7 sites delegate. Add a regression test that calls `_safe_torchaudio_save` with each of the four failure modes (cuda tensor, non-contig, out-of-range, wrong dtype) and asserts the resulting file passes `sf.info()` with the expected `frames`, `samplerate`, `subtype`.

**Warning signs:** User reports "exported WAV is silent" or "header is corrupt" without a stack trace. The fix raises confidence the next bug like this will surface a *test* failure, not a *user* failure.

### Pitfall 4 — HF_HOME drift across the sidecar boundary

**What goes wrong:** User has `~/.cache/huggingface/hub/` populated with IndexTTS weights. After Phase 2 migration, sidecar can't find them and re-downloads 6 GB.

**Why it happens:** `subprocess.Popen` without `env=` inherits the parent env, which IS what we want — but if any code path strips `HF_HOME` or rebuilds env from scratch (e.g. a Tauri bundle that doesn't set `HF_HOME` in the launchctl environment), the sidecar starts with no cache override and HF defaults to `~/.cache/huggingface`. If the user's actual cache lives at a non-default `HF_HUB_CACHE`, this hits a *different* path.

**How to avoid:** `subprocess_backend.py` MUST pass `env=os.environ.copy()` explicitly (matches `sonitranslate.py:142`). Backend startup (`backend/main.py:64-65`) already sets `HF_HOME` + `HF_HUB_CACHE` — sidecars inherit by reference. Add an integration test: pre-populate `$TMPDIR/hf-cache/hub/models--IndexTeam--IndexTTS-2/` with a marker file, launch sidecar, assert sidecar sees the marker (via a probe `op`).

**Warning signs:** ENGINE-07 acceptance test fails: user reports "OmniVoice is re-downloading IndexTTS after upgrade." This pitfall is the most likely root cause.

### Pitfall 5 — `is_available()` raises an exception, takes down the whole engine listing

**What goes wrong:** ENGINE-05 root cause. If `KittenTTSBackend.is_available()` raises because of a misconfigured ONNX runtime, the current `list_backends()` loop at `tts_backend.py:1148-1158` propagates the exception, and the entire engine picker UI shows "Failed to load engines."

**Why it happens:** `is_available()` is documented as `(bool, str)` but several implementations have `except Exception as e: return False, str(e)` only partially covering the import surface. IndexTTS (`tts_backend.py:773-780`) has an explicit `except Exception` wrap that catches the deep import chain — KittenTTS and others don't.

**How to avoid:** Wrap the `cls.is_available()` call in `list_backends()` itself:
```python
for bid, cls in _REGISTRY.items():
    try:
        ok, msg = cls.is_available()
    except Exception as e:
        ok, msg = False, f"{type(e).__name__}: {e}"
        _LAST_ERRORS[bid] = msg     # used by ENGINE-06 Compat Matrix
    out.append({...})
```
One unprotected `is_available()` cannot prevent boot.

**Warning signs:** User reports "engine picker is empty" or "Settings → Engines never loads."

### Pitfall 6 — Sidecar zombie on Tauri app exit

**What goes wrong:** User quits OmniVoice; Tauri SIGTERMs the backend; backend dies; sidecar lives on, holding ~6 GB RAM and an HF lock file. Next launch: lock contention, mysterious failures.

**Why it happens:** SIGTERM to the backend doesn't propagate to its children unless the children are in the backend's process group AND the backend's signal handler forwards. `sonitranslate.py:175-180` handles this for its one subprocess; `SubprocessBackend` must do the same for *every* registered sidecar.

**How to avoid:** Three layers of defense:
1. `SubprocessBackend.__init__` registers `atexit.register(self.shutdown)`.
2. The Popen call uses `start_new_session=True` (Unix) so the sidecar is in its own process group and survives the parent's SIGTERM cleanly OR can be group-killed.
3. Backend's main process installs a `SIGTERM` handler that iterates `_REGISTRY` and calls `.shutdown()` on each subprocess-backed engine before re-raising.

The Tauri layer (`frontend/src-tauri/src/lib.rs:567-595`) already SIGTERMs the backend with a 2-second grace + SIGKILL — that part is correct and unchanged in Phase 2.

**Warning signs:** Process list shows lingering `engines/indextts/.venv/bin/python` after OmniVoice is closed. Add a CI step that asserts `psutil` finds zero leftover sidecars 5 s after backend shutdown.

### Pitfall 7 — Slot leak in `_gpu_pool` if sidecar dies mid-generation

**What goes wrong:** Parent grants a GPU slot to a sidecar. Sidecar crashes (OOM, CUDA fault). Parent never receives a response. Slot counter stays decremented forever. After 4 such crashes, the pool is exhausted and no generation works.

**Why it happens:** The slot-grant protocol (`{"op":"gpu_acquire"}` → `{"slot":"granted"}` → ... → `{"op":"gpu_release"}`) is request/response-paired, but a process death breaks the second half of the pair.

**How to avoid:** The slot is released on EITHER `{"op":"gpu_release"}` from the sidecar OR sidecar process exit (whichever comes first), in a single try/finally on the parent side:
```python
slot = self._gpu_pool.acquire()
try:
    response = self._call({"op": "synthesize", ...})
finally:
    self._gpu_pool.release(slot)
```
Combine with Pitfall 6's process-group cleanup so a dead sidecar reliably triggers the `finally`.

**Warning signs:** After several test runs, generation requests start hanging at "Acquiring GPU slot..." stage. The pool counter has leaked.

### Pitfall 8 — First-launch sidecar spawn takes 30+ seconds, looks like a hang

**What goes wrong:** First `generate()` after app boot: spawn Python (~1 s), import torch (~2 s in the child venv), import indextts (~5 s), load IndexTTS-2 from disk (~20 s on cold cache). User sees a spinner that doesn't move and concludes the app is broken.

**Why it happens:** Model load happens lazily in the sidecar's `{"op":"ready"}` handler. We could move it to spawn-time to surface "loading…" earlier, at the cost of paying the load even if the user never uses IndexTTS in this session.

**How to avoid:** Keep lazy load (don't pay if not used), but stream progress events from sidecar to parent during load (`{"op":"progress","stage":"loading_model","percent":0.5}`), and surface in the frontend toast / engine card. The protocol supports this trivially because we already have a frame-based stdio loop.

**Warning signs:** Discord reports of "IndexTTS hangs on first use after upgrade." Always check whether the user waited 60 s before reporting.

---

## Code Examples

### SubprocessBackend base class skeleton

```python
# backend/services/subprocess_backend.py — NEW (~150 LOC target)
"""Per-engine subprocess isolation primitive.

Lifts the lifecycle half of services/sonitranslate.py into a base class
that engines requiring incompatible dependency pins (transformers<5 for
IndexTTS being the canonical case, issue #42) inherit from. Communicates
over length-prefixed JSON frames on stdin/stdout — no port allocation,
no pickle, cross-venv safe.

Subclasses provide:
  - id, display_name (inherited from TTSBackend)
  - venv_path():          path to the sidecar's Python executable
  - script_path():        path to the sidecar's main.py
  - is_available(cls):    health check (sidecar binary + venv present)

The base class handles spawn, stdio framing, GPU slot grant, shutdown,
and TTSBackend.generate() implementation that synchronously dispatches
{"op": "synthesize", ...} and returns the resulting torch.Tensor.
"""
from __future__ import annotations
import atexit, base64, json, logging, os, struct, subprocess, sys, threading
from pathlib import Path
from typing import Optional
import numpy as np
import torch

from services.tts_backend import TTSBackend
from services.model_manager import _get_gpu_pool

logger = logging.getLogger("omnivoice.subprocess_backend")


class SubprocessBackend(TTSBackend):
    _proc: Optional[subprocess.Popen] = None
    _lock: threading.Lock

    def __init__(self):
        self._proc = None
        self._lock = threading.Lock()
        atexit.register(self.shutdown)

    # ── Subclass surface ───────────────────────────────────────────
    @classmethod
    def venv_python(cls) -> Path:
        raise NotImplementedError

    @classmethod
    def sidecar_script(cls) -> Path:
        raise NotImplementedError

    # ── Lifecycle ──────────────────────────────────────────────────
    def _spawn(self) -> None:
        if self._proc and self._proc.poll() is None:
            return
        env = os.environ.copy()                 # carries HF_HOME, HF_TOKEN
        env["PYTHONUNBUFFERED"] = "1"
        kwargs: dict = dict(
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        if sys.platform != "win32":
            kwargs["start_new_session"] = True
        else:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        logger.info("Spawning %s sidecar: %s", self.id, self.sidecar_script())
        self._proc = subprocess.Popen(
            [str(self.venv_python()), str(self.sidecar_script())], **kwargs
        )
        # Wait for ready handshake
        ready = self._recv()
        if not ready or ready.get("op") != "ready":
            raise RuntimeError(f"{self.id} sidecar did not signal ready: {ready!r}")

    def shutdown(self) -> None:
        if not self._proc:
            return
        try:
            self._send({"op": "shutdown"})
        except Exception:
            pass
        try:
            self._proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None

    # ── Wire protocol ──────────────────────────────────────────────
    def _send(self, msg: dict) -> None:
        body = json.dumps(msg, separators=(",", ":")).encode("utf-8")
        self._proc.stdin.write(struct.pack("!I", len(body)))
        self._proc.stdin.write(body)
        self._proc.stdin.flush()

    def _recv(self) -> Optional[dict]:
        header = self._proc.stdout.read(4)
        if len(header) < 4:
            return None
        (n,) = struct.unpack("!I", header)
        if n > 64 * 1024 * 1024:
            raise IOError(f"frame too large: {n}")
        body = self._proc.stdout.read(n)
        if len(body) < n:
            raise IOError(f"short read: {len(body)}/{n}")
        return json.loads(body)

    # ── TTSBackend.generate ────────────────────────────────────────
    def generate(self, text: str, **kw) -> torch.Tensor:
        with self._lock:
            self._spawn()
            pool = _get_gpu_pool()
            # Acquire a GPU slot for the sidecar's generation window
            fut = pool.submit(lambda: None)   # reserves a worker thread
            try:
                self._send({"op": "synthesize", "text": text, **{
                    k: v for k, v in kw.items() if isinstance(v, (str, int, float, bool, list, dict, type(None)))
                }})
                response = self._recv()
                if not response or response.get("op") != "audio":
                    raise RuntimeError(f"{self.id} sidecar bad response: {response!r}")
                pcm = base64.b64decode(response["audio_pcm_b64"])
                arr = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
                return torch.from_numpy(arr).unsqueeze(0)
            finally:
                fut.result()                  # release worker slot
```

### IndexTTS sidecar entry point

```python
# backend/engines/indextts/main.py — NEW (~120 LOC target)
"""IndexTTS-2 sidecar entry point. Runs inside engines/indextts/.venv with
transformers<5, isolated from the OmniVoice parent process which pins
transformers>=5.3. Closes issue #42.
"""
from __future__ import annotations
import base64, json, os, struct, sys, tempfile, traceback


def send(obj: dict) -> None:
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("!I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def recv() -> dict | None:
    h = sys.stdin.buffer.read(4)
    if len(h) < 4:
        return None
    (n,) = struct.unpack("!I", h)
    return json.loads(sys.stdin.buffer.read(n))


def main() -> int:
    model = None
    try:
        from indextts.infer_v2 import IndexTTS2
        import torch, torchaudio
    except Exception as e:
        send({"op": "error", "stage": "import",
              "message": f"{type(e).__name__}: {e}",
              "traceback": traceback.format_exc()})
        return 1

    repo_dir = os.environ.get("OMNIVOICE_INDEXTTS_DIR", ".")
    cfg = os.path.join(repo_dir, "checkpoints", "config.yaml")
    use_fp16 = os.environ.get("OMNIVOICE_INDEXTTS_FP16", "1") == "1"
    try:
        model = IndexTTS2(
            cfg_path=cfg,
            model_dir=os.path.join(repo_dir, "checkpoints"),
            use_fp16=use_fp16,
            use_cuda_kernel=False,
            use_deepspeed=False,
        )
    except Exception as e:
        send({"op": "error", "stage": "load",
              "message": f"{type(e).__name__}: {e}",
              "traceback": traceback.format_exc()})
        return 1

    send({"op": "ready", "engine": "indextts2"})

    while True:
        msg = recv()
        if not msg or msg.get("op") == "shutdown":
            return 0
        op = msg.get("op")
        if op == "ping":
            send({"op": "pong"})
            continue
        if op == "synthesize":
            try:
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
                    tmp = t.name
                kw = {
                    "spk_audio_prompt": msg.get("ref_audio"),
                    "text": msg["text"],
                    "output_path": tmp,
                    "verbose": False,
                }
                # ... (emotion/duration kwargs as in current IndexTTS2Backend.generate)
                model.infer(**kw)
                wav, sr = torchaudio.load(tmp)
                if wav.ndim == 2 and wav.shape[0] > 1:
                    wav = wav.mean(dim=0, keepdim=True)
                pcm = (
                    wav.squeeze(0).clamp(-1, 1).mul(32767).to(torch.int16)
                    .cpu().contiguous().numpy().tobytes()
                )
                send({"op": "audio",
                      "audio_pcm_b64": base64.b64encode(pcm).decode("ascii"),
                      "sample_rate": int(sr)})
                try: os.unlink(tmp)
                except OSError: pass
            except Exception as e:
                send({"op": "error", "stage": "generate",
                      "message": f"{type(e).__name__}: {e}",
                      "traceback": traceback.format_exc()})


if __name__ == "__main__":
    sys.exit(main())
```

### Regression test for WAV-export #48

```python
# tests/test_audio_io.py — NEW
import os
import pytest
import soundfile as sf
import torch
from services.audio_io import _safe_torchaudio_save


@pytest.mark.parametrize("dtype", [torch.float32, torch.float64, torch.int16])
@pytest.mark.parametrize("device", ["cpu"])  # add "mps"/"cuda" if available in CI
@pytest.mark.parametrize("contiguous", [True, False])
def test_safe_save_round_trip(tmp_path, dtype, device, contiguous):
    sr = 24000
    n = sr  # 1 second
    t = torch.linspace(-1, 1, n, dtype=torch.float32, device=device).mul(0.5)
    if dtype != torch.float32:
        t = t.to(dtype)
    if not contiguous:
        # Force non-contig via stride manipulation
        t = t.unsqueeze(0).expand(2, n).clone()[:, ::1].t().contiguous().t()
        assert not t.is_contiguous()
    path = tmp_path / f"out_{dtype}_{contiguous}.wav"
    _safe_torchaudio_save(str(path), t, sr)
    info = sf.info(str(path))
    assert info.samplerate == sr
    assert info.frames == n
    assert info.subtype.startswith("PCM_")
    # Re-read and check signal isn't all-zero / all-NaN
    samples, _ = sf.read(str(path))
    assert samples.size > 0
    assert abs(samples).max() > 0.1   # signal survived round-trip
```

### Engine registry graceful-degradation wrap

```python
# backend/services/tts_backend.py — MODIFIED
_LAST_ERRORS: dict[str, str] = {}     # NEW — module-level last-error cache

def list_backends() -> list[dict]:
    """Enumerate every registered backend with its availability state.
    Guarantees no single broken engine takes the registry down.
    """
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
        # Detect isolation mode from class hierarchy
        from services.subprocess_backend import SubprocessBackend
        isolation = "subprocess" if issubclass(cls, SubprocessBackend) else "in-process"
        out.append({
            "id": bid,
            "display_name": cls.display_name,
            "available": ok,
            "reason": None if ok else msg,
            "install_hint": _INSTALL_HINTS.get(bid),
            "last_error": _LAST_ERRORS.get(bid),
            "isolation_mode": isolation,           # ENGINE-06 UI consumes this
        })
    return out
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `multiprocessing.Process` (fork) for parallelism on macOS | `mp.get_context("spawn")` — but only relevant if you stay in one interpreter | Py 3.8 made spawn the macOS default [VERIFIED: docs.python.org] | For sidecars across **different** venvs, neither applies — use `subprocess.Popen`. |
| `torchaudio.save(..., format="wav")` with implicit encoding inference | `torchaudio.save(..., encoding="PCM_S", bits_per_sample=16)` explicit; or migrate to `torchcodec.AudioEncoder` in torchaudio ≥2.9 | torchaudio 2.9 (2025) delegated WAV write to TorchCodec [CITED: docs.pytorch.org/audio/stable/generated/torchaudio.save.html] | Default behaviour drifted; explicit encoding immunizes against the change. |
| `HfFolder.save_token()` | `huggingface_hub.login(token=…, add_to_git_credential=False)` | HF Hub 1.x | Phase 1's concern; Phase 2 only consumes the resolved token via env injection. |
| `gradio_client` for engine RPC | JSON-over-stdio for engines wrapped from a pip package | Phase 2 introduces this for the first time | Cleaner, port-free, Windows-safer. SoniTranslate stays on Gradio because it *is* a Gradio app. |

**Deprecated/outdated:**
- `multiprocessing.Process(target=...)` for sidecar isolation when the goal is dependency isolation. It can't switch venvs.
- Implicit-encoding `torchaudio.save` — silently changes behaviour between torchaudio versions.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `pytest-timeout` is already in dev-dependencies | Standard Stack — Supporting | If absent, add via `uv add --dev pytest-timeout`. Low risk. |
| A2 | torchaudio.save 2.9+ "TorchCodec delegate" requires float32-in-[-1,1] | Pitfall 3 + Pattern 3 | If torchaudio < 2.9 in the locked env, the strictness is looser — but `_safe_torchaudio_save` is correct either way. Defensive. |
| A3 | `multiprocessing.get_context("spawn")` is the documented default on macOS for Py 3.8+ and remains so on Py 3.11 / 3.12 | Pitfall 1 | If a future Python ships with a different default, `mp.get_context("spawn")` still works — we never relied on the default. |
| A4 | `subprocess.Popen` with `env=os.environ.copy()` reliably inherits `HF_HOME` set at `backend/main.py:64` | Pitfall 4 + Section IndexTTS | If a launcher (Tauri bundle) clobbers env before launching the backend, `HF_HOME` won't be set yet at backend startup. Confirmed in-tree at `backend/main.py:64-65` that the *backend* sets it; sidecars inherit. Verified. |
| A5 | Existing IndexTTS users have `OMNIVOICE_INDEXTTS_DIR` set | Backward-compat | If they don't, the sidecar bootstrap creates `engines/indextts/.venv` and prompts them to clone the IndexTTS repo into `engines/indextts/`. Documented in install hint. |
| A6 | The current `_gpu_pool` (model_manager.py:46) is the correct VRAM coordination point for sidecar generations | Architecture Map | If the pool turns out to be process-local (it is — it's a Python ThreadPoolExecutor in the parent), the slot grant is parent-side serialization, not actual VRAM accounting in the child. That's still correct: the child only runs when the parent grants — the parent's pool *is* the bottleneck of how many concurrent GPU consumers exist system-wide. |
| A7 | IndexTTS's `infer()` writes to a file (current behaviour at tts_backend.py:881-897) — sidecar can rely on that | Code Examples — sidecar | If a future IndexTTS update returns a tensor directly, the sidecar can adapt; the wire-format conversion to int16 PCM is unchanged. Resilient. |

**Mitigation:** Each assumption flagged here is either (a) verifiable in CI at plan-execution time (A1, A4, A5), or (b) defensive-by-default (A2, A3, A6, A7). None gate the phase.

---

## Open Questions

1. **Does the existing IndexTTS install at `OMNIVOICE_INDEXTTS_DIR` ship a `.venv` we can reuse, or do we always create `engines/indextts/.venv`?**
   - What we know: Issue #42's reporter installed via `uv pip install -e .` *into the OmniVoice parent venv* (that's the entire bug). The "right" install path is into a separate venv — but no in-tree convention enforces it.
   - What's unclear: Whether existing users (n=??, probably small per the Architect's "Discord-volume" framing) have a `.venv` adjacent to their `OMNIVOICE_INDEXTTS_DIR` or just an installed-into-parent state.
   - Recommendation: On first sidecar spawn after upgrade, probe in this order:
     1. `${OMNIVOICE_INDEXTTS_DIR}/.venv/bin/python -c "import indextts"` — reuse if found
     2. `engines/indextts/.venv/bin/python -c "import indextts"` — reuse if found
     3. Create `engines/indextts/.venv` via bundled `uv`, then `uv pip install -e ${OMNIVOICE_INDEXTTS_DIR}` (or clone if dir doesn't exist)
   - Defer fully-automated install of IndexTTS to v0.4 — Phase 2 keeps a "Click to install IndexTTS" button in Settings, just like today.

2. **What's the minimum-acceptable spawn-to-ready latency for the Compatibility Matrix UI?**
   - What we know: Cold-load of IndexTTS-2 is ~20 s on a SATA SSD; ~8 s on an NVMe SSD; ~6 s on Apple Silicon's NVMe. Loading happens at sidecar spawn.
   - What's unclear: Whether the Compat Matrix UI calls `health_check()` (sidecar must already be spawned) or lazily decides based on `is_available()` only.
   - Recommendation: Compat Matrix UI calls only `is_available()` — checks for venv + python + script presence. `health_check()` spawns the sidecar and is invoked only when the user clicks "Test engine" in the matrix UI, or implicitly on first `generate()`. Avoids paying the load cost on every Settings open.

3. **Should the sidecar's stderr be captured by the parent or written to a file?**
   - What we know: SoniTranslate captures stderr to the parent's log (`sonitranslate.py:152-153`). gpu_sandbox sends errors via the response channel.
   - What's unclear: Stderr from a long-running sidecar could fill the parent's pipe buffer (~64 KB on Linux) and deadlock the sidecar's writes.
   - Recommendation: Sidecar writes its own log to `omnivoice_data/logs/engines/<id>.log`; parent's `subprocess.Popen(stderr=subprocess.PIPE)` is read by a background thread that copies stderr lines into the main backend log with a `[indextts]` prefix. Two layers: machine-readable file + human-debuggable parent-log stream.

---

## Validation Architecture

> nyquist_validation is enabled per `.planning/config.json` default (key absent = enabled).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `pytest` + `pytest-asyncio` + `pytest-timeout` (already pinned for Phase 0) |
| Config file | `pyproject.toml` (`[tool.pytest.ini_options]`) — verify in plan Wave 0 |
| Quick run command | `uv run pytest tests/test_audio_io.py tests/test_subprocess_backend.py -x` |
| Full suite command | `uv run pytest tests/ -x --timeout 60` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ENGINE-01 | Echo sidecar spawn → ready → generate → exit, cross-platform | integration | `pytest tests/test_subprocess_backend.py::test_echo_round_trip -x` | ❌ Wave 0 |
| ENGINE-01 | Spawn cleanup on parent shutdown (no zombie) | integration | `pytest tests/test_subprocess_backend.py::test_no_zombie_after_shutdown -x` | ❌ Wave 0 |
| ENGINE-02 | Sidecar inherits HF_HOME, finds pre-existing cache | integration | `pytest tests/test_subprocess_backend.py::test_hf_home_inherited -x` | ❌ Wave 0 |
| ENGINE-03 | IndexTTS sidecar imports `indextts.infer_v2` without `OffloadedCache` ImportError | integration | `pytest tests/test_indextts_sidecar.py::test_import_does_not_clash -x` | ❌ Wave 0 |
| ENGINE-04 | IndexTTS sidecar + in-process OmniVoice both generate in one session, no AttributeError | integration | `pytest tests/test_indextts_sidecar.py::test_coexist_with_omnivoice -x` | ❌ Wave 0 |
| ENGINE-05 | `list_backends()` returns all 9 entries even if one raises in `is_available()` | unit | `pytest tests/test_tts_backend.py::test_list_backends_resilient -x` | ❌ Wave 0 |
| ENGINE-06 | `list_backends()` includes `isolation_mode` and `last_error` keys | unit | `pytest tests/test_tts_backend.py::test_list_backends_shape -x` | ❌ Wave 0 |
| ENGINE-07 | Sidecar reuses existing `${OMNIVOICE_INDEXTTS_DIR}/.venv` if present (no re-install) | integration | `pytest tests/test_indextts_sidecar.py::test_reuse_existing_venv -x` | ❌ Wave 0 |
| BUG-01 | `_safe_torchaudio_save` produces valid WAV under all dtype/contig combinations | unit | `pytest tests/test_audio_io.py::test_safe_save_round_trip -x` | ❌ Wave 0 |
| BUG-01 | All 7 in-tree write sites delegate to `_safe_torchaudio_save` | static lint | `pytest tests/test_audio_io.py::test_no_bare_torchaudio_save -x` (greps router files) | ❌ Wave 0 |
| BUG-01 | Dub pipeline end-to-end produces a `sf.info()`-valid WAV (manual fixture) | integration | `pytest tests/test_dub_pipeline.py::test_dubbed_wav_decodes -x` (uses Phase 0 fixture) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `uv run pytest tests/test_audio_io.py tests/test_subprocess_backend.py -x` (~30 s on hot cache)
- **Per wave merge:** `uv run pytest tests/ -x --timeout 60` (~3 min hot cache)
- **Phase gate:** Full suite green + manual smoke (dub a 30-s video, generate one IndexTTS sample, confirm both WAVs decode) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/test_subprocess_backend.py` — covers ENGINE-01, ENGINE-02
- [ ] `tests/test_indextts_sidecar.py` — covers ENGINE-03, ENGINE-04, ENGINE-07
- [ ] `tests/test_tts_backend.py` (extend existing if any) — covers ENGINE-05, ENGINE-06
- [ ] `tests/test_audio_io.py` — covers BUG-01
- [ ] `tests/test_dub_pipeline.py` — covers BUG-01 end-to-end
- [ ] `backend/engines/_echo/main.py` — permanent regression-test sidecar
- [ ] Phase 0 fixture extension: a 3-s `ref.wav` plus an SRT for the dub regression test (verify Phase 0's `omnivoice_data/` fixture already supplies these — if not, fold into Wave 1)

---

## Security Domain

> security_enforcement is enabled per default (absent in config = enabled).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (indirectly) | HF token forwarded to sidecar via env — never written to disk in sidecar code, never logged. Phase 1's logging filter applies parent-side; sidecar inherits and must also filter. |
| V3 Session Management | no | No sessions in IPC protocol |
| V4 Access Control | partial | Sidecar can ONLY accept frames from the parent's stdin — no network listener, no other IPC. By construction, no unauthorized callers. |
| V5 Input Validation | yes | Parent-side: validate frame size cap (64 MB) before allocating. Sidecar-side: validate JSON op against allow-list `{ping, ready, synthesize, shutdown}` before dispatching. |
| V6 Cryptography | no | No crypto in Phase 2 (encrypted HF token settings is Phase 1) |
| V12 File / Resources | yes | Sidecar reads HF_HOME, OMNIVOICE_INDEXTTS_DIR. Both are inherited from parent env, both pre-validated by Phase 1's path-sanitization. |
| V14 Configuration | yes | `PYTHONUNBUFFERED=1` forced in child env — defense-in-depth, not a secret. |

### Known Threat Patterns for stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Sidecar arbitrary-code-execution via crafted ref_audio path | Tampering | Parent validates ref_audio path is under `omnivoice_data/voices/` or a temp dir before forwarding; sidecar trusts parent (its only input source). |
| HF token leak via sidecar stderr | Information Disclosure | Sidecar log filter mirrors Phase 1's AUTH-05 filter; main backend log captures only `[indextts] error: <redacted>` line on failure. |
| Frame-size DoS (parent allocates 4 GB on malicious length prefix) | DoS | Hard cap at 64 MB per frame in both `_send`/`_recv`. Anything larger is a protocol violation → kill sidecar. |
| Zombie sidecar holds VRAM after crash | DoS | Pitfall 6 + Pitfall 7 mitigations; CI test asserts no leftover sidecar PIDs 5 s after shutdown. |
| WAV header confusion (issue #48-class) → downstream tool crashes | Tampering (data) | `_safe_torchaudio_save` enforces canonical encoding; regression test asserts via `sf.info()`. |
| Pickled tensor exploit via deserialization | RCE | We **don't** pickle. JSON only. By design, no pickle attack surface. |

---

## Sources

### Primary (HIGH confidence)
- `backend/services/tts_backend.py:711-812` (IndexTTS2Backend current implementation — `is_available()` already detects the transformers conflict at lines 753-764)
- `backend/services/sonitranslate.py:130-182` (long-lived subprocess sidecar lifecycle pattern in-tree)
- `backend/services/gpu_sandbox.py:1-164` (multiprocessing.Pipe + worker pattern in-tree)
- `backend/services/model_manager.py:42-99` (`_gpu_pool` slot accounting, `_pick_gpu_workers` heuristic)
- `backend/main.py:64-65` (`HF_HOME` / `HF_HUB_CACHE` set at backend startup — confirmed inheritance source)
- `frontend/src-tauri/src/lib.rs:567-595` (existing SIGTERM-with-grace shutdown of the backend, defends Phase 2's atexit chain)
- `frontend/src-tauri/src/commands.rs:309-312` (Tauri `quit_app` command — backend lifecycle entry point)
- `backend/api/routers/{generation,dub_generate,openai_compat,batch,dub_core}.py` — 11 WAV-write sites enumerated via grep, covering all of BUG-01's surface area
- `gh issue #42` (the canonical reproduction transcript including the `OffloadedCache` ImportError)
- `gh issue #48` (the report — no reproduction, but the 7 write sites are the only candidates)
- [Python `multiprocessing` — Contexts and start methods](https://docs.python.org/3/library/multiprocessing.html) — VERIFIED current docs, spawn-default-on-macOS-since-3.8 confirmed
- [torchaudio.save (stable docs, 2.10)](https://docs.pytorch.org/audio/stable/generated/torchaudio.save.html) — VERIFIED encoding/bits_per_sample params + TorchCodec delegation note
- [python-soundfile docs (0.13.1)](https://python-soundfile.readthedocs.io/en/0.13.1/) — VERIFIED `sf.info()` + `check_format()` API

### Secondary (MEDIUM confidence)
- [pytorch/audio Issue #430 — save/load bugs](https://github.com/pytorch/audio/issues/430) — VERIFIED that round-trip behaviour can change between versions; corroborates `_safe_torchaudio_save` necessity
- [pytorch/audio Issue #252 — downsampled audio saved as zeros](https://github.com/pytorch/audio/issues/252) — VERIFIED known silent-corruption mode
- [CVNets reference saves with `.contiguous()`](https://apple.github.io/ml-cvnets/_modules/data/transforms/audio_bytes.html) — corroborates contiguity-before-save as a defensive pattern
- [British Geological Survey — Fork vs Spawn](https://britishgeologicalsurvey.github.io/science/python-forking-vs-spawn/) — corroborates spawn semantics on macOS

### Tertiary (LOW confidence — informational only)
- [discuss.python.org thread — switching default mp context to spawn on POSIX](https://discuss.python.org/t/switching-default-multiprocessing-context-to-spawn-on-posix-as-well/21868) — relevant for *Linux* default shift in Py 3.14; Phase 2 explicitly opts into `spawn` so unaffected
- [SuperFastPython — fork faster than spawn](https://superfastpython.com/fork-faster-than-spawn/) — performance context, not relevant to Phase 2's cross-process boundary
- [uv environment management docs](https://docs.astral.sh/uv/pip/environments/) — already approved by Phase 1; reused for engine venvs

---

## Project Constraints (from CLAUDE.md)

Direct extractions from CLAUDE.md that Phase 2 MUST honor:

1. **Existing engine compatibility — users with already-installed engines (IndexTTS, CosyVoice, etc.) must not have to reinstall.** Drives ENGINE-07 and the backward-compat probe in the IndexTTS sidecar bootstrap.
2. **Cross-platform parity — every fix must work on macOS (Apple Silicon + Intel), Windows (x64), and Linux (AppImage + deb). No platform-only regressions; the cross-platform bug bash (PR #51) is the baseline.** Drives the `subprocess.Popen` choice over `multiprocessing.Process`, the explicit `creationflags` on Windows, and the JSON-over-stdio framing (avoids HTTP/port-bind platform quirks).
3. **Backward-compatible project data — existing `omnivoice_data/` (user voices, projects, settings) must keep working without manual migration.** Phase 2 introduces no DB schema changes; only file-system addition of `engines/indextts/.venv` and new logs under `omnivoice_data/logs/engines/`.
4. **Local-first guarantee preserved — auto bug reporting (new addition) must be opt-in...** Not Phase 2's concern; Phase 5's. But the sidecar log routing under `omnivoice_data/logs/engines/<id>.log` (Open Question 3) MUST NOT auto-forward to any remote endpoint. Verified by design.
5. **Beta release cadence — ship as v0.3.x minor releases.** Phase 2 ships as a v0.3.0 component, not gated on Phase 6's RC cadence — but the plan SHOULD identify Wave 1 (SubprocessBackend POC + BUG-01) as independently shippable as a v0.3.0-alpha so the larger IndexTTS migration in Wave 2 doesn't block the simpler #48 fix.
6. **No new Python runtime dependencies (CLAUDE.md "Installation" — Cap 1, 2, 3, 5 specifically).** Verified — Phase 2 uses only stdlib + pre-existing transitive deps.

---

## Metadata

**Confidence breakdown:**
- SubprocessBackend primitive design: **HIGH** — two in-tree precedents (`gpu_sandbox.py`, `sonitranslate.py:130-182`) provide ~85% of the implementation; only the JSON-over-stdio framing is new, and that's stdlib-only.
- IndexTTS sidecar migration: **HIGH** — issue #42 has an unambiguous reproduction, and the `engines/<id>/.venv` convention already exists in `engines/sonitranslate/.venv`.
- VRAM coordination: **MEDIUM** — slot-grant protocol is sound but untested in this codebase. Wave 1 POC validates it before Wave 2 commits.
- Engine registry shape: **HIGH** — pure refactor of an existing 14-line function; trivial.
- WAV-export #48 fix: **HIGH** — root-cause hypothesis (dtype/contig/range/encoding) is well-documented in pytorch/audio issues and matches the bug's "silent corruption" symptom; `_safe_torchaudio_save` is the defensive helper every similar codebase has eventually written.
- Sidecar lifecycle on Tauri app-exit: **HIGH** — existing SIGTERM-with-grace at `lib.rs:567-595` already correctly tears down the backend; adding atexit-driven sidecar shutdown on the backend side is a 20-line addition.
- MPS spawn quirk: **MEDIUM → HIGH after explanation.** Re-investigation surfaced that this concern conflated `multiprocessing.Process` with `subprocess.Popen`. Phase 2 uses `Popen` exclusively, so the historical macOS-spawn-fork hazards do not apply. Confidence is HIGH on the non-applicability; the LOW-confidence residue is "what if a future refactor switches to `mp.Process`" — addressed by a docstring lint rule in `subprocess_backend.py`.

**Research date:** 2026-05-18
**Valid until:** 2026-06-17 (30 days — stable APIs; libsndfile, torchaudio.save, subprocess.Popen, multiprocessing.get_context are all multi-year-stable)
