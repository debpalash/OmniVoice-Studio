"""Phase 1.1 / 2.7 — translator service.

Validates the glossary prompt-prefixing and the graceful "no LLM" path.
Does NOT hit a real LLM — the client is mocked.
"""
import os
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

from unittest.mock import MagicMock, patch
import pytest

from services import translator as tr


# ── Glossary preamble ──────────────────────────────────────────────────────


def test_glossary_text_empty_inputs():
    assert tr._glossary_text(None) == ""
    assert tr._glossary_text([]) == ""
    assert tr._glossary_text([{"source": "", "target": "y"}]) == ""


def test_glossary_text_includes_each_term():
    out = tr._glossary_text([
        {"source": "Marcus", "target": "Marcus", "note": "character name"},
        {"source": "breakthrough", "target": "Durchbruch"},
    ])
    assert "Marcus → Marcus" in out
    assert "breakthrough → Durchbruch" in out
    assert "character name" in out


# ── No-LLM graceful path ───────────────────────────────────────────────────


def test_cinematic_no_llm_returns_literal_with_marker(monkeypatch):
    monkeypatch.setattr(tr, "_llm_client", lambda: None)
    res = tr.cinematic_refine_sync(
        "Hello.",
        "Hola.",
        source_lang="en",
        target_lang="es",
    )
    # With no LLM, "text" falls back to literal and an error marker is present.
    assert res["text"] == "Hola."
    assert res["literal"] == "Hola."
    assert res["critique"] == ""
    assert res.get("error") == "no-llm"


def test_cinematic_empty_literal_is_passthrough():
    res = tr.cinematic_refine_sync(
        "Source",
        "",
        source_lang="en",
        target_lang="es",
    )
    assert res["text"] == ""
    assert res["literal"] == ""
    # No error when there's literally nothing to refine.
    assert "error" not in res


# ── Happy-path 3-step chain (mocked client) ────────────────────────────────


def test_cinematic_full_chain_with_mocked_llm(monkeypatch):
    calls = []
    responses = iter([
        "reads stiff; prefer idiomatic phrasing",  # reflect
        "Hola, mundo.",                             # adapt
    ])

    def fake_chat(client, *, system, user):
        calls.append({"system": system, "user": user})
        return next(responses)

    mock_client = MagicMock()
    monkeypatch.setattr(tr, "_llm_client", lambda: mock_client)
    monkeypatch.setattr(tr, "_chat", fake_chat)

    res = tr.cinematic_refine_sync(
        "Hello, world.",
        "Hola mundo.",
        source_lang="en",
        target_lang="es",
        glossary=[{"source": "world", "target": "mundo"}],
    )
    assert res["literal"] == "Hola mundo."
    assert res["text"] == "Hola, mundo."
    assert res["critique"] == "reads stiff; prefer idiomatic phrasing"
    assert len(calls) == 2
    # Glossary prepended to both system prompts (reflect + adapt).
    assert "world → mundo" in calls[0]["system"]
    assert "world → mundo" in calls[1]["system"]


def test_cinematic_reflect_failure_returns_literal(monkeypatch):
    mock_client = MagicMock()
    monkeypatch.setattr(tr, "_llm_client", lambda: mock_client)

    def boom(*a, **kw):
        raise RuntimeError("LLM down")
    monkeypatch.setattr(tr, "_chat", boom)

    res = tr.cinematic_refine_sync(
        "Hello",
        "Hola",
        source_lang="en",
        target_lang="es",
    )
    assert res["text"] == "Hola"
    assert res["literal"] == "Hola"
    assert "reflect" in res.get("error", "")


# ── Divergence guard (v0.3.9 field report: hallucinated dub lines) ─────────


def _mock_chain(monkeypatch, reflect: str, adapt: str):
    """Wire cinematic_refine_sync to a mocked 2-step REFLECT→ADAPT chain."""
    responses = iter([reflect, adapt])
    monkeypatch.setattr(tr, "_llm_client", lambda: MagicMock())
    monkeypatch.setattr(tr, "_chat", lambda client, *, system, user: next(responses))


def test_cinematic_adapt_runaway_length_falls_back_to_literal(monkeypatch):
    """The reported bug: for a Latin-script target the script check passes ANY
    text, so a hallucinated wall of dialogue used to ship as the dub line."""
    literal = "¿Cómo estás hoy, amigo mío?"
    _mock_chain(monkeypatch, "fine but a bit stiff", "Hola amigo. " * 30)  # ~13× the literal
    res = tr.cinematic_refine_sync(
        "How are you doing today, my friend?", literal,
        source_lang="en", target_lang="es",
    )
    assert res["text"] == literal
    assert res.get("error") == "adapt-diverged"
    assert res["critique"] == "fine but a bit stiff"  # UI still sees what happened


def test_cinematic_adapt_critique_echo_rejected(monkeypatch):
    """ADAPT returning the critique itself must not become the dub line."""
    literal = "¿Cómo estás hoy, amigo mío? Hace mucho que no te veo por aquí."
    critique = (
        "The literal translation reads stiff and does not fit the slot; "
        "prefer a shorter, more idiomatic phrasing with warmer tone."
    )
    _mock_chain(monkeypatch, critique, critique)  # adapt echoes the critique verbatim
    res = tr.cinematic_refine_sync(
        "How are you doing today, my friend? Long time no see.", literal,
        source_lang="en", target_lang="es",
    )
    assert res["text"] == literal
    assert res.get("error") == "adapt-diverged"


def test_cinematic_sane_adaptation_accepted(monkeypatch):
    """A faithful, idiomatic rewrite passes every guard untouched."""
    literal = "¿Cómo estás hoy, amigo mío? Hace mucho que no te veo."
    adapted = "¿Qué tal, amigo? ¡Cuánto tiempo sin verte!"
    _mock_chain(monkeypatch, "a bit formal; contract it", adapted)
    res = tr.cinematic_refine_sync(
        "How are you doing today, my friend? Long time no see.", literal,
        source_lang="en", target_lang="es",
    )
    assert res["text"] == adapted
    assert "error" not in res


def test_cinematic_adapt_wrong_script_falls_back_to_literal(monkeypatch):
    """ADAPT output off the target script degrades to the literal with the
    script-specific marker (the pre-existing fallback, previously untested)."""
    literal = "नमस्ते मेरे दोस्त, आप कैसे हैं?"
    _mock_chain(monkeypatch, "solid but wordy", "This is English, not Hindi, sorry.")
    res = tr.cinematic_refine_sync(
        "Hello my friend, how are you?", literal,
        source_lang="en", target_lang="hi",
    )
    assert res["text"] == literal
    assert res.get("error") == "adapt-wrong-script:hi"


def test_chat_pins_low_temperature(monkeypatch):
    """Cinematic reflect/adapt must pin temperature like the Fast path does —
    the provider default of 1.0 is what let local models drift into invention."""
    client = MagicMock()
    client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="ok"))])
    monkeypatch.setattr(tr, "_llm_model", lambda: "test-model")
    assert tr._chat(client, system="s", user="u") == "ok"
    assert client.chat.completions.create.call_args.kwargs["temperature"] == 0.2


def test_refine_guard_short_reference_uses_absolute_cap():
    # A 2-word line legitimately triples — the ratio window must not apply.
    ok, _ = tr.refine_output_ok("¡No!", "¡Claro que no, jamás!", "es")
    assert ok
    # …but a wall of text after a 2-word line is still divergence.
    ok, reason = tr.refine_output_ok("¡No!", "x" * 200, "es")
    assert not ok and reason.startswith("length-abs")


def test_refine_guard_ratio_env_override(monkeypatch):
    literal = "¿Cómo estás hoy, amigo mío?"
    ok, reason = tr.refine_output_ok(literal, literal * 4, "es")
    assert not ok and reason.startswith("length-ratio")
    monkeypatch.setenv("OMNIVOICE_REFINE_RATIO_MAX", "5.0")
    ok, _ = tr.refine_output_ok(literal, literal * 4, "es")
    assert ok  # ceiling raised via env, mirroring the _cinematic_budget pattern


# ── Cinematic pass wall-clock budget (#stall follow-up) ────────────────────

def test_cinematic_budget_degrades_slow_segments_to_literal(monkeypatch):
    """A slow LLM must not hang the translate: the pass returns within the
    budget and unfinished segments fall back to their literal translation."""
    import asyncio
    import time
    from concurrent.futures import ThreadPoolExecutor

    monkeypatch.setenv("OMNIVOICE_CINEMATIC_BUDGET_S", "0.3")

    def _slow(src, lit, **kw):
        time.sleep(3.0)  # far over the 0.3s budget
        return {"text": "REFINED", "literal": lit, "critique": ""}

    monkeypatch.setattr(tr, "cinematic_refine_sync", _slow)
    pairs = [("s1", "hi", "hola"), ("s2", "world", "mundo")]

    async def _run():
        ex = ThreadPoolExecutor(max_workers=4)
        t0 = time.time()
        out = await tr.cinematic_refine_many(
            pairs, source_lang="en", target_lang="es", executor=ex,
        )
        return time.time() - t0, out

    dt, out = asyncio.run(_run())
    assert dt < 2.0, f"budget did not bound the pass (took {dt:.1f}s)"
    assert [r["id"] for r in out] == ["s1", "s2"]      # order + length preserved
    for r in out:
        assert r["text"] == r["literal"]                # degraded to literal
        assert r.get("error") == "cinematic-budget"


def test_cinematic_budget_disabled_runs_to_completion(monkeypatch):
    """Budget <= 0 disables the bound — every segment gets its refine."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    monkeypatch.setenv("OMNIVOICE_CINEMATIC_BUDGET_S", "0")
    monkeypatch.setattr(
        tr, "cinematic_refine_sync",
        lambda src, lit, **kw: {"text": f"R:{lit}", "literal": lit, "critique": ""},
    )

    async def _run():
        return await tr.cinematic_refine_many(
            [("s1", "hi", "hola")], source_lang="en", target_lang="es",
            executor=ThreadPoolExecutor(max_workers=2),
        )

    out = asyncio.run(_run())
    assert out[0]["text"] == "R:hola" and "error" not in out[0]
