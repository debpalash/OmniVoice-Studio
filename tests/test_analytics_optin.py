"""Opt-in analytics — the three rules, pinned.

OmniVoice is local-first, so an analytics SDK gets held to a higher bar. These
tests exist so the guarantees can't quietly rot:

  1. OFF unless the user says yes (default False; silence is not consent).
  2. NO exception autocapture — the SDK's own default would ship raw tracebacks
     carrying home paths and, in this codebase, Hugging Face tokens out of
     exception messages, bypassing core.failure.sanitize() entirely.
  3. Metadata ONLY, enforced by allowlist — so no future caller can leak the text
     of a take, a file path, or a voice name by adding a property.
"""
from __future__ import annotations

import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest

from core import analytics


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """Fresh prefs + no token + no kill switch, per test."""
    from core import prefs

    monkeypatch.setattr(prefs, "_PREFS_PATH", str(tmp_path / "prefs.json"))
    monkeypatch.delenv("POSTHOG_PROJECT_TOKEN", raising=False)
    monkeypatch.delenv("OMNIVOICE_ANALYTICS_DISABLED", raising=False)
    analytics.shutdown()
    yield
    analytics.shutdown()


# ── Rule 1: off unless the user says yes ────────────────────────────────────


def test_off_by_default_even_when_the_build_ships_a_token(monkeypatch):
    """The whole promise: a default install transmits nothing."""
    monkeypatch.setenv("POSTHOG_PROJECT_TOKEN", "phc_test")
    assert analytics.user_opted_in() is False
    assert analytics.enabled() is False


def test_opting_in_without_a_token_still_cannot_transmit(monkeypatch):
    """A source build has no destination — the toggle must not pretend otherwise."""
    analytics.set_opted_in(True)
    assert analytics.user_opted_in() is True
    assert analytics.token_configured() is False
    assert analytics.enabled() is False


def test_enabled_only_when_BOTH_gates_are_true(monkeypatch):
    monkeypatch.setenv("POSTHOG_PROJECT_TOKEN", "phc_test")
    analytics.set_opted_in(True)
    assert analytics.enabled() is True


def test_kill_switch_outranks_everything(monkeypatch):
    monkeypatch.setenv("POSTHOG_PROJECT_TOKEN", "phc_test")
    analytics.set_opted_in(True)
    monkeypatch.setenv("OMNIVOICE_ANALYTICS_DISABLED", "1")
    assert analytics.enabled() is False


def test_withdrawing_consent_takes_effect_immediately(monkeypatch):
    monkeypatch.setenv("POSTHOG_PROJECT_TOKEN", "phc_test")
    analytics.set_opted_in(True)
    assert analytics.enabled() is True
    analytics.set_opted_in(False)
    assert analytics.enabled() is False
    # capture() after opting out must be a no-op, not a queued event.
    analytics.capture("speech_generated", {"engine_id": "omnivoice"})


def test_a_broken_prefs_file_does_not_enable_tracking(monkeypatch):
    from core import prefs

    def boom(*a, **k):
        raise RuntimeError("prefs corrupt")

    monkeypatch.setattr(prefs, "get", boom)
    assert analytics.user_opted_in() is False  # fails CLOSED


# ── Rule 3: metadata only, enforced by allowlist ────────────────────────────


def test_allowlist_drops_anything_that_could_carry_user_content():
    dirty = {
        # The things that must NEVER leave:
        "text": "my private script about a confidential merger",
        "audio_path": "/Users/someone/voice.wav",
        "voice_name": "Grandma's voice",
        "profile_name": "Client - Acme Corp",
        "email": "a@b.com",
        "prompt": "secret",
        # The things that may:
        "engine_id": "omnivoice",
        "language": "en",
        "text_length": 120,
        "has_profile": True,
        "duration_seconds": 3.4,
        "error_type": "RuntimeError",
    }
    clean = analytics.sanitize_properties(dirty)

    assert clean == {
        "engine_id": "omnivoice",
        "language": "en",
        "text_length": 120,
        "has_profile": True,
        "duration_seconds": 3.4,
        "error_type": "RuntimeError",
    }
    blob = repr(clean)
    assert "confidential merger" not in blob
    assert "/Users/" not in blob
    assert "Grandma" not in blob


def test_a_long_string_is_refused_even_on_an_allowlisted_key():
    """Belt and braces: free text must not ride in on a legitimate key."""
    clean = analytics.sanitize_properties({"language": "x" * 500, "engine_id": "omnivoice"})
    assert "language" not in clean
    assert clean == {"engine_id": "omnivoice"}


def test_sanitize_handles_none_and_empty():
    assert analytics.sanitize_properties(None) == {}
    assert analytics.sanitize_properties({}) == {}


# ── Rule 2: no exception autocapture ────────────────────────────────────────


def test_client_is_built_with_exception_autocapture_OFF(monkeypatch):
    """The SDK's own default ships raw tracebacks — home paths, and in this
    codebase HF tokens out of exception messages — bypassing the redaction in
    core.failure.sanitize(). It must be explicitly disabled."""
    monkeypatch.setenv("POSTHOG_PROJECT_TOKEN", "phc_test")
    analytics.set_opted_in(True)

    captured_kwargs = {}

    class FakePosthog:
        def __init__(self, token, **kwargs):
            captured_kwargs.update(kwargs)

        def capture(self, *a, **k):
            pass

        def shutdown(self):
            pass

    import sys
    import types

    fake_mod = types.ModuleType("posthog")
    fake_mod.Posthog = FakePosthog
    monkeypatch.setitem(sys.modules, "posthog", fake_mod)

    analytics.capture("speech_generated", {"engine_id": "omnivoice"})

    assert captured_kwargs.get("enable_exception_autocapture") is False


def test_capture_never_raises_even_if_the_sdk_explodes(monkeypatch):
    monkeypatch.setenv("POSTHOG_PROJECT_TOKEN", "phc_test")
    analytics.set_opted_in(True)

    class Boom:
        def __init__(self, *a, **k):
            raise RuntimeError("network on fire")

    import sys
    import types

    fake_mod = types.ModuleType("posthog")
    fake_mod.Posthog = Boom
    monkeypatch.setitem(sys.modules, "posthog", fake_mod)

    analytics.capture("speech_generated", {"engine_id": "omnivoice"})  # must not raise


def test_installation_id_is_random_not_derived_from_the_machine():
    iid = analytics.installation_id()
    assert analytics.installation_id() == iid  # stable across calls
    import socket

    assert socket.gethostname() not in iid
    assert os.environ.get("USER", "nope") not in iid
