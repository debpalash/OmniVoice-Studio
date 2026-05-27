```markdown
# OmniVoice-Studio Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to contribute to the OmniVoice-Studio codebase, a Python-based project (with a TypeScript/React frontend) for voice and audio processing. You'll learn the repository's coding conventions, commit patterns, and step-by-step workflows for adding engines, hardening audio I/O, updating settings panels, managing error documentation, exposing engine health, and maintaining regression fixtures. This guide also covers testing patterns and provides handy commands for frequent tasks.

---

## Coding Conventions

**File Naming**
- Use `camelCase` for file names.
  - Example: `audioIoHelper.py`, `ttsBackend.py`

**Import Style**
- Use **relative imports** in Python.
  - Example:
    ```python
    from .audioIoHelper import atomic_save_wav
    ```

**Export Style**
- Use **named exports** (in JS/TS).
  - Example:
    ```typescript
    export function classifyError(error: Error) { ... }
    ```

**Commit Patterns**
- Use [Conventional Commits](https://www.conventionalcommits.org/).
- Prefixes: `feat`, `fix`, `docs`, `chore`, `refactor`, `ci`
- Example commit message:
  ```
  feat: add GGUF engine support to backend and compatibility matrix
  ```

---

## Workflows

### Add New Engine Backend
**Trigger:** When adding a new TTS or specialty engine (e.g., TTS, GGUF, Supertonic, IndexTTS)  
**Command:** `/new-engine`

1. Create `backend/engines/{engine_name}/` with:
    - `__init__.py`
    - `backend.py`
    - Any engine-specific files
2. Register the engine in `backend/services/tts_backend.py`.
3. Update `backend/services/settings_store.py` if settings or license gating are needed.
4. Update or create `frontend/src/components/EngineCompatibilityMatrix.jsx` and `frontend/src/api/types.ts` to surface the new engine.
5. Update `backend/api/routers/engines.py` to expose health/status endpoints if needed.
6. Add tests:
    - `tests/test_{engine_name}.py`
    - `tests/backend/services/test_{engine_name}_sidecar.py` (if applicable)
7. Update `.github/workflows/ci.yml` to ensure CI builds/tests the new engine.
8. Document the engine in `.planning/phases/{phase}/` and/or `docs/engines/{engine_name}.md`.

**Example:**
```python
# backend/engines/gguf/backend.py
class GGUFEngine:
    def synthesize(self, text):
        # Engine logic here
        pass
```

---

### Add or Harden Audio IO Helper
**Trigger:** When fixing audio file corruption bugs or adding new audio formats  
**Command:** `/harden-audio-io`

1. Create or update helpers in `backend/services/audio_io.py` (e.g., `_safe_torchaudio_save`, `atomic_save_wav`).
2. Refactor all direct audio write calls in `backend/api/routers/` to use these helpers.
3. Add or update tests:
    - `tests/backend/services/test_audio_io.py`
    - `tests/backend/test_dub_pipeline_wav.py`
4. Update documentation in `.planning/phases/` or `docs/` as needed.

**Example:**
```python
# backend/services/audio_io.py
def atomic_save_wav(path, data, sample_rate):
    # Write WAV atomically to avoid corruption
    pass
```

---

### Add or Update Settings UI Panel
**Trigger:** When exposing a new user-configurable setting or moving a UI control  
**Command:** `/new-settings-panel`

1. Create or update `frontend/src/components/settings/{PanelName}Panel.jsx` and `.css`.
2. Wire the panel into `frontend/src/pages/Settings.jsx`.
3. Update state in `frontend/src/store/` (e.g., `prefsSlice.ts`, `index.ts`).
4. Add or update backend API endpoints in `backend/api/routers/settings.py`.
5. Update `backend/services/settings_store.py` for persistence.
6. Write or update tests:
    - `frontend/src/components/settings/{PanelName}Panel.test.jsx`
    - Backend tests as needed

**Example:**
```jsx
// frontend/src/components/settings/AudioPanel.jsx
export function AudioPanel() {
  // Panel logic here
}
```

---

### Add or Update Error Docs Deeplink
**Trigger:** When making an error actionable by linking it to relevant documentation  
**Command:** `/error-docs-link`

1. Add or update error class → docs URL mapping in `backend/core/error_docs_map.py`.
2. Mirror the mapping in `frontend/src/utils/errorDocsMap.ts`.
3. Update `classifyError` logic in both TS and Python.
4. Add or update tests:
    - `tests/backend/core/test_error_docs_map.py`
    - `frontend/src/utils/errorDocsMap.test.ts`
5. Update `frontend/src/components/ErrorBoundary.jsx` to use the mapping for deeplink buttons.

**Example:**
```python
# backend/core/error_docs_map.py
ERROR_DOCS_MAP = {
    "AudioCorruptionError": "https://docs.omnivoice.studio/errors/audio-corruption"
}
```

---

### Engine Health API and Compatibility Matrix UI
**Trigger:** When making engine installability and compatibility visible to users  
**Command:** `/engine-health-matrix`

1. Update `backend/api/routers/engines.py` to provide `/engines` and `/engines/{id}/health` endpoints.
2. Update `backend/services/tts_backend.py` to include health, last_error, gpu_compat, etc.
3. Update `frontend/src/components/EngineCompatibilityMatrix.jsx` and `.css` to render the matrix.
4. Update `frontend/src/api/engines.ts` and `types.ts` for API calls and types.
5. Add or update tests:
    - `tests/backend/api/test_engines_route_shape.py`
    - `frontend/src/test/EngineCompatibilityMatrix.test.jsx`

**Example:**
```python
# backend/api/routers/engines.py
@router.get("/engines/{engine_id}/health")
def engine_health(engine_id: str):
    # Return health status
    pass
```

---

### Add or Update Regression or Smoke Test Fixture
**Trigger:** When ensuring core app functions don't regress, especially after major changes  
**Command:** `/update-fixture`

1. Create or update `scripts/seed-test-fixture.py` to generate a deterministic fixture.
2. Update or add files in `tests/fixtures/omnivoice_data/` (db, profile, sample.wav).
3. Add or update smoke tests in `tests/smoke/test_boot_smoke.py`.
4. Update `.gitignore` to allowlist fixture files.
5. Ensure CI runs the smoke tests on all platforms (`.github/workflows/ci.yml`).

**Example:**
```python
# scripts/seed-test-fixture.py
def seed_fixture():
    # Generate test data
    pass
```

---

## Testing Patterns

- **Frontend:** Uses [Vitest](https://vitest.dev/) for JS/TS tests.
  - Test files: `*.test.js`, `*.test.jsx`, `*.test.ts`
- **Backend:** Python tests in `tests/` directory.
  - Example: `tests/test_engine.py`, `tests/backend/services/test_audio_io.py`
- **Fixtures:** Test data in `tests/fixtures/omnivoice_data/`
- **CI:** `.github/workflows/ci.yml` ensures all tests run on push/PR.

**Example (Vitest):**
```javascript
// frontend/src/components/settings/AudioPanel.test.jsx
import { describe, it, expect } from 'vitest';
import { AudioPanel } from './AudioPanel';

describe('AudioPanel', () => {
  it('renders correctly', () => {
    // Test implementation
  });
});
```

---

## Commands

| Command               | Purpose                                                        |
|-----------------------|----------------------------------------------------------------|
| /new-engine           | Add a new TTS or specialty engine backend                      |
| /harden-audio-io      | Centralize and harden audio file I/O logic                     |
| /new-settings-panel   | Add or update a settings UI panel and backend wiring           |
| /error-docs-link      | Add or update error-to-docs deeplink mappings                  |
| /engine-health-matrix | Expose engine health API and update compatibility matrix UI    |
| /update-fixture       | Seed or update regression/smoke test fixtures                  |
```
