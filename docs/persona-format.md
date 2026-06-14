# Portable personas — the `.ovsvoice` format

A **`.ovsvoice`** file is a portable voice persona: a single ZIP that packages a
voice profile's identity, an optional reference clip, a consent attestation, an
SPDX license tag, and a **watermarked preview**. You can export one from any
voice and import it back into another OmniVoice install — fully local, no
account, no upload to anyone.

It supersedes the older `.omnivoice` share bundle. OmniVoice still imports
`.omnivoice` files (they just carry no consent / license / preview).

## Export

**Voices → open a voice → Export persona.**

- The **"Include voice clip"** checkbox controls privacy:
  - **On (default):** the bundle carries your raw reference/locked audio, so the
    imported persona clones with full fidelity.
  - **Off:** a **preview-only** bundle — only the watermarked preview travels, no
    raw recording of your voice leaves the machine. The imported persona is still
    usable (the preview becomes its reference clip).
- A short **preview** is always generated and, when AudioSeal is installed,
  **watermarked** so the audio can be attributed back to OmniVoice. Behaviour is
  identical on macOS, Windows, and Linux; without AudioSeal the preview is still
  written, just flagged un-watermarked.
- The file downloads as `<voice name>.ovsvoice`.

## Import

**Voices → My Imports → the package button (next to Upload).** Pick a
`.ovsvoice` (or legacy `.omnivoice`) file; the persona appears in your voice
list.

### Consent & verification

A persona's **verified-own-voice** status can't be forged by hand-editing the
bundle. On import, OmniVoice marks a persona verified **only** when all three
hold: a real consent recording is present (above the minimum length), the
consent statement text is non-empty, and a `consent.json` attestation is
included. Otherwise it imports **unverified** — still usable for local
synthesis; verification is only required for agentic features and community
sharing, never for plain local generation. You can always re-attest locally
afterwards.

## What's inside (`.ovsvoice` = ZIP)

| Member | Purpose | Presence |
|--------|---------|----------|
| `manifest.json` | format + schema version, persona identity, engine/design params, license, tags, preview metadata | required |
| `metadata.json` | legacy-shaped copy so older OmniVoice can still read the ref audio | always written |
| `preview.wav` | watermarked preview (24 kHz mono) | required |
| `consent.json` | attestation: method, statement text, verified flag, timestamp | optional |
| `ref_audio.*` / `locked_audio.*` | the reference / locked clip | omitted when "Include voice clip" is off |
| `consent_audio.*` | the recorded consent statement | optional |

The manifest's `license.spdx` is validated against an allowlist (plus
`LicenseRef-` custom ids); anything unrecognised normalises to
`LicenseRef-OmniVoice-Personal`. The license is **metadata only** — OmniVoice
does not enforce it.

## Privacy & local-first

Export and import are **100% local** — building a bundle reads your local
database and files and writes a ZIP on the same machine; importing reads a local
file. No network call is made on any export/import/inspect path, and the feature
works fully offline. (The only adjacent network use is AudioSeal's optional
one-time model download for watermarking, which degrades to a no-op offline.)
