"""OmniVoice GGUF subprocess-host backend (Phase 4 Plan 04-01).

Hardware-adaptive quantized variant of the upstream `k2-fsa/OmniVoice`
model. Runs through Phase 2's :class:`SubprocessBackend` so the C++
`omnivoice-tts` runtime is fully isolated from the parent's Python
process — no shared GIL, no shared CUDA context, and crashes in the
runtime can't take down the FastAPI server.

The public entry point is :class:`OmniVoiceGGUFBackend`. Registered in
``services.tts_backend._REGISTRY`` lazily via ``_LAZY_REGISTRY`` so the
import of this package (and its `huggingface_hub` + `soundfile` + `torch`
chain) is deferred until a caller actually instantiates the backend.

See ``.planning/decisions/SPIKE-01-gguf.md`` for the GO rationale and the
pinned commit SHAs for both the GGUF quant repo and the `omnivoice.cpp`
runtime source.
"""
from __future__ import annotations

from .backend import OmniVoiceGGUFBackend  # re-export for _LAZY_REGISTRY

__all__ = ["OmniVoiceGGUFBackend"]
