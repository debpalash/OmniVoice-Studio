"""Two-pass loudnorm measure orchestrator (#28).

The impure half of the two-pass ACX/podcast master: run ffmpeg's measure pass
over the concatenated chapters and parse the printed loudnorm JSON. The pure
builders/parser live in :mod:`services.longform_render`; this only drives ffmpeg.

Contract: **never raises.** Every failure (skip / non-zero rc / timeout / spawn
error / empty or unparseable stderr / silent program) is caught, logged at
WARNING, and converted to ``None`` so the caller falls back to single-pass. A
slow or broken measure must degrade the master, never abort the render.
"""
from __future__ import annotations

import logging
from typing import Optional

from services.longform_render import (
    MeasuredLoudness,
    build_loudnorm_measure_cmd,
    build_loudnorm_measure_filter,
    parse_loudnorm_measure,
)

logger = logging.getLogger("omnivoice.loudness")


async def measure_loudness(
    ffmpeg: str,
    concat_list_path: str,
    preset: str,
    *,
    job_id: str,
) -> Optional[MeasuredLoudness]:
    """Measure the concatenated program's loudness for ``preset`` (acx/podcast),
    or ``None`` for off/unknown or on ANY failure (→ single-pass fallback).

    Only the ffmpeg rc and a short static message are logged — never the raw
    stderr (it can carry the concat path under OUTPUTS_DIR), keeping the log
    local-first / path-safe.
    """
    filt = build_loudnorm_measure_filter(preset)
    if filt is None:
        return None  # off / unknown — a normal skip, not an error (no log)
    cmd = build_loudnorm_measure_cmd(ffmpeg, concat_list_path, filt)
    from services.ffmpeg_utils import run_ffmpeg  # lazy → patchable at source
    try:
        # asyncio.TimeoutError is a subclass of Exception (Py≥3.11) — caught
        # here so a slow measure degrades to single-pass instead of killing the
        # whole render via the caller's outer except.
        rc, _out, err = await run_ffmpeg(cmd, capture=True, job_id=job_id)
    except Exception as exc:
        logger.warning("loudness measure pass did not run (%s) — single-pass fallback",
                       type(exc).__name__)
        return None
    if rc != 0:
        logger.warning("loudness measure pass exited rc=%s — single-pass fallback", rc)
        return None
    try:
        stderr_text = err.decode("utf-8", "replace") if isinstance(err, (bytes, bytearray)) else (err or "")
    except Exception:
        return None
    measured = parse_loudnorm_measure(stderr_text)
    if measured is None:
        logger.warning("loudness measure output unparseable — single-pass fallback")
    return measured


__all__ = ["measure_loudness"]
