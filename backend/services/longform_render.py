"""Shared long-form render core (Stories + Audiobook convergence).

Both the Audiobook tab and the Stories Editor produce the *same* artifact: a
chapter-marked audio file built from chapter WAVs. This module owns the pure,
engine-agnostic ffmpeg/metadata builders for that mux so neither feature has to
reimplement it:

  * ``build_ffmetadata`` — FFMETADATA1 doc: an optional ``[global]`` tag block
    (title / author / narrator / year / genre / description) followed by one
    ``[CHAPTER]`` per (title, duration_ms).
  * ``build_concat_list`` — ffmpeg concat-demuxer list of chapter WAVs.
  * ``build_loudnorm_filter`` — an ``-af loudnorm=…`` string for an ACX /
    podcast loudness preset (off by default — opt-in, so the default-behavior
    stays platform-identical).
  * ``validate_cover_image`` — guard a cover path (type + size) before it
    reaches ffmpeg.
  * ``build_render_cmd`` — pure argv for the mux: chapter WAVs + FFMETADATA
    (+ optional cover art, loudness filter), output as ``m4b`` or ``mp3``.
  * ``chapter_cache_key`` — deterministic content hash so a re-run reuses
    already-rendered chapters (resume) and re-renders only what changed.

Every function here is pure (string/argv in, string/argv out) so it's unit
tested without ffmpeg, torch, or a GPU. The impure ffmpeg run lives in the
caller (the audiobook router today; the stories job tomorrow).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

_BITRATE_RE = re.compile(r"^\d{2,3}k$")
#: Default ceiling for the content-addressed chapter cache. Above this, the
#: oldest cached chapter WAVs are evicted (LRU by mtime). Override via
#: OMNIVOICE_LONGFORM_CACHE_MAX_GB.
_CACHE_MAX_BYTES = int(float(os.environ.get("OMNIVOICE_LONGFORM_CACHE_MAX_GB", "2")) * 1024 ** 3)
_COVER_EXTS = {".jpg", ".jpeg", ".png"}
_COVER_MAX_BYTES = 8 * 1024 * 1024  # 8 MB — a book cover, not a payload

#: Our metadata field → FFMETADATA tag key. Order is stable for deterministic
#: output (tested). ``author`` maps to ``artist`` and ``narrator`` to
#: ``composer`` — the tags audiobook players (Apple Books, Audible) read for
#: those roles.
_GLOBAL_TAG_KEYS: list[tuple[str, str]] = [
    ("title", "title"),
    ("author", "artist"),
    ("album", "album"),
    ("narrator", "composer"),
    ("year", "date"),
    ("genre", "genre"),
    ("description", "comment"),
]


def _escape_meta(value: str) -> str:
    """Escape an FFMETADATA value (``=``, ``;``, ``#``, ``\\``, newline)."""
    return re.sub(r"([=;#\\\n])", r"\\\1", value or "")


def prune_cache_dir(cache_dir: str, max_bytes: int = _CACHE_MAX_BYTES) -> tuple[int, int]:
    """Evict the oldest files in ``cache_dir`` until the total size is within
    ``max_bytes`` (LRU by mtime). The content-addressed chapter cache otherwise
    grows without bound — uncompressed WAVs accumulate across every render.

    Best-effort: returns ``(remaining_bytes, removed_count)`` and never raises
    (a missing dir / unstattable file is just skipped). Call it *before* writing
    a job's chapters so the fresh ones are never the eviction target.
    """
    try:
        names = os.listdir(cache_dir)
    except OSError:
        return (0, 0)
    entries: list[tuple[float, int, str]] = []
    total = 0
    for name in names:
        p = os.path.join(cache_dir, name)
        try:
            if not os.path.isfile(p):
                continue
            size = os.path.getsize(p)
            mtime = os.path.getmtime(p)
        except OSError:
            continue
        entries.append((mtime, size, p))
        total += size
    if total <= max_bytes:
        return (total, 0)
    entries.sort()  # oldest first
    removed = 0
    for _mtime, size, p in entries:
        if total <= max_bytes:
            break
        try:
            os.remove(p)
            total -= size
            removed += 1
        except OSError:
            continue
    return (total, removed)


# ── Chapter cache key (resume) ──────────────────────────────────────────────

def chapter_cache_key(
    spans: Iterable[tuple],
    *,
    sample_rate: int,
    engine_id: str,
    voice_sig: Optional[dict] = None,
) -> str:
    """Deterministic content hash for a chapter's rendered audio.

    ``spans`` is an ordered list of ``(voice_id, text, pause_ms_after[, speed])``
    (speed optional, defaults to None). Same inputs → same key → reuse the
    cached chapter WAV on a re-run (resume); any change (text, voice, order,
    pauses, speed, sample rate, engine, or a voice's resolved signature) → new
    key → re-render. ``voice_sig`` maps each voice id to a stable signature
    string (e.g. ``ref_audio|instruct|seed``) so editing the underlying profile
    also invalidates the cache.
    """
    payload = {
        "sr": int(sample_rate),
        "engine": engine_id or "",
        "spans": [[s[0], s[1], int(s[2]), (s[3] if len(s) > 3 else None)] for s in spans],
        "voices": {k: voice_sig[k] for k in sorted(voice_sig)} if voice_sig else {},
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    # Content-addressing only — not a security digest. usedforsecurity=False
    # keeps bandit's B324 (weak-hash) check quiet.
    return hashlib.sha1(raw.encode("utf-8"), usedforsecurity=False).hexdigest()[:20]


# ── Loudness normalization ──────────────────────────────────────────────────

@dataclass(frozen=True)
class LoudnessPreset:
    """A loudnorm target. ``i`` = integrated LUFS, ``tp`` = true-peak ceiling
    (dBTP), ``lra`` = loudness range."""
    key: str
    i: float
    tp: float
    lra: float


#: ``acx`` targets Audible/ACX submission (≈ -19 LUFS integrated, ≤ -3 dBTP
#: peak — inside ACX's -23…-18 dB RMS / -3 dB peak window). ``podcast`` targets
#: the -16 LUFS streaming norm.
LOUDNESS_PRESETS: dict[str, LoudnessPreset] = {
    "acx": LoudnessPreset("acx", -19.0, -3.0, 11.0),
    "podcast": LoudnessPreset("podcast", -16.0, -1.5, 11.0),
}


def build_loudnorm_filter(preset: Optional[str]) -> Optional[str]:
    """Return an ``-af`` loudnorm filter string for ``preset``, or ``None`` for
    off / unknown (single-pass; two-pass measure→apply is a runner enhancement).
    """
    if not preset:
        return None
    p = LOUDNESS_PRESETS.get(preset.lower())
    if p is None:  # "off", "none", or anything unrecognized → no filter
        return None
    return f"loudnorm=I={p.i}:TP={p.tp}:LRA={p.lra}"


# ── FFMETADATA ──────────────────────────────────────────────────────────────

def build_ffmetadata(
    chapters: Iterable[tuple[str, int]],
    global_meta: Optional[dict] = None,
) -> str:
    """Build an FFMETADATA1 doc: optional global tags + one ``[CHAPTER]`` per
    ``(title, duration_ms)``. START/END are cumulative millisecond offsets.
    """
    lines = [";FFMETADATA1"]
    if global_meta:
        for field_key, meta_key in _GLOBAL_TAG_KEYS:
            val = global_meta.get(field_key)
            if val is not None and str(val).strip():
                lines.append(f"{meta_key}={_escape_meta(str(val).strip())}")
    start = 0
    for title, dur_ms in chapters:
        end = start + max(0, int(dur_ms))
        lines += [
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={start}",
            f"END={end}",
            f"title={_escape_meta(title)}",
        ]
        start = end
    return "\n".join(lines) + "\n"


def build_concat_list(wav_paths: Iterable[str]) -> str:
    """Build an ffmpeg concat-demuxer list. Single quotes in paths are escaped
    the ffmpeg way (``'`` → ``'\\''``) so paths can't break the list or inject
    arguments."""
    lines = []
    for p in wav_paths:
        safe = str(p).replace("'", "'\\''")
        lines.append(f"file '{safe}'")
    return "\n".join(lines) + "\n"


# ── Cover art ───────────────────────────────────────────────────────────────

def validate_cover_image(path: Optional[str]) -> bool:
    """True if ``path`` is a readable jpg/png within the size cap. Anything
    dubious (missing, wrong type, too big, unreadable) → False, and the caller
    simply omits the cover rather than failing the render."""
    if not path:
        return False
    try:
        p = Path(path)
        return (
            p.is_file()
            and p.suffix.lower() in _COVER_EXTS
            and 0 < p.stat().st_size <= _COVER_MAX_BYTES
        )
    except OSError:
        return False


# ── Render command ──────────────────────────────────────────────────────────

def build_render_cmd(
    ffmpeg: str,
    concat_list_path: str,
    metadata_path: str,
    out_path: str,
    *,
    fmt: str = "m4b",
    bitrate: str = "128k",
    cover_path: Optional[str] = None,
    loudness: Optional[str] = None,
) -> list[str]:
    """Pure argv for muxing chapter WAVs + FFMETADATA into a tagged,
    chapter-marked audio file.

    Inputs: 0 = concat-demuxer list of chapter WAVs, 1 = FFMETADATA (chapters +
    global tags), 2 = cover image (only when present + valid). ``fmt`` is
    ``m4b`` (AAC in mp4, faststart) or ``mp3`` (libmp3lame). A loudness preset
    adds an ``-af loudnorm`` pass; an invalid/oversized cover is silently
    dropped (see :func:`validate_cover_image`).
    """
    if not _BITRATE_RE.match(bitrate or ""):
        bitrate = "128k"
    is_mp3 = (fmt or "").lower() == "mp3"
    # Cover art is embedded for M4B only. The MP3 muxer rejects an
    # ``attached_pic`` video stream via ``-c:v copy`` (produces a corrupt file
    # across ffmpeg versions), and a reliable cross-version ID3 APIC path is
    # finicky — so for MP3 we skip the cover rather than ship a broken file.
    # M4B is the cover-bearing audiobook format anyway.
    embed_cover = validate_cover_image(cover_path) and not is_mp3

    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(concat_list_path),
        "-i", str(metadata_path),
    ]
    if embed_cover:
        cmd += ["-i", str(cover_path)]

    cmd += ["-map", "0:a", "-map_metadata", "1"]
    if embed_cover:
        cmd += ["-map", "2:v", "-disposition:v", "attached_pic"]

    filt = build_loudnorm_filter(loudness)
    if filt:
        cmd += ["-af", filt]

    if is_mp3:
        cmd += ["-c:a", "libmp3lame", "-b:a", bitrate, "-f", "mp3", str(out_path)]
    else:  # m4b — AAC in an mp4 container
        cmd += ["-c:a", "aac", "-b:a", bitrate]
        if embed_cover:
            cmd += ["-c:v", "copy"]
        cmd += ["-movflags", "+faststart", "-f", "mp4", str(out_path)]
    return cmd
