"""plan-04 (#131) — unit tests for the shared failure helper.

These are the foundational (Phase 2) tests: the non-empty-reason guarantee,
redaction, classification, and the diagnostic block. Written RED before
`core/failure.py` exists.
"""
from pathlib import Path

from core import failure


# ── Non-empty reason guarantee (the core fix) ───────────────────────────────

def test_reason_non_empty_when_exception_message_empty():
    evt = failure.build_failure(ValueError(""), stage="extract")
    assert evt["reason"], "reason must never be empty"
    assert evt["error_class"] == "ValueError"
    assert evt["stage"] == "extract"
    # Backward-compat mirror used by older frontends.
    assert evt["error"] == evt["reason"]


def test_reason_uses_message_when_present():
    evt = failure.build_failure(FileNotFoundError("no such file: clip.mp4"), stage="extract")
    assert "no such file" in evt["reason"]
    assert evt["error_class"] == "FileNotFoundError"


def test_accepts_plain_string_message():
    evt = failure.build_failure("preflight: ffmpeg not found", stage="preflight")
    assert evt["reason"] == "preflight: ffmpeg not found"
    assert evt["stage"] == "preflight"


def test_build_failure_event_carries_type():
    evt = failure.build_failure_event(RuntimeError("boom"), stage="task")
    assert evt["type"] == "error"
    assert evt["reason"] == "boom"
    # warning variant for non-fatal degradations
    warn = failure.build_failure_event(RuntimeError("demucs down"), stage="demucs", event_type="warning")
    assert warn["type"] == "warning"


# ── Redaction (Constitution I) ──────────────────────────────────────────────

def test_sanitize_redacts_hf_token():
    tok = "hf_" + "A" * 36
    out = failure.sanitize(f"auth failed using {tok} on download")
    assert tok not in out


def test_sanitize_redacts_secret_env_values(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-supersecretvalue123456")
    out = failure.sanitize("request died: sk-supersecretvalue123456 rejected")
    assert "sk-supersecretvalue123456" not in out


def test_sanitize_strips_home_path():
    home = str(Path.home())
    out = failure.sanitize(f"could not open {home}/Movies/clip.mp4")
    assert home not in out
    assert "~" in out


# ── Diagnostic block (US3) ──────────────────────────────────────────────────

def test_diagnostic_has_context_and_no_secrets(monkeypatch):
    leaked = "hf_" + "B" * 36
    monkeypatch.setenv("HF_TOKEN", leaked)
    evt = failure.build_failure(RuntimeError("ffprobe exploded"), stage="extract")
    diag = evt["diagnostic"]
    assert "extract" in diag
    assert "RuntimeError" in diag
    assert leaked not in diag
    # carries an environment summary
    assert ("OS" in diag) or ("Python" in diag)


# ── Classification → docs topic + hint (US1, FR-005) ────────────────────────

def test_docs_topic_and_hint_for_known_class():
    evt = failure.build_failure(
        ModuleNotFoundError("No module named 'pkg_resources'"), stage="task"
    )
    assert evt["docs_topic"] == "PKG_RESOURCES_MISSING"
    assert evt["hint"], "known classes must carry an actionable hint"


def test_unknown_cause_has_empty_topic_but_still_non_empty_reason():
    evt = failure.build_failure(RuntimeError("totally novel failure xyz"), stage="task")
    assert evt["docs_topic"] == ""
    assert evt["reason"]
