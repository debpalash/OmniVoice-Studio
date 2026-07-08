# OmniVoice Studio — Install on Windows

This page is self-contained: follow it top to bottom and you'll end up with a
working OmniVoice Studio install on Windows 10 / 11 (x64).

## Prerequisites

### Using the MSI installer

- **Windows 10 (21H2 or newer) or Windows 11**, x64.
- **~10 GB free disk** for the app, its Python environment, and model weights.
- Optional: an **NVIDIA GPU + driver** for CUDA acceleration — see
  [GPU support on Windows](#gpu-support). AMD GPUs run CPU-only on Windows.

That's it — Python, FFmpeg, and the model weights are bundled or bootstrapped
by the app itself on first launch. No toolchain needed.

### Building from source

Everything above, plus the toolchain:

- **Git for Windows** — `winget install --id Git.Git -e`. Needed for
  `git clone`, and it includes **Git Bash**, which `bun run desktop-prod`
  uses to run its build-and-launch script. Without it, `desktop-prod` stops
  with an error telling you to install it.
- **Python 3.11+** — `winget install Python.Python.3.11` (or download from
  [python.org](https://www.python.org/downloads/windows/)).
- **Microsoft C++ Build Tools** — required by some PyPI source distributions
  (`pyannote.audio`, occasional torch wheel rebuild). Install via the
  [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  with the **"Desktop development with C++"** workload checked.
- **Bun** — `powershell -c "irm bun.sh/install.ps1 | iex"`.
- **FFmpeg** — `winget install Gyan.FFmpeg`.
- **Rust / Cargo** — `winget install Rust.Rustup` or download `rustup-init.exe` from [rustup.rs](https://rustup.rs/).
  After installing Rustup, close and reopen PowerShell before running `bun run desktop-prod`.

## GPU support on Windows

<a id="gpu-support"></a>

**GPU acceleration on Windows is NVIDIA/CUDA-only.** The Windows install
ships the CUDA build of PyTorch; with an NVIDIA GPU and a regular NVIDIA
driver it's picked up automatically (no CUDA Toolkit install needed).

**AMD GPUs — including Ryzen / Ryzen AI integrated Radeon graphics — run
CPU-only on Windows.** ROCm is not supported on Windows: PyTorch publishes no
Windows ROCm wheels, and OmniVoice's ROCm option is Linux-only. (The Ryzen AI
NPU is likewise not used.) Everything still works on CPU, just slower. If you
have an AMD GPU and want GPU acceleration, run OmniVoice on Linux instead —
see [linux.md — AMD GPU (ROCm)](linux.md#amd-gpu-rocm).

## Install (from source)

Run from a regular (non-admin) PowerShell:

```bash
git clone https://github.com/debpalash/OmniVoice-Studio.git
cd OmniVoice-Studio
bun install
bun run desktop-prod
```

The first launch creates the Python venv via `uv`, syncs deps, and downloads
model weights. The splash screen shows progress.

> **Note:** `bun run desktop-prod` runs a bash script under the hood. You can
> launch it from PowerShell or cmd as shown — it finds Git Bash automatically
> (installed with Git for Windows, see Prerequisites). If no Git Bash is
> found, it prints instructions instead of failing silently. Alternatives
> that don't need bash: `bun run desktop` (dev mode) or the pre-built MSI
> below.

## Install (pre-built MSI)

Download the latest MSI from the
[Releases page](https://github.com/debpalash/OmniVoice-Studio/releases/latest),
run it, follow the wizard. The shortcut lands in the Start menu as
**OmniVoice Studio**.

### Installing to a different drive

<a id="install-other-drive"></a>

The wizard's **directory picker** lets you install the app to any **local**
drive (D:, E:, …). Two caveats:

- **Mapped network drives (Z: → a share) are not supported** — this is a
  Windows Installer limitation, not an OmniVoice bug: MSI custom actions run
  as a service account that doesn't see per-user drive mappings, so the
  install fails or rolls back. Install to a local drive instead.
- The install location only moves the ~200 MB app itself. The big data
  (models, voices, projects — tens of GB) lives in the **data directory**,
  which you move independently: **Settings → Storage → Models directory**
  in-app, or `OMNIVOICE_DATA_DIR` / [Portable mode](#portable-install) for
  the whole data tree.

If an install to a local non-C: drive fails anyway, capture a log with
`msiexec /i OmniVoice*.msi /L*V install.log` and
[open an issue](https://github.com/debpalash/OmniVoice-Studio/issues) with it
— that log shows exactly which step rolled back.

## Portable install (Windows)

<a id="portable-install"></a>

OmniVoice Studio has a **Portable** mode: instead of scattering data across
`%APPDATA%` and `%LOCALAPPDATA%`, the whole install — Python env, model
weights, voices, projects, settings — lives in a single
`OmniVoiceStudio-Data` folder created **next to the executable**. Moving or
copying the app folder (exe + that data folder together) relocates the entire
install, USB-stick style.

The first-run setup screen offers Portable whenever the folder next to
`OmniVoice Studio.exe` is writable. A default MSI install goes to
`C:\Program Files`, which is *not* user-writable — that's why Portable shows
as greyed out after a default install
([#766](https://github.com/debpalash/OmniVoice-Studio/issues/766)). To enable
it, install to a user-writable folder instead:

- Re-run the MSI and choose a custom destination folder in the setup wizard
  (e.g. `D:\Apps\OmniVoice`), or
- From a terminal:
  `msiexec /i OmniVoice.Studio_<version>_x64_en-US.msi INSTALLDIR="D:\Apps\OmniVoice"`

On the next launch, pick **Portable** on the first-run setup screen. What
lives next to the exe afterwards:

<!-- validate: skip -->
```
D:\Apps\OmniVoice\
├── OmniVoice Studio.exe        ← the app
└── OmniVoiceStudio-Data\       ← the whole install, self-contained
    ├── config.json             ← install-mode + app settings
    ├── env\                    ← Python venv + backend code
    └── data\                   ← voices, projects, settings DB
        └── models\             ← model weights (HF cache)
```

Prefer the default Program Files install? **Installed** mode is the same app —
data just lives in `%APPDATA%\OmniVoice` and the model cache in
`%LOCALAPPDATA%\OmniVoice\hf_cache`.

## HF_TOKEN persistence

The **recommended path** is the in-app **Settings → API Keys** panel: it
writes the token to OmniVoice's encrypted SQLite store *and* to the canonical
`huggingface_hub` location, so every subprocess the app spawns picks it up.

If you prefer setting an environment variable directly (power-user / CLI runs
from source), use **PowerShell** with `[Environment]::SetEnvironmentVariable`:

```powershell
[Environment]::SetEnvironmentVariable("HF_TOKEN","hf_yourtokenhere","User")
```

That writes to the user-scope environment and is picked up by every **new**
shell — close and reopen PowerShell or your terminal to see it.

> **Don't use `setx`.** `setx HF_TOKEN "hf_..."` works in theory but has
> three real gotchas that produce "I set it but it's empty" bug reports:
> it doesn't propagate to the current shell, it silently truncates values
> longer than 1024 chars, and it doesn't escape `%` characters. Use the
> in-app panel or the PowerShell one-liner above.

Full HF token guide: [docs/setup/huggingface-token.md](../setup/huggingface-token.md).

## Triton / torch.compile OOM

<a id="torch-compile-oom"></a>

On Windows, certain TTS engines (notably IndexTTS-2 and some CosyVoice paths)
trigger `torch.compile` / Triton kernel compilation during the first
synthesise call. On machines with <16 GB VRAM, that compile step can OOM
*before* the audio render even begins — the error usually surfaces as
`OutOfMemoryError: CUDA out of memory` or `RuntimeError: Triton compilation
failed`.

**The one-click fix:** open **Settings → Performance** in the app and toggle
**"Disable torch.compile (Windows)"** on. That sets the
`TORCH_COMPILE_DISABLE=1` env var on every engine subprocess OmniVoice spawns,
which falls back to the eager-mode kernel path. You'll lose a few percent of
peak throughput in exchange for the engine actually loading.

**From the CLI / from source:** set the env var manually before launching:

```powershell
$env:TORCH_COMPILE_DISABLE = "1"
bun run desktop-prod
```

This setting is a no-op on macOS and Linux (the OOM is Windows-specific —
the `torch.compile` kernel cache behaves differently on the other platforms).
Tracking issue: [#65](https://github.com/debpalash/OmniVoice-Studio/issues/65).

## Hugging Face token (optional but recommended)

See [docs/setup/huggingface-token.md](../setup/huggingface-token.md).

## Troubleshooting

Hit a wall? See [docs/install/troubleshooting.md](troubleshooting.md).
