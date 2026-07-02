"""Issue #878 — LLM-provider state must not leak between tests.

LLM provider selection reads three process-global surfaces: env vars
(LLM_DEFAULT_PROVIDER, per-provider *_API_KEY / *_BASE_URL, TRANSLATE_*),
the SQLite settings store (llm.active_provider & co.), and prefs.json
(llm_backend). A test that mutates any of them without teardown — or that
merely imports `main` (its dotenv load injects the developer's .env /
~/.config/omnivoice/env into os.environ) — used to flip what later tests'
`active_backend_id()` / `active_provider_id()` resolved to. Reported repro:

    uv run pytest tests/test_generate_engine.py::test_generate_default_path_still_runs_omnivoice \
                  tests/test_engines.py::test_llm_auto_selects_off_when_nothing_configured -q
    # → assert 'openai-compat' == 'off'

The pair below reproduces the whole class deterministically (pytest runs
tests in definition order within a file): the first test pollutes all three
surfaces on purpose and "forgets" to clean up; the second asserts the
`_isolate_llm_provider_state` autouse guard in tests/conftest.py restored
every surface to its pre-test baseline. Fails without the guard.
"""
import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest

# A cross-section of the guarded env surface: selection overrides, a provider
# key, and the legacy single-endpoint vars. Baselines are captured lazily in
# the polluting test (module import happens at collection time; the ambient
# values at test start are what the guard restores to).
_ENV_VARS = (
    "LLM_DEFAULT_PROVIDER",
    "OMNIVOICE_LLM_BACKEND",
    "GROQ_API_KEY",
    "TRANSLATE_BASE_URL",
    "TRANSLATE_API_KEY",
)

_baseline: dict = {}


def _store_active_provider():
    from services import settings_store
    return settings_store.get_text("llm.active_provider")


def _prefs_llm_backend():
    from core import prefs
    return prefs.get("llm_backend")


def test_pollute_llm_state_without_cleanup():
    """Deliberately leak on every surface — no monkeypatch, no teardown."""
    from core.db import ensure_schema
    from core import prefs
    from services import settings_store

    ensure_schema()  # settings table must exist for the store write

    _baseline["env"] = {n: os.environ.get(n) for n in _ENV_VARS}
    _baseline["store"] = _store_active_provider()
    _baseline["prefs"] = _prefs_llm_backend()

    os.environ["LLM_DEFAULT_PROVIDER"] = "groq"
    os.environ["OMNIVOICE_LLM_BACKEND"] = "openai-compat"
    os.environ["GROQ_API_KEY"] = "gsk_leaked_by_test"
    os.environ["TRANSLATE_BASE_URL"] = "http://leak:11434/v1"
    os.environ["TRANSLATE_API_KEY"] = "leaked"
    settings_store.set_text("llm.active_provider", "groq")
    prefs.set_("llm_backend", "openai-compat")

    # Sanity: the pollution really is visible inside the offending test.
    assert os.environ["GROQ_API_KEY"] == "gsk_leaked_by_test"
    assert _store_active_provider() == "groq"
    assert _prefs_llm_backend() == "openai-compat"


def test_llm_state_restored_after_polluting_test():
    """The autouse guard must have restored env, store, and prefs exactly."""
    if "env" not in _baseline:
        pytest.skip("baseline unavailable — polluting test did not run first")

    leaked = {
        n: os.environ.get(n)
        for n in _ENV_VARS
        if os.environ.get(n) != _baseline["env"][n]
    }
    assert not leaked, f"env vars leaked across tests: {leaked}"
    assert _store_active_provider() == _baseline["store"], (
        "settings store llm.active_provider leaked across tests"
    )
    assert _prefs_llm_backend() == _baseline["prefs"], (
        "prefs.json llm_backend leaked across tests"
    )
