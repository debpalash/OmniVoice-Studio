"""Stable, non-diagnostic metadata for engine-discovery responses."""
from __future__ import annotations

from core.device_caps import KERNEL_RISK_MARKER

_UNAVAILABLE = "Engine unavailable. Check installation and configuration."
_PREVIOUS_FAILURE = "A previous engine check failed."
_ROUTING_BY_STATUS = {
    "cpu_fallback": "GPU acceleration is unavailable; this engine will use CPU.",
    "cpu_only": "This engine runs on CPU on this host.",
    "unavailable": "This engine has no compatible compute device on this host.",
}
_ROUTING_UNAVAILABLE = "Engine routing details are unavailable."
_ACCELERATOR_KERNEL_RISK = (
    "The selected accelerator may not be supported by this PyTorch build."
)
_ACCELERATOR_LOW_VRAM = (
    "The accelerator may not meet this engine's recommended VRAM."
)
_ACCELERATOR_ADVISORY = "The selected accelerator has a compatibility advisory."


def _public_routing_reason(status: object, diagnostic: object) -> str:
    """Map a private routing diagnostic to an accurate stable category."""
    if status == "accelerated":
        private = diagnostic if isinstance(diagnostic, str) else ""
        if KERNEL_RISK_MARKER in private:
            return _ACCELERATOR_KERNEL_RISK
        if " GB VRAM; this engine wants about " in private:
            return _ACCELERATOR_LOW_VRAM
        return _ACCELERATOR_ADVISORY
    return _ROUTING_BY_STATUS.get(status, _ROUTING_UNAVAILABLE)


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
            item["routing_reason"] = _public_routing_reason(
                item.get("routing_status"), item["routing_reason"]
            )
        evidence = item.get("execution_evidence")
        if isinstance(evidence, dict) and evidence.get("cpu_fallback_reason") is not None:
            evidence = dict(evidence)
            evidence["cpu_fallback_reason"] = _public_routing_reason(
                "cpu_fallback", evidence["cpu_fallback_reason"]
            )
            item["execution_evidence"] = evidence
        safe.append(item)
    return safe


def public_unavailability(detail: object) -> str | None:
    return None if detail is None else _UNAVAILABLE
