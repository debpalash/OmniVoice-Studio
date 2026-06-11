# OmniVoice Studio — Install on Windows

This page is self-contained: follow it top to bottom and you'll end up with a
working OmniVoice Studio install on Windows 10 / 11 (x64).

## Prerequisites

- **Windows 10 (21H2 or newer) or Windows 11**, x64.
- **Python 3.11+** — `winget install Python.Python.3.11` (or download from
  [python.org](https://www.python.org/downloads/windows/)).
- **Microsoft C++ Build Tools** — required by some PyPI source distributions
  (`pyannote.audio`, occasional torch wheel rebuild). Install via the
  [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  with the **"Desktop development with C++"** workload checked.
- **Bun** — `powershell -c "irm bun.sh/install.ps1 | iex"`.
- **FFmpeg** — `winget install Gyan.FFmpeg`.
- **Git for Windows** (from-source installs only) — `winget install --id Git.Git -e`.
  You need it for `git clone` anyway, and it includes **Git Bash**, which
  `bun run desktop-prod` uses to run its build-and-launch script. Without it,
  `desktop-prod` stops with an error telling you to install it.

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
