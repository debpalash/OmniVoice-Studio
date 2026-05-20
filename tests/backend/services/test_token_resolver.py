"""Tests for backend/services/token_resolver.py — AUTH-01 / AUTH-03 / AUTH-06.

Covers the 3-source cascade (App → Env → HF-CLI), the on_401 fallback,
the state() shape consumed by the Settings UI, and the save/clear API the
React panel will call.
"""
import sys
from unittest.mock import MagicMock

import pytest


APP_TOKEN = "hf_appapp00000000000000000000000000000000abc"
ENV_TOKEN = "hf_envenv00000000000000000000000000000000def"
CLI_TOKEN = "hf_clicli00000000000000000000000000000000ghi"


@pytest.fixture
def fresh_resolver(monkeypatch, tmp_path):
    """Fresh import of services.token_resolver + a tmp DB-backed settings
    store. Also clears HF env vars so the env source is empty by default."""
    monkeypatch.setenv("OMNIVOICE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)

    # Aggressive purge — see note in test_settings_store.py.
    for mod in list(sys.modules):
        if (
            mod == "core" or mod.startswith("core.")
            or mod == "services" or mod.startswith("services.")
        ):
            del sys.modules[mod]
    from core import db as _db
    _db.init_db()
    from services import token_resolver
    token_resolver.invalidate_cache()
    return token_resolver


def _mock_whoami(monkeypatch, mapping):
    """Patch huggingface_hub.whoami so that a known {token: result} mapping
    drives validity. `mapping[token]` may be a dict like {"name": "alice"}
    or an Exception instance to raise."""
    import huggingface_hub

    def _fake_whoami(token=None, **kwargs):
        if token in mapping:
            outcome = mapping[token]
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        raise RuntimeError(f"unexpected token in whoami: {token!r}")

    monkeypatch.setattr(huggingface_hub, "whoami", _fake_whoami)


def _mock_get_token(monkeypatch, value):
    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "get_token", lambda: value)


def test_resolve_priority_app_wins(fresh_resolver, monkeypatch):
    """All three sources set + valid → App wins."""
    tr = fresh_resolver
    from services import settings_store
    settings_store.set_hf_token(APP_TOKEN)
    monkeypatch.setenv("HF_TOKEN", ENV_TOKEN)
    _mock_get_token(monkeypatch, CLI_TOKEN)
    _mock_whoami(monkeypatch, {
        APP_TOKEN: {"name": "alice"},
        ENV_TOKEN: {"name": "bob"},
        CLI_TOKEN: {"name": "carol"},
    })
    tr.invalidate_cache()
    result = tr.resolve()
    assert result is not None
    assert result.token == APP_TOKEN
    assert result.source == "app"
    assert result.username == "alice"


def test_resolve_skips_empty_falls_to_env(fresh_resolver, monkeypatch):
    """No app token, env set, no CLI → Env wins."""
    tr = fresh_resolver
    monkeypatch.setenv("HF_TOKEN", ENV_TOKEN)
    _mock_get_token(monkeypatch, None)
    _mock_whoami(monkeypatch, {ENV_TOKEN: {"name": "bob"}})
    tr.invalidate_cache()
    result = tr.resolve()
    assert result is not None
    assert result.token == ENV_TOKEN
    assert result.source == "env"


def test_resolve_returns_none_when_all_empty(fresh_resolver, monkeypatch):
    tr = fresh_resolver
    _mock_get_token(monkeypatch, None)
    _mock_whoami(monkeypatch, {})
    tr.invalidate_cache()
    assert tr.resolve() is None


def test_resolve_skips_401_app_falls_to_env(fresh_resolver, monkeypatch):
    """App set but 401, env set and valid → resolver returns Env, not App.
    AUTH-06 mid-resolve fallback."""
    tr = fresh_resolver
    from services import settings_store
    from huggingface_hub.errors import HfHubHTTPError

    settings_store.set_hf_token(APP_TOKEN)
    monkeypatch.setenv("HF_TOKEN", ENV_TOKEN)
    _mock_get_token(monkeypatch, None)
    err = HfHubHTTPError("401 Unauthorized", response=MagicMock(status_code=401))
    _mock_whoami(monkeypatch, {
        APP_TOKEN: err,
        ENV_TOKEN: {"name": "bob"},
    })
    tr.invalidate_cache()
    result = tr.resolve()
    assert result is not None
    assert result.source == "env"
    assert result.token == ENV_TOKEN


def test_on_401_cascade(fresh_resolver, monkeypatch):
    """Active source = 'app', call on_401('app') → next valid source."""
    tr = fresh_resolver
    from services import settings_store
    settings_store.set_hf_token(APP_TOKEN)
    monkeypatch.setenv("HF_TOKEN", ENV_TOKEN)
    _mock_get_token(monkeypatch, None)
    _mock_whoami(monkeypatch, {
        APP_TOKEN: {"name": "alice"},
        ENV_TOKEN: {"name": "bob"},
    })
    tr.invalidate_cache()
    # Initial resolve picks app.
    assert tr.resolve().source == "app"
    # When the consumer reports a 401 from "app", fall back.
    fallback = tr.on_401("app")
    assert fallback is not None
    assert fallback.source == "env"


def test_state_returns_three_rows(fresh_resolver, monkeypatch):
    """state() returns one row per source in priority order, with masked
    token + whoami fields populated. The Settings UI consumes this."""
    tr = fresh_resolver
    from services import settings_store
    settings_store.set_hf_token(APP_TOKEN)
    monkeypatch.setenv("HF_TOKEN", ENV_TOKEN)
    _mock_get_token(monkeypatch, None)
    _mock_whoami(monkeypatch, {
        APP_TOKEN: {"name": "alice"},
        ENV_TOKEN: {"name": "bob"},
    })
    tr.invalidate_cache()
    s = tr.state()
    assert "sources" in s
    assert "active" in s
    assert [r.source for r in s["sources"]] == ["app", "env", "hf-cli"]
    assert s["active"] == "app"
    # masked format: hf_…<last 3 chars of the token>
    app_row = s["sources"][0]
    assert app_row.set is True
    assert app_row.masked is not None and app_row.masked.startswith("hf_")
    assert app_row.masked.endswith(APP_TOKEN[-3:])
    assert app_row.whoami_user == "alice"
    assert app_row.whoami_ok is True
    # HF-CLI row: unset
    cli_row = s["sources"][2]
    assert cli_row.set is False
    assert cli_row.masked is None


def test_save_writes_both_store_and_login(fresh_resolver, monkeypatch):
    """save_app_token() must update settings_store AND call
    huggingface_hub.login(token=..., add_to_git_credential=False) so the
    canonical HF file (~/.cache/huggingface/token) is in sync."""
    tr = fresh_resolver
    import huggingface_hub

    login_calls = []
    monkeypatch.setattr(
        huggingface_hub,
        "login",
        lambda **kw: login_calls.append(kw),
    )
    tr.save_app_token(APP_TOKEN)

    # Settings store now has it.
    from services import settings_store
    assert settings_store.get_hf_token() == APP_TOKEN

    # huggingface_hub.login was called with the right kwargs.
    assert len(login_calls) == 1
    call = login_calls[0]
    assert call.get("token") == APP_TOKEN
    # Pitfall #2: must always pass add_to_git_credential=False.
    assert call.get("add_to_git_credential") is False


def test_save_uses_add_to_git_credential_false(fresh_resolver, monkeypatch):
    """Standalone check for Pitfall #2 (explicit so reviewers see the
    invariant being enforced)."""
    tr = fresh_resolver
    import huggingface_hub
    captured = {}
    def _fake_login(**kwargs):
        captured.update(kwargs)
    monkeypatch.setattr(huggingface_hub, "login", _fake_login)
    tr.save_app_token(APP_TOKEN)
    assert captured.get("add_to_git_credential") is False


def test_clear_app_token_removes_from_store(fresh_resolver, monkeypatch):
    tr = fresh_resolver
    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "login", lambda **kw: None)
    monkeypatch.setattr(huggingface_hub, "logout", lambda: None)

    tr.save_app_token(APP_TOKEN)
    from services import settings_store
    assert settings_store.get_hf_token() == APP_TOKEN

    tr.clear_app_token(also_clear_hf_cli=False)
    assert settings_store.get_hf_token() is None


def test_clear_app_token_also_logs_out_when_requested(fresh_resolver, monkeypatch):
    tr = fresh_resolver
    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "login", lambda **kw: None)
    logout_calls = []
    monkeypatch.setattr(huggingface_hub, "logout", lambda: logout_calls.append(True))

    tr.save_app_token(APP_TOKEN)
    tr.clear_app_token(also_clear_hf_cli=True)
    assert logout_calls == [True]


def test_resolve_accepts_hugging_face_hub_token_alias(fresh_resolver, monkeypatch):
    """HF docs list HUGGING_FACE_HUB_TOKEN as the legacy env-var name; the
    resolver must accept either."""
    tr = fresh_resolver
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setenv("HUGGING_FACE_HUB_TOKEN", ENV_TOKEN)
    _mock_get_token(monkeypatch, None)
    _mock_whoami(monkeypatch, {ENV_TOKEN: {"name": "bob"}})
    tr.invalidate_cache()
    result = tr.resolve()
    assert result is not None
    assert result.source == "env"
    assert result.token == ENV_TOKEN
