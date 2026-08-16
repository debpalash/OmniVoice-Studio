"""Structural guard: no synthesis call site can ship without provenance marking.

The #1169 class: watermark coverage grew call-site-by-call-site (three
separate ``embed_watermark`` calls) until a fourth producer —
``/v1/audio/speech`` — shipped synthetic audio with no mark at all, with EU AI
Act Art. 50(2) applying from 2026-08-02. The fix is ONE chokepoint,
``services.watermark.mark_synthetic``; this guard makes the chokepoint
structurally load-bearing:

1. Every backend module that invokes a TTS synthesis primitive must reference
   ``mark_synthetic`` — or sit in the justified allowlist below. A future
   audio route that synthesizes without marking fails here before it ships.
2. Known producers must KEEP their ``mark_synthetic`` call (deleting one fails).
3. ``embed_watermark`` may not be called outside ``services/watermark.py`` —
   new code physically can't bypass the chokepoint's logging/uniformity.
4. Allowlist entries must still match the synthesis pattern (no stale
   exemptions accumulating).

Behavioral (detect-on-response) coverage per route lives in
tests/test_synthetic_audio_watermark_1169.py.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest
import torch

_BACKEND = Path(__file__).resolve().parents[1] / "backend"

#: Callee names that produce a synthetic speech tensor. Matching any of these
#: makes a module a "producer" that must route its output through
#: mark_synthetic. Single source of truth for the matcher below.
_SYNTH_CALLEES = frozenset({
    "_run_inference",               # OmniVoice model, generation.py primitive
    "_run_backend_inference",
    "generate_with_cached_ref",     # cached-reference OmniVoice path
    "synthesize_chapter",           # longform chapter assembly
})

#: The adapter-protocol engine call: ``<x>backend.generate(...)`` — matched
#: when the receiver's terminal name ends with ``backend`` (``backend``,
#: ``self.backend``, ``_backend``, ``tts_backend``), which in this codebase is
#: always the TTS adapter protocol.
_SYNTH_ADAPTER_METHOD = "generate"
_SYNTH_ADAPTER_RECEIVER_SUFFIX = "backend"


def _terminal_name(expr: ast.AST) -> str:
    """The rightmost identifier of a callee receiver: ``self.backend`` →
    ``backend``, ``_backend`` → ``_backend``; anything else → ``''``."""
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute):
        return expr.attr
    return ""


def _references(src: str, names: frozenset[str]) -> bool:
    """Does the source reference one of `names` in CODE — a ``Name`` or
    ``Attribute`` node, so direct calls, dotted calls, and callback/partial
    forms all count, while a comment or docstring mention cannot? Parse
    failure proves nothing, so it does NOT excuse the module."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in names:
            return True
        if isinstance(node, ast.Attribute) and node.attr in names:
            return True
    return False


def _calls(src: str, names: frozenset[str]) -> bool:
    """Does the source CALL one of `names` (bare or as a method)? Prose
    cannot satisfy it; an unparseable source is flagged, never excused —
    strict degrade, same policy as ``_synthesizes``."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return True
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id in names:
            return True
        if isinstance(func, ast.Attribute) and func.attr in names:
            return True
    return False


def _synthesizes(src: str) -> bool:
    """Does this module source actually CALL a synthesis primitive?

    AST-based so prose cannot trip it: a comment or docstring mentioning
    ``backend.generate`` (the worker transport's feature-flag rationale did
    exactly that and turned main red) is not a call site. A source that fails
    to parse is flagged, not excused — the guard degrades strict, never
    permissive.
    """
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return True
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id in _SYNTH_CALLEES:
            return True
        if isinstance(func, ast.Attribute):
            if func.attr in _SYNTH_CALLEES:
                return True
            if (
                func.attr == _SYNTH_ADAPTER_METHOD
                and _terminal_name(func.value).endswith(_SYNTH_ADAPTER_RECEIVER_SUFFIX)
            ):
                return True
    return False

#: Modules that legitimately touch synthesis primitives WITHOUT marking.
#: Every entry carries its justification; test_allowlist_is_not_stale keeps
#: the list honest.
_ALLOWED = {
    "api/routers/engines.py":
        "engine self-test: the synthesized audio is reduced to a sample count "
        "for a JSON verdict and never leaves the process",
    "services/tts_backend.py":
        "the engine-adapter layer itself — the seam BELOW the chokepoint; "
        "every caller marks the returned tensor",
}

#: Producers that must each keep a mark_synthetic call. (sonitranslate.py is
#: absent by design: its audio is synthesized inside the external sidecar and
#: never passes through our tensor stage — the gap is documented at the
#: /engines/sonitranslate/dub route, not silently ignored. services/gpu_sandbox.py
#: is a second documented gap: its subprocess renders via ``model.generate(...)``
#: — a receiver no rule matches, missed by the old regex too — and nothing wires
#: the module into a route yet. Wiring it in requires marking the returned
#: audio or renaming the receiver to the ``*backend`` adapter convention.)
_PRODUCERS = [
    "api/routers/generation.py",
    "api/routers/openai_compat.py",
    "api/routers/tts_stream.py",
    "api/routers/dub_generate.py",
    "api/routers/batch.py",
    "api/routers/audiobook.py",
    "api/routers/archetypes.py",
    "services/persona_bundle.py",
    # Remote execution: the synthesis happens on another machine, so the mark
    # has to be embedded there — the control plane only ever sees encoded
    # bytes. The guard walked api/ and services/ only, so this producer would
    # have shipped unmarked with every check green.
    "worker/executor.py",
]


def _py_files():
    for sub in ("api", "services", "worker"):
        for p in sorted((_BACKEND / sub).rglob("*.py")):
            yield p.relative_to(_BACKEND).as_posix(), p.read_text(encoding="utf-8")


def _offenders(files) -> list[str]:
    """Scan (rel, src) pairs for unmarked producers.

    Parse FIRST and flag anything that does not parse — an _ALLOWED entry
    exempts a module from the marking rule, never from being readable: a
    broken allowlisted source must fail loudly here instead of being
    silently skipped (CodeRabbit, PR #1573).
    """
    found = []
    for rel, src in files:
        try:
            ast.parse(src)
        except SyntaxError as exc:
            found.append(f"{rel} (does not parse: {exc})")
            continue
        if not _synthesizes(src):
            continue
        if rel in _ALLOWED or _references(src, frozenset({"mark_synthetic"})):
            continue
        found.append(rel)
    return found


def test_every_synthesis_module_routes_through_mark_synthetic():
    offenders = _offenders(_py_files())
    assert not offenders, (
        "Modules synthesize audio but never reference the mark_synthetic "
        f"chokepoint (EU AI Act Art. 50(2), #1169): {offenders}\n"
        "Either mark the produced audio (services.watermark.mark_synthetic at "
        "the tensor stage, before encoding) or add a justified _ALLOWED entry."
    )


def test_allowlist_cannot_suppress_a_parse_failure():
    """Regression (CodeRabbit, PR #1573): an _ALLOWED module whose source is
    unparseable must be flagged, not silently skipped by its exemption."""
    [offender] = _offenders([("api/routers/engines.py", "def broken(:\n")])
    assert "does not parse" in offender


@pytest.mark.parametrize("rel", _PRODUCERS)
def test_known_producer_still_marks(rel):
    src = (_BACKEND / rel).read_text(encoding="utf-8")
    assert _references(src, frozenset({"mark_synthetic"})), (
        f"{rel} lost its mark_synthetic call — its synthetic audio would ship "
        "without the Art. 50(2) provenance mark (#1169)."
    )


def test_embed_watermark_not_called_outside_the_chokepoint():
    offenders = []
    for rel, src in _py_files():
        if rel == "services/watermark.py":
            continue
        if _calls(src, frozenset({"embed_watermark"})):
            offenders.append(rel)
    assert not offenders, (
        f"Direct embed_watermark() calls bypass the mark_synthetic chokepoint: "
        f"{offenders} (#1169 — call mark_synthetic instead)"
    )


def test_allowlist_is_not_stale():
    # _PRODUCERS entries need only exist (persona_bundle marks pre-existing
    # reference audio rather than calling a synthesis primitive); _ALLOWED
    # entries must additionally still match the pattern they're exempt from.
    for rel in list(_ALLOWED) + _PRODUCERS:
        p = _BACKEND / rel
        assert p.is_file(), f"watermark-coverage list names a missing file: {rel}"
    for rel in _ALLOWED:
        src = (_BACKEND / rel).read_text(encoding="utf-8")
        try:
            ast.parse(src)
        except SyntaxError as exc:
            pytest.fail(f"allowlisted module no longer parses: {rel}: {exc}")
        assert _synthesizes(src), (
            f"{rel} no longer matches a synthesis primitive — remove it from "
            "tests/test_watermark_route_coverage.py so the guard stays sharp."
        )


# ── _synthesizes: the producer scan must see calls, not prose ────────────────


def test_synthesizes_ignores_mentions_in_comments_and_docstrings():
    """The class fix: prose naming a primitive is not a call site.

    worker/transport/server.py's feature-flag rationale mentions
    ``backend.generate`` in a comment and turned main red; the AST matcher must
    not repeat that.
    """
    comment_only = (
        "# A generic backend.generate() call accepts the same wire shape.\n"
        "FEATURES = frozenset({'remote_tts_render_v1'})\n"
    )
    docstring_only = (
        '"""Adapter notes: engines call backend.generate() directly."""\n'
        "def relay(x):\n"
        "    return x\n"
    )
    assert _synthesizes(comment_only) is False
    assert _synthesizes(docstring_only) is False


def test_synthesizes_flags_real_call_sites_in_all_matcher_shapes():
    """Guard strength: every call shape the old regex caught stays caught —
    and the adapter rule covers aliased receivers it missed (generation.py
    calls ``_backend.generate``)."""
    real = {
        "direct adapter call": "y = backend.generate(text='hi')\n",
        "bound adapter attribute": "y = self.backend.generate(text='hi')\n",
        "aliased adapter local": "y = _backend.generate(text='hi')\n",
        "method receiver": "y = self._run_inference(x)\n",
        "bare name": "y = _run_backend_inference(x)\n",
        "cached ref": "y = engine.generate_with_cached_ref(x)\n",
        "chapter assembly": "y = book.synthesize_chapter(ch)\n",
    }
    for label, src in real.items():
        assert _synthesizes(src) is True, label


def test_synthesizes_flags_unparseable_source():
    """A source that cannot parse is flagged, never excused.

    In a green tree every scanned module imports cleanly, so this branch
    fires only on genuinely broken input — and the guard degrades strict.
    """
    assert _synthesizes("def f(:\n    # mentions nothing\n") is True


# ── _references / _calls: excusals and call bans see code, not prose ─────────


def test_references_counts_code_forms_not_prose():
    """A prose mention of mark_synthetic must NOT excuse a producer (the
    inverse of the server.py incident), while every real code reference —
    direct call, dotted call, callback/partial — must."""
    prose_only = "# callers must mark_synthetic the result before encoding\nx = 1\n"
    docstring_only = '"""Remember to mark_synthetic all outputs."""\ny = f(x)\n'
    assert _references(prose_only, frozenset({"mark_synthetic"})) is False
    assert _references(docstring_only, frozenset({"mark_synthetic"})) is False
    real = {
        "direct call": "z = mark_synthetic(wav, 24000)\n",
        "dotted call": "z = watermark.mark_synthetic(wav, 24000)\n",
        "callback/partial": (
            "import functools\n"
            "mark = functools.partial(mark_synthetic, sample_rate=24000)\n"
        ),
    }
    for label, src in real.items():
        assert _references(src, frozenset({"mark_synthetic"})) is True, label


def test_calls_counts_call_sites_not_prose():
    """A comment saying 'do not call embed_watermark()' must not flag the
    module — the same prose-poisoning class that turned main red."""
    prose = "# do not call embed_watermark() directly; use mark_synthetic\n"
    assert _calls(prose, frozenset({"embed_watermark"})) is False
    assert _calls("z = embed_watermark(w)\n", frozenset({"embed_watermark"})) is True
    assert _calls("z = wm.embed_watermark(w)\n", frozenset({"embed_watermark"})) is True


# ── mark_synthetic unit contract (delegation, not new policy) ────────────────


def test_mark_synthetic_delegates_and_respects_pref(monkeypatch):
    from services import watermark

    calls = []
    monkeypatch.setattr(watermark, "_audioseal_available", True)

    class _Gen:
        def __call__(self, audio, sample_rate, message=None):
            calls.append(audio.shape[-1])
            return audio * 2.0

    monkeypatch.setattr(watermark, "_generator", _Gen())
    wav = torch.full((1, 2400), 0.1)

    monkeypatch.setattr(watermark, "is_enabled", lambda: False)
    assert watermark.mark_synthetic(wav, 24000, context="t") is wav  # pref off → untouched
    assert watermark.mark_synthetic(wav, 24000, context="t", force=True) is not wav
    monkeypatch.setattr(watermark, "is_enabled", lambda: True)
    assert watermark.mark_synthetic(wav, 24000, context="t") is not wav
    assert calls == [2400, 2400]


def test_mark_synthetic_never_raises(monkeypatch):
    from services import watermark

    monkeypatch.setattr(watermark, "_audioseal_available", True)
    monkeypatch.setattr(watermark, "is_enabled", lambda: True)

    class _Boom:
        def __call__(self, *a, **k):
            raise RuntimeError("audioseal exploded (test)")

    monkeypatch.setattr(watermark, "_generator", _Boom())
    wav = torch.full((1, 2400), 0.1)
    # Degrade-don't-block: the original audio passes through unchanged.
    assert watermark.mark_synthetic(wav, 24000, context="t") is wav


def test_will_mark_requires_pref_and_availability(monkeypatch):
    from services import watermark

    monkeypatch.setattr(watermark, "is_enabled", lambda: True)
    monkeypatch.setattr(watermark, "_audioseal_available", True)
    assert watermark.will_mark() is True
    monkeypatch.setattr(watermark, "_audioseal_available", False)
    assert watermark.will_mark() is False
    monkeypatch.setattr(watermark, "_audioseal_available", True)
    monkeypatch.setattr(watermark, "is_enabled", lambda: False)
    assert watermark.will_mark() is False
