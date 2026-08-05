"""A job's clone references must live in ITS directory, not a neighbour's (#1331).

Reported from Discord (in Russian): re-dubbing a single sentence loses the
cloned voice; only a full re-dub keeps it. #1361 made the mechanism visible —
the reference path is handed to the engine but the file is gone. This is the
root cause for the identified class:

On a content-hash cache hit (same video dubbed twice), ``find_cached_job``
points the NEW job's ``vocals_path`` into the OLD job's directory — that is the
cache working as designed. But ``dub_core`` then extracted the new job's clone
references into ``os.path.dirname(vocals_path)``, i.e. **into the old job's
directory too**. Delete that older history entry — an ordinary, sanctioned
action that ``rmtree``s its dir — and every clone reference of the newer job
dangles. From then on each single-segment regen silently renders in the
default voice, and a full re-dub "fixes" it only because prep re-extracts.

The fix is one argument: clones are written into the CURRENT job's own dir.
"""
from __future__ import annotations

import ast
import importlib
import os
import sys

import numpy as np
import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

sf = pytest.importorskip("soundfile")


def _extraction_call():
    """The ``extract_speaker_clones(...)`` call node in dub_core, by AST —
    a comment mentioning the right directory must not satisfy this."""
    src = open(
        os.path.join(os.path.dirname(__file__), "..", "backend", "api",
                     "routers", "dub_core.py"),
        encoding="utf-8",
    ).read()
    for node in ast.walk(ast.parse(src)):
        if (isinstance(node, ast.Call)
                and getattr(node.func, "id", getattr(node.func, "attr", None))
                == "extract_speaker_clones"):
            return node, src
    raise AssertionError("extract_speaker_clones call not found in dub_core.py")


def test_the_out_dir_is_not_derived_from_the_vocals_path():
    """The bug, stated directly: ``os.path.dirname(vocals_for_clone)`` follows
    the vocals into whichever job dir the cache resolved them from."""
    call, _ = _extraction_call()
    out_dir_arg = ast.unparse(call.args[2])
    assert "dirname" not in out_dir_arg, (
        f"the clone out_dir is again derived from the vocals path "
        f"({out_dir_arg!r}) — on a cache hit that is an OLDER job's directory, "
        f"and deleting that job orphans this one's clone references (#1331)"
    )


def test_the_out_dir_comes_from_the_jobs_own_id():
    call, src = _extraction_call()
    out_dir_arg = ast.unparse(call.args[2])
    # The argument is a variable; its assignment must resolve via the job id.
    assert "_clone_dir" in out_dir_arg
    assert "_safe_job_dir(job_id)" in src.split("fut_clones")[0].rsplit(
        "extract_speaker_clones", 2)[0][-2000:] or "_safe_job_dir(job_id)" in src, (
        "the clone out_dir is no longer anchored to this job's own directory"
    )


def test_extraction_honours_an_out_dir_away_from_the_vocals(tmp_path):
    """Functional half: vocals in one job's dir, clones requested in another's
    — the written reference files must land in the requested dir, so deleting
    the vocals-owning job cannot orphan them."""
    from services.speaker_clone import extract_speaker_clones

    old_job = tmp_path / "job-old"
    new_job = tmp_path / "job-new"
    old_job.mkdir()
    new_job.mkdir()

    sr = 16000
    rng = np.random.default_rng(0)
    audio = (rng.standard_normal(sr * 12) * 0.1).astype(np.float32)
    vocals = old_job / "vocals.wav"
    sf.write(vocals, audio, sr)

    segments = [
        {"start": 0.0, "end": 5.5, "text": "first line", "speaker_id": "Speaker 1"},
        {"start": 6.0, "end": 11.5, "text": "second line", "speaker_id": "Speaker 1"},
    ]
    clones = extract_speaker_clones(str(vocals), segments, str(new_job))
    assert clones, "no clone extracted from 11s of speech"
    for info in clones.values():
        ref = info["ref_audio"]
        assert os.path.dirname(ref) == str(new_job), (
            f"clone reference written next to the vocals ({ref}) instead of "
            f"into the requesting job's dir"
        )
        assert os.path.isfile(ref)

    # The point of the whole exercise: the old job's dir can now die without
    # taking the new job's voice with it.
    import shutil
    shutil.rmtree(old_job)
    for info in clones.values():
        assert os.path.isfile(info["ref_audio"])


def _all_extraction_calls():
    """BOTH extraction call sites in dub_core — the per-speaker one and the
    per-segment one (the default). The first version of this fix covered only
    the former; both reviewers caught the latter, which is how the class
    survives a spot fix. Sweeping every call keeps a third copy honest too."""
    src = open(
        os.path.join(os.path.dirname(__file__), "..", "backend", "api",
                     "routers", "dub_core.py"),
        encoding="utf-8",
    ).read()
    calls = [
        node for node in ast.walk(ast.parse(src))
        if isinstance(node, ast.Call)
        and getattr(node.func, "id", getattr(node.func, "attr", None))
        in ("extract_speaker_clones", "extract_segment_refs")
    ]
    assert len(calls) >= 2, "expected both extraction call sites in dub_core"
    return calls


def test_no_extraction_call_derives_its_out_dir_from_the_vocals():
    for call in _all_extraction_calls():
        out_dir_arg = ast.unparse(call.args[2])
        assert "dirname" not in out_dir_arg, (
            f"an extraction call writes next to the vocals again "
            f"({ast.unparse(call.func)}: {out_dir_arg!r}) — on a cache hit "
            f"that is an older job's directory (#1331)"
        )


def test_segment_refs_honour_an_out_dir_away_from_the_vocals(tmp_path):
    """Functional half for the DEFAULT path: per-segment clips land in the
    requesting job's dir and survive the vocals-owning job's deletion."""
    from services.speaker_clone import extract_segment_refs

    old_job = tmp_path / "job-old"
    new_job = tmp_path / "job-new"
    old_job.mkdir()
    new_job.mkdir()

    sr = 16000
    rng = np.random.default_rng(1)
    audio = (rng.standard_normal(sr * 12) * 0.1).astype(np.float32)
    vocals = old_job / "vocals.wav"
    sf.write(vocals, audio, sr)

    segments = [
        {"start": 0.0, "end": 5.5, "text": "first line", "speaker_id": "Speaker 1"},
        {"start": 6.0, "end": 11.5, "text": "second line", "speaker_id": "Speaker 1"},
    ]
    refs = extract_segment_refs(str(vocals), segments, str(new_job), seg_ids=[0, 1])
    assert refs, "no per-segment refs extracted from two 5.5s lines"

    import shutil
    shutil.rmtree(old_job)
    for info in refs.values():
        assert os.path.dirname(info["ref_audio"]) == str(new_job)
        assert os.path.isfile(info["ref_audio"])
