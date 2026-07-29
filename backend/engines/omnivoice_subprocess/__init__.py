"""omnivoice-subprocess: the resident OmniVoice TTS engine in a crash-isolated
sidecar process (#730/#1190).

The default ``omnivoice`` engine runs in-process on the GPU ``ThreadPoolExecutor``.
When a generate or load there exceeds its execution budget the pool is "reset"
but the abandoned worker *thread* cannot be killed (Python cannot interrupt a
native torch/MPS call), so it holds the MPS device until it finishes on its
own, and every later synth contends with the zombie and hangs.

This engine runs the SAME OmniVoice model in a child process via
:class:`SubprocessBackend`. A child process CAN be hard-killed: on a recv
timeout the parent's watchdog calls ``proc.kill()``, reclaiming the child's
VRAM/device, and the next request transparently respawns a fresh sidecar. That
is the one thing the in-process engine structurally cannot do.

OPT-IN (Settings -> Engines, or ``OMNIVOICE_TTS_BACKEND=omnivoice-subprocess``);
the in-process ``omnivoice`` stays the default so existing users see no change.

Tradeoff vs the in-process engine: identical model and quality, a little extra
per-call overhead (one stdio round-trip), and it does not carry the native
advanced-parameter surface (``t_shift`` / ``layer_penalty_factor`` /
``position_temperature`` / ``class_temperature``) or parent-side seed
determinism, because the generic ``backend.generate`` path does not forward
those. Acceptable for unattended / reaction-triggered use where reliability
matters more than those controls.

Unlike IndexTTS / dots.tts / Supertonic-3, this sidecar runs under the PARENT
interpreter (``venv_python() -> sys.executable``): the goal here is crash
isolation, not dependency isolation, and the OmniVoice engine uses the host's
own pins.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from services.subprocess_backend import SubprocessBackend

if TYPE_CHECKING:
    import torch  # noqa: F401

logger = logging.getLogger("omnivoice.omnivoice_subprocess")


class OmniVoiceSubprocessBackend(SubprocessBackend):
    """The resident OmniVoice model in a killable sidecar process."""

    id = "omnivoice-subprocess"
    display_name = "OmniVoice (subprocess-isolated, killable on timeout)"
    _DEFAULT_SAMPLE_RATE = 24000
    gpu_compat = ("cuda", "mps", "cpu")
    # Match OmniVoiceBackend: the measured floor below which a render that
    # should take seconds runs for minutes (the #1226/#1222 4 GB reports).
    min_vram_gb = 6.0

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        # Same probe as OmniVoiceBackend: the package must be importable. The
        # interpreter is the parent's own (sys.executable), so there is no
        # separate venv to validate.
        try:
            import omnivoice.models.omnivoice  # noqa: F401
        except Exception as e:
            return False, f"omnivoice package missing: {e}"
        return True, "ready"

    @classmethod
    def venv_python(cls) -> Path:
        # Same interpreter as the parent: this engine isolates for crash
        # recovery, not dependency pins, so it needs no dedicated venv.
        return Path(sys.executable)

    @classmethod
    def sidecar_script(cls) -> Path:
        return Path(__file__).resolve().parent / "main.py"

    @property
    def recv_timeout_s(self) -> float:
        """Override the base 60s recv timeout.

        Aligns the kill deadline with the generate budget: a long-but-valid
        OmniVoice synth (which can take tens of seconds) is not falsely killed,
        while a genuinely wedged one is hard-killed and its VRAM reclaimed at
        the deadline. That reclaim is the concrete behavior the in-process
        engine lacks (it abandons but never frees the device).
        """
        try:
            return max(30.0, float(os.environ.get("OMNIVOICE_SIDECAR_RECV_TIMEOUT_S", "300")))
        except (ValueError, TypeError):
            return 300.0

    @property
    def sample_rate(self) -> int:
        return self._DEFAULT_SAMPLE_RATE

    @property
    def supported_languages(self) -> list[str]:
        # OmniVoice advertises 600+ zero-shot; "multi" is the honest tag.
        return ["multi"]


__all__ = ["OmniVoiceSubprocessBackend"]
