# Hugging Face Token Setup

Some OmniVoice features need a **Hugging Face access token** to download gated models:

- **Pyannote speaker diarization** — requires accepting the pyannote model terms on HF
- **Some TTS engines** — gated voice/style packs
- **High-rate model downloads** — anonymous downloads can rate-limit

This guide shows how to set the token **permanently**, so you don't have to paste it again after every restart.

---

## TL;DR — pick one

| Method | Persists across restarts? | Picked up by OmniVoice? | Picked up by shell + other HF tools? |
|---|---|---|---|
| **A. HF canonical file** (recommended) | ✅ Yes | ✅ Yes | ✅ Yes |
| **B. Shell env var** (`~/.zshrc` / `~/.bashrc` / Windows env) | ✅ Yes | ✅ Yes (via env inheritance) | ✅ Yes |
| **C. In-app paste only** | ❌ **No — session only** | ✅ Yes (this session) | ❌ No |

> **Why "session only" today:** as of v0.2.7, pasting a token into the app's Settings panel applies it to the current backend process, but doesn't write it to disk. The app prints:
> > *"API keys and tokens are set for this session only. For persistence across restarts, set them as environment variables in your shell profile."*
>
> Once Phase 1 AUTH-03 ships (v0.3.x), pasting in Settings will save to the canonical HF file automatically. Until then, use Method A or B below.

---

## Get your token

1. Sign in at https://huggingface.co
2. Visit https://huggingface.co/settings/tokens
3. Click **"New token"** → **Type: Read** → give it a name like `omnivoice` → **Create**
4. Copy the `hf_...` string

For pyannote diarization, also visit https://huggingface.co/pyannote/speaker-diarization-3.1 and click **"Agree and access repository"** — your token then has read access to the gated model.

---

## Method A — HF canonical file (recommended)

Picked up automatically by every HF library (`huggingface_hub`, `transformers`, `diffusers`, OmniVoice's backend, Tauri sidecar).

### macOS / Linux

```bash
pip install --user huggingface_hub   # one-time, if not already installed
huggingface-cli login                # paste your hf_... token when prompted
```

This writes the token to `~/.cache/huggingface/token` with mode `0600`.

### Windows (PowerShell)

```powershell
pip install --user huggingface_hub
huggingface-cli login
```

Token is written to `%USERPROFILE%\.cache\huggingface\token`.

### Verify

```bash
huggingface-cli whoami
# Expected: your-username
```

### Remove (if needed)

```bash
huggingface-cli logout
# or just: rm ~/.cache/huggingface/token
```

---

## Method B — Shell environment variable

Useful if you don't want to install the `huggingface_hub` CLI, or you want every shell session to advertise the token via `echo $HF_TOKEN`.

### macOS (zsh — default since 10.15)

```bash
echo 'export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' >> ~/.zshrc
source ~/.zshrc
```

### Linux (bash)

```bash
echo 'export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' >> ~/.bashrc
source ~/.bashrc
```

### Linux (zsh)

```bash
echo 'export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' >> ~/.zshrc
source ~/.zshrc
```

### Windows — PowerShell (user scope, persists across reboots)

```powershell
[Environment]::SetEnvironmentVariable("HF_TOKEN","hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx","User")
```

You must **open a new PowerShell window** for the change to take effect (the current one won't see it — Microsoft's documented gotcha for `SetEnvironmentVariable`).

### Windows — cmd.exe

```cmd
setx HF_TOKEN "hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Same gotcha: open a new `cmd.exe` window to see it. `setx` writes to the registry but doesn't update the running shell.

### Verify

```bash
echo $HF_TOKEN           # macOS / Linux
echo $env:HF_TOKEN       # PowerShell
echo %HF_TOKEN%          # cmd.exe
```

### Remove

Edit the file (`~/.zshrc`, `~/.bashrc`) and delete the `export HF_TOKEN=...` line, then restart your shell. On Windows, run `[Environment]::SetEnvironmentVariable("HF_TOKEN", $null, "User")` in PowerShell.

---

## When OmniVoice picks it up

OmniVoice's backend reads the token in this priority order:

1. **`$HF_TOKEN` environment variable** (Methods B and C — set on shell or process)
2. **`~/.cache/huggingface/token` file** (Method A)
3. **In-app Settings paste** (Method C — overrides for this session only)

If multiple are set, the highest-priority one wins for that process. Use `huggingface-cli whoami` to confirm what the HF libs see, and check OmniVoice's status panel (Settings → Models → "HF auth: ✓ / ✗") to confirm the backend picked it up.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Diarization fails with "401 unauthorized" | Token isn't reaching the diarization process | Make sure you ran `source ~/.zshrc` (or opened a new shell) AFTER setting the var, and that OmniVoice was started from that shell. Tauri-launched processes inherit from the launch shell's env. |
| `huggingface-cli whoami` says "Not logged in" | Token file isn't where the CLI looks | Check `ls -la ~/.cache/huggingface/token`. If missing, re-run `huggingface-cli login`. |
| Pyannote diarization 403 even after login | You haven't accepted the model terms | Visit https://huggingface.co/pyannote/speaker-diarization-3.1 and click "Agree". |
| Windows: token set with `setx` but still empty in PowerShell | `setx` doesn't update the current shell | Open a new PowerShell window. |
| Token works in Terminal but not in the Tauri app | Tauri launched from Finder/Spotlight doesn't source `~/.zshrc` | Use Method A instead (it's read from the disk file, no shell required). Or launch OmniVoice from a Terminal with `open /Applications/OmniVoice\ Studio.app`. |

---

## Security notes

- **Never commit your token to git.** Add `*.env` and `.env.local` to `.gitignore` (OmniVoice already does this).
- **The canonical file (`~/.cache/huggingface/token`) is mode `0600`** — only your user can read it.
- **Use a `Read`-only token** unless you specifically need write access. Read tokens can still download gated models.
- **OmniVoice never sends your token to any third-party endpoint.** The token only goes from your machine → `huggingface.co` for downloads. See [PROJECT.md "Local-first guarantee"](/.planning/PROJECT.md#constraints) for the full constraint.

---

*Last updated: 2026-05-17 — applies to OmniVoice v0.2.7+*
