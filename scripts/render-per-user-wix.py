#!/usr/bin/env python3
"""Render the supported per-user MSI template from the canonical WiX source."""

from __future__ import annotations

import argparse
from pathlib import Path


TRANSFORMS = (
    ('InstallScope="perMachine"', 'InstallScope="perUser"'),
    (
        'Id="PrevInstallDirNoName" Root="HKLM"',
        'Id="PrevInstallDirNoName" Root="HKCU"',
    ),
    (
        'Id="PrevInstallDirWithName" Root="HKLM"',
        'Id="PrevInstallDirWithName" Root="HKCU"',
    ),
    (
        '<Directory Id="$(var.PlatformProgramFilesFolder)" Name="PFiles">',
        '<Directory Id="LocalAppDataFolder" Name="LocalAppData">',
    ),
    (
        '<RegistryKey Root="HKLM" Key="Software\\\\{{manufacturer}}\\\\{{product_name}}">',
        '<RegistryKey Root="HKCU" Key="Software\\\\{{manufacturer}}\\\\{{product_name}}">',
    ),
    ('Value="perMachine"', 'Value="perUser"'),
    (
        'Guid="{{path_component_guid}}"',
        'Guid="41f6d598-8908-4004-9332-291b64fd38be"',
    ),
    (
        r'<RegistryKey Root="HKLM" Key="Software\Classes\\{{protocol}}">',
        r'<RegistryKey Root="HKCU" Key="Software\Classes\\{{protocol}}">',
    ),
)


def render(source: str) -> str:
    rendered = source
    for old, new in TRANSFORMS:
        count = rendered.count(old)
        if count != 1:
            raise ValueError(f"expected exactly one WiX token, found {count}: {old}")
        rendered = rendered.replace(old, new)
    return rendered


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render(args.source.read_text(encoding="utf-8")), encoding="utf-8")


if __name__ == "__main__":
    main()
