# Voice Gallery — Design & Implementation Spec

**Date:** 2026-05-31
**Branch:** `debpalash/voice-gallery`
**Status:** Approved (design), in implementation
**Ships on:** v0.3.0 (per CLAUDE.md versioning rule — no version chatter)

---

## 1. Goal

A browsable library of **designed voice archetypes** — hundreds of ready-to-use
voices generated entirely by OmniVoice's own voice-design engine — organized
ElevenLabs-style (featured cards up top, facet filters to explore the rest),
plus a **neutral URL/file importer** for users to bring their own source audio.

The project authors **zero celebrity / named-real-person catalog**. The "vibe"
of every archetype comes from token combinations + a sample script + curatorial
naming, never from cloning an identifiable individual.

### Why no celebrity directory (decision record)

A user-pasted URL importer is neutral infrastructure (like yt-dlp/ffmpeg) — the
user supplies the source and owns the licensing call. But a project-shipped
*directory of named real people* (Celebs / Politicians / Disney / Marvel) is an
editorial act that:

- flips the project from neutral tool to **inducement/contributory liability**
  (the *MGM v. Grokster* line),
- puts the **maintainer's** name on right-of-publicity / ELVIS-Act / NO-FAKES
  exposure,
- is the leading vector for the current voice-scam fraud wave.

So: keep the neutral importer, drop the curated celebrity taxonomy, lead with
synthetic archetypes.

---

## 2. The binding engine constraint

`omnivoice/utils/voice_design.py` defines the **complete validated instruct
vocabulary**. `model.generate(instruct=...)` runs `_resolve_instruct`, which
rejects any token outside it with `ValueError` (this caused issue #89). The
entire expressive palette:

| Axis | Valid tokens | Exclusivity |
|------|--------------|-------------|
| Gender | `male`, `female` | one-of |
| Age | `child`, `teenager`, `young adult`, `middle-aged`, `elderly` | one-of |
| Pitch | `very low pitch`, `low pitch`, `moderate pitch`, `high pitch`, `very high pitch` | one-of |
| Style | `whisper` (the **only** style token) | optional |
| Accent (EN-only) | american, british, australian, chinese, canadian, indian, korean, portuguese, russian, japanese | one-of |
| Dialect (ZH-only) | 河南话, 陕西话, 四川话, 贵州话, 云南话, 桂林话, 济南话, 石家庄话, 甘肃话, 宁夏话, 青岛话, 东北话 | one-of |

**Critical:** there is **no emotional/descriptive style axis** (no "calm",
"raspy", "warm" like ElevenLabs' `descriptive`). We cannot 1:1 import ElevenLabs
voices. We borrow their **structure** (use-case categories + facet filters) and
their **demographic facets** (age/gender/accent map directly), not their style
vocabulary. Accent (EN) and dialect (ZH) are mutually exclusive — never combined
in one instruct.

### Scale (how we reach "hundreds")

Legal English space ≈ gender(2) × age(5) × pitch(5) × accent(11 incl. neutral) ≈
**550**, ~doubled by the `whisper` modifier. Pruned to plausible combos →
**~300–500 English archetypes**. Chinese-dialect space (gender × age × pitch ×
12 dialects) adds **hundreds more**. This matches ElevenLabs-scale breadth via
demographic/vocal variety rather than emotional variety.

---

## 3. Taxonomy (replaces celebs/politicians/disney/marvel)

Seven **use-case** categories (mirrors ElevenLabs, real-person-free):

`narration` Narration & Story · `conversational` Conversational ·
`characters` Characters & Animation · `social` Social Media ·
`entertainment` Entertainment & TV · `advertisement` Advertisement ·
`informative` Informative & Educational

**Facet filters:** Gender · Age · Pitch · Accent · Whisper · Language (EN / ZH).

Featured archetypes carry a curated, human-assigned `use_case`. Browse-all
archetypes get a **heuristic** primary `use_case` (documented as approximate)
derived from their facets, so use-case filtering still works across the full set.

---

## 4. Architecture

### 4.1 Information architecture

Gallery tab has two zones (top toggle):

- **Archetypes**
  - **Featured** — ~24 curated archetypes, pre-rendered preview WAVs, grouped by use-case.
  - **Browse all** — generated several-hundred set; facet-filterable; previews rendered on-demand + cached.
- **My Imports** — neutral URL/file importer (repurposes existing yt-dlp + `AudioTrimmer` flow), no curated categories.

### 4.2 Archetype model (value object — NOT a DB row)

```python
{
  "id": str,            # stable: short hash of (instruct + language)
  "name": str,          # "British · Middle-aged · Low — Narrator" (generated) or curated
  "icon": str,
  "use_case": str,      # one of the 7 ids
  "instruct": str,      # comma-joined valid tokens — guaranteed to pass the validator
  "attrs": {Gender, Age, Pitch, Style, EnglishAccent, ChineseDialect},  # drives the design sliders
  "facets": {gender, age, pitch, accent, whisper, lang},                # drives filters
  "sample_script": str,
  "preview_url": str | None,   # set for featured (pre-rendered); None => render on demand
  "is_featured": bool,
  "language": "English" | "Chinese",
}
```

### 4.3 Backend

- **NEW** `backend/core/archetypes.py`
  - `USE_CASES`, `FEATURED` (~24, extends the personalities pattern).
  - `generate_archetypes()` — walks the validator's own sets, prunes implausible
    combos via a rules table, auto-names, assigns heuristic use-case, builds
    guaranteed-valid instruct strings. Deterministic order + stable IDs.
  - `list_archetypes(filters)`, `get_archetype(id)`, `categories()`.
  - Imports the vocab from `omnivoice/utils/voice_design.py` (single source of truth).
- **NEW** `backend/api/routers/archetypes.py`
  - `GET /archetypes/categories`
  - `GET /archetypes?use_case=&gender=&age=&pitch=&accent=&whisper=&lang=&featured=&limit=&offset=`
  - `GET /archetypes/{id}`
  - `GET /archetypes/{id}/preview` — serve pre-rendered WAV if present; else render
    via the voice-design engine and cache to disk keyed by instruct hash.
  - `POST /archetypes/{id}/use` — render a sample → create a `voice_profile`
    (rendered WAV as `ref_audio`, archetype `instruct`/`language`) → return profile id.
  - Register in `backend/main.py` alongside the other routers.
- **Preview cache** — `OUTPUTS_DIR/archetype_previews/<hash>.wav`, served via a new
  static mount or `FileResponse`. Pre-rendered featured WAVs live under
  `backend/assets/samples/voice_design/` (served at `/demo_audio`, existing mount).
- **Importer (repurpose `gallery.py`)** — drop the celeb `CATEGORIES` constant;
  `voice_gallery` table now backs only "My Imports". `/gallery/search/youtube`
  stays but is driven by a user-supplied URL/query (no celeb default). No
  age-gate cookie bypass is added.
- **Constraint:** `POST /profiles` *requires* `ref_audio`, so "use archetype"
  must render a WAV first — handled inside `/archetypes/{id}/use`.

### 4.4 Frontend

- **Rewrite** `frontend/src/pages/VoiceGallery.jsx` — zone toggle, facet filter
  bar, featured grid, browse grid with lazy preview, card actions. Remove the
  celeb `CATEGORY_ICONS` map.
- **NEW** `frontend/src/api/archetypes.ts` + hooks in `frontend/src/api/hooks.ts`
  (`useArchetypeCategories`, `useArchetypes(filters)`), following the existing
  react-query `queryKeys`/`useQuery` pattern.
- **NEW** `frontend/src/store/gallerySlice.ts` — favorited archetype IDs
  (persisted), active filters, active zone, view mode. Registered in
  `store/index.ts`. (Archetypes aren't in the DB, so favorites live client-side.)
- **Card actions:** **Preview** (play WAV) · **Use voice** (primary →
  `POST /archetypes/{id}/use` → profile, usable everywhere) · **Open in Designer**
  (secondary → `setInstruct` + `setVdStates` + switch to Design tab) · **Favorite**.

### 4.5 i18n

All new strings → `archetypes.*` and existing `gallery.*` keys; `en.json`
authoritative, other 20 locales fall back to English until translated. Chinese
dialect display names are functional model vocabulary — add to the
`test_no_hardcoded_cjk.py` allowlist with justification, do not inline elsewhere.

---

## 5. Decisions locked

1. Catalog approach: **C (Hybrid)** — ~24 curated featured + generated browse-all.
2. Categories: **trait/use-case**, replacing all named-real-person buckets.
3. Primary card action: **Use voice (save as profile)**; Designer secondary.
4. Browse-all previews: **on-demand render + disk cache** (no pre-rendering hundreds).
5. Featured previews: **pre-rendered WAVs** via `render_demos_omnivoice.py`.

---

## 6. Cross-platform / constraints compliance (CLAUDE.md)

- **Default-feature parity (strict):** archetype browse + on-demand preview +
  "use voice" behave identically on macOS/Windows/Linux (pure Python synth +
  static assets — no OS-specific code). The yt-dlp importer is the one
  platform-variable surface → surfaced as a status; importer degrades gracefully
  if yt-dlp/ffmpeg absent. No default behavior diverges by platform.
- **Backward-compatible data:** no schema change to `voice_profiles`; `voice_gallery`
  table reused as-is. No alembic migration required. Existing profiles/imports untouched.
- **Local-first:** no network calls except the user-initiated importer download.
- **Versioning:** ships on v0.3.0; no version chatter.

---

## 7. Phased implementation plan

**Phase 1 — Archetype engine (TDD).** `backend/core/archetypes.py` +
`backend/tests/test_archetypes.py`. Tests first: (a) every generated `instruct`
is composed only of tokens in the validator's `_INSTRUCT_ALL_VALID` set and obeys
one-per-category exclusivity; (b) accent and dialect never co-occur;
(c) generated count is in the hundreds; (d) implausible combos pruned
(no `child` + `very low pitch`, no `elderly` + `very high pitch`); (e) IDs unique
& stable across runs; (f) featured entries valid + carry use_case + script.

**Phase 2 — Archetype API.** `backend/api/routers/archetypes.py` + register in
`main.py` + preview cache dir. Tests: categories, list + each filter, pagination,
404s, `/preview` for a pre-rendered featured id, `/use` happy path
(model-gated/skipped where weights absent).

**Phase 3 — De-celebrify importer.** Strip celeb `CATEGORIES` from `gallery.py`
and the `'celebs'`/`'famous voice'` defaults in the frontend; keep upload/trim/
save-as-profile. Update affected tests.

**Phase 4 — Frontend data layer.** `api/archetypes.ts`, hooks, `store/gallerySlice.ts`,
register slice. Type-check + unit tests for the slice/util.

**Phase 5 — Frontend UI.** Rewrite `VoiceGallery.jsx`: zone toggle, facet bar,
featured + browse grids, lazy preview, card actions, My Imports importer.

**Phase 6 — i18n.** Add `archetypes.*` keys to `en.json`; verify no hardcoded CJK
outside the allowlist.

**Phase 7 — Featured preview assets.** Extend `render_demos_omnivoice.py` to
render the ~24 featured WAVs (dev-box step, seed-fixed). Featured fall back to
on-demand render if a WAV is missing.

**Phase 8 — Verify.** Backend pytest, frontend typecheck/test/lint,
`test_no_hardcoded_cjk.py`, manual smoke of the gallery tab.

---

## 8. Out of scope

- Project-authored celebrity/character directory.
- Auto age-gate / cookie bypass for scraping.
- Emotional-style instruct tokens (engine doesn't support them).
- GitHub-App auto-submit path for bug reports (unrelated).
