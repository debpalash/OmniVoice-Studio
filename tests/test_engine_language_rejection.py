"""#1257: `400 Bad Request: Invalid language code. Supported languages: ar
(Arabic), da (Danish), de (German), …`

The reporter was on mlx-audio and got a bare recitation of 23 language codes.
Nothing in it says which engine is refusing, that OmniVoice offers 646
languages because a *different* engine supports them, or that switching engines
is the fix. Three generate attempts in their action log, all identical.

The cause is stated outright in `MLXAudioBackend.supported_languages`:

    # Per-model; Kokoro supports 8, Qwen3 ~4, Kugel 24. Return "multi"
    # so the language picker doesn't gate by engine — each engine
    # silently ignores languages it doesn't know.

The last clause is not true. The engine's library raises, so the picker offers
languages the active engine will reject, and the rejection arrives with no
context. Enumerating every model's real language list would be a brittle map
that goes stale on each engine update; naming the engine and the way out is
both accurate and durable.
"""
from __future__ import annotations

import pytest

from api.routers.generation import _language_rejection_or


class _Engine:
    id = "mlx-audio"
    display_name = "MLX Audio"


REPORTED = (
    "Invalid language code. Supported languages: ar (Arabic), da (Danish), "
    "de (German), el (Greek), en (English), es (Spanish)"
)


def test_the_reported_error_names_the_engine_and_the_way_out():
    rewritten = _language_rejection_or(ValueError(REPORTED), _Engine(), "bn")

    assert isinstance(rewritten, ValueError)
    message = str(rewritten)
    assert "MLX Audio" in message, "the user must learn WHICH engine refused"
    assert "'bn'" in message, "...and which language it refused"
    assert "Model Catalogue → Engines" in message, "...and where to fix it"
    # The engine's own list is still useful — keep it rather than hide it.
    assert "ar (Arabic)" in message


@pytest.mark.parametrize(
    "reason",
    [
        "Invalid language code. Supported languages: en, es",
        "Unsupported language: bn",
        "RuntimeError: language not supported by this checkpoint",
        "ValueError: This language is not supported",
    ],
)
def test_every_wording_of_a_language_rejection_is_caught(reason):
    """Each engine multiplexes a different third-party library, so the class
    and the wording both vary — match on meaning."""
    rewritten = _language_rejection_or(RuntimeError(reason), _Engine(), "bn")
    assert "Model Catalogue → Engines" in str(rewritten)


def test_a_language_rejection_becomes_a_ValueError():
    """The route maps ValueError → 400 and everything else → 500. A user
    picking an unsupported language is a validation problem, not a crash."""
    rewritten = _language_rejection_or(RuntimeError(REPORTED), _Engine(), "bn")
    assert isinstance(rewritten, ValueError)


def test_an_unrelated_failure_is_returned_untouched():
    """This wraps every exception on the path, so it must be inert for the
    rest — an OOM rewritten as a language problem would be far worse than the
    bug being fixed."""
    oom = RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")
    assert _language_rejection_or(oom, _Engine(), "en") is oom

    disk = OSError("[Errno 28] No space left on device")
    assert _language_rejection_or(disk, _Engine(), "en") is disk


def _run(backend, exc, language="bn"):
    """Drive the real `_run_backend_inference` with a backend that raises."""
    from api.routers.generation import _run_backend_inference

    class _Raiser:
        id = getattr(backend, "id", "x")
        display_name = getattr(backend, "display_name", None)
        sample_rate = 24000
        applies_own_mastering = True

        def generate(self, *a, **kw):
            raise exc

    return _run_backend_inference(
        _Raiser(), "hello", language, None, None, None, None,
        None, None, 1.0, False, False, None,
    )


def test_the_wiring_rewrites_a_language_rejection_end_to_end():
    """Exercised through the real call path, not by reading its source: an
    assertion on source text passes even when the call is unreachable or its
    result discarded (#1224 taught this lesson on this same codebase)."""
    with pytest.raises(ValueError) as caught:
        _run(_Engine(), RuntimeError(REPORTED))

    assert "Model Catalogue → Engines" in str(caught.value)
    assert "MLX Audio" in str(caught.value)


def test_an_oom_still_reaches_the_oom_path():
    """The rewrite wraps every failure on the path, so the OOM handling that
    was already there must survive it."""
    with pytest.raises(Exception) as caught:
        _run(_Engine(), RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB"))

    message = str(caught.value)
    assert "Model Catalogue → Engines" not in message, "an OOM is not a language problem"
    # _oom_friendly_reraise rewrites it into its own guidance.
    assert "memory" in message.lower()


def test_a_nameless_backend_still_names_itself():
    """`or "engine" in message` would always pass — the production template
    contains the word — so it proved nothing about the fallback (#1257
    review). Assert the class name the fallback actually resolves to."""
    class _Bare:
        pass

    message = str(_language_rejection_or(ValueError(REPORTED), _Bare(), None))
    assert "_Bare" in message
    assert "Model Catalogue → Engines" in message


@pytest.mark.parametrize(
    "reason",
    [
        "Unsupported language model configuration: gpt2-medium",
        "unsupported language modeling head",
    ],
)
def test_a_model_failure_that_merely_says_unsupported_language_is_untouched(reason):
    """Review finding (#1257): a bare "unsupported language" prefix also
    matches "Unsupported language model ...", which is a model/config problem
    that would then be handed engine-switch advice it has no use for."""
    exc = RuntimeError(reason)
    assert _language_rejection_or(exc, _Engine(), "en") is exc


@pytest.mark.parametrize(
    "reason",
    ["Unsupported language: bn", "Unsupported language 'bn'", "Unsupported language"],
)
def test_a_genuine_unsupported_language_still_matches(reason):
    assert "Model Catalogue → Engines" in str(
        _language_rejection_or(RuntimeError(reason), _Engine(), "bn")
    )
