"""The runtime app version must come from package metadata, not a stale literal
(prevents the recurring "0.4.0"/"0.2.7" drift — Greptile #145)."""
import re
from importlib.metadata import version

from core.version import APP_VERSION


def test_app_version_is_semver():
    assert re.match(r"^\d+\.\d+\.\d+", APP_VERSION), APP_VERSION


def test_app_version_matches_installed_package_metadata():
    # In any synced env the package is installed; APP_VERSION must equal it
    # (i.e. it's read from pyproject, not hardcoded).
    assert APP_VERSION == version("omnivoice")


def test_all_version_files_in_lockstep():
    """The FOUR version files must agree: pyproject.toml,
    frontend/src-tauri/{tauri.conf.json,Cargo.toml}, and frontend/package.json.

    package.json drives the runtime ``__APP_VERSION__`` (vite.config.js), which
    shows in the first-run footer and EVERY auto bug report — so a drift ships a
    v0.3.6 build that calls itself v0.3.5. The release.yml version-bump job was
    bumping only the first three; package.json drifted unnoticed. Catch it in CI.
    """
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]

    def _toml_version(p: Path) -> str:
        return re.search(r'(?m)^version\s*=\s*"([^"]+)"', p.read_text()).group(1)

    versions = {
        "pyproject.toml": _toml_version(root / "pyproject.toml"),
        "Cargo.toml": _toml_version(root / "frontend/src-tauri/Cargo.toml"),
        "tauri.conf.json": json.loads((root / "frontend/src-tauri/tauri.conf.json").read_text())["version"],
        "package.json": json.loads((root / "frontend/package.json").read_text())["version"],
    }
    assert len(set(versions.values())) == 1, f"version files drifted: {versions}"
