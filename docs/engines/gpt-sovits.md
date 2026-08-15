# VoiceStudio — GPT-SoVITS Engine

GPT-SoVITS (RVC-Boss) is one of the most popular open-source voice-cloning
systems (57k+ GitHub stars, MIT-licensed). It does zero-shot and few-shot
cloning with excellent naturalness in Chinese, English, Japanese, Cantonese,
and Korean, and it is very fast (RTF ~0.014 on suitable hardware).

Unlike VoiceStudio's other engines, GPT-SoVITS does not run inside the app.
It ships as a standalone API server, and VoiceStudio connects to it over
HTTP.

## When to pick it

- You already run (or want to run) a GPT-SoVITS server, e.g. with few-shot
  fine-tuned voices.
- You need fast, natural cloning in zh/en/ja/yue/ko.

## Setup

1. Install and start the GPT-SoVITS API server (upstream project):

   ```bash
   cd GPT-SoVITS
   python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
   ```

2. Select the engine via **Model Catalogue → Engines** or
   `OMNIVOICE_TTS_BACKEND=gpt-sovits`.

VoiceStudio marks the engine available only when the server responds
(2-second reachability probe).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMNIVOICE_GPTSOVITS_URL` | `http://127.0.0.1:9880` | API server URL |
| `OMNIVOICE_TRUSTED_NETWORKS` | (unset) | Required to allow a non-loopback server |

**Remote servers:** by default VoiceStudio only talks to loopback addresses
— part of the local-first guarantee. To point at a server on another
machine (e.g. a GPU box on your LAN), add its network to
`OMNIVOICE_TRUSTED_NETWORKS`; otherwise the connection is refused as an
untrusted endpoint.

Prefer `https://` (or a private tunnel such as Tailscale/WireGuard) for any
non-loopback server: with plain `http://` the text you synthesize and the
audio that comes back cross the network unencrypted. VoiceStudio does not
disable certificate verification, so a TLS endpoint needs a certificate the
system trusts.

## Behaviour notes

- Output is 32 kHz mono (server output is resampled if needed).
- Cloning passes your reference clip path and optional transcript to the
  server; the reference path must be readable **by the server process**, so
  remote servers need the clip on their own filesystem.
- Speed control is forwarded as the server's `speed_factor`.
- The GPU is whatever the GPT-SoVITS server itself uses (CUDA preferred);
  VoiceStudio's side is just an HTTP client.

## Known limits

- Five languages only; for broader coverage use
  [OmniVoice](omnivoice.md) ([languages.md](../languages.md)).
- No voice design; server availability is your responsibility — if the
  server stops, generations fail with a "server not reachable" error.

## Troubleshooting

- "GPT-SoVITS server not reachable": start the server with the command
  above, or fix `OMNIVOICE_GPTSOVITS_URL`.
- "endpoint is outside loopback or OMNIVOICE_TRUSTED_NETWORKS": see
  Configuration above.
- Other issues: [install/troubleshooting.md](../install/troubleshooting.md).

See also: [benchmarks.md](../benchmarks.md),
[expressive-speech.md](../expressive-speech.md).
