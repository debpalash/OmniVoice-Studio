"""`.ovsvoice` persona-bundle format (#29 / parity §R3 G1).

A portable ZIP that packages a voice profile's identity + an optional reference
clip + a consent attestation + an SPDX license tag + a watermarked preview.

This module owns the **pure, model-free** core: the format constants, SPDX
normalization, and the manifest/consent builders. The audio preview + ZIP
pack/unpack (which lazily import torchaudio/watermark) layer on top of these.
"""
from __future__ import annotations

import time
from typing import Optional

# ── Format constants ─────────────────────────────────────────────────────────
OVSVOICE_FORMAT = "ovsvoice"
OVSVOICE_SCHEMA_VERSION = 1
MAX_BUNDLE_BYTES = 100 * 1024 * 1024          # 100 MB (mirrors marketplace cap)
_MIN_CONSENT_AUDIO_BYTES = 1000               # the consent-recording floor
DEFAULT_LICENSE = "LicenseRef-OmniVoice-Personal"

# Membership allowlist for SPDX validation — a fixed-string set + the
# ``LicenseRef-`` prefix. NO regex over the (user-supplied) SPDX string, so this
# carries no CodeQL py/polynomial-redos surface.
_SPDX_ALLOWLIST: frozenset[str] = frozenset({
    "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0",
    "CC-BY-ND-4.0", "MIT", "Apache-2.0", "LicenseRef-OmniVoice-Personal",
})


class BundleError(Exception):
    """A bundle build/parse failure carrying the HTTP status the router maps to."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def normalize_spdx(spdx: Optional[str]) -> str:
    """Return a safe SPDX id: the value if it's allowlisted or a ``LicenseRef-``
    custom id, else :data:`DEFAULT_LICENSE`. Never raises, never 400s — a junk
    id (incl. shell-injection attempts) normalizes to the default. Membership /
    fixed-prefix only — no regex (CodeQL-clean)."""
    if not spdx or not isinstance(spdx, str):
        return DEFAULT_LICENSE
    s = spdx.strip()
    if s in _SPDX_ALLOWLIST or s.startswith("LicenseRef-"):
        return s
    return DEFAULT_LICENSE


def build_manifest(
    profile: dict,
    *,
    license_spdx: str,
    tags: list[str],
    engine_id: str = "",
    custom_license_text: Optional[str] = None,
    preview: Optional[dict] = None,
    members: Optional[dict] = None,
    omnivoice_version: str = "",
) -> dict:
    """Build the ``manifest.json`` object for a profile row. Mirrors the legacy
    ``_bundle_metadata`` persona fields, adds the format discriminator, license
    (normalized — never raises on a bad id, A19), tags, preview + members blocks.
    Pure: no I/O, no model."""
    return {
        "format": OVSVOICE_FORMAT,
        "schema_version": OVSVOICE_SCHEMA_VERSION,
        "omnivoice_version": omnivoice_version or "",
        "exported_at": time.time(),
        "persona": {
            "name": profile.get("name") or "",
            "kind": profile.get("kind") or "clone",
            "language": profile.get("language") or "Auto",
            "personality": profile.get("personality") or "",
            "instruct": profile.get("instruct") or "",
            "ref_text": profile.get("ref_text") or "",
            "seed": profile.get("seed"),                 # int or None (A16)
            "is_locked": bool(profile.get("is_locked")),
            "vd_states": profile.get("vd_states"),        # JSON string or None (A15) — never re-parsed
        },
        "engine": {"id": engine_id or "", "design_params": None},
        "license": {"spdx": normalize_spdx(license_spdx), "custom_text": custom_license_text or None},
        "tags": list(tags or []),
        "preview": preview,                              # set by the audio step; None for legacy/no-preview
        "members": members or {"ref_audio": None, "locked_audio": None, "consent_audio": None},
    }


def build_consent_json(profile: dict, *, has_recording: bool) -> Optional[dict]:
    """The optional ``consent.json`` for a profile, or None when there's nothing
    to attest. A ``design`` persona attests as designed-synthetic by definition;
    a verified clone attests as a self-recorded statement. Import treats these
    fields as ADVISORY — real verification needs the actual consent_audio member
    (see the import rules), so this can't forge verified-own-voice."""
    kind = profile.get("kind") or "clone"
    consent_text = (profile.get("consent_text") or "").strip()
    verified = bool(profile.get("verified_own_voice"))
    if kind == "design":
        method = "designed-synthetic"
        verified = True
    elif verified or consent_text or has_recording:
        method = "self-recorded-statement"
    else:
        return None  # nothing to attest
    recorded_at = profile.get("consent_recorded_at")
    try:
        recorded_at = float(recorded_at)
    except (TypeError, ValueError):
        recorded_at = time.time()
    return {
        "verified_own_voice": verified,
        "method": method,
        "consent_text": consent_text,
        "recorded_at": recorded_at,
        "has_recording": bool(has_recording),
    }


__all__ = [
    "OVSVOICE_FORMAT", "OVSVOICE_SCHEMA_VERSION", "MAX_BUNDLE_BYTES",
    "DEFAULT_LICENSE", "BundleError", "normalize_spdx", "build_manifest",
    "build_consent_json",
]
