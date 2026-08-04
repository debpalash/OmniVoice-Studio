#!/usr/bin/env python3
"""Rebuild the rolling preview release's updater manifest from what is published.

Why this exists (#1327): since ~2026-07-13 every matrix leg logged "Signature
not found for the updater JSON. Skipping upload…" — ``tauri-action`` uploaded
the bundles and their ``.sig`` companions but never refreshed ``latest.json``.
Meanwhile the version-less macOS updater bundles are deleted and replaced every
night by the stale-bundle cleanup, so the manifest's darwin signatures stopped
matching the published files and every macOS Preview update failed signature
verification — for over two weeks, with CI green throughout, because parity and
version-format checks do not look at a signature.

The selection rules live here rather than in a YAML heredoc because they are
the part that keeps being subtly wrong: three separate review findings on
#1327/#1362 were about *which* artifacts may be described together. A heredoc
can only be tested by extracting it and stubbing a shell; a module can be
imported and called.

``build_manifest`` is pure — assets in, manifest out, exceptions on anything it
refuses to describe. Signature fetching and publishing stay in the workflow.
"""
from __future__ import annotations

import datetime
import re

#: The two version-less macOS updater bundles, clobbered on every run.
MAC_AARCH64 = "OmniVoice.Studio_aarch64.app.tar.gz"
MAC_X86_64 = "OmniVoice.Studio_x64.app.tar.gz"

_APPIMAGE_RE = r"OmniVoice\.Studio_[\d.]+-(?P<n>\d+)_amd64\.AppImage"
_MSI_RE = r"OmniVoice\.Studio_[\d.]+-(?P<n>\d+)_x64_en-US\.msi"

#: How far a darwin bundle's upload time may precede the versioned artifacts of
#: the same run. The matrix legs finish minutes apart, so some slack is
#: required; it only has to be far smaller than the gap between two runs.
FRESHNESS_SLACK = datetime.timedelta(minutes=2)

NOTES = ("Auto-generated rolling preview build from main. "
         "See CHANGELOG.md and the commit log for details.")


class ManifestRefused(Exception):
    """The published assets do not describe one coherent build.

    Raised rather than returning a best-effort manifest: leaving the previous
    manifest in place is a visible, already-understood state, whereas
    publishing one that misdescribes its own payload is the failure this whole
    job exists to end.
    """


def _newest(names, pattern):
    """``(name, run_number)`` for the highest-numbered match, else ``(None, -1)``.

    Versioned artifacts accumulate on the rolling release, so "current" means
    the highest run number rather than the only one present.
    """
    best, best_n = None, -1
    for name in names:
        m = re.fullmatch(pattern, name)
        if m and int(m.group("n")) > best_n:
            best, best_n = name, int(m.group("n"))
    return best, best_n


def _parse_ts(value):
    return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def build_manifest(assets, repo: str, *, signatures, pub_date=None) -> dict:
    """Build the updater manifest, or raise :class:`ManifestRefused`.

    ``assets`` is ``[{"name": …, "updatedAt": …}, …]`` as ``gh release view``
    returns it. ``signatures`` maps an asset name to its ``.sig`` contents;
    it is passed in so this function needs no network.
    """
    names = [a["name"] for a in assets]
    updated_at = {a["name"]: a.get("updatedAt") for a in assets}

    appimage, n1 = _newest(names, _APPIMAGE_RE)
    msi, n2 = _newest(names, _MSI_RE)
    if not appimage or not msi:
        raise ManifestRefused(
            f"missing versioned updater artifacts (AppImage={appimage}, MSI={msi})"
        )

    # Both legs must come from the SAME run. Picking each independently and
    # taking whichever N is larger publishes a manifest advertising X.Y.Z-5
    # while handing Windows users the -4 MSI — the exact drift this job exists
    # to end, reintroduced by the fix for it (CodeRabbit on #1327).
    if n1 != n2:
        raise ManifestRefused(
            f"preview updater artifacts are from different runs — AppImage is run "
            f"{n1} ({appimage}) but MSI is run {n2} ({msi}). One leg failed or was "
            f"re-run; refusing to publish a manifest whose version describes only "
            f"some of the files it points at. Re-run the failed leg."
        )

    version = re.search(r"_([\d.]+-\d+)_", appimage).group(1)

    for required in (MAC_AARCH64, MAC_X86_64, appimage, msi):
        if required not in names:
            raise ManifestRefused(f"updater artifact missing from release: {required}")
        if required + ".sig" not in names:
            raise ManifestRefused(f".sig companion missing for: {required}")

    # The darwin tarballs carry no run number, so nothing in their NAMES ties
    # them to this build — and signature verification cannot help, because a
    # stale tarball and its stale .sig match each other perfectly. A run whose
    # macOS legs never uploaded would advertise this version while serving Mac
    # users the previous build; they would keep reporting the old version and
    # be re-offered the update forever (CodeRabbit on #1362).
    #
    # Bind them by upload time instead.
    try:
        newest_versioned = max(_parse_ts(updated_at[appimage]), _parse_ts(updated_at[msi]))
        mac_times = {n: _parse_ts(updated_at[n]) for n in (MAC_AARCH64, MAC_X86_64)}
    except (TypeError, ValueError) as e:
        raise ManifestRefused(
            f"cannot read asset upload times, so the macOS bundles cannot be tied "
            f"to this run: {e}"
        ) from e

    stale = sorted(n for n, t in mac_times.items() if t < newest_versioned - FRESHNESS_SLACK)
    if stale:
        raise ManifestRefused(
            f"the macOS updater bundle(s) {stale} were last uploaded before this "
            f"run's versioned artifacts ({newest_versioned.isoformat()}), so they "
            f"are from an EARLIER build. Publishing would advertise {version} while "
            f"serving Mac users the previous one — and because they would keep "
            f"reporting the old version, the updater would re-offer it forever. "
            f"Re-run the macOS legs."
        )

    entries = {
        "darwin-aarch64": MAC_AARCH64, "darwin-aarch64-app": MAC_AARCH64,
        "darwin-x86_64": MAC_X86_64, "darwin-x86_64-app": MAC_X86_64,
        "linux-x86_64": appimage, "linux-x86_64-appimage": appimage,
        "windows-x86_64": msi, "windows-x86_64-msi": msi,
    }
    missing_sigs = sorted({v for v in entries.values() if not signatures.get(v)})
    if missing_sigs:
        raise ManifestRefused(f"no signature content for: {missing_sigs}")

    base = f"https://github.com/{repo}/releases/download/preview/"
    when = pub_date or datetime.datetime.now(datetime.timezone.utc)
    return {
        "version": version,
        "notes": NOTES,
        "pub_date": when.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "platforms": {
            k: {"signature": signatures[v].strip(), "url": base + v}
            for k, v in entries.items()
        },
    }


def required_assets(assets) -> list:
    """The asset names a manifest built from ``assets`` would reference.

    Lets the caller fetch exactly the ``.sig`` files it needs before calling
    :func:`build_manifest`, without duplicating the selection rules.
    """
    names = [a["name"] for a in assets]
    appimage, _ = _newest(names, _APPIMAGE_RE)
    msi, _ = _newest(names, _MSI_RE)
    return [n for n in (MAC_AARCH64, MAC_X86_64, appimage, msi) if n]
