# Plan 02-04 — Engine Compatibility Matrix API + UI (SUMMARY)

**Status:** delivered. Branch `phase-2-plan-02-04-engine-compat-matrix`; PR
pending. Closes ENGINE-06.

## What landed

### Backend
- `backend/services/tts_backend.py`
  - `gpu_compat: tuple[str, ...]` class attribute on `TTSBackend` (default
    `("cpu",)`) and per-backend overrides (see table below).
  - `_HF_TOKEN_MASK_RE` + `_mask_hf_tokens()` — runtime regex redaction
    applied to `reason` and `last_error` fields inside `list_backends()`
    before serialization. Closes **T-02-12** without depending on the
    logging-level `HFTokenRedactor`.
  - `list_backends()` now emits `gpu_compat: list[str]` on every entry
    and runs the new redactor.
- `backend/api/routers/engines.py`
  - **New** `GET /engines/{engine_id}/health` — loopback-gated (T-02-13).
    Resolves the backend across tts/asr/llm registries; calls
    `SubprocessBackend.health_check()` (spawn-and-ping) for subprocess
    engines or falls back to `is_available()` for in-process ones.
    Returns `{ id, ok, message, latency_ms }`. Never 500s on a sick
    engine — exceptions land in the response body. Unknown id → 404.
  - `_ENGINE_INSTANCES: dict[type, object]` cache + `_get_engine_instance`
    helper so repeated health checks reuse one singleton per class.
    Avoids leaking atexit hooks / spawning extra sidecars.

### Frontend
- `frontend/src/components/EngineCompatibilityMatrix.jsx` (~270 lines).
  Semantic `<table>` with role-attributes for RTL. Columns: Engine /
  Install state / GPU compat / Isolation / Actions. "Test engine"
  button does NOT auto-spawn on mount; 5 s cooldown prevents
  click-storms. Optional `onSelect` prop turns the matrix into a
  picker so Settings doesn't need a parallel table.
- `frontend/src/components/EngineCompatibilityMatrix.css` — minimal
  styling reusing existing chrome tokens; per-GPU chip colors.
- `frontend/src/api/engines.ts` — `getEngineHealth(id)` client.
- `frontend/src/api/types.ts` — `EngineBackend` extended with the four
  new optional fields; new `EngineHealthResponse` type.
- `frontend/src/pages/Settings.jsx` — replaces the hand-rolled engines
  table in `EnginesTab` with `<EngineCompatibilityMatrix family="tts"
  onSelect={selectEngine wrapper} />`. Drops the now-dead `FAMILY_META`
  local map and unused `listEngines` / `Mic` / `MessageSquare` imports.
  **No new Settings tab added** — an "Engines" tab already existed
  (Phase 3 / 4.6), so the matrix is mounted into the existing tab
  rather than duplicating navigation.

### Tests
- `tests/backend/api/test_engines_route_shape.py` (new, 11 tests):
  1. `/engines` response includes the new fields on every TTS entry
  2. IndexTTS2 isolation_mode == "subprocess"
  3. OmniVoice isolation_mode == "in-process"
  4. OmniVoice gpu_compat == {"cuda", "mps", "cpu"}
  5. Health subprocess path (mocked) returns ok/pong/latency_ms
  6. Health in-process path falls back to is_available
  7. Unknown engine id → 404
  8. Non-loopback origin → 403 (T-02-13)
  9. Engine instance cache reuses singleton across 2 calls
  10. HF tokens in `is_available()` errors don't leak into `/engines`
  11. HF tokens in `health_check()` errors don't leak into
      `/engines/{id}/health`
- `tests/backend/services/test_tts_backend_registry.py::test_list_backends_shape`
  — updated `required` keyset to include `gpu_compat`.
- `frontend/src/test/EngineCompatibilityMatrix.test.jsx` (new, 8 tests):
  1. Renders one row per backend with documented columns
  2. isolation_mode badge visible per row
  3. GPU compat chips render the expected per-engine subset
  4. Unavailable rows render the failure reason inline
  5. last_error line renders below status; masked sentinel preserved
  6. Test click fires getEngineHealth(id) + renders latency_ms
  7. Test button disabled while inflight; 2nd click no-op
  8. Failure path (ok=false) renders a failure marker

## Test results
- **Backend (`uv run pytest tests/ -q --ignore=tests/manual`):**
  **402 passed, 10 skipped, 13 xfailed, 1 xpassed** (was 391+ pre-plan).
- **Frontend (`bun run test`, runs `vitest run`):** **65 passed** (8 new).
- **Frontend lint:** No new errors introduced. Settings.jsx pre-existing
  lint count went from 5 → 4 (removed an unused-vars warning).
- **Frontend typecheck (`bun run typecheck:ci`):** clean.

## gpu_compat defaults — per-engine assignments

| Engine        | gpu_compat              | Confidence |
|---------------|-------------------------|------------|
| OmniVoice     | cuda, mps, cpu          | HIGH       |
| VoxCPM2       | cuda, mps, cpu          | HIGH       |
| MOSS-TTS-Nano | cuda, cpu               | HIGH       |
| KittenTTS     | cpu                     | HIGH (ONNX CPU graph) |
| MLX-Audio     | mps, cpu                | HIGH       |
| **CosyVoice** | cuda, cpu               | **MEDIUM** — MPS support not verified upstream; flagged for Phase 6 confirmation |
| IndexTTS2     | cuda, mps, cpu          | HIGH (subprocess uses sidecar's GPU) |
| GPT-SoVITS    | cuda, cpu               | MEDIUM (whatever the external API server uses) |
| Sherpa-ONNX   | cuda, cpu               | MEDIUM (CUDA provider available on Linux/Windows) |

**Recommend Phase 6** verify CosyVoice MPS / Sherpa-ONNX CUDA matrix
when the release notes pass; these are stack-research-based, not
empirically verified on hardware.

## Frontend test runner command (for Phase 6 CI matrix)

```bash
cd frontend && bun run test                 # full suite via vitest
cd frontend && bun run test:watch            # vitest --watch
```

Note: **`bun test`** runs Bun's built-in test runner, which does **not**
set up jsdom. The component tests require `bun run test` (which invokes
`vitest run` per package.json scripts). Document this in the README + CI
config so contributors don't hit "ReferenceError: document is not defined".

## HF-token redaction proof
The new `test_no_hf_token_leak_in_engines_response` and
`test_no_hf_token_leak_in_health_response` tests register a synthetic
backend whose `is_available()` / `health_check()` embed a real
`hf_abcdefghijklmnopqrstuvwxyz01234567890abcd` string in the error
message, then assert the regex `hf_[A-Za-z0-9]{30,}` matches **zero
substrings** anywhere in the response body — and that the
`hf_***REDACTED***` sentinel appears in its place. T-02-12 mitigated.

## Scope notes
- **INST-13** (dictation-widget Settings checkbox) is **NOT** included
  in this plan, per the locked Phase 2 8-ID scope (ENGINE-01..07 +
  BUG-01). The matrix mounts inside the existing `EnginesTab` of
  `Settings.jsx`; if a future plan adds INST-13 it will mount in the
  same tab structure established here.
- **ASR/LLM family extension:** `list_backends()` in `backend/services/
  asr_backend.py` and `backend/services/llm_backend.py` was NOT
  extended with the new fields. Reasoning: the plan's
  `must_haves.truths` and `success_criteria` focus on the TTS matrix
  (where the IndexTTS2 isolation_mode payoff lives). The frontend
  component types these fields as optional (`?: ...`) so the matrix
  still renders for ASR/LLM families on the simpler payload — only
  the `Isolation` and `GPU compat` columns degrade gracefully (fall
  back to defaults). Extending ASR/LLM is a one-line refactor when
  a future plan needs it.

## Manual smoke path
1. `bun desktop-dev` (Tauri) OR `bun --filter frontend dev` + `uv run python -m backend.main`.
2. Navigate to **Settings → Engines**.
3. See one row per registered backend with install state, GPU chips,
   isolation badge.
4. Click **Test engine** on any row.
   - Available in-process row → latency_ms appears (single-digit ms).
   - IndexTTS2 row (if installed) → spawns the sidecar (≤30 s cold),
     returns `pong` + latency. Click again within 5 s → ignored (cooldown).
5. `curl http://127.0.0.1:3900/engines | jq '.tts.backends[0] | keys'` →
   shows `available, display_name, gpu_compat, id, install_hint,
   isolation_mode, last_error, reason`.
6. `curl http://127.0.0.1:3900/engines/omnivoice/health` → returns
   ok/message/latency_ms in well under 1 s.
