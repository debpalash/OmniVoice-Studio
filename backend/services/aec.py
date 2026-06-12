"""Acoustic echo cancellation for dictate-over-playback (parity Action 8b).

When the user dictates while OmniVoice is *playing* audio (a TTS preview, a
dub render, a video), the loudspeaker signal leaks back into the microphone.
The streaming ASR on ``/ws/transcribe`` then transcribes that bleed as if it
were speech — the "it typed back what the app just said" symptom. A browser's
``getUserMedia({echoCancellation:true})`` would help, but its quality and even
its availability differ per platform/webview, which would make a *default*
feature behave differently on macOS/Windows/Linux — against the project's
cross-platform-parity rule. A server-side canceller behaves identically
everywhere, so it is the local-first, platform-neutral choice.

This is an NLMS (normalised least-mean-squares) time-domain adaptive filter
with a Geigel double-talk detector. It is a clean-room-grade *port* of
Patter's ``getpatter/audio/aec.py`` (MIT) — see docs/competitive-analysis.md,
Action 8. It is NOT production-grade DSP (WebRTC AEC3 / Speex AEC are); it is
a dependency-free, good-enough canceller that removes the steady-state echo
the ASR would otherwise hallucinate on.

Wiring (one instance per ``/ws/transcribe`` session — NOT thread-safe)::

    aec = NlmsEchoCanceller(sample_rate=16000)
    # Far-end: every PCM chunk the client is about to play through speakers.
    aec.push_far_end(playback_pcm_bytes)
    # Near-end: the mic PCM, cleaned before it reaches the ASR buffer.
    cleaned = aec.process_near_end(mic_pcm_bytes)
"""

from __future__ import annotations

import logging
import time
from typing import Final

import numpy as np

logger = logging.getLogger("omnivoice.aec")


_DEFAULT_FILTER_TAPS: Final[int] = 512
"""Adaptive-filter length in samples. 512 taps @ 16 kHz = 32 ms, covering a
typical near-field laptop/desktop echo path. Longer tails (large rooms) can
pass ``filter_taps=1024``+ at proportionally more CPU per frame; 512 converges
in ~0.5 s with the warm-up ramp and is the sweet spot for dictation."""

_DEFAULT_STEP_SIZE: Final[float] = 0.1
"""Steady-state NLMS step size. Larger = faster channel tracking but less
stable; 0.1 is the textbook value for narrowband voice."""

_DEFAULT_WARMUP_STEP_SIZE: Final[float] = 0.5
"""Aggressive step used during the warm-up window so the filter reaches a
usable echo estimate within ~0.5 s instead of several seconds. The Geigel
double-talk detector still gates updates, so the bigger step does not learn
the user's own voice as echo."""

_DEFAULT_WARMUP_SECONDS: Final[float] = 0.5
"""Length of the warm-up window. After this many seconds of processed
near-end audio the step decays from ``warmup_step_size`` to ``step_size``."""

_DEFAULT_LEAKAGE: Final[float] = 0.9999
"""Per-iteration weight leakage (slightly < 1) so the filter slowly forgets
stale taps when the echo path drifts (the user moves the mic)."""

_DOUBLE_TALK_RHO: Final[float] = 0.6
"""Geigel double-talk threshold. When ``max(|near|) > rho * max(|far|)`` the
near-end carries energy the far-end cannot explain (the user is talking) →
freeze adaptation so the filter does not model the user's voice as echo."""

_FAR_END_BUFFER_SECONDS: Final[float] = 0.5
"""How much past far-end (playback) audio to retain. The echo arrives at the
mic tens of ms after playback; the filter needs that much look-back to align.
500 ms is generous headroom."""


class NlmsEchoCanceller:
    """Time-domain NLMS adaptive filter with Geigel double-talk detection.

    Operates on narrowband mono PCM at 16 kHz (the rate the dictation path
    resamples to) or 8 kHz. Not thread-safe — each ``/ws/transcribe`` session
    owns its own instance.
    """

    # Far-end staleness window (seconds): once the most recent far-end push
    # is older than this, ``process_near_end`` passes the mic through instead
    # of cancelling against a frozen reference (which would superimpose the
    # same stale ~50 ms waveform on every mic frame as an audible buzz).
    _FAR_STALE_S: float = 0.25

    def __init__(
        self,
        sample_rate: int = 16000,
        *,
        filter_taps: int = _DEFAULT_FILTER_TAPS,
        step_size: float = _DEFAULT_STEP_SIZE,
        warmup_step_size: float = _DEFAULT_WARMUP_STEP_SIZE,
        warmup_seconds: float = _DEFAULT_WARMUP_SECONDS,
        leakage: float = _DEFAULT_LEAKAGE,
        double_talk_rho: float = _DOUBLE_TALK_RHO,
    ) -> None:
        if sample_rate not in (8000, 16000):
            raise ValueError(
                "NlmsEchoCanceller supports 8000 Hz or 16000 Hz only; "
                f"got {sample_rate}."
            )
        if filter_taps < 64:
            raise ValueError(
                f"filter_taps must be >= 64 to model a meaningful echo path; "
                f"got {filter_taps}."
            )
        if not 0 < step_size <= 1:
            raise ValueError(f"step_size must be in (0, 1]; got {step_size}.")
        if not 0 < warmup_step_size <= 1:
            raise ValueError(
                f"warmup_step_size must be in (0, 1]; got {warmup_step_size}."
            )
        if warmup_seconds < 0:
            raise ValueError(f"warmup_seconds must be >= 0; got {warmup_seconds}.")
        if not 0 < leakage <= 1:
            raise ValueError(f"leakage must be in (0, 1]; got {leakage}.")

        self._sample_rate = sample_rate
        self._taps = filter_taps
        self._step = float(step_size)
        self._warmup_step = float(warmup_step_size)
        self._warmup_samples = int(warmup_seconds * sample_rate)
        self._leakage = float(leakage)
        self._rho = float(double_talk_rho)
        # Counts near-end samples processed so the step can taper from
        # warmup_step to step over the first warmup_samples. Counted from the
        # first process_near_end call so the window aligns with playback start.
        self._processed_samples: int = 0
        self._last_far_push_monotonic: float | None = None

        # Filter coefficients (zeros — adapts to the channel within ~0.5–2 s).
        self._w = np.zeros(filter_taps, dtype=np.float32)

        # Far-end ring buffer holding >= filter_taps samples of playback
        # history, with headroom so push/process can interleave freely.
        max_buf_samples = max(
            filter_taps * 2,
            int(sample_rate * _FAR_END_BUFFER_SECONDS),
        )
        self._far_buf = np.zeros(max_buf_samples, dtype=np.float32)
        self._far_write_idx = 0  # next write position (head)
        self._far_filled = 0  # samples written so far (capped at len(far_buf))

        # Diagnostics only — never read in the hot path.
        self.frames_processed: int = 0
        self.double_talk_frames: int = 0

    # ── Public API ──────────────────────────────────────────────────────────

    def push_far_end(self, pcm_bytes: bytes) -> None:
        """Append far-end (playback) audio to the reference ring buffer.

        Accepts raw int16 little-endian mono PCM at the configured rate.
        """
        if not pcm_bytes:
            return
        self._last_far_push_monotonic = time.monotonic()
        samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        n = samples.shape[0]
        buf_len = self._far_buf.shape[0]
        if n >= buf_len:
            # More than the buffer holds — keep only the newest buf_len.
            self._far_buf[:] = samples[-buf_len:]
            self._far_write_idx = 0
            self._far_filled = buf_len
            return
        end = self._far_write_idx + n
        if end <= buf_len:
            self._far_buf[self._far_write_idx:end] = samples
        else:
            head = buf_len - self._far_write_idx
            self._far_buf[self._far_write_idx:] = samples[:head]
            self._far_buf[: n - head] = samples[head:]
        self._far_write_idx = (self._far_write_idx + n) % buf_len
        self._far_filled = min(self._far_filled + n, buf_len)

    def process_near_end(self, pcm_bytes: bytes) -> bytes:
        """Subtract the estimated echo from the near-end (mic) signal.

        Returns int16 little-endian mono PCM with the estimated echo removed.
        Passes the frame through unchanged when there is nothing worth
        cancelling: no playback has been primed, or the far-end reference is
        stale (the app went silent).
        """
        if not pcm_bytes:
            return pcm_bytes

        # Not enough far-end history to fill the filter window yet — passing
        # through avoids emitting garbage on the first frames.
        if self._far_filled < self._taps:
            return pcm_bytes

        # Far-end reference is stale (app stopped playing): the ring only
        # advances on push_far_end, so the "most recent" window is frozen at
        # the tail of the last playback. Convolving against it would buzz.
        last_push = self._last_far_push_monotonic
        if last_push is None or (time.monotonic() - last_push) > self._FAR_STALE_S:
            return pcm_bytes

        near = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        cleaned = self._block_nlms(near)
        out = np.clip(cleaned * 32768.0, -32768.0, 32767.0).astype(np.int16)
        self.frames_processed += 1
        return out.tobytes()

    def reset(self) -> None:
        """Clear filter coefficients and far-end history (e.g. on a new turn)."""
        self._w.fill(0)
        self._far_buf.fill(0)
        self._far_write_idx = 0
        self._far_filled = 0
        self._processed_samples = 0
        self._last_far_push_monotonic = None
        self.frames_processed = 0
        self.double_talk_frames = 0

    # ── Internals ───────────────────────────────────────────────────────────

    def _far_window(self, length: int) -> np.ndarray:
        """Most recent ``length`` far-end samples, oldest first / newest last."""
        buf_len = self._far_buf.shape[0]
        if length > self._far_filled:
            length = self._far_filled
        end = self._far_write_idx  # newest sample is at (end - 1) mod buf_len
        if end >= length:
            return self._far_buf[end - length: end]
        head = self._far_buf[buf_len - (length - end):]
        tail = self._far_buf[:end]
        return np.concatenate((head, tail))

    def _block_nlms(self, near: np.ndarray) -> np.ndarray:
        """Sample-by-sample NLMS over one frame of near-end samples.

        Classical NLMS depends on the weights adapted at the previous sample,
        so the inner loop is sequential. Each sample is O(taps); numpy keeps a
        320-sample / 512-tap frame well under a millisecond on commodity CPUs.
        """
        taps = self._taps
        far_window = self._far_window(taps + near.shape[0] - 1)
        if far_window.shape[0] < taps + near.shape[0] - 1:
            # Still warming up — left-pad with zeros so indices line up.
            pad = np.zeros(
                taps + near.shape[0] - 1 - far_window.shape[0], dtype=np.float32
            )
            far_window = np.concatenate((pad, far_window))

        # Geigel double-talk detector (frame-wise).
        far_max = float(np.max(np.abs(far_window))) if far_window.size else 0.0
        near_max = float(np.max(np.abs(near)))
        # Freeze adaptation when the far reference is effectively silent
        # (<= -60 dBFS): adapting against a fade-out tail with near-zero norm
        # blows the weights up against user speech when playback resumes.
        if far_max <= 1e-3:
            return near
        double_talk = near_max > self._rho * far_max
        if double_talk:
            self.double_talk_frames += 1

        out = np.empty_like(near)
        w = self._w
        leakage = self._leakage
        # Constant step within the frame keeps the inner loop branch-free.
        if self._processed_samples < self._warmup_samples:
            step = self._warmup_step
        else:
            step = self._step
        for i in range(near.shape[0]):
            x = far_window[i: i + taps]
            y_est = float(np.dot(w, x))
            e = float(near[i] - y_est)
            out[i] = e
            if not double_talk:
                # NLMS update with leakage. +1e-6 guards divide-by-zero.
                norm = float(np.dot(x, x)) + 1e-6
                w *= leakage
                w += (step * e / norm) * x
        self._processed_samples += near.shape[0]
        return out
