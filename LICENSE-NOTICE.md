# OmniVoice Studio — License Notice

## Abbreviation

AGPL-3.0-only

## Notice

Copyright 2024-present Palash Debnath and OmniVoice Studio contributors.

OmniVoice Studio is **free and open-source software, licensed under the GNU
Affero General Public License, Version 3 (AGPL-3.0)**. You are free to use,
copy, modify, and redistribute it — and that **includes commercial and internal
business use**: run the app, use its outputs commercially, sell the audio you
produce with it, provide professional/client services with it, and deploy it
within your organization.

Because this is the **Affero** GPL, one additional obligation applies: if you
modify OmniVoice Studio and make that modified version available to others over
a network, you must also offer those users the complete corresponding source
code of your modified version under these same AGPL-3.0 terms. See the full
text in [`LICENSE`](LICENSE).

A **commercial license is available** for organizations that want to embed
OmniVoice Studio in a closed-source or proprietary product or service without
the AGPL-3.0 copyleft obligations. Pricing tiers are coming soon; for inquiries
contact `OmniVoice@palash.dev`.

(This Notice is a plain-language summary; the binding terms are the full GNU
AGPL-3.0 text in [`LICENSE`](LICENSE).)

### Scope

These terms cover the OmniVoice Studio application — the Tauri desktop shell
(`frontend/src-tauri/`), the React frontend (`frontend/src/`), the FastAPI
backend (`backend/`), and supporting build / packaging scripts (`scripts/`,
`Dockerfile`, `docker-compose.yml`, `.github/`).

The bundled `omnivoice/` Python package — the underlying TTS model by Han Zhu —
is **separately licensed under Apache License 2.0** by its upstream authors and
is not relicensed here. Apache License 2.0 is compatible with, and may be
combined under, the GNU AGPL-3.0. See `pyproject.toml`.

Third-party dependencies retain their own licenses. See `Cargo.lock`,
`bun.lock`, and `uv.lock` for the resolved set.

### Reference

The full canonical text of the GNU Affero General Public License, Version 3 is
reproduced verbatim in [`LICENSE`](LICENSE). The authoritative copy lives at
<https://www.gnu.org/licenses/agpl-3.0.txt>.

> **Why this notice is a separate file:** `LICENSE` must contain the verbatim
> AGPL-3.0 text and nothing else, so GitHub's license detection (and the
> corporate license scanners that gate adoption) can identify it as
> `AGPL-3.0-only` rather than falling back to "Other" / `NOASSERTION`.
