"""Supertonic-3 sidecar package (Phase 3 Plan 03-01).

Supertonic-3 runs in its own long-lived subprocess via Phase 2's
``SubprocessBackend`` primitive. Unlike IndexTTS it shares the OmniVoice
parent venv ‑‑ the SDK's deps (``onnxruntime``, ``numpy``, ``soundfile``,
``huggingface_hub``) already live there.

Three public entry points live in this package:

  * :class:`Supertonic3Backend` (in ``backend.py``) ‑‑ the
    SubprocessBackend subclass that
    ``services.tts_backend._LAZY_REGISTRY`` resolves on first access.
    Defined in a separate module rather than inside
    ``services.tts_backend`` to avoid the import cycle:
    ``services.tts_backend`` finishes loading before anything here is
    imported. (Same indirection pattern as ``engines.indextts``.)
  * ``sidecar.py`` ‑‑ the subprocess entry point. Stdlib-only at import
    time; loads the supertonic SDK lazily on the first synthesize op so
    the ``ready`` handshake fits inside
    ``SubprocessBackend.SPAWN_READY_TIMEOUT_S``.
  * ``constants.py`` ‑‑ pinned model revision SHA (TTS-03), voice
    presets, license URLs.

Do NOT import ``sidecar.py`` from the parent process. The sidecar must
run as a subprocess so the parent's tts_backend module stays
import-cycle-free and the SDK's onnxruntime initialization can't
contaminate the parent's interpreter state.
"""
from __future__ import annotations

# Re-export the backend class for convenience. ``_LAZY_REGISTRY`` in
# ``services.tts_backend`` resolves ``"supertonic3"`` to this attribute.
from engines.supertonic3.backend import Supertonic3Backend

__all__ = ["Supertonic3Backend"]
