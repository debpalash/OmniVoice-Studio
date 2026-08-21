"""A dictation model that decodes nothing gets demoted, not re-selected forever.

On Windows, `sherpa-parakeet-tdt-v3` installs cleanly, loads without error,
and returns an empty token list for clear speech
(both quantisations, both decoding methods, sherpa-onnx 1.13.3 and 1.13.4)
while whisper and zipformer transcribe the same bytes. The defect is inside
sherpa-onnx's NeMo-TDT decoder — unfixable from here by configuration.

Whisper Tiny is now the cross-platform default, while Parakeet remains
selectable. Runtime demotion still protects users who select a recognizer that
loads successfully but decodes nothing: it is demoted on this machine and the
next session follows the capture fallback.

These tests pin the demotion round trip and, critically, that the user can
always take back control by re-picking the model.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from services import sherpa_dictation as sd  # noqa: E402

MODEL = "sherpa-parakeet-tdt-v3"


@pytest.fixture(autouse=True)
def _clean_slate():
    sd.clear_demotion()
    yield
    sd.clear_demotion()


def test_a_fresh_model_is_not_demoted():
    assert sd.is_demoted(MODEL) is False
    assert sd.demoted_models() == []


def test_demoting_persists_and_is_idempotent():
    assert sd.demote_model(MODEL) is True      # newly demoted
    assert sd.is_demoted(MODEL) is True
    assert sd.demote_model(MODEL) is False     # already known — no duplicate
    assert sd.demoted_models().count(MODEL) == 1


def test_demotion_is_per_model_not_global():
    """One broken model must not disable every other dictation option."""
    sd.demote_model(MODEL)
    assert sd.is_demoted("sherpa-whisper-tiny") is False


def test_selection_skips_a_demoted_model():
    """The payoff: dictation stops auto-selecting the model that returns
    nothing and routes to the capture ASR engine (None) instead."""
    from core import prefs
    from services.asr_backend import dictation_model_id

    prefs.set_("dictation.enabled", True)
    prefs.set_("dictation.model_id", MODEL)
    assert dictation_model_id() == MODEL       # healthy: selected

    sd.demote_model(MODEL)
    assert dictation_model_id() is None        # demoted: fall through


def test_user_can_always_take_back_control():
    """Re-picking the model in Settings clears the demotion — otherwise a
    demoted model could never be chosen again, and a sherpa upgrade that fixed
    the decoder would be unreachable."""
    sd.demote_model(MODEL)
    assert sd.is_demoted(MODEL) is True
    sd.clear_demotion(MODEL)
    assert sd.is_demoted(MODEL) is False


def test_clear_demotion_without_args_forgets_everything():
    sd.demote_model(MODEL)
    sd.demote_model("sherpa-parakeet-tdt-v2")
    sd.clear_demotion()
    assert sd.demoted_models() == []


def test_demoting_nothing_is_a_noop():
    assert sd.demote_model("") is False
    assert sd.is_demoted(None) is False
