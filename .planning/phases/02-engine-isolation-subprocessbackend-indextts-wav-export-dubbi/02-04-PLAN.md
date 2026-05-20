---
phase: 02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi
plan: 04
type: execute
wave: 3
depends_on:
  - 02-01
  - 02-03
files_modified:
  - backend/api/routers/engines.py
  - backend/services/tts_backend.py
  - frontend/src/components/EngineCompatibilityMatrix.jsx
  - frontend/src/components/EngineCompatibilityMatrix.css
  - frontend/src/pages/Settings.jsx
  - frontend/src/api/engines.js
  - tests/backend/api/test_engines_route_shape.py
  - frontend/src/test/EngineCompatibilityMatrix.test.jsx
autonomous: true
requirements:
  - ENGINE-06

must_haves:
  truths:
    - "User opens Settings → Engines page and sees a table row for every registered TTS backend with install state, GPU compatibility, isolation mode (in-process or subprocess), and last error if any"
    - "Each row's isolation_mode badge reads 'in-process' for OmniVoice/VoxCPM2/MossTTSNano/KittenTTS/MLXAudio/CosyVoice and 'subprocess' for IndexTTS2 (verifies the 02-01 list_backends wrap + 02-03 IndexTTS migration end-to-end via the UI)"
    - "When an engine's is_available() returned False, the row shows the failure reason inline (not a generic 'unavailable' label)"
    - "When the last_error cache has a value, the row shows a 'Last error:' line beneath the status — this distinguishes 'currently failing' from 'failed before, now working'"
    - "Clicking 'Test engine' on a subprocess-isolated row triggers a health_check round-trip via a new GET /engines/{id}/health route → spawns the sidecar → returns pong → does not regress when called twice in a row"
  artifacts:
    - path: "backend/api/routers/engines.py"
      provides: "GET /engines (existing) returns last_error + isolation_mode; NEW GET /engines/{id}/health endpoint for the 'Test engine' button"
      contains: "isolation_mode"
    - path: "frontend/src/components/EngineCompatibilityMatrix.jsx"
      provides: "React component rendering the compatibility table; consumes /engines and /engines/{id}/health"
      min_lines: 100
      contains: "isolation_mode"
    - path: "frontend/src/api/engines.js"
      provides: "Frontend API client for /engines and /engines/{id}/health"
      min_lines: 20
    - path: "frontend/src/pages/Settings.jsx"
      provides: "Mounts the EngineCompatibilityMatrix component in the Settings → Engines tab"
      contains: "EngineCompatibilityMatrix"
    - path: "tests/backend/api/test_engines_route_shape.py"
      provides: "API contract test — /engines response shape includes last_error + isolation_mode for every entry; /engines/{id}/health round-trip"
      min_lines: 40
    - path: "frontend/src/test/EngineCompatibilityMatrix.test.jsx"
      provides: "RTL component test asserting the matrix renders the expected columns for both in-process and subprocess engines"
      min_lines: 50
  key_links:
    - from: "frontend/src/pages/Settings.jsx (Engines tab)"
      to: "frontend/src/components/EngineCompatibilityMatrix.jsx"
      via: "import + mount inside the existing Settings page tab structure"
      pattern: "import.*EngineCompatibilityMatrix"
    - from: "frontend/src/components/EngineCompatibilityMatrix.jsx"
      to: "backend/api/routers/engines.py (GET /engines)"
      via: "fetch via frontend/src/api/engines.js; renders one row per entry"
      pattern: "fetch.*engines|getEngines"
    - from: "frontend/src/components/EngineCompatibilityMatrix.jsx (Test engine button)"
      to: "backend/api/routers/engines.py (GET /engines/{id}/health)"
      via: "click handler triggers a POST or GET to the health endpoint"
      pattern: "health"
    - from: "backend/api/routers/engines.py::engine_health"
      to: "backend/services/tts_backend.py (registered backend's health_check method)"
      via: "instantiate the backend class (cached singleton) and call health_check() — works for both SubprocessBackend (real spawn+ping) and in-process backends (returns is_available result)"
      pattern: "health_check"

threat_model:
  trust_boundaries:
    - "frontend ↔ FastAPI /engines* routes (existing trust boundary — uses same loopback origin policy as other Settings routes)"
  threats:
    - id: T-02-12
      category: Information Disclosure
      component: backend/api/routers/engines.py (last_error field)
      disposition: mitigate
      mitigation: "last_error strings are formatted as 'TypeName: message' from Python exceptions. Phase 1's HFTokenRedactor logging filter does not run on FastAPI response bodies — verify last_error fields cannot leak HF tokens by ensuring the error message itself never embeds a token. Spot check: walk every TTSBackend.is_available() raise/return site; any error message that interpolates HF_TOKEN must be patched to mask the token. Add a unit test that asserts no field in /engines response matches the hf_[A-Za-z0-9]{30,} regex."
    - id: T-02-13
      category: Spoofing
      component: backend/api/routers/engines.py (GET /engines/{id}/health)
      disposition: mitigate
      mitigation: "Engine health check spawns a sidecar process — same loopback origin guard used by /system/set-env and /api/settings/hf-token (commit e1f08a6 from Phase 1) is applied here. Non-loopback origin returns 403."
    - id: T-02-14
      category: Denial of Service
      component: backend/api/routers/engines.py (GET /engines/{id}/health for subprocess engines)
      disposition: mitigate
      mitigation: "Health check round-trip times out at 30 s in the SubprocessBackend.health_check() (already implemented in 02-01) — UI cannot lock up by repeated clicks. Cooldown of 5 s in the frontend prevents click-storm."
---

<objective>
Ship the frontend Engine Compatibility Matrix that ENGINE-06 calls for — and surface, end-to-end, the data shape that 02-01's `list_backends()` wrap and 02-03's IndexTTS migration produce. Add a small `GET /engines/{id}/health` route so the matrix's "Test engine" button can spawn-and-ping a SubprocessBackend on user demand (per Open Question #2 — don't auto-spawn on every Settings render).

Purpose: ENGINE-06 is the user-facing payoff of Phase 2. Without it, ENGINE-05's per-engine status surfacing has no consumer; ENGINE-03's "IndexTTS now runs subprocess" is invisible. The matrix UI makes the architectural shift legible: users can see at a glance which engine is in-process vs subprocess, which has a recent error, and which is GPU-eligible.

Output: 1 new FastAPI route + 1 new React component + 1 small api client + tests on both sides. The matrix is mounted in the existing `Settings.jsx` Engines tab — no navigation refactor.
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
@.planning/phases/02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi/02-03-PLAN.md

@CLAUDE.md
@backend/api/routers/engines.py
@backend/services/tts_backend.py
@frontend/src/pages/Settings.jsx

<interfaces>
<!-- API contract this plan finalizes. 02-01 already added last_error + isolation_mode to GET /engines; this plan adds the health route + wires the UI. -->

```typescript
// GET /engines (existing, payload shape after 02-01)
type EngineEntry = {
  id: string;
  display_name: string;
  available: boolean;
  reason: string | null;
  install_hint: string | null;
  last_error: string | null;          // populated by 02-01's _LAST_ERRORS dict
  isolation_mode: "in-process" | "subprocess";  // populated by 02-01's issubclass check
  gpu_compat?: ("cuda" | "mps" | "rocm" | "cpu")[];  // NEW — this plan computes from class metadata
};

type EnginesResponse = {
  tts: { active: string | null, backends: EngineEntry[] };
  asr: { active: string | null, backends: EngineEntry[] };  // unchanged shape
  llm: { active: string | null, backends: EngineEntry[] };  // unchanged shape
};

// NEW: GET /engines/{id}/health
type HealthResponse = {
  id: string;
  ok: boolean;
  message: string;        // "pong" on success; failure reason on error
  latency_ms: number;     // wall-clock from spawn-or-cached to response
};
```

```javascript
// frontend/src/api/engines.js — new
export async function getEngines() { /* GET /engines */ }
export async function getEngineHealth(id) { /* GET /engines/${id}/health */ }
```

```jsx
// frontend/src/components/EngineCompatibilityMatrix.jsx — component contract
// Props: { family?: "tts" | "asr" | "llm" }  default "tts"
// Renders a table with columns:
//   Engine | Install state | GPU compat | Isolation mode | Last error | Actions (Test)
// State: { engines, loading, healthByEngine }
// Effects:
//   on mount: getEngines() → setEngines
//   on click "Test engine" for row r: getEngineHealth(r.id) → setHealthByEngine
```
</interfaces>

<existing_state>
- `backend/api/routers/engines.py:30-50` already exposes `GET /engines`, `GET /engines/tts`, `GET /engines/asr`, `GET /engines/llm`, and `POST /engines/select`. The response body for `/engines` is built by calling `tts_backend.list_backends()` etc. After 02-01, `list_backends()` already returns `last_error` and `isolation_mode` — the route forwards them unmodified because no schema transformation is in place. Confirm this by reading the existing route source; if a Pydantic response_model is declared, extend it to include the two new fields.
- `frontend/src/pages/Settings.jsx` exists and renders the Settings page. It already has tab navigation (per the file's CSS sibling). Identify the existing "Engines" tab if any — if no Engines tab exists, add one. Read the file before editing to determine the tab structure idiom (it likely uses a state-based switcher rather than react-router).
- `frontend/src/components/` does NOT yet have an `EngineCompatibilityMatrix.jsx`. This plan creates it from scratch.
- Frontend test infrastructure: `frontend/src/test/` directory likely exists; if React Testing Library + Vitest is the project's pattern, mirror it. If not, the frontend test can be skipped and the API contract test on the backend side is the gate — confirm by reading `frontend/package.json` for the existing test runner.
- `gpu_compat` is computed metadata, not stored on the backend class today. Implementation strategy: introduce a `gpu_compat` class attribute on `TTSBackend` (default `["cpu"]`) and override per backend as appropriate (OmniVoice/IndexTTS2 = `["cuda","mps","cpu"]`, KittenTTS = `["cpu"]`, etc.). The `list_backends()` wrap in 02-01 reads `getattr(cls, "gpu_compat", ["cpu"])` and adds it to the response. Per-engine accuracy is best-effort; this plan adds the attribute and reasonable defaults; phase 6 release notes can refine.
- The existing `health_check()` method on `SubprocessBackend` (shipped in 02-01) spawns the sidecar if not running and round-trips a ping. For in-process backends (TTSBackend subclasses that aren't SubprocessBackend), there is no `health_check` — fallback is to call `is_available()` and report the result. Implement this routing in the new endpoint.
- Loopback origin guard: Phase 1 added a helper for `/system/set-env` and reused it for `/api/settings/hf-token`. Reuse the same helper for `GET /engines/{id}/health`. The helper signature is approximately `def assert_loopback_origin(request: Request) -> None` raising HTTP 403 on a non-loopback host — verify the exact name in Phase 1's actual implementation.
</existing_state>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Backend route GET /engines/{id}/health + gpu_compat attribute + response shape extension</name>
  <files>backend/api/routers/engines.py, backend/services/tts_backend.py, tests/backend/api/test_engines_route_shape.py</files>
  <behavior>
    `tests/backend/api/test_engines_route_shape.py`:
    - `test_engines_response_includes_new_fields`: TestClient.get("/engines") → assert every entry in `tts.backends` has keys `id, display_name, available, reason, install_hint, last_error, isolation_mode, gpu_compat`.
    - `test_indextts2_entry_has_subprocess_isolation_mode`: TestClient.get("/engines") → find the indextts2 row → `isolation_mode == "subprocess"`. (Cross-checks 02-03's migration via the API surface.)
    - `test_omnivoice_entry_has_in_process_isolation_mode`: same check for "omnivoice" → `isolation_mode == "in-process"`.
    - `test_engine_health_subprocess_success`: monkeypatch `IndexTTS2Backend.health_check` to return `(True, "pong")` (avoid real spawn in CI) → TestClient.get("/engines/indextts2/health") → 200, body has `ok=True`, `message="pong"`, `latency_ms` is a number.
    - `test_engine_health_in_process_falls_back_to_is_available`: TestClient.get("/engines/omnivoice/health") → 200, body has `ok==<whatever is_available returned>`, `message==<the second tuple element>`.
    - `test_engine_health_unknown_id`: TestClient.get("/engines/does_not_exist/health") → 404.
    - `test_engine_health_loopback_only`: send the health request with `Host: 10.0.0.5:3900` → 403 (reuses Phase 1 loopback guard).
    - `test_no_hf_token_leak_in_engines_response`: register a backend whose `is_available()` returns `(False, "auth failed for hf_abcdef0123456789012345678901234567890")` → TestClient.get("/engines") → assert no value in the entire response body matches `hf_[A-Za-z0-9]{30,}` regex (T-02-12). The backend MUST run the response through Phase 1's HFTokenRedactor BEFORE serializing — or mask tokens at the source. Resolution: add a `_mask_hf_tokens(s: str) -> str` helper inside `tts_backend.py::list_backends` that applies the same regex to `reason` and `last_error` fields, replacing matches with `hf_***REDACTED***`.
  </behavior>
  <action>
    Step 1 — Edit `backend/services/tts_backend.py`:
      - Add `gpu_compat: tuple[str, ...] = ("cpu",)` as a class attribute on the abstract `TTSBackend` base class (line ~34).
      - Override on each in-tree backend with reasonable defaults — best-effort:
        - `OmniVoiceBackend.gpu_compat = ("cuda", "mps", "cpu")`
        - `VoxCPM2Backend.gpu_compat = ("cuda", "cpu")`
        - `MossTTSNanoBackend.gpu_compat = ("cuda", "cpu")`
        - `KittenTTSBackend.gpu_compat = ("cpu",)` (ONNX CPU-only path)
        - `MLXAudioBackend.gpu_compat = ("mps", "cpu")`
        - `CosyVoiceBackend.gpu_compat = ("cuda", "cpu")`
        - `IndexTTS2Backend.gpu_compat = ("cuda", "mps", "cpu")` (subprocess, but the sidecar itself uses GPU when available)
      - Extend `list_backends()` (the wrap from 02-01) to include `"gpu_compat": list(getattr(cls, "gpu_compat", ("cpu",)))` in the response entry.
      - Add a `_HF_TOKEN_MASK_RE = re.compile(r"hf_[A-Za-z0-9]{30,}")` module-level regex and apply it inside `list_backends()` to the `reason` and `last_error` strings before serialization (T-02-12). Replacement string: `"hf_***REDACTED***"`.

    Step 2 — Edit `backend/api/routers/engines.py`:
      - Add new route `GET /engines/{family}/{engine_id}/health` — family is `tts|asr|llm`, engine_id is the backend's `id`. Reduce ambiguity in case two families have overlapping ids; if URL collision is acceptable, the simpler form `GET /engines/{engine_id}/health` works because TTS/ASR/LLM ids today don't collide. Pick the simpler form unless the existing route file already namespaces by family.
      - Implementation:
        ```python
        from time import perf_counter
        from backend.api.routers.system import assert_loopback_origin  # or wherever Phase 1 placed the helper
        from backend.services import tts_backend, asr_backend, llm_backend

        @router.get("/engines/{engine_id}/health")
        async def engine_health(engine_id: str, request: Request, _: None = Depends(assert_loopback_origin)):
            # Resolve the backend class from any of the three registries
            for registry in (tts_backend._REGISTRY, asr_backend._REGISTRY, llm_backend._REGISTRY):
                cls = registry.get(engine_id)
                if cls is not None:
                    break
            else:
                raise HTTPException(status_code=404, detail=f"unknown engine id: {engine_id}")

            t0 = perf_counter()
            if hasattr(cls, "health_check"):
                # SubprocessBackend path — spawn sidecar (if not already) and ping
                try:
                    instance = _get_engine_instance(cls)  # cached singleton (see Step 3)
                    ok, msg = instance.health_check()
                except Exception as e:
                    ok, msg = False, f"{type(e).__name__}: {e}"
            else:
                # In-process backend — just call is_available
                try:
                    ok, msg = cls.is_available()
                except Exception as e:
                    ok, msg = False, f"{type(e).__name__}: {e}"

            latency_ms = (perf_counter() - t0) * 1000
            return {"id": engine_id, "ok": ok, "message": msg, "latency_ms": latency_ms}
        ```

    Step 3 — Add an engine-instance singleton cache inside engines.py (or `tts_backend.py` if more appropriate). For each `SubprocessBackend` subclass, instantiate once and reuse — the SubprocessBackend's `__init__` registers atexit cleanup, so reusing a singleton is the right move (multiple `IndexTTS2Backend()` instances would spawn multiple sidecars). Implementation:
      ```python
      _ENGINE_INSTANCES: dict[type, TTSBackend] = {}
      def _get_engine_instance(cls):
          if cls not in _ENGINE_INSTANCES:
              _ENGINE_INSTANCES[cls] = cls()
          return _ENGINE_INSTANCES[cls]
      ```
      Verify this aligns with how `tts_backend.py` currently instantiates backends for `/api/tts/generate` — if there's already a singleton pattern, reuse it; if not, this is the introduction point.

    Step 4 — Write `tests/backend/api/test_engines_route_shape.py`:
      - Use `from fastapi.testclient import TestClient` + the app factory.
      - For `test_engine_health_subprocess_success`, monkeypatch `IndexTTS2Backend.health_check` to return `(True, "pong")` (so no real spawn happens in CI).
      - For `test_no_hf_token_leak_in_engines_response`, register a temporary backend with a tainted error message; serialize; walk the response JSON looking for the hf_ regex. Assert zero matches.
      - For `test_engine_health_loopback_only`, set the `Host:` header to a non-loopback value (e.g. `10.0.0.5:3900`) and assert 403.
  </action>
  <verify>
    <automated>uv run pytest tests/backend/api/test_engines_route_shape.py -x -v --timeout=30</automated>
  </verify>
  <done>
    All 8 tests in `test_engines_route_shape.py` pass. `GET /engines` returns the extended shape with `last_error`, `isolation_mode`, and `gpu_compat` for every entry. `GET /engines/{id}/health` round-trips for both subprocess and in-process backends, with loopback enforcement and HF-token masking verified.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Frontend EngineCompatibilityMatrix component + Settings tab wiring</name>
  <files>frontend/src/api/engines.js, frontend/src/components/EngineCompatibilityMatrix.jsx, frontend/src/components/EngineCompatibilityMatrix.css, frontend/src/pages/Settings.jsx, frontend/src/test/EngineCompatibilityMatrix.test.jsx</files>
  <behavior>
    `frontend/src/test/EngineCompatibilityMatrix.test.jsx`:
    - `renders rows from mocked /engines response`: mock `getEngines` to return 3 backends (1 in-process available, 1 in-process unavailable with last_error, 1 subprocess available) → render → table has 3 rows → row 1 shows "in-process" badge + "Available" → row 2 shows "in-process" + "Unavailable" + the failure reason → row 3 shows "subprocess" + "Available".
    - `clicking Test on a row calls getEngineHealth(id) and shows latency`: mock `getEngineHealth` to return `{ok:true, message:"pong", latency_ms: 1234}` → click "Test" button on row 3 → assert button transitions to "Testing…" then displays "1234 ms" or similar.
    - `Test button is disabled during inflight request`: mock `getEngineHealth` to return a promise that doesn't resolve → click → button is disabled → click again has no effect.
    - `gpu_compat chips render correctly`: backend returns `gpu_compat: ["cuda","mps","cpu"]` → row shows three chips/badges with those labels.
    - `last_error displays in red text below status` (assert by class name / text content rather than color literal).
  </behavior>
  <action>
    Step 1 — Create `frontend/src/api/engines.js`:
      - `export async function getEngines() { const r = await fetch('/engines'); if (!r.ok) throw new Error(...); return r.json(); }`
      - `export async function getEngineHealth(id) { const r = await fetch(\`/engines/${id}/health\`); if (!r.ok) throw new Error(...); return r.json(); }`
      - If the project has a centralized `apiBase` (per Phase 1's INST-12 / Docker LAN fix), import from there. If `apiBase.ts` doesn't exist yet (Phase 1 is still landing), use relative URLs and document the dependency in SUMMARY.

    Step 2 — Create `frontend/src/components/EngineCompatibilityMatrix.jsx`:
      - Functional component with hooks. Props: `{ family = "tts" }`.
      - State: `const [engines, setEngines] = useState([]); const [loading, setLoading] = useState(true); const [healthByEngine, setHealthByEngine] = useState({});`
      - Effect on mount: `getEngines().then(data => setEngines(data[family].backends))`.
      - Render an HTML `<table>` with columns: Engine, Install state, GPU compat, Isolation mode, Last error, Actions.
      - For each row:
        - Engine: `display_name`
        - Install state: ✅ Available | ❌ Unavailable (with `reason` as a tooltip or inline text below)
        - GPU compat: render each entry of `gpu_compat` as a small chip/badge
        - Isolation mode: render `isolation_mode` as a colored badge (subprocess = blue, in-process = gray) — purely visual, no functional dependency
        - Last error: if `last_error` non-null, render in a dimmer/red text below the install state
        - Actions: `<button onClick={() => testHealth(row.id)}>Test engine</button>` — disabled while inflight; on response, render `{health.latency_ms}ms — {health.message}` next to the button
      - `testHealth(id)`: optimistically set `healthByEngine[id] = {inflight: true}`, then call `getEngineHealth(id)` → update with result. On error, surface the error message in the cell.
      - Use semantic HTML and ARIA roles for the table — RTL queries by role should work.

    Step 3 — Create `frontend/src/components/EngineCompatibilityMatrix.css` with minimal styling. Match the existing Settings page's CSS idiom (read `frontend/src/pages/Settings.css` first to align on color tokens, font sizes, spacing). The matrix is a table; the badges are inline-block with rounded corners. No animation; no theme system.

    Step 4 — Edit `frontend/src/pages/Settings.jsx`:
      - Identify the existing tab structure. If there's already an "Engines" tab, replace its content with `<EngineCompatibilityMatrix family="tts" />`. If there's no Engines tab, add one to the tab list AND a tab panel for it. Preserve the existing Settings tabs (API Keys from Phase 1, Privacy from Phase 5, etc. — whichever exist).
      - Add the import: `import EngineCompatibilityMatrix from '../components/EngineCompatibilityMatrix.jsx';`

    Step 5 — Write `frontend/src/test/EngineCompatibilityMatrix.test.jsx`:
      - Use whatever testing library the project uses (Vitest + React Testing Library is the most likely — verify via `grep -l "vitest\\|jest" frontend/package.json`).
      - Mock `getEngines` and `getEngineHealth` via `vi.mock('../api/engines.js')` or jest equivalent.
      - Cover all 5 behaviors listed in `<behavior>`.

    Step 6 — Verify the manual smoke path: boot the backend + frontend dev server → navigate to Settings → Engines tab → see the matrix populated → click "Test engine" on IndexTTS2 row (assumes a working install, otherwise the row shows "Unavailable" with the docs link in reason — also acceptable). Document the smoke path in SUMMARY.
  </action>
  <verify>
    <automated>cd frontend && bun test src/test/EngineCompatibilityMatrix.test.jsx 2>&1 | tail -20; cd .. ; echo "--- Lint check ---"; cd frontend && bun run lint -- src/components/EngineCompatibilityMatrix.jsx src/pages/Settings.jsx 2>&1 | tail -20 ; cd ..</automated>
  </verify>
  <done>
    Frontend tests pass (or if the project uses a non-bun test runner, substitute the equivalent command and document in SUMMARY). The Engines tab in Settings.jsx renders the matrix with all in-tree backends. Test button works on at least one subprocess-isolated entry. Lint clean.
  </done>
</task>

</tasks>

<verification>
  After both tasks:
  - Backend: `uv run pytest tests/backend/api/test_engines_route_shape.py -x --timeout=30` → all green
  - Frontend: `cd frontend && bun test src/test/EngineCompatibilityMatrix.test.jsx` → all green (or project equivalent)
  - Manual smoke: boot backend + frontend (`bun desktop-dev` or equivalent) → navigate to Settings → Engines → see one row per registered backend → click Test on any row → see latency_ms reported
  - `curl http://localhost:3900/engines | jq '.tts.backends[0] | keys'` → contains "isolation_mode", "last_error", "gpu_compat"
  - `curl http://localhost:3900/engines/indextts2/health` (loopback only) → returns ok/message/latency_ms
  - Cross-platform: matrix renders identically on macOS, Windows, Linux dev environments
</verification>

<success_criteria>
1. ENGINE-06 closed: a user opens Settings → Engines and sees the compatibility matrix with install state, GPU compatibility, isolation mode, and last-error columns populated for every backend.
2. The matrix surfaces the architectural shift made invisible by the underlying changes: IndexTTS2 now displays "subprocess" — the only such row — making the Phase 2 keystone visible to users without reading the changelog.
3. "Test engine" health-check button gives users a way to verify a subprocess engine is alive without running a real generation. Spawn cost (≤30 s for cold IndexTTS load) is borne only when the user explicitly asks.
4. HF token leakage is masked: `_HF_TOKEN_MASK_RE` in `list_backends()` and the test gate (`test_no_hf_token_leak_in_engines_response`) prove no `hf_*` token can reach the frontend through this API surface.
5. Loopback-only enforcement on `/engines/{id}/health` prevents an external attacker from triggering sidecar spawns via the API.
6. Cross-platform parity: the UI renders identically on all three OSes; the backend route works identically.
</success_criteria>

<output>
Create `.planning/phases/02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi/02-04-SUMMARY.md` when done. Include:
- Whether an "Engines" tab existed in Settings.jsx or was added by this plan
- The exact frontend test runner command used (so Phase 6 release notes can list it for the CI matrix)
- gpu_compat defaults assigned to each in-tree backend — flag any that are best-guess (e.g. CosyVoice's MPS path) for future verification
- Confirmation that the new `_HF_TOKEN_MASK_RE` redaction in list_backends() passes the leak test
- Note that INST-13 (dictation-widget Settings checkbox) is NOT included in this plan — per the user-locked Phase 2 requirement scope (8 IDs: ENGINE-01..07 + BUG-01). If a future plan adds INST-13, it will mount in the same Settings.jsx file structure this plan establishes.
</output>
</content>
</invoke>