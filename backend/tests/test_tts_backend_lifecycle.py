"""Lifecycle contract for ``TTSBackend.unload`` — Phase 2 foundation.

Wave 1 adds the method to the ABC as a default no-op. Phase 2 will:
  • Override it per-engine (release the model, free VRAM, drop file handles).
  • Add a CI gate that fails when a new subclass forgets to override.
  • Wire the registry to call unload() on engine switch and shutdown.

This test file pins the *contract* so Phase 2 has something to migrate
against. Each assertion expresses an invariant that overriders must
preserve:

  1. ``unload`` is a real attribute on the ABC (not just docstring prose).
  2. It is callable with no arguments and returns None.
  3. It is idempotent — calling it twice in a row must not raise.
  4. Every existing subclass inherits it (no NotImplementedError today).

If any of these fail, the lifecycle contract regressed and the
registry can no longer safely call unload() without per-engine handling.
"""
from __future__ import annotations

import inspect
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


def _load_tts_backend_module():
    """Import services.tts_backend without forcing the heavy engine deps
    that some subclasses pull in at module import. We don't need a live
    engine to validate the ABC contract.
    """
    from services import tts_backend  # noqa: WPS433 — late import is the point
    return tts_backend


class TestUnloadOnABC:
    def test_unload_defined_on_base_class(self):
        tts = _load_tts_backend_module()
        assert hasattr(tts.TTSBackend, "unload"), (
            "TTSBackend lost the unload() method. Phase 2 engine isolation "
            "relies on it; restore the default no-op on the ABC."
        )

    def test_unload_is_not_abstract(self):
        # If unload() becomes @abstractmethod in this commit, every
        # subclass that hasn't migrated yet stops instantiating. Phase 2
        # may flip this — but Wave 1 must not.
        tts = _load_tts_backend_module()
        abstracts = getattr(tts.TTSBackend, "__abstractmethods__", frozenset())
        assert "unload" not in abstracts, (
            "TTSBackend.unload is @abstractmethod — that breaks every "
            "subclass that hasn't migrated. Keep it a default no-op in "
            "Wave 1; flip to abstract only in Phase 2 alongside per-engine "
            "overrides + CI gate."
        )

    def test_unload_signature_takes_self_only(self):
        tts = _load_tts_backend_module()
        sig = inspect.signature(tts.TTSBackend.unload)
        # Single positional `self` parameter — engine-switch in the
        # registry must call it with no arguments.
        params = list(sig.parameters.values())
        assert len(params) == 1, (
            f"TTSBackend.unload should take only `self`; got {params}. "
            "The registry calls it as `backend.unload()` with no args."
        )
        # The module uses `from __future__ import annotations`, which
        # stringifies return annotations. Accept the string form too.
        assert sig.return_annotation in (None, type(None), "None", inspect.Signature.empty), (
            f"TTSBackend.unload should return None (or be unannotated); "
            f"got annotation {sig.return_annotation!r}."
        )


class TestUnloadDefaultBehavior:
    """The default no-op must actually be safe to call."""

    def _make_minimal_subclass(self):
        """Build a concrete TTSBackend that implements only the abstract
        bits, leaving unload() inherited from the ABC.
        """
        import torch
        tts = _load_tts_backend_module()

        class _MinimalBackend(tts.TTSBackend):
            id = "test-minimal"
            display_name = "Minimal Test Backend"

            @property
            def sample_rate(self) -> int:
                return 24000

            @property
            def supported_languages(self) -> list[str]:
                return ["en"]

            @classmethod
            def is_available(cls):
                return True, "test"

            def generate(self, text: str, **kw) -> "torch.Tensor":
                return torch.zeros(1, 1)

        return _MinimalBackend()

    def test_default_unload_returns_none(self):
        backend = self._make_minimal_subclass()
        result = backend.unload()
        assert result is None, (
            "Default TTSBackend.unload() must return None — callers rely "
            "on it as a fire-and-forget cleanup hook."
        )

    def test_default_unload_is_idempotent(self):
        backend = self._make_minimal_subclass()
        # Two back-to-back calls must not raise. Real overriders need this
        # property to handle "user spam-clicks the engine switch" gracefully.
        try:
            backend.unload()
            backend.unload()
        except Exception as exc:  # pragma: no cover — failure surfaces here
            pytest.fail(
                f"Default TTSBackend.unload() not idempotent: {exc!r}. "
                "Overriders must preserve this — make sure your override "
                "is safe to call twice."
            )


class TestExistingSubclassesInherit:
    """No engine in services/tts_backend.py should explode if you call
    ``unload()`` on it before its first generate() — which is exactly what
    the registry will do during a fast engine-switch.
    """

    def test_all_subclasses_have_callable_unload(self):
        tts = _load_tts_backend_module()
        subclasses = [
            cls for cls in vars(tts).values()
            if isinstance(cls, type)
            and issubclass(cls, tts.TTSBackend)
            and cls is not tts.TTSBackend
        ]
        # Sanity: the file is supposed to ship at least 9 engines today.
        assert len(subclasses) >= 1, (
            "No TTSBackend subclasses found in services.tts_backend. "
            "Did the registry split into another module without updating "
            "this test?"
        )
        for cls in subclasses:
            assert callable(getattr(cls, "unload", None)), (
                f"{cls.__name__} has no callable unload() — even via the "
                "ABC inheritance. Did someone shadow it?"
            )