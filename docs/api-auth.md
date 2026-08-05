# Authenticating the local API

OmniVoice's backend is **loopback-only and unauthenticated by default** — a
script running on the same machine as `http://localhost:3900` needs no key, no
PIN, no header. Everything on this page only matters once you reach the backend
from **another device** (a phone on your LAN, a laptop over Tailscale, a client
behind a reverse proxy).

There are two independent gates, both **inert until you turn them on**, plus one
env var that exempts trusted callers:

| Gate | Turn on with | Guards | Applies to |
|---|---|---|---|
| **Share PIN** | the in-app Network share toggle | casual LAN-share guests, one session | non-loopback **HTTP** |
| **API key** | `OMNIVOICE_API_KEY` env var on the backend | a durable remote credential | non-loopback **HTTP + WebSocket** |
| **Trusted networks** | `OMNIVOICE_TRUSTED_NETWORKS` env var | *exempts* the two gates above | non-loopback **consumption** routes only |

Loopback traffic (`127.0.0.1`, `::1`, `localhost`) is **never** gated — local
tools keep working unchanged whichever gate is set.

> OmniVoice separates **consumption** (TTS, dictation, voices) from
> **administration** (`/system/*`, `/api/settings/*` — RCE-class). The PIN and
> trusted networks are *consumption* credentials; the **admin surface is only
> ever reached from loopback or with the API key** (see [Admin routes](#admin-routes-and-server-mode)).

> Both gates can be active at once. The PIN and the API key are independent; when
> both are set, each is checked on the paths it covers.

---

## Share PIN

The PIN is the lightweight, in-app path: flip on **Network** sharing (footer
**Local** pill → **Network**, or **Settings → Sharing & Remote Access**) and the
app generates a fresh **6-digit PIN** for that session. It is regenerated every
time you enable sharing and is **never written to disk**. See
[docs/sharing.md](sharing.md) for the UI walkthrough.

While a PIN is set, every **non-loopback HTTP request** to an API route must
present it. Supply it any one of three ways:

| Where | How |
|---|---|
| Header | `X-OmniVoice-Pin: <pin>` |
| Query param | `?pin=<pin>` |
| Cookie | `ov_pin=<pin>` — the backend sets this automatically after the first valid PIN, so browser sessions only prove it once |

```bash
# From another device on the LAN — with the PIN
curl http://<host>:3900/v1/audio/voices \
  -H "X-OmniVoice-Pin: 123456"
```

A missing or wrong PIN returns:

```
HTTP/1.1 401 Unauthorized
{"detail": "PIN required"}
```

Notes on the PIN gate (`NetworkAccessMiddleware`, `backend/main.py`):

- It covers **HTTP only** — it does **not** gate WebSockets. The dictation
  WebSocket has its own guard (see below), and the PIN does **not** authorize
  it; use the API key or a trusted network for remote dictation.
- The SPA shell (`/`, `/index.html`, `/favicon*`, `/assets/*`, `/health`) is
  always served un-PIN'd so the PIN-prompt UI can load.
- It is a **consumption** credential: a valid PIN never unlocks the admin surface
  (it is 6 digits, brute-forceable). Admin needs loopback or the API key.
- It is completely inert when no PIN is set (the default, and every Docker
  deploy).

---

## API key

The API key is the durable credential for running the backend somewhere and
driving it remotely — a GPU box on your tailnet, a Docker container, a
reverse-proxied host. Set it on the **backend** process:

```bash
# Generate a strong key and start the backend with it
export OMNIVOICE_API_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(24))')"
uv run uvicorn backend.main:app --host 0.0.0.0 --port 3900
# Docker: pass -e OMNIVOICE_API_KEY=…
```

While `OMNIVOICE_API_KEY` is set, every **non-loopback HTTP and WebSocket**
request must present it (the SPA shell paths below are the only HTTP exception).
Supply it any one of three ways:

| Where | How |
|---|---|
| Header | `Authorization: Bearer <key>` — **preferred**; the one place a key isn't at risk of landing in a log |
| Cookie | `ov_key=<key>` — set automatically after the first authenticated HTTP request; the safer fallback for browser WebSockets |
| Query param | `?api_key=<key>` — last resort (browser WebSockets can't set headers). **A key in a URL leaks into proxy/access logs and browser history** — prefer the header or cookie |

```bash
# Prefer an encrypted transport (Tailscale Serve / TLS) for a real key; plain
# http:// on an untrusted network exposes the Bearer token on the wire.
curl https://gpu-box:3900/v1/audio/speech \
  -H "Authorization: Bearer $OMNIVOICE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-1","voice":"alloy","input":"Hello from a keyed backend.","response_format":"wav"}' \
  --output speech.wav
```

```python
# The OpenAI SDK sends the key as a Bearer token automatically
from openai import OpenAI

client = OpenAI(
    base_url="https://gpu-box:3900/v1",
    api_key="<your OMNIVOICE_API_KEY>",   # must match OMNIVOICE_API_KEY on the backend
)                                          # (any string works ONLY when no key is set — the loopback default)
audio = client.audio.speech.create(
    model="tts-1", voice="alloy", input="Hello from a keyed backend.",
)
audio.stream_to_file("speech.wav")
```

A missing or wrong key returns:

```
HTTP/1.1 401 Unauthorized
{"detail": "API key required"}
```

On a **WebSocket**, a missing or wrong key rejects the handshake with close
code **1008** (policy violation) instead of a JSON body.

Notes on the API-key gate (`BearerKeyMiddleware`, `backend/main.py`):

- The key is compared in **constant time** and is **never logged**.
- The SPA shell paths bypass the gate on **HTTP** so a remote UI can load and
  show what's wrong; WebSockets have no such exemption.
- **Plain HTTP is sniffable** — a Bearer key over `http://` on a hostile
  network can be read off the wire. Use Tailscale (WireGuard) or TLS for
  anything beyond a fully trusted LAN. See
  [docs/remote-gpu.md](remote-gpu.md) for the full remote-backend setup.

---

## Dictation WebSocket

The live-dictation stream at **`ws://<host>:3900/ws/transcribe`** carries its
own inline guard (`backend/api/routers/capture_ws.py`) *in addition to* the
API-key middleware. A non-loopback client reaches it only if it is **either**:

- on a [trusted network](#trusted-networks) (`is_local_host` passes), **or**
- presenting the **API key** — as `Authorization: Bearer <key>`, the `ov_key`
  cookie, or `?api_key=<key>` (URL keys leak into logs — prefer the cookie).

```
ws://gpu-box:3900/ws/transcribe?api_key=<key>
```

The **share PIN does not authorize dictation** — the PIN gate is HTTP-only, and
the dictation guard checks only the API key (or trusted-network membership). A
LAN guest who has only entered a PIN can use the HTTP API but **not** live
dictation. When neither the API key nor a trusted network applies, the handshake
is closed with code **1008** and reason `loopback origin required`.

---

## Trusted networks

`OMNIVOICE_TRUSTED_NETWORKS` is a comma-separated list of **CIDR ranges** whose
clients are treated as loopback-trusted by the **consumption** gates — so a
reverse proxy or a trusted LAN/Tailnet can reach the API **without a PIN or key**
(useful when a proxy strips the `Authorization` header).

```bash
export OMNIVOICE_TRUSTED_NETWORKS="192.168.1.0/24,10.0.0.0/8"
```

What it exempts vs. what it does not:

- **Exempts** (via `is_local_host`, `backend/api/dependencies.py`): the share
  PIN gate, the API-key gate, and the dictation WebSocket guard. Clients in a
  listed range need no PIN or key for these **consumption** routes.
- **Never exempts admin.** `/system/*` and `/api/settings/*` are the RCE-class
  admin surface; trusted-network membership is a *consumption* exemption and
  does not reach them — even under `OMNIVOICE_SERVER_MODE=1`. See
  [Admin routes](#admin-routes-and-server-mode).

Details: malformed CIDR entries are silently ignored (a bad entry never wedges
the gate); IPv4-mapped IPv6 addresses (`::ffff:192.168.1.5`) from dual-stack
proxies are unwrapped so they match IPv4 CIDRs; the value is read at request
time, so in production **restart the backend** to apply a change. Default empty
— no change to the strict loopback default.

---

## Admin routes and server mode

Admin routes — `/system/*` (including `set-env`, **RCE-class**),
`/api/settings/*`, engine install/uninstall, media tools, MCP bindings — sit on
a stricter gate (`require_loopback`, `backend/api/dependencies.py`) than
consumption. On the desktop build they are **true-loopback-only**: no PIN, key,
or trusted network reaches them from another machine.

In **server mode** (`OMNIVOICE_SERVER_MODE=1`, the Docker image) the loopback
origin is unenforceable — NAT rewrites the source and even a
`-p 127.0.0.1:3900:3900` mapping looks non-loopback — so the true-loopback
requirement is dropped (issue #261, else the operator is 403'd out of their own
`/system/*`). It is replaced by a **credential rule**, not removed:

- **No credential configured** (no API key, no PIN) → admin is open. The bare
  Docker flow; exposure rests entirely on your port mapping / firewall.
- **A credential is configured** → admin requires the **API key** (`Authorization:
  Bearer` / `?api_key` / `ov_key` cookie), or genuine loopback. The **6-digit
  share PIN does not gate admin** (it is brute-forceable), and trusted-network
  membership never does either. So a **PIN-only** server-mode deployment keeps
  admin loopback-only; remote admin requires the long API key.

This is the fix for a real escalation (#1213): before it, server mode made the
admin gate a no-op, so with an API key set *and* a trusted CIDR configured, a LAN
client in that CIDR could `POST /system/set-env` — RCE-class — with **no
credential at all**, because the API-key middleware waved it through as
`is_local_host`. Now the admin gate is independent of the consumption exemptions.

---

## Browsers from another origin (CORS)

Everything above gates *authentication*. A **browser** frontend served from a
different origin than the backend hits a separate wall first: CORS. The
backend's allow-list defaults to loopback + Tauri origins only
(`http://localhost:<ui-port>`, `http://127.0.0.1:<ui-port>`,
`tauri://localhost`, `http://tauri.localhost`), so opening a dev/source UI via
a LAN IP (e.g. `http://192.168.1.159:3901` talking to `…:3900`) blocks every
request with *"Missing Header: Access-Control-Allow-Origin"* — regardless of
`OMNIVOICE_SERVER_MODE` or `OMNIVOICE_TRUSTED_NETWORKS`, neither of which
touches CORS (#1348).

Add the exact origin the browser shows in its address bar:

```bash
export OMNIVOICE_ALLOWED_ORIGINS="http://192.168.1.159:3901,http://localhost:3901,http://127.0.0.1:3901,tauri://localhost,http://tauri.localhost"
```

Each entry must be a bare origin — `scheme://host:port`, exactly what the
browser sends in its `Origin` header — with no path and no trailing slash
(`http://192.168.1.159:3901/` would never match). The variable **replaces**
the default list, so restate the loopback/Tauri origins alongside your own. (The in-app LAN share and Tailscale flows in
[docs/sharing.md](sharing.md) don't need this — they serve UI and API from the
same origin.) If you only moved the Vite dev server's port, set
`OMNIVOICE_UI_PORT` instead and the default list follows it.

## Status codes

| Code | Meaning | What to do |
|---|---|---|
| **401** | Consumption auth failed — `{"detail": "PIN required"}` or `{"detail": "API key required"}`. | Supply the PIN / key (header, cookie, or query param above). A WebSocket surfaces this as close code **1008**. |
| **403** | `{"detail": "loopback origin required"}` — you reached a **loopback-gated** route (admin: `/system/*`, `/api/settings/*`; or a `require_local` route from outside a trusted network) from a non-loopback origin. | A PIN won't help. Run the request from the box itself; for `require_local` routes add the caller to `OMNIVOICE_TRUSTED_NETWORKS`; for **admin** routes use `OMNIVOICE_SERVER_MODE=1` **and** present the **API key** (the PIN/trusted-network don't reach admin). |
| **429** | **Not an auth failure.** The GPU pool is saturated (admission control) or a model download is rate-limited. Ships with `Retry-After` and `X-OmniVoice-Retryable: true`. | Back off for `Retry-After` seconds and retry the identical request. |

---

## See also

- [docs/remote-gpu.md](remote-gpu.md) — end-to-end remote-backend setup over
  Tailscale, with the API key.
- [docs/sharing.md](sharing.md) — the in-app LAN share + PIN flow.
- [docs/agentic-voice.md](agentic-voice.md) — pointing OpenAI-compatible agent
  frameworks at OmniVoice.
- [docs/mcp.md](mcp.md) — the MCP server for AI agents.
