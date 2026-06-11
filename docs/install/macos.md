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

Pick the DMG that matches your Mac (check **Apple menu → About This Mac → Chip/Processor**):

| Mac | DMG to download |
|-----|-----------------|
| Apple Silicon (M1/M2/M3/M4…) | `OmniVoice.Studio_<version>_aarch64.dmg` |
| Intel | `OmniVoice.Studio_<version>_x64.dmg` |

The architectures are **not** interchangeable: an Intel Mac cannot run the
`aarch64` build (Rosetta 2 only translates the other direction — it lets Apple
Silicon run Intel apps, never the reverse). If a release predates the Intel
build target and has no `x64` DMG, use the
[install-from-source path](#install-from-source) above instead.

If the first launch is blocked by macOS Gatekeeper ("OmniVoice Studio cannot be
opened because the developer cannot be verified"), see the next section — it
opens with one right-click, no Terminal.

## App is "damaged" / can't be opened (Gatekeeper)

<a id="gatekeeper-quarantine"></a>

On first launch you'll see **"OmniVoice Studio cannot be opened because the
developer cannot be verified"** — macOS Gatekeeper blocking an app it can't trace
to a paid Apple Developer account (issues #134, #72).

**Why:** the build is **ad-hoc code-signed** (a valid signature, free) but not
yet **notarised** by Apple, so macOS quarantines any copy downloaded from the
internet and asks you to confirm the first launch. This is expected for
open-source builds — releases are notarised (warning-free) only once the
project's Apple Developer ID pipeline is funded (see "For maintainers" below).
Confirming is **safe** because you downloaded from the official repo / Releases
page; for belt-and-braces, verify the SHA-256 against the `*.dmg.sha256` checksum
on the release page first.

**Fix — GUI, no Terminal (do this):** in Finder, **right-click** (or
Control-click) **OmniVoice Studio.app** → **Open** → click **Open** again in the
dialog. (On macOS 15 Sequoia: double-click once, then go to **System Settings →
Privacy & Security**, scroll down, and click **"Open Anyway"**.) This is a
one-time confirmation per install; afterwards it launches by double-click.

> If you instead see the harsher **"app is damaged and can't be opened. Move to
> Trash"** with no Open option, the download was corrupted or it's a pre-signing
> build — re-download the latest release, or use the Terminal fallback below.

**Fix — Terminal:** after dragging the app into `/Applications`, run:

```bash
xattr -dr com.apple.quarantine "/Applications/OmniVoice Studio.app"
```

(Adjust the path if you put the app somewhere other than `/Applications`. The
broader `xattr -cr "/Applications/OmniVoice Studio.app"` also works — it clears
*all* extended attributes rather than just the quarantine flag.)

That clears the quarantine attribute so Gatekeeper stops blocking the launch — a
one-time fix per install.

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
