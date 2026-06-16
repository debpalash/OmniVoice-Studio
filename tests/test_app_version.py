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
    """The FIVE version sources must agree: pyproject.toml,
    frontend/src-tauri/{tauri.conf.json,Cargo.toml}, frontend/package.json, and
    backend/core/version.py's ``_FALLBACK_VERSION``.

    package.json drives the runtime ``__APP_VERSION__`` (vite.config.js), which
    shows in the first-run footer and EVERY auto bug report — so a drift ships a
    v0.3.6 build that calls itself v0.3.5. ``_FALLBACK_VERSION`` is what the
    *frozen* backend reports when package metadata is unavailable — and it being
    stuck at "0.3.5" is exactly why the v0.3.6 desktop build reported 0.3.5 in
    About + bug reports. The release.yml version-bump job must bump all five;
    catch any drift here in CI.
    """
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]

    def _toml_version(p: Path) -> str:
        return re.search(r'(?m)^version\s*=\s*"([^"]+)"', p.read_text()).group(1)

    def _named_literal(p: Path, name: str) -> str:
        return re.search(rf'(?m)^{name}\s*=\s*"([^"]+)"', p.read_text()).group(1)

    versions = {
        "pyproject.toml": _toml_version(root / "pyproject.toml"),
        "Cargo.toml": _toml_version(root / "frontend/src-tauri/Cargo.toml"),
        "tauri.conf.json": json.loads((root / "frontend/src-tauri/tauri.conf.json").read_text())["version"],
        "package.json": json.loads((root / "frontend/package.json").read_text())["version"],
        "core/version.py": _named_literal(root / "backend/core/version.py", "_FALLBACK_VERSION"),
    }
    assert len(set(versions.values())) == 1, f"version files drifted: {versions}"


def test_fallback_version_resolves_to_pyproject():
    """When package metadata is unavailable (frozen build / raw checkout), the
    version must still resolve to pyproject — never the stale literal that made
    the v0.3.6 build report "0.3.5"."""
    from pathlib import Path

    from core.version import _fallback_version

    root = Path(__file__).resolve().parents[1]
    pyproject = re.search(
        r'(?m)^version\s*=\s*"([^"]+)"', (root / "pyproject.toml").read_text()
    ).group(1)
    assert _fallback_version() == pyproject


def test_frozen_build_collects_package_metadata():
    """backend.spec must copy_metadata('omnivoice') so the frozen backend reads
    its real version via importlib.metadata instead of the fallback literal."""
    from pathlib import Path

    spec = (Path(__file__).resolve().parents[1] / "backend.spec").read_text()
    assert (
        "copy_metadata('omnivoice')" in spec or 'copy_metadata("omnivoice")' in spec
    ), "backend.spec must copy_metadata('omnivoice') (frozen-build version reporting)"
