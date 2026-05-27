---
name: add-new-engine-backend
description: Workflow command scaffold for add-new-engine-backend in OmniVoice-Studio.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-new-engine-backend

Use this workflow when working on **add-new-engine-backend** in `OmniVoice-Studio`.

## Goal

Add a new TTS or specialty engine to the backend, register it, expose it to the frontend, and test it.

## Common Files

- `backend/engines/{engine_name}/__init__.py`
- `backend/engines/{engine_name}/backend.py`
- `backend/services/tts_backend.py`
- `backend/services/settings_store.py`
- `backend/api/routers/engines.py`
- `frontend/src/components/EngineCompatibilityMatrix.jsx`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create new backend/engines/{engine_name}/ directory with __init__.py, backend.py, and any engine-specific files.
- Add engine registration and logic to backend/services/tts_backend.py.
- Update backend/services/settings_store.py if engine requires settings or license gating.
- Update or create frontend/src/components/EngineCompatibilityMatrix.jsx and related frontend/src/api/types.ts to surface the new engine.
- Update backend/api/routers/engines.py to expose health/status endpoints if needed.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.