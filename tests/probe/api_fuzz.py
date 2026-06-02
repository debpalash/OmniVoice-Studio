"""L1 API contract/property fuzzing via Schemathesis (enable-on-demand).

Schemathesis reads the FastAPI app's own OpenAPI schema and autonomously
generates inputs that probe every operation for: unhandled 500s, responses that
violate the declared schema, and validation bypasses. It is the highest-ROI
*autonomous* bug finder available (independent studies rank it best/second-best
among API fuzzers) — and it needs no hand-written assertions.

It runs against the app **in-process over ASGI** (no live server, no port), the
same way tests/test_api.py uses FastAPI's TestClient.

Enable it with one command:

    uv add schemathesis        # or: uv pip install schemathesis

Until then, tests/probe/test_api_fuzz.py skips cleanly so CI stays green.
"""

from __future__ import annotations


def load_app():
    """Return the FastAPI ASGI app. Mirrors the import path used across the
    suite (conftest puts ``backend/`` on sys.path with ``--app-dir backend``)."""
    from main import app  # noqa: PLC0415 — must import after conftest sys.path setup

    return app


def build_schema(app=None):
    """Build a Schemathesis schema from the in-process ASGI app, tolerating the
    API rename between Schemathesis 3.x and 4.x. Raises ImportError if the
    package isn't installed (callers guard with pytest.importorskip)."""
    import schemathesis

    if app is None:
        app = load_app()

    # 4.x: schemathesis.openapi.from_asgi(path, app); 3.x: schemathesis.from_asgi
    from_asgi = getattr(getattr(schemathesis, "openapi", None), "from_asgi", None)
    if from_asgi is None:
        from_asgi = getattr(schemathesis, "from_asgi", None)
    if from_asgi is None:  # pragma: no cover - version we don't recognise
        raise RuntimeError("Schemathesis present but no from_asgi entrypoint found")
    return from_asgi("/openapi.json", app)
