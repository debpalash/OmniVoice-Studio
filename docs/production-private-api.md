# Production private API service

For a private application backend calling VoiceStudio, run the versioned Docker
image as an internal service. Do not expose port 3900 directly to the public
internet.

## Recommended baseline

```yaml
services:
  voicestudio:
    image: ghcr.io/debpalash/omnivoice-studio:0.5.1
    restart: unless-stopped
    environment:
      OMNIVOICE_API_KEY: ${OMNIVOICE_API_KEY:?set a long random key}
    ports:
      - "127.0.0.1:3900:3900"
    volumes:
      - voicestudio-data:/app/omnivoice_data
      - voicestudio-models:/root/.cache/huggingface
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3900/health"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 120s

volumes:
  voicestudio-data:
  voicestudio-models:
```

Generate `OMNIVOICE_API_KEY` with a password manager or
`python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`. Keep it in the
deployment platform's secret store, not in the Compose file or source control.
Send it from InterviewAce as `Authorization: Bearer <key>`.

Pin an exact release tag. `:latest` and `:main` are rolling previews;
`:stable` moves whenever a stable release is published. AMD hosts use the
matching `:0.5.1-rocm` image and the device mapping documented in
[Docker installation](install/docker.md#pull-and-run-amd-gpu--rocm).

## Network boundary

Prefer a private container network with no published VoiceStudio port when the
calling backend runs in the same Compose or Kubernetes deployment. Otherwise,
bind to `127.0.0.1` and put a TLS reverse proxy or private overlay network in
front of it. The six-digit share PIN is intended for casual LAN access; use the
API key for an application service.

If a reverse proxy is used:

- forward the `Authorization` header;
- disable response buffering for streaming generation;
- set its read timeout above VoiceStudio's generation timeout;
- preserve the client address only through a trusted proxy configuration;
- set `OMNIVOICE_ALLOWED_ORIGINS` only when a browser on another origin must
  call VoiceStudio directly.

InterviewAce's browser should normally call the InterviewAce backend, which
then calls VoiceStudio. This keeps the VoiceStudio credential and API surface
out of the customer browser.

## Operations

- Persist both `/app/omnivoice_data` and the Hugging Face cache. Back up the
  data volume; treat the model cache as replaceable unless download time is
  operationally significant.
- Warm and validate the selected engines after deployment before admitting
  traffic. `/engines` reports availability and the resolved execution device;
  `/health` proves service readiness.
- Keep request concurrency bounded. A capacity response is a backpressure
  signal; honor `Retry-After` instead of starting parallel retries.
- Drain callers, recreate the container with a newly pinned tag, run the engine
  checks, then restore traffic. Do not update model/runtime dependencies inside
  a running production container.
- For a failed benchmark or production request, capture `/system/info`, the
  selected `/engines` entry, response routing headers, container logs, and a
  diagnostic bundle before restarting.

The API key also authorizes server-mode administration. Use a separate
VoiceStudio instance or network policy if the calling application should have
consumption access without administrative access; the current API key is a
root credential, not a per-route service token. Full credential, session,
WebSocket, trusted-network, admin-route, and CORS behavior is in
[API authentication](api-auth.md).

## Engine and model obligations

Deploying VoiceStudio does not settle the licenses of optional engines or model
weights. Record the exact engine, model revision, and accepted terms alongside
the deployment, and review generated-output restrictions for that combination.
See [Engine licences](engines/index.md) before enabling an engine.
