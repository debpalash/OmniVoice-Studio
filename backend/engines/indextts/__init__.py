"""IndexTTS-2 sidecar package (Phase 2 Plan 02-03).

IndexTTS-2 runs in its own subprocess + dedicated venv with
``transformers<5``, isolated from the OmniVoice parent process which
pins ``transformers>=5.3``. Closes issue #42 — the canonical
``OffloadedCache`` ImportError driven by the transformers v4 ↔ v5
incompatibility — by making the two libraries live in separate OS
processes.

Three public entry points live in this package:

  * ``IndexTTS2Backend`` (this module) — the SubprocessBackend subclass
    that ``services.tts_backend._REGISTRY`` resolves lazily on first
    access. The class is defined HERE rather than inside
    ``services.tts_backend`` because importing ``SubprocessBackend`` at
    that module's top level would cycle with
    ``services.subprocess_backend``'s ``from services.tts_backend import
    TTSBackend`` line. Defining the class in this package breaks the
    cycle: ``services.tts_backend`` finishes loading before anything
    here is imported.
  * ``main.py`` — the sidecar entrypoint (runs under a different venv).
  * ``bootstrap.py`` — the venv-probe + lazy-bootstrap helper.

Do NOT import ``main.py`` from the parent process — it runs under a
different venv and may not have access to the parent's installed
packages. The parent only ever spawns it as a subprocess.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from services.subprocess_backend import SubprocessBackend

if TYPE_CHECKING:
    import torch  # noqa: F401

logger = logging.getLogger("omnivoice.indextts")


class IndexTTS2Backend(SubprocessBackend):
    """IndexTTS2 (Bilibili) — runs in its own subprocess + dedicated venv.

    Plan 02-03 migrated IndexTTS off the in-process import path because
    IndexTTS pins ``transformers<5`` while OmniVoice pins
    ``transformers>=5.3``. The two cannot share a Python interpreter
    without one of them blowing up at import time (issue #42 — the
    canonical ``OffloadedCache`` ImportError). Running IndexTTS in a
    subprocess with its own venv lets both libraries co-exist.

    Key differentiators preserved from the in-process incarnation:
      * **Emotion decoupling** — clone timbre from one reference, apply
        emotion from a completely separate source (audio, 8-float
        vector, or text).
      * **Duration control** — first AR model to precisely target
        output length (critical for video dubbing lip-sync).
      * **8-float emotion vector** — [happy, angry, sad, afraid,
        disgusted, melancholic, surprised, calm] — each 0.0–1.0.
      * **Text-based emotion** — natural-language emotion descriptions
        via a fine-tuned Qwen3 encoder, ``emo_alpha`` capped at 0.6.

    Installation (transparent to existing v0.2.7 users — ENGINE-07)::

        git clone https://github.com/index-tts/index-tts.git
        cd index-tts && uv pip install -e .   # NOT uv sync --all-extras
        hf download IndexTeam/IndexTTS-2 --local-dir=checkpoints

    Set ``OMNIVOICE_INDEXTTS_DIR`` to the repo root. OmniVoice will
    create ``backend/engines/indextts/.venv`` lazily on first launch if
    no venv exists yet — the user's existing
    ``${OMNIVOICE_INDEXTTS_DIR}/.venv`` is preferred if present, so no
    re-install is needed.

    License: Custom (Bilibili) — free for research/non-commercial.
    Commercial use requires contacting indexspeech@bilibili.com.
    """

    id = "indextts2"
    display_name = "IndexTTS2 (emotion control, duration control, zero-shot)"
    supports_voice_design = False  # requires ref audio for timbre
    _DEFAULT_SAMPLE_RATE = 24000
    # Explicit so IndexTTS2 stops advertising the inherited CPU-only default:
    # the sidecar runs the IndexTTS PyTorch model on CUDA when present, else
    # CPU. ROCm left unclaimed (the sidecar's own venv would need a ROCm torch);
    # a ROCm host honestly resolves to cpu_fallback.
    gpu_compat = ("cuda", "cpu")

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        # IMPORTANT: do NOT attempt ``import indextts`` here. The parent's
        # transformers>=5.3 cannot coexist with IndexTTS's transformers<5
        # in one interpreter — that's the entire reason this backend
        # lives in a subprocess. We only verify the venv exists on disk
        # and the sidecar script ships with the install. Health-checking
        # the sidecar is gated on user action (Settings → 'Test engine').
        from engines.indextts.bootstrap import (
            INDEXTTS_SIDECAR_SCRIPT,
            is_indextts_installed,
        )
        if not is_indextts_installed():
            return False, (
                "IndexTTS-2 venv not found. Set OMNIVOICE_INDEXTTS_DIR to "
                "your IndexTTS clone (the directory containing checkpoints/) "
                "and restart OmniVoice. See docs/engines/indextts.md for the "
                "full install walk-through."
            )
        if not INDEXTTS_SIDECAR_SCRIPT.exists():
            return False, (
                "IndexTTS sidecar script missing at "
                f"{INDEXTTS_SIDECAR_SCRIPT} — reinstall OmniVoice."
            )
        return True, "ok"

    @classmethod
    def venv_python(cls):
        from engines.indextts.bootstrap import resolve_indextts_venv
        return resolve_indextts_venv()

    @classmethod
    def sidecar_script(cls):
        from engines.indextts.bootstrap import INDEXTTS_SIDECAR_SCRIPT
        return INDEXTTS_SIDECAR_SCRIPT

    @property
    def sample_rate(self) -> int:
        # Advertised by the sidecar's ready frame; pinned at the class
        # level so callers (engine picker, dub pipeline) can query
        # without spawning the sidecar.
        return self._DEFAULT_SAMPLE_RATE

    @property
    def supported_languages(self) -> list[str]:
        # Primarily Chinese + English with multilingual prompt handling.
        return ["zh", "en"]

    # ── parent-side emotion / duration arbitration ─────────────────────
    #
    # The sidecar accepts any of: emo_vector, emo_audio_prompt+emo_alpha,
    # emo_text+use_emo_text+emo_alpha+use_random. We do the priority
    # arbitration here so the wire payload is unambiguous and the
    # sidecar's dispatch stays narrow (mirrors the legacy in-process
    # arbitration at the old tts_backend.py:855-907).
    #
    # Override ``generate`` to translate the public ``generate(text,
    # **kw)`` API into the sidecar's synthesize op. The base class's
    # ``generate`` would still work (it forwards every JSON-safe
    # kwarg), but the priority arbitration would land in the sidecar,
    # fragmenting logic. Keeping it parent-side also lets us drop
    # ``description → emo_text`` without the sidecar knowing what
    # ``description`` means.

    def generate(self, text: str, **kw) -> "torch.Tensor":
        ref_audio = kw.get("ref_audio")
        if not ref_audio:
            raise RuntimeError(
                "IndexTTS2 requires a reference audio for voice cloning "
                "(timbre). Pass ref_audio= with a path to a speaker "
                "reference clip."
            )

        emo_vector = kw.get("emo_vector")
        emo_audio = kw.get("emo_audio")
        emo_text = kw.get("emo_text")
        emo_alpha = float(kw.get("emo_alpha", 1.0))
        use_random = bool(kw.get("use_random", False))

        # Voice-design fallback: if ``description`` came in via the
        # OpenAI-compatible TTS route, treat it as a text emotion prompt.
        description = kw.get("description")
        if description and not emo_text and not emo_vector and not emo_audio:
            emo_text = description

        forwarded: dict = {"ref_audio": ref_audio}

        # Duration control — codec frame rate ≈ 21 Hz.
        duration = kw.get("duration")
        if duration is not None:
            target_tokens = int(float(duration) * 21)
            if target_tokens > 0:
                forwarded["target_tokens"] = target_tokens

        if (
            emo_vector
            and isinstance(emo_vector, (list, tuple))
            and len(emo_vector) == 8
        ):
            forwarded["emo_vector"] = [float(v) for v in emo_vector]
            forwarded["use_random"] = use_random
            logger.info(
                "IndexTTS2: emotion via vector %s", forwarded["emo_vector"],
            )
        elif emo_audio:
            forwarded["emo_audio_prompt"] = emo_audio
            forwarded["emo_alpha"] = emo_alpha
            logger.info(
                "IndexTTS2: emotion via audio ref (alpha=%.2f)", emo_alpha,
            )
        elif emo_text:
            forwarded["emo_text"] = emo_text
            forwarded["use_emo_text"] = True
            forwarded["emo_alpha"] = min(emo_alpha, 0.6)
            forwarded["use_random"] = use_random
            logger.info(
                "IndexTTS2: emotion via text description: %r (alpha=%.2f)",
                emo_text[:60], forwarded["emo_alpha"],
            )

        # Delegate to SubprocessBackend.generate which handles the JSON
        # round-trip, GPU slot acquire/release, and int16 PCM decode.
        return super().generate(text, **forwarded)


__all__ = ["IndexTTS2Backend"]
