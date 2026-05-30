# Network Sharing & Tailscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user expose the *same running* OmniVoice backend to their other machines — PIN-gated LAN sharing (with QR) and Tailscale private remote access — without restarting the backend or dropping the loaded model / in-flight jobs, and with loopback-only as the default on every launch.

**Architecture:** A second in-process `uvicorn.Server` bound to `0.0.0.0:<P+1>` serves the *same* FastAPI `app` (no restart). A PIN middleware gates non-loopback clients (inert unless a PIN is set → docker deploys unaffected). The existing loopback-gated `system` router hosts the control endpoints (desktop-only by construction). Tailscale is driven by shelling out to the `tailscale` CLI and proxies the loopback backend. Frontend: a footer toggle + Settings panel, a global `X-OmniVoice-Pin` header injection in the single `apiFetch` chokepoint, and a remote PIN gate.

**Tech Stack:** FastAPI + uvicorn (programmatic `Server`), Starlette `BaseHTTPMiddleware`, `psutil.net_if_addrs`, `secrets`; React + Vitest, `qrcode` (new frontend dep), the `tailscale` CLI.

**Reference spec:** `docs/superpowers/specs/2026-05-30-network-sharing-design.md`

---

## File Structure

**Create:**
- `backend/services/network_share.py` — share-listener lifecycle + PIN + LAN enumeration (pure-ish, unit-testable).
- `backend/services/tailscale.py` — `tailscale` CLI wrapper (status/serve), graceful when CLI absent.
- `frontend/src/components/NetworkToggle.jsx` (+ `.css`) — footer pill, confirm, expandable panel (addresses/QR/PIN/copy/open).
- `frontend/src/components/RemoteAuthGate.jsx` — PIN entry screen for remote devices on 401.
- `frontend/src/components/settings/SharingPanel.jsx` (+ `.css`) — Settings surface (LAN mirror + Tailscale).
- Tests: `tests/test_network_share.py`, `tests/test_network_middleware.py`, `tests/test_tailscale_service.py`, `frontend/src/components/NetworkToggle.test.jsx`, `frontend/src/components/settings/SharingPanel.test.jsx`, plus client-PIN test.

**Modify:**
- `backend/api/schemas.py` — extend `SystemInfoResponse` with sharing fields.
- `backend/api/routers/system.py` — `/system/network/{enable,disable,state}`, `/system/tailscale/{status,enable,disable}`, `/system/info` fields.
- `backend/main.py` — register `NetworkAccessMiddleware`; init `app.state.network_share` in `lifespan`.
- `frontend/src/api/client.ts` — inject `X-OmniVoice-Pin` in `apiFetch`; capture `?pin=` at module load.
- `frontend/src/components/LogsFooter.jsx` — mount `<NetworkToggle/>` in `logs-footer__right`.
- `frontend/src/pages/Settings.jsx` — register the "Sharing" tab + `<SharingPanel/>`.
- `frontend/src/App.jsx` (or root) — mount `<RemoteAuthGate/>`.
- `frontend/package.json` — add `qrcode`.

**Constant:** the primary backend port is the hardcoded literal `3900` (`backend/main.py`; no `OMNIVOICE_PORT`). Introduce `BACKEND_PORT = 3900` in `backend/services/network_share.py` and use it as the base; the share port is the first free port from `3901`.

---

## Phase 1 — Backend: share listener, schema, control endpoints

### Task 1: `network_share` module — LAN enumeration + PIN

**Files:**
- Create: `backend/services/network_share.py`
- Test: `tests/test_network_share.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_network_share.py
import socket
from unittest.mock import patch
from services import network_share as ns


def _addr(ip):
    class A:  # mimic psutil snicaddr
        family = socket.AF_INET
        address = ip
    return A()


def test_lan_ipv4_filters_loopback_and_linklocal():
    fake = {
        "lo0": [_addr("127.0.0.1")],
        "en0": [_addr("192.168.1.42")],
        "en1": [_addr("169.254.5.5"), _addr("10.0.0.9")],
    }
    with patch("services.network_share.psutil.net_if_addrs", return_value=fake):
        out = ns.lan_ipv4_addresses()
    assert out == ["192.168.1.42", "10.0.0.9"]


def test_gen_pin_is_six_digits():
    pin = ns._gen_pin()
    assert pin.isdigit() and len(pin) == 6
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd /Users/user4/Desktop/github/OmniVoice && python -m pytest tests/test_network_share.py -q`
Expected: FAIL (module `services.network_share` does not exist).

- [ ] **Step 3: Implement the module (enumeration + PIN + state, no listener yet)**

```python
# backend/services/network_share.py
"""Same-process LAN share listener + access PIN.

Enabling starts a SECOND uvicorn.Server bound to 0.0.0.0 on a dedicated port,
serving the SAME FastAPI app object — so the loaded model and in-flight jobs
are untouched (no restart). Disabling stops it, closing the 0.0.0.0 socket.
Loopback-only by default: nothing binds 0.0.0.0 until enable() is called.
"""
import asyncio
import secrets
import socket
from dataclasses import dataclass, field
from typing import Optional

import psutil
import uvicorn

BACKEND_PORT = 3900  # must match backend/main.py uvicorn.run(port=...)


@dataclass
class ShareState:
    enabled: bool = False
    share_port: Optional[int] = None
    pin: Optional[str] = None
    lan_addresses: list = field(default_factory=list)


_state = ShareState()
_server: Optional["uvicorn.Server"] = None
_task: Optional["asyncio.Task"] = None


def lan_ipv4_addresses() -> list:
    out, seen = [], set()
    for _name, addrs in psutil.net_if_addrs().items():
        for a in addrs:
            if a.family == socket.AF_INET:
                ip = a.address
                if ip.startswith("127.") or ip.startswith("169.254."):
                    continue
                if ip not in seen:
                    seen.add(ip)
                    out.append(ip)
    return out


def _gen_pin() -> str:
    return f"{secrets.randbelow(900000) + 100000}"  # 100000-999999


def _find_free_port(base: int, tries: int = 20) -> int:
    for p in range(base, base + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", p))
                return p
            except OSError:
                continue
    raise RuntimeError("no free share port available")


def get_state() -> ShareState:
    return _state


async def enable(app) -> ShareState:
    global _server, _task, _state
    if _state.enabled:
        return _state
    port = _find_free_port(BACKEND_PORT + 1)
    pin = _gen_pin()
    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="warning")
    server = uvicorn.Server(config)
    server.install_signal_handlers = lambda: None  # never hijack signals in-process
    _task = asyncio.create_task(server.serve())
    for _ in range(100):  # ~5s for the socket to bind
        if getattr(server, "started", False):
            break
        await asyncio.sleep(0.05)
    _server = server
    _state = ShareState(True, port, pin, lan_ipv4_addresses())
    app.state.network_share = _state
    return _state


async def disable(app) -> ShareState:
    global _server, _task, _state
    if _server is not None:
        _server.should_exit = True
        if _task is not None:
            try:
                await asyncio.wait_for(_task, timeout=5)
            except Exception:
                pass
    _server = _task = None
    _state = ShareState()
    app.state.network_share = _state
    return _state
```

- [ ] **Step 4: Run tests — expect pass**

Run: `python -m pytest tests/test_network_share.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/services/network_share.py tests/test_network_share.py
git commit -m "feat(network): share-listener module — LAN enumeration + PIN + lifecycle"
```

### Task 2: Extend `SystemInfoResponse` schema

**Files:**
- Modify: `backend/api/schemas.py` (the `SystemInfoResponse` model)
- Test: covered by Task 3's endpoint test.

- [ ] **Step 1: Add optional fields (default-safe so the never-throw `/system/info` contract holds)**

Locate `class SystemInfoResponse(BaseModel)` in `backend/api/schemas.py`. Add:

```python
    share_enabled: bool = False
    share_port: Optional[int] = None
    lan_addresses: list[str] = []
    pin_required: bool = False
```

(If the file lacks `from typing import Optional`, add it. `list[str] = []` default is fine for a response model.)

- [ ] **Step 2: Commit (grouped with Task 3).**

### Task 3: Control endpoints + `/system/info` fields

**Files:**
- Modify: `backend/api/routers/system.py`
- Test: `tests/test_network_share.py` (append endpoint tests)

> NOTE: the `system` router is loopback-gated (`APIRouter(dependencies=[Depends(require_loopback)])`). That is correct here — these control endpoints are desktop-only by design. Remote devices never call them.

- [ ] **Step 1: Write the failing endpoint tests**

```python
# append to tests/test_network_share.py
from fastapi.testclient import TestClient


def _loopback_client():
    from main import app
    return TestClient(app, client=("127.0.0.1", 50000))


def test_network_state_endpoint_defaults_disabled():
    c = _loopback_client()
    r = c.get("/system/network/state")
    assert r.status_code == 200
    assert r.json()["enabled"] is False


def test_network_control_rejects_non_loopback():
    from main import app
    c = TestClient(app, client=("10.0.0.5", 9999))
    assert c.post("/system/network/enable").status_code == 403


def test_system_info_has_sharing_fields():
    c = _loopback_client()
    body = c.get("/system/info").json()
    for k in ("share_enabled", "share_port", "lan_addresses", "pin_required"):
        assert k in body
```

- [ ] **Step 2: Run — expect failure** (`python -m pytest tests/test_network_share.py -q`) → 404/KeyError.

- [ ] **Step 3: Add endpoints + info fields in `backend/api/routers/system.py`**

Add near the imports: `from fastapi import Request` (extend the existing `from fastapi import ...` line) and `from services import network_share`.

Append at end of file (after `quarantine_status`):

```python
# ── Network sharing (loopback-only control surface) ──────────────────────────

@router.get("/system/network/state")
async def network_state():
    st = network_share.get_state()
    return {
        "enabled": st.enabled,
        "share_port": st.share_port,
        "pin": st.pin,
        "lan_addresses": st.lan_addresses,
    }


@router.post("/system/network/enable")
async def network_enable(request: Request):
    st = await network_share.enable(request.app)
    return {
        "enabled": st.enabled,
        "share_port": st.share_port,
        "pin": st.pin,
        "lan_addresses": st.lan_addresses,
    }


@router.post("/system/network/disable")
async def network_disable(request: Request):
    st = await network_share.disable(request.app)
    return {"enabled": st.enabled}
```

In `system_info()`, add to BOTH the success and except dicts (keep the never-throw contract):

```python
            "share_enabled": network_share.get_state().enabled,
            "share_port": network_share.get_state().share_port,
            "lan_addresses": network_share.get_state().lan_addresses,
            "pin_required": bool(network_share.get_state().pin),
```

(In the `except` branch use the same — `get_state()` is cheap and never throws.)

- [ ] **Step 4: Run — expect pass** (`python -m pytest tests/test_network_share.py -q`).

- [ ] **Step 5: Commit**

```bash
git add backend/api/schemas.py backend/api/routers/system.py tests/test_network_share.py
git commit -m "feat(network): loopback-only control endpoints + /system/info sharing fields"
```

---

## Phase 2 — Backend: PIN middleware

### Task 4: `NetworkAccessMiddleware`

**Files:**
- Modify: `backend/main.py`
- Test: `tests/test_network_middleware.py`

- [ ] **Step 1: Write the failing test** (drives a fake share state onto `app.state`)

```python
# tests/test_network_middleware.py
from fastapi.testclient import TestClient
from services import network_share as ns


def _app_with_pin(pin="123456"):
    from main import app
    app.state.network_share = ns.ShareState(enabled=True, share_port=3901, pin=pin, lan_addresses=["10.0.0.9"])
    return app


def teardown_function():
    from main import app
    app.state.network_share = ns.ShareState()  # reset → middleware inert


def test_inert_when_no_pin():
    from main import app
    app.state.network_share = ns.ShareState()  # no pin
    c = TestClient(app, client=("10.0.0.5", 1))   # non-loopback
    assert c.get("/health").status_code == 200


def test_loopback_bypasses_pin():
    c = TestClient(_app_with_pin(), client=("127.0.0.1", 1))
    assert c.get("/system/info").status_code == 200  # loopback → ok


def test_non_loopback_without_pin_401_on_api():
    c = TestClient(_app_with_pin(), client=("10.0.0.5", 1))
    r = c.get("/api/voices")  # any non-shell API path
    assert r.status_code in (401,)  # PIN required


def test_non_loopback_with_valid_pin_passes():
    c = TestClient(_app_with_pin("654321"), client=("10.0.0.5", 1))
    r = c.get("/api/voices", headers={"X-OmniVoice-Pin": "654321"})
    assert r.status_code != 401


def test_spa_shell_served_without_pin():
    c = TestClient(_app_with_pin(), client=("10.0.0.5", 1))
    assert c.get("/health").status_code == 200
```

- [ ] **Step 2: Run — expect failure** (non-loopback `/api/voices` currently 200/404, not 401).

- [ ] **Step 3: Implement the middleware in `backend/main.py`**

Add import near the other imports: `from starlette.middleware.base import BaseHTTPMiddleware` and ensure `JSONResponse` is imported (it is, line ~196). Add `import secrets` if not present.

Define before the `app.add_middleware(CORSMiddleware, ...)` block (~line 422):

```python
_LOOPBACK_CLIENTS = {"127.0.0.1", "::1"}
_SHELL_PATHS = {"/", "/index.html", "/favicon.ico", "/health"}


class NetworkAccessMiddleware(BaseHTTPMiddleware):
    """When a share PIN is set, require it for non-loopback clients on API
    routes. Inert when no PIN (default + docker deploys). Loopback (incl.
    Tailscale-proxied) always bypasses; the SPA shell is always served so the
    PIN gate UI can load."""

    async def dispatch(self, request, call_next):
        ns = getattr(request.app.state, "network_share", None)
        pin = getattr(ns, "pin", None) if ns else None
        if not pin:
            return await call_next(request)
        client = request.client.host if request.client else None
        if client in _LOOPBACK_CLIENTS:
            return await call_next(request)
        path = request.url.path
        if path in _SHELL_PATHS or path.startswith("/assets/") or path.startswith("/favicon"):
            return await call_next(request)
        supplied = (
            request.headers.get("x-omnivoice-pin")
            or request.query_params.get("pin")
            or request.cookies.get("ov_pin")
            or ""
        )
        if not secrets.compare_digest(supplied, pin):
            return JSONResponse({"detail": "PIN required"}, status_code=401)
        response = await call_next(request)
        if request.cookies.get("ov_pin") != pin:
            response.set_cookie("ov_pin", pin, samesite="lax")
        return response
```

Register it (order: add AFTER CORS so CORS wraps outermost):

```python
app.add_middleware(NetworkAccessMiddleware)
```

Also initialize state in `lifespan` (before `yield`, ~line 252): `app.state.network_share = network_share.get_state()` with `from services import network_share` imported at top.

- [ ] **Step 4: Run — expect pass** (`python -m pytest tests/test_network_middleware.py -q`). If `/api/voices` 404s before the PIN check, use an existing GET API path; the assertion is `status_code == 401`, which the middleware returns before routing.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_network_middleware.py
git commit -m "feat(network): PIN middleware — gate non-loopback API access when sharing on"
```

---

## Phase 3 — Frontend: PIN header injection + remote gate

### Task 5: Inject `X-OmniVoice-Pin` in `apiFetch` + capture `?pin=`

**Files:**
- Modify: `frontend/src/api/client.ts`
- Test: `frontend/src/api/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/api/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('apiFetch PIN header', () => {
  let realFetch;
  beforeEach(() => { realFetch = global.fetch; sessionStorage.clear(); });
  afterEach(() => { global.fetch = realFetch; sessionStorage.clear(); });

  it('attaches X-OmniVoice-Pin when present in sessionStorage', async () => {
    sessionStorage.setItem('ov_pin', '424242');
    const seen: any = {};
    global.fetch = vi.fn((_url, opts) => { Object.assign(seen, opts); return Promise.resolve({ ok: true, json: async () => ({}) }); });
    const { apiFetch } = await import('./client');
    await apiFetch('/system/info');
    expect((seen.headers || {})['X-OmniVoice-Pin']).toBe('424242');
  });

  it('omits the header when no pin', async () => {
    const seen: any = {};
    global.fetch = vi.fn((_url, opts) => { Object.assign(seen, opts); return Promise.resolve({ ok: true, json: async () => ({}) }); });
    const { apiFetch } = await import('./client');
    await apiFetch('/system/info');
    expect((seen.headers || {})['X-OmniVoice-Pin']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect failure** (`cd frontend && npx vitest run src/api/client.test.ts`).

- [ ] **Step 3: Implement** — in `apiFetch` (the single chokepoint at line ~39):

```ts
export async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const pin = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ov_pin') : null;
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> || {}) };
  if (pin) headers['X-OmniVoice-Pin'] = pin;
  const res = await fetch(apiUrl(path), { ...opts, headers });
  if (!res.ok) { const detail = await readError(res); throw new ApiError(res.status, detail); }
  return res;
}
```

And at module top (after `export const API = ...`), capture a QR-supplied PIN once:

```ts
if (typeof window !== 'undefined') {
  try {
    const p = new URL(window.location.href).searchParams.get('pin');
    if (p) sessionStorage.setItem('ov_pin', p);
  } catch { /* noop */ }
}
```

- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "feat(network): inject X-OmniVoice-Pin globally + capture ?pin= from QR URL"
```

### Task 6: `RemoteAuthGate` component

**Files:**
- Create: `frontend/src/components/RemoteAuthGate.jsx`
- Modify: mount in `frontend/src/App.jsx`
- Test: `frontend/src/components/RemoteAuthGate.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/components/RemoteAuthGate.test.jsx
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RemoteAuthGate from './RemoteAuthGate';

describe('RemoteAuthGate', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it('renders children when not gated', () => {
    render(<RemoteAuthGate><div>app-content</div></RemoteAuthGate>);
    expect(screen.getByText('app-content')).toBeInTheDocument();
  });

  it('stores the entered PIN', () => {
    render(<RemoteAuthGate forceGate><div>app-content</div></RemoteAuthGate>);
    fireEvent.change(screen.getByLabelText(/access pin/i), { target: { value: '999111' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(sessionStorage.getItem('ov_pin')).toBe('999111');
  });
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement** (gate triggered by a global `ov:pin-required` event the api layer dispatches on 401; `forceGate` prop is test-only):

```jsx
// frontend/src/components/RemoteAuthGate.jsx
import { useEffect, useState } from 'react';

export default function RemoteAuthGate({ children, forceGate = false }) {
  const [gated, setGated] = useState(forceGate);
  const [pin, setPin] = useState('');

  useEffect(() => {
    const onRequired = () => setGated(true);
    window.addEventListener('ov:pin-required', onRequired);
    return () => window.removeEventListener('ov:pin-required', onRequired);
  }, []);

  if (!gated) return children;

  const submit = (e) => {
    e.preventDefault();
    const v = pin.trim();
    if (!v) return;
    sessionStorage.setItem('ov_pin', v);
    window.location.reload();
  };

  return (
    <div className="remote-auth-gate" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="remote-auth-gate__card">
        <h2>Enter access PIN</h2>
        <p>This OmniVoice instance is shared on the network. Enter the PIN shown on the host.</p>
        <label htmlFor="ov-pin">Access PIN</label>
        <input id="ov-pin" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
        <button type="submit">Connect</button>
      </form>
    </div>
  );
}
```

In `client.ts` `apiFetch`, dispatch the event on a 401 (so the gate appears): inside the `if (!res.ok)` branch, before throwing — `if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('ov:pin-required'));`

Mount in `App.jsx`: wrap the top-level app tree with `<RemoteAuthGate>...</RemoteAuthGate>` (import it; place just inside the root provider).

- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/RemoteAuthGate.jsx frontend/src/components/RemoteAuthGate.test.jsx frontend/src/api/client.ts frontend/src/App.jsx
git commit -m "feat(network): remote PIN gate on 401"
```

---

## Phase 4 — Frontend: footer toggle + panel + QR

### Task 7: add the `qrcode` dependency

- [ ] **Step 1:** `cd frontend && (bun add qrcode || npm install qrcode)`
- [ ] **Step 2: Commit** `git add frontend/package.json frontend/bun.lockb frontend/package-lock.json 2>/dev/null; git commit -m "chore(network): add qrcode dep for share QR"`

### Task 8: `NetworkToggle` component

**Files:**
- Create: `frontend/src/components/NetworkToggle.jsx`, `frontend/src/components/NetworkToggle.css`
- Modify: `frontend/src/components/LogsFooter.jsx`
- Test: `frontend/src/components/NetworkToggle.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/components/NetworkToggle.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import NetworkToggle from './NetworkToggle';

describe('NetworkToggle', () => {
  let realFetch;
  beforeEach(() => { realFetch = global.fetch; });
  afterEach(() => { global.fetch = realFetch; });

  it('defaults to Local when state reports disabled', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ enabled: false }) }));
    render(<NetworkToggle />);
    await waitFor(() => expect(screen.getByText(/local/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement** (logic-complete; styling follows the `SourcePill` BEM pattern in `LogsFooter.jsx`). Uses `apiJson`/`apiPost` from `../api/client`. On enable: POST `/system/network/enable`; render panel with `lan_addresses`, per-row copy (`navigator.clipboard.writeText`) + open (`openExternal` from `../api/external`), a QR (`import QRCode from 'qrcode'` → `QRCode.toDataURL('http://'+ip+':'+share_port+'/?pin='+pin)`), and the PIN. On disable: POST `/system/network/disable`. Confirm dialog before enabling. Read initial state from `/system/network/state` on mount.

Full component:

```jsx
// frontend/src/components/NetworkToggle.jsx
import { useEffect, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { Wifi, WifiOff, Copy, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiJson, apiPost } from '../api/client';
import { openExternal } from '../api/external';
import './NetworkToggle.css';

export default function NetworkToggle() {
  const [st, setSt] = useState({ enabled: false });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [qrs, setQrs] = useState({});

  const refresh = useCallback(async () => {
    try { setSt(await apiJson('/system/network/state')); } catch { /* loopback only; ignore */ }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!st.enabled || !st.pin) { setQrs({}); return; }
    let cancelled = false;
    (async () => {
      const next = {};
      for (const ip of st.lan_addresses || []) {
        next[ip] = await QRCode.toDataURL(`http://${ip}:${st.share_port}/?pin=${st.pin}`);
      }
      if (!cancelled) setQrs(next);
    })();
    return () => { cancelled = true; };
  }, [st.enabled, st.pin, st.share_port, st.lan_addresses]);

  const enable = async () => {
    if (!window.confirm('Share OmniVoice on your local network? Other devices will be able to reach it with the access PIN.')) return;
    setBusy(true);
    try { setSt(await apiPost('/system/network/enable')); setOpen(true); }
    catch (e) { toast.error(`Could not enable sharing: ${e.message}`); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try { await apiPost('/system/network/disable'); await refresh(); setOpen(false); }
    catch (e) { toast.error(`Could not disable: ${e.message}`); }
    finally { setBusy(false); }
  };

  const copy = (text) => { navigator.clipboard?.writeText(text); toast.success('Copied'); };

  return (
    <div className="net-toggle">
      <button
        className={`net-toggle__pill ${st.enabled ? 'net-toggle__pill--on' : ''}`}
        onClick={st.enabled ? () => setOpen((o) => !o) : enable}
        disabled={busy}
        title={st.enabled ? 'Sharing on — click for details' : 'Share on your network'}
      >
        {st.enabled ? <Wifi size={12} /> : <WifiOff size={12} />}
        <span>{busy ? 'Switching…' : st.enabled ? 'Network' : 'Local'}</span>
      </button>

      {st.enabled && open && (
        <div className="net-toggle__panel">
          {(st.lan_addresses || []).length === 0 && <p>No reachable network interface — connect to Wi-Fi/Ethernet.</p>}
          {(st.lan_addresses || []).map((ip) => {
            const url = `http://${ip}:${st.share_port}/?pin=${st.pin}`;
            return (
              <div key={ip} className="net-toggle__row">
                <code>{ip}:{st.share_port}</code>
                <button onClick={() => copy(url)} aria-label={`Copy ${ip}`}><Copy size={12} /></button>
                <button onClick={() => openExternal(url)} aria-label={`Open ${ip}`}><ExternalLink size={12} /></button>
                {qrs[ip] && <img className="net-toggle__qr" src={qrs[ip]} alt={`QR for ${ip}`} width={96} height={96} />}
              </div>
            );
          })}
          <div className="net-toggle__pin">PIN: <strong>{st.pin}</strong></div>
          <button className="net-toggle__off" onClick={disable} disabled={busy}>Stop sharing</button>
        </div>
      )}
    </div>
  );
}
```

`NetworkToggle.css`: a small pill + dropdown panel; match `logs-footer__*` visual weight (executor: follow `LogsFooter.css` conventions — gruvbox palette, `--on` accent green `#b8bb26`).

- [ ] **Step 4: Mount in `LogsFooter.jsx`** — import `NetworkToggle`, render `<NetworkToggle />` inside `<div className="logs-footer__right">` immediately before the `logs-footer__discord` button (~line 390).

- [ ] **Step 5: Run test + build**

Run: `cd frontend && npx vitest run src/components/NetworkToggle.test.jsx && bun run build`
Expected: test PASS, build exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/NetworkToggle.jsx frontend/src/components/NetworkToggle.css frontend/src/components/NetworkToggle.test.jsx frontend/src/components/LogsFooter.jsx
git commit -m "feat(network): footer Local/Network toggle with LAN addresses, QR, copy/open"
```

---

## Phase 5 — Tailscale

### Task 9: `tailscale` service wrapper

**Files:**
- Create: `backend/services/tailscale.py`
- Test: `tests/test_tailscale_service.py`

- [ ] **Step 1: Write the failing test** (mock `subprocess`)

```python
# tests/test_tailscale_service.py
import json
from unittest.mock import patch, MagicMock
from services import tailscale as ts


def test_status_absent_cli_is_graceful():
    with patch("services.tailscale.shutil.which", return_value=None):
        s = ts.status()
    assert s["installed"] is False and s["running"] is False


def test_status_parses_json():
    payload = {"BackendState": "Running", "Self": {"DNSName": "box.tail1234.ts.net.", "TailscaleIPs": ["100.64.0.1"]}}
    with patch("services.tailscale.shutil.which", return_value="/usr/bin/tailscale"), \
         patch("services.tailscale.subprocess.run", return_value=MagicMock(returncode=0, stdout=json.dumps(payload))):
        s = ts.status()
    assert s["installed"] and s["running"]
    assert s["magic_dns_name"] == "box.tail1234.ts.net"
    assert s["tailnet_ips"] == ["100.64.0.1"]
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement**

```python
# backend/services/tailscale.py
"""Thin wrapper around the `tailscale` CLI. Every call degrades gracefully
when the CLI is missing or not logged in (installed/running flags)."""
import json
import shutil
import subprocess
from services.network_share import BACKEND_PORT


def _cli():
    return shutil.which("tailscale")


def status() -> dict:
    out = {"installed": False, "running": False, "magic_dns_name": "", "tailnet_ips": []}
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
    except Exception:
        pass
    return out


def serve_enable(port: int = BACKEND_PORT) -> dict:
    cli = _cli()
    if not cli:
        return {"ok": False, "error": "tailscale CLI not found"}
    try:
        r = subprocess.run(
            [cli, "serve", "--bg", "--https=443", f"http://127.0.0.1:{port}"],
            capture_output=True, text=True, timeout=20,
        )
        if r.returncode != 0:
            return {"ok": False, "error": (r.stderr or r.stdout or "tailscale serve failed").strip()}
        dns = status().get("magic_dns_name", "")
        return {"ok": True, "url": f"https://{dns}" if dns else ""}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def serve_disable() -> dict:
    cli = _cli()
    if not cli:
        return {"ok": True}
    try:
        subprocess.run([cli, "serve", "reset"], capture_output=True, text=True, timeout=20)
    except Exception:
        pass
    return {"ok": True}
```

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Add endpoints** in `backend/api/routers/system.py` (loopback-only router — correct, desktop-driven):

```python
from services import tailscale as _tailscale

@router.get("/system/tailscale/status")
async def tailscale_status():
    return _tailscale.status()

@router.post("/system/tailscale/enable")
async def tailscale_enable():
    return _tailscale.serve_enable()

@router.post("/system/tailscale/disable")
async def tailscale_disable():
    return _tailscale.serve_disable()
```

- [ ] **Step 6: Commit**

```bash
git add backend/services/tailscale.py tests/test_tailscale_service.py backend/api/routers/system.py
git commit -m "feat(tailscale): CLI status + serve enable/disable + endpoints"
```

---

## Phase 6 — Settings panel

### Task 10: `SharingPanel`

**Files:**
- Create: `frontend/src/components/settings/SharingPanel.jsx`, `.css`
- Modify: `frontend/src/pages/Settings.jsx`
- Test: `frontend/src/components/settings/SharingPanel.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/components/settings/SharingPanel.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SharingPanel from './SharingPanel';

describe('SharingPanel', () => {
  let realFetch;
  beforeEach(() => { realFetch = global.fetch; });
  afterEach(() => { global.fetch = realFetch; });

  it('shows Tailscale "not detected" when CLI absent', async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).includes('tailscale/status')) return Promise.resolve({ ok: true, json: async () => ({ installed: false }) });
      return Promise.resolve({ ok: true, json: async () => ({ enabled: false }) });
    });
    render(<SharingPanel />);
    await waitFor(() => expect(screen.getByText(/not detected|install tailscale/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement** following the `StoragePanel.jsx` template (default export, `apiJson`/`apiPost`, `toast`, `sharingpanel__*` classes, `<section aria-labelledby>`). It mirrors the LAN toggle (reuse `<NetworkToggle/>` or call the same endpoints) and adds a Tailscale section: read `/system/tailscale/status`; if `!installed` show an "Install Tailscale" link (`openExternal('https://tailscale.com/download')`); else an enable/disable control that POSTs `/system/tailscale/enable|disable` and shows the returned `url` with copy/open + a QR (reuse the `qrcode` import).

- [ ] **Step 4: Register in `Settings.jsx`** — add `import SharingPanel from '../components/settings/SharingPanel';`; add `{ id: 'sharing', label: 'Sharing', icon: Wifi, accent: '#83a598' }` to the `TABS` array (import `Wifi` from lucide-react); add `{activeTab === 'sharing' && <SharingPanel />}` alongside the other dispatch blocks.

- [ ] **Step 5: Run test + build**

Run: `cd frontend && npx vitest run src/components/settings/SharingPanel.test.jsx && bun run build`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/settings/SharingPanel.jsx frontend/src/components/settings/SharingPanel.css frontend/src/components/settings/SharingPanel.test.jsx frontend/src/pages/Settings.jsx
git commit -m "feat(network): Settings → Sharing & Remote Access panel (LAN + Tailscale)"
```

---

## Phase 7 — Docs & full-suite verification

### Task 11: docs + final checks

- [ ] **Step 1:** Create `docs/sharing.md` — how to share on the LAN (PIN + QR), the security model (loopback-only default; `/system/*` is loopback-gated), and the Tailscale path. No CJK (honors the localization rule).
- [ ] **Step 2: Backend suite** — `python -m pytest tests/test_network_share.py tests/test_network_middleware.py tests/test_tailscale_service.py tests/test_no_hardcoded_cjk.py -q` → all pass.
- [ ] **Step 3: Frontend** — `cd frontend && npx vitest run src/components/NetworkToggle.test.jsx src/components/RemoteAuthGate.test.jsx src/components/settings/SharingPanel.test.jsx src/api/client.test.ts && bun run build` → pass + exit 0.
- [ ] **Step 4: Commit docs** `git add docs/sharing.md && git commit -m "docs(network): sharing & remote access guide"`
- [ ] **Step 5:** Open PR from `feat/network-sharing` → `main`; after it merges, close PR #125 reference is already done.

---

## Notes for the executor
- The `system` router is loopback-gated by `Depends(require_loopback)` — all `/system/network/*` and `/system/tailscale/*` endpoints inherit it (desktop-only by design; this is the security guarantee, not a bug). Do NOT move them to an ungated router.
- The PIN middleware is **inert unless `app.state.network_share.pin` is set** — this preserves docker `0.0.0.0` deploys (no regression).
- `request.client.host` is the real TCP peer (non-spoofable); loopback check is correct and matches `require_loopback`.
- Keep all user-facing strings English / i18n — `tests/test_no_hardcoded_cjk.py` will fail CI otherwise.
- The share listener shares the *same* `app` object → model/jobs are never restarted.
