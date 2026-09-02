from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "stamp-preview-version.py"
SPEC = importlib.util.spec_from_file_location("stamp_preview_version", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@pytest.mark.parametrize(
    ("package", "stable", "expected"),
    [
        ("0.5.2", "v0.5.1", "0.5.2-144"),
        ("0.5.2", "v0.5.2", "0.5.3-144"),
        ("0.4.9", "v0.5.2", "0.5.3-144"),
    ],
)
def test_preview_is_based_above_stable(package: str, stable: str, expected: str) -> None:
    assert MODULE.preview_version(package, stable, 144) == expected


@pytest.mark.parametrize("run_number", [0, 65_536])
def test_preview_rejects_wix_incompatible_run_number(run_number: int) -> None:
    with pytest.raises(ValueError, match="WiX"):
        MODULE.preview_version("0.5.2", "v0.5.1", run_number)


def test_cli_rewrites_only_the_package_version(tmp_path: Path) -> None:
    package_json = tmp_path / "package.json"
    package_json.write_text(
        json.dumps({"name": "omnivoice-studio", "version": "0.5.2"}) + "\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--package-json",
            str(package_json),
            "--stable-tag",
            "v0.5.2",
            "--run-number",
            "7",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.strip() == "0.5.3-7"
    assert json.loads(package_json.read_text(encoding="utf-8")) == {
        "name": "omnivoice-studio",
        "version": "0.5.3-7",
    }


def test_release_workflow_stamps_against_the_latest_stable_release() -> None:
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(
        encoding="utf-8"
    )

    assert "gh release view --repo \"$GITHUB_REPOSITORY\" --json tagName" in workflow
    assert "python scripts/stamp-preview-version.py" in workflow
    assert '--stable-tag "$STABLE_TAG"' in workflow
