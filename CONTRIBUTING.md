# Contributing to OmniVoice Studio

Thanks for your interest in improving OmniVoice Studio! This guide covers everything you need to get started.

## Quick Links

| | |
|---|---|
| 💬 **Chat** | [Discord](https://discord.gg/bzQavDfVV9) |
| 🐛 **Bugs** | [GitHub Issues](https://github.com/debpalash/OmniVoice-Studio/issues) |
| 🏷️ **Good First Issues** | [Filtered list](https://github.com/debpalash/OmniVoice-Studio/labels/good%20first%20issue) |
| 📋 **Roadmap** | [README → Roadmap](README.md#roadmap) |

---

## Development Setup

### Prerequisites

- [Git](https://git-scm.com/)
- [Bun](https://bun.sh/) (frontend package manager)
- [uv](https://docs.astral.sh/uv/) (Python environment manager)
- [ffmpeg](https://ffmpeg.org/) (audio/video processing)
- Python 3.10+ (managed automatically by `uv`)

### Clone & Run

```bash
git clone https://github.com/debpalash/OmniVoice-Studio.git
cd OmniVoice-Studio
bun install
bun run dev
```

This starts both services:

| Service | URL | What it does |
|---------|-----|---|
| **Backend** | `localhost:3900` | FastAPI server — TTS, ASR, diarization, dubbing pipeline |
| **Frontend** | `localhost:3901` | React + Vite UI |

### Desktop App (Tauri)

```bash
bun run desktop          # dev: hot-reload Tauri shell + backend
bun run desktop-prod     # production: builds, bundles the backend, then launches
```

Both run `uv sync` first (so the Python backend env is set up) and start the
backend automatically — you do **not** start it separately. Use the exact script
names: there is no `desktop=prod` (note the **hyphen** in `desktop-prod`).
`desktop-prod` is Windows-aware (auto-detects bash/git; see `scripts/desktop-prod.mjs`).

Requires [Rust](https://rustup.rs/) and platform-specific Tauri dependencies — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

If the app opens but stays on the **setup splash with no buttons**, the Python
backend didn't finish starting — the splash surfaces the stall reason, a log
panel, and a **Retry** button (and Settings → Logs → Backend has the full trace).
The most common from-source cause is `uv` or Python not being on your PATH.

---

## Project Structure

```
OmniVoice-Studio/
├── backend/                 # Python FastAPI server
│   ├── api/                 # Route handlers
│   ├── core/                # Config, prefs, constants
│   └── services/            # TTS engines, ASR, dubbing, audio DSP
│       └── tts_backend.py   # ← Multi-engine TTS registry
├── frontend/                # React + Vite
│   ├── src/
│   │   ├── components/      # UI components
│   │   ├── hooks/           # Custom React hooks
│   │   ├── stores/          # Zustand state slices
│   │   └── utils/           # Shared utilities
│   └── src-tauri/           # Rust/Tauri desktop shell
├── deploy/                  # Docker, CI configs
├── docs/                    # Screenshots, MCP config
└── scripts/                 # Build & release scripts
```

---

## How to Contribute

### Bug Reports

Open an [issue](https://github.com/debpalash/OmniVoice-Studio/issues/new) with:

1. **What happened** vs **what you expected**
2. **Steps to reproduce**
3. **OS, GPU, and Python version** (find in Settings → Logs)
4. **Error logs** (Settings → Logs → copy relevant lines)

### Pull Requests

1. **Fork** the repo and create a branch from `main`
2. **Keep PRs focused** — one feature or fix per PR
3. **Run tests** before pushing:
   ```bash
   # Backend tests
   uv run pytest backend/ -x -q

   # Frontend build check
   cd frontend && npx vite build --mode development
   ```
4. **Write a clear PR title** — it becomes the squash-merge commit message
5. **Don't include** local machine stats, file paths, or private system info in PR descriptions

### Adding a New TTS Engine

OmniVoice's TTS backend is a plugin registry. Adding a new engine takes ~50 lines:

1. Open `backend/services/tts_backend.py`
2. Create a class extending `TTSBackend`:

```python
class MyEngineBackend(TTSBackend):
    id = "my-engine"
    display_name = "My Engine (description)"

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import my_engine  # noqa: F401
            return True, "ready"
        except ImportError:
            return False, "my_engine not installed. pip install my-engine"

    @property
    def sample_rate(self) -> int:
        return 24000

    @property
    def supported_languages(self) -> list[str]:
        return ["en", "zh"]

    def generate(self, text: str, **kw) -> torch.Tensor:
        # ... call your engine, return [1, num_samples] tensor
```

3. Register it in `_REGISTRY` at the bottom of the file
4. That's it — it auto-appears in Settings → TTS Engine

---

## Code Style

### Python (Backend)

- **Formatter**: We don't enforce one globally — match the style of the file you're editing
- **Logging**: Use `logger.warning()` / `logger.error()`, never bare `print()`
- **Exceptions**: Avoid bare `except: pass` — catch specific exceptions
- **Type hints**: Use them for public API functions and class methods

### JavaScript/React (Frontend)

- **Components**: Functional components with hooks
- **State**: Zustand stores in `src/stores/`, organized by slice
- **CSS**: **Utilities-first + shadcn/ui, one stylesheet.** UI is built on the shadcn/ui primitives in `src/components/ui/` (wrapped by the `src/ui/` barrel, themed to the OmniVoice palette), composed with Tailwind v4 utility classes. **All styling now lives in a single file — `src/index.css`**: the `@theme` / `[data-theme]` token foundation plus the irreducible set utilities can't express (`@keyframes`, glassmorphism/`backdrop-filter`, pseudo-elements, `:has()`, unlayered cascade overrides, and styling hooks on library-generated DOM like virtualized rows / WaveSurfer). The per-component `.css` files were eliminated in the CSS→Tailwind/shadcn migration — **do not create new ones.** Reach for shadcn primitives + utilities; if a rule is genuinely irreducible, add it to `src/index.css` with a provenance comment. (The only other `.css` is the test-only visual harness. See `docs/shadcn-migration.md`.)
- **Naming**: `PascalCase` for components, `camelCase` for hooks and utils

### Rust (Tauri)

- **Format**: `cargo fmt` before committing
- **Modules**: One concern per file (`bootstrap.rs`, `tools.rs`, `config.rs`, `commands.rs`)

---

## Frontend file structure & size limits

Frontend code stays modular so an edit loads one small file, not a 1900-line
one. The rules:

- **Size caps:** **soft 300 lines**, **hard 500 lines** per `.jsx` file.
  Anything over 500 lines must be split. (The cap does **not** apply to
  `src/index.css` — it is the single, intentional styling foundation and the
  only app stylesheet; see the CSS rule above.)
- **Pages are thin orchestrators.** A file in `frontend/src/pages/` is just
  layout + routing + state wiring that composes feature components — no inline
  sub-component over ~50 lines.
- **One component per file.** Co-locate `Foo.jsx` + `Foo.test.jsx` together in a
  per-page feature folder under `frontend/src/components/` (e.g.
  `components/settings/`, `components/dub/`). Styling is **not** co-located —
  it's utilities + shadcn, with any irreducible rules in `src/index.css`.
- **Shared bits go in a `primitives/` folder** inside the feature folder
  (`components/settings/primitives/` is the existing example).
- **Enforced by ESLint `max-lines`** (`max: 500`) — **warn-only for now** so it
  never breaks CI, with the goal of upgrading to `error` once the backlog of
  oversized files clears.

---

## Commit Messages

Write clear, concise messages. The PR title becomes the squash-merge commit.

```
good: fix: prevent CUDA OOM during concurrent transcription + TTS
good: feat: add CosyVoice 3 TTS backend adapter
good: docs: add platform compatibility matrix to README

bad:  fixed stuff
bad:  update
bad:  WIP
```

---

## Testing

```bash
# Run all backend tests
uv run pytest backend/ -x -q

# Run a specific test file
uv run pytest backend/tests/test_api.py -x -q

# Frontend build validation (no test suite yet)
cd frontend && npx vite build --mode development

# Tauri shell check (requires Rust)
cd frontend/src-tauri && cargo check
```

---

---

## What code review looks like

Every PR is reviewed by two AI reviewers before a human looks at it:

- **CodeRabbit** posts a walkthrough (with a sequence diagram, and an ASCII
  before/after sketch for UI changes), inline findings, and warning-mode
  pre-merge checks against the project's hard rules.
- **Greptile** reviews with the same project rubrics and learns from 👍/👎
  reactions on its comments — react to train it.

Both are advisory, not gating: CI and the maintainer's approval decide. Don't
be surprised by detailed bot comments minutes after you open a PR — address
what's right, push back (in a reply) on what's wrong.

**Commit & PR conventions:** conventional-commit style with a scope
(`fix(dub): …`, `feat(setup): …`) and link the issue (`Closes #N` / `Refs #N`)
in the title or body.

## Quality gates your PR must pass

- **Cross-platform parity (hard rule):** anything that ships in default mode
  must behave identically on macOS, Windows, and Linux. Platform-specific
  *implementation* is fine; platform-divergent *default behavior* is a P0.
  Platform-only features go behind an explicit opt-in (Settings toggle, env
  var, or CLI flag).
- **i18n — all 21 locales (hard rule):** every user-facing string goes through
  `t('...')` and the key must exist in **all 21** files under
  `frontend/src/i18n/locales/`. Translate; don't copy English into non-English
  locales. CI fails on hardcoded CJK outside the allowlist in
  `tests/test_no_hardcoded_cjk.py` (extend `_ALLOWED_FILES` with a
  justification for legitimate functional CJK).
- **DB schema changes** go through an alembic migration with a tested upgrade
  path — existing `omnivoice_data/` must keep working with no manual steps.
- **Engine back-compat:** already-installed engines (model weights on disk)
  must not require reinstall or re-download.
- **Local-first:** no new outbound calls except GitHub Issues (opt-in
  reporting) and HuggingFace model downloads. Never log or persist secrets or
  absolute home paths.
- **Security posture:** the backend serves loopback HTTP — treat every
  query/path/form parameter as hostile. User-chosen filesystem destinations
  are authorized in the Tauri process (save dialog), never via HTTP params.

## Contribution licensing

OmniVoice Studio is **AGPL-3.0-only**, and the maintainer also offers a
**commercial license** (see [LICENSE](LICENSE)). By submitting a contribution
you agree that:

1. you have the right to submit it (your own work, or compatibly licensed);
2. it is licensed to the project under **AGPL-3.0**; and
3. you grant the project maintainer a perpetual, worldwide, non-exclusive
   right to also distribute your contribution under the project's commercial
   license terms.

This inbound grant is what keeps the dual-license model viable. If you can't
agree to (3) for a particular contribution, say so in the PR and we'll discuss
before merging. Adding a `Signed-off-by:` line (DCO) to your commits is
appreciated but not required.

---

## Need Help?

- **Stuck on setup?** Ask in [Discord #help](https://discord.gg/bzQavDfVV9)
- **Not sure where to start?** Check [good first issues](https://github.com/debpalash/OmniVoice-Studio/labels/good%20first%20issue)
- **Want to discuss a big change?** Open a [discussion](https://github.com/debpalash/OmniVoice-Studio/discussions) or Discord thread before coding

Thank you for contributing! 🎙️
