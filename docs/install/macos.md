# OmniVoice Studio — Install on macOS

This page is self-contained: follow it top to bottom and you'll end up with a
working OmniVoice Studio install on macOS (Apple Silicon or Intel).

## Prerequisites

- **macOS 12 (Monterey) or newer** — Apple Silicon or Intel.
- **Python 3.11+** — `brew install python@3.11` (or use `pyenv` / the system Python if you already have ≥3.11).
- **Bun** — `curl -fsSL https://bun.sh/install | bash`.
- **Xcode Command Line Tools** — `xcode-select --install`.
- **FFmpeg** (used by the dubbing + capture pipelines) — `brew install ffmpeg`.

Optional but recommended:

- **A Hugging Face account** for diarization and the larger TTS models. See
  [docs/setup/huggingface-token.md](../setup/huggingface-token.md).

## Install (from source)

```bash
git clone https://github.com/debpalash/OmniVoice-Studio.git
cd OmniVoice-Studio
bun install
bun run desktop-prod
```

The first launch builds the Tauri shell, creates the Python venv via `uv`,
syncs deps, and downloads model weights (~2.4 GB). The splash screen shows
live progress for every step.

## Install (pre-built `.app`)

Download the latest DMG from the
[Releases page](https://github.com/debpalash/OmniVoice-Studio/releases/latest),
double-click to mount, drag **OmniVoice Studio.app** into `/Applications`.

If the first launch shows "app is damaged and can't be opened", that's macOS
Gatekeeper — see the next section.

## Gatekeeper quarantine

<a id="gatekeeper-quarantine"></a>

OmniVoice Studio is currently **not notarised** — the developer-ID signing +
notarisation pipeline is tracked for v0.4. Until then, macOS quarantines any
copy you downloaded outside the App Store. After dragging the app into
`/Applications`, run:

```bash
xattr -cr "/Applications/OmniVoice Studio.app"
```

That clears the quarantine xattr so Gatekeeper stops blocking the launch. It's
a one-time fix per install. The app itself is open source — verify the SHA-256
against the `*.dmg.sha256` checksum on the release page before clearing the
attribute if you want belt-and-braces.

## Apple Silicon vs Intel

- **Apple Silicon (M-series):** OmniVoice automatically picks the `mlx-whisper`
  and `mlx-audio` backends where available — these use the Apple Neural Engine
  and Metal Performance Shaders for ~2× the throughput of the CPU path.
- **Intel macs:** falls back to `faster-whisper` (CTranslate2) on CPU. Still
  fast; just no ANE acceleration.

The picker in **Settings → Engines** shows which backend is active.

## Hugging Face token (optional but recommended)

The default install works without a token, but diarization (the
`pyannote/speaker-diarization-3.1` model) is gated and the larger
voice-design engines also download faster with a token attached.

- Open **Settings → API Keys** in the app.
- Or set the env var `export HF_TOKEN=hf_…` in `~/.zshrc`.

Full details: [docs/setup/huggingface-token.md](../setup/huggingface-token.md).

## Troubleshooting

Hit a wall? See [docs/install/troubleshooting.md](troubleshooting.md).

The in-app error UI (the React error boundary that fires on backend errors)
includes an **"Open docs for this error"** button — that button deeplinks
back into this docs tree at the right section for the error class.
