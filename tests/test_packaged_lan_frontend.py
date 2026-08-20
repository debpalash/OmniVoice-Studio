"""Packaged desktop builds must carry the SPA used by Network Sharing."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_desktop_bundle_carries_the_lan_frontend() -> None:
    """The backend cannot serve LAN clients from Tauri's embedded WebView assets."""
    config = json.loads((ROOT / "frontend/src-tauri/tauri.conf.json").read_text())
    resources = config["bundle"]["resources"]

    assert "../../frontend/dist" in resources, (
        "frontend/dist must be a filesystem bundle resource so the packaged "
        "Python backend can serve Network Sharing clients"
    )
