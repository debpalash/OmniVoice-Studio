"""Thin wrapper around the `tailscale` CLI. Every call degrades gracefully
when the CLI is missing or not logged in (installed/running flags).

`tailscale serve --https=443` requires the tailnet's HTTPS Certificates
feature (reported as non-empty ``CertDomains`` in `status --json`). Most
tailnets have it off — and forcing `--https` then fails with
"error enabling https feature: 404". So we serve over **HTTP** (`--http=80`)
by default — the WireGuard tunnel already encrypts the transport — and only
use HTTPS when the tailnet actually has certs provisioned.
"""
import json
import logging
import shutil
import subprocess

from services import network_share

_ADMIN_DNS = "https://login.tailscale.com/admin/dns"
logger = logging.getLogger("omnivoice.tailscale")


def _cli():
    return shutil.which("tailscale")


def status() -> dict:
    out = {
        "installed": False,
        "running": False,
        "magic_dns_name": "",
        "tailnet_ips": [],
        "cert_domains": [],
    }
    cli = _cli()
    if not cli:
        return out
    out["installed"] = True
    try:
        r = subprocess.run([cli, "status", "--json"], capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            return out
        data = json.loads(r.stdout or "{}")
        out["running"] = data.get("BackendState") == "Running"
        self_ = data.get("Self") or {}
        out["magic_dns_name"] = (self_.get("DNSName") or "").rstrip(".")
        out["tailnet_ips"] = self_.get("TailscaleIPs") or []
        out["cert_domains"] = data.get("CertDomains") or []
    except Exception:
        pass
    return out


def _run(args):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=20)
        if r.returncode != 0:
            return {"ok": False, "error": (r.stderr or r.stdout or "tailscale serve failed").strip()}
        return {"ok": True, "error": ""}
    except Exception:
        logger.exception("Tailscale command failed")
        return {"ok": False, "error": "tailscale command failed"}


def serve_enable(port: int | None = None) -> dict:
    if port is None:
        port = network_share.backend_port()
    cli = _cli()
    if not cli:
        return {"ok": False, "error": "Tailscale CLI not found. Install Tailscale and sign in first."}
    st = status()
    if not st.get("running"):
        return {
            "ok": False,
            "error": "Tailscale is installed but not running. Run `tailscale up` (and sign in), then retry.",
        }
    dns = st.get("magic_dns_name", "")
    target = f"http://127.0.0.1:{port}"

    # Use HTTPS only if the tailnet has certificate domains provisioned;
    # otherwise `--https` 404s ("error enabling https feature"). Fall back to
    # HTTP on any failure.
    if st.get("cert_domains"):
        https = _run([cli, "serve", "--bg", "--https=443", target])
        if https["ok"]:
            return {"ok": True, "scheme": "https", "url": f"https://{dns}" if dns else ""}

    http = _run([cli, "serve", "--bg", "--http=80", target])
    if http["ok"]:
        return {
            "ok": True,
            "scheme": "http",
            "url": f"http://{dns}" if dns else "",
            "note": (
                "Served over HTTP on your tailnet (the WireGuard tunnel encrypts it). "
                f"For an https:// URL, enable HTTPS Certificates in the admin console ({_ADMIN_DNS})."
            ),
        }
    return {
        "ok": False,
        "error": (
            f"tailscale serve failed: {http['error'] or 'unknown error'}. "
            f"Ensure MagicDNS is enabled for your tailnet ({_ADMIN_DNS})."
        ),
    }


def serve_disable() -> dict:
    cli = _cli()
    if not cli:
        return {"ok": True}
    try:
        subprocess.run([cli, "serve", "reset"], capture_output=True, text=True, timeout=20)
    except Exception:
        pass
    return {"ok": True}
