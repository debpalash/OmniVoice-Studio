#!/usr/bin/env python3
"""Stamp a Preview build above the latest stable VoiceStudio release."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


_VERSION_RE = re.compile(r"^(?:v)?(\d+)\.(\d+)\.(\d+)$")


def _release_tuple(value: str) -> tuple[int, int, int]:
    match = _VERSION_RE.fullmatch(value.strip())
    if match is None:
        raise ValueError(f"expected a release version X.Y.Z, got {value!r}")
    return tuple(map(int, match.groups()))


def preview_version(package_version: str, stable_tag: str, run_number: int) -> str:
    """Return a numeric-prerelease SemVer strictly above ``stable_tag``."""
    if not 0 < run_number <= 65_535:
        raise ValueError("run number must be between 1 and 65535 for WiX")
    package = _release_tuple(package_version)
    stable = _release_tuple(stable_tag)
    base = package if package > stable else (stable[0], stable[1], stable[2] + 1)
    return f"{base[0]}.{base[1]}.{base[2]}-{run_number}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-json", type=Path, required=True)
    parser.add_argument("--stable-tag", required=True)
    parser.add_argument("--run-number", type=int, required=True)
    args = parser.parse_args()

    package = json.loads(args.package_json.read_text(encoding="utf-8"))
    stamped = preview_version(package["version"], args.stable_tag, args.run_number)
    package["version"] = stamped
    args.package_json.write_text(
        json.dumps(package, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(stamped)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
