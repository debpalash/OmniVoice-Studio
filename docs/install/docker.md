# OmniVoice Studio — Install with Docker

For headless servers, dedicated GPUs, or "I want one command" deployments.
The docker image bundles the backend; the UI is served over HTTP and you open
it in a normal browser.

## Pull and run (CPU)

```bash
docker pull ghcr.io/debpalash/omnivoice-studio:latest

docker run -d --name omnivoice \
  -p 127.0.0.1:3900:3900 \
  -v omnivoice-data:/app/omnivoice_data \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  ghcr.io/debpalash/omnivoice-studio:latest
```

Open [http://localhost:3900](http://localhost:3900). The first run downloads
~2.4 GB of model weights — follow `docker logs -f omnivoice` to watch.

## Pull and run (NVIDIA GPU)

```bash
docker run -d --name omnivoice --gpus all \
  -p 127.0.0.1:3900:3900 \
  -v omnivoice-data:/app/omnivoice_data \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  ghcr.io/debpalash/omnivoice-studio:latest
```

GPU mode requires the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
on the host.

## Docker Compose (recommended)

```bash
# CPU
docker compose -f deploy/docker-compose.yml --profile cpu up -d

# NVIDIA GPU
docker compose -f deploy/docker-compose.yml --profile gpu up -d
```

The `docker-compose.yml` shipped in `deploy/` defaults to `127.0.0.1:3900`
on the host. The backend inside the container binds to `0.0.0.0` so the
host port mapping can forward — the host-side `127.0.0.1` binding is what
enforces loopback-only.

## LAN access

<a id="lan-access"></a>

To expose OmniVoice on your LAN (e.g. you're running it on a homelab box and
opening the UI from a laptop), change the host port mapping:

```yaml
# deploy/docker-compose.yml
services:
  omnivoice:
    ports:
      - "0.0.0.0:3900:3900"   # ← was 127.0.0.1:3900:3900
```

The OmniVoice frontend defaults to the **same origin** the page was served
from, so opening the UI from `http://<lan-ip>:3900` Just Works for both the
page load *and* the API/media requests it makes afterwards.

If you front the app with a **reverse proxy** and the API and UI land on
different origins, pin the API base explicitly. Use **`OMNIVOICE_PUBLIC_API_BASE`**
— a *runtime* env var the backend injects into the page, so it works with the
prebuilt image via `docker run -e` (the older `VITE_OMNIVOICE_API` is inlined at
*build* time and cannot be set on a prebuilt image):

```bash
docker run -e OMNIVOICE_PUBLIC_API_BASE=https://api.your-host.example \
  -p 0.0.0.0:3900:3900 \
  ghcr.io/debpalash/omnivoice-studio:latest
```

> `OMNIVOICE_PUBLIC_API_BASE` must be a plain `http(s)://…` URL; anything else
> is ignored and the app falls back to same-origin. If you build from source you
> may instead bake `VITE_OMNIVOICE_API` at build time, but the runtime var above
> is simpler and image-agnostic.

> **Security:** OmniVoice ships no authentication. Anything on your LAN with
> the URL can use the app. Put it behind a reverse proxy with `basic_auth`
> (Caddy / nginx + htpasswd) or a private network overlay (Tailscale, ZeroTier)
> before exposing publicly.

## Volume mounts

Two paths are worth persisting across container restarts:

| Mount | Purpose | Why |
|-------|---------|-----|
| `omnivoice_data:/app/omnivoice_data` | Project DB, user voices, settings | Survives upgrade; encrypted HF token lives here |
| `~/.cache/huggingface:/root/.cache/huggingface` | HF model cache | Re-using your host's cache saves ~2.4 GB of re-downloads |

## Troubleshooting

- **Media-preview 404 in LAN mode:** see the [LAN access](#lan-access) section
  above — the `window.location.host` fix shipped in v0.3.
- **GPU not detected:** verify `docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu22.04 nvidia-smi` succeeds first.
- More entries: [docs/install/troubleshooting.md](troubleshooting.md).
