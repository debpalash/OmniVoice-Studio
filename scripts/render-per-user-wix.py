#!/usr/bin/env python3
"""Render the supported per-user MSI template from the canonical WiX source."""

from __future__ import annotations

import argparse
from pathlib import Path


WEBVIEW_ACTIONS_START = "        <!-- BEGIN WEBVIEW_INSTALL_ACTIONS -->"
WEBVIEW_ACTIONS_END = "        <!-- END WEBVIEW_INSTALL_ACTIONS -->"

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
    (
        '        <!-- Managed-deployment switches. Explicit allow is required for network bootstrap. -->\n'
        '        <Property Id="ALLOWWEBVIEW2BOOTSTRAP" Secure="yes" />\n'
        '        <Property Id="DISABLEWEBVIEW2BOOTSTRAP" Secure="yes" />',
        '        <!-- The current-user bundle never installs or updates WebView2. -->',
    ),
    (
        '        <Condition Message="Microsoft Edge WebView2 Runtime is required. Install the Evergreen Standalone Runtime first, or explicitly set ALLOWWEBVIEW2BOOTSTRAP=1."><![CDATA[Installed OR REMOVE OR INSTALLED_WEBVIEW2_VERSION OR (ALLOWWEBVIEW2BOOTSTRAP = "1" AND DISABLEWEBVIEW2BOOTSTRAP <> "1")]]></Condition>',
        '        <Condition Message="Microsoft Edge WebView2 Runtime is required. Install the Evergreen Runtime for the current user first."><![CDATA[Installed OR REMOVE OR INSTALLED_WEBVIEW2_VERSION]]></Condition>',
    ),
)


def render(source: str) -> str:
    rendered = source
    for old, new in TRANSFORMS:
        count = rendered.count(old)
        if count != 1:
            raise ValueError(f"expected exactly one WiX token, found {count}: {old}")
        rendered = rendered.replace(old, new)

    start_count = rendered.count(WEBVIEW_ACTIONS_START)
    end_count = rendered.count(WEBVIEW_ACTIONS_END)
    if (start_count, end_count) != (1, 1):
        raise ValueError(
            "expected exactly one marked WebView2 action block, "
            f"found start={start_count}, end={end_count}"
        )
    start = rendered.index(WEBVIEW_ACTIONS_START)
    end = rendered.index(WEBVIEW_ACTIONS_END, start) + len(WEBVIEW_ACTIONS_END)
    rendered = (
        rendered[:start]
        + "        <!-- WebView2 is a prerequisite for current-user installs. -->"
        + rendered[end:]
    )
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
