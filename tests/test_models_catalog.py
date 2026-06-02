"""Regression guard for the bundled model catalog (``backend/config/models.yaml``).

Issue #239: two ASR entries pointed at Hugging Face repo IDs that returned
HTTP 404 ("Repository Not Found"), so users could not install those ASR models:

* ``UsefulSensors/moonshine-small`` — no such model (Moonshine ships *tiny* /
  *base*, there is no 300M "small").
* ``Systran/faster-whisper-large-v3-turbo`` — Systran publishes no turbo repo.

These tests are intentionally **static** (no network) so they run in CI: they
assert every ``repo_id`` is well-formed and that the known-bad IDs can never be
reintroduced. They do not verify live HF availability — that would be flaky and
slow — but they stop the catalog from shipping the exact IDs that broke #239.
"""
import re
from pathlib import Path

import yaml

_YAML = Path(__file__).resolve().parents[1] / "backend" / "config" / "models.yaml"
# org-or-user / repo-name, both segments HF-legal (letters, digits, _, -, .).
_REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]*/[\w.-]+$")
# Repo IDs that returned HTTP 404 on Hugging Face (issue #239). Must never reappear.
_KNOWN_BAD = {
    "UsefulSensors/moonshine-small",
    "Systran/faster-whisper-large-v3-turbo",
}


def _models():
    data = yaml.safe_load(_YAML.read_text(encoding="utf-8"))
    return data["models"] if isinstance(data, dict) and "models" in data else data


def test_catalog_loads_and_has_entries():
    models = _models()
    assert isinstance(models, list) and len(models) > 0


def test_every_repo_id_is_well_formed():
    for m in _models():
        rid = m.get("repo_id")
        assert rid and _REPO_RE.match(rid), f"malformed repo_id: {rid!r}"


def test_required_fields_present():
    for m in _models():
        for field in ("repo_id", "label", "role"):
            assert m.get(field), f"{m.get('repo_id')!r} missing required field {field!r}"


def test_known_404_repo_ids_absent():
    ids = {m.get("repo_id", "") for m in _models()}
    leaked = ids & _KNOWN_BAD
    assert not leaked, f"known-404 repo IDs reintroduced (issue #239): {leaked}"
