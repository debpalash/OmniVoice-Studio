"""Supertonic-3 engine constants — pinned model SHA, voice presets, license URLs.

This module is the *only* place the model revision SHA appears. Both the
sidecar (``backend/engines/supertonic3/sidecar.py``) and the resolution
script (``scripts/resolve_supertonic3_sha.py``) read from here.

TTS-03 compliance: ``PINNED_REVISION_SHA`` is a 40-character lowercase hex
commit SHA that lives on the model's commit log. Bumping it intentionally
is a deliberate PR (run ``scripts/resolve_supertonic3_sha.py``, verify the
diff against the previous SHA touched the ONNX weights / tokenizer, and
replace the constant below).

The SHA below matches the SDK's own pin
(``supertonic.config.MODEL_CONFIGS["supertonic-3"]["revision"]``) in
``supertonic==1.3.1``, so the sidecar's call to
``snapshot_download(revision=PINNED_REVISION_SHA)`` resolves to the exact
weights the SDK was validated against by Supertone Inc.
"""
from __future__ import annotations

#: 40-char HuggingFace commit SHA for ``Supertone/supertonic-3``.
#:
#: This is the ``"Initial Supertonic 3 release"`` commit ‑‑ also the SHA
#: that ships hard-coded inside ``supertonic==1.3.1``
#: (``supertonic/config.py::MODEL_CONFIGS["supertonic-3"]["revision"]``).
#: Bump intentionally via ``scripts/resolve_supertonic3_sha.py`` when
#: rolling forward.
PINNED_REVISION_SHA: str = "724fb5abbf5502583fb520898d45929e62f02c0b"

#: HuggingFace repo id for the model weights.
MODEL_REPO_ID: str = "Supertone/supertonic-3"

#: Native sample rate per the model card.
SAMPLE_RATE: int = 44100

#: Built-in voice presets shipped with Supertonic-3. The SDK exposes
#: ``M1..M5`` and ``F1..F5`` ‑‑ the plan front-matter narrows the public
#: surface to 7 voices for the UI engine card; the SDK still accepts any
#: of the 10 if a caller forwards one explicitly.
VOICE_PRESETS: list[str] = ["M1", "M3", "M4", "M5", "F3", "F4", "F5"]

#: Default voice if the caller omits one or passes an unknown id.
DEFAULT_VOICE: str = "M1"

#: License URLs surfaced in the acceptance dialog (TTS-05).
#:
#: * ``code`` ‑‑ MIT, the inference SDK on GitHub.
#: * ``model`` ‑‑ OpenRAIL-M, the model weights on HuggingFace.
LICENSE_URLS: dict[str, str] = {
    "code": "https://github.com/supertone-inc/supertonic/blob/main/LICENSE",
    "model": "https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE",
}

#: Settings-store key for the license-acceptance boolean. Plumbed through
#: ``settings_store.get_license_accepted("supertonic3")`` /
#: ``set_license_accepted``; kept here so the helpers and the UI
#: agree on the canonical engine id.
LICENSE_ACCEPTED_KEY: str = "supertonic3_license_accepted"
