# Architecture Patterns — OmniVoice Studio Stabilization Milestone

**Domain:** Multi-engine, local-first ML desktop app (Python backend + React frontend + Tauri shell + PyInstaller-bundleable sidecar)
**Researched:** 2026-05-16
**Scope:** Architecture for *additions to an existing brownfield codebase*. No re-architecture; new capabilities must compose with what is already there.

> **Reading guide:** The Tauri shell owns first-launch bootstrap and OS integration. The FastAPI backend owns ML pipelines, persistence, and engine selection. The React frontend is a thin client that mostly reads/writes through `backend/api/routers/*`. State lives in three places: SQLite (`omnivoice.db`), `prefs.json` (UI choices), `~/.config/omnivoice/env` (durable env vars loaded by `main.py`). Tauri keeps its own config in `app_local_data_dir/config.json`.

---

## 1. Existing Architecture — What's Already There

The four-layer model the milestone must integrate into:

```
┌────────────────────────────────────────────────────────────────────┐
│  Layer 4: Tauri Shell (frontend/src-tauri/src/*.rs, ~1.4 kLOC)     │
│  - bootstrap.rs:  uv venv + uv sync (first-run, retry, clean)      │
│  - backend.rs:    spawn backend subprocess, port probe, log paths  │
│  - commands.rs:   IPC commands (sysinfo, log tail, HF cache scan,  │
│                   simulate_paste, tray, dictation hotkey)          │
│  - config.rs:     persistent app config (region, shortcut)         │
│  - tools.rs:      sidecar discovery (uv, ffmpeg, ffprobe)          │
│  Plugins: log, dialog, updater, single-instance, global-shortcut,  │
│           window-state, opener, process                            │
├────────────────────────────────────────────────────────────────────┤
│  Layer 3: React Frontend (frontend/src/, Zustand store)             │
│  - pages/Settings.jsx, SetupWizard.jsx, Launchpad.jsx, …           │
│  - components/{ErrorBoundary, BootstrapSplash, LogsFooter, …}      │
│  - store/{prefsSlice, uiSlice, dubSlice, …}                         │
│  - api/{system,setup,engines,…}.ts  → HTTP/WebSocket clients       │
├────────────────────────────────────────────────────────────────────┤
│  Layer 2: FastAPI Backend (backend/, ~25 routers, 97 endpoints)    │
│  - main.py:         lifespan, global exception handler →           │
│                     CRASH_LOG_PATH                                  │
│  - api/routers/:    HTTP surface (thin)                            │
│  - services/:       business logic + ML pipelines                  │
│    • tts_backend.py:  TTSBackend ABC + _REGISTRY (6 engines)       │
│    • gpu_sandbox.py:  multiprocessing subprocess for TTS gen       │
│    • model_manager.py: torch model singleton, GPU pool             │
│    • dub_pipeline.py, batched_tts.py, …                             │
│  - core/:           cross-cutting (config, db, prefs, event_bus,   │
│                     job_queue, onboarding, tasks)                  │
│  - hooks/:          PyInstaller runtime hooks (numpy, torch.compile)│
├────────────────────────────────────────────────────────────────────┤
│  Layer 1: ML Model Layer (omnivoice/ + external engine packages)    │
│  - omnivoice/models/omnivoice (vendored)                           │
│  - External (installed into the SAME venv):                        │
│      whisperx, faster-whisper, demucs, pyannote, audioseal,         │
│      kittentts, voxcpm, moss_tts_nano, mlx-audio, cosyvoice, …     │
└────────────────────────────────────────────────────────────────────┘

State stores:
  • SQLite          omnivoice.db        voice_profiles, jobs, projects
  • prefs.json      DATA_DIR/prefs.json UI choices (atomic write)
  • env file        ~/.config/omnivoice/env  durable HF_TOKEN etc.
  • Tauri config    app_local_data_dir/config.json  region, shortcut
  • crash log       DATA_DIR/crash_log.txt  unhandled exception trail
  • rolling log     DATA_DIR/omnivoice.log  2 MB × 3, JSON-optional
  • Tauri log       Library/Logs/<bid>/tauri.log  Rust log output
```

**Existing patterns to imitate (not re-invent):**

| Pattern | Where | Why it matters for this milestone |
|---------|-------|-----------------------------------|
| `TTSBackend` ABC + `is_available()` gate | `backend/services/tts_backend.py:34` | Supertonic-3 plugs in here. The `is_available()` cleanup-fail pattern keeps the engine picker honest. |
| `prefs.resolve(key, env=..., default=...)` | `backend/core/prefs.py:67` | Env > prefs.json > default. Use this for bug-report opt-in flag. |
| Atomic JSON write via tempfile + os.replace | `backend/core/prefs.py:38-54` | Reuse for any new on-disk state. |
| `gpu_sandbox.sandboxed_generate()` | `backend/services/gpu_sandbox.py` | Already proven multiprocessing pattern for crash isolation — Supertonic-3 isolation can reuse the same primitive, not invent a new one. |
| Global exception handler → `CRASH_LOG_PATH` | `backend/main.py:326-356` | Bug-report subsystem hooks here, not at every route. |
| Tauri `emit_log` ring buffer | `frontend/src-tauri/src/bootstrap.rs:58-67` | Splash log replay. Mirror this pattern for the bug-report log buffer. |
| `core/onboarding.py` first-run seed | `backend/core/onboarding.py` | Where to add bug-report consent prompt on first launch. |
| `~/.config/omnivoice/env` dotenv | `backend/main.py:14-22` | Durable env-var sink. HF_TOKEN persistence already half-built here. |
| `tauri.conf.json` region → `HF_ENDPOINT` mirror | `frontend/src-tauri/src/backend.rs:168-175` | Mirror-fallback wiring point for #60/#57 already exists. |

**Anti-patterns to NOT introduce:**

- Adding a new SQLite table when `prefs.json` suffices.
- Adding a third config file when `prefs.json` or `~/.config/omnivoice/env` covers the use case.
- Catching exceptions inside route handlers when `global_exception_handler` already does it.
- Spawning a fresh subprocess pool when `gpu_sandbox` already has one.
- Adding a Sentry SDK with a remote DSN (violates local-first constraint).

---

## 2. Subsystem Designs

### 2.1 Bug Reporting Subsystem

**Question recap:** Python layer or Tauri layer? Both, with one consumer.

**Recommended structure (3 producers → 1 consumer → 1 emitter):**

```
┌───────────────────────┐
│ Python: errors        │   global_exception_handler (already exists,
│  main.py exc handler  │──►  main.py:326) — append to CRASH_LOG_PATH
│  logger.exception()   │     + ring buffer; no behavior change
└───────────────────────┘
┌───────────────────────┐
│ Tauri Rust: panics    │   std::panic::set_hook installed in lib.rs::run()
│  set_hook + Result    │──►  before tauri::Builder — write to
│  command errors       │     Library/Logs/<bid>/panics.log
└───────────────────────┘                       │
┌───────────────────────┐                       │
│ React: ErrorBoundary  │   Existing ErrorBoundary (frontend/src/        │
│  console.error tap    │──►  components/ErrorBoundary.jsx) → POST to    │
│  window.onerror       │     /system/report/event (new endpoint)         │
└───────────────────────┘                       │
                                                ▼
                              ┌──────────────────────────────────┐
                              │ Bug Report Aggregator (NEW)       │
                              │ backend/services/bug_report.py    │
                              │                                   │
                              │ - Buffer: last N events from each  │
                              │   source (in-memory + on-disk     │
                              │   fallback at DATA_DIR/reports/)   │
                              │ - Redact: HF_TOKEN, paths→~        │
                              │ - Bundle: sysinfo, engines, last   │
                              │   100 log lines, crash_log tail    │
                              └─────────────┬────────────────────┘
                                            │
                                            ▼
                              ┌──────────────────────────────────┐
                              │ Report Submitter (opt-in only)    │
                              │ backend/api/routers/feedback.py   │
                              │                                   │
                              │ POST /feedback/preview            │
                              │   → returns sanitized JSON for    │
                              │     user review                   │
                              │ POST /feedback/submit             │
                              │   → opens GitHub issue URL via    │
                              │     tauri-plugin-opener with the  │
                              │     prefilled `?title=&body=`     │
                              │     query string                  │
                              └──────────────────────────────────┘
```

**Where each piece lives:**

| Piece | Path | New/Existing |
|-------|------|--------------|
| Rust panic hook | `frontend/src-tauri/src/lib.rs` (top of `run()`) | NEW (~20 lines) |
| Panic log file | `Library/Logs/<bid>/panics.log` | NEW path, reuses tauri log dir resolver in `commands.rs::tauri_log_path` |
| Backend ingest endpoint | `backend/api/routers/feedback.py` (NEW router) | NEW |
| Aggregator service | `backend/services/bug_report.py` | NEW (~150 lines) |
| Frontend trigger UI | `frontend/src/pages/Settings.jsx` (new "Help & Feedback" tab) | NEW |
| Consent flag storage | `prefs.json` key `bug_report_consent: bool` | reuse `core/prefs.py` |
| First-run consent prompt | `frontend/src/components/BootstrapSplash.jsx` end-of-bootstrap step | extend existing component |

**Why opt-in consent lives in `prefs.json`, not DB or Tauri config:**

- `prefs.json` is process-agnostic — backend reads it directly without an IPC round-trip.
- `core/prefs.py::resolve()` already gives us env-var override (`OMNIVOICE_BUG_REPORT=0` lets a corporate user disable it via shell).
- DB row would require schema migration + alembic gate before any opt-in logic ships.
- Tauri config is the wrong place — backend can't read it without IPC, and the report bundle is *built* in the backend.

**Data flow — submit path:**

```
User clicks "Send bug report"  (Settings UI)
  │
  ▼
GET /feedback/preview          (backend builds redacted bundle)
  │
  ▼
Modal: shows JSON preview      (user can edit / cancel)
  │
  ▼
POST /feedback/submit          (backend serializes to GitHub
  │                             issue body, returns prefilled URL)
  ▼
tauri-plugin-opener opens      (NO direct POST from app — user
GitHub issue create page       must click "Submit" in browser,
with ?title=&body=&labels=     keeping the local-first promise)
```

**Why no third-party endpoint (and no Sentry):**
- Project Constraint: "auto bug reporting (new addition) must be **opt-in**, must submit only to GitHub Issues (no third-party telemetry endpoint)."
- Sentry SDK requires DSN → remote ingest server. Self-hosted Sentry is a separate service the user shouldn't have to run.
- Routing through the user's browser to GitHub means the user's GitHub session authenticates the submission — no app credentials, no API token in the binary.

**State / data:**
- In-memory ring buffer: last 200 events across Python+Tauri+JS, sized at ~256 KB.
- Disk spill: `DATA_DIR/reports/<timestamp>.json` for the last 10 reports (rotating).
- Consent: single boolean in `prefs.json`.

---

### 2.2 HF Token Persistence

**Question recap:** Where's the boundary between frontend UI, backend env-var management, and child-process inheritance?

**Current state (incomplete):**
- `main.py:14-22` loads `~/.config/omnivoice/env` via dotenv on startup. ✓
- `system.py:510-535` has `POST /system/set-env` that mutates `os.environ` for the running process. ✓
- **Missing:** Writing back to `~/.config/omnivoice/env` so the value survives a restart.
- **Missing:** Forwarding HF_TOKEN to child processes (e.g., `gpu_sandbox` worker subprocess, future Supertonic-3 subprocess).

**Recommended structure:**

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend: Settings → API Keys                                    │
│ - Input field (masked) + "Save"                                   │
│ - Calls POST /system/env { key: "HF_TOKEN", value, persist: true } │
└───────────────────────┬─────────────────────────────────────────┘
                        │ (HTTPS to localhost:3900)
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ backend/services/env_store.py  (NEW, ~80 lines)                  │
│                                                                  │
│  set_env(key, value, *, persist: bool) -> None                    │
│    1. os.environ[key] = value          (running process)         │
│    2. if persist:                                                 │
│         atomic_write(~/.config/omnivoice/env, KEY=value)         │
│    3. publish to event_bus → reload subscribers                   │
│                                                                  │
│  get_env(key) -> Optional[str]                                    │
│  list_env() -> dict (redacted to masked values)                   │
│                                                                  │
│  ALLOWED_KEYS = {"HF_TOKEN", "TRANSLATE_API_KEY",                 │
│                   "OPENAI_API_KEY", "GROQ_API_KEY"}              │
│                                                                  │
│  File is mode 0600 — owner read/write only.                       │
└──────────────┬──────────────────────────────────────────────────┘
               │ subscribes
               ▼
┌─────────────────────────────────────────────────────────────────┐
│ Child-process inheritance                                         │
│                                                                  │
│ - gpu_sandbox.py spawns multiprocessing.Process → inherits         │
│   parent os.environ automatically. No code change needed.         │
│                                                                  │
│ - Future per-engine subprocess (Supertonic-3, IndexTTS): the       │
│   spawning helper must call os.environ.copy() then add engine-     │
│   specific overrides. env_store.snapshot_for_child() returns       │
│   the filtered dict.                                              │
│                                                                  │
│ - Tauri-launched backend: env_store writes ~/.config/omnivoice/env │
│   on shutdown signal too, so next Tauri spawn picks it up via      │
│   main.py:14-22's dotenv.load_dotenv().                            │
└─────────────────────────────────────────────────────────────────┘
```

**Why not write to the user's shell rc file (~/.zshrc, etc.)?**
- Modifying shell rc files is a hostile install behavior — tools that do it are correctly distrusted.
- Tauri-launched processes don't source shell rc anyway (no interactive shell in between).
- `~/.config/omnivoice/env` is the cleanest contract: app-owned, dotenv-format, ignored if missing.

**Boundary:** the *frontend* never touches files. The *backend* owns the dotenv file. The *Tauri shell* doesn't read env vars from disk — it just spawns the backend, which loads them. This keeps the trust boundary at one place.

**State:** `~/.config/omnivoice/env` is the canonical store. `os.environ` is the runtime cache.

---

### 2.3 Supertonic-3 Engine + Engine Isolation

**Question recap:** Subprocess-per-engine? Lazy import? Separate venv per engine?

**Reality check — what mature multi-engine ML apps do:**

| Project | Isolation strategy | Outcome |
|---------|-------------------|---------|
| AUTOMATIC1111 webui | Shared venv, no isolation | Constant dependency hell ([wiki](https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/Dependencies), [#15662](https://github.com/AUTOMATIC1111/stable-diffusion-webui/issues/15662)) |
| ComfyUI (today) | Shared venv, manager-coordinated | Same hell; mitigated by ComfyUI-Manager unified resolver |
| ComfyUI ([comfy-env](https://github.com/PozzettiAndrea/comfy-env)) | **Per-node subprocess + per-node venv, Unix socket IPC** | Works; only opt-in for nodes that need it |
| Docker-wrapped SD | Container = full isolation | Works but kills "local-first" desktop feel |

**Recommended structure for OmniVoice (matches comfy-env's hybrid model):**

```
┌──────────────────────────────────────────────────────────────────┐
│ TTSBackend registry  (backend/services/tts_backend.py)            │
│                                                                   │
│  _REGISTRY = {                                                    │
│    "omnivoice":   OmniVoiceBackend,        # in-process (default)  │
│    "kittentts":   KittenTTSBackend,         # in-process (tiny)    │
│    "voxcpm2":     VoxCPM2Backend,           # in-process           │
│    "moss-nano":   MossTTSNanoBackend,       # in-process           │
│    "mlx-audio":   MLXAudioBackend,          # in-process (Mac ARM) │
│    "cosyvoice3":  CosyVoiceBackend,         # in-process           │
│    "indextts":    SubprocessBackend(        # NEW: isolated         │
│                     entry="engines.indextts.main",                 │
│                     venv="indextts"),                              │
│    "supertonic3": SubprocessBackend(        # NEW: isolated         │
│                     entry="engines.supertonic3.main",              │
│                     venv="supertonic3"),                           │
│  }                                                                │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│ Tier 1: in-process engines (today's model, keep as-is)             │
│   - Lazy import in _ensure_loaded()                                │
│   - is_available() reports missing dep cleanly                     │
│   - No behavior change for existing users                          │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Tier 2: NEW — isolated engines (IndexTTS, Supertonic-3, future)    │
│                                                                   │
│   backend/services/engine_subprocess.py  (NEW, ~250 lines)         │
│                                                                   │
│   class SubprocessBackend(TTSBackend):                            │
│     def __init__(self, entry, venv):                              │
│         self.entry = entry        # "engines.supertonic3.main"    │
│         self.venv  = venv         # "supertonic3"                  │
│         self.proc  = None         # persistent worker              │
│                                                                   │
│     def _ensure_proc(self):                                       │
│       venv_py = DATA_DIR/"engine_venvs"/self.venv/"bin"/"python"   │
│       if not venv_py.exists():                                     │
│           self._bootstrap_venv()                                   │
│       if self.proc is None or self.proc.poll() is not None:       │
│           self.proc = subprocess.Popen(                            │
│             [venv_py, "-m", self.entry],                           │
│             stdin=PIPE, stdout=PIPE, stderr=PIPE,                  │
│             env={**os.environ.copy(),                              │
│                  "OMNIVOICE_ENGINE_ID": self.id})                  │
│                                                                   │
│     def generate(self, text, **kw):                               │
│       payload = json.dumps({"text": text, **kw})                   │
│       self.proc.stdin.write(payload + "\n"); self.proc.stdin.flush│
│       result_path = self.proc.stdout.readline().strip()            │
│       return torchaudio.load(result_path)[0]                       │
│                                                                   │
│ Engine entrypoint lives in: backend/engines/<name>/main.py         │
│   - tiny module: read JSON line on stdin, generate, write          │
│     WAV path on stdout, exit on EOF                                │
│   - depends only on the engine's own pip deps (lives in its venv)  │
└──────────────────────────────────────────────────────────────────┘
```

**Why not "venv per engine for everything"?**
- Cold-start cost: a fresh venv adds 500-2000ms to first call (interpreter spawn + lazy import of torch).
- Disk cost: torch alone is ~1 GB per venv. Six engines × 1 GB = unshippable.
- Most engines (KittenTTS, MossTTSNano, MLX-Audio) coexist fine in the main venv today — no reason to break what works.

**Why per-engine venv for IndexTTS / Supertonic-3?**
- Issue #42 documents IndexTTS clashing with another engine in the shared venv. Whatever the upstream conflict is, *no* runtime-share fix is durable — only isolation is.
- Supertonic-3 is a brand-new dep with unknown transitive constraints; bringing it in-process means risking another #42 the day after release.

**Build order for engine_subprocess.py:**
1. Build `SubprocessBackend` against IndexTTS first (it's already broken in shared venv — moving it to isolation can only improve).
2. Verify with #42 regression test: load IndexTTS + OmniVoice in same session, confirm no clash.
3. Then add Supertonic-3 on top of the proven primitive.
4. Document the path (`backend/engines/<name>/main.py`) so contributors writing new engines pick isolation by default.

**Where venv state lives:**
- `DATA_DIR/engine_venvs/<engine_id>/.venv` — survives app upgrades.
- `DATA_DIR/engine_venvs/<engine_id>/requirements.txt` — pinned per engine.
- Bootstrap via `uv venv` then `uv pip install -r requirements.txt`. Reuses the existing `uv` binary discovered by `tools.rs::resolve_uv`.

**Backward-compat risks (FLAGGED):**
- Existing IndexTTS users have already-downloaded model weights at `~/.cache/huggingface/hub/`. The subprocess engine MUST resolve to that same HF cache (it will, since the subprocess inherits HF_HOME / HF_HUB_CACHE via env). Migration test required.
- Existing TTS settings stored in `prefs.json` use the same `id` keys — `OMNIVOICE_TTS_BACKEND=indextts` must continue to route correctly after the registry change.

---

### 2.4 Cross-Platform Installer & Mirror Fallback

**Question recap:** Bootstrap script vs. installer wrapper for mirror fallback?

**Current state:**
- Tauri shell runs `uv venv` + `uv sync` inside `bootstrap.rs::ensure_venv_ready` (lines 263-462).
- Already region-aware: `bootstrap.rs:452-455` sets `UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/` when `config.region == "china"`.
- Already mirrors HF endpoint: `backend.rs:168-175` sets `HF_ENDPOINT=https://hf-mirror.com` when region=china.
- The plumbing is in place; what's missing is **failure-driven** fallback (try default → on timeout/403, retry against mirror).

**Recommended structure:**

```
┌──────────────────────────────────────────────────────────────────┐
│ Tauri bootstrap.rs — extended (NOT moved to a wrapper)            │
│                                                                   │
│ ensure_venv_ready() {                                             │
│   1. uv venv                                                      │
│   2. uv sync (default index)                                      │
│   3. ON FAILURE:                                                  │
│      - parse stderr for known restricted-region signatures:        │
│        ResolverError / NetworkError / "timed out" / 403 / 451     │
│      - if matched, switch UV_INDEX_URL → mirror cascade:          │
│          • mirrors.aliyun.com/pypi/simple                          │
│          • pypi.tuna.tsinghua.edu.cn/simple                        │
│          • pypi.douban.com/simple                                 │
│      - emit BootstrapStage::InstallingDeps with                    │
│        message="Retrying via mirror…"                              │
│      - retry uv sync                                              │
│   4. ON SECOND FAILURE: surface to BootstrapStage::Failed         │
│      with the actionable hint "Try Settings → Region → China"     │
│ }                                                                 │
└──────────────────────────────────────────────────────────────────┘
```

**Why this lives in the bootstrap script, not an outer installer wrapper:**
- The Tauri shell already does the bootstrap. Adding a second layer (Electron-style installer that wraps Tauri that wraps uv) is the wrong direction.
- Mature Tauri apps (Pake, the Tauri team's own examples) keep first-launch bootstrap in the Rust shell, not in a pre-installer step. The pre-installer (DMG/MSI/AppImage) does only *file placement*.
- Failure detection requires reading uv's stderr in real time — bootstrap.rs already does this via `run_streaming` (lines 71-104). The signal source and the retry logic must live in the same process.
- A wrapper-based mirror cascade would have to re-implement venv detection, log streaming, and progress events — all of which `bootstrap.rs` already does.

**State / config:**
- `region` is already stored in Tauri config (`config.rs`). Add an `effective_index_url` runtime field that records which mirror succeeded — surfaced read-only in Settings → Diagnostics.
- No new on-disk state required.

**Build order:**
1. Add stderr signature matcher (small, no fallback yet) — observability first.
2. Add the cascade (mirror list constant in `config.rs`).
3. Add Settings UI: read-only display of "Current package index" + a "Switch to China mirrors" toggle that's redundant with the auto-cascade but gives power users a manual escape.

---

### 2.5 Docs Subsystem

**Question recap:** `docs/install/` tree? In-app help panel? Both?

**Current state:**
- `docs/` has a flat structure: developer-facing (`STRUCTURE.md`, `ROADMAP.md`, `desktop-build.md`) + media files. No per-OS install docs.
- README is single-source-of-truth for install. It's 500 lines and growing.
- Settings → Logs is the closest thing to in-app help (`pages/Settings.jsx`).

**Recommended structure (both, with one canonical source):**

```
docs/
├── README.md           ⟵ unchanged: marketing + 3-quickstart cards
├── install/            ⟵ NEW: per-OS deep-dives, linked from README
│   ├── macos.md          (xattr -cr, Sequoia damaged-dmg, Rosetta)
│   ├── windows.md        (long-path, MAX_PATH, antivirus, MSI flags)
│   ├── linux.md          (FUSE, WebKit white-screen, glibc, .deb vs AppImage)
│   ├── docker.md         (GPU profile, port binding, reverse proxy)
│   └── troubleshooting.md  (HF token, diarization, dubbing WAV bug, CosyVoice)
├── engines/            ⟵ NEW: per-engine install + troubleshooting
│   ├── cosyvoice.md
│   ├── indextts.md
│   ├── supertonic3.md
│   └── ...
└── (existing dev docs unchanged)

frontend/src/pages/Help.jsx   ⟵ NEW: in-app help panel
  - Fetches docs/install/*.md from the running backend (NEW endpoint:
    GET /docs/{slug} — reads from frontend/dist/docs/ at runtime,
    bundled by Vite as static assets)
  - Renders with same Markdown component used by API docs (Scalar already
    ships a renderer; pick react-markdown for parity with frontend stack)
  - Surfaced from:
      • Bootstrap splash → "Need help?" link → docs/install/<os>.md
      • Settings → Help tab → table of contents
      • Error UI → contextual link (e.g., dubbing WAV bug → 
        troubleshooting.md#wav-export-corruption)
```

**Why both, not one:**
- README is the GitHub landing page — must stay short and marketing-led.
- Per-OS files in `docs/install/` give Discord/GitHub a place to link ("see docs/install/windows.md#long-paths").
- In-app help panel matters because users hit errors *inside* the app — making them open a browser breaks flow and is the #1 Discord-volume driver per `.planning/PROJECT.md`.

**Why same Markdown source for README and in-app:**
- Single source of truth. Changes to install docs ship to GitHub and to the app in the same PR.
- `docs/install/*.md` is bundled by Vite into `frontend/dist/docs/` at build time (already happens for screenshots via `vite-plugin-static-copy`-style patterns).

**State:**
- No state. Docs are read-only static assets.
- One small addition: `read_doc_views` table in SQLite to count which troubleshooting pages get the most hits (data-driven docs improvement). Optional, defer.

**Build order:**
1. Create `docs/install/` tree and migrate the README's troubleshooting `<details>` blocks into it (README links out).
2. Add bundling step: `docs/install/` → `frontend/dist/docs/`.
3. Backend endpoint: `GET /docs/{slug}` → serve from `frontend_path/docs/{slug}.md`.
4. Frontend `Help.jsx` page + Settings tab + error-UI contextual links.

---

## 3. Cross-Subsystem Dependencies

```
┌─────────────────┐
│ env_store       │ ◄────────────┐
│ (2.2 HF token)  │              │
└────────┬────────┘              │ used by
         │ used by               │
         ▼                       │
┌─────────────────┐    ┌─────────┴───────┐
│ SubprocessBack- │    │ bug_report      │
│ end (2.3 engine │    │ (2.1 reporting) │
│ isolation)      │    └─────────┬───────┘
└────────┬────────┘              │ surfaces docs links from
         │ surfaces install      ▼
         │ docs link on first    ┌─────────────────┐
         │ engine selection      │ docs/install/   │
         └─────────────────────► │ + Help.jsx      │
                                 │ (2.5 docs)      │
                                 └─────────────────┘
┌─────────────────┐ ┌─────────────────┐
│ mirror fallback │ │ (no subsystem   │
│ (2.4 installer) │ │  depends on it; │
│                 │ │  pure bootstrap)│
└─────────────────┘ └─────────────────┘
```

**Suggested build order (which unblocks what):**

1. **env_store (2.2)** — small, well-bounded, no upstream dependencies. Once HF_TOKEN persists, half of the #35 user-reported pain disappears. Also unblocks (2.3) because Supertonic-3 will need HF_TOKEN forwarded to its subprocess.

2. **docs/install + Help.jsx skeleton (2.5)** — independent of other subsystems. Build the empty skeleton first so subsequent subsystems can link contextual troubleshooting from day one.

3. **engine_subprocess primitive against IndexTTS (2.3, part 1)** — fix the broken thing (#42) before adding a new thing on top. Validates the SubprocessBackend pattern.

4. **Supertonic-3 on top of proven primitive (2.3, part 2)** — riskless once the primitive is tested.

5. **mirror fallback (2.4)** — independent; can be done in parallel with any of the above. Best done after (1) so the env-store can also persist `OMNIVOICE_REGION_PREFERENCE` consistently.

6. **bug_report (2.1)** — last, because the reports it captures are most valuable *after* the above changes ship (the reports will surface unknown-unknowns in the new code).

---

## 4. Risk Callouts

| Risk | Subsystem | Impact | Mitigation |
|------|-----------|--------|------------|
| **#42 regression** | 2.3 engine isolation | IndexTTS users break | Pin a migration test: load IndexTTS + OmniVoice in same session, run 1 generation each, assert no AttributeError. Run in CI on every PR. |
| **HF cache divergence** | 2.3 engine isolation | Subprocess engines re-download already-cached weights | Subprocess must inherit HF_HOME/HF_HUB_CACHE — already done via `os.environ.copy()`. Add an integration test that confirms first-run uses cached weights. |
| **Engine venv bloat** | 2.3 engine isolation | DATA_DIR/engine_venvs grows unbounded | Cap to 3 isolated engines max in this milestone (IndexTTS, Supertonic-3, +1 buffer). Add disk-usage badge in Settings → Diagnostics. |
| **Bug reports leak HF_TOKEN** | 2.1 bug reporting | Privacy breach | Redaction list (HF_TOKEN, *_API_KEY, $HOME → ~) lives in `bug_report.py` constants. Unit-test redaction with known-bad inputs. |
| **Bug-report opt-in default = true** | 2.1 bug reporting | Violates local-first promise | DEFAULT MUST BE FALSE. Consent dialog explicitly off-by-default. PR review must verify `prefs.resolve("bug_report_consent", default=False)`. |
| **HF_TOKEN written world-readable** | 2.2 token persistence | Other users on shared host read token | `~/.config/omnivoice/env` mode 0600 (chmod after write). On Windows, document NTFS ACL approach in docs/install/windows.md. |
| **Mirror cascade infinite loop** | 2.4 installer | Bootstrap hangs forever | Hard cap: 1 retry per mirror, 3 mirrors total. Each attempt has 120s uv timeout (uv's default). Track attempts in bootstrap.rs state. |
| **In-app docs out of sync with installed version** | 2.5 docs | Stale workaround info | Bundle docs at build time (already standard for static assets). NEVER fetch docs from GitHub at runtime — that breaks offline-first. |
| **`pkg_resources` fix breaks frozen bundle** | (Wave 1 #58, not its own subsystem) | PyInstaller bundle may double-include setuptools | Verify `setuptools` is excluded in `backend.spec:excludes` if redundant; check bundle size delta before/after. |

---

## 5. Implications for Roadmap

Recommended phase grouping (the orchestrator will turn these into roadmap phases):

| Group | Subsystems | Phase characteristic |
|-------|------------|----------------------|
| **A: Token + Docs scaffolding** | 2.2 env_store, 2.5 docs skeleton | Small, independent, unblocks user-visible pain immediately |
| **B: Engine isolation** | 2.3 SubprocessBackend (IndexTTS first, then Supertonic-3) | Heavier; one risky refactor + one safe addition. Treat IndexTTS migration as the deepest risk in the milestone. |
| **C: Installer reliability** | 2.4 mirror cascade | Bounded; almost pure Rust change in bootstrap.rs. |
| **D: Bug reporting** | 2.1 full stack | Last because its value compounds as the above ship. Also smallest user-visible delta until adopted. |

**Phases A and C can run in parallel.** Phase B is the longest pole — start it early.

---

## 6. Sources

### Internal (HIGH confidence — direct code reads)
- `/Users/user4/Desktop/voice-design/OmniVoice/backend/main.py` (lifespan, global exception handler, env loading)
- `/Users/user4/Desktop/voice-design/OmniVoice/backend/core/prefs.py` (env > prefs.json > default pattern)
- `/Users/user4/Desktop/voice-design/OmniVoice/backend/core/config.py` (DATA_DIR, CRASH_LOG_PATH, LOG_PATH)
- `/Users/user4/Desktop/voice-design/OmniVoice/backend/core/onboarding.py` (first-run pattern)
- `/Users/user4/Desktop/voice-design/OmniVoice/backend/services/tts_backend.py` (TTSBackend ABC + registry)
- `/Users/user4/Desktop/voice-design/OmniVoice/backend/services/gpu_sandbox.py` (existing subprocess primitive)
- `/Users/user4/Desktop/voice-design/OmniVoice/backend/api/routers/system.py` (existing set-env endpoint, line 510)
- `/Users/user4/Desktop/voice-design/OmniVoice/frontend/src-tauri/src/bootstrap.rs` (venv bootstrap, region mirror handling)
- `/Users/user4/Desktop/voice-design/OmniVoice/frontend/src-tauri/src/backend.rs` (HF_ENDPOINT region mapping line 168-175)
- `/Users/user4/Desktop/voice-design/OmniVoice/frontend/src-tauri/src/commands.rs` (log path resolvers, tray, dictation)
- `/Users/user4/Desktop/voice-design/OmniVoice/frontend/src/components/ErrorBoundary.jsx` (existing React error boundary)
- `/Users/user4/Desktop/voice-design/OmniVoice/backend.spec` (PyInstaller bundling architecture)
- `/Users/user4/Desktop/voice-design/OmniVoice/docs/STRUCTURE.md` (canonical project layout)
- `/Users/user4/Desktop/voice-design/OmniVoice/.planning/PROJECT.md` (milestone constraints)

### External (MEDIUM confidence — web research)
- [ComfyUI custom node V3 dependency resolution](https://comfyui.org/en/comfyui-v3-dependency-resolution)
- [comfy-env: per-node subprocess isolation for ComfyUI](https://github.com/PozzettiAndrea/comfy-env)
- [ComfyUI dependency resolution and standards blog](https://blog.comfy.org/p/dependency-resolution-and-custom)
- [Custom Nodes as Python Dependencies — ComfyUI discussion](https://github.com/Comfy-Org/ComfyUI/discussions/1959)
- [AUTOMATIC1111 webui dependency wiki](https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/Dependencies)
- [AUTOMATIC1111 dependency conflict bug #15662](https://github.com/AUTOMATIC1111/stable-diffusion-webui/issues/15662)
- [Tauri panic capture discussion #9649](https://github.com/tauri-apps/tauri/discussions/9649)
- [Capture errors Tauri cannot resolve — feature request #13482](https://github.com/tauri-apps/tauri/issues/13482)
- [Aptabase: Catching panics on Tauri apps](https://aptabase.com/blog/catching-panics-on-tauri-apps)
- [Sentry SDK overview (DSN requirement)](https://develop.sentry.dev/sdk/overview/)
- [Sentry DSN configuration discussion](https://brtkwr.com/posts/2025-10-21-sentry-dsn-configuration/)
- [uv: multiple virtual environments — issue #15205](https://github.com/astral-sh/uv/issues/15205)
- [uv: using environments docs](https://docs.astral.sh/uv/pip/environments/)
- [uv: workspaces docs (plugin systems)](https://docs.astral.sh/uv/concepts/projects/workspaces/)

### Confidence note
HIGH confidence in the internal architecture descriptions (they're direct code reads). MEDIUM confidence in the external comparisons (web search of community patterns, no Context7 hits for the ML-app ecosystem questions). The Sentry/local-first conclusion is HIGH confidence because the project constraint document settles it independently of Sentry's docs.
