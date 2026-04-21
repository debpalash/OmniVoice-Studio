"""
Incremental re-dub — Phase 4.1 (ROADMAP.md), the other defensible bet.

Given the current dub state + a prior state, compute the minimum set of
segments whose audio needs regenerating. A segment needs re-gen when any of
its *generation inputs* changed:

    text · target_lang · profile_id · instruct · speed · direction

Deterministic content hash per segment is the key. We store the hash on the
segment after every successful generation; when re-dubbing, we hash again and
only queue segments whose hash differs from the stored one.

This isn't full crossfade-at-the-edges yet — that comes with Phase 4.5. For
now the caller re-runs `/dub/generate` with a filtered segments list.
"""
from __future__ import annotations

import hashlib
import json


_GEN_INPUT_FIELDS = ("text", "target_lang", "profile_id", "instruct", "speed", "direction")


def segment_fingerprint(seg: dict) -> str:
    """Deterministic hash of the inputs that actually affect TTS output.

    Any change to `_GEN_INPUT_FIELDS` flips the hash and the segment becomes
    a re-gen candidate. Changes to position / selection state / lip-sync
    badge don't trigger regen, which is what we want.
    """
    payload = {k: (seg.get(k) if seg.get(k) is not None else "") for k in _GEN_INPUT_FIELDS}
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def plan_incremental(
    segments: list[dict],
    *,
    stored_hashes: dict[str, str] | None = None,
) -> dict:
    """Return `{stale, fresh, total, fingerprints}` where:

    • `stale`       : list of segment ids whose generation inputs changed
      since the last successful generate (i.e. need re-dub).
    • `fresh`       : ids whose stored hash still matches current inputs —
      safe to reuse the prior audio.
    • `fingerprints`: {id: sha1} for every segment, for caller to persist
      after a successful regen.

    `stored_hashes` may come from the caller's own bookkeeping (e.g. the
    `dub_history.job_data["seg_hashes"]` we'll start writing in Phase 4.5).
    When missing, every segment is considered stale (first run).
    """
    stored = stored_hashes or {}
    stale: list[str] = []
    fresh: list[str] = []
    fingerprints: dict[str, str] = {}
    for seg in segments:
        sid = str(seg.get("id", ""))
        if not sid:
            continue
        fp = segment_fingerprint(seg)
        fingerprints[sid] = fp
        prev = stored.get(sid)
        if prev == fp:
            fresh.append(sid)
        else:
            stale.append(sid)
    return {
        "stale": stale,
        "fresh": fresh,
        "total": len(segments),
        "fingerprints": fingerprints,
    }
