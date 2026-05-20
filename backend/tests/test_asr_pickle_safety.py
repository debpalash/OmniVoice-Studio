"""Regression guard against the torch.load monkey-patch returning.

An earlier revision of ``services/asr_backend.py`` reassigned
``torch.load`` to a wrapper that forced ``weights_only=False`` for the
duration of ``whisperx.load_model``. The comment around it called the
trick "belt-and-braces" but it actually *defeated* PyTorch's secure
unpickler globally for any code that ran during that window. Any
concurrent ``torch.load`` call — even from an unrelated module — could
have deserialised an attacker-controlled pickle and executed arbitrary
code.

The correct mitigation is ``torch.serialization.add_safe_globals(...)``
on the specific classes the trusted (whisperx-shipped) VAD checkpoint
contains. That call lives in ``_allow_vad_pickle_globals``.

This test reads the source rather than running whisperx (which would
need a GPU model download). Same shape as ``tests/test_bind_host.py``:
if a future refactor reintroduces the monkey-patch — even to "scope it
tightly" or "make it a context manager" — this test fails with a pointer
to the security rationale.
"""
from __future__ import annotations

import io
import os
import sys
import tokenize
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


_ASR_BACKEND_PATH = (
    Path(__file__).resolve().parent.parent / "services" / "asr_backend.py"
)
_ASR_BACKEND_SRC = _ASR_BACKEND_PATH.read_text(encoding="utf-8")


def _executable_source(src: str) -> str:
    """Strip comments and string literals so a guard pattern only
    matches *real* code, not the rationale block that describes what we
    removed (which legitimately quotes the dangerous pattern). Same
    spirit as a Semgrep ``patterns: [pattern-not: in-comment]`` filter,
    done with the stdlib so the test has zero non-stdlib dependencies.
    """
    tokens = tokenize.generate_tokens(io.StringIO(src).readline)
    return "".join(
        t.string for t in tokens
        if t.type not in (tokenize.COMMENT, tokenize.STRING)
    )


_ASR_BACKEND_CODE = _executable_source(_ASR_BACKEND_SRC)


class TestNoMonkeyPatch:
    def test_torch_load_not_reassigned(self):
        assert "torch.load=" not in _ASR_BACKEND_CODE.replace(" ", ""), (
            "asr_backend.py reassigns torch.load — this defeats PyTorch's "
            "secure unpickler process-wide. Use "
            "torch.serialization.add_safe_globals() to whitelist the "
            "trusted pickle classes instead."
        )

    def test_serialization_load_not_reassigned(self):
        # Block the lower-level variant too: ``torch.serialization.load``
        # is what the deprecated patch reassigned to bypass call sites
        # that didn't go through ``torch.load``.
        assert "_ts.load=" not in _ASR_BACKEND_CODE.replace(" ", ""), (
            "asr_backend.py reassigns torch.serialization.load — same "
            "concern as the torch.load patch. Use add_safe_globals() "
            "instead."
        )

    def test_no_weights_only_false_override(self):
        # ``weights_only=False`` is the unsafe load mode. After comments
        # and strings are stripped, any remaining occurrence is a real
        # code path that disables the safety mechanism.
        normalized = _ASR_BACKEND_CODE.replace(" ", "")
        assert "weights_only=False" not in normalized, (
            "asr_backend.py contains executable `weights_only=False` — "
            "the unsafe pickle load path. Use the default "
            "(weights_only=True) and extend _allow_vad_pickle_globals() "
            "if a new pickle class is needed."
        )


class TestSafeGlobalsAllowlistPresent:
    """Counterpart to the above: the safe path must still be wired up.

    If a future refactor removes the allowlist call entirely (e.g. while
    upgrading whisperx), VAD loading silently breaks with a cryptic
    pickle error. The allowlist is load-bearing.
    """

    def test_allow_vad_pickle_globals_defined(self):
        assert "def _allow_vad_pickle_globals" in _ASR_BACKEND_SRC, (
            "asr_backend.py no longer defines _allow_vad_pickle_globals — "
            "the safe load path is gone. Restore it before VAD loading "
            "regresses."
        )

    def test_allow_vad_pickle_globals_invoked_in_ensure_asr(self):
        # Walk the lines from `def _ensure_asr` to the next `def ` and
        # assert the allowlist call appears inside that function body.
        lines = _ASR_BACKEND_SRC.splitlines()
        in_fn = False
        body: list[str] = []
        for line in lines:
            if line.startswith("    def _ensure_asr"):
                in_fn = True
                continue
            if in_fn and line.startswith("    def "):
                break
            if in_fn:
                body.append(line)
        joined = "\n".join(body)
        assert "_allow_vad_pickle_globals()" in joined, (
            "_ensure_asr no longer calls _allow_vad_pickle_globals() — "
            "VAD loading will fail with a cryptic pickle error on PyTorch "
            "≥2.6."
        )

    def test_uses_add_safe_globals_api(self):
        # The correct API is `torch.serialization.add_safe_globals`. If the
        # allowlist switches to anything else (e.g. a removed-in-2.x API),
        # this guard surfaces it during review.
        assert "add_safe_globals" in _ASR_BACKEND_SRC, (
            "asr_backend.py no longer references add_safe_globals — the "
            "documented secure-load mitigation. Refactor with caution."
        )
