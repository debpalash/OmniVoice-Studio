# Plan 02-03 — Execution Summary

**Phase:** 02 (engine isolation + SubprocessBackend + IndexTTS WAV-export + dubbing)
**Plan:** 02-03 — IndexTTS on SubprocessBackend
**Wave:** 2
**Closes:** ENGINE-02, ENGINE-03, ENGINE-04, ENGINE-07 + issue #42

## Outcome

IndexTTS-2 now runs in its own subprocess + dedicated venv with
`transformers<5`, isolated from the OmniVoice parent process which
keeps its `transformers>=5.3` pin. Issue #42 (the canonical
`OffloadedCache` ImportError) is closed with a structural fix — the
two transformers versions live in different OS processes and can
never collide.

44 tests pass across the four files exercised by this plan:

- `tests/backend/services/test_indextts_backward_compat.py` (8 tests)
- `tests/backend/services/test_indextts_sidecar.py` (17 tests)
- `tests/backend/services/test_subprocess_backend.py` (13 tests)
- `tests/backend/services/test_tts_backend_registry.py` (6 tests)

Full suite: **391 passed, 10 skipped, 13 xfailed, 1 xpassed** in 57 s.
Smoke: 4 passed in 2.25 s. Zero regressions outside of the two
test_issue_fixes.py tests that asserted the *old* in-process error
messages — those were rewritten to validate the new subprocess
contract (`test_indextts_no_inprocess_import_attempted` is now the
direct ENGINE-03 closure assertion).

## Files modified / added

| Path | Purpose | LOC |
|---|---|---|
| `backend/engines/indextts/__init__.py` | Hosts `IndexTTS2Backend(SubprocessBackend)` — see deviation note below | 208 |
| `backend/engines/indextts/main.py` | Sidecar entrypoint; JSON-stdio loop; loads IndexTTS2 lazily | 277 |
| `backend/engines/indextts/bootstrap.py` | 3-step venv probe + lazy `uv venv` + `uv pip install -e` bootstrap | 256 |
| `backend/services/tts_backend.py` | IndexTTS2Backend body removed; lazy registry entry + PEP 562 re-export | net −~150 LOC |
| `tests/backend/services/test_indextts_sidecar.py` | 17 tests — coexistence, env-forwarding, emotion arbitration, source invariants | 350 |
| `tests/backend/services/test_indextts_backward_compat.py` | 8 tests — probe priority, no-spawn discipline, cache-marker preservation | 320 |
| `tests/fixtures/mock_indextts_sidecar.py` | Stdlib-only fixture mimicking the sidecar's wire protocol | 144 |
| `docs/engines/indextts.md` | Install walkthrough + venv-resolution order + common errors | 130 |
| `tests/test_issue_fixes.py` | Two old conflict-detection tests rewritten for the subprocess contract | net ±~15 LOC |

## Class size

The `IndexTTS2Backend` class body in `backend/engines/indextts/__init__.py`
is ~166 lines including its docstring (~50 lines of `"""..."""` plus
~30 lines of comments explaining the parent-side emotion arbitration).
Excluding docstring + comments the executable body is ~70 LOC — above
the plan's "target ≤30 LOC" but justified: the emotion/duration
arbitration (priority of emo_vector > emo_audio > emo_text, the 0.6
cap on text-mode alpha, the description→emo_text fallback) lives
parent-side so the sidecar's wire payload is unambiguous, matching
the old in-process behaviour at the legacy `tts_backend.py:855-907`.
The plan called this out in `<interfaces>` — "Override generate to
translate the public API". Moving the arbitration into the sidecar
would slim the parent class but fragment logic. **Decision:** keep
parent-side; the ~40 extra lines are documented logic the user can
read in one place.

## Deviation from RESEARCH.md sidecar skeleton

The plan's `<interfaces>` block shows `IndexTTS2Backend` defined
inside `backend/services/tts_backend.py`. **I moved the class into
`backend/engines/indextts/__init__.py` to break the import cycle**
between `services.subprocess_backend` (which imports
`TTSBackend` from `services.tts_backend`) and the proposed
`from services.subprocess_backend import SubprocessBackend` at the
top of `tts_backend.py`. The cycle wedged
`tests/backend/services/test_subprocess_backend.py` at collection
time with `ImportError: cannot import name 'SubprocessBackend' from
partially initialized module 'services.subprocess_backend'`.

The lazy-import resolution that DID work:

1. `IndexTTS2Backend` is defined in `backend/engines/indextts/__init__.py`.
2. `services.tts_backend._REGISTRY` is a custom `_LazyRegistry` dict
   subclass that resolves `"indextts2"` via deferred
   `importlib.import_module("engines.indextts")` on first access.
3. A PEP 562 `__getattr__` at the bottom of `tts_backend.py`
   re-exports `IndexTTS2Backend` so legacy callers writing
   `from services.tts_backend import IndexTTS2Backend` keep working.

This is the "minimal lazy-import resolution" called for in Plan
02-03 Step 3 — neither side has a circular dependency at import
time; the engines package is only loaded when something asks the
registry for IndexTTS2.

Sidecar ops added beyond the plan's spec: none (the plan's contract
is implemented verbatim — `ready` / `ping` / `synthesize` /
`shutdown` / `error` / `progress`). The emotion kwargs forwarded to
the sidecar are the exact allowlist the plan specified:
`{emo_vector, emo_audio_prompt, emo_alpha, emo_text, use_emo_text,
use_random, target_tokens}`.

## Lazy-import resolution location

Triggered by:

- `services.tts_backend._REGISTRY.items()` / `__getitem__` / `__contains__`
  → resolves via `_LAZY_REGISTRY` → `importlib.import_module("engines.indextts")`.
- `services.tts_backend.__getattr__("IndexTTS2Backend")` (PEP 562)
  → same import path.
- Test files do `from engines.indextts import bootstrap as
  indextts_bootstrap` directly — no resolution path needed; that's
  a normal top-level import in a leaf module.

## Venv-probe paths — dev vs. production

The probe order is identical in dev and production:

1. `${OMNIVOICE_INDEXTTS_DIR}/.venv/{bin|Scripts}/python` (highest
   priority; preserves zero-friction upgrade for v0.2.7 users)
2. `backend/engines/indextts/.venv/{bin|Scripts}/python`
3. Bootstrap: `uv venv backend/engines/indextts/.venv` +
   `uv pip install --python <python> -e ${OMNIVOICE_INDEXTTS_DIR}`

**uv discovery:** `OMNIVOICE_BUNDLED_UV` env var (Tauri-set in
production) → `shutil.which("uv")` (dev / system uv) → raise with
clear install-uv error. The Tauri side does not currently export
`OMNIVOICE_BUNDLED_UV` to the backend; the production code path
falls back to system `uv` for now. A follow-up PR in Phase 2 Wave
3 or Plan 02-04 can wire up the env var in
`frontend/src-tauri/src/lib.rs` when the launcher needs it.

## Test infrastructure

`tests/fixtures/mock_indextts_sidecar.py` exists. It implements the
IndexTTS sidecar op contract using stdlib only — no torch, no
numpy, no indextts dep. The wire protocol matches the production
sidecar byte-for-byte (length-prefixed JSON, 64 MB frame cap,
ready/ping/synthesize/shutdown/probe_env ops). Synthesize replies
with 1 s of 0.5-amp 440 Hz int16 sine wave so the parent's
`torch.max(torch.abs(audio)).item() > 0.3` assertion has signal.

The mock sidecar additionally echoes its received kwargs as
`forwarded_kwargs` in the audio reply — the unit tests use this to
assert the parent-side emotion arbitration constructed the correct
JSON payload (without needing to sniff the raw pipe).

## Threats mitigated

| ID | Mitigation |
|----|------------|
| T-02-08 (HF_TOKEN logging in sidecar) | Sidecar never logs `os.environ`; parent's stderr drain pipes through Phase 1 `HFTokenRedactor` |
| T-02-09 (`uv pip install -e` supply chain) | Accepted — install is from a user-controlled local clone; v0.4 can add hash pinning |
| T-02-10 (model-load DoS) | Sidecar emits `progress` frames at 0/50/100% during the ~20 s cold load; Compat Matrix UI will surface them |
| T-02-11 (tempfile leak) | `tempfile.NamedTemporaryFile(suffix=".wav")` + `os.unlink` in `finally`; OS reaps stragglers |

## D1 / D4 locked decisions

- `backend/services/sonitranslate.py` — **unchanged** (verified by `git diff`).
- `backend/services/gpu_sandbox.py` — **unchanged** (verified by `git diff`).

## ENGINE-XX closure mapping

| Req | Evidence |
|-----|----------|
| ENGINE-02 | `test_hf_home_marker_present_after_bootstrap` — HF cache survives bootstrap byte-for-byte; `SubprocessBackend._spawn` uses `os.environ.copy()` so HF_HOME/HF_HUB_CACHE/HF_ENDPOINT/HF_TOKEN reach the sidecar (verified by `test_env_forwarding_to_indextts_sidecar`) |
| ENGINE-03 | `IndexTTS2Backend` is now a `SubprocessBackend` subclass; `test_indextts_no_inprocess_import_attempted` proves no `import indextts.*` ever fires in the parent process |
| ENGINE-04 | `test_coexist_with_omnivoice_in_one_session` — OmniVoiceBackend + IndexTTS2Backend both serve `generate()` in the same Python interpreter |
| ENGINE-07 | `test_venv_probe_prefers_omnivoice_indextts_dir` — existing v0.2.7 users with `OMNIVOICE_INDEXTTS_DIR + .venv` reach a working generation with zero re-download and zero re-install |
