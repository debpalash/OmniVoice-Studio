"""Pure, host-aware routing resolver — maps an engine's declared ``gpu_compat``
against the cached host capabilities to "where will this engine *actually* run
on this machine, and is that a problem the user should hear about?"

No model load, no probe (the caller passes the cached ``HostCaps``), no I/O.
Deterministic and byte-identical for a given ``(gpu_compat, HostCaps)`` across
macOS/Windows/Linux — that cross-OS determinism is the whole point of the
no-silent-fallback contract.

Reason strings are author-controlled English (interpolating only family/device
names) but are **still** scrubbed by the caller (``core.scrub.scrub_text``)
before serialization, because an interpolated ``device_name`` or probe note can
carry a home path.
"""
from __future__ import annotations

from typing import Literal, TypedDict

from core.device_caps import (
    DIRECTML_MARKER,
    KERNEL_RISK_MARKER,
    HostCaps,
)

RoutingStatus = Literal["accelerated", "cpu_fallback", "cpu_only", "unavailable", "n/a"]


class RoutingResult(TypedDict):
    effective_device: str          # a DeviceFamily value or "cpu"
    routing_status: RoutingStatus  # resolve_routing never emits "n/a" (LLM-only)
    routing_reason: str | None     # raw, pre-scrub


def _caveat(caps: HostCaps) -> str | None:
    """A kernel-risk caveat string for an otherwise-accelerated host, or None.
    Advisory notes (multi-GPU, VRAM-query-failed, DirectML) never qualify."""
    for note in caps.notes:
        if KERNEL_RISK_MARKER in note:
            return f"{caps.family.upper()} selected, but: {note}"
    return None


def resolve_routing(gpu_compat: tuple[str, ...], caps: HostCaps) -> RoutingResult:
    """Resolve the effective device + status for an engine on this host.

    Rules are evaluated in order; the first match wins (see spec §2)."""
    targets = tuple(gpu_compat or ())
    fam = caps.family

    # 1. Empty compat — reserved for LLM (which never calls this). Defensive.
    if not targets:
        return {
            "effective_device": "cpu",
            "routing_status": "cpu_only",
            "routing_reason": "engine declares no compute targets",
        }

    # 2. Host accelerator is one the engine supports → accelerated.
    if fam != "cpu" and fam in targets:
        return {
            "effective_device": fam,
            "routing_status": "accelerated",
            "routing_reason": _caveat(caps),
        }

    # 3. Host has an accelerator the engine lacks, but engine supports cpu
    #    → the no-silent-fallback signal.
    if fam != "cpu" and "cpu" in targets:
        if fam == "rocm" and "cuda" in targets and "rocm" not in targets:
            reason = "declares CUDA only; ROCm not in its compat set"
        else:
            reason = f"engine has no {fam.upper()} path; running on CPU"
        return {
            "effective_device": "cpu",
            "routing_status": "cpu_fallback",
            "routing_reason": reason,
        }

    # 4. Genuine CPU-only host (or DirectML, which the probe reports as cpu)
    #    and engine supports cpu → benign; must not warn or block.
    if fam == "cpu" and "cpu" in targets:
        reason = None
        for note in caps.notes:
            if DIRECTML_MARKER in note:
                reason = (
                    "DirectML GPU present; engine routes via torch CPU path "
                    "(DirectML acceleration not wired into routing)"
                )
                break
        return {
            "effective_device": "cpu",
            "routing_status": "cpu_only",
            "routing_reason": reason,
        }

    # 5. Engine needs an accelerator this host lacks and has no cpu path.
    first = targets[0]
    return {
        "effective_device": first,
        "routing_status": "unavailable",
        "routing_reason": f"requires {', '.join(targets)}; this host has {fam}",
    }


def routing_notice(result: RoutingResult) -> tuple[str, str | None] | None:
    """`(status, reason)` when a synth-time notice SHOULD be surfaced to the
    user, else `None`. Surfaced for `cpu_fallback` (always) and for
    `accelerated` ONLY when it carries a driver/arch caveat reason — everything
    else (`cpu_only`, clean `accelerated`, `n/a`) is benign and stays silent."""
    st = result["routing_status"]
    if st == "cpu_fallback" or (st == "accelerated" and result["routing_reason"]):
        return (st, result["routing_reason"])
    return None


def header_safe_reason(reason: str | None) -> str | None:
    """A routing reason made safe for an HTTP header value: scrubbed, then
    ASCII-sanitized (headers are latin-1; a non-ASCII device name would 500 the
    response otherwise), **control characters stripped** (a CR/LF could split
    the header / inject a new one), and length-capped at 256. Returns None for
    an empty reason. No regex — `.encode`/membership only (CodeQL-clean)."""
    if not reason:
        return None
    from core.scrub import scrub_text
    ascii_only = scrub_text(reason).encode("ascii", "ignore").decode("ascii")
    # Drop ASCII control chars (0x00-0x1F + DEL 0x7F) — incl. CR/LF, so the
    # value can never break out of its header line.
    cleaned = "".join(c for c in ascii_only if 0x20 <= ord(c) < 0x7F)
    return cleaned[:256] or None


def routing_fields(gpu_compat: tuple[str, ...], caps: HostCaps) -> dict:
    """The three serialization-ready routing keys for a ``list_backends`` entry.

    Resolves routing and applies the redaction contract: ``routing_reason`` is
    scrubbed via ``core.scrub.scrub_text`` only when truthy, so a ``None`` reason
    serializes as JSON ``null`` (NOT ``""`` — ``scrub_text(None)`` would coerce
    to ``""``). Used by tts/asr ``list_backends`` so the scrub rule lives in one
    place. (LLM emits its own literal ``network``/``n/a``/``null`` fields and
    does NOT call this.)
    """
    from core.scrub import scrub_text

    r = resolve_routing(tuple(gpu_compat or ()), caps)
    reason = r["routing_reason"]
    return {
        "effective_device": r["effective_device"],
        "routing_status": r["routing_status"],
        "routing_reason": scrub_text(reason) if reason else None,
    }


__all__ = [
    "RoutingStatus", "RoutingResult", "resolve_routing", "routing_fields",
    "routing_notice", "header_safe_reason",
]
