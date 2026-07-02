import os
import sys
import tempfile
import time

# Backend runs with `--app-dir backend`, so tests must do the same.
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)


# ── Hermetic app state (issue #878) ────────────────────────────────────────
# Tests must never read or write the developer's real app state. Without
# this, `core.config.DATA_DIR` resolves to the real per-user data dir
# (~/Library/Application Support/OmniVoice, %APPDATA%\OmniVoice, ~/.omnivoice)
# so prefs.json / omnivoice.db writes made by tests land in — and leak from —
# the developer's actual install, and a dev who used the app sees LLM tests
# fail that pass on clean CI. Redirecting here (before pytest imports any
# test module, which is what freezes DATA_DIR at `core.config` import time)
# makes every local run behave like a clean CI runner. `setdefault` semantics:
# an explicitly exported OMNIVOICE_DATA_DIR still wins.
if not os.environ.get("OMNIVOICE_DATA_DIR"):
    os.environ["OMNIVOICE_DATA_DIR"] = tempfile.mkdtemp(prefix="omnivoice-test-data-")
# Same story for the durable per-user env file (~/.config/omnivoice/env):
# `main.py` loads it with override=True at import, so a TestClient importing
# the app mid-suite would inject the developer's real TRANSLATE_* / key vars
# into this process. `core.user_env` resolves OMNIVOICE_ENV_FILE at call
# time, so pointing it into the throwaway data dir neutralizes both the
# load and any test that writes user-env without stubbing.
if not os.environ.get("OMNIVOICE_ENV_FILE"):
    os.environ["OMNIVOICE_ENV_FILE"] = os.path.join(
        os.environ["OMNIVOICE_DATA_DIR"], "user-env"
    )


# ── Test fixtures ──────────────────────────────────────────────────────────


import pytest

# ── LLM-provider state isolation (issue #878) ──────────────────────────────
# LLM provider selection is process-global three ways: env vars (the
# resolution roots for llm_providers/llm_backend, and `main.py` import loads
# .env files straight into os.environ), the SQLite settings store
# (llm.active_provider / llm.base_url.* / encrypted llm_key.* secrets), and
# prefs.json (llm_backend pick, env.TRANSLATE_* persistence). Any test that
# mutates one of these without teardown — or merely imports `main` — used to
# change what *later* tests' `active_backend_id()` / `active_provider_id()`
# resolved to (order-dependent failures in test_engines.py,
# test_llm_endpoint_settings.py, test_llm_providers.py). The autouse guard
# below snapshots all three surfaces before every test and restores them
# exactly afterwards, making the whole class of leak impossible.

# Env vars that are NOT declared on a Provider entry but still steer LLM /
# translation resolution.
_LLM_ENV_EXTRAS = (
    "LLM_DEFAULT_PROVIDER",    # llm_providers.active_provider_id() override
    "OMNIVOICE_LLM_BACKEND",   # llm_backend.active_backend_id() override
    "OMNIVOICE_LLM_TIMEOUT",
    "TRANSLATE_PROVIDER",      # dub translate default provider
    "TRANSLATE_BASE_URL",
    "TRANSLATE_API_KEY",
    "TRANSLATE_MODEL",
)

_llm_env_names_cache: tuple = ()


def _llm_env_names() -> tuple:
    """Every env var the LLM-provider registry resolves through.

    Derived from `services.llm_providers._PROVIDERS` so a newly added
    provider is guarded automatically. Falls back to the static extras if
    the import is unavailable (e.g. sys.modules stubbed by tests/backend/**);
    only a successful full derivation is cached.
    """
    global _llm_env_names_cache
    if _llm_env_names_cache:
        return _llm_env_names_cache
    names = set(_LLM_ENV_EXTRAS)
    try:
        from services import llm_providers
        for p in llm_providers.all_providers():
            names.update(p.key_envs)
            for n in (p.base_url_env, p.model_env, p.account_env):
                if n:
                    names.add(n)
    except Exception:
        return tuple(sorted(names))  # degraded, uncached — retry next test
    _llm_env_names_cache = tuple(sorted(names))
    return _llm_env_names_cache


_LLM_STORE_SQL = (
    "SELECT key, value FROM settings "
    "WHERE key LIKE 'llm.%' OR key LIKE 'secret.llm_key.%'"
)


def _llm_store_snapshot() -> dict:
    """Raw llm.* / secret.llm_key.* rows (ciphertext included — no decrypt)."""
    try:
        from core.db import db_conn
        with db_conn() as conn:
            return {k: v for k, v in conn.execute(_LLM_STORE_SQL).fetchall()}
    except Exception:
        # Missing settings table / stubbed core.* — nothing to snapshot.
        return {}


def _llm_store_restore(before: dict) -> None:
    try:
        from core.db import db_conn
        with db_conn() as conn:
            after = {k: v for k, v in conn.execute(_LLM_STORE_SQL).fetchall()}
            if after == before:
                return
            for k in after.keys() - before.keys():
                conn.execute("DELETE FROM settings WHERE key = ?", (k,))
            for k, v in before.items():
                if after.get(k) != v:
                    conn.execute(
                        "INSERT OR REPLACE INTO settings(key, value, updated_at) "
                        "VALUES (?, ?, ?)",
                        (k, v, time.time()),
                    )
    except Exception:
        pass  # table never existed during the test → nothing leaked


def _llm_prefs_subset(data: dict) -> dict:
    return {
        k: v for k, v in data.items()
        if k == "llm_backend" or k.startswith("env.TRANSLATE")
    }


def _llm_prefs_snapshot() -> dict:
    try:
        from core import prefs
        return _llm_prefs_subset(prefs._load())
    except Exception:
        return {}


def _llm_prefs_restore(before: dict) -> None:
    try:
        from core import prefs
        data = prefs._load()
        current = _llm_prefs_subset(data)
        if current == before:
            return
        for k in current.keys() - before.keys():
            data.pop(k, None)
        data.update(before)
        prefs._save(data)
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _isolate_llm_provider_state():
    """Snapshot/restore the three global LLM-provider state surfaces per test."""
    names = _llm_env_names()
    env_before = {n: os.environ.get(n) for n in names}
    store_before = _llm_store_snapshot()
    prefs_before = _llm_prefs_snapshot()
    yield
    for n, v in env_before.items():
        if os.environ.get(n) != v:
            if v is None:
                os.environ.pop(n, None)
            else:
                os.environ[n] = v
    _llm_store_restore(store_before)
    _llm_prefs_restore(prefs_before)


@pytest.fixture
def clean_llm_env(monkeypatch):
    """Delete every LLM-provider env var for the duration of a test.

    For tests that assert on the *unconfigured* state (auto-select 'off',
    empty endpoint settings, provider precedence): ambient shell exports or
    a `.env` loaded by an earlier `main` import must not read as
    'something configured'. Restoration is monkeypatch's.
    """
    for name in _llm_env_names():
        monkeypatch.delenv(name, raising=False)


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
