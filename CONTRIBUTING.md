# Contributing to OmniVoice Studio

Thanks for your interest in improving OmniVoice Studio! This guide covers everything you need to get started.

## Quick Links

| | |
|---|---|
| 💬 **Chat** | [Discord](https://discord.gg/aRRdVj3de7) |
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
bun run desktop
```

Requires [Rust](https://rustup.rs/) and platform-specific Tauri dependencies — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

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
- **CSS**: Vanilla CSS in component-level files — no Tailwind
- **Naming**: `PascalCase` for components, `camelCase` for hooks and utils

### Rust (Tauri)

- **Format**: `cargo fmt` before committing
- **Modules**: One concern per file (`bootstrap.rs`, `tools.rs`, `config.rs`, `commands.rs`)

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

## Need Help?

- **Stuck on setup?** Ask in [Discord #help](https://discord.gg/aRRdVj3de7)
- **Not sure where to start?** Check [good first issues](https://github.com/debpalash/OmniVoice-Studio/labels/good%20first%20issue)
- **Want to discuss a big change?** Open a [discussion](https://github.com/debpalash/OmniVoice-Studio/discussions) or Discord thread before coding

Thank you for contributing! 🎙️
