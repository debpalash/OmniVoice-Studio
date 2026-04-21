"""Speaker-clone extraction.

After diarisation assigns `speaker_id` to every segment, this module picks
the longest clean passage per speaker from the Demucs-isolated vocals track
and writes it as a per-speaker reference WAV. The reference, paired with the
corresponding transcript text, lets zero-shot TTS engines clone the
speaker's voice for dubbing — the central product promise of
"same speaker, new language."

Constraints we live with:
  * Zero-shot TTS wants 5–15 s of clean audio per reference. <5 s risks a
    thin clone; >15 s is wasted context.
  * The reference must be the actual speaker, not background music. Demucs
    handles that upstream — we read from `vocals.wav`, not the raw mix.
  * The accompanying transcript text must align with the audio slice or the
    TTS cloner will mis-align its phoneme lookups.

We don't promote these clones to the persistent voice library; they're
job-scoped (lives next to `seg_N.wav` under `dub_jobs/{id}/`). Users can
promote manually via "Save as Voice Profile" — out of scope here.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import numpy as np
import soundfile as sf

logger = logging.getLogger("omnivoice.speaker_clone")

MIN_REF_DURATION_S = 5.0   # below this the clone is thin and unstable
MAX_REF_DURATION_S = 15.0  # above this is just wasted reference context
IDEAL_REF_DURATION_S = 8.0  # target window — long enough for prosody, short enough for coverage


def extract_speaker_clones(
    vocals_path: str,
    segments: list[dict],
    out_dir: str,
) -> dict[str, dict]:
    """Build a per-speaker reference sample from `vocals_path` + `segments`.

    Returns a dict keyed by `speaker_id`:
        {
          "Speaker 1": {
            "ref_audio": "/abs/path/voice_speaker_1.wav",
            "ref_text":  "…concatenated transcript of the chosen slices…",
            "duration":  7.83,
            "source_count": 2,
          },
          ...
        }

    Speakers whose segments total < MIN_REF_DURATION_S are skipped — we'd
    rather fall back to the default TTS voice than ship a bad clone.
    """
    if not vocals_path or not os.path.exists(vocals_path):
        logger.info("speaker_clone: no vocals track at %s; skipping", vocals_path)
        return {}
    if not segments:
        return {}

    try:
        audio, sr = sf.read(vocals_path, dtype="float32", always_2d=False)
    except Exception as e:
        logger.warning("speaker_clone: failed to read %s: %s", vocals_path, e)
        return {}
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    # Group by speaker — preserve original segment order for text concat.
    by_speaker: dict[str, list[tuple[int, dict]]] = {}
    for idx, seg in enumerate(segments):
        spk = seg.get("speaker_id") or "Speaker 1"
        by_speaker.setdefault(spk, []).append((idx, seg))

    os.makedirs(out_dir, exist_ok=True)
    out: dict[str, dict] = {}

    for speaker_id, items in by_speaker.items():
        chosen = _pick_reference_slices(items)
        if not chosen:
            logger.info(
                "speaker_clone: %s has <%ss of usable audio; will fall back to default voice",
                speaker_id, MIN_REF_DURATION_S,
            )
            continue

        ref_audio_np = _concat_slices(audio, sr, chosen)
        if ref_audio_np.size == 0:
            continue

        safe_id = _safe_name(speaker_id)
        ref_path = os.path.join(out_dir, f"voice_{safe_id}.wav")
        try:
            sf.write(ref_path, ref_audio_np, sr)
        except Exception as e:
            logger.warning("speaker_clone: failed to write %s: %s", ref_path, e)
            continue

        ref_text = " ".join((seg.get("text") or "").strip() for _, seg in chosen).strip()
        out[speaker_id] = {
            "ref_audio": ref_path,
            "ref_text": ref_text,
            "duration": float(ref_audio_np.size) / float(sr),
            "source_count": len(chosen),
        }
        logger.info(
            "speaker_clone: wrote %s (%.2fs from %d slice%s)",
            ref_path, out[speaker_id]["duration"], len(chosen), "" if len(chosen) == 1 else "s",
        )

    return out


# ── Internals ───────────────────────────────────────────────────────────────


def _pick_reference_slices(items: list[tuple[int, dict]]) -> list[tuple[int, dict]]:
    """Select the subset of a speaker's segments to use as reference audio.

    Strategy: take the single longest segment; if it's short, accumulate the
    next longest ones in original order until we clear IDEAL_REF_DURATION_S.
    Cap at MAX_REF_DURATION_S. Return [] if we can't reach MIN_REF_DURATION_S.
    """
    if not items:
        return []

    # Longest-first candidates. Keep original indices so we can preserve order.
    by_dur = sorted(
        items,
        key=lambda pair: (pair[1].get("end", 0.0) - pair[1].get("start", 0.0)),
        reverse=True,
    )

    picked: list[tuple[int, dict]] = []
    total = 0.0
    for idx, seg in by_dur:
        dur = max(0.0, float(seg.get("end", 0.0)) - float(seg.get("start", 0.0)))
        if dur <= 0.0:
            continue
        if total + dur > MAX_REF_DURATION_S and picked:
            break
        picked.append((idx, seg))
        total += dur
        if total >= IDEAL_REF_DURATION_S:
            break

    if total < MIN_REF_DURATION_S:
        return []

    # Restore original order so concatenated transcript reads left-to-right.
    picked.sort(key=lambda pair: pair[0])
    return picked


def _concat_slices(audio: np.ndarray, sr: int, picked: list[tuple[int, dict]]) -> np.ndarray:
    """Concatenate the picked segment audio slices into one reference array."""
    parts: list[np.ndarray] = []
    for _, seg in picked:
        start = int(float(seg.get("start", 0.0)) * sr)
        end = int(float(seg.get("end", 0.0)) * sr)
        if start < 0:
            start = 0
        if end > audio.size:
            end = audio.size
        if end <= start:
            continue
        parts.append(audio[start:end])
    if not parts:
        return np.zeros(0, dtype=np.float32)
    # A 20 ms silence pad between slices keeps the TTS reference clean and
    # gives the phoneme aligner something to anchor on at the boundary.
    gap = np.zeros(int(0.02 * sr), dtype=np.float32)
    out: list[np.ndarray] = []
    for i, part in enumerate(parts):
        if i > 0:
            out.append(gap)
        out.append(part.astype(np.float32, copy=False))
    return np.concatenate(out)


def _safe_name(speaker_id: str) -> str:
    """`Speaker 1` → `speaker_1`. Keeps filenames portable across OSes."""
    cleaned = []
    for ch in speaker_id.lower():
        if ch.isalnum():
            cleaned.append(ch)
        elif ch in (" ", "-"):
            cleaned.append("_")
    return "".join(cleaned) or "speaker"


def auto_profile_id(speaker_id: str) -> str:
    """Stable profile id prefix so `_gen` can tell auto-clones apart from
    persistent voice-profile ids."""
    return f"auto:{_safe_name(speaker_id)}"
