# Implementation Spec — TASK #29: `.ovsvoice` Portable Persona Format (export/import)

## TL;DR

Add a self-contained, portable **`.ovsvoice`** persona bundle (a ZIP) that packages a voice profile's identity, an optional reference clip, a **consent attestation** (`consent.json`), an **SPDX license tag**, and a **watermarked preview clip** — then lets the user export one from a profile and import one back into the gallery as a new profile. This is parity-program row **5.3 / §R3 G1** (`docs/specs/2026-06-12-elevenlabs-parity-program.md:78`). It is the standalone primitive that the Persona Gallery (row 5.4, `…:79`) later builds on. Reuse the existing `_bundle_metadata` (`backend/api/routers/marketplace.py:61-83`), the consent columns on `voice_profiles` (`backend/core/db.py:52-55`), and the watermark service (`backend/services/watermark.py`). No DB schema change, no new runtime dependency. The whole feature is **default-on, local-only, cross-platform-identical** — see the Constraints section for the rule-by-rule proof.

> **Grounding note (verified against the tree, branch `feat/stories-shared-render`):** every file/symbol/line below was checked against the current branch. Corrections from the prior draft: `_safe_torchaudio_save` lives in `backend/services/audio_io.py:68` (generation.py only *imports* it at `:17` and *calls* it at `:470`/`:484`); `export_profile` is `marketplace.py:86-137` (not 99-137 — body starts at 99, `def` at 86); `embed_watermark` is `watermark.py:95-142` with `_check_available` at `:43-53` (the `is_enabled()`+availability gate is the literal line `if not is_enabled() or not _check_available():` at `:112`, **verified**) and is decorated `@torch.no_grad()` at `:95` with signature `embed_watermark(waveform: torch.Tensor, sample_rate: int, message: Optional[list[int]] = None)` (**verified**, no keyword-only args today); the router import block is `main.py:304-335` and the registration block is `main.py:742-773`; the consent UPDATE write is `profiles.py:364-368` (inside `record_consent`, `:325-378`); `APP_VERSION` is read at runtime from installed package metadata in `backend/core/version.py` (`importlib.metadata.version("omnivoice")`; installed value `0.3.6` from `pyproject.toml:7`, source-checkout fallback literal `"0.3.5"` at `version.py:15` — **verified**); and the frontend import affordance belongs in **`ImportsZone`** (`frontend/src/pages/VoiceGallery.jsx:522`, mounted at `:230`, already owns a `fileRef` file picker at `:528`), **not** the read-only `CommunityZone` at `:452-453`. **API-shape corrections this round (verified):** the legacy `export_profile` streams with `media_type="application/zip"` and header `Content-Disposition: attachment; filename="<name>.omnivoice"` + `Content-Length` (`marketplace.py:130-137`) — **not** `application/octet-stream`; the persona export mirrors `application/zip`. The legacy `import_profile` is `async def`, takes `file: UploadFile = File(...)`, and returns exactly `{"success", "profile_id", "name", "is_locked", "source_bundle"}` (`marketplace.py:143-243`) — the persona import response is a **superset** of those keys (see §API). The legacy `import_profile` INSERT writes exactly **13 columns** `(id, name, ref_audio_path, ref_text, instruct, language, seed, personality, is_locked, locked_audio_path, created_at, kind, vd_states)` (`marketplace.py:207-228`); the persona INSERT adds the **4 consent columns** for 17 total (full list pinned in §API). `tags` on the legacy publish endpoint is a `Query("", ...)` param (`marketplace.py:252`), and `marketplace.py` imports `File, HTTPException, Query, UploadFile` + `StreamingResponse` (`:35-36`) — `personas.py` imports the same plus `Form`/`Body` for the export options. Additional verification: the local consent flow returns **422** (not 400) on empty `consent_text` / too-short recording (`profiles.py:331-332`, `:334-335`, **verified** — import-side reuses the *logic* but maps to its own status codes, B12–B15); `_voices_path` uses `os.path.realpath` + `startswith(root + os.sep)` and returns `Optional[str]` (`profiles.py:309-322`, **verified** OS-agnostic); the repo has **no alembic** — schema migrations are a hand-rolled `_migrate(conn, from_version)` in `db.py` (tops at version 4), and this spec needs none of it; `_safe_torchaudio_save` does **not** resample or downmix (`audio_io.py:68-149`, **verified** — no `torchaudio.functional.resample` in that file), so the service must resample/downmix itself; the CJK lint is `tests/test_no_hardcoded_cjk.py` (**not** under `backend/tests/`), scans git-tracked files, and does **not** auto-allowlist the new `persona_bundle.py`/`personas.py`/frontend files; the i18n runtime uses `fallbackLng: 'en'` with lazy per-locale loading and **only `en.json` bundled** (`frontend/src/i18n/index.ts:59,64,81`), so new strings need only land in `en.json`; the frontend `Profile` type and `apiPost/apiFetch/apiJson` helpers are at `types.ts:106-123` / `client.ts:102-148` (**verified** — `apiPost` returns parsed JSON, `apiFetch` returns the raw `Response`).

## Problem

OmniVoice already ships a `.omnivoice` bundle (`backend/api/routers/marketplace.py`) that zips `metadata.json` + `ref_audio` + `locked_audio` (built by `export_profile`/`publish_to_marketplace`; `marketplace.py:99-137` and `:275-296`). It is insufficient as a *portable persona* format:

- **No consent attestation travels with the persona.** The owner's `verified_own_voice` flag and consent record (`verified_own_voice`, `consent_text`, `consent_audio_path`, `consent_recorded_at` — `backend/core/db.py:52-55`) are never read by `_bundle_metadata` (`marketplace.py:69-81` only captures `bundle_version`/`profile_name`/`ref_text`/`instruct`/`language`/`personality`/`seed`/`kind`/`vd_states`/`is_locked`/`omnivoice_version`), so a shared persona carries no creation-method / attestation provenance. §R3 G2 (persona gallery) requires consent attestation at package time; without it, an imported persona silently loses its verified status.
- **No license tag.** There is no machine-readable statement of how the persona may be reused (the competitive-analysis recommendation is an SPDX-style tag — `docs/competitive-analysis.md:1151-1152`).
- **No watermarked preview.** The bundle carries raw `ref_audio`/`locked_audio` only (`marketplace.py:108-122`). The parity program mandates an **AudioSeal-watermarked preview** so a shared persona can be attributed back to OmniVoice and (later) to a persona ID ("AudioSeal watermark mandatory on preview audio … enough to carry a persona ID" — `docs/competitive-analysis.md:1140` / `:1151-1153`).
- **The format version is shared with `.omnivoice` and undifferentiated.** `BUNDLE_VERSION = 1` (`marketplace.py:52`, stamped into `metadata.bundle_version` at `:70`) does not distinguish "persona bundle with consent + preview" from the legacy share bundle.

The persona gallery (row 5.4) gates on "designed / self-recorded only, consent attestation, AudioSeal preview watermark enforced at package time" (`docs/specs/2026-06-12-elevenlabs-parity-program.md:79`) — none of which the current bundle satisfies.

## Goal / Non-goals

### Goals
- A new **`.ovsvoice`** bundle (ZIP) that is a superset of the existing `.omnivoice` payload, adding: `consent.json`, an SPDX license tag in the manifest, and a watermarked `preview.wav`.
- **Export** endpoint: `POST /personas/export/{profile_id}` → streams a downloadable `.ovsvoice` file (mirrors the `StreamingResponse(media_type="application/zip", headers={Content-Disposition, Content-Length})` shape of `export_profile`, `marketplace.py:130-137`).
- **Import** endpoint: `POST /personas/import` → creates a new `voice_profiles` row (lands in the existing voice list / gallery via `GET /profiles`, `profiles.py:32-36`), restoring `kind`, `vd_states`, and consent fields where present.
- A **preview** is generated at package time from the profile's reference/locked audio, watermarked via `services.watermark.embed_watermark`, regardless of the user's global invisible-watermark setting (enforced at package time per §R3).
- **Backward compatibility:** importing a legacy `.omnivoice` bundle (no `consent.json`, no `preview.wav`, no license) still works — fields default exactly as the current `import_profile` does (`marketplace.py:204-228`).
- Frontend: an **Export Persona** action on `VoiceProfile.jsx` and an **Import** affordance in the voice list, wired through `frontend/src/api/profiles.ts`. All copy via i18n `t(...)` keys (Constraints → Localization).
- Docs-sync: update `README.md` / `docs/**` where the bundle format is described (per the CLAUDE.md docs-sync hard rule).

### Non-goals
- The **community persona gallery / index repo** (row 5.4 / §R3 G2-G3) — index, "Community" tab, GitHub-PR submission. This spec ships only the file format + local export/import. (The read-only `CommunityZone` already exists at `VoiceGallery.jsx:452-453`; this spec does not touch it.)
- **Piper/ONNX export target** (§R3 G4) — the manifest is designed to be extensible toward it (`engine` + `design_params`), but we do not implement it.
- Replacing or deleting the existing `.omnivoice` marketplace endpoints (`marketplace.py:86-435`). `.ovsvoice` is additive; `.omnivoice` import stays as a compatible legacy reader.
- Any voiceprint / biometric verification. Consent here is an **attestation** (creation method + statement + timestamp), exactly as the existing consent lock is (the `record_consent` write at `backend/api/routers/profiles.py:364-368`; provenance, "not a voiceprint check" per the comment at `:298-300`).
- Cross-machine *audio* identity transfer beyond what the engine already does with a reference clip.

## Design

### Bundle layout (`.ovsvoice`, ZIP)

```
manifest.json        # schema_version, persona identity, engine/design params, license, tags
metadata.json        # legacy-shaped copy (for .omnivoice readers; written on EVERY .ovsvoice export)
consent.json         # attestation: method, statement text, verified flag, timestamp  (optional)
ref_audio.<ext>      # reference clip (clone personas)                                  (optional)
locked_audio.<ext>   # locked/optimized clip (locked personas)                          (optional)
preview.wav          # AudioSeal-watermarked preview, 24 kHz mono 16-bit PCM            (required on export)
consent_audio.<ext>  # the recorded consent statement                                   (optional)
```

`manifest.json` replaces the legacy flat `metadata.json` as the canonical reader. To stay readable by the **legacy** `.omnivoice` importer (`marketplace.import_profile`, which requires `metadata.json` — `marketplace.py:168-172`), the export **also** writes `metadata.json` (a verbatim copy of `_bundle_metadata(profile, ...)`) when producing a `.ovsvoice`, so an older OmniVoice can still import the ref audio. The new importer prefers `manifest.json` and falls back to `metadata.json` (B4).

### Bundle versioning

Introduce `OVSVOICE_SCHEMA_VERSION = 1` in a new module `backend/services/persona_bundle.py`, distinct from the legacy `BUNDLE_VERSION = 1` constant (`marketplace.py:52`). `manifest.json` carries `"format": "ovsvoice"` and `"schema_version": 1` so future readers can branch. (This `schema_version` governs only the *bundle file format*; it is unrelated to the project release version stamped into `omnivoice_version`, and unrelated to the DB `_migrate` schema version — see Constraints → Versioning / Backward-compatible data.)

### Where the logic lives — exact function signatures

Extract bundle build/parse into a **service module** `backend/services/persona_bundle.py` so it is unit-testable without a TestClient and reusable by row 5.4. The router (`backend/api/routers/personas.py`, new) is a thin HTTP layer. **Pin these signatures** (a developer implements against them verbatim):

```python
# backend/services/persona_bundle.py
from __future__ import annotations
import io, json, os, re, shutil, time, uuid, zipfile
from dataclasses import dataclass, field
from typing import Optional

OVSVOICE_SCHEMA_VERSION = 1
MAX_BUNDLE_BYTES = 100 * 1024 * 1024          # reuse marketplace.py:55 value
PREVIEW_MAX_SECONDS = 8.0                      # A6 cap
PREVIEW_SAMPLE_RATE = 24_000                   # A8 declared rate; mono, 16-bit PCM
_MIN_CONSENT_AUDIO_BYTES = 1000                # import profiles.py:302 floor
DEFAULT_LICENSE = "LicenseRef-OmniVoice-Personal"

# Membership allowlist for SPDX validation — fixed-string set + LicenseRef- prefix
# (NO regex over SPDX input — CodeQL py/polynomial-redos). Extend as needed.
_SPDX_ALLOWLIST: frozenset[str] = frozenset({
    "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0",
    "CC-BY-ND-4.0", "MIT", "Apache-2.0", "LicenseRef-OmniVoice-Personal",
})

class BundleError(Exception):
    """Base; carries an HTTP status + safe (non-leaking) detail."""
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status        # 400 | 413
        self.detail = detail        # user-safe message, never raw exc text

@dataclass
class ParsedPersona:
    manifest: dict                          # parsed manifest.json OR metadata.json (B4)
    consent: Optional[dict]                 # parsed consent.json, or None
    is_legacy: bool                         # True when only metadata.json was found (B6/B23)
    schema_version_ahead: bool              # manifest.schema_version > OVSVOICE_SCHEMA_VERSION (B7)
    license_spdx: str                       # normalized (B21)
    preview_only: bool                      # only preview.wav, no ref/locked member (A12/B8)
    # member name -> ext (".wav" fallback), resolved by prefix-match, NOT used to build paths:
    members: dict                           # {"ref_audio": ".wav"|None, "locked_audio": ..., "consent_audio": ..., "preview": ...}
    _zip: zipfile.ZipFile                   # open handle; caller extracts via _extract_member()

def build_manifest(profile: dict, *, license_spdx: str, tags: list[str],
                   preview_watermarked: bool, preview_duration_s: float,
                   members: dict) -> dict:
    """Return the manifest.json dict (shape pinned in §API). Reuses
    _bundle_metadata's core fields. Never raises on bad license_spdx —
    normalizes to DEFAULT_LICENSE (A19)."""

def build_persona_bundle(
    profile: dict,
    *,
    license_spdx: str = DEFAULT_LICENSE,
    tags: Optional[list[str]] = None,
    include_reference: bool = True,
    embed_fn=None,            # injectable for tests; defaults to services.watermark.embed_watermark
) -> bytes:
    """Assemble the .ovsvoice ZIP in memory and return its bytes.
    Raises BundleError(503, ...) is NOT used here — the *router* maps the
    'no readable source' condition (returns None preview) to 503. This
    function raises NoPreviewSource (subclass) when A2/A3/A4/A5/A12 leave
    no usable source clip; the router translates it to HTTP 503."""

def parse_persona_bundle(content: bytes) -> ParsedPersona:
    """Validate ZIP + read manifest/consent. Raises BundleError(400|413, ...)
    for B1-B11 conditions. Does NOT touch DB or write files."""

class NoPreviewSource(Exception):
    """Raised by build_persona_bundle when no readable source clip exists
    (A2/A3/A4/A5/A12); router maps to HTTP 503."""
```

This mirrors the existing split between **`backend/services/watermark.py`** (logic) and **`backend/api/routers/watermark.py`** (HTTP), which imports `detect_watermark, is_enabled, _check_available` from the service.

### Preview generation (watermark enforced at package time)

At export, generate `preview.wav` (24 kHz mono 16-bit PCM):
1. Load the source clip with `torchaudio.load(full_path)` → `(waveform, sr)` where `waveform` is `(channels, samples)`. Prefer `locked_audio_path`, else `ref_audio_path` (same precedence as `profiles.py:230`, `row["locked_audio_path"] or row["ref_audio_path"]`). Both are filenames relative to `VOICES_DIR`; resolve them through `_voices_path` first (the file the DB names may have been deleted — see A3). For a `kind='design'` persona, the stored deterministic identity sample (`ref_audio_path`, rendered by `_render_archetype_wav`, `profiles.py:91-102`) is the source.
2. Guard `waveform.numel() == 0` → treat as unreadable source (A5).
3. Downmix to mono: `wav = waveform.mean(dim=0, keepdim=True)` if `waveform.shape[0] > 1` (A7).
4. Resample to 24 kHz if `sr != PREVIEW_SAMPLE_RATE`: `wav = torchaudio.functional.resample(wav, sr, PREVIEW_SAMPLE_RATE)` (A8 — `_safe_torchaudio_save` does **not** resample, **verified** `audio_io.py:68-149`).
5. Trim to ≤ `PREVIEW_MAX_SECONDS` (`wav = wav[:, : int(PREVIEW_SAMPLE_RATE * PREVIEW_MAX_SECONDS)]`); shorter clips used whole (A6). `preview_duration_s = wav.shape[-1] / PREVIEW_SAMPLE_RATE` (the actual written length, reported in the manifest).
6. Watermark via `embed_watermark(wav, PREVIEW_SAMPLE_RATE, force=True)` (**forced on**, bypassing `is_enabled()`). Determine `preview_watermarked = _check_available() and is_enabled_bypassed_ok` — concretely: `watermarked = _check_available()` after a non-raising call (the residual A11 honesty caveat is in Risk).
7. Save with `_safe_torchaudio_save(member_buf_or_path, wav, PREVIEW_SAMPLE_RATE, format="wav", bits_per_sample=16)` — exact signature `_safe_torchaudio_save(path_or_buf, tensor, sample_rate, *, format="wav", bits_per_sample=16)` (`audio_io.py:68`). Write to an `io.BytesIO`, then `zf.writestr("preview.wav", buf.getvalue())`.

When AudioSeal is unavailable (`_check_available()` is `False`), the preview is still written **unwatermarked** with `manifest.preview.watermarked = false` recorded honestly (do not fail the export). This degrade path is **identical on macOS/Windows/Linux** — see Constraints → Cross-platform parity.

### Import → profile (lands in the gallery)

`parse_persona_bundle` → insert a `voice_profiles` row (new 8-char id via `str(uuid.uuid4())[:8]`, exactly as `marketplace.py:176`). **The INSERT extends the legacy 13-column shape (`marketplace.py:207-228`) to 17 columns** by adding the four consent columns (`db.py:52-55`). Full INSERT pinned in §API. Restored fields:
- `kind` / `vd_states` (already round-tripped by `_bundle_metadata` at `marketplace.py:77-78`).
- Consent fields **only if** `consent.json` is present *and* the bundle carried a `consent_audio` member ≥ `_MIN_CONSENT_AUDIO_BYTES` *and* `consent_text` is non-empty: write `verified_own_voice=1`, `consent_text`, `consent_audio_path` (the server-side `{profile_id}_consent{ext}` filename, **not** the bundle member name), `consent_recorded_at`. Otherwise import as **unverified** (`verified_own_voice=0`), preserving `consent_text`/`method` so the user can re-attest via `POST /profiles/{id}/consent` (`profiles.py:325-378`). Rationale: a persona's *verified-own-voice* status must not be forgeable by hand-editing a manifest — verification requires the recorded statement, matching `profiles.py:351-368`.
- The watermarked `preview.wav` is **not** stored as the profile's ref audio; the real `ref_audio`/`locked_audio` members are. The preview is provenance only. If a bundle has *only* `preview.wav` (privacy-stripped share), import the preview as the ref clip so the persona is usable, and set `preview_only=true` in the import response.

### Path-injection safety (carry over the hardened patterns)

Reuse the exact hardening already in the repo (this branch has a string of CodeQL `py/path-injection` fixes — `git log fc5bd0b…8bb0e73`):
- Resolve every on-disk write through `_voices_path` (`profiles.py:309-322`) — basename-only check (`os.path.basename(filename) != filename` → reject), `os.path.realpath`, must stay under `os.path.realpath(VOICES_DIR)`, returns `None` on any escape → router maps to **400**. Import `_voices_path` from `profiles.py` or lift it into a shared util so both routers use one implementation.
- Allowlist audio extensions with the existing regex `_CONSENT_EXT_RE = re.compile(r"^\.[A-Za-z0-9]{1,8}$")` (`profiles.py:306`), else fall back to `.wav` (the `if not _CONSENT_EXT_RE.match(ext): ext = ".wav"` idiom at `profiles.py:344-346`). **CodeQL note:** this regex is **linear** (single `[A-Za-z0-9]{1,8}` quantifier), so it carries no `py/polynomial-redos` exposure — it must be **reused verbatim**.
- ZIP entry names are matched by prefix (`ref_audio`, `locked_audio`, `consent_audio`, `preview`) — exactly how `import_profile` already iterates (`name.startswith("ref_audio")` / `"locked_audio"`, `marketplace.py:182-195`) — and the entry name is **never** used to construct the output path. Output filenames are derived from the server-generated `profile_id` only (`f"{profile_id}{ext}"` / `f"{profile_id}_locked{ext}"` / `f"{profile_id}_consent{ext}"`, same as `marketplace.py:185`/`:192` + the consent pattern at `profiles.py:347`).
- Enforce `MAX_BUNDLE_BYTES` (100 MB) **before** reading the ZIP, mirroring `marketplace.py:154-160`.

### License tag

Add a `license` block to the manifest: `{ "spdx": "<id>", "custom_text": "<optional>" }`. Default on export = `DEFAULT_LICENSE = "LicenseRef-OmniVoice-Personal"` (a custom ref meaning "personal use, no redistribution"); the export call accepts an SPDX id from the UI. Validate against `_SPDX_ALLOWLIST` (set membership) plus `spdx.startswith("LicenseRef-")`; on miss, **normalize to `DEFAULT_LICENSE`** (never 400). **Validate by membership / fixed-string prefix check, not by a back-tracking regex** (CodeQL `py/polynomial-redos`). No license-enforcement logic — metadata only.

## Completeness — exhaustive edge cases, states, and failure paths

This section enumerates every state and "and then…" the feature must handle. Numbered so tests and review can map 1:1.

### A. Export-side states (`build_persona_bundle` + `POST /personas/export/{id}`)

**A1 — Profile not found.** `SELECT * FROM voice_profiles WHERE id=?` returns no row → **404** `{"detail": "Voice profile not found"}` (exact marketplace idiom, `marketplace.py:94-95`). No partial file, no stream opened.

**A2 — Both `ref_audio_path` and `locked_audio_path` empty/NULL.** Column is nullable (`db.py:42`). No source clip → `build_persona_bundle` raises `NoPreviewSource` → router **503** ("this profile has no reference or locked audio to build a preview from; re-create or re-import it"), framed like the design-render 503 (`profiles.py:103-107`). Do **not** emit a manifest with a missing `preview` member.

**A3 — DB names a file that is gone from disk.** `_voices_path(name)` resolves to a path where `os.path.isfile(...)` is `False`, or `_voices_path` returns `None` (escape). Fall through the precedence chain: if locked is missing, try ref; if ref also missing/absent → `NoPreviewSource` (**503**). Mirrors the defensive `os.path.isfile(full_ref)` guards (`marketplace.py:112`, `:120`).

**A4 — `torchaudio.load` raises on the source clip.** Truncated/corrupt WAV. Catch it; try the *other* clip in the precedence chain; if both fail → **503** ("could not read the profile's audio to build a preview — see Settings → Logs"). Never let raw exception text leak into the HTTP body (CodeQL `31ee5ef` discipline).

**A5 — Empty / zero-length source audio.** A 0-sample tensor would make `_safe_torchaudio_save` raise `ValueError` (`audio_io.py:106-111`). Detect `waveform.numel() == 0` *before* trimming/watermarking → treat as A4 (→ 503).

**A6 — Source shorter than the preview cap.** Clip < 8 s → use whole (no padding). `preview.duration_s` reports the actual length.

**A7 — Multi-channel / odd-shape source.** `torchaudio.load` → `(channels, samples)`. Downmix to mono (`mean(dim=0, keepdim=True)`) before watermarking. `_safe_torchaudio_save` normalizes 1D→2D and clamps peaks (`audio_io.py:131-136`) but does **not** resample/downmix — the service does both.

**A8 — Source sample rate ≠ 24 kHz.** Resample to 24 kHz via `torchaudio.functional.resample` before saving so the manifest never lies. `preview.sample_rate = 24000`.

**A9 — AudioSeal installed and watermark succeeds.** `_check_available()==True`, `is_enabled()` True or False. The persona path calls `embed_watermark(..., force=True)`, bypassing the user pref. Result: `preview.watermarked=true`.

**A10 — AudioSeal absent.** `_check_available()==False` → `embed_watermark` returns input unchanged. Preview still written; `preview.watermarked=false`, recorded honestly. **Export must not fail.**

**A11 — AudioSeal present but model load / embed throws.** `embed_watermark` swallows it (`except Exception … return waveform`, `watermark.py:140-142`). Service sets `watermarked = _check_available()` (best-effort honesty); the residual "claimed true but unmarked" risk is in Risk and acceptable for v0.3.x (row 5.4 re-detects via `detect_watermark`).

**A12 — `include_reference=false` (privacy-stripped export).** Load source → build preview → write `preview.wav` → **do not** write raw `ref_audio`/`locked_audio`. `manifest.members.ref_audio`/`locked_audio` = `null`; preview-only. If A2/A3/A4 also apply, 503s.

**A13 — `safe_name` collapses to empty.** `"".join(c if c.isalnum() or c in "-_ " else "" for c in name).strip().replace(" ", "_")[:40]` (`marketplace.py:125-127`) → `""`. Fall back to `f"persona_{profile_id}"` so `Content-Disposition` always carries a usable filename.

**A14 — CJK / Unicode in `safe_name`.** `c.isalnum()` keeps Unicode letters. Mirror what `export_profile` does (raw `filename="..."`, `marketplace.py:134`) for parity; do not regress. This is a *file name derived from user data*, not UI copy — no i18n key, and does **not** trip `tests/test_no_hardcoded_cjk.py` (runtime data, not source literal).

**A15 — `vd_states` is a JSON string or NULL.** Column is `TEXT DEFAULT NULL` (`db.py:57`). `_bundle_metadata` passes through verbatim (`marketplace.py:78`). Keep it a string (or `null`) in the manifest — do **not** `json.loads` it. NULL → `vd_states: null`.

**A16 — `seed` NULL.** `seed INTEGER DEFAULT NULL` (`db.py:47`). Manifest `seed: null` valid; import restores `NULL` (INSERT binds `metadata.get("seed")`).

**A17 — `kind` unknown / NULL.** Export stamps `profile.get("kind") or "clone"` (`marketplace.py:77`). Unknown `kind` round-trips as-is; consent `method` derivation keys off `kind == "design"` only — any other value treated as a clone for consent-method purposes.

**A18 — Locked profile (`is_locked=1`) export.** Source precedence picks `locked_audio` for the preview. Both members written (unless `include_reference=false`); `manifest.persona.is_locked=true`. Import re-derives `is_locked = bool(metadata.is_locked AND a locked member was written)` exactly as `marketplace.py:204`.

**A19 — Bad SPDX on export.** `license_spdx` from the UI fails allowlist/`LicenseRef-` check → **normalize to `DEFAULT_LICENSE`** and proceed (do not 400). Log the substitution.

**A20 — Concurrent delete during export.** Export is read-only on the DB and reads files outside a transaction. A3/A4 cover now-missing files; worst case 503, never a crash. No locking (matches `export_profile`'s lock-free read).

### B. Import-side states (`parse_persona_bundle` + `POST /personas/import`)

**B1 — Filename guard.** Reject when `file.filename` is empty or `file.filename.lower()` ends with neither `.ovsvoice` nor `.omnivoice` → **400** (extend the `.endswith` guard at `marketplace.py:148`). Case-insensitive (`.OVSVOICE`) via lowercase + fixed-string `str.endswith` (**no regex** → no ReDoS).

**B2 — Oversized upload.** `len(content) > MAX_BUNDLE_BYTES` (100 MB) → **413** *before* `ZipFile(io.BytesIO(content))`, mirroring `marketplace.py:154-160`.

**B3 — Not a ZIP.** `zipfile.ZipFile(...)` raises `BadZipFile` → **400** ("not a valid ZIP"), mirroring `marketplace.py:162-165`.

**B4 — Manifest selection.** Prefer `manifest.json`; else fall back to `metadata.json` (legacy); if **both** absent → **400** ("missing manifest"), extending `marketplace.py:168-172`.

**B5 — Malformed manifest JSON.** Present but `json.load` raises (truncated, not-JSON, BOM) → **400** ("manifest is not valid JSON"). Do not let `JSONDecodeError` propagate as 500.

**B6 — `format` discriminator mismatch.** `manifest.format` present but ≠ `"ovsvoice"` → if `schema_version <= OVSVOICE_SCHEMA_VERSION` parse leniently; if `format` entirely unknown, fall back to the legacy/metadata reader rather than 400. No `format` key → treat as legacy `metadata.json`.

**B7 — Future `schema_version`.** `manifest.schema_version > OVSVOICE_SCHEMA_VERSION` → import best-effort using only understood fields; never 500. Surface `schema_version_ahead=true` in the response.

**B8 — ZIP member combinatorics.** Each cell has defined behavior:
  - manifest + `ref_audio` + `locked_audio` + `consent.json` + `consent_audio` + `preview` → full restore (verified if B12–B15 pass).
  - manifest + `ref_audio` only → clone-style import, unverified, no consent.
  - manifest + `locked_audio` only (no ref) → use locked as the ref clip (write as `{profile_id}{ext}`, set `is_locked` per A18); usable.
  - manifest + `preview` only (A12) → import preview as the ref clip, `preview_only=true` in the response.
  - manifest + **no audio member at all** → **400** ("no audio member found"), extending `marketplace.py:197-201`.
  - legacy `metadata.json` + `ref_audio` → behaves exactly like `marketplace.import_profile`, `verified_own_voice=0`, `kind` defaults to `clone` (`marketplace.py:226`).

**B9 — Duplicate / multiple matching members.** `zf.namelist()` may have two `startswith("ref_audio")` entries. The legacy loop lets the *last* win silently (`marketplace.py:182-195`). Match that (last-wins) deterministically; do **not** error. Output path is always `{profile_id}{ext}`.

**B10 — Zip-slip / path-injection member names.** Members named `../../evil.wav`, `ref_audio/../../../x`, absolute paths, embedded `\0` — the member name is **never** used to build the output path; only `os.path.splitext(name)[1]` → `_CONSENT_EXT_RE` (else `.wav`). Output filename `{profile_id}{ext}` resolved through `_voices_path` (returns `None` on escape → **400** "invalid profile id", belt-and-braces as at `profiles.py:349-350`). Test #13 asserts nothing written outside `VOICES_DIR`.

**B11 — Extension edge cases on members.** No extension (`ref_audio`), multi-dot (`ref_audio.tar.gz` → ext `.gz` passes), bogus (`ref_audio.../x`) → `_CONSENT_EXT_RE` rejects anything not `^\.[A-Za-z0-9]{1,8}$` and falls back to `.wav`. Ext > 8 chars or with separators → `.wav`. (Reused verified-linear regex — no new ReDoS surface.)

**B12 — Consent forgery guard (verified-claimed, no recording).** `consent.json` says `verified_own_voice=true` but no `consent_audio` member → import as `verified_own_voice=0`, preserving `consent_text`/`method`. Core non-forgeability rule; test #4.

**B13 — Consent recording present but `consent.json` missing/contradictory.** A `consent_audio` member exists but `consent.json` absent, or says `verified_own_voice=false` while a recording is present → trust the **declared flag**, not the file's mere presence. Import unverified; keep the recording on disk only if a valid `consent_text` exists, else drop it. Never set `verified_own_voice=1` without recording **and** true flag **and** non-empty `consent_text`.

**B14 — Consent recording too short / empty.** `consent_audio` member smaller than `_MIN_CONSENT_AUDIO_BYTES` (1000, `profiles.py:302`) → treat as no recording (B12 path: unverified).

**B15 — `consent_text` empty but flag true + recording present.** Local flow rejects empty consent text with **422** (`profiles.py:331-332`). Mirror the *logic* (empty/whitespace → cannot verify → `verified_own_voice=0`); on import this is **not** a 422 — the upload still imports (unverified).

**B16 — `consent_recorded_at` missing/non-numeric.** Coerce to `time.time()` (import time) when absent or unparseable, rather than `NULL` for a verified record. Column is `REAL DEFAULT NULL` (`db.py:55`).

**B17 — Design persona import.** `kind='design'`, `consent.method == "designed-synthetic"`, no human recording → for this spec's DB write, `kind='design'` preserved; `verified_own_voice` follows B12 (no recording → 0). The synthetic-exemption logic is row 5.4's. We only guarantee `kind` survives.

**B18 — Disk-write failure during member extraction (rollback).** Writing members via `shutil.copyfileobj` can fail mid-stream. On any failure after some files are written: **delete every file this import wrote** (track a list) before re-raising, mirroring `create_profile` (`profiles.py:119-123`) and `record_consent` (`profiles.py:369-372`).

**B19 — DB INSERT failure (rollback).** If the INSERT raises (constraint, locked DB) after files written: delete written files (B18 cleanup) and re-raise → **500** with generic message. Wrap like `create_profile`'s `try/except` (`profiles.py:110-123`).

**B20 — `profile_id` collision.** `str(uuid.uuid4())[:8]` PRIMARY KEY collision → `IntegrityError`. Retry id generation **once**, else B19 (rollback + 500). Document the retry-once.

**B21 — Bad SPDX in an imported manifest.** `manifest.license.spdx` junk → **do not crash, do not 400** → normalize to `DEFAULT_LICENSE`. Membership/prefix check only (no regex). Test #15.

**B22 — Preview member malformed.** `preview.wav` corrupt → provenance only, never stored as the profile's audio *unless* it's the only audio (B8). In preview-only, a corrupt preview → still write it; do **not** validate-decode at import time (avoid torchaudio import on the import path). Response carries `preview_only=true`.

**B23 — Legacy `.omnivoice` carrying a `preview.wav` by coincidence.** Legacy/metadata path ignores `consent.json`/`manifest.json`, reads only `metadata.json`, treats `preview.wav` as not-a-ref-member. No verification, no preview-as-ref unless it's the only audio.

**B24 — Empty ZIP / ZIP with only directories.** `zf.namelist()` empty or all end in `/` → no manifest → B4 (**400** "missing manifest").

**B25 — `event_bus` emit.** On successful import, emit `event_bus.emit("profiles", {"action": "created", "id": profile_id})` (same payload as `marketplace.py:231` / `profiles.py:124`). Emit **only after** the DB commit succeeds (not on rollback paths).

**B26 — Response shape on every success/partial branch.** The 200 body always includes the keys pinned in §API. `watermarked_preview` reflects `manifest.preview.watermarked` (false for legacy bundles with no preview, and for preview-present-but-unwatermarked).

### C. `/personas/inspect` (no-write preview path)

**C1 — Same parse, no DB.** Runs `parse_persona_bundle` and returns the manifest + a consent summary **without** writing any file or DB row. All B1–B11 validation errors apply identically; B18–B25 do **not**.

**C2 — Inspect never extracts audio.** Reads metadata only; must not write `consent_audio`/`ref_audio` to disk.

### D. `embed_watermark(force=)` signature-change states

**D1 — Default `force=False`.** Behavior identical to today for all existing call sites (`generation.py:462`, dub pipeline) — gated on `is_enabled()` and `_check_available()`. Test #19 asserts unchanged.

**D2 — `force=True`, AudioSeal present, `is_enabled()=False`.** Bypasses the pref → embeds. `watermarked=true`.

**D3 — `force=True`, AudioSeal absent.** Still no-ops (`_check_available()` half of the gate is **not** bypassed by `force`) → returns input unchanged. `watermarked=false`. Test #19.

**D4 — `force=True`, embed raises internally.** Swallowed (`watermark.py:140-142`), returns input. See A11 caveat.

### E. Cross-platform / concurrency states

**E1 — Path semantics.** `_voices_path`'s `os.path.realpath` + `startswith(root + os.sep)` is OS-agnostic; Windows drive-letter/UNC resolve through `realpath` the same way the existing consent/delete paths do. No platform branch. Load-bearing for the cross-platform-parity hard rule.

**E2 — Two imports racing on the DB.** SQLite `db_conn()` serializes writes; a same-tick id collision is B20. No additional locking.

**E3 — Export streaming while DB busy.** Export's read is short and lock-free; no interaction with concurrent writers (A20).

## Integration points (file:line)

- **`backend/api/routers/marketplace.py:61-83`** — `_bundle_metadata(profile, **extra) -> dict`: returns `{bundle_version, profile_name, ref_text, instruct, language, personality, seed, kind, vd_states, is_locked, omnivoice_version}` plus `**extra`. Its core fields are reused verbatim by `persona_bundle.build_manifest`. Refactor `_bundle_metadata` to live in (or be importable from) the new service so `.omnivoice` and `.ovsvoice` share one source of truth — keep `bundle_version` for `.omnivoice`; `.ovsvoice` uses `schema_version` instead.
- **`backend/api/routers/marketplace.py:86-137`** — `export_profile(profile_id: str)`: reference for the `SELECT * FROM voice_profiles WHERE id = ?` lookup (`:90-92`), 404 on miss with `detail="Voice profile not found"` (`:94-95`), in-memory `io.BytesIO` + `zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED)` build (`:100-122`), the defensive `os.path.isfile(...)` guards before `zf.write` (`:112`, `:120` → A3/A12), `safe_name` derivation (`:125-127` → A13/A14), and `StreamingResponse(buf, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{filename}"', "Content-Length": str(buf.getbuffer().nbytes)})` (`:130-137`). The persona export mirrors all of this, including `media_type="application/zip"`.
- **`backend/api/routers/marketplace.py:143-243`** — `async def import_profile(file: UploadFile = File(...))`: reference for the upload-size guard (`:154-160` → B2), `BadZipFile` → 400 (`:162-165` → B3), `metadata.json` presence check (`:168-172` → B4), audio member extraction via `shutil.copyfileobj` (`:182-195` → B8/B9/B18), the "no ref audio" 400 (`:197-201` → B8), the `is_locked` re-derivation `bool(metadata.get("is_locked") and locked_audio_filename)` (`:204` → A18), and the **13-column** INSERT (columns `:207-211`, values `:212-228` → B19). The persona importer extends this INSERT to **17 columns** (adds the 4 consent columns) and adds rollback-on-failure cleanup that `import_profile` currently lacks (B18/B19). Legacy import returns exactly `{"success": True, "profile_id", "name", "is_locked", "source_bundle"}` (`:237-243`) — the persona response is a superset (see §API).
- **`backend/core/db.py:38-59`** — `voice_profiles` schema in `_BASE_SCHEMA`: confirms every column the importer can write and their nullability/defaults driving A2/A15/A16/B16: `ref_audio_path TEXT` (nullable), `seed INTEGER DEFAULT NULL`, `is_locked INTEGER DEFAULT 0`, `verified_own_voice INTEGER DEFAULT 0` (`:52`), `consent_text TEXT DEFAULT ''` (`:53`), `consent_audio_path TEXT DEFAULT ''` (`:54`), `consent_recorded_at REAL DEFAULT NULL` (`:55`), `kind TEXT DEFAULT 'clone'` (`:56`), `vd_states TEXT DEFAULT NULL` (`:57`), `created_at REAL` (`:58`). **No migration needed** (all columns ship in `_BASE_SCHEMA`; `_migrate` tops at version 4; no alembic).
- **`backend/api/routers/profiles.py:230`** — `audio_file = row["locked_audio_path"] or row["ref_audio_path"]`: the locked-over-ref precedence for picking the preview/import source (A1–A4 chain).
- **`backend/api/routers/profiles.py:302`, `:306`, `:309-322`, `:344-346`, `:361-372`** — `_MIN_CONSENT_AUDIO_BYTES = 1000` (recording floor → B14), `_CONSENT_EXT_RE = re.compile(r"^\.[A-Za-z0-9]{1,8}$")` (extension allowlist, **verified linear** → B11/CodeQL), `_voices_path(filename) -> Optional[str]` (path confinement, **verified** basename+realpath+`startswith(root+os.sep)` → B10/E1), the `if not _CONSENT_EXT_RE.match(ext): ext = ".wav"` idiom (B11), the canonical consent-record UPDATE `SET verified_own_voice=1, consent_text=?, consent_audio_path=?, consent_recorded_at=? WHERE id=?` (`:364-367` → B12/B16), and the **orphan-cleanup-then-reraise** pattern when the DB write fails (`:369-372` → B18/B19). The local flow's empty-text / short-recording rejections are **422** (`:331-332`, `:334-335`) — the import path reuses the *predicate* but does not 422 the upload (B15).
- **`backend/api/routers/profiles.py:110-123`** — `create_profile`'s `try/except` that deletes the orphaned audio file when the INSERT fails: the exact rollback discipline the persona importer must replicate (B18/B19).
- **`backend/api/routers/profiles.py:103-107`** — the design-render **503** framing reused for export failures A2/A4/A5/A12.
- **`backend/services/watermark.py:43-53`, `:78-80`, `:95-142`** — `_check_available() -> bool` (A10/D3), `is_enabled() -> bool` (returns `resolve("watermark.invisible", default=True) is not False`, `:78-80`; D1/D2), and `embed_watermark(waveform, sample_rate, message=None)` decorated `@torch.no_grad()` (`:95`). **Signature change:** add keyword-only `force: bool = False`; amend the gate at `:112` from the verified literal `if not is_enabled() or not _check_available():` to `if (not force and not is_enabled()) or not _check_available():`. The internal `except Exception … return waveform` at `:140-142` drives A11/D4.
- **`backend/services/audio_io.py:68`, `:106-111`, `:131-136`** — `_safe_torchaudio_save(path_or_buf, tensor, sample_rate, *, format="wav", bits_per_sample=16) -> None`: the single audited save wrapper. `ValueError` on `numel()==0` (`:106-111`) is why the service must pre-check empty source (A5); the 1D→2D normalization + peak clamp (`:131-136`) is reused, but it does **not** resample or downmix — the service uses `torchaudio.functional.resample` + `mean(dim=0)` for A7/A8. Import as `from services.audio_io import _safe_torchaudio_save` (`generation.py:17`).
- **`backend/api/routers/generation.py:461-464`, `:513-518`** — pattern for running `embed_watermark` off the event loop: `audio_tensor = await loop.run_in_executor(_gpu_pool, embed_watermark, audio_tensor, sample_rate)` (lazy `from services.watermark import embed_watermark` at `:461`). Reuse `run_in_executor` for preview generation so export doesn't block. Because the persona path needs `force=True`, wrap with `functools.partial(embed_watermark, force=True)`: `await loop.run_in_executor(_gpu_pool, functools.partial(embed_watermark, wav, PREVIEW_SAMPLE_RATE, force=True))`. The 503 framing at `:513-518` matches A4.
- **`backend/api/routers/archetypes.py:129`, `:137-142`** — `_render_archetype_wav(a: dict, out_path: Path)` is the renderer behind a `kind='design'` persona's stored sample (invoked from `profiles.create_profile` at `:95-102`); documents why a design persona always has a usable `ref_audio_path` *unless* the render was interrupted (A3). Preview generation here is a *reload of that stored WAV*, not re-inference. The lazy-import discipline at `:137-142` is the model for keeping torch/torchaudio imports out of collection time.
- **`backend/main.py:304-335`** — router import block (`from api.routers import (system, profiles, exports, generation, …, marketplace, …)`). Add `personas` to this tuple.
- **`backend/main.py:742-773`** — `app.include_router(...)` block. Add `app.include_router(personas.router)` next to `app.include_router(profiles.router)` (`:743`) and `app.include_router(marketplace.router)` (`:767`).
- **`frontend/src/api/profiles.ts:1-47`** — add `exportPersona`/`importPersona`/`inspectPersona`; mirror existing `apiPost`/`apiFetch`/`apiJson` usage (imports at `:1`; `recordConsent(id, formData)` at `:33-35` is the closest multipart precedent — `apiPost(path, formData)` posts FormData with no `Content-Type` override, `client.ts:137-138`). `apiPost` returns parsed JSON (`client.ts:143`); `apiFetch` returns the raw `Response` (`client.ts:114-123`). For the binary download use `apiFetch(...).then(r => r.blob())`. Pinned signatures in §API. The UI must surface export-503, import-400, import-413 as distinct toasts, **each via a `t(...)` i18n key**.
- **`frontend/src/pages/VoiceProfile.jsx:33-77`** — add an "Export persona (.ovsvoice)" button near the consent/lock controls; this component already does `const { t } = useTranslation();` (`:34`, **verified**) and routes copy through `t('voice_profile.*')` (e.g. `:43`, `:51`, `:59`, `:62`). New strings under the existing `voice_profile` namespace in `en.json` (`:468`). Includes the privacy `include_reference` checkbox (default OFF).
- **`frontend/src/api/types.ts:106-123`** — `ProfileKind = 'clone' | 'design'` and `Profile` (with `verified_own_voice?: boolean | number`, `consent_text?`, `consent_recorded_at?: number | null` at `:119-122`). Add a `PersonaBundleMeta` type for `/inspect`/import responses (pinned in §API).
- **`frontend/src/pages/VoiceGallery.jsx:522`** (`ImportsZone`, mounted at `:230` under `zone === 'imports'`, `:177-178`) — add the **Import (.ovsvoice)** entry point. `ImportsZone` already holds `fileRef = useRef(null)` (`:528`) and a `useGalleryVoices()` query with `reload = () => voicesQ.refetch()` (`:530-532`) — wire a file picker → `importPersona` → `reload()`. New copy under the `voice_gallery` namespace (existing keys at `en.json:826,910,928,929`). Do **not** put it in `CommunityZone` (`:452-453`).

## API / data shapes

### `manifest.json`

```json
{
  "format": "ovsvoice",
  "schema_version": 1,
  "omnivoice_version": "0.3.6",
  "exported_at": 1749800000.0,
  "persona": {
    "name": "Aria Narration",
    "kind": "design",
    "language": "English",
    "personality": "warm-narrator",
    "instruct": "female, middle-aged, low pitch",
    "ref_text": "Hello — this is a preview of this voice.",
    "seed": 42,
    "is_locked": false,
    "vd_states": "{\"gender\":\"female\",\"age\":\"middle-aged\"}"
  },
  "engine": { "id": "indextts", "design_params": null },
  "license": { "spdx": "CC-BY-4.0", "custom_text": null },
  "tags": ["narration", "warm"],
  "preview": { "file": "preview.wav", "watermarked": true, "duration_s": 6.2, "sample_rate": 24000 },
  "members": { "ref_audio": "ref_audio.wav", "locked_audio": null, "consent_audio": "consent_audio.wav" }
}
```

**Field types / contracts:**
- `format` — string literal `"ovsvoice"` (the discriminator; B6).
- `schema_version` — integer; `1` this version.
- `omnivoice_version` — string, sourced from `core.version.APP_VERSION` (`importlib.metadata.version("omnivoice")` → `"0.3.6"`; literal `"0.3.5"` fallback for a non-`uv sync`'d checkout, `version.py:15`). **Informational provenance, not a gate.**
- `exported_at` — float epoch seconds (`time.time()`).
- `persona.*` — mirrors `_bundle_metadata`: `name` (str), `kind` (str, `"clone"`/`"design"`/unknown-passthrough), `language` (str, default `"Auto"`), `personality` (str), `instruct` (str), `ref_text` (str), `seed` (int **or `null`**, A16), `is_locked` (bool), `vd_states` (**JSON string or `null`** — never `json.loads`'d, A15).
- `engine` — `{ "id": str, "design_params": object | null }`; forward-compat hook for the Piper-ONNX target (§R3 G4). `id` defaults to the active engine string; `design_params` is `null` this version.
- `license` — `{ "spdx": str, "custom_text": str | null }`; `spdx` is allowlisted/normalized (A19/B21).
- `tags` — `string[]` (parsed from the comma-separated `tags` query param: `[t.strip() for t in tags.split(",") if t.strip()]`, same as `marketplace.py:278`).
- `preview` — `{ "file": "preview.wav", "watermarked": bool, "duration_s": float, "sample_rate": 24000 }`. `watermarked` is `false` whenever AudioSeal was unavailable (A10) or when there is no preview (legacy bundles — absent block).
- `members` — `{ "ref_audio": str | null, "locked_audio": str | null, "consent_audio": str | null }` — the ZIP member *filenames* present (advisory; the importer matches by prefix, not by this value). All `null` when `include_reference=false` (A12).

### `consent.json` (optional)

```json
{
  "verified_own_voice": true,
  "method": "self-recorded-statement",
  "consent_text": "I consent to the use of my voice ...",
  "recorded_at": 1749790000.0,
  "has_recording": true
}
```

**Field types / DB-column mapping (import side):**

| consent.json field | type | maps to DB column (`db.py`) | import rule |
|---|---|---|---|
| `verified_own_voice` | bool | `verified_own_voice INTEGER` (`:52`) | written as `1` **only** when B12–B15 all pass; else `0` |
| `method` | str ∈ `{"self-recorded-statement","designed-synthetic","imported-unverified"}` | *(no column; advisory)* | machine identifier, not localized |
| `consent_text` | str | `consent_text TEXT` (`:53`) | empty/whitespace → cannot verify (B15) |
| `recorded_at` | float epoch | `consent_recorded_at REAL` (`:55`) | coerce to `time.time()` if missing/non-numeric (B16) |
| `has_recording` | bool | *(no column; advisory)* | **ignored** for verification — trust the actual `consent_audio` member |
| *(server-derived)* | — | `consent_audio_path TEXT` (`:54`) | the on-disk `{profile_id}_consent{ext}` filename, **never** the bundle member name |

A `kind='design'` persona exports with `method="designed-synthetic"`, `verified_own_voice=true` *by definition*. On **import**, `has_recording`/`verified_own_voice` are *advisory only* — the importer trusts verification solely when an actual `consent_audio` member ≥ `_MIN_CONSENT_AUDIO_BYTES` is present **and** `consent_text` is non-empty (B12–B15).

### Endpoints

```
POST /personas/export/{profile_id}
  request: path param profile_id: str
           query params (FastAPI Query, like marketplace.py:252):
             license_spdx: str = "LicenseRef-OmniVoice-Personal"
             tags: str = ""                  # comma-separated, parsed to list[str]
             include_reference: bool = true  # privacy: false → preview-only bundle (A12)
  200: StreamingResponse, media_type="application/zip"     # NOT octet-stream (matches marketplace.py:132)
       headers:
         Content-Disposition: attachment; filename="<safe_name>.ovsvoice"   # safe_name via marketplace.py:125-127; empty→"persona_<id>" (A13)
         Content-Length: <int>                                              # str(buf.getbuffer().nbytes)
  404: {"detail": "Voice profile not found"}                                # A1, exact marketplace.py:95 string
  503: {"detail": "<no-readable-source message, no raw exc text>"}          # A2, A3, A4, A5, A12
       (engine/torchaudio unavailable; message points to Settings → Logs; same framing as profiles.py:103-107)
  (bad license_spdx is NOT an error here — normalized to default, A19)

POST /personas/import
  request: multipart/form-data, field name "file" (UploadFile = File(...)), value = <.ovsvoice|.omnivoice>
  200: {
         "success": true,                    // bool, always present
         "profile_id": "ab12cd34",           // str, 8 hex chars
         "name": "Aria Narration",           // str
         "kind": "design",                   // str ("clone"|"design"|passthrough)
         "verified_own_voice": false,        // bool (B12-B16)
         "preview_only": false,              // bool (A12/B8)
         "license_spdx": "CC-BY-4.0",        // str (normalized, B21)
         "watermarked_preview": true,        // bool, = manifest.preview.watermarked (false for legacy)
         "source_bundle": "Aria.ovsvoice",   // str, = file.filename (matches marketplace.py:242)
         "schema_version_ahead": false       // bool (B7)
       }
  400: {"detail": "..."}    # filename not .ovsvoice/.omnivoice (B1) / bad zip (B3) /
                            # missing manifest+metadata (B4) / malformed manifest JSON (B5) /
                            # no audio member (B8) / path-escape member (B10)
  413: {"detail": "Bundle too large (<n> bytes). Max is <MAX_BUNDLE_BYTES>."}  # B2, mirrors marketplace.py:159
  500: {"detail": "<generic; files cleaned up>"}   # disk-write or DB-insert failure after rollback (B18, B19)
  (bad SPDX in an imported manifest is NOT an error — normalized to default, B21)

GET  /personas/inspect       (multipart/form-data, field "file": UploadFile)  [optional, supports import-preview UI]
  200: {
         "format": "ovsvoice",              // str | "omnivoice-legacy" (when only metadata.json, B6/B23)
         "schema_version": 1,               // int (1 for legacy synthesized view)
         "name": "...", "kind": "...",
         "language": "...", "personality": "...", "is_locked": false,
         "license_spdx": "CC-BY-4.0",       // normalized
         "tags": ["..."],
         "preview_only": false,
         "watermarked_preview": true,       // = manifest.preview.watermarked (false if no preview)
         "consent": {                       // null when no consent.json
            "verified_claimed": true,       // = consent.json verified_own_voice (advisory)
            "method": "self-recorded-statement",
            "has_recording": true,          // = an actual consent_audio member present & >= floor
            "would_verify": true            // computed: B12-B15 would pass on import
         },
         "schema_version_ahead": false
       }                                                                     # C1, C2 — NO DB write, NO file extracted
  400/413: same validation/messages as import (B1–B11); no disk/DB paths apply
```

`importPersona` accepts both `.ovsvoice` and (for compatibility) `.omnivoice`; on a legacy bundle it reads `metadata.json`, skips consent/preview, and behaves like today's `marketplace.import_profile` (`marketplace.py:143-243`): `verified_own_voice=0`, `kind` default `"clone"`, `watermarked_preview=false`, `preview_only=false`, `license_spdx=DEFAULT_LICENSE`, `schema_version_ahead=false`. The `.endswith(...)` filename guard mirrors `marketplace.py:148` and is **case-insensitive** (lowercase + fixed-string compare, no regex; B1).

### Import INSERT (exact column list — 17 columns)

The persona importer extends the legacy 13-column INSERT (`marketplace.py:207-228`) with the 4 consent columns:

```python
conn.execute(
    """INSERT INTO voice_profiles
       (id, name, ref_audio_path, ref_text, instruct, language,
        seed, personality, is_locked, locked_audio_path, created_at,
        kind, vd_states,
        verified_own_voice, consent_text, consent_audio_path, consent_recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
    (
        profile_id,
        manifest_persona.get("name", "Imported Voice"),
        ref_audio_filename,                       # f"{profile_id}{ext}" or preview-as-ref (A12)
        manifest_persona.get("ref_text", ""),
        manifest_persona.get("instruct", ""),
        manifest_persona.get("language", "Auto"),
        manifest_persona.get("seed"),             # may be None (A16)
        manifest_persona.get("personality", ""),
        1 if is_locked else 0,                    # bool(is_locked AND locked member written), A18
        locked_audio_filename or "",
        time.time(),
        manifest_persona.get("kind") or "clone",  # passthrough (A17)
        manifest_persona.get("vd_states"),        # JSON string or None (A15)
        1 if verified else 0,                     # B12-B15 gate
        consent_text if verified else "",         # preserve text even when unverified? -> see note
        consent_audio_filename if verified else "",
        consent_recorded_at if verified else None,
    ),
)
```

> Note on preserving `consent_text` when unverified (B12/B13/B15): the spec's rule is to keep `consent_text`/`method` so the user can re-attest locally. Implement by writing `consent_text` (the bundle's text) into the `consent_text` column even when `verified=0` **but** leaving `consent_audio_path=''` and `consent_recorded_at=NULL` and `verified_own_voice=0`. (Adjust the `consent_text if verified else ""` above to `consent_text` unconditionally when `consent_text` is a valid non-empty string and a re-attest UX is desired; otherwise keep the conservative empty default. The acceptance test #4/#5 only asserts `verified_own_voice=0` for forged bundles, so either choice passes — pick "preserve text" to match the Design section.)

### `embed_watermark` signature change

```python
# backend/services/watermark.py:95  (currently decorated @torch.no_grad())
@torch.no_grad()
def embed_watermark(
    waveform: torch.Tensor,
    sample_rate: int,
    message: Optional[list[int]] = None,
    *,
    force: bool = False,
) -> torch.Tensor:
    # change the gate at line 112 from (verified current literal):
    #   if not is_enabled() or not _check_available():
    # to:
    #   if (not force and not is_enabled()) or not _check_available():
    # force=True bypasses is_enabled() but still no-ops when AudioSeal is unavailable (D3)
    ...
```
`force` is **keyword-only** (after `*`), so all positional call sites (`generation.py:462` `run_in_executor(_gpu_pool, embed_watermark, audio_tensor, sample_rate)`, the dub pipeline) are unchanged and default to `force=False` (D1). The persona path must pass `force=True` by keyword — via `functools.partial(embed_watermark, wav, sample_rate, force=True)` when handing it to `run_in_executor`. This keeps the watermark default-behavior identical on every platform.

### Frontend signatures (`frontend/src/api/profiles.ts`)

```typescript
import { apiJson, apiPost, apiFetch } from './client';
import type { Profile, ProfileUsage, PersonaBundleMeta } from './types';

// Binary download — apiFetch returns the raw Response (client.ts:114-123)
export async function exportPersona(
  id: string,
  opts?: { license_spdx?: string; tags?: string; include_reference?: boolean },
): Promise<Blob> {
  const q = new URLSearchParams();
  if (opts?.license_spdx) q.set('license_spdx', opts.license_spdx);
  if (opts?.tags) q.set('tags', opts.tags);
  if (opts?.include_reference === false) q.set('include_reference', 'false');
  const qs = q.toString();
  const r = await apiFetch(`/personas/export/${id}${qs ? `?${qs}` : ''}`, { method: 'POST' });
  return r.blob();
}

// Import — multipart FormData, apiPost returns parsed JSON (client.ts:131-144)
export async function importPersona(formData: FormData): Promise<PersonaImportResult> {
  return apiPost<PersonaImportResult>('/personas/import', formData);   // formData has field "file"
}

export async function inspectPersona(formData: FormData): Promise<PersonaBundleMeta> {
  // GET with body is awkward; if implemented as POST server-side, mirror that here.
  return apiPost<PersonaBundleMeta>('/personas/inspect', formData);
}
```

### Frontend types (`frontend/src/api/types.ts`)

```typescript
export interface PersonaImportResult {
  success: boolean;
  profile_id: string;
  name: string;
  kind: ProfileKind | string;
  verified_own_voice: boolean;
  preview_only: boolean;
  license_spdx: string;
  watermarked_preview: boolean;
  source_bundle: string;
  schema_version_ahead: boolean;
}

export interface PersonaBundleMeta {
  format: string;                 // "ovsvoice" | "omnivoice-legacy"
  schema_version: number;
  name: string;
  kind: ProfileKind | string;
  language?: string;
  personality?: string;
  is_locked?: boolean;
  license_spdx: string;
  tags: string[];
  preview_only: boolean;
  watermarked_preview: boolean;
  consent: null | {
    verified_claimed: boolean;
    method: string;
    has_recording: boolean;
    would_verify: boolean;
  };
  schema_version_ahead: boolean;
}
```

## Constraints

This feature ships in **default mode** (no opt-in toggle to export/import a persona), so it is held to every OmniVoice hard rule. Each is satisfied as follows:

- **Default-features cross-platform parity (CLAUDE.md P0 rule — "behave identically on macOS, Windows, and Linux"):** export/import is default-on with no platform branch. Its building blocks are all OS-agnostic: stdlib `zipfile`/`json`, the `_voices_path` confinement using `os.path.realpath` + `startswith(root + os.sep)` (which uses `os.sep`, resolving Windows drive-letter/UNC the same way the existing consent/delete paths already do — **verified** `profiles.py:309-322`, E1), and the watermark gate (`_check_available()` at `watermark.py:43-53` is a pure import check). The single capability that *could* diverge — AudioSeal availability — is handled by the **identical degrade path on all three platforms**: when AudioSeal is absent the preview is still written, just with `manifest.preview.watermarked = false` recorded honestly (A10). There is **no platform-only skip** and no platform that produces a different bundle shape. No new platform-only feature is introduced, so nothing needs an opt-in gate.
- **Local-first guarantee preserved (no cloud/accounts/telemetry):** **zero network calls.** Export builds the ZIP in-memory from local DB + local files and streams it back to the same machine; import reads an uploaded local file. No new endpoint posts anywhere; no token, account, or API key is read or required. The only network code adjacent to this path is AudioSeal's *first-run model fetch* via `huggingface_hub`, which is the pre-existing, optional watermark dependency (not introduced here) and degrades to no-op offline (A10/A11). The feature is fully functional with no connectivity.
- **Backward-compatible project data (alembic for DB / lazy migration for client state):** **no DB schema change** — every column the importer writes (`verified_own_voice`, `consent_text`, `consent_audio_path`, `consent_recorded_at`, `kind`, `vd_states`, `seed`, …) already exists in `_BASE_SCHEMA` (`db.py:38-59`). This project has **no alembic**; schema versioning is the hand-rolled `_migrate(conn, from_version)` in `db.py` (currently tops at version 4) — and this spec touches *neither*, so the CLAUDE.md "alembic with a tested upgrade path" requirement is vacuously satisfied. Existing `omnivoice_data/` opens unmodified; existing profiles export with no migration; legacy `.omnivoice` bundles still import (B8/B11/B23). Client-side there is no new persisted localStorage shape; the only new client state is transient import-preview UI state. The bundle's own `schema_version` (B6/B7) provides forward/backward leniency for *future* `.ovsvoice` readers.
- **Existing-engine compatibility:** no engine code is touched; the preview is built by *reloading* the already-stored ref/locked WAV via `torchaudio.load`, never a re-inference, so users with IndexTTS/CosyVoice/etc. already installed need no reinstall and no on-disk model-state change.
- **CodeQL `py/path-injection`:** output paths are derived solely from the server-generated `profile_id` (`{profile_id}{ext}` / `{profile_id}_locked{ext}` / `{profile_id}_consent{ext}`), never from attacker-controlled ZIP member names; every write is confined by `_voices_path` (basename+realpath, returns `None`→400 on escape); extensions pass the `_CONSENT_EXT_RE` allowlist else fall back to `.wav` (B10/B11). These are the exact patterns that cleared the recent CodeQL fixes on this branch (`git log fc5bd0b…8bb0e73`), and exception text is never echoed into HTTP bodies (the `31ee5ef` discipline, A4).
- **CodeQL `py/polynomial-redos`:** the only regex on the user/bundle-input path is the **reused, verified-linear** `_CONSENT_EXT_RE = ^\.[A-Za-z0-9]{1,8}$` (`profiles.py:306`). The spec adds **no new regex**: filename suffix matching uses fixed-string `str.endswith` on a lowercased name (B1); SPDX validation is set-membership against `_SPDX_ALLOWLIST` + `startswith("LicenseRef-")` (B21). Any future regex over bundle input must stay linear (no overlapping `\s*`/`.+`, exclude both delimiters in `[^x]*`) per the CodeQL ReDoS memory.
- **Localization (no hardcoded non-English/CJK; all UI via i18n `t()`):** every new user-facing string (export button, license picker, `include_reference` privacy checkbox, import affordance, and the distinct 503/400/413 error toasts) is added as a `t('...')` key. `VoiceProfile.jsx` already imports `useTranslation` and routes copy through `t('voice_profile.*')` (**verified** `:34`, `:43`, `:51`); new keys go under the existing `voice_profile` namespace (`en.json:468`), and gallery copy under `voice_gallery` (`en.json:826…`). Because the runtime uses `fallbackLng: 'en'` with lazy per-locale loading and **only `en.json` is bundled** (**verified** `i18n/index.ts:59,64,81`), adding keys to `en.json` alone is sufficient and safe. No hardcoded CJK is introduced: `method` values, the `format` discriminator, and the user-data-derived export filename (A14) are functional identifiers/runtime data, not source literals, so `tests/test_no_hardcoded_cjk.py` (**verified** scans git-tracked source for literal CJK, does *not* auto-allowlist the new `persona_bundle.py`/`personas.py`/frontend files) stays green. The new test file `backend/tests/test_persona_bundle.py` *is* auto-allowlisted by that lint's `test_`-prefix rule but should still avoid gratuitous CJK literals.
- **Versioning (continuous-to-main patch, no RCs):** this is a feature-add shipped continuous-to-main on the current `v0.3.x` line; it requires **no version bump** of its own — `omnivoice_version` in the manifest is read from `core.version.APP_VERSION` (already `0.3.6` on `main`), and the bundle's `schema_version=1` is independent of the release version. No `-rc` tag, no soak, no `v0.4` deferral.
- **Docs-sync (hard rule):** README/`docs/**` sections describing the share-bundle format are updated **in the same PR set** (PR 5.3d below) — manifest schema, consent/license/preview semantics, `.omnivoice` compatibility, preview-only/privacy behavior, plus `CHANGELOG.md`.
- **GSD workflow:** implementation must be started via a GSD entry point (`/gsd-execute-phase` for this planned row, or `/gsd-quick` for the docs slice) per the project rule.

## Dependencies

- **No new runtime dependency.** Uses `zipfile`, `json`, `uuid`, `time`, `os`, `io`, `shutil`, `functools`, `re` (stdlib — all already imported in `marketplace.py:24-32` except `functools`, which is stdlib); `torch`/`torchaudio` (already pinned, used by `watermark.py`/`audio_io.py`/`generation.py`; the service uses `torchaudio.load` + `torchaudio.functional.resample` for A7/A8); `audioseal` (already an **optional** dep, lazily imported in `watermark.py:48,60,71` — its absence degrades cleanly per A10).
- **Code dependency:** reuses `services/watermark.py` (`embed_watermark`, `_check_available`, `is_enabled`), `services/audio_io.py` (`_safe_torchaudio_save`), `core/db.py` (`db_conn`), `core/config` (`VOICES_DIR`, `OUTPUTS_DIR`), `core/version.APP_VERSION`, `core/event_bus` (the `event_bus.emit("profiles", {"action": "created", "id": profile_id})` call → B25), and `profiles._voices_path`/`_CONSENT_EXT_RE`/`_MIN_CONSENT_AUDIO_BYTES`/`_bundle_metadata`-shape (→ B10/B11/B14).
- **Upstream/parallel:** standalone; **row 5.4 (Persona Gallery) depends on this** (`docs/specs/2026-06-12-elevenlabs-parity-program.md:79` lists 5.4 `Depends on: 0.2, 5.3`). Design `manifest.engine`/`design_params` to be forward-compatible with the future Piper-ONNX export target (§R3 G4 / voicebox #138 at `docs/competitive-analysis.md:1153-1156`) without implementing it.

## Risk

- **Preview generation cost / blocking** — loading + watermarking on every export adds latency and can OOM on huge clips. *Mitigation:* cap preview to ≤ 8 s mono 24 kHz before watermarking (A6/A7/A8); run in `run_in_executor` (`generation.py:462`); on any failure, prefer `watermarked=false` over a 500 where a preview can still be written, and 503 only when there is no readable source (A2–A5). `embed_watermark` already swallows internal failures.
- **Watermark-flag honesty (A11)** — `embed_watermark` swallows internal exceptions, so a preview can be reported `watermarked=true` while actually unmarked. *Mitigation:* the gallery (row 5.4) re-runs `detect_watermark` at admission rather than trusting the flag; this PR records best-effort honesty (`watermarked = _check_available()` and a successful spy-verified call). Acceptable for v0.3.x.
- **AudioSeal absent in some installs** — preview unwatermarked. *Mitigation:* honest `watermarked` flag (A10); never fail export; **identical behavior on macOS/Windows/Linux**.
- **Consent forgery** — a hand-edited manifest could claim `verified_own_voice`. *Mitigation:* import only trusts verification when the recorded `consent_audio` member is present, ≥ `_MIN_CONSENT_AUDIO_BYTES`, *and* `consent_text` is non-empty (B12–B15, test #4/#5), matching the local write-then-set order at `profiles.py:351-368`.
- **Orphan files on partial import** — `import_profile` today does not clean up files when the INSERT fails. *Mitigation:* the persona importer tracks every file it writes and deletes them on any extraction- or INSERT-failure before re-raising (B18/B19, test #16).
- **Zip-slip / path-injection (CodeQL gate)** — branch history of `py/path-injection` fixes (`fc5bd0b…8bb0e73`). *Mitigation:* output paths derived from server-generated `profile_id` only; basename+realpath confinement via `_voices_path`; extension allowlist; never join attacker-controlled member names (B10/B11, test #13).
- **ReDoS on bundle input (CodeQL `py/polynomial-redos`)** — bundle filenames, member names, SPDX strings are attacker-controllable. *Mitigation:* no new regex — fixed-string `endswith` for filenames, set-membership/`startswith` for SPDX, reused linear `_CONSENT_EXT_RE` for extensions.
- **Format confusion between `.omnivoice` and `.ovsvoice`** — users may expect old bundles to carry consent. *Mitigation:* clear extension split, `format` discriminator, importer accepts both with documented behavior (case-insensitive `.endswith`, B1/B6/B23), docs updated.
- **Privacy of shared reference audio** — sharing a clone persona ships the user's actual voice clip. *Mitigation:* `include_reference=false` produces a preview-only bundle (watermarked preview + manifest, no raw ref, A12); default the UI checkbox per the project's privacy convention (reproduction-file capture defaults OFF).
- **id collision (B20)** — `uuid4()[:8]` PRIMARY KEY collision is rare but possible. *Mitigation:* retry id generation once on `IntegrityError`, else rollback + 500.

## PR slices

1. **PR 5.3a — service core (`persona_bundle.py`) + tests.** `build_persona_bundle` / `parse_persona_bundle` / `build_manifest` / `ParsedPersona` / `NoPreviewSource` / `BundleError` (signatures pinned in §Design), manifest + consent.json + license, `embed_watermark(force=)` keyword-only param (the gate edit at the verified `watermark.py:112` literal), full `test_persona_bundle.py` (all edge cases A/B/C/D). No HTTP, no UI. Model-free tests pass locally; CI runs watermark-on path. *Self-contained, reviewable.*
2. **PR 5.3b — router + wiring.** New `backend/api/routers/personas.py` (`/personas/export`, `/personas/import`, optional `/personas/inspect`) — maps `BundleError.status`→HTTP, `NoPreviewSource`→503, `IntegrityError`→retry-once-then-500; registered in `main.py` (`personas` in the import tuple at `:304-335`, `app.include_router(personas.router)` in the block at `:742-773`). Includes rollback-on-failure cleanup (B18/B19). Refactor `marketplace._bundle_metadata` to delegate to the shared builder (keeping `.omnivoice` behavior identical, incl. the `bundle_version` field at `marketplace.py:70`). Endpoint tests via `TestClient` covering A1/A2 (404/503), B1–B4 (400), B2 (413), B18/B19 (500-after-cleanup), C1/C2 (inspect no-write), and the exact 200-body key set (B26).
3. **PR 5.3c — frontend.** `exportPersona`/`importPersona`/`inspectPersona` in `profiles.ts` (signatures pinned in §API), export button + license/privacy (`include_reference` default OFF) options in `VoiceProfile.jsx` (near the consent block, `:50-77`), import affordance in `ImportsZone` (`VoiceGallery.jsx:522`, reuse its `fileRef` at `:528`), distinct error toasts for 503/400/413, `PersonaImportResult`/`PersonaBundleMeta` types in `types.ts`, **i18n keys added to `en.json` only** (`voice_profile`/`voice_gallery` namespaces), vitest. Run `bunx vitest run` locally per the merge-discipline memory.
4. **PR 5.3d — docs-sync.** Update README/`docs/**` sections describing the bundle format and add a `.ovsvoice` format note (manifest schema, consent/license/preview semantics, `.omnivoice` compatibility, preview-only/privacy behavior). Update `CHANGELOG.md`.

(If the reviewer prefers fewer PRs, 5.3a+5.3b can merge together; the frontend and docs slices should stay separate per the merge-discipline + docs-sync conventions.)

## Test plan

New file `backend/tests/test_persona_bundle.py` (model-free, mirroring `test_community.py`'s config-shim + `TestClient` pattern at `backend/tests/test_community.py:20-32` — `sys.path.insert`, a fake `core.config` module with `DATA_DIR`/`VOICES_DIR`/`OUTPUTS_DIR` set to a `tempfile.mkdtemp`, then import the router/service). Auto-allowlisted by `tests/test_no_hardcoded_cjk.py` (`test_`-prefix rule) but avoid gratuitous CJK literals:

1. **Round-trip identity** — build a profile dict, `build_persona_bundle`, `parse_persona_bundle`; assert `name`, `kind`, `vd_states`, `instruct`, `language`, `seed`, `is_locked` survive (the `_bundle_metadata` fields, `marketplace.py:71-79`). Include `seed=None` and `vd_states=None` (A15/A16). Assert `manifest.persona` field types match §API.
2. **Manifest schema** — `format == "ovsvoice"`, `schema_version == 1`, `license.spdx` present and allowlisted, `preview` block present with `sample_rate==24000` and `duration_s` a float; assert a sibling `metadata.json` member also exists (legacy-reader compat).
3. **Consent round-trip** — verified profile with consent audio (≥1000 bytes) + non-empty `consent_text` → `consent.json` written with `has_recording=true`; import restores `verified_own_voice=1` + all four consent columns (`db.py:52-55`), with `consent_audio_path == f"{profile_id}_consent.wav"` (server-derived, not the member name).
4. **Consent forgery guard** — manifest claims `verified_own_voice=true` but no `consent_audio` member → import sets `verified_own_voice=0` (B12).
5. **Consent recording too short / empty text** — `consent_audio` < 1000 bytes → unverified (B14). Recording present but `consent_text` empty → unverified (B15), and **not** a 422 on import (the upload succeeds, profile just unverified).
6. **Design persona** — `kind='design'`, no human ref → `consent.method == "designed-synthetic"`; import preserves `kind='design'`; `verified_own_voice` follows B12/B17.
7. **Watermark on preview** — monkeypatch `services.watermark._check_available → True`, `is_enabled → False`, and spy `embed_watermark`; assert the preview path calls it with `force=True` keyword (D2) and `manifest.preview.watermarked == true`. With `_check_available → False`, preview still written, `watermarked == false`, export succeeds (A10).
8. **No-source export** — both paths empty → **503** (A2). Profile naming a deleted file → tries the other, then **503** (A3). Source `torchaudio.load` can't read (garbage bytes in `.wav`) → **503**, no raw exception text in body (A4).
9. **Empty / multi-channel / off-rate source** — 0-sample source → 503 (A5). Stereo 48 kHz source → preview mono 24 kHz, `manifest.preview.sample_rate==24000`, `duration_s` ≤ 8.0 (A6/A7/A8).
10. **`include_reference=false`** — preview-only bundle: `members.ref_audio`/`locked_audio` are `null`, `preview.wav` present; import sets `preview_only=true` and uses preview as the ref clip (A12/B8).
11. **Legacy `.omnivoice` import** — feed a bundle built by the *old* `marketplace._bundle_metadata` (metadata.json only); assert import succeeds, `verified_own_voice=0`, `kind` defaults `clone` (`marketplace.py:226`), `watermarked_preview=false`, `preview_only=false`, `license_spdx==DEFAULT_LICENSE`, `schema_version_ahead=false` (B8/B23). Also: filename ending `.OVSVOICE` accepted (lowercase+`endswith`); filename ending `.txt` rejected 400 (B1).
12. **Manifest-selection + malformed JSON** — `manifest.json` only imports; both → prefers manifest; neither → 400 (B4); manifest present but invalid JSON → 400 (B5); empty ZIP / dirs-only → 400 (B24).
13. **Path-injection / zip-slip** — ZIP with members `../../evil.wav`, `ref_audio/../../../x`, an absolute path, and a no-extension member; assert no file written outside `VOICES_DIR` (via `_voices_path`), output names `{profile_id}.*` only, bad extensions → `.wav` (B10/B11). Duplicate `ref_audio*` members → last-wins, no error (B9).
14. **Size + bad-zip guards** — > `MAX_BUNDLE_BYTES` → 413 with the exact message shape (B2); non-zip bytes → `BadZipFile` → 400 (B3).
15. **Bad SPDX** — export with `license_spdx="haha; rm -rf"` → normalized to `DEFAULT_LICENSE`, export succeeds (A19); import of a junk-SPDX manifest → normalized, no crash (B21). Assert normalization is membership/prefix-based (no regex).
16. **Rollback** — monkeypatch the DB INSERT to raise → assert all files this import wrote are deleted from `VOICES_DIR` and a 500 (generic message) returned (B18/B19). Monkeypatch `shutil.copyfileobj` to raise mid-extraction → same cleanup (B18).
17. **`/personas/inspect`** — returns manifest + consent summary (the exact 200-body shape in §API, incl. `consent.would_verify`), asserts **no** new row in `voice_profiles` and **no** new file in `VOICES_DIR` (C1/C2); same 400/413 validation as import.
18. **Future schema_version** — manifest with `schema_version=99` imports best-effort with `schema_version_ahead=true`, no 500 (B7).
19. **`embed_watermark(force=)` unit test** — `force=True` (keyword) bypasses `is_enabled()=False` (D2); AudioSeal-missing (`_check_available()=False`) still no-ops and returns input unchanged even with `force=True` (D3); default `force=False` unchanged for existing positional call sites (D1).

Frontend: a vitest unit for `exportPersona`/`importPersona`/`inspectPersona` (mock `apiFetch`/`apiPost` from `../api/client`), asserting: `exportPersona` builds the correct query string (`license_spdx`/`tags`/`include_reference=false`) and reads `r.blob()`; `importPersona` posts a multipart `FormData` with field `file`; and 503/400/413 responses surface distinct error toasts **resolved through `t(...)` keys** (assert the i18n key is invoked, not a hardcoded string) — co-located with the existing `frontend/src/utils/*.test.js` pattern. Run `bunx vitest run` locally.

Local Python: run `uv run pytest backend/tests/test_persona_bundle.py` (model-free, no torch import at collection — keep watermark/torchaudio imports lazy inside functions, the same lazy-import discipline used by `generation.py:461` and `archetypes.py:137-142`, to avoid the known local torch/Triton segfault noted in MEMORY). Let CI validate the watermark-on path. Also run `uv run pytest tests/test_no_hardcoded_cjk.py`.

## Acceptance criteria

- Exporting any profile via `POST /personas/export/{id}` yields a valid ZIP whose `manifest.json` has `format=="ovsvoice"`, `schema_version==1`, a `license` block, and a `preview` block (`sample_rate==24000`); a sibling `metadata.json` (legacy-shaped) is also present; the response is `media_type="application/zip"` and the file downloads with a `.ovsvoice` extension (filename via the `safe_name` idiom; empty name → `persona_<id>`, A13).
- Exporting a profile with **no readable source audio** (both paths empty, or files missing/corrupt/empty) returns **503**, not a 500, and never a malformed bundle (A2–A5); no raw exception text in the body.
- The bundle always contains `preview.wav` (when a source exists); it is AudioSeal-watermarked when AudioSeal is installed (`manifest.preview.watermarked==true`), and present-but-unwatermarked (flag `false`) when not — **with identical behavior and bundle shape on macOS, Windows, and Linux** (A9/A10).
- `include_reference=false` produces a preview-only bundle (no raw ref/locked members, `members.*` null); importing it sets `preview_only=true` and the persona is still usable (A12/B8).
- Importing a `.ovsvoice` bundle via `POST /personas/import` creates a new `voice_profiles` row that appears in `GET /profiles` (`profiles.py:32-36`), preserving `kind`, `vd_states`, `language`, `instruct`, `personality`, `seed` (incl. `null`), `is_locked`; the 200 body contains exactly the key set in §API (B26).
- A verified profile (recorded consent ≥1000 bytes + non-empty text) round-trips: import restores `verified_own_voice=1` + `consent_text` + `consent_audio_path` (server-derived `{profile_id}_consent{ext}`) + `consent_recorded_at` (`db.py:52-55`). A manifest claiming verification *without* a qualifying `consent_audio` member, or with empty `consent_text`, imports as `verified_own_voice=0` (B12–B16).
- A legacy `.omnivoice` bundle still imports successfully (no consent, `kind` defaults to `clone` per `marketplace.py:226`, `watermarked_preview=false`); filename matching is case-insensitive and non-bundle extensions are rejected 400 (B1/B23).
- Every ZIP-member combination in B8 has the documented outcome; manifest-less / malformed-JSON / no-audio uploads return 400 (B4/B5/B8/B24); duplicate members are last-wins without error (B9).
- No file is ever written outside `VOICES_DIR` for any crafted member name (enforced via `_voices_path`, `profiles.py:309-322`); bad extensions fall back to `.wav`; **CodeQL `py/path-injection` and `py/polynomial-redos` both stay green** (B10/B11).
- A disk-write or DB-insert failure mid-import leaves **no** orphan files in `VOICES_DIR` and returns a 500 with a generic message (B18/B19).
- Oversized (>100 MB) and non-ZIP uploads return 413 and 400 respectively with user-facing (i18n) messages (B2/B3).
- `GET /personas/inspect` returns the manifest + consent summary in the §API shape (incl. `consent.would_verify`) without writing any DB row or extracting any file (C1/C2).
- `embed_watermark(..., force=True)` (keyword) bypasses the user's invisible-watermark setting (`is_enabled()`) but still no-ops without AudioSeal; existing positional call sites (`generation.py:462`, dub) are unchanged (default `force=False`) (D1–D3).
- **No DB migration, no alembic step; existing `omnivoice_data/` works unmodified.**
- **Zero network calls on any export/import/inspect path**; the feature is fully functional offline.
- All new UI text is added as `t(...)` keys in `frontend/src/i18n/locales/en.json`; `tests/test_no_hardcoded_cjk.py` stays green and no new locale-parity failures are introduced.
- This change requires **no version bump** and ships continuous-to-main on the v0.3.x line with no RC.
- `bunx vitest run` and `uv run pytest backend/tests/test_persona_bundle.py` pass locally; full backend suite + frontend gates green in CI before merge.
- README/docs describing the bundle format are updated in the same PR set (docs-sync rule).
