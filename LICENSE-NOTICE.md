# VoiceStudio — License Notice

## Abbreviation

AGPL-3.0-only

## Notice

Copyright 2024-present Palash Debnath and VoiceStudio contributors.

VoiceStudio is **free and open-source software, licensed under the GNU
Affero General Public License, Version 3 (AGPL-3.0)**. You are free to use,
copy, modify, and redistribute it. That **includes commercial and internal
business use** of the application itself. Model weights, tokenizers, and other
third-party assets retain their own terms; this application license does not
grant or summarize rights under those separate terms.

Because this is the **Affero** GPL, one additional obligation applies: if you
modify VoiceStudio and make that modified version available to others over
a network, you must also offer those users the complete corresponding source
code of your modified version under these same AGPL-3.0 terms. See the full
text in [`LICENSE`](LICENSE).

A **commercial license is available** for organizations that want to embed
VoiceStudio in a closed-source or proprietary product or service without
the AGPL-3.0 copyleft obligations. Pricing tiers are coming soon; for inquiries
contact `VoiceStudio@palash.dev`.

(This Notice is a plain-language summary; the binding terms are the full GNU
AGPL-3.0 text in [`LICENSE`](LICENSE).)

### Scope

These terms cover the VoiceStudio application — the Tauri desktop shell
(`frontend/src-tauri/`), the React frontend (`frontend/src/`), the FastAPI
backend (`backend/`), and supporting build / packaging scripts (`scripts/`,
`Dockerfile`, `docker-compose.yml`, `.github/`).

The bundled `omnivoice/` Python package — the underlying TTS model by Han Zhu —
is **separately licensed under Apache License 2.0** by its upstream authors and
is not relicensed here. Apache License 2.0 is compatible with, and may be
combined under, the GNU AGPL-3.0. See `pyproject.toml`.

Downloaded model weights are not relicensed by VoiceStudio. The default
`k2-fsa/OmniVoice` model card identifies its code as Apache-2.0 and pretrained
weights as CC-BY-NC. Its `audio_tokenizer/LICENSE` contains separate Boson
Higgs Audio 2 and Meta Llama community terms. A commercial license for
VoiceStudio-owned code does not replace any of those terms.

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
