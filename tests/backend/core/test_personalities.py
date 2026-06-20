"""Regression test for issue #89.

Bug: clicking any personality button in the Design tab made the next
Synthesize call crash with a 400 ValueError. Root cause: the personality
``instruct`` strings shipped as prose ("Speak clearly and professionally
like a television news presenter") instead of the comma-separated
taxonomy tokens OmniVoice's ``_resolve_instruct`` accepts.

This test guards the personalities registry so we never regress: every
personality's ``instruct`` must pass the validator the same model code
path runs at synthesis time.

If you add a new personality, ``instruct`` must be a comma-separated
string of tokens drawn from ``omnivoice.utils.voice_design._INSTRUCT_ALL_VALID``
(see ``backend/core/personalities.py`` for the full taxonomy list).
"""
from __future__ import annotations

import pytest


# Import directly from core — no torch / model load needed for this check.
# tests/conftest.py prepends ``backend/`` to ``sys.path`` (the same way the
# uvicorn launcher does with ``--app-dir backend``), so ``core`` resolves
# to ``backend/core``.
from core.personalities import get_personalities, get_personality


# ── Helpers ────────────────────────────────────────────────────────────────


def _import_resolver():
    """Import the same ``_resolve_instruct`` the runtime calls.

    Lives in ``omnivoice.models.omnivoice`` (the upstream model module),
    which transitively pulls torch. We skip the test if torch isn't
    available in the current environment — the test still runs on dev
    machines and in CI where torch is part of the test extras.
    """
    pytest.importorskip("torch")
    pytest.importorskip("omnivoice")
    from omnivoice.models.omnivoice import _resolve_instruct  # type: ignore[import-not-found]

    return _resolve_instruct


# ── Schema sanity ──────────────────────────────────────────────────────────


def test_personality_registry_shape():
    personalities = get_personalities()
    assert isinstance(personalities, list) and personalities, (
        "Design tab needs at least one personality to render the strip"
    )
    seen_ids: set[str] = set()
    for p in personalities:
        # Every personality must expose these fields — the frontend reads
        # them by name in ``CloneDesignTab.jsx``.
        for key in ("id", "name", "instruct", "icon"):
            assert key in p, f"personality {p.get('name')!r} missing {key!r}"
            assert isinstance(p[key], str), (
                f"personality {p.get('name')!r} field {key!r} must be a string"
            )
        assert p["id"] not in seen_ids, f"duplicate personality id {p['id']!r}"
        seen_ids.add(p["id"])


def test_get_personality_lookup():
    p = get_personality("narrator")
    assert p is not None and p["id"] == "narrator"
    assert get_personality("does_not_exist") is None


# ── Issue #89 regression ───────────────────────────────────────────────────


def test_every_personality_instruct_is_accepted_by_resolve_instruct():
    """The exact failing path from issue #89.

    Clicking a personality button sets ``instruct = p.instruct`` on the
    frontend. The Design tab's Synthesize call sends that string as the
    ``instruct`` form field, the router forwards it to
    ``model.generate(instruct=...)``, and the model runs
    ``_resolve_instruct`` first thing. If any token is rejected, the
    whole synthesis call raises ``ValueError`` (HTTP 400 to the UI).

    Guarantee: every shipped personality must round-trip through
    ``_resolve_instruct`` without raising.
    """
    resolve_instruct = _import_resolver()
    for p in get_personalities():
        try:
            normalised = resolve_instruct(p["instruct"])
        except ValueError as exc:
            pytest.fail(
                f"Personality {p['id']!r} instruct {p['instruct']!r} was "
                f"rejected by OmniVoice — this is the exact #89 crash. "
                f"Fix: replace prose with comma-separated taxonomy tokens "
                f"from omnivoice.utils.voice_design._INSTRUCT_ALL_VALID. "
                f"Underlying error: {exc}"
            )
        # The normaliser returns either None (for empty) or a non-empty
        # string. We don't want any personality to silently collapse to
        # None — that would mean the picked instruct had no effect.
        assert normalised, (
            f"Personality {p['id']!r} instruct {p['instruct']!r} normalised "
            "to nothing — pick at least one taxonomy token."
        )


def test_resolve_instruct_tolerates_object_object_sentinel():
    """A pre-fix Voice Studio build persisted the literal "[object Object]" into
    voice_profiles.instruct (#550 et al). _resolve_instruct must DROP that
    sentinel and not 400 the whole generation, while still rejecting a genuine
    unsupported token."""
    resolve_instruct = _import_resolver()
    # sentinel alone → treated as empty (no ValueError); returns falsy
    assert not resolve_instruct("[object Object]")
    assert not resolve_instruct("[OBJECT object]")  # case-insensitive
    # sentinel mixed with a valid token → the valid token survives, no raise
    assert resolve_instruct("male, [object Object]") == "male"
    # a real unsupported token must STILL raise (the #114/#115 user feedback)
    with pytest.raises(ValueError):
        resolve_instruct("frobnicate")
