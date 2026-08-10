"""VoiceStudio 0.5.0 release-brand and source-launch contracts."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_release_version_is_0_5_0_everywhere() -> None:
    package = json.loads((ROOT / "frontend/package.json").read_text())
    assert package["version"] == "0.5.0"

    mirrors = {
        "pyproject.toml": r'(?m)^version = "([^"]+)"',
        "frontend/src-tauri/Cargo.toml": r'(?m)^version = "([^"]+)"',
        "backend/core/version.py": r'(?m)^_FALLBACK_VERSION = "([^"]+)"',
    }
    for path, pattern in mirrors.items():
        match = re.search(pattern, (ROOT / path).read_text())
        assert match and match.group(1) == "0.5.0", path


def test_visible_brand_surfaces_say_voicestudio() -> None:
    header = (ROOT / "frontend/src/components/Header.jsx").read_text()
    assert "Voice<span" in header and ">Studio</span>" in header
    assert "Omni<span" not in header

    visible_files = (
        "frontend/src-tauri/Info.plist",
        "frontend/src-tauri/appimage/AppRun",
        "frontend/src/test/visual/harness.html",
        "frontend/e2e/gallery.spec.ts",
    )
    for path in visible_files:
        text = (ROOT / path).read_text()
        assert "VoiceStudio" in text, path
        assert "OmniVoice needs" not in text, path
        assert "OmniVoice may" not in text, path
        assert "OmniVoice Gallery" not in text, path

    readme = (ROOT / "README.md").read_text()
    assert "**VoiceStudio** (default, powered by k2-fsa/OmniVoice)" in readme
    assert "**OmniVoice** (default)" not in readme


def test_engine_help_names_the_app_not_the_upstream_model() -> None:
    paths = (
        "backend/engines/confucius4/__init__.py",
        "backend/engines/confucius4/bootstrap.py",
        "backend/engines/dots_tts/__init__.py",
        "backend/engines/dots_tts/bootstrap.py",
        "backend/engines/indextts/__init__.py",
        "backend/engines/indextts/bootstrap.py",
        "backend/engines/moss_tts_v15/__init__.py",
        "backend/engines/moss_tts_v15/bootstrap.py",
    )
    stale_help = re.compile(r"(?:restart|reinstall|re-launch|Run) OmniVoice")
    for path in paths:
        text = (ROOT / path).read_text()
        assert not stale_help.search(text), path


def test_source_launch_cleans_idle_ports_quietly() -> None:
    scripts = json.loads((ROOT / "package.json").read_text())["scripts"]
    for name in ("predev", "predesktop"):
        command = scripts[name]
        assert "bun scripts/clear-dev-ports.mjs 3900 3901" in command
        assert "|| true" not in command


def test_icon_rail_has_no_static_section_captions_and_keeps_air_between_items() -> None:
    rail = (ROOT / "frontend/src/components/NavRail.jsx").read_text()
    for stale_caption in ("Start", "Create", "Workflows", "Reference"):
        assert stale_caption not in rail
    assert "pt-[18px]" in rail
    assert "gap-[9px]" in rail
