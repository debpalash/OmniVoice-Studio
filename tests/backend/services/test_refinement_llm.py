"""Phase-2 dictation refinement (Wave 2.1) — prompt builder + maybe_refine.

No real LLM: the active backend is monkeypatched. The pass-through contract
(raw transcript stands on ANY failure) is the load-bearing behavior here.
"""

from __future__ import annotations

import pytest

from services import refinement
from services.refinement import (
    REFINEMENT_EXAMPLES,
    RefinementFlags,
    build_refinement_prompt,
)


# ── Prompt builder ──────────────────────────────────────────────────────────

def test_all_flags_on_includes_all_sections():
    p = build_refinement_prompt(RefinementFlags())
    assert "text filter, not an assistant" in p
    assert "Remove disfluencies" in p
    assert "changes their mind mid-utterance" in p
    assert "Preserve technical terms" in p


def test_flags_off_drop_sections():
    p = build_refinement_prompt(RefinementFlags(self_correction=False, preserve_technical=False))
    assert "Remove disfluencies" in p
    assert "changes their mind mid-utterance" not in p
    assert "Preserve technical terms" not in p


def test_no_flags_yields_passthrough_prompt():
    p = build_refinement_prompt(
        RefinementFlags(smart_cleanup=False, self_correction=False, preserve_technical=False)
    )
    assert "Return the transcript unchanged" in p


def test_examples_are_user_assistant_pairs():
    assert len(REFINEMENT_EXAMPLES) == 7
    for user_turn, assistant_turn in REFINEMENT_EXAMPLES:
        assert user_turn and assistant_turn


# ── refine_transcript message shape ─────────────────────────────────────────

class _FakeBackend:
    id = "openai-compat"

    def __init__(self, reply="Refined."):
        self.reply = reply
        self.seen_messages = None

    def chat_messages(self, *, messages, timeout=None):
        self.seen_messages = messages
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def test_refine_transcript_builds_structured_few_shot(monkeypatch):
    fake = _FakeBackend("  Cleaned text.  ")
    monkeypatch.setattr("services.llm_backend.get_active_llm_backend", lambda: fake)

    out = refinement.refine_transcript("um hello there", RefinementFlags())
    assert out == "Cleaned text."

    msgs = fake.seen_messages
    assert msgs[0]["role"] == "system"
    # 7 example pairs as real chat turns, then the live transcript last.
    assert len(msgs) == 1 + 2 * len(REFINEMENT_EXAMPLES) + 1
    assert msgs[1]["role"] == "user" and msgs[2]["role"] == "assistant"
    assert msgs[-1] == {"role": "user", "content": "um hello there"}


# ── maybe_refine pass-through contract ──────────────────────────────────────

@pytest.fixture
def stored_config(monkeypatch):
    """In-memory settings_store so config round-trips without SQLite."""
    store = {}
    monkeypatch.setattr("services.settings_store.get_text",
                        lambda key, default=None: store.get(key, default))
    monkeypatch.setattr("services.settings_store.set_text",
                        lambda key, value: store.__setitem__(key, value))
    return store


def test_maybe_refine_off_backend_returns_none(monkeypatch, stored_config):
    class _Off:
        id = "off"
    monkeypatch.setattr("services.llm_backend.get_active_llm_backend", lambda: _Off())
    assert refinement.maybe_refine("some words here") is None


def test_maybe_refine_disabled_config_returns_none(monkeypatch, stored_config):
    refinement.set_refinement_config({"auto": False})
    fake = _FakeBackend("never called")
    monkeypatch.setattr("services.llm_backend.get_active_llm_backend", lambda: fake)
    assert refinement.maybe_refine("some words here") is None
    assert fake.seen_messages is None


def test_maybe_refine_llm_failure_returns_none(monkeypatch, stored_config):
    fake = _FakeBackend(RuntimeError("connection refused"))
    monkeypatch.setattr("services.llm_backend.get_active_llm_backend", lambda: fake)
    assert refinement.maybe_refine("some words here") is None


def test_maybe_refine_empty_reply_returns_none(monkeypatch, stored_config):
    fake = _FakeBackend("   ")
    monkeypatch.setattr("services.llm_backend.get_active_llm_backend", lambda: fake)
    assert refinement.maybe_refine("some words here") is None


def test_maybe_refine_success(monkeypatch, stored_config):
    fake = _FakeBackend("So the meeting is at 3pm on Tuesday.")
    monkeypatch.setattr("services.llm_backend.get_active_llm_backend", lambda: fake)
    out = refinement.maybe_refine("so um the meeting is at 3pm you know on tuesday")
    assert out == "So the meeting is at 3pm on Tuesday."


def test_maybe_refine_empty_transcript_short_circuits(stored_config):
    assert refinement.maybe_refine("") is None
    assert refinement.maybe_refine("   ") is None


def test_maybe_refine_respects_flag_config(monkeypatch, stored_config):
    refinement.set_refinement_config({"preserve_technical": False})
    fake = _FakeBackend("ok")
    monkeypatch.setattr("services.llm_backend.get_active_llm_backend", lambda: fake)
    refinement.maybe_refine("hello world out there")
    assert "Preserve technical terms" not in fake.seen_messages[0]["content"]


# ── Config round-trip ───────────────────────────────────────────────────────

def test_config_roundtrip_and_unknown_keys_ignored(stored_config):
    out = refinement.set_refinement_config({"self_correction": False, "bogus": True})
    assert out["self_correction"] is False
    assert "bogus" not in out
    again = refinement.get_refinement_config()
    assert again["self_correction"] is False
    assert again["auto"] is True


def test_config_invalid_json_falls_back_to_defaults(stored_config):
    stored_config[refinement._SETTINGS_KEY] = "{not json"
    cfg = refinement.get_refinement_config()
    assert cfg["auto"] is True and cfg["smart_cleanup"] is True
