# Support

## Where to get help

| Channel | Best for |
|---|---|
| [Discord](https://discord.gg/bzQavDfVV9) — `#help` | Setup problems, quick questions, sharing results |
| [GitHub Issues](https://github.com/debpalash/OmniVoice-Studio/issues) | Bugs and feature requests — use the templates; attach the diagnostic bundle (Settings → About → "Save diagnostic bundle") |
| [GitHub Discussions](https://github.com/debpalash/OmniVoice-Studio/discussions) | Design questions, ideas, show & tell |
| Security issues | **Never a public issue** — see [SECURITY.md](SECURITY.md) for private reporting |

## Model sources we support

OmniVoice loads local models, and you're free to point it at any model folder
you trust. **Official support, however, covers only models from verifiable
public sources** — Hugging Face repos and official project releases with a
published license and checksums. Privately distributed, paywalled, or
otherwise unverifiable model files are **use-at-your-own-risk**: we can't
reproduce or debug problems with a model we can't download, and we can't vouch
for what's in a private archive. If you do load one, extract only the model
files themselves (weights, config, tokenizer) — never run bundled executables.

## Before filing a bug

1. Update to the latest release (or `main` if you follow previews) — fixes ship continuously.
2. Run the in-app self-check: **Settings → About → Run self-check**.
3. Search existing issues; add a 👍 + your details to an existing one rather than opening a duplicate.

## Response expectations

This is an open-source project maintained with the help of an automated triage
bot: issues are typically triaged within hours and every report gets a human-
approved response. Reproducible reports with a diagnostic bundle get fixed
fastest.
