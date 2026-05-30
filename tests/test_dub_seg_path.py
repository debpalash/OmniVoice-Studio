"""dub_seg_path — stable-id-keyed per-segment WAV path (#185).

Assert on the filename + job dir (invariants), not the absolute DUB_DIR — other
tests reload core.config against a fixture data dir, so the module-level DUB_DIR
constant can differ from the instance dub_seg_path closes over.
"""
import os

import pytest

from core.config import dub_seg_path


def test_keys_by_stable_id():
    assert os.path.basename(dub_seg_path("job1", "5")) == "seg_5.wav"
    # A bare numeric index sanitises to the legacy seg_{i}.wav name, so old jobs
    # keep resolving through the same helper.
    assert os.path.basename(dub_seg_path("job1", 5)) == "seg_5.wav"
    # A stable id that is NOT the current index maps to its own file (the fix).
    assert os.path.basename(dub_seg_path("job1", "abc-12")) == "seg_abc-12.wav"
    # Lives under the job's own directory.
    assert os.path.basename(os.path.dirname(dub_seg_path("job1", "5"))) == "job1"


def test_sanitises_against_path_traversal():
    p = dub_seg_path("job1", "../../etc/passwd")
    assert os.path.basename(p) == "seg_.._.._etc_passwd.wav"  # slashes neutralised
    assert os.path.basename(os.path.dirname(p)) == "job1"      # stays in the job dir
    assert os.path.basename(dub_seg_path("job1", "a b/c")) == "seg_a_b_c.wav"


def test_rejects_parent_dir_job_id():
    # A bare ".." component survives sanitisation (dots are allowed) but the
    # realpath containment guard rejects it.
    with pytest.raises(ValueError):
        dub_seg_path("..", "5")
