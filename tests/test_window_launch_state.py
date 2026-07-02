"""Launch-window contract (owner decision, 2026-07-02): the app must ALWAYS
open maximized — never fullscreen — on every platform.

Two halves enforce it, and both must hold:
  1. tauri.conf.json declares `maximized: true` + `fullscreen: false`.
  2. lib.rs denylists BOTH "widget" and "main" in tauri-plugin-window-state —
     otherwise restored geometry silently overrides the config, and one manual
     resize makes every later launch reopen at that smaller size.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_CONF = _ROOT / "frontend" / "src-tauri" / "tauri.conf.json"
_LIB = _ROOT / "frontend" / "src-tauri" / "src" / "lib.rs"


def _main_window() -> dict:
    windows = json.loads(_CONF.read_text())["app"]["windows"]
    mains = [w for w in windows if w.get("label", "main") == "main"]
    assert len(mains) == 1, f"expected exactly one main window, got {len(mains)}"
    return mains[0]


def test_main_window_opens_maximized_not_fullscreen():
    win = _main_window()
    assert win.get("maximized") is True
    assert win.get("fullscreen") is False


def test_startup_enforces_maximize_in_rust():
    """The conf flag alone isn't reliable: macOS can ignore `maximized: true`
    at window creation with the Overlay title-bar style. lib.rs must enforce
    maximize() on the main window during setup (studio mode)."""
    src = _LIB.read_text()
    assert re.search(
        r'get_webview_window\("main"\)[\s\S]{0,600}\.maximize\(\)', src
    ), "lib.rs must call .maximize() on the main window during setup"


def test_window_state_plugin_denylists_main_and_widget():
    src = _LIB.read_text()
    m = re.search(r"with_denylist\(&\[(?P<labels>[^\]]*)\]\)", src)
    assert m, "tauri-plugin-window-state denylist not found in lib.rs"
    labels = set(re.findall(r'"([^"]+)"', m.group("labels")))
    assert {"main", "widget"} <= labels, (
        f"window-state denylist must include main+widget, got {labels} — "
        "without 'main', restored geometry overrides maximized-on-open"
    )
