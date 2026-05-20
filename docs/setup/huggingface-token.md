# Hugging Face Token Setup

OmniVoice uses a single HF token for every model download, license-gate
check, and `whoami` ping. This page covers the three places OmniVoice will
look for a token and the recommended path for v0.3+.

## Three sources (cascade)

OmniVoice resolves the active HF token by walking three sources in priority
order — the first source that has a token *and* survives a live `whoami`
call wins:

1. **App** — encrypted in OmniVoice's SQLite settings store.
   Set via the in-app **Settings → API Keys** panel.
2. **Env** — `HF_TOKEN` (or the legacy `HUGGING_FACE_HUB_TOKEN`) environment
   variable visible to the OmniVoice process.
3. **HF CLI** — the canonical `~/.cache/huggingface/token` file written by
   `huggingface-cli login`.

The active source is surfaced live in **Settings → API Keys**: each row shows
set/unset, a masked preview (`hf_…3jw`), the `whoami` username + green check
when valid, and an **"Active"** badge on whichever source is currently
serving the cascade.

## Setting via the app (recommended)

1. Open **Settings → API Keys**.
2. Paste your HF token (get one from
   [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) —
   the "read" scope is enough).
3. Click **Save**. The token is encrypted at rest (Fernet symmetric AEAD,
   key derived per-install from machine-id) and also written to the
   canonical `huggingface_hub` token location so subprocess engines pick it
   up automatically.
4. The row's `whoami` indicator flips green and the **Active** badge moves to
   "App".

> **Known limitation (honest disclosure):** the encryption key is derived
> per-install from the machine identifier. If you copy `omnivoice_data/`
> across machines, the token row in `settings` will fail to decrypt on the
> new machine — the resolver logs a warning and falls back to the env / CLI
> source. Re-save the token on the new machine to re-encrypt with the
> new install's key.

## Setting via environment variable (power users)

If you launch OmniVoice from a terminal or CI and prefer env-var management,
export `HF_TOKEN` from your shell's startup file:

```bash
# macOS (zsh — default since 10.15)
echo 'export HF_TOKEN=hf_yourtokenhere' >> ~/.zshrc && source ~/.zshrc

# Linux (bash)
echo 'export HF_TOKEN=hf_yourtokenhere' >> ~/.bashrc && source ~/.bashrc
```

**Windows PowerShell** — write to user-scope environment:

```powershell
[Environment]::SetEnvironmentVariable("HF_TOKEN","hf_yourtokenhere","User")
```

That persists for new shells. Close and reopen PowerShell or your terminal
to see it.

> **Don't use `setx`.** `setx HF_TOKEN "hf_..."` writes the variable but
> *doesn't propagate to the current shell* — a common source of "I set it
> but it's empty" bug reports. Use the in-app Settings → API Keys path or
> the `[Environment]::SetEnvironmentVariable` one-liner above.

## Setting via `huggingface-cli`

If you already use the HuggingFace CLI:

```bash
pip install --upgrade huggingface_hub
huggingface-cli login
# paste token at the prompt
```

That writes to `~/.cache/huggingface/token`. OmniVoice reads via
`huggingface_hub.get_token()` and picks it up automatically — you'll see the
**HF CLI** row in **Settings → API Keys** flip to "set".

## Accepting model licenses

Some models need both a token *and* a license acceptance click before
downloads work. Visit each page while signed in with the same HF account:

- `pyannote/speaker-diarization-3.1` — required for diarization.
  See [docs/features/diarization.md](../features/diarization.md).
- `pyannote/segmentation-3.0` — required transitively by the above.
- `IndexTeam/IndexTTS-2` — required if you use IndexTTS for voice cloning.
- `Supertone/supertonic-3` — required if you enable the Supertonic-3 engine.

After clicking **"Agree and access repository"** on each page, restart any
in-flight OmniVoice job (the gated check is cached for the lifetime of the
process).

## Troubleshooting

- **HF 401 even though a token is set** — visit the model's HuggingFace page
  and accept the license (see above). The token is fine; the *license* gate
  is separate.
- **Token row stays red after Save** — the `whoami` call failed. Check the
  token is valid at
  [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
  and has at least the "read" scope.
- **Token didn't survive a reboot** — open **Settings → API Keys** and check
  the App row. If it's empty, the SQLite store may have been wiped — re-save.
  If it's set but the active source is "Env" or "HF CLI", that's the cascade
  working as intended (App is highest priority).
