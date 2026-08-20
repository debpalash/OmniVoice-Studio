"""#1618 — RAM preflight must not hard-block the machines it means to admit.

An "8 GB" machine reports ~7.8 GB usable (firmware/iGPU/kernel reservations),
so comparing reported RAM against the marketing-size threshold blocked exactly
the boundary hardware the ≥8 GB rule intends to allow. The check now applies
``_RAM_RESERVED_ALLOWANCE`` to both thresholds, and
``OMNIVOICE_RAM_PREFLIGHT=0`` downgrades a genuine fail to a warning.
"""

import pytest

from api.routers.setup import wizard


def _ram_check(monkeypatch, ram_gb: float, env: str | None = None) -> dict:
    # Keep the preflight hermetic: stub the probes that hit the network or
    # auto-acquire media tools, so each RAM assertion stays fast and offline.
    monkeypatch.setattr(wizard, "_network_check", lambda: {
        "id": "network", "label": "Network", "status": "pass",
        "detail": "stubbed", "fix": None, "mirror_reachable": True,
    })
    import services.media_tools as media_tools
    monkeypatch.setattr(media_tools, "summary", lambda auto_acquire=True: None)
    monkeypatch.setattr(wizard, "_ram_gb", lambda: ram_gb)
    if env is None:
        monkeypatch.delenv("OMNIVOICE_RAM_PREFLIGHT", raising=False)
    else:
        monkeypatch.setenv("OMNIVOICE_RAM_PREFLIGHT", env)
    resp = wizard.preflight()
    checks = resp["checks"] if isinstance(resp, dict) else resp.checks
    for c in checks:
        c = c if isinstance(c, dict) else c.model_dump()
        if c["id"] == "ram":
            return c
    raise AssertionError("no ram check in preflight response")


def test_8gb_installed_reporting_7_84_usable_is_not_blocked(monkeypatch):
    """The #1618 report: 7.84 GB usable on an 8 GB laptop was a hard fail."""
    check = _ram_check(monkeypatch, 7.84)
    assert check["status"] != "fail"


def test_boundary_at_allowance_passes_the_fail_gate(monkeypatch):
    check = _ram_check(
        monkeypatch, wizard._RAM_FAIL_GB * wizard._RAM_RESERVED_ALLOWANCE
    )
    assert check["status"] != "fail"


def test_genuinely_low_ram_still_fails(monkeypatch):
    check = _ram_check(monkeypatch, 6.0)
    assert check["status"] == "fail"


@pytest.mark.parametrize("env", ["0", "false", "no"])
def test_escape_hatch_downgrades_fail_to_warn(monkeypatch, env):
    check = _ram_check(monkeypatch, 6.0, env=env)
    assert check["status"] == "warn"
    assert "OMNIVOICE_RAM_PREFLIGHT" in (check["fix"] or "")


def test_escape_hatch_not_triggered_by_other_values(monkeypatch):
    check = _ram_check(monkeypatch, 6.0, env="1")
    assert check["status"] == "fail"


def test_12gb_installed_reporting_11_8_usable_passes_clean(monkeypatch):
    """Same reservation gap at the warn threshold: 12 GB installed ≈ 11.8."""
    check = _ram_check(monkeypatch, 11.8)
    assert check["status"] == "pass"


def test_warn_band_between_thresholds(monkeypatch):
    check = _ram_check(monkeypatch, 9.0)
    assert check["status"] == "warn"
