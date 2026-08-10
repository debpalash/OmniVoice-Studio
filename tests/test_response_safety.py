"""Regression tests for private diagnostics crossing the HTTP boundary."""
from __future__ import annotations

import logging

_PRIVATE = (
    "Traceback (most recent call last):\n"
    '  File "/home/alice/private/project.py", line 7\n'
    "RuntimeError: hf_abcdefghijklmnopqrstuvwxyz1234567890"
)


def test_public_failure_logs_only_stable_class_and_returns_fixed_text(caplog):
    from core.public_errors import public_failure

    logger = logging.getLogger("test.response_safety")

    with caplog.at_level(logging.ERROR):
        result = public_failure(
            logger,
            "operation failed",
            RuntimeError(_PRIVATE),
            response="Operation failed; check the backend log for details.",
        )

    assert result == "Operation failed; check the backend log for details."
    assert _PRIVATE not in caplog.text
    assert "class=RuntimeError" in caplog.text
    assert "Traceback" not in result
    assert "/home/alice" not in result
    assert "hf_abcdefghijklmnopqrstuvwxyz1234567890" not in result


def test_engine_health_never_returns_engine_owned_diagnostic():
    from core.public_errors import public_engine_health

    assert public_engine_health(False, _PRIVATE) == (
        "Engine unavailable; check the backend log for details."
    )
    assert public_engine_health(True, _PRIVATE) == "Healthy"


def test_recognized_failure_gets_constant_recovery_without_private_text():
    from core.public_errors import public_exception_response

    private = RuntimeError(
        "Using SOCKS proxy from /home/alice/private with "
        "hf_abcdefghijklmnopqrstuvwxyz1234567890 but socksio is not installed"
    )
    payload = public_exception_response(private, fallback="Internal error.")

    assert payload["docs_topic"] == "SOCKS_PROXY_SUPPORT_MISSING"
    assert "unset ALL_PROXY/HTTPS_PROXY" in payload["hint"]
    serialized = str(payload)
    assert "/home/alice" not in serialized
    assert "hf_abcdefghijklmnopqrstuvwxyz1234567890" not in serialized


def test_unknown_failure_has_no_diagnostic_derived_guidance():
    from core.public_errors import public_exception_response

    payload = public_exception_response(RuntimeError(_PRIVATE), fallback="Internal error.")
    assert payload == {"detail": "Internal error."}


def test_engine_health_route_logs_but_does_not_return_private_diagnostic(
    monkeypatch, caplog
):
    from api.routers import engines

    class BrokenEngine:
        @classmethod
        def is_available(cls):
            raise RuntimeError(_PRIVATE)

    monkeypatch.setattr(engines, "_resolve_engine_class", lambda _engine_id: BrokenEngine)
    hostile_engine_id = "broken\nFORGED ENGINE LOG"
    with caplog.at_level(logging.WARNING):
        result = engines.engine_health(hostile_engine_id)

    assert result["ok"] is False
    assert result["message"] == "Engine unavailable; check the backend log for details."
    assert _PRIVATE not in caplog.text
    assert hostile_engine_id not in caplog.text
    assert "FORGED ENGINE LOG" not in caplog.text
    assert "Traceback" not in result["message"]
    assert "/home/alice" not in result["message"]
    assert "hf_abcdefghijklmnopqrstuvwxyz1234567890" not in result["message"]


def test_tailscale_enable_failure_keeps_service_output_private(monkeypatch, caplog):
    import asyncio

    from api.routers import system

    private = f"{_PRIVATE}\nTOKEN=private-value"
    monkeypatch.setattr(
        system._tailscale,
        "serve_enable",
        lambda: {"ok": False, "error": private},
    )

    with caplog.at_level(logging.ERROR):
        result = asyncio.run(system.tailscale_enable())

    assert result == {
        "ok": False,
        "error": "Tailscale sharing could not be enabled; check the backend log for details.",
    }
    assert private not in caplog.text
    assert "TOKEN=private-value" not in caplog.text
    assert "/home/alice" not in caplog.text


def test_tailscale_command_exception_stays_in_local_log(monkeypatch, caplog):
    from services import tailscale

    private = f"{_PRIVATE}\nTOKEN=private-value"

    def fail_run(*_args, **_kwargs):
        raise RuntimeError(private)

    monkeypatch.setattr(tailscale.subprocess, "run", fail_run)
    with caplog.at_level(logging.ERROR, logger="omnivoice.tailscale"):
        result = tailscale._run(["tailscale", "serve"])

    assert result == {"ok": False, "error": "tailscale command failed"}
    assert private in caplog.text
    assert private not in str(result)


def test_tailscale_nonzero_output_stays_in_local_log(monkeypatch, caplog):
    from types import SimpleNamespace

    from services import tailscale

    private = f"{_PRIVATE}\nTOKEN=private-value"
    monkeypatch.setattr(
        tailscale.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=1,
            stdout="",
            stderr=private,
        ),
    )

    with caplog.at_level(logging.ERROR, logger="omnivoice.tailscale"):
        result = tailscale._run(["tailscale", "serve"])

    assert result == {"ok": False, "error": "tailscale command failed"}
    assert "/home/alice" in caplog.text
    assert "TOKEN=private-value" in caplog.text
    assert private not in str(result)


def test_wrapped_cache_repair_failure_keeps_constant_recovery_guidance():
    from core.public_errors import public_exception_response

    private = RuntimeError(
        "The TTS model cache for /home/alice/models--private is incomplete and "
        "could not be auto-repaired. hf_abcdefghijklmnopqrstuvwxyz1234567890"
    )
    payload = public_exception_response(private, fallback="Internal error.")
    assert payload["docs_topic"] == "MODEL_CACHE_CORRUPT"
    assert "delete the model's models--<org>--<name> folder" in payload["hint"]
    assert "/home/alice" not in str(payload)
    assert "hf_abcdefghijklmnopqrstuvwxyz1234567890" not in str(payload)


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
        raise RuntimeError(f"{_PRIVATE}\nUsing SOCKS proxy but socksio is not installed")

    app.add_exception_handler(Exception, main_mod.global_exception_handler)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/private-failure")

    assert response.status_code == 500
    body = response.json()
    assert body["error_class"] == "RuntimeError"
    assert body["docs_topic"] == "SOCKS_PROXY_SUPPORT_MISSING"
    assert "unset ALL_PROXY/HTTPS_PROXY" in body["hint"]
    assert body["detail"].endswith(body["hint"])
    serialized = response.text
    assert "Traceback" not in serialized
    assert "/home/alice" not in serialized
    assert "hf_abcdefghijklmnopqrstuvwxyz1234567890" not in serialized
