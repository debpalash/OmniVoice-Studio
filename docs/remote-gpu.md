# Remote GPU backend

Run the VoiceStudio backend on one machine (a GPU box, a home server) and drive
it from the desktop app or a browser on another — over your tailnet, with the
inference staying on the powerful machine.

> Calling the API from your own scripts rather than the desktop app? See
> [docs/api-auth.md](api-auth.md) for a consumer-focused reference of every auth
> gate (share PIN, API key, dictation WebSocket, trusted networks) with the exact
> headers, params, and `401`/`403`/`429` meanings.

This is opt-in and off by default: with no API key set, the backend stays
loopback-only exactly as before.

## The shape

```
┌──────────────┐     tailnet (WireGuard)      ┌─────────────────────┐
│ laptop        │  ws/https to MagicDNS URL   │ gpu-box              │
│ VoiceStudio UI  │ ──────────────────────────▶ │ VoiceStudio backend    │
│ (thin client) │  Authorization: Bearer …    │ OMNIVOICE_API_KEY set │
└──────────────┘                              └─────────────────────┘
```

The desktop app *is* the thin client — there is no separate binary. You set a
**Backend URL** and an **API key** in Settings, and every request (including
the dictation and TTS WebSockets) is sent to the remote with the key attached.

## 1. On the GPU box: run the backend with a key

Generate a key and start the backend with it set:

```bash
export OMNIVOICE_API_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(24))')"
export OMNIVOICE_SERVER_MODE=1          # headless: relaxes the loopback admin gate
uv run uvicorn backend.main:app --host 0.0.0.0 --port 3900
```

The Docker image is the same idea — pass `-e OMNIVOICE_API_KEY=…`.

If a **browser** will load the UI from a different origin than the backend
(e.g. a Vite dev server on `:3901` opened via the box's LAN IP), you also need
the backend's CORS allow-list to include that origin — see
[Browsers from another origin (CORS)](api-auth.md#browsers-from-another-origin-cors);
neither server mode nor trusted networks covers CORS.

When `OMNIVOICE_API_KEY` is set, **every non-loopback HTTP and WebSocket
request must present it**, as `Authorization: Bearer <key>`, `?api_key=<key>`
(browser WebSockets can't set headers), or the `ov_key` cookie the backend
sets after the first authenticated request. Loopback traffic on the box
itself is never gated, so local tools keep working.

## 2. Reach it over Tailscale

Install [Tailscale](https://tailscale.com/) on both machines (its client is
BSD-3 open source; self-host the control plane with
[headscale](https://github.com/juanfont/headscale) if you want a fully open
stack). Then the box is reachable at its MagicDNS name:

```
http://gpu-box.your-tailnet.ts.net:3900
```

For TLS (recommended — see the warning below), put the port behind
**Tailscale Serve** on the box:

```bash
tailscale serve 3900
# now reachable at https://gpu-box.your-tailnet.ts.net
```

Serve terminates on the node and forwards from `127.0.0.1`, so to the backend
the request looks like loopback — which is why the **API key is still
required** in that path (the bearer gate doesn't rely on the source address
for non-local exposure; set the key and it always applies to keyed clients).

> **Do not use `tailscale funnel`** (public-internet exposure) for this. Even
> with a key, a voice-cloning backend should not be on the open internet.

## 3. In the app: point at the remote

Settings → Sharing → **Remote backend**:

- **Backend URL**: the MagicDNS URL from step 2 (with `:3900` if you didn't
  use Serve, or no port if you did).
- **API key**: the value of `OMNIVOICE_API_KEY` from step 1.
- **Test connection** hits `{url}/health` and shows the remote's version and
  device.
- **Save & reload** stores both in this browser/app and restarts the UI
  against the remote. The URL must be a full `http://` or `https://` URL
  (`gpu-box:3900` alone is rejected), and saving a URL that hasn't passed
  **Test connection** asks for confirmation first — a wrong base would leave
  the app unable to reach any backend until you change it back here.

Leave the URL empty to go back to the local backend.

### From a browser (no desktop app)

You can also drive the remote from a plain browser — open the URL with the key
in the **fragment** once:

```
https://gpu-box.your-tailnet.ts.net/#api_key=<key>
```

Use the fragment (`#`, not `?`) deliberately: fragments are never sent to the
server, so the key stays out of the GPU box's and any reverse proxy's request
logs. The key is stored for that browser and the fragment is scrubbed from the
address bar (so it doesn't linger in history or get re-applied on a reload). If
your key contains `+`, `&`, `#`, or `=`, URL-encode it (e.g. `#api_key=a%2Bb`);
keys from `secrets.token_urlsafe` (above) need no encoding.
Thereafter the UI loads normally with the key attached to every request. If a
request ever 401s again (wrong/rotated key), you're prompted to re-enter it. The
same gate shows a LAN-share **PIN** prompt instead when network sharing — not a
remote key — is what's gating access.

## Security notes

- **Plain HTTP is sniffable.** A bearer key over `http://` on a hostile
  network can be read off the wire. Use Tailscale (WireGuard-encrypted) or
  Tailscale Serve (TLS) for anything beyond a fully trusted LAN.
- The API key and the LAN-share **PIN** are independent: the PIN guards a
  casual share session, the key is the durable remote credential. Either can
  be active; both are checked when set.
- Admin routes (`/system/*`, `/api/settings/*`) stay loopback-gated unless
  `OMNIVOICE_SERVER_MODE=1` is set on the box; in server mode the **API key** is
  the access control for those too (the short share PIN is consumption-only and
  does not gate admin) — see the credential rule below.
- **Trust a LAN or reverse proxy with `OMNIVOICE_TRUSTED_NETWORKS`.** If you run
  VoiceStudio behind a reverse proxy (nginx, Caddy, NPM) or only expose it on a
  trusted LAN/Tailnet, set `OMNIVOICE_TRUSTED_NETWORKS` to a comma-separated list
  of CIDRs (e.g. `192.168.1.0/24,10.0.0.0/8`); clients from those networks are
  then treated as trusted by the **consumption** gates (share PIN, API key,
  dictation WebSocket) and need no key/PIN. **Admin routes** (`/system/*`,
  `/api/settings/*`) stay true-loopback-only — use `OMNIVOICE_SERVER_MODE=1` for
  headless admin. It's the granular alternative to
  `OMNIVOICE_SERVER_MODE=1` (which trusts *all* non-loopback sources) and
  sidesteps a proxy that strips the `Authorization` header. Default empty — no
  change to the strict loopback default. **Trusted-network membership is a
  *consumption* exemption only — it never unlocks admin by itself, even in
  server mode (#1213).** When combined with `OMNIVOICE_SERVER_MODE=1`, a
  trusted-network client that presents no credential still gets `403` on the
  admin routes (unless no credential is configured at all, the bare-Docker #261
  flow, where admin is open); if a credential is set, only the **API key** — not
  the share PIN — reaches admin. See [`api-auth.md`](api-auth.md) for the full
  two-tier model.
- The key is compared in constant time and never logged.
