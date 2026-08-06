# Network Sharing & Tailscale Remote Access — Design Spec

- **Date:** 2026-05-30
- **Status:** Approved design — pending spec review
- **Supersedes:** the raw `0.0.0.0` default-flip proposed in community PR #125 (declined as a silent default change; replaced by this explicit, user-driven feature)
- **Ships on:** v0.3.0

## 1. Goal

Let a user **see and access the same running VoiceStudio instance from their other machines** — without losing the loaded model or interrupting in-flight jobs, and without weakening the local-first default. Two complementary capabilities:

- **A. LAN sharing** — expose the *same* backend to devices on the same network (Wi-Fi/Ethernet), gated by a short access **PIN**, with a polished footer panel: all LAN addresses, copy/open link, and a **QR code** for phones.
- **B. Tailscale remote access** — for secure, private access from *anywhere*, a Settings toggle that drives `tailscale serve` to publish the WebUI over the user's tailnet at an HTTPS `*.ts.net` URL (TLS + identity handled by Tailscale; no open ports, no PIN).

Both leave the running model and job state **completely untouched**.

## 2. Non-Goals (explicitly out of scope)

- **WebRTC** — evaluated and dropped; Tailscale fully covers "secure private remote access" with far less risk and no STUN/TURN infrastructure. May be revisited in its own spec if real-time P2P media becomes a requirement.
- **TLS for the LAN path** — the LAN listener is plain HTTP (the app is HTTP today). Users who want encryption use the Tailscale path (B), which terminates TLS.
- **Accounts / per-device tokens / PIN expiry beyond the session** — one shared session PIN. YAGNI.
- **Changing the default bind** — the primary backend stays loopback-only by default on every launch (the user's chosen "always start Local").

## 3. Core constraint → mechanism

A live socket cannot be re-bound, and you cannot bind both `127.0.0.1:P` and `0.0.0.0:P` simultaneously. Restarting uvicorn to change the host would drop the loaded model and kill in-flight jobs — **disqualified by the requirement to preserve active work.**

**Mechanism: a second in-process listener on a dedicated share port.**

The backend already runs under uvicorn on `127.0.0.1:P` (P = `backend_port()`, spawned by Tauri). On "enable LAN sharing," the backend starts a **second `uvicorn.Server` bound to `0.0.0.0` on a share port** (default `P+1`, auto-incremented if taken), running as an `asyncio` task that serves the **exact same FastAPI `app` object**.

Because it is the same `app` in the same process and event loop:
- same loaded model (no reload),
- same in-memory job registry and SSE streams,
- no restart, no dropped work.

"Disable" sets `server.should_exit = True` and awaits the task's exit → the `0.0.0.0` socket is **genuinely closed** (not merely firewalled). Default state = no share listener = nothing bound to `0.0.0.0`.

## 4. Architecture

No *new* Rust/Tauri commands are required — the feature is backend-driven and the footer/Settings UI calls backend HTTP endpoints; opening links reuses the existing `shell.open` capability. (The salvaged Windows `kill_orphan_on_port` from PR #85 remains useful for the bootstrap port-conflict path but is unrelated to this feature.)

### 4.1 Backend

**New module `backend/services/network_share.py`** — owns the share-listener lifecycle and PIN:
- `ShareState` dataclass: `enabled: bool`, `host: str`, `share_port: int | None`, `pin: str | None`, `lan_addresses: list[str]`, `started_at`.
- `enable(app, base_port) -> ShareState`: pick an available share port (`base_port+1`, try a small range), generate a 6-digit PIN (`secrets.randbelow`), build a `uvicorn.Config(app, host="0.0.0.0", port=share_port)` + `uvicorn.Server`, launch `asyncio.create_task(server.serve())`, await `server.started`, store the server/task/state on `app.state.network_share`.
- `disable() -> ShareState`: signal `should_exit`, await task, clear state.
- `get_state() -> ShareState`.
- `lan_ipv4_addresses() -> list[str]`: enumerate via `psutil.net_if_addrs()`, keep `AF_INET`, drop loopback/link-local (`127.`, `169.254.`). (psutil already pinned — no new backend dep.)

**Control endpoints (`backend/api/routers/system.py`)** — the `system` router is **already loopback-gated** by `Depends(require_loopback)` (confirmed in the #157 security review: it checks the real, non-spoofable `request.client.host`). New endpoints added under this router inherit it — so a LAN client (even via the share listener) can never enable exposure, read the PIN, or reach `/system/set-env` (which can set executable paths). No new guard needed; reuse the existing dependency:
- `POST /system/network/enable` → `network_share.enable(...)` → returns sanitized `ShareState` (incl. `pin`, `lan_addresses`, `share_port`).
- `POST /system/network/disable` → returns `ShareState`.
- `GET /system/network/state` → current `ShareState` (incl. `pin` only because caller is loopback).

**`/system/info` additions:** `share_enabled`, `share_port`, `lan_addresses`, `pin_required`, and `access_pin` — `access_pin` is included **only when `request.client.host` is loopback** (the desktop app sees it; remote devices never receive it from the API).

**Auth middleware `NetworkAccessMiddleware` (`backend/main.py`):**
- **Active only when a PIN is set** (`app.state.network_share.pin`). When no PIN is set (default, and the docker-compose `0.0.0.0` deploy path), the middleware is a pass-through → **full backward compatibility**, no regression to server deployments.
- When active:
  - **Loopback clients always bypass** (`127.0.0.1`, `::1`). This includes Tailscale-`serve`-proxied requests, which arrive from loopback — so the Tailscale path correctly needs no PIN.
  - **SPA shell always served** without PIN so the gate UI can load: `GET /`, `/assets/*`, `/favicon*`, `/index.html`, and the `/health` healthcheck.
  - **All other routes from non-loopback clients require the PIN**, accepted via `X-VoiceStudio-Pin` header, `?pin=` query, or `ov_pin` cookie. A valid PIN response sets the `ov_pin` cookie so subsequent media/SSE/`<audio>`/`<img>` GETs (which can't send custom headers) authenticate automatically. Invalid/absent → `401`.

### 4.2 Tailscale (`backend/services/tailscale.py` + endpoints)

- `status() -> {installed, running, magic_dns_name, tailnet_ips}` — shell out to `tailscale status --json` (and `tailscale version`); all calls wrapped so a missing CLI degrades gracefully to `installed: false`.
- `serve_enable(port) -> {url}` — `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (proxies the **primary loopback** backend; no LAN listener and no model restart needed). Parse/return the `https://<machine>.<tailnet>.ts.net` URL.
- `serve_disable()` — `tailscale serve reset` (or targeted `--https=443 off`).
- Endpoints (loopback-only): `GET /system/tailscale/status`, `POST /system/tailscale/enable`, `POST /system/tailscale/disable`.

### 4.3 Frontend

- **`frontend/src/components/NetworkToggle.jsx`** (mounted in `LogsFooter.jsx`): a pill showing the current state (`● Local` / `● Network`) and a toggle.
  - Local→Network: confirm dialog ("Other devices on your network will be able to reach VoiceStudio with the access PIN"), then `POST /system/network/enable`; a "switching…" state covers the call.
  - Network→Local: immediate (going safer), `POST /system/network/disable`.
  - Expandable panel when enabled: **every LAN address** with per-row **copy** + **open-in-browser**, a **QR** encoding `http://<ip>:<share_port>/?pin=<pin>`, and the **PIN** shown for manual entry.
  - **Visibility:** the toggle is shown when the backend is loopback-bound (the desktop app and local runs — `/system/info.bind_host == 127.0.0.1`). In a server deployment where the operator already bound the backend to `0.0.0.0` (`OMNIVOICE_BIND_HOST=0.0.0.0`), the toggle is hidden because exposure is already the operator's concern. The default Local behavior remains identical on every platform.
- **Settings → "Sharing & Remote Access" panel** (`frontend/src/components/settings/SharingPanel.jsx`): the full surface — the LAN toggle (mirrors the footer), plus the **Tailscale** section (status, enable/disable, the `*.ts.net` URL with copy/open/QR, and an install link when the CLI is absent).
- **Remote PIN gate** (`frontend/src/components/RemoteAuthGate.jsx`): when the SPA is loaded from a non-loopback origin and an API call returns `401`, show a PIN entry screen. On mount, read `?pin=` from the URL (populated by the QR) to auto-authenticate. The PIN is held in `sessionStorage` and attached by the api client.
- **API client header injection:** the shared fetch wrapper (`frontend/src/api/client.*`) attaches `X-VoiceStudio-Pin` from `sessionStorage` when present. Loopback (the desktop app) never sets it and never needs it.

## 5. Data flow

**Enable LAN share (desktop):** footer toggle → confirm → `POST /system/network/enable` (loopback) → backend starts `0.0.0.0:P+1` listener (same app), generates PIN → returns `{share_port, pin, lan_addresses}` → panel renders addresses + QR(`http://<ip>:<P+1>/?pin=<pin>`) + PIN.

**Remote device:** scans QR → loads SPA from `http://<ip>:<P+1>/?pin=<pin>` (SPA shell served PIN-free) → SPA reads `?pin=`, stores it, sends `X-VoiceStudio-Pin` (and gets `ov_pin` cookie) → middleware validates against the same running backend → user sees the **same projects, voices, jobs, loaded model**.

**Tailscale:** Settings → enable → `POST /system/tailscale/enable` → `tailscale serve` proxies `127.0.0.1:P` → returns `https://<machine>.<tailnet>.ts.net` → user opens it from any tailnet device; requests arrive at the backend from loopback (via Tailscale's proxy) → PIN bypassed → identity enforced by Tailscale.

**Disable:** footer/Settings → `POST .../disable` → listener stops / `tailscale serve reset` → `0.0.0.0` closed; running model and jobs unaffected throughout.

## 6. Security model

- **Default is loopback-only, every launch.** Nothing is bound to `0.0.0.0` until the user explicitly enables it; no persisted auto-exposure.
- **Control endpoints are loopback-only** via the existing `require_loopback` dependency on the `system` router (non-spoofable `request.client.host`, confirmed in the #157 security review) — a LAN client cannot enable sharing, read the PIN, or reach `/system/set-env` (which can set executable paths → would be RCE if exposed).
- **`access_pin` is returned by the API only to loopback callers.**
- **PIN gating is client-IP based:** loopback (incl. Tailscale-proxied) trusted; direct LAN requires PIN. Enforcement is inert unless a PIN is set → docker `0.0.0.0` deploys are unaffected (backward compatible).
- **Tailscale path needs no open port and no PIN** — it proxies loopback and relies on tailnet identity + TLS.
- The PIN is a session secret regenerated on each enable; it never persists to disk.

## 7. Error handling

- **Share enable fails** (no free port / bind error): return the error, stay Local, toast in the UI; never leave a half-open state.
- **No LAN address found** (offline/no NIC): enable still succeeds but the panel shows "No reachable network interface — connect to Wi-Fi/Ethernet"; QR omitted.
- **Tailscale CLI missing / not logged in:** Settings shows "Tailscale not detected" with an install/login link; enable is disabled.
- **`tailscale serve` failure:** surface stderr to the user; leave LAN sharing independent (the two paths don't depend on each other).
- **Disable is idempotent** and always safe (no-op if already off).

## 8. Testing

- **Backend (`tests/`):**
  - `network_share`: enable picks a free port and starts a listener; `get_state` reflects it; disable closes it; PIN is 6 digits; `lan_ipv4_addresses` filters loopback/link-local (mock `psutil.net_if_addrs`).
  - Middleware: pass-through when no PIN set; loopback bypass; non-loopback + no PIN → 401; non-loopback + valid PIN (header/query/cookie) → 200 and sets cookie; SPA shell + `/health` open; `access_pin` present only for loopback callers.
  - Control endpoints reject non-loopback callers with 403.
  - Tailscale module: parse `tailscale status --json` fixtures; graceful `installed:false` when CLI absent (mock subprocess).
- **Frontend (Vitest):** `NetworkToggle` defaults to Local; disabled outside desktop context; panel renders addresses + QR + PIN when enabled; `RemoteAuthGate` shows on 401 and auto-fills from `?pin=`; api client attaches `X-VoiceStudio-Pin` only when set.

## 9. Dependencies

- **Backend:** none new (`psutil`, `uvicorn`, `secrets` already present; `tailscale` is an external CLI invoked via subprocess, optional).
- **Frontend:** one small QR library (`qrcode`), used by both the footer panel and the Tailscale URL display.

## 10. Cross-platform parity

- The **default (Local)** behavior is byte-for-byte identical on macOS / Windows / Linux — the strict default-parity rule is satisfied because exposure is **explicit opt-in** (footer toggle / Settings).
- LAN sharing is pure Python/asyncio + psutil → identical across platforms.
- Tailscale uses the same `tailscale` CLI on all three OSes and degrades gracefully where it isn't installed (platform-agnostic absence handling, not platform-divergent behavior).

## 11. Implementation order (for the plan)

1. Backend `network_share` module + control endpoints + `/system/info` fields (+ tests).
2. `NetworkAccessMiddleware` + PIN cookie + SPA-shell allowlist (+ tests).
3. Frontend api-client PIN header + `RemoteAuthGate` (+ tests).
4. `NetworkToggle` footer component + panel + QR (+ tests).
5. Tailscale module + endpoints (+ tests).
6. Settings `SharingPanel` (LAN mirror + Tailscale) (+ tests).
7. Docs: a "Sharing & remote access" page (LAN PIN/QR + Tailscale), and a comment on PR #125 explaining this supersedes the default-flip.
