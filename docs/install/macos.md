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

If you see **"OmniVoice Studio.app" is damaged and can't be opened. You should
move it to the Trash**, the app is **not** damaged — that misleading message is
macOS Gatekeeper blocking an app it can't verify (issues #134, #72).

**Why:** releases are only notarised when the project's Apple Developer ID
signing pipeline is configured (see "For maintainers" below). On an unsigned
build, macOS quarantines any copy downloaded outside the App Store.

**Fix (unsigned builds):** after dragging the app into `/Applications`, run:

```bash
xattr -cr "/Applications/OmniVoice Studio.app"
```

That clears the quarantine xattr so Gatekeeper stops blocking the launch — a
one-time fix per install. Alternatively, right-click the app → **Open** →
**Open** in the dialog. The app is open source; verify the SHA-256 against the
`*.dmg.sha256` checksum on the release page first if you want belt-and-braces.

### For maintainers — enabling notarised builds

The release workflow (`.github/workflows/release.yml`) is already wired to
code-sign + notarise the macOS bundle; it activates automatically once these
repository **secrets** are set (it skips signing — producing today's unsigned
build — when they're absent):

| Secret | What |
|--------|------|
| `APPLE_CERTIFICATE` | Developer ID Application cert, exported as a base64-encoded `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarisation |
| `APPLE_PASSWORD` | an **app-specific password** for that Apple ID |
| `APPLE_TEAM_ID` | your 10-char Apple Developer Team ID |

Requires a paid Apple Developer account ($99/yr). Once set, downloaded DMGs open
without the quarantine step.

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
