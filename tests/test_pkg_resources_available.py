"""Regression for #224 (and #58): whisperx / faster-whisper import
`pkg_resources` at runtime. setuptools 80+ dropped the bundled pkg_resources,
so an unpinned `setuptools>=75` resolves to a version WITHOUT it — which both
breaks WhisperX transcription ("No module named 'pkg_resources'") and makes its
is_available() report "No ASR backend is ready". The setuptools pin (<80) must
keep a version that still ships pkg_resources.
"""
import importlib.util


def test_pkg_resources_importable():
    assert importlib.util.find_spec("pkg_resources") is not None, (
        "pkg_resources is missing — the installed setuptools dropped it. "
        "Keep the setuptools pin below the version that removed pkg_resources "
        "(pyproject.toml / issue #224)."
    )
