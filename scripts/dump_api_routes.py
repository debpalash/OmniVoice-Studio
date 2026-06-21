#!/usr/bin/env python3
"""Regenerate the backend API route snapshot.

The snapshot (`tests/fixtures/api_routes.txt`) is the committed inventory of
every HTTP/WebSocket route the FastAPI app exposes. `tests/test_api_route_
inventory.py` diffs the live app against it, so an accidentally removed or
renamed endpoint fails CI. When you intentionally add/remove/rename a route,
run this script and commit the updated snapshot.

    OMNIVOICE_MODEL=test uv run python scripts/dump_api_routes.py
"""
import os
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
SNAPSHOT = _REPO / "tests" / "fixtures" / "api_routes.txt"

_HEADER = (
    "# OmniVoice backend API route snapshot — regenerate with "
    "scripts/dump_api_routes.py\n"
    "# Guards against accidental endpoint removal/rename "
    "(tests/test_api_route_inventory.py).\n"
)


def route_lines(app):
    """Stable, sorted ``"METHODS /path"`` lines for every route on ``app``.

    HEAD/OPTIONS are dropped (auto-added by Starlette); WebSocket routes use
    ``WS``. Excludes things that vary by environment and aren't part of the API
    contract: ``Mount`` routes (StaticFiles / sub-app mounts like ``/demo_audio``,
    ``/outputs``, ``/mcp`` — they only register when their dir/sub-app exists, so
    they differ between a dev checkout and a fresh CI runner) and the bare
    ``GET /`` root (a conditional frontend-serving fallback). HEAD/OPTIONS are
    dropped (Starlette adds them automatically).
    """
    from starlette.routing import Mount

    rows = set()
    for r in app.routes:
        path = getattr(r, "path", None)
        if not path or path == "/" or isinstance(r, Mount):
            continue
        methods = getattr(r, "methods", None)
        if methods:
            ms = ",".join(sorted(m for m in methods if m not in ("HEAD", "OPTIONS")))
        elif "WebSocket" in type(r).__name__:
            ms = "WS"
        else:
            continue  # non-HTTP, non-WS, non-mount: not part of the API surface
        rows.add(f"{ms} {path}")
    return sorted(rows)


def load_app():
    os.environ.setdefault("OMNIVOICE_MODEL", "test")
    os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")
    sys.path.insert(0, str(_REPO / "backend"))
    from main import app
    return app


def main():
    lines = route_lines(load_app())
    # `--print` dumps to stdout (the inventory test captures this in a subprocess
    # so importing the app never pollutes the pytest process); default writes the
    # committed snapshot.
    if "--print" in sys.argv:
        sys.stdout.write("\n".join(lines) + "\n")
    else:
        SNAPSHOT.write_text(_HEADER + "\n".join(lines) + "\n", encoding="utf-8")
        sys.stderr.write(f"Wrote {len(lines)} routes to {SNAPSHOT.relative_to(_REPO)}\n")


if __name__ == "__main__":
    main()
