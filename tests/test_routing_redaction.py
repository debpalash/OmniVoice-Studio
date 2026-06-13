"""Token/path-safety contract for routing reasons (GPU compat matrix, PR 1).

``resolve_routing`` returns raw author strings, but any reason that interpolates
a ``device_name`` or probe note can carry a home path — so the serialization
layer scrubs it with ``core.scrub.scrub_text``. These tests pin that a reason
built from a home-path-bearing note comes out clean after scrubbing, and that a
``None`` reason must NOT be passed through ``scrub_text`` (which would turn it
into ``""`` instead of JSON ``null``).
"""
from __future__ import annotations

from core.device_caps import KERNEL_RISK_MARKER, HostCaps
from core.scrub import scrub_text
from services.engine_routing import resolve_routing


def _caps(family, *, notes=()):
    avail = (family, "cpu") if family != "cpu" else ("cpu",)
    return HostCaps(family=family, available_families=avail, notes=tuple(notes))


def test_home_path_in_caveat_reason_is_scrubbed():
    note = (f"/home/alice/torch GPU (sm_120) not in this build's archs "
            f"— {KERNEL_RISK_MARKER}")
    r = resolve_routing(("cuda", "cpu"), _caps("cuda", notes=[note]))
    raw = r["routing_reason"]
    assert "/home/alice" in raw           # pre-scrub carries the path
    clean = scrub_text(raw)
    assert "/home/alice" not in clean     # post-scrub it is gone
    assert "~" in clean


def test_none_reason_must_not_become_empty_string():
    r = resolve_routing(("cuda", "cpu"), _caps("cuda"))
    assert r["routing_reason"] is None
    # The serialization rule the wiring must follow: scrub only when truthy,
    # else preserve JSON null. scrub_text(None) would wrongly yield "".
    serialized = scrub_text(r["routing_reason"]) if r["routing_reason"] else None
    assert serialized is None
    assert scrub_text(None) == ""         # documents why the guard is needed


def test_fallback_reason_scrubs_clean_and_nonempty():
    r = resolve_routing(("cpu",), _caps("cuda"))
    clean = scrub_text(r["routing_reason"])
    assert clean and "***REDACTED***" not in clean  # no secret to redact here
