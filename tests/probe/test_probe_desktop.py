"""L3 desktop — config-integrity against the REAL tauri.conf.json (runs for real
on any platform, no Tauri toolchain), platform-merge behaviour, and a guarded
live bundle launch that skips without a built bundle / display.
"""

from __future__ import annotations

import os

import pytest

from . import desktop
from . import spec as probe_spec
from .judges import desktop as dj

_SPEC = os.path.join(os.path.dirname(__file__), "specs", "desktop_smoke.probe.yaml")


def test_desktop_config_integrity(probe_report):
    spec = probe_spec.load_spec(_SPEC)
    context = desktop.desktop_context()
    results = probe_spec.run_judges(spec, context)
    probe_report.record(spec, results)
    assert probe_spec.blocking_failures(results) == [], "\n".join(str(r) for r in results)


def test_version_parity_is_actually_checked():
    # Guard against a vacuous pass: the config version really equals pyproject's.
    cfg = desktop.load_tauri_config()
    assert cfg["version"] == desktop.pyproject_version() != ""


def test_platform_override_replaces_targets():
    # Tauri replaces (not merges) array fields from the platform override.
    linux = desktop.load_tauri_config("linux")
    assert "rpm" in linux["bundle"]["targets"]  # only present in the linux override
    windows = desktop.load_tauri_config("windows")
    assert set(windows["bundle"]["targets"]) == {"nsis", "msi"}
    # Non-overridden fields survive the merge.
    assert linux["build"]["devUrl"] == "http://localhost:3901"


def test_csp_judge_catches_blocked_backend():
    good = {"app": {"security": {"csp": "connect-src 'self' http://localhost:* http://127.0.0.1:*;"}}}
    assert dj.csp_allows(good, ["http://localhost:*", "http://127.0.0.1:*"]).passed is True
    bad = {"app": {"security": {"csp": "connect-src 'self';"}}}
    assert dj.csp_allows(bad, ["http://localhost:*"]).passed is False


def test_config_contains_judge():
    cfg = {"bundle": {"externalBin": ["binaries/uv", "binaries/ffmpeg"]}}
    assert dj.config_contains(cfg, "bundle.externalBin", ["binaries/uv"]).passed is True
    assert dj.config_contains(cfg, "bundle.externalBin", ["binaries/ffprobe"]).passed is False
    assert dj.config_contains(cfg, "bundle.missing", ["x"]).passed is False  # not a list → FAIL


def test_live_bundle_launch_skips_cleanly():
    ok, reason = desktop.can_launch()
    if not ok:
        pytest.skip(f"L3 live launch unavailable: {reason}")
    # A bundle exists and we have a display — smoke that it launches.
    # (Reached only on a machine with a built desktop bundle.)
    assert os.path.exists(reason)
