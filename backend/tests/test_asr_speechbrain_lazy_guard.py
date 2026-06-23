"""speechbrain LazyModule cross-platform guard (#630/#611/#647).

speechbrain 1.x suppresses optional-integration imports (k2_fsa, numba, …) that
are triggered merely by introspection from the stdlib `inspect` module. Its
guard checked `filename.endswith("/inspect.py")` — a hardcoded POSIX separator —
so on Windows (backslash paths) the guard MISSED and a stray access to the
`speechbrain.k2_integration` redirect actually imported the (absent) k2 package,
raising `ImportError: Lazy import of LazyModule(...k2_fsa...) failed` that aborted
WhisperX transcription with zero segments.

`_harden_speechbrain_lazy_imports()` re-implements `ensure_module` with an
`os.path.basename` check so the guard fires on every platform. These tests fake
the importer frame (both Windows- and POSIX-style `inspect.py` paths, plus a
real-caller path) so they pin the behaviour regardless of the host OS.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

importutils = pytest.importorskip(
    "speechbrain.utils.importutils",
    reason="speechbrain not installed in this environment",
)
from services.asr_backend import _harden_speechbrain_lazy_imports  # noqa: E402


class _FakeFrameInfo:
    def __init__(self, filename):
        self.filename = filename


def _bogus_lazy_module():
    # A LazyModule whose target can never import — so we can observe whether the
    # inspect.py guard fired (AttributeError) or the import was attempted (ImportError).
    return importutils.LazyModule(
        "omnivoice_nonexistent_zzz",
        "omnivoice_nonexistent_zzz_target",
        None,
    )


@pytest.mark.parametrize(
    "inspect_path",
    [
        r"C:\Python311\Lib\inspect.py",   # Windows — the case the old guard missed
        "/usr/lib/python3.11/inspect.py",  # POSIX — already worked, must keep working
    ],
)
def test_guard_fires_for_inspect_frame_on_any_separator(monkeypatch, inspect_path):
    _harden_speechbrain_lazy_imports()
    lm = _bogus_lazy_module()
    monkeypatch.setattr(
        importutils.inspect, "getframeinfo",
        lambda *_a, **_k: _FakeFrameInfo(inspect_path),
    )
    # Guard must treat an inspect.py-triggered access as "attribute absent"
    # (AttributeError) rather than attempting the doomed import (ImportError).
    with pytest.raises(AttributeError):
        lm.ensure_module(0)


def test_real_caller_still_surfaces_import_error(monkeypatch):
    """A genuine access from real user code (not inspect.py) with the target
    missing must still raise ImportError — we only suppress inspect-triggered
    spurious imports, never legitimate failures."""
    _harden_speechbrain_lazy_imports()
    lm = _bogus_lazy_module()
    monkeypatch.setattr(
        importutils.inspect, "getframeinfo",
        lambda *_a, **_k: _FakeFrameInfo(r"C:\Users\me\app\real_caller.py"),
    )
    with pytest.raises(ImportError):
        lm.ensure_module(0)


def test_patch_is_idempotent():
    _harden_speechbrain_lazy_imports()
    first = importutils.LazyModule.ensure_module
    _harden_speechbrain_lazy_imports()
    assert importutils.LazyModule.ensure_module is first
    assert getattr(importutils.LazyModule, "_omnivoice_xplat_guard", False) is True
