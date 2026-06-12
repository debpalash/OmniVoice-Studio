"""Second-pass ASR quality control for dubs (Wave 3.3 / Spec 5).

After a dub is generated, re-recognize the synthetic audio and compare what
the ASR *heard* against what we asked the TTS to *say*. Where the two drift
apart, the line is flagged for the user to verify — turning subtitle timing
and pronunciation from "trusted math" into "measured truth", and doubling as
an automatic dub-quality check.

Design delta from pyvideotrans (whose second pass lets recognized text
*replace* the subtitles wholesale): we keep the GENERATED text authoritative
for content and use the second pass for *measurement* — timing + a drift
score that feeds the incremental re-dub loop, never silently overwriting the
translation.

Pure functions here (no ASR, no I/O) so the scoring is unit-testable; the
pipeline stage that runs the ASR pass lives in the dub router.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


def _tokens(text: str) -> list[str]:
    """Lowercase word tokens, punctuation stripped — the unit drift is scored
    in. Script-agnostic: for no-space scripts each character is a token, which
    still gives a sensible edit-distance ratio."""
    text = (text or "").lower().strip()
    if not text:
        return []
    words = re.findall(r"\w+", text, flags=re.UNICODE)
    return words or list(text.replace(" ", ""))


def _edit_distance(a: list[str], b: list[str]) -> int:
    """Levenshtein distance between two token lists (iterative, O(len(a)*len(b))
    time, O(len(b)) space)."""
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ta in enumerate(a, 1):
        cur = [i]
        for j, tb in enumerate(b, 1):
            cost = 0 if ta == tb else 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[-1]


def word_error_rate(reference: str, hypothesis: str) -> float:
    """Normalized token edit distance in [0.0, 1.0+].

    0.0 = the ASR heard exactly the target text. ~1.0 = entirely different.
    Can exceed 1.0 when the hypothesis is much longer than the reference
    (insertions); callers clamp/threshold as needed. An empty reference with a
    non-empty hypothesis scores 1.0 (everything is an insertion)."""
    ref = _tokens(reference)
    hyp = _tokens(hypothesis)
    if not ref and not hyp:
        return 0.0
    if not ref:
        return 1.0
    return _edit_distance(ref, hyp) / len(ref)


@dataclass
class SegmentQC:
    seg_id: str
    target_text: str
    recognized_text: str
    drift: float           # word_error_rate(target, recognized)
    flagged: bool          # drift >= threshold
    new_start: float | None  # measured onset from the dubbed-audio recognition
    new_end: float | None


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def score_dub(
    dub_segments: list[dict],
    recognized: list[dict],
    *,
    drift_threshold: float = 0.5,
    seg_ids: list | None = None,
) -> list[SegmentQC]:
    """Match the second-pass recognition to the dub segments and score drift.

    ``dub_segments`` are the segments we generated (each {start, end, text});
    ``recognized`` are the ASR result segments on the dubbed audio (each
    {start, end, text}). Each dub segment is matched to the recognized
    segment(s) it overlaps in time; their text is concatenated as the
    hypothesis and scored against the dub segment's ``text``. The recognized
    span's bounds become the measured start/end (subtitle-timing truth).
    """
    results: list[SegmentQC] = []
    for i, seg in enumerate(dub_segments):
        sid = str(seg_ids[i]) if (seg_ids and i < len(seg_ids)) else str(seg.get("id", i))
        s0, s1 = float(seg.get("start", 0.0)), float(seg.get("end", 0.0))
        hits = [r for r in recognized if _overlap(s0, s1, float(r.get("start", 0.0)), float(r.get("end", 0.0))) > 0]
        hyp = " ".join((r.get("text") or "").strip() for r in hits).strip()
        drift = word_error_rate(seg.get("text", ""), hyp)
        new_start = min((float(r.get("start", 0.0)) for r in hits), default=None)
        new_end = max((float(r.get("end", 0.0)) for r in hits), default=None)
        results.append(SegmentQC(
            seg_id=sid,
            target_text=(seg.get("text") or "").strip(),
            recognized_text=hyp,
            drift=round(drift, 3),
            flagged=drift >= drift_threshold,
            new_start=new_start,
            new_end=new_end,
        ))
    return results
