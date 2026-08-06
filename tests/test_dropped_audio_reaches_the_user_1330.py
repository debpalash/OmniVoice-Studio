"""Missing audio has to reach the USER, not just the log (#1330).

Reported as "this app dosent generate me the last few sentences": the take
comes back clean and simply short, so nothing in the product ever says a
sentence went missing. #1360 added a WARNING log line — which records the bug
for us and tells the user nothing, because nobody reads a log to find out
whether the audio they just made is complete.

So the render now collects the text it lost and the response carries it:
headers on the classic path (the body is a WAV), a `warning` frame before
`done` on the streaming one. These tests pin the collection and both carriers;
the toast that renders them is covered by the frontend suite.
"""

import ast
import os
import sys

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "backend"))

torch = pytest.importorskip("torch")

SR = 24_000


@pytest.fixture()
def ct():
    """Resolve the module per test rather than at collection.

    A module-level import binds whatever ``sys.modules`` held when this file
    was collected, which an earlier test may have replaced (CodeRabbit).
    """
    import importlib

    return importlib.import_module("services.chunked_tts")


def _tone(n=2400):
    return torch.ones(1, n, dtype=torch.float32)


def _empty():
    return torch.zeros(1, 0, dtype=torch.float32)


# ── the render collects what it lost ────────────────────────────────────────


def test_concatenate_records_the_text_of_every_dropped_chunk(ct):
    sink = []
    texts = ["first sentence.", "the tail that vanished.", "third."]
    out = ct.concatenate_audio_chunks(
        [_tone(), _empty(), _tone()], SR, 0, texts=texts, sink=sink
    )
    assert sink == ["the tail that vanished."]
    # ...and the audio it COULD render is still returned. Announcing the loss
    # must never cost the user the take that did work.
    assert out.shape[-1] == 4800


def test_a_dropped_final_chunk_is_recorded_even_when_it_is_the_only_loss(ct):
    # The reported shape exactly: the tail is what goes missing.
    sink = []
    ct.concatenate_audio_chunks(
        [_tone(), _tone(), _empty()], SR, 0,
        texts=["a.", "b.", "the last few sentences."], sink=sink,
    )
    assert sink == ["the last few sentences."]


def test_none_chunks_count_as_losses_too(ct):
    sink = []
    ct.concatenate_audio_chunks([_tone(), None], SR, 0, texts=["a.", "b."], sink=sink)
    assert sink == ["b."]


def test_join_rendered_chunks_records_through_every_one_of_its_branches(ct):
    # join_rendered_chunks has three exits — nothing kept, exactly one kept
    # (which bypasses the concat), and the normal join. The single-kept branch
    # is the one that shipped silent once already.
    nothing = []
    assert ct.join_rendered_chunks([None, None], SR, texts=["a.", "b."], sink=nothing) is None
    assert nothing == ["a.", "b."]

    one = []
    kept = ct.join_rendered_chunks([_tone(), _empty()], SR, texts=["a.", "b."], sink=one)
    assert kept is not None and one == ["b."]

    many = []
    ct.join_rendered_chunks(
        [_tone(), _empty(), _tone()], SR, texts=["a.", "b.", "c."], sink=many
    )
    assert many == ["b."]


def test_a_complete_render_records_nothing(ct):
    sink = []
    ct.concatenate_audio_chunks([_tone(), _tone()], SR, 0, texts=["a.", "b."], sink=sink)
    assert sink == []


def test_the_count_survives_when_the_text_is_unavailable(ct):
    # Callers that never had per-chunk text still must not under-report: the
    # user needs to know something was lost even if we cannot quote it.
    sink = []
    ct.concatenate_audio_chunks([_tone(), _empty(), None], SR, 0, sink=sink)
    assert len(sink) == 2


def test_a_broken_sink_cannot_break_the_render(ct):
    # A diagnostic must never be able to turn a working render into a failure.
    class Hostile:
        def extend(self, _):
            raise RuntimeError("nope")

    ct.report_dropped_chunks([0], 2, ["a."], Hostile())


# ── both response carriers exist ────────────────────────────────────────────


def _generation_src():
    return open(os.path.join(REPO, "backend/api/routers/generation.py"), encoding="utf-8").read()


def test_every_inference_entry_point_accepts_the_sink(ct):
    # If a path forgets the parameter, that path silently truncates again —
    # with the collection code right next to it looking correct.
    tree = ast.parse(_generation_src())
    entry = {"_run_inference", "_run_backend_inference"}
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in entry:
            names = {a.arg for a in node.args.kwonlyargs}
            assert "dropped_sink" in names, f"{node.name} cannot report dropped audio"
            found.add(node.name)
    assert found == entry


def test_the_classic_path_puts_the_loss_in_the_response_headers():
    # The classic response body is a WAV, so headers are the only channel.
    src = _generation_src()
    assert "X-OmniVoice-Dropped-Chunks" in src
    assert "X-OmniVoice-Dropped-Text" in src
    # The quoted text must go through the header sanitizer, or a newline in the
    # user's own text could split the response headers.
    head = src[src.index("X-OmniVoice-Dropped-Text") - 400:src.index("X-OmniVoice-Dropped-Text")]
    assert "header_safe_reason" in head


def test_the_streaming_path_emits_a_warning_frame_before_done():
    # Order matters: a consumer that stops reading at `done` would never see a
    # warning emitted after it.
    src = _generation_src()
    warn = src.index('"type": "warning", "code": "dropped_chunks"')
    done = src.index('"type": "done", "id": meta["id"]')
    assert warn < done


def test_the_warning_frame_is_not_an_error_frame():
    # It must not be shaped like `error`: the take is real and playable, and
    # the streaming client treats `error` as a signal to tear down and fall
    # back to a full re-render.
    src = _generation_src()
    frame = src[src.index('"type": "warning"'):]
    frame = frame[:frame.index("})")]
    assert '"count"' in frame and '"text"' in frame
    assert "retryable" not in frame
