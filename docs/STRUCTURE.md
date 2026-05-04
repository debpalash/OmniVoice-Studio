# Project Structure

Every folder has a single job. Every file at the root earns its place.

## Layout

```
OmniVoice/
│
├── README.md                    ⟵ user-facing overview
├── CHANGELOG.md                 ⟵ release history
├── LICENSE
│
├── pyproject.toml               ⟵ Python project manifest
├── uv.lock                      ⟵ Python lockfile
├── package.json                 ⟵ monorepo manifest (Bun workspaces + Turborepo)
├── bun.lock                     ⟵ JS lockfile
├── turbo.json                   ⟵ turborepo pipeline
│
├── .dockerignore                ⟵ Docker build context filter
├── backend.spec                 ⟵ pyinstaller spec (stays at root by pyinstaller convention)
├── alembic.ini                  ⟵ DB migration config (stays at root by alembic convention)
│
├── .env                         ⟵ user config; gitignored, .env.example is the template
├── .gitignore
│
├── backend/                     ⟵ FastAPI server
│   ├── main.py
│   ├── api/routers/             HTTP endpoints (thin)
│   ├── core/                    config, db, task queue, metrics
│   ├── services/                business logic
│   └── schemas/                 pydantic request/response shapes
│
├── frontend/                    ⟵ React 19 + Vite + Tauri desktop
│   ├── src/
│   │   ├── pages/               one file per top-level view
│   │   ├── components/          reusable UI
│   │   ├── api/                 typed API clients
│   │   ├── store/               Zustand slices
│   │   ├── hooks/               custom React hooks
│   │   └── utils/
│   ├── src-tauri/               Rust desktop shell
│   └── public/
│
├── omnivoice/                   ⟵ the underlying TTS model package
│   ├── models/
│   ├── cli/                     CLI entry points (omnivoice-infer, etc.)
│   ├── data/                    data utilities used by the model
│   ├── eval/                    evaluation scripts
│   ├── scripts/                 one-off utilities that ship with the package
│   ├── training/
│   └── utils/
│
├── tests/                       ⟵ all tests live here, no exceptions
│   ├── conftest.py
│   ├── test_api.py
│   ├── test_dub_*.py
│   ├── test_job_queue.py
│   ├── test_segmentation.py
│   └── frontend/                Node-based frontend tests
│
├── scripts/                     ⟵ dev / build / release shell + python scripts
│   ├── install.sh               universal installer
│   ├── run.sh                   universal launcher
│   ├── smoke-test.sh            end-to-end validation
│   └── desktop-prod.sh          production desktop build
│
├── deploy/                      ⟵ Docker deployment configs
│   ├── Dockerfile               single-stage CUDA image
│   └── docker-compose.yml       one-click local deployment
│
├── docs/                        ⟵ developer docs, screenshots, branding
│   ├── ROADMAP.md               where this project is going
│   ├── STRUCTURE.md             you are here
│   ├── mcp.json                 MCP config template
│   ├── preview.png              README hero image
│   ├── logo.png, logo.svg       branding assets
│   ├── screenshot-*.png         feature screenshots
│   ├── languages.md
│   ├── training.md
│   ├── data_preparation.md
│   ├── evaluation.md
│   └── voice-design.md
│
├── design/                      ⟵ ASCII mockups of the target UX
│   ├── README.md
│   └── 00–08-*.md               per-feature specs
│
├── research/                    ⟵ reference material, competitor analysis, archived code
│   ├── LEARNINGS.md             competitive analysis, what to absorb
│   ├── TheWhisper/              vendored reference (read-only)
│   ├── voice-pro/               vendored reference
│   └── legacy_gradio/           archived Gradio UI (pre-React rewrite)
│
├── examples/                    ⟵ runnable demos + sample inputs
│
├── omnivoice_data/              ⟵ Docker bind-mount target (gitignored)
│                                   DB + HF cache live here when running via compose
│
└── .git/
```

## Rules of the root

1. **Nothing at the root is a runtime artifact.** Outputs, temp files, local DBs, crash logs — all go to `~/Library/Application Support/OmniVoice/` (or the OS equivalent), *never* into the repo. The one exception is `omnivoice_data/`, which exists as a bind-mount anchor for Docker.

2. **No ad-hoc scripts at the root.** One-off debug scripts live in `scripts/`. Tests live in `tests/`. Benchmarks live in `scripts/benchmarks/` (when we create them).

3. **Each subdirectory owns one concern.** If you can't describe what goes in a directory in one sentence, it's wrong.

4. **Every package has a manifest.** `backend/`, `frontend/`, `omnivoice/` each have their own deps declared via `pyproject.toml` / `package.json` — they are independently testable.

## What lives where

| Kind of thing | Goes in |
|---|---|
| User-facing product code | `backend/`, `frontend/` |
| The TTS model (independent of the studio) | `omnivoice/` |
| Everything executable but not user-facing | `scripts/` |
| Tests | `tests/` |
| Developer + user docs (Markdown) | `docs/` |
| Target-state mockups | `design/` |
| Competitor clones, legacy code, ref material | `research/` |
| Runnable demos and sample data | `examples/` |
| Runtime data (never committed) | `~/Library/Application Support/OmniVoice/` on Mac |

## What *doesn't* live at the root anymore

Removed in the cleanup pass:

| File | Why it was there | Where it went |
|---|---|---|
| `test_crash.py`, `test_server.py`, `test_whisper.py`, `test_mock.py`, `test_pyannote.py` | One-off debug scripts from an April 14 crash investigation. Imported symbols that no longer exist after the router refactor. | Deleted (already gitignored, referenced dead code). |
| `benchmark.py` | Another stale debug script; imported `backend.main._get_db` which no longer exists. | Deleted. |
| `output.wav`, `test.wav` | Runtime artifacts. | Deleted / moved out. |
| `crash_log.txt` | Runtime log. Now written to `$DATA_DIR/crash_log.txt`. | Deleted. |
| `omnivoice.zip` (148 MB) | Offline reference archive of the project itself. | Moved out of the repo to `../omnivoice.zip.bak`. |
| `data/` | Only contained `.DS_Store`. | Deleted. |
| `legacy_gradio/` | The pre-React Gradio UI. Kept for historical reference. | Archived to `research/legacy_gradio/`. |
| Scattered `.DS_Store` files | macOS Finder droppings. | Deleted from every non-ignored directory. |

## Scaling path (proposed, not yet executed)

The current flat layout works fine for the current size. If the project grows to include additional apps (a mobile companion, a plugin SDK, multiple backends), migrate to a Turborepo-style monorepo:

```
OmniVoice/
├── apps/
│   ├── api/                 ← was backend/
│   ├── web/                 ← was frontend/
│   └── desktop/             ← could extract src-tauri/ here later
├── packages/
│   ├── omnivoice-model/     ← was omnivoice/
│   └── tts-adapters/        ← new; the pluggable TTS interface from ROADMAP phase 3
├── config/
│   ├── docker/
│   └── pyinstaller/
├── tests/
├── docs/
├── design/
└── research/
```

**Do not execute this migration without a dedicated PR.** It breaks:
- `pyproject.toml` `[tool.hatch.build.targets.{sdist,wheel}]` paths
- `package.json` workspaces and scripts
- `turbo.json`, `Dockerfile`, `docker-compose.yml` paths
- `backend.spec` (`['backend/main.py']`, `pathex=['.']`)
- `frontend/src-tauri/tauri.*.conf.json` sidecar paths
- every import that reads `from backend.main import …` (tests, scripts)

Migrate when adding the second `apps/*` or the second `packages/*`. Not before.

## Conventions

- **Filenames:** snake_case for Python, kebab-case or PascalCase for JS/TS components, lowercase for Markdown.
- **Tests mirror source paths.** `backend/services/dub_pipeline.py` → `tests/services/test_dub_pipeline.py`.
- **One-off scripts** go into `scripts/` with a descriptive name, not `test_*.py` at the root.
- **New top-level directories** require a PR that updates *this file*.
