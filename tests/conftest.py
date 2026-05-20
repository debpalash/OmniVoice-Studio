import os
import sys

# Backend runs with `--app-dir backend`, so tests must do the same.
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)


# ── Test fixtures ──────────────────────────────────────────────────────────


import pytest


@pytest.fixture
def mock_settings_store(monkeypatch):
    """In-memory replacement for ``services.settings_store`` license helpers.

    Phase 3 Plan 03-01 / Wave 0 gap: the real settings_store talks to
    SQLite via ``core.db.db_conn()``; that opens the project SQLite
    file as a side effect of the import. Tests that exercise
    ``Supertonic3Backend.is_available()`` shouldn't need the SQLite
    plumbing online ‑‑ they just need a controllable
    ``get_license_accepted`` / ``set_license_accepted`` pair.

    Yields a dict ``{engine_id: bool}`` so tests can pre-seed
    acceptance state or assert on what got written. The dict is
    re-bound to the monkeypatched helpers on every read/write so a
    test can mutate it directly to simulate "user clicked Accept".
    """
    state: dict[str, bool] = {}

    def fake_get(engine_id: str) -> bool:
        return bool(state.get(engine_id, False))

    def fake_set(engine_id: str, accepted: bool) -> None:
        state[engine_id] = bool(accepted)

    # Patch the canonical module so any importer (Supertonic3Backend,
    # api.routers.settings, etc.) sees the fakes. Using setattr+
    # monkeypatch lets pytest restore the originals between tests.
    from services import settings_store as _ss

    monkeypatch.setattr(_ss, "get_license_accepted", fake_get)
    monkeypatch.setattr(_ss, "set_license_accepted", fake_set)
    return state
