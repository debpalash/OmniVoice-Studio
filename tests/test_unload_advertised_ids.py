"""#1247: `400 Bad Request: Unknown model id: engine:kittentts`.

Reported straight from `EngineCompatibilityMatrix.jsx` — the user opened
Settings and pressed Unload on a resident engine.

`list_loaded()` enumerates in-process engines as `engine:<id>` and marks
each ``"unloadable": True``. `unload()` handled `tts`, `diarization`,
`sidecars` and `sidecar:<id>` — and nothing else. The panel was offering a
button for an id the dispatcher rejected. The engines themselves have
implemented `unload()` the whole time; only the routing was missing.

The guard at the bottom is the point: the two functions are a *contract*, and
the bug was them disagreeing. Any future id the lister advertises as unloadable
must be one the dispatcher accepts.
"""
from __future__ import annotations

import pytest

from services import model_lifecycle


class _FakeEngine:
    """Stands in for an in-process backend (mlx-audio, kittentts, …)."""

    id = "kittentts"
    _MODEL_ATTRS = ("_model",)

    def __init__(self, loaded=True):
        self._model = object() if loaded else None
        self.unload_calls = 0

    def unload(self):
        self.unload_calls += 1
        self._model = None


@pytest.fixture
def fake_engines(monkeypatch):
    import api.routers.engines as engines_router

    instances = {}
    monkeypatch.setattr(engines_router, "_ENGINE_INSTANCES", instances, raising=False)
    return instances


# ── the reported failure ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unloading_a_resident_engine_no_longer_400s(fake_engines):
    engine = _FakeEngine(loaded=True)
    fake_engines[type(engine)] = engine

    result = await model_lifecycle.unload("engine:kittentts")

    assert result["success"] is True
    assert result["unloaded"] == "engine:kittentts"
    assert engine.unload_calls == 1
    assert engine._model is None, "the memory must actually be handed back"


@pytest.mark.asyncio
async def test_an_engine_that_holds_nothing_reports_not_loaded(fake_engines):
    """Same shape as the `tts` / `diarization` branches — a no-op, not an error."""
    engine = _FakeEngine(loaded=False)
    fake_engines[type(engine)] = engine

    result = await model_lifecycle.unload("engine:kittentts")

    assert result["success"] is False
    assert result["reason"] == "not loaded"
    assert engine.unload_calls == 0


@pytest.mark.asyncio
async def test_an_engine_that_is_not_instantiated_reports_not_loaded(fake_engines):
    """A stale panel row (the engine was already evicted) must not 400 either —
    the user pressing a button that raced a background eviction did nothing
    wrong."""
    result = await model_lifecycle.unload("engine:neverloaded")

    assert result["success"] is False
    assert result["reason"] == "not loaded"


@pytest.mark.asyncio
async def test_the_warm_dictation_asr_can_be_unloaded(monkeypatch):
    """A SECOND instance of the same defect, found by the contract test below
    rather than by a user: `capture-asr` was listed as unloadable and the
    dispatcher had no branch for it either."""
    import services.asr_backend as ab

    released = []
    monkeypatch.setattr(ab, "_capture_backend", object(), raising=False)
    monkeypatch.setattr(
        ab, "release_idle_capture_backend",
        lambda idle_s, **kw: (released.append(idle_s), True)[1],
        raising=False,
    )

    result = await model_lifecycle.unload("capture-asr")

    assert result["success"] is True
    assert released == [0.0], "an explicit Unload releases now, not after a timeout"


@pytest.mark.asyncio
async def test_dictation_in_progress_declines_rather_than_yanking_the_model(monkeypatch):
    import services.asr_backend as ab

    monkeypatch.setattr(ab, "_capture_backend", object(), raising=False)
    monkeypatch.setattr(
        ab, "release_idle_capture_backend", lambda idle_s, **kw: False, raising=False
    )

    result = await model_lifecycle.unload("capture-asr")

    assert result["success"] is False
    assert "dictation" in result["reason"]


@pytest.mark.asyncio
async def test_a_genuinely_unknown_id_still_raises(fake_engines):
    """The 400 is correct for an id nothing advertises — don't lose it."""
    with pytest.raises(ValueError, match="Unknown model id"):
        await model_lifecycle.unload("banana")


# ── the contract that was broken ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_every_advertised_unloadable_id_is_accepted(fake_engines, monkeypatch):
    """The recurrence guard.

    The panel renders an Unload button for every row with ``unloadable: True``.
    Advertising an id the dispatcher rejects is precisely #1247, and it will
    keep happening as new model kinds are added unless the two sides are
    checked against each other.
    """
    engine = _FakeEngine(loaded=True)
    fake_engines[type(engine)] = engine

    listing = model_lifecycle.list_loaded()
    advertised = [m["id"] for m in listing["models"] if m.get("unloadable")]
    assert "engine:kittentts" in advertised, "fixture engine should be listed"

    for model_id in advertised:
        try:
            await model_lifecycle.unload(model_id)
        except ValueError as e:  # pragma: no cover — this is the failure mode
            pytest.fail(
                f"{model_id} is advertised as unloadable but the dispatcher "
                f"rejects it: {e}"
            )
