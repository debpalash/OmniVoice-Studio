"""#1287: MOSS-TTS-Nano reported "ready", then died on the first generate.

    cannot import name 'MossTTSNano' from 'moss_tts_nano'

`is_available()` only checked that the MODULE imported. The reporter had the
package installed — so the engine advertised itself as ready, they switched to
it, and the failure arrived at generate time as a raw ImportError.

MOSS-TTS-Nano is installed straight from git with no pinned release and its
exported class has changed. The durable fix is not to chase the current name: an
availability check that does not verify the API it will actually call is a check
that lies, whatever the name happens to be today.
"""
from __future__ import annotations

import types

import pytest


def _backend():
    from services import tts_backend

    return tts_backend


class _Model:
    @classmethod
    def from_pretrained(cls, *a, **k):
        return cls()


def _module(**names):
    return types.SimpleNamespace(**names)


@pytest.mark.parametrize(
    "exported",
    ["MossTTSNano", "MOSSTTSNano", "MossTTS", "MossTTSNanoForCausalLM"],
)
def test_resolves_every_name_upstream_has_used(exported):
    tb = _backend()
    assert tb._moss_model_class(_module(**{exported: _Model})) is _Model


def test_returns_none_when_no_model_class_is_present():
    """The regression: this is the shape that used to advertise itself ready."""
    tb = _backend()
    assert tb._moss_model_class(_module(__version__="0.3.0", helper=lambda: None)) is None


def test_a_name_without_from_pretrained_does_not_count():
    """Matching on name alone would move the failure, not fix it."""
    tb = _backend()

    class NotAModel:
        pass

    assert tb._moss_model_class(_module(MossTTSNano=NotAModel)) is None


def test_error_names_what_is_actually_exported():
    """"missing X" is a dead end; "found Y" is something the user can act on
    and something we can turn into a one-line fix."""
    tb = _backend()

    class Renamed:
        @classmethod
        def from_pretrained(cls, *a, **k):
            return cls()

    found = tb._moss_candidate_exports(_module(SomeNewName=Renamed, _private=Renamed))
    assert found == ["SomeNewName"], found


def test_availability_reports_unready_when_the_class_is_gone(monkeypatch):
    """End-to-end: installed package, wrong API → unavailable with a reason,
    instead of ready-then-crash."""
    import sys

    tb = _backend()
    monkeypatch.setitem(sys.modules, "moss_tts_nano", _module(__version__="9.9"))
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace())

    ok, msg = tb.MossTTSNanoBackend.is_available()
    assert ok is False
    assert "does not expose a usable model class" in msg
    # Actionable: says how to fix it and invites the missing name.
    assert "pip install -e ." in msg


def test_availability_is_ready_when_the_class_is_there(monkeypatch):
    import sys

    tb = _backend()
    monkeypatch.setitem(sys.modules, "moss_tts_nano", _module(MossTTSNano=_Model))
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace())

    ok, msg = tb.MossTTSNanoBackend.is_available()
    assert ok is True and msg == "ready"


def test_missing_package_still_says_install_it(monkeypatch):
    """The pre-existing message must survive — a missing package and a renamed
    class are different problems with different fixes."""
    import builtins
    import sys

    tb = _backend()
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace())
    monkeypatch.delitem(sys.modules, "moss_tts_nano", raising=False)
    real_import = builtins.__import__

    def _no_moss(name, *a, **k):
        if name == "moss_tts_nano":
            raise ImportError("No module named 'moss_tts_nano'")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _no_moss)
    ok, msg = tb.MossTTSNanoBackend.is_available()
    assert ok is False
    assert "not installed" in msg
