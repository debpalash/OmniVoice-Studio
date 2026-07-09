"""Clone-purity guards in services.speaker_clone (speaker-hint fix).

A per-speaker auto-clone reference cut from mislabeled or boundary-adjacent
audio mixes two people's voices — the field-reported "made up" clone voices.
These tests pin the three guards:

  * per-slice minimum duration (MIN_SLICE_DURATION_S),
  * non-adjacency scoring preference (ADJACENT_TURN_GUARD_S) — a preference,
    never a hard filter,
  * labels_source="heuristic" skips extraction entirely.

Pure tests over a synthetic vocals wav — no model, no main import.
"""
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout

import numpy as np
import pytest
import soundfile as sf

from services.asr_backend import ASRTimeoutError, run_transcribe_guarded
from services.speaker_clone import (
    ADJACENT_TURN_GUARD_S,
    MIN_REF_DURATION_S,
    MIN_SLICE_DURATION_S,
    _pick_reference_slices,
    extract_speaker_clones,
    refine_ref_text,
    refine_ref_texts,
)

SR = 16000


@pytest.fixture
def vocals(tmp_path):
    # 60 s of non-silent audio so every segment slice has content.
    path = tmp_path / "vocals.wav"
    sf.write(str(path), np.float32(np.sin(np.linspace(0, 18000, 60 * SR))), SR)
    return str(path)


def _seg(start, end, speaker="Speaker 1", text="hello there"):
    return {"start": start, "end": end, "speaker_id": speaker, "text": text}


class TestPickReferenceSlices:
    def test_rejects_slices_below_minimum_duration(self):
        # Six 1.0 s fragments total 6 s (> MIN_REF_DURATION_S) — pre-fix they
        # were all picked; now every one is under MIN_SLICE_DURATION_S so the
        # speaker yields no reference at all (default voice beats a bad clone).
        items = [(i, _seg(i * 3.0, i * 3.0 + 1.0)) for i in range(6)]
        assert MIN_SLICE_DURATION_S > 1.0  # test premise
        assert 6 * 1.0 > MIN_REF_DURATION_S  # pre-fix these WOULD have passed
        assert _pick_reference_slices(items) == []

    def test_prefers_slice_not_adjacent_to_other_speaker(self):
        # Two equal-length candidates for Speaker 1; the first is 0.1 s away
        # from a Speaker 2 turn (< ADJACENT_TURN_GUARD_S), the second is far
        # from everyone. The clean one must win the ranking.
        adjacent = _seg(0.0, 8.0, "Speaker 1")
        other = _seg(8.1, 10.0, "Speaker 2")
        clean = _seg(20.0, 28.0, "Speaker 1")
        all_segments = [adjacent, other, clean]
        items = [(0, adjacent), (2, clean)]
        chosen = _pick_reference_slices(
            items, speaker_id="Speaker 1", all_segments=all_segments,
        )
        assert [seg for _, seg in chosen] == [clean]

    def test_adjacency_is_a_preference_not_a_hard_filter(self):
        # Dense dialogue: every Speaker 1 slice borders a Speaker 2 turn.
        # Extraction must still succeed using the adjacent slices.
        s1a = _seg(0.0, 6.0, "Speaker 1")
        s2a = _seg(6.1, 8.0, "Speaker 2")
        s1b = _seg(8.2, 12.0, "Speaker 1")
        all_segments = [s1a, s2a, s1b]
        items = [(0, s1a), (2, s1b)]
        chosen = _pick_reference_slices(
            items, speaker_id="Speaker 1", all_segments=all_segments,
        )
        assert chosen, "dense dialogue must still produce a reference"

    def test_heuristic_labels_source_returns_nothing(self):
        items = [(0, _seg(0.0, 8.0))]
        assert _pick_reference_slices(items, labels_source="heuristic") == []

    def test_legacy_call_without_kwargs_still_picks_long_slice(self):
        # Backward compat: positional-only invocation (the pre-fix signature)
        # keeps working and picks the long slice.
        long_seg = _seg(0.0, 8.0)
        chosen = _pick_reference_slices([(0, long_seg)])
        assert [seg for _, seg in chosen] == [long_seg]

    def test_overlapping_other_speaker_counts_as_adjacent(self):
        # Negative gap (overlap) must also be flagged — that is the worst
        # mixed-audio case of all.
        overlapped = _seg(0.0, 8.0, "Speaker 1")
        other = _seg(4.0, 6.0, "Speaker 2")
        clean = _seg(20.0, 28.0, "Speaker 1")
        chosen = _pick_reference_slices(
            [(0, overlapped), (2, clean)],
            speaker_id="Speaker 1",
            all_segments=[overlapped, other, clean],
        )
        assert [seg for _, seg in chosen] == [clean]


class TestExtractSpeakerClones:
    def test_heuristic_labels_source_skips_extraction(self, tmp_path, vocals):
        segs = [_seg(0.0, 8.0), _seg(10.0, 18.0, "Speaker 2")]
        out = extract_speaker_clones(
            vocals, segs, str(tmp_path), labels_source="heuristic",
        )
        assert out == {}

    @pytest.mark.parametrize("source", [None, "pyannote", "turns"])
    def test_trusted_labels_still_extract(self, tmp_path, vocals, source):
        # None (legacy caller, missing kwarg) and real diarization sources
        # keep the current behavior: clones are produced.
        segs = [_seg(0.0, 8.0), _seg(10.0, 18.0, "Speaker 2")]
        kwargs = {} if source is None else {"labels_source": source}
        out = extract_speaker_clones(vocals, segs, str(tmp_path), **kwargs)
        assert set(out) == {"Speaker 1", "Speaker 2"}
        for info in out.values():
            assert info["duration"] >= MIN_REF_DURATION_S

    def test_adjacency_guard_constant_sane(self):
        # The guard must stay tighter than the heuristic's own gap threshold,
        # or every real turn boundary would be flagged.
        from services.segmentation import SPEAKER_GAP
        assert 0 < ADJACENT_TURN_GUARD_S < SPEAKER_GAP


class _FakeASR:
    """Stands in for the active ASR backend's .transcribe() — no model, no
    network. `chunks_by_path` maps a ref_audio path to the canned chunk list
    that path's re-transcription should return."""
    def __init__(self, chunks_by_path=None, raises_for=()):
        self.chunks_by_path = chunks_by_path or {}
        self.raises_for = set(raises_for)
        self.calls = []

    def transcribe(self, path, *, word_timestamps=True):
        self.calls.append(path)
        if path in self.raises_for:
            raise RuntimeError("simulated ASR failure")
        return {"chunks": self.chunks_by_path.get(path, []), "language": "es"}


class TestRefineRefText:
    # Issue #1004: the ASR segment's `text` field and its `[start, end]`
    # timestamps routinely drift (a trailing word audible in the slice but
    # missing from the text, or vice versa) — pairing a mismatched (ref_audio,
    # ref_text) breaks zero-shot TTS prompt priming badly enough that the
    # clone can speak the reference text verbatim instead of the target text.
    # Re-transcribing the actual written clip guarantees the pair matches.

    def test_replaces_mismatched_text_with_the_actual_clip_transcript(self):
        asr = _FakeASR(chunks_by_path={
            "/tmp/ref.wav": [{"text": "hola"}, {"text": "que tal"}],
        })
        out = refine_ref_text("/tmp/ref.wav", asr, fallback_text="mismatched source text")
        assert out == "hola que tal"
        assert asr.calls == ["/tmp/ref.wav"]

    def test_falls_back_to_original_text_on_asr_failure(self):
        asr = _FakeASR(raises_for={"/tmp/ref.wav"})
        out = refine_ref_text("/tmp/ref.wav", asr, fallback_text="original text")
        assert out == "original text"

    def test_falls_back_to_original_text_on_empty_transcript(self):
        # A clip ASR can't get any text out of (e.g. near-silent) shouldn't
        # wipe out a usable original — empty is worse than stale.
        asr = _FakeASR(chunks_by_path={"/tmp/ref.wav": []})
        out = refine_ref_text("/tmp/ref.wav", asr, fallback_text="original text")
        assert out == "original text"

    def test_no_asr_backend_is_a_strict_no_op(self):
        # Preflight ASR load failure, or any other reason the caller has no
        # backend to hand in — never a crash, never blocks the original path.
        out = refine_ref_text("/tmp/ref.wav", None, fallback_text="original text")
        assert out == "original text"


class TestRefineRefTexts:
    def test_refines_every_entry_in_place_and_returns_the_dict(self):
        asr = _FakeASR(chunks_by_path={
            "/tmp/spk1.wav": [{"text": "hola amigo"}],
            "/tmp/spk2.wav": [{"text": "buenos dias"}],
        })
        clones = {
            "Speaker 1": {"ref_audio": "/tmp/spk1.wav", "ref_text": "stale 1"},
            "Speaker 2": {"ref_audio": "/tmp/spk2.wav", "ref_text": "stale 2"},
        }
        out = refine_ref_texts(clones, asr)
        assert out is clones  # mutated in place, returned for call-and-reassign
        assert clones["Speaker 1"]["ref_text"] == "hola amigo"
        assert clones["Speaker 2"]["ref_text"] == "buenos dias"

    def test_a_failing_entry_does_not_affect_the_others(self):
        asr = _FakeASR(
            chunks_by_path={"/tmp/spk2.wav": [{"text": "buenos dias"}]},
            raises_for={"/tmp/spk1.wav"},
        )
        clones = {
            "Speaker 1": {"ref_audio": "/tmp/spk1.wav", "ref_text": "kept on failure"},
            "Speaker 2": {"ref_audio": "/tmp/spk2.wav", "ref_text": "stale 2"},
        }
        refine_ref_texts(clones, asr)
        assert clones["Speaker 1"]["ref_text"] == "kept on failure"
        assert clones["Speaker 2"]["ref_text"] == "buenos dias"


class _HangingASR:
    """An ASR backend whose .transcribe() *wedges* (blocks) instead of raising
    — the #730 whisperx/CTranslate2 hang. `refine_ref_text`'s try/except only
    catches a raised Exception, so on its own this dispatch has no wall-clock
    bound; it must go through the same `run_transcribe_guarded` every other
    transcribe in dub_core.py uses."""
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def transcribe(self, path, *, word_timestamps=True):
        self.started.set()
        self.release.wait()  # blocks until the test releases it
        return {"chunks": [{"text": "arrived too late"}]}


class TestRefineWedgeIsGuarded:
    # Issue #730 class: a re-transcribe can hang rather than raise. The other
    # transcribe dispatches in dub_core.py bound this via run_transcribe_guarded
    # (chunk loop + whole-file "Dub"); the clone/segment refine dispatches must
    # too, or a wedge holds the 1-worker GPU pool forever ("can't reach backend").

    def test_refine_ref_texts_alone_has_no_wall_clock_bound(self):
        # Proves the gap: dispatched raw (as #1008 did), a wedged transcribe
        # never returns — refine_ref_text's except can't catch a hang.
        asr = _HangingASR()
        clones = {"S1": {"ref_audio": "/tmp/a.wav", "ref_text": "orig"}}
        pool = ThreadPoolExecutor(max_workers=1)
        fut = pool.submit(refine_ref_texts, clones, asr)
        assert asr.started.wait(timeout=2.0)
        with pytest.raises(FuturesTimeout):
            fut.result(timeout=0.3)  # still blocked — no internal bound
        asr.release.set()            # let the worker unwind before teardown
        pool.shutdown(wait=False)

    def test_run_transcribe_guarded_bounds_the_wedge_and_falls_back(self):
        # Proves the fix: routing the same call through the guard bounds the
        # hang, raises ASRTimeoutError, and the original ref_text is preserved
        # (matching refine_ref_text's "failure is a strict no-op" fallback).
        asr = _HangingASR()
        clones = {"S1": {"ref_audio": "/tmp/a.wav", "ref_text": "orig"}}
        pool = ThreadPoolExecutor(max_workers=1)

        async def _go():
            with pytest.raises(ASRTimeoutError):
                await run_transcribe_guarded(
                    pool, lambda: refine_ref_texts(clones, asr),
                    what="Dub clone ref-text refine", timeout=0.3,
                )

        asyncio.run(_go())
        assert clones["S1"]["ref_text"] == "orig"  # fallback kept the original
        asr.release.set()
        pool.shutdown(wait=False)
