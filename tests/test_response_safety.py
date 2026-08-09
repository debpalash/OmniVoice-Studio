"""Regression tests for private diagnostics crossing the HTTP boundary."""
from __future__ import annotations

import logging

from core.response_safety import public_engine_health, public_failure


_PRIVATE = (
    "Traceback (most recent call last):\n"
    '  File "/home/alice/private/project.py", line 7\n'
    "RuntimeError: hf_abcdefghijklmnopqrstuvwxyz1234567890"
)


def test_public_failure_logs_private_diagnostic_but_returns_fixed_text(caplog):
    logger = logging.getLogger("test.response_safety")

    with caplog.at_level(logging.ERROR):
        result = public_failure(
            logger,
            "operation failed",
            RuntimeError(_PRIVATE),
            response="Operation failed; check the backend log for details.",
        )

    assert result == "Operation failed; check the backend log for details."
    assert _PRIVATE in caplog.text
    assert "Traceback" not in result
    assert "/home/alice" not in result
    assert "hf_abcdefghijklmnopqrstuvwxyz1234567890" not in result


def test_engine_health_never_returns_engine_owned_diagnostic():
    assert public_engine_health(False, _PRIVATE) == (
        "Engine unavailable; check the backend log for details."
    )
    assert public_engine_health(True, _PRIVATE) == "Healthy"


def test_engine_health_route_logs_but_does_not_return_private_diagnostic(
    monkeypatch, caplog
):
    from api.routers import engines

    class BrokenEngine:
        @classmethod
        def is_available(cls):
            raise RuntimeError(_PRIVATE)

    monkeypatch.setattr(engines, "_resolve_engine_class", lambda _engine_id: BrokenEngine)
    with caplog.at_level(logging.WARNING):
        result = engines.engine_health("broken")

    assert result["ok"] is False
    assert result["message"] == "Engine unavailable; check the backend log for details."
    assert _PRIVATE in caplog.text
    assert "Traceback" not in result["message"]
    assert "/home/alice" not in result["message"]
    assert "hf_abcdefghijklmnopqrstuvwxyz1234567890" not in result["message"]


def test_global_exception_handler_keeps_private_failure_out_of_response(
    tmp_path, monkeypatch
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import main as main_mod
    from core import error_journal

    monkeypatch.setattr(main_mod, "CRASH_LOG_PATH", str(tmp_path / "crash.log"))
    monkeypatch.setattr(
        error_journal,
        "record",
        lambda *args, **kwargs: {"error_class": "RuntimeError"},
    )
    app = FastAPI()

    @app.get("/private-failure")
    def private_failure():
        raise RuntimeError(_PRIVATE)

    app.add_exception_handler(Exception, main_mod.global_exception_handler)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/private-failure")

    assert response.status_code == 500
    body = response.json()
    assert body == {
        "detail": "VoiceStudio hit an internal error; check the backend log for details.",
        "error_class": "RuntimeError",
    }
    serialized = response.text
    assert "Traceback" not in serialized
    assert "/home/alice" not in serialized
    assert "hf_abcdefghijklmnopqrstuvwxyz1234567890" not in serialized
