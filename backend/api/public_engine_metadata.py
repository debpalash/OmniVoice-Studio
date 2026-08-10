"""Stable, non-diagnostic metadata for engine-discovery responses."""
from __future__ import annotations

_UNAVAILABLE = "Engine unavailable. Check installation and configuration."
_PREVIOUS_FAILURE = "A previous engine check failed."
_ROUTING_BY_STATUS = {
    "accelerated": "The accelerator may not meet this engine's recommended VRAM.",
    "cpu_fallback": "GPU acceleration is unavailable; this engine will use CPU.",
    "unavailable": "This engine has no compatible compute device on this host.",
}
_ROUTING_UNAVAILABLE = "Engine routing details are unavailable."


def public_backends(entries: list[dict]) -> list[dict]:
    """Copy registry entries while replacing service diagnostics.

    Availability probes may contain exception text, local paths, tracebacks, or
    credentials. Installation hints are registry-authored and remain intact.
    """
    safe: list[dict] = []
    for entry in entries:
        item = dict(entry)
        if item.get("reason") is not None:
            item["reason"] = _UNAVAILABLE
        if item.get("last_error") is not None:
            item["last_error"] = _PREVIOUS_FAILURE
        if item.get("routing_reason") is not None:
            item["routing_reason"] = _ROUTING_BY_STATUS.get(
                item.get("routing_status"), _ROUTING_UNAVAILABLE
            )
        safe.append(item)
    return safe


def public_unavailability(detail: object) -> str | None:
    return None if detail is None else _UNAVAILABLE
