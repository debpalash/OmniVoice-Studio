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
