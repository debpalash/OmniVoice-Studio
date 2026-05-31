# OmniVoice Studio — Install on Linux

This page is self-contained: follow it top to bottom and you'll end up with a
working OmniVoice Studio install on a Debian / Ubuntu / Fedora / Arch host.

## Prerequisites

- **Linux x86_64** with a desktop session (X11 or Wayland) capable of running
  a Tauri / WebKitGTK app.
- **Python 3.11+** — typically `sudo apt install python3.11` on Debian/Ubuntu,
  `sudo dnf install python3.11` on Fedora, or already installed on Arch.
- **Bun** — `curl -fsSL https://bun.sh/install | bash`.
- **FFmpeg** — `sudo apt install ffmpeg` (Debian/Ubuntu), `sudo dnf install ffmpeg-free` (Fedora), or `sudo pacman -S ffmpeg` (Arch).
- **GTK/WebKit deps** for the Tauri shell:

  ```bash
  # Debian / Ubuntu
  sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev build-essential

  # Fedora
  sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel

  # Arch
  sudo pacman -S --needed base-devel webkit2gtk-4.1 libayatana-appindicator librsvg openssl xdotool
  ```

- Optional: a **Hugging Face token** for diarization + the larger TTS engines
  (see [docs/setup/huggingface-token.md](../setup/huggingface-token.md)).

## Install (from source)

```bash
git clone https://github.com/debpalash/OmniVoice-Studio.git
cd OmniVoice-Studio
bun install
bun run desktop-prod
```

The first launch creates the Python venv via `uv`, syncs deps, and downloads
model weights (~2.4 GB). Subsequent launches start in seconds.

## Install (AppImage)

Download the latest AppImage from the
[Releases page](https://github.com/debpalash/OmniVoice-Studio/releases/latest),
make it executable, and run:

```bash
chmod +x OmniVoice.Studio_*.AppImage
./OmniVoice.Studio_*.AppImage
```

No FUSE? Use `--appimage-extract-and-run`:

```bash
./OmniVoice.Studio_*.AppImage --appimage-extract-and-run
```

## Install (.deb)

```bash
sudo apt install ./OmniVoice.Studio_*.amd64.deb
omnivoice-studio
```

The desktop app uses these canonical paths (kept in sync with
`scripts/desktop-prod.sh` by the docs-drift CI gate):

<!-- validate -->
```bash
APP_ID="com.debpalash.omnivoice-studio"
APP_NAME="OmniVoice Studio"
```

## AppImage white-screen on Fedora 44 / Ubuntu 24.04

<a id="appimage-white-screen-on-fedora-44--ubuntu-2404"></a>

Newer distros ship WebKitGTK 2.44 / 2.46, which has a compositing-mode
regression that lands the Tauri window as a fully-white frame with no UI.

**Workaround:** set `WEBKIT_DISABLE_COMPOSITING_MODE=1` before launching:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ./OmniVoice.Studio_*.AppImage
```

OmniVoice's AppRun launcher autodetects the broken WebKitGTK range and sets
this for you (shipped in v0.3+). The manual env-var path remains the documented
fallback when running from a checked-out source tree.

Tracking issue: [#62](https://github.com/debpalash/OmniVoice-Studio/issues/62).

## .deb ffprobe conflict

<a id="deb-ffprobe-conflict"></a>

Pre-v0.3 `.deb` packages installed `ffprobe` into `/usr/bin/ffprobe` and
clobbered the system copy on some distros. v0.3+ relocates the bundled
binary into `/usr/lib/omnivoice-studio/bin/ffprobe` and the `postrm` script
runs `dpkg --search` to undo the old conflict on upgrade. If you upgraded
from a pre-v0.3 .deb and `ffprobe -version` now reports the wrong binary,
re-install the system package:

```bash
sudo apt install --reinstall ffmpeg
```

## Restricted networks (China / Russia)

If `uv` times out fetching the python-build-standalone tarball or PyPI:

```bash
# Use a faster Python source mirror (China only — verify a current mirror)
export UV_PYTHON_INSTALL_MIRROR=https://ghproxy.com/https://github.com/astral-sh/python-build-standalone/releases/download

# Use a PyPI mirror
export UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple

# Or skip the download entirely if you have a compatible system Python
export UV_PYTHON_PREFERENCE=only-system

# Be tolerant of slow links
export UV_HTTP_TIMEOUT=120
export UV_HTTP_RETRIES=5
```

The Phase 3 install milestone (INST-07..11) ships an OS-level mirror cascade
that picks these defaults automatically; for v0.3 set them by hand.

## AMD GPU (ROCm)

<a id="amd-gpu-rocm"></a>

OmniVoice **auto-detects AMD GPUs** — `get_best_device()` returns the GPU when a
ROCm build of PyTorch is installed (ROCm-built PyTorch reports through
`torch.cuda.is_available()`), and OmniVoice auto-sets `HSA_OVERRIDE_GFX_VERSION`
for consumer cards whose GFX ID isn't in the official ROCm support matrix. No
code changes or flags are needed.

The catch: the **default install ships the CUDA build** of PyTorch (the
`pytorch-cuda` index in `pyproject.toml`), so on an AMD-only machine
`torch.cuda.is_available()` is `False` and OmniVoice falls back to CPU. To use
your AMD GPU, replace torch with the ROCm wheel **after** the first-run install
populates the venv:

```bash
# From the project directory (source install), into OmniVoice's uv venv.
# Current stable is ROCm 6.2 — match your installed ROCm/driver version
# (https://pytorch.org/get-started/locally/ lists available wheels).
uv pip install --reinstall torch torchaudio \
  --index-url https://download.pytorch.org/whl/rocm6.2
```

Then relaunch — the Settings → System panel should now report the GPU device
instead of `cpu`. Verify the wheel sees your card:

```bash
uv run python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Notes:
- ROCm is **Linux-only** and **opt-in** — the default cross-platform behavior
  (CUDA on NVIDIA, MPS on Apple, CPU elsewhere) is unchanged.
- Unsupported GFX (e.g. some consumer RDNA cards): if it still won't run, set
  `HSA_OVERRIDE_GFX_VERSION` yourself (e.g. `export HSA_OVERRIDE_GFX_VERSION=11.0.0`)
  to the nearest supported architecture before launching.
- ZLUDA (CUDA-on-ROCm translation) can work but is unsupported here — prefer a
  native ROCm wheel.

Tracking issue: [#124](https://github.com/debpalash/OmniVoice-Studio/issues/124).
An installer-integrated, env-var-driven ROCm wheel selection is a planned
follow-up; until then this manual step is the supported path.

## Hugging Face token (optional but recommended)

See [docs/setup/huggingface-token.md](../setup/huggingface-token.md).

## Troubleshooting

Hit a wall? See [docs/install/troubleshooting.md](troubleshooting.md).
