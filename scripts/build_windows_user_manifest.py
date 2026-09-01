#!/usr/bin/env python3
"""Build the updater manifest for the non-elevated Windows MSI channel."""

from __future__ import annotations

import datetime
from pathlib import Path
from urllib.parse import quote


def build_manifest(*, repo: str, tag: str, version: str, asset: str, signature: str) -> dict:
    base = f"https://github.com/{repo}/releases/download/{quote(tag, safe='')}/"
    entry = {"signature": signature.strip(), "url": base + quote(asset)}
    return {
        "version": version,
        "notes": "VoiceStudio update for the per-user Windows installation.",
        "pub_date": datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "platforms": {
            "windows-x86_64": entry,
            "windows-x86_64-msi": entry,
        },
    }


def write_manifest(path: Path, manifest: dict) -> None:
    import json

    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--asset", required=True)
    parser.add_argument("--signature-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    write_manifest(
        args.output,
        build_manifest(
            repo=args.repo,
            tag=args.tag,
            version=args.version,
            asset=args.asset,
            signature=args.signature_file.read_text(encoding="utf-8"),
        ),
    )


if __name__ == "__main__":
    main()
