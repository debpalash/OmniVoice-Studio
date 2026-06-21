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
    ``WS`` and sub-app mounts use ``MOUNT`` so the inventory is method-aware.
    """
    from starlette.routing import Mount

    rows = set()
    for r in app.routes:
        path = getattr(r, "path", None)
        if not path:  # skip None and the empty-path root mount (not an API route)
            continue
        methods = getattr(r, "methods", None)
        if methods:
            ms = ",".join(sorted(m for m in methods if m not in ("HEAD", "OPTIONS")))
        elif "WebSocket" in type(r).__name__:
            ms = "WS"
        elif isinstance(r, Mount):
            ms = "MOUNT"
        else:
            ms = "-"
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
    SNAPSHOT.write_text(_HEADER + "\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {len(lines)} routes to {SNAPSHOT.relative_to(_REPO)}")


if __name__ == "__main__":
    main()
