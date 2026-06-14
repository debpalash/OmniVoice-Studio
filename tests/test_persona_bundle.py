"""Pure-core tests for the .ovsvoice persona bundle (#29 / parity §R3 G1).

Covers the model-free nucleus: SPDX normalization, manifest schema/fields, and
the consent attestation builder. The audio preview + ZIP pack/unpack are a
separate slice (and run on CI for the torch-coupled paths).
"""
from __future__ import annotations

from services.persona_bundle import (
    DEFAULT_LICENSE,
    OVSVOICE_FORMAT,
    OVSVOICE_SCHEMA_VERSION,
    build_consent_json,
    build_manifest,
    normalize_spdx,
)

_PROFILE = {
    "name": "Aria Narration", "kind": "design", "language": "English",
    "personality": "warm-narrator", "instruct": "female, middle-aged, low pitch",
    "ref_text": "Hello.", "seed": 42, "is_locked": False,
    "vd_states": '{"gender":"female"}',
}


# ── SPDX normalization ──────────────────────────────────────────────────────

def test_spdx_allowlisted_kept():
    for ok in ("CC-BY-4.0", "MIT", "Apache-2.0", "CC0-1.0", "LicenseRef-OmniVoice-Personal"):
        assert normalize_spdx(ok) == ok


def test_spdx_custom_licenseref_prefix_kept():
    assert normalize_spdx("LicenseRef-MyStudio-Terms") == "LicenseRef-MyStudio-Terms"


def test_spdx_junk_and_injection_normalize_to_default():
    for bad in (None, "", "   ", "GPL-3.0-only", "haha; rm -rf /", "<script>", 123):
        assert normalize_spdx(bad) == DEFAULT_LICENSE  # never raises, never the raw junk


def test_spdx_is_stripped():
    assert normalize_spdx("  MIT  ") == "MIT"


# ── manifest ────────────────────────────────────────────────────────────────

def test_manifest_format_discriminator_and_schema():
    m = build_manifest(_PROFILE, license_spdx="CC-BY-4.0", tags=["narration"])
    assert m["format"] == OVSVOICE_FORMAT
    assert m["schema_version"] == OVSVOICE_SCHEMA_VERSION
    assert isinstance(m["exported_at"], float)


def test_manifest_persona_fields_mirror_profile():
    m = build_manifest(_PROFILE, license_spdx="CC-BY-4.0", tags=[])
    p = m["persona"]
    assert p["name"] == "Aria Narration" and p["kind"] == "design"
    assert p["seed"] == 42 and p["is_locked"] is False
    assert p["vd_states"] == '{"gender":"female"}'  # JSON string, NOT re-parsed


def test_manifest_seed_and_vd_states_none_passthrough():
    m = build_manifest({"name": "X", "seed": None, "vd_states": None},
                       license_spdx="MIT", tags=[])
    assert m["persona"]["seed"] is None
    assert m["persona"]["vd_states"] is None


def test_manifest_normalizes_bad_license_never_raises():
    m = build_manifest(_PROFILE, license_spdx="bogus-license", tags=[])
    assert m["license"]["spdx"] == DEFAULT_LICENSE


def test_manifest_tags_and_members_defaults():
    m = build_manifest(_PROFILE, license_spdx="MIT", tags=["a", "b"])
    assert m["tags"] == ["a", "b"]
    assert m["members"] == {"ref_audio": None, "locked_audio": None, "consent_audio": None}
    assert m["preview"] is None


# ── consent.json ────────────────────────────────────────────────────────────

def test_consent_design_is_designed_synthetic_verified():
    c = build_consent_json(_PROFILE, has_recording=False)
    assert c["method"] == "designed-synthetic"
    assert c["verified_own_voice"] is True


def test_consent_clone_self_recorded_when_attested():
    prof = {"kind": "clone", "verified_own_voice": 1, "consent_text": "I consent.",
            "consent_recorded_at": 1749790000.0}
    c = build_consent_json(prof, has_recording=True)
    assert c["method"] == "self-recorded-statement"
    assert c["has_recording"] is True and c["consent_text"] == "I consent."
    assert c["recorded_at"] == 1749790000.0


def test_consent_none_when_nothing_to_attest():
    assert build_consent_json({"kind": "clone"}, has_recording=False) is None


def test_consent_recorded_at_coerced_when_missing_or_bad():
    c = build_consent_json({"kind": "clone", "consent_text": "ok", "consent_recorded_at": "nope"},
                           has_recording=True)
    assert isinstance(c["recorded_at"], float)  # coerced to now, not a crash
