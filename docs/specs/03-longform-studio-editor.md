# Implementation Spec — 03: Long-form "Studio" Editor (per-segment edit · regenerate-one-line · reassign-voice · emotion/timing)

> Status: draft for owner review · Target line: **v0.3.x** (continuous-to-main, no RC) · Surfaces: Dub, Audiobook, Stories
> Foundation: this is **90% a great editor UX + gap-filling on top of machinery that already exists**. Dubbing already content-addresses segments and regenerates exactly one line; the work is (a) lifting that pattern to the longform (Audiobook/Stories) renderer, which today only caches at *chapter* granularity, and (b) unifying the editor affordances to the ElevenLabs "Studio" bar.

---

## Context & Problem

### The gap vs ElevenLabs Studio / Dubbing Studio

ElevenLabs has converged its "pro polish" loop into two editors that OmniVoice partially matches and partially does not:

- **Studio (Projects / Audiobooks)** — paste a manuscript, see chapters laid out, assign different voices per character/paragraph, and make **surgical edits without regenerating everything**: a *Replace voice* pop-up tells you *how many paragraphs* will be re-rendered, and editing one fragment re-renders only that fragment ([Studio overview](https://elevenlabs.io/docs/eleven-creative/products/studio), [change voice across paragraphs](https://help.elevenlabs.io/hc/en-us/articles/23370957112721-How-can-I-change-the-voice-and-settings-across-multiple-paragraphs-in-Studio), [Audiobooks](https://elevenlabs.io/docs/eleven-creative/products/audiobooks)).
- **Dubbing Studio** — transcript **and** translation are edited inline in speaker cards; a clip carries a **"stale" badge** when its text/settings/length change; you **regenerate one clip** (refresh icon) or *Generate Stale Audio* in bulk; you **reassign a clip to another speaker** by dragging it to that track; and you adjust **timing** by dragging clip handles / Split / Merge ([Dubbing Studio](https://elevenlabs.io/docs/eleven-creative/products/dubbing/dubbing-studio)).

OmniVoice today is **asymmetric** across its three longform surfaces:

| Capability | Dub | Stories | Audiobook |
|---|---|---|---|
| Per-line text edit | ✅ `DubSegmentRow.jsx` (text 232–252, restore 253–273) | ✅ per-line `<textarea>` (`StoriesEditor.jsx:712–720`) | ❌ one script `<textarea>` only (`AudiobookTab.jsx:227–233`) |
| Per-line voice/speaker reassign | ✅ profile `<select>` (288–313) + speaker_id (213–224) | ✅ per-line voice override (734–742) + cast panel | ⚠️ only via inline `[voice:NAME]` markup typed in the blob |
| Per-line emotion/direction | ✅ `direction` (split/direction menu 335–383) | ✅ `emotion` tone tags (tune drawer 773–795) | ❌ none |
| Per-line timing / fit | ✅ fit strategies + fit badges (`DubSegmentRow.jsx:74–105`) | n/a (longform has no slots) | n/a |
| **Stale badge + regenerate ONE line** | ✅ `plan_incremental` + `regen_only` + "Regen changed (N)" (`DubTab.jsx:781–786`) | ❌ no incremental — server **re-streams the whole plan** on every export | ❌ chapter-cache only; editing one span re-keys the **whole chapter** |
| Re-stitch / re-mux after a partial edit | ✅ `dub_generate` always rebuilds `dubbed_{lang}.wav`; mux is lazy in `dub_export` | ❌ full re-render | ⚠️ resume reuses *unchanged chapters* but never sub-chapter |

### What already exists in-repo (the foundation we build on)

The dub pipeline **already** content-addresses segments so that editing one line re-synthesizes only that line:

- **`backend/services/incremental.py`** — `segment_fingerprint(seg)` (52–67) is a sha1 over the **generation inputs that actually affect TTS output**: `_GEN_INPUT_FIELDS = ("text","target_lang","profile_id","instruct","speed","direction","effect_preset")` (line 23). `_canon_value` (32–49) normalizes None/""/missing and int↔float so the **server-parsed view** and the **client-raw view** of the same logical segment hash identically — the root-cause fix for #281 ("1 edit re-dubs all N lines"). `fit_fingerprint(params)` (101–116) hashes the **fit configuration separately and on purpose** (70–76): a fit-knob change must trigger a **re-mix** of already-rendered natural-rate WAVs (`regen_only=[]`), never a re-TTS. `plan_incremental(segments, *, stored_hashes)` (119–157) returns `{stale, fresh, total, fingerprints}`.
- **`backend/api/routers/dub_generate.py`** — honors `regen_only` (113): for a segment **not** in `regen_only` it reloads the cached `dub_seg_path(job_id, seg_id)` (160–197, with a legacy index-name fallback at 162–166) instead of re-running TTS; for stale segments it runs `_gen(...)`. After the loop it **always re-stitches the full `dubbed_{lang}.wav`** (766–770) and persists `job["seg_hashes"]` (498–512) + `seg_order` (127). The `done` SSE ships `seg_hashes`/`seg_num_step` back (840). Strategy-transition guard (122–123) and `seg_wav_kind` (830) keep smart_fit reuse correct.
- **`tests/test_redub_incremental.py`** — already asserts the contract end-to-end with a mocked TTS engine: `test_edited_line_produces_different_cached_output` (228–281) proves an edited line's cached WAV changes, the **untouched line's cached WAV is reused byte-for-byte** (272–273), TTS ran exactly once (266), and the final track was rebuilt (281). `test_one_edit_marks_exactly_one_segment_stale` (101–118) proves the planner.
- **Per-segment audio + metadata keying.** Audio lives on disk as `{DUB_DIR}/{job_id}/seg_{seg_id}.wav` via `dub_seg_path(job_id, seg_id)` (`backend/core/config.py:54–71`). Metadata lives in the job's `job_data` JSON blob (`dub_history` table, `backend/core/db.py:74–85`), holding `segments`, `seg_order`, `seg_hashes`, `seg_num_step`, `seg_wav_kind`, `dubbed_tracks`, `fit_plans`, `video_stretch_plans`. Stable ids are minted at transcribe time (`s{NNNNN:05x}`, `dub_core.py:600`). Job persistence is `dub_pipeline.get_job`/`save_job`/`put_job` (`backend/services/dub_pipeline.py:158–214`).
- **Longform (Audiobook + Stories) share one renderer** `_render_longform_sse` (`backend/api/routers/audiobook.py:403–595`) and one **chapter-level** content-addressed key `chapter_cache_key` (`backend/services/longform_render.py:110–136`), cached under `OUTPUTS_DIR/longform_cache` (`_render_chapter_cached`, `audiobook.py:314–355`). The lexicon is folded into the key (338–341). Resume (`audiobook.py:714–759`) reuses already-rendered chapters because the key is content-based. **But the granularity is the whole chapter** (longform_render.py:117–125) — that is the gap.

**Conclusion:** Dub is the reference implementation. Stories already has the *editor UI* but no incremental backend. Audiobook has neither a per-line editor nor sub-chapter incrementality. This spec makes all three behave like a "Studio" by (1) standardizing the editor affordances and (2) pushing the dub-proven `fingerprint → stale → regen_only → re-stitch` loop down into the longform renderer at **span granularity**.

---

## Goals / Non-goals

### Goals
1. **Per-segment edit across all three surfaces**: edit a line's **text** (and, for dub, its **translation** independently of the source text), change its **assigned voice/speaker**, set per-segment **emotion/style** (composes with the emotion/style field — see "Composition with emotion/style"), and adjust **timing** (dub only: fit/slot).
2. **A visible "stale" badge + "regenerate this one line"** affordance on every surface, mirroring Dubbing Studio's refresh-icon + *Generate Stale Audio*. Editing a line invalidates **exactly one fingerprint** and triggers a **single-segment regen + re-stitch/re-mux**; unchanged lines are cache-hits (reused byte-for-byte).
3. **Reuse the existing machinery, don't reinvent it.** Dub keeps `plan_incremental`/`regen_only`. Longform gets a **span-level** twin of `chapter_cache_key` so editing one span re-synthesizes one span, not the chapter.
4. **A unified editor *contract*** (stale model, regen verb, voice-reassign affordance, the "N lines will regenerate" preview) shared in concept across surfaces, while respecting each surface's distinct timing model.
5. **Zero forced re-render of existing projects.** Existing `omnivoice_data/` dub jobs, story projects, and audiobook renders keep working untouched; new keying degrades gracefully to "treat as stale once" rather than corrupting cached audio.
6. **Local-first, cross-platform parity preserved**, docs-sync in the same PR.

### Non-goals (explicitly deferred)
- **A timeline/waveform DAW view.** ElevenLabs reassigns a speaker by dragging a clip between tracks on a timeline; OmniVoice reassigns via the existing per-row `<select>`. No timeline canvas, no clip-drag-to-track, no multi-track audio lanes in this spec. (Split/Merge already exist in `DubSegmentRow.jsx`.)
- **New TTS engines or new emotion *models*.** This spec consumes whatever emotion/style field exists; it does not add a new style engine.
- **Sub-chapter resume of an *interrupted* render.** Resume stays chapter-granular (`audiobook.py:714–759`); span-level incrementality is for *edits*, not for crash recovery, in this milestone.
- **Collaborative / multi-user editing.** Local-first, single-user.
- **Audiobook/Stories *slot* timing.** Longform has no per-line time slots (it's narration, not lip-sync); per-segment *timing* is a **dub-only** capability here. Longform "timing" is limited to the existing `[pause]` markers and per-line `speed`.
- **Changing the dub fingerprint contract.** `segment_fingerprint`'s field set is stable (back-compat tested in `test_redub_incremental.py:87–98`); emotion/style integration extends it **only if** the field genuinely affects TTS output (see Open Questions Q1).

---

## User Experience

The three surfaces converge on **one mental model — "edit a line, see it go stale, regenerate just that line"** — but keep surface-appropriate controls.

### Shared "Studio" affordances (all surfaces)
- **Stale badge.** A line whose generation inputs changed since its last successful render shows an amber **"changed"** chip (mirrors Dubbing Studio's stale state). Derived from `fingerprint(line) ≠ stored_hash[line.id]` — the dub planner today.
- **Regenerate-this-line.** A per-row **↻** button regenerates only that line, then re-stitches. Disabled (no-op) when the line isn't stale.
- **Regenerate-changed (bulk).** A header button **"Regenerate changed (N)"** counts stale lines and regenerates exactly those (dub already has this — `DubTab.jsx:781–786`; Stories/Audiobook gain it).
- **"This will regenerate N lines" preview.** When a change has fan-out (e.g. reassigning a *cast* voice that M lines inherit, or editing the pronunciation lexicon that affects K chapters), a confirm step states the count before clearing that audio — ElevenLabs' *Replace voice* pop-up pattern.
- **Instant preview vs final export.** A line-level **▶ preview** renders that one line quickly (low step count, no watermark/mux) and is *not* persisted; the **final** render/export re-stitches and re-muxes the full artifact. Dub already splits these (`preview_segment`, `dub_generate.py:867–951`; preview is `preview: true`, no disk write, 8 steps).

### Dub surface (extend, don't rebuild)
`DubTab.jsx` + `DubSegmentRow.jsx` already implement nearly all of this. Remaining UX work is **polish + parity**:
- **Independent translation edit.** Today text edit + restore-original exists (`DubSegmentRow.jsx:232–273`); make the **transcript (`text_original`)** and the **translation (`text`)** independently editable in the row, with a **↻ re-translate this line** affordance routing to `dub_translate` (`dub_translate.py:222`) for one id, then marking the line stale. (ElevenLabs: edit transcript *or* translation freely.)
- **Reassign speaker** keeps the per-row speaker `<select>` (213–224) and the per-row voice override (288–313); changing either flips the fingerprint via `profile_id` and goes stale.
- **Timing** keeps the existing fit strategy + fit badges (`smart_fit`/`concise`/`stretch_video`/`strict_slot`, `DubSegmentRow.jsx:74–105`). A **fit-knob** change re-mixes (not re-TTS) via the existing `fit_fingerprint` path. Split/Merge/Direction stay (335–383).
- Emotion/style → the per-segment **direction** field (already a fingerprint input).

### Stories surface
`StoriesEditor.jsx` already has the richest line editor (per-line text, per-line voice override, emotion tone tags, per-line speed, per-line preview). The **only** missing piece is the *incremental backend*: today `generateAll` (374–409) POSTs the whole plan to `/longform/render` and re-streams everything. New UX:
- Each track card gains the shared **stale chip** + **↻ regenerate this line** + header **"Regenerate changed (N)"**.
- Single-line preview stays client-side (`previewTrack`, 301–352) — unchanged.
- Full export switches from "always full render" to "render with `regen_only`": only stale spans re-synthesize; fresh spans reuse cached span WAVs. Reassigning a **cast** voice shows the "N lines inherit this voice and will regenerate" confirm.

### Audiobook surface
`AudiobookTab.jsx` is the least mature — a single script `<textarea>` (227–233) with only per-*chapter* audition (372–397). It gets the biggest UX uplift:
- **A segment/transcript view** for the parsed plan: render `AudiobookPlan.chapters[].spans[]` (the parser already produces spans — `audiobook.py:80–94`, `Span` at `services/audiobook.py:28–43`) as an editable list **under each chapter heading**, each span row carrying: editable text, a per-span **voice `<select>`** (writes back as inline `[voice:NAME]` so the script blob stays the single source of truth — see Technical Design), an emotion/style affordance, and the shared **stale chip + ↻**.
- Editing a span edits the underlying script blob region; the plan re-parses; **only the edited span goes stale**, not the chapter.
- Per-chapter audition stays; per-*span* preview is added (reuses the longform single-span render path).
- The single-blob textarea remains available as a "raw script" toggle for power users; the structured view is the default. (Both bind to the same `script` string per the `LongformProject` store, spec 31.)

---

## Technical Design

### Principle: one cache contract, two implementations

Dub and longform both reduce to: **`fingerprint(unit) → diff vs stored → regen the stale units → reuse cached unit audio for the rest → re-stitch/re-mux the whole artifact`**. Dub's `unit` = dub segment (already shipped). Longform's `unit` becomes the **span** (new). We do **not** force them onto one code path — their timing/mux differ — but they share `incremental.py`'s primitives and the same persisted-hash discipline.

### Part A — Dub (extend existing, minimal change)

The edit → single-segment-regen → re-stitch flow already exists and is tested. Deltas:

1. **Independent transcript/translation edit.** `DubSegment` already has `text` (translation) and the job carries `text_original` (set in `dub_core.py:601`, preserved by `_sync_job_segments`, `dub_generate.py:51–88`). Expose `text_original` as an editable field on the row; **only `text` is a fingerprint input** (incremental.py:23), so editing the *transcript* alone does **not** force a re-TTS unless the user re-translates. A **per-line re-translate** calls `POST /dub/translate` (`dub_translate.py:222`) for that single id; the returned `text` flips the fingerprint → the line goes stale → user clicks ↻.
2. **No fingerprint change needed** for voice/speaker/direction/effect — all already in `_GEN_INPUT_FIELDS`. Timing/fit already routes through `fit_fingerprint` (re-mix, not re-TTS).
3. **Re-mux** stays lazy in `dub_export.py` (download/preview endpoints, `dub_download` 366–740, `dub_preview_video` 789–1034), driven by the persisted `fit_plans`/`video_stretch_plans`. A single-segment regen only rebuilds `dubbed_{lang}.wav`; the video re-mux happens on next download/preview, gated by plan-staleness helpers (`_video_retime_plan_for` 260–277).

> Net dub change is small: a transcript field + a single-id re-translate call. The heavy lifting (`regen_only`, `seg_hashes`, re-stitch) is untouched.

### Part B — Longform (the real new machinery): span-level incremental

Today `_render_chapter_cached` (`audiobook.py:314–355`) keys the **whole chapter** with `chapter_cache_key` (`longform_render.py:110–136`). We add a **span-level** key and a span cache, then make `_render_longform_sse` reuse fresh span WAVs and re-synthesize only stale ones.

**New: `span_fingerprint` + span cache** (in `backend/services/longform_render.py`, alongside `chapter_cache_key`):
- `span_fingerprint(span, *, engine_id, sample_rate, voice_sig, lexicon) -> str` — sha1 over the inputs that affect a span's rendered audio: `(voice_id, text, pause_ms_after, speed, emotion/style, lexicon-respelling-of-text, engine_id, sample_rate, voice_sig)`. This is the **longform twin of `segment_fingerprint`**; it deliberately mirrors the dub field discipline (same #281 canonicalization rules — reuse `incremental._canon_value` so int↔float / None↔"" parity holds).
- Span audio cached at `OUTPUTS_DIR/longform_cache/span_{key}.wav` (sibling to the existing chapter WAVs). The chapter WAV becomes a **stitch of its span WAVs** (crossfade + inter-span silence already done by `synthesize_chapter`, `services/audiobook.py:97–141`) rather than a single monolithic render. `chapter_cache_key` is retained for the **final stitched chapter** (so resume still hits at chapter granularity), but the chapter render now internally reuses fresh span WAVs.

**Refactor `synthesize_chapter`** (`services/audiobook.py:97–141`) so each span renders through a `render_span(span) -> tensor` that first checks the span cache by `span_fingerprint`; on hit it loads the WAV, on miss it runs the injected `synth` and writes the WAV. The function already iterates spans and stitches (121–139) — we wrap the per-span synth call (125) in the cache check. **This is the exact analog of dub's per-segment cache-load-or-`_gen` branch** (`dub_generate.py:160–199`).

**New: `regen_only` for longform.** `_render_longform_sse` (`audiobook.py:403`) and the `POST /audiobook` / `POST /longform/render` request bodies accept an optional `regen_only: list[str]` (span ids) + `stored_span_hashes: dict[str,str]`. When present:
- Spans **not** in `regen_only` and whose stored hash matches → **cache-hit**, reuse WAV.
- Spans in `regen_only` (or all spans, when omitted = today's behavior) → re-synthesize.
- The chapter is re-stitched from the (mostly cached) span WAVs; the book is re-muxed (the existing `build_ffmetadata` + concat-demux mux, `audiobook.py:536` / `services/longform_render.py`).
- Emit `seg_hashes`-equivalent (`span_hashes`) in the `done` SSE so the client persists them, exactly like dub's `done` payload (`dub_generate.py:840`).

**Span identity.** Longform spans need **stable ids** the way dub segments do (`s{NNNNN:05x}`). The longform parser (`services/longform_parser.parse_script_to_spans`, wrapped at `audiobook.py:80–94`) currently emits positional spans with no id. We add a **deterministic span id** derived from `(chapter_index, span_index)` *plus a content-stable suffix*, OR — preferred — mint stable ids in the parser and thread them through `Span` (`services/audiobook.py:28–43`, add `id: Optional[str]`). For Stories, the track card already has a stable `id` (`makeTrack`, `StoriesEditor.jsx:91–94`) → `storyToSpans` (`utils/storyToSpans.js:27–60`) threads it onto the span. The id is what `regen_only` addresses.

> **Why not just keep chapter keys?** Because a 30-page chapter re-synthesizing on a one-word fix is exactly the wall this spec closes. Span keying makes "fix one sentence" cost one sentence — the ElevenLabs bar.

### Composition with emotion/style (per-segment)

Assume a per-segment emotion/style field exists (dub: `direction`; stories: `emotion` track field, `StoriesEditor.jsx:91–94`; audiobook: to be added per-span). Integration rule, derived from the existing `fit_fingerprint` precedent:

- **If the field changes the TTS *output*** (e.g. an instruct/direction string fed to the engine) → it is a **fingerprint input**. Dub already includes `direction` (incremental.py:23; `test_direction_change_flips_fingerprint`, `test_redub_incremental.py:131–134`). Longform `span_fingerprint` includes the emotion/style field symmetrically.
- **If the field is post-processing only** (a DSP/effect knob that re-mixes already-rendered audio) → it belongs in a **separate** fit-style fingerprint that triggers a re-mix, not a re-TTS — exactly how `fit_fingerprint` (incremental.py:70–116) is kept *out* of `segment_fingerprint`.

This composes cleanly with a future emotion/style spec: whichever bucket the field falls into, the fingerprint discipline already has a slot for it. (Owner decision Q1.)

### Edit → single-segment-regen → re-stitch/re-mux (end-to-end)

```
User edits line L's text / voice / emotion  (any surface)
   │
   ├─ client recomputes fingerprint(L)  → ≠ stored_hash[L.id]  → L shows "stale" chip
   │     (dub: segment_fingerprint; longform: span_fingerprint — same canonicalization)
   │
User clicks ↻ (one line) or "Regenerate changed (N)"
   │
   ├─ DUB:      POST /dub/generate/{job} { segments, segment_ids, regen_only:[L.id], preview:false }
   │              → dub_generate reuses cached seg_{id}.wav for all but L (dub_generate.py:160–197)
   │              → re-TTS L only (_gen) → re-stitch dubbed_{lang}.wav (766–770)
   │              → persist seg_hashes[L.id] (498–512) → done SSE returns new hashes (840)
   │              → re-mux is lazy on next /dub/download (dub_export.py:366–740)
   │
   └─ LONGFORM: POST /audiobook (or /longform/render) { chapters, regen_only:[L.id], stored_span_hashes }
                  → _render_longform_sse reuses span_{key}.wav for fresh spans
                  → re-synthesize L only → re-stitch L's chapter → re-mux m4b/mp3 (audiobook.py:536)
                  → done SSE returns span_hashes  → client persists them
```

Both paths **always rebuild the full final artifact** from a set that is mostly cache-hits — the dub invariant proven by `test_redub_incremental.py:280–281` (final track rebuilt) generalizes to longform's m4b/mp3.

### Files to extend (with paths)

| File | Change |
|---|---|
| `backend/services/incremental.py` | Add `span_fingerprint(...)` (or factor a shared `_fingerprint(fields, canon)` core that both `segment_fingerprint` and `span_fingerprint` call). Reuse `_canon_value`. |
| `backend/services/longform_render.py` | Add span-level key + `span_{key}.wav` cache load/write helper; keep `chapter_cache_key` for the stitched chapter. |
| `backend/services/audiobook.py` | `Span` gains stable `id`; `synthesize_chapter` (97–141) wraps per-span synth in span-cache load-or-render. |
| `backend/api/routers/audiobook.py` | `_render_longform_sse` (403–595) honors `regen_only` + `stored_span_hashes`; `POST /audiobook` (598–610) + `POST /longform/render` (639–667) accept them; `done` SSE emits `span_hashes`. |
| `backend/services/longform_parser.py` (+ `frontend/src/utils/longformParser.js` twin, byte-for-byte per #27) | Mint stable span ids. **Both must change together** (the JS twin is golden-corpus-verified). |
| `backend/api/routers/dub_translate.py` | Allow a **single-id** re-translate (already id-keyed, `dub_translate.py:222`); ensure one-segment requests are cheap. |
| `frontend/src/components/DubSegmentRow.jsx` | Expose editable `text_original` (transcript) distinct from `text` (translation); add per-line re-translate. |
| `frontend/src/pages/AudiobookTab.jsx` | New structured span/transcript view over `AudiobookPlan`; per-span text/voice/emotion edit + stale chip + ↻; raw-script toggle retained. |
| `frontend/src/components/StoriesEditor.jsx` | Add stale chip + ↻ + "Regenerate changed (N)"; `generateAll` (374–409) sends `regen_only`/`stored_span_hashes`. |
| `frontend/src/utils/storyToSpans.js` | Thread track `id` → span `id`. |
| `frontend/src/store/longformSlice.ts` (per spec 31) | Persist `span_hashes` alongside the project (the localStorage analog of `job_data.seg_hashes`). |

---

## API / Schema / Data-model changes

### New / extended request fields (additive, all optional → back-compat)
- **`DubSegment`** (`backend/schemas/requests.py:19–43`): unchanged field set; `text_original` is carried in the job, not the segment fingerprint. (No schema change required for dub — the transcript edit reuses existing job state.) If exposed in the request, add `text_original: Optional[str] = None` (additive, defaulted → old payloads parse unchanged).
- **Longform render bodies** (`LongformChapter`/`LongformSpan` Pydantic models, `audiobook.py:615–636`; `AudiobookSynthesizeRequest`): add `regen_only: Optional[list[str]] = None` and `stored_span_hashes: Optional[dict[str,str]] = None`. `LongformSpan` gains `id: Optional[str] = None`. All defaulted → existing clients unaffected.

### Endpoints
- **Reuse** `POST /dub/generate/{job_id}` (`dub_generate.py:93`) — already takes `regen_only`. No new dub endpoint.
- **Reuse** `POST /dub/translate` (`dub_translate.py:222`) for single-id re-translate (already id-keyed). No new endpoint.
- **Extend** `POST /audiobook` (`audiobook.py:598`) and `POST /longform/render` (`audiobook.py:639`) to honor `regen_only`/`stored_span_hashes`; `done` SSE adds a `span_hashes` field (additive — old clients ignore unknown keys, matching dub's `seg_hashes`/`seg_num_step` additive precedent at `dub_generate.py:840`).
- **New (optional, thin)** `POST /audiobook/preview-span/{job_id}` mirroring `dub_generate.py:867` `preview_segment` — fast single-span audition (low steps, no mux, no persist). Only if Stories' client-side preview (`previewTrack`) doesn't already cover the audiobook need; otherwise skip.

### Persistence
- **Dub**: no change. `seg_hashes`/`seg_order`/`seg_num_step` already live in `job_data` (`dub_history.job_data`, `db.py:74–85`), written by `_save_job` (`dub_pipeline.py:187–214`).
- **Longform**: span audio cached on disk under `OUTPUTS_DIR/longform_cache/span_{key}.wav` (content-addressed → self-cleaning, pruned by the existing `prune_cache_dir`, `audiobook.py:494`). **`span_hashes` persist client-side** in the `LongformProject` zustand store (spec 31, `longformSlice.ts`) — the localStorage analog of `job_data.seg_hashes`. **No new SQLite table, no alembic migration** for longform (it's filesystem cache + browser state). If the owner later wants server-side longform job rows to carry `span_hashes`, *that* would go through alembic — flagged as a non-goal here.
- **Migration / back-compat**: existing dub jobs already carry `seg_hashes` (or get them on next generate). Existing longform renders have **no** `span_hashes` → first edit treats all spans as stale **once** (the planner's "missing stored hash → stale" default, `incremental.plan_incremental` doc 134–136), which is safe (re-renders correctly, just not incrementally that one time). **No forced re-render** of any existing project on upgrade. No DB schema change → **no alembic migration needed**; the localStorage versioned `migrate` fn (spec 31) tolerates the absent `span_hashes` key.

### Preferences
- Per-surface toggle (Settings): "Default to structured editor view" (Audiobook), defaulting **on**. No network prefs. Stored in existing settings store.

---

## Local-first & Cross-platform compliance

- **Local-first preserved.** Every path is local: TTS/regen runs on-device (MPS/CUDA/ROCm/CPU auto-detect, unchanged); span/segment WAVs are local files; fingerprints are local sha1; `span_hashes` persist locally (job_data / localStorage). **No cloud call, no account, no API key, no telemetry** is added. The optional `POST /dub/translate` offline providers (nllb, argos) keep translation local; cloud LLM translation stays the user's existing opt-in.
- **Cross-platform parity (strict rule, 2026-05-20).** The editor + per-segment regen is **default behavior** and must be identical on macOS / Windows / Linux. The implementation uses only cross-platform pieces: `dub_seg_path`/cache paths use `os.path.join` + realpath containment (`config.py:54–71`, already cross-platform), ffmpeg mux is the existing cross-platform invocation (`build_render_cmd`), fingerprints are pure Python, and the UI is the existing Tauri/React stack. **No platform-only affordance** is introduced — no macOS-only shortcut, no Windows-only picker. The keyboard shortcuts already in `DubSegmentRow.jsx` (⌘D split / ⌘M merge, 335–383) must map to Ctrl on Windows/Linux (verify they already do; if not, that's a P0 parity fix in the same PR).
- **Existing-engine + existing-`omnivoice_data/` back-compat.** No engine code touched in a way that requires reinstall; on-disk model state untouched. Existing dub jobs, story projects, audiobook renders open and play unchanged; the only first-edit cost is one non-incremental regen (correct output, just not cached yet). Span cache is purely additive on disk.

---

## Phasing (sliceable milestones on the v0.3.x line)

Each slice is independently shippable, continuous-to-main, with its own regression test. Ordering puts the **lowest-risk, highest-leverage** work first (dub is already 90% there).

- **03a — Dub transcript/translation split + single-id re-translate.** Expose editable transcript (`text_original`) vs translation (`text`) in `DubSegmentRow.jsx`; per-line re-translate via `POST /dub/translate` for one id. Reuses existing `regen_only`. *Smallest, proves the "edit translation → one line stale → ↻" loop end-to-end on the surface that already supports it.*
- **03b — Longform span fingerprint + span cache (backend only, no UI).** `span_fingerprint` in `incremental.py`; span-cache load/write in `longform_render.py`; `synthesize_chapter` reuses fresh span WAVs; stable span ids in the parser (both twins). Gated by a test asserting **one edited span re-synthesizes; siblings cache-hit** (the dub test, lifted to longform).
- **03c — Longform `regen_only` wiring + `span_hashes` in the store.** `_render_longform_sse` + the two POST bodies honor `regen_only`/`stored_span_hashes`; `done` SSE emits `span_hashes`; `longformSlice` persists them.
- **03d — Stories editor: stale chip + ↻ + "Regenerate changed (N)".** Stories already has the row editor; just add the stale UX and switch `generateAll` to send `regen_only`. *First user-visible longform incrementality.*
- **03e — Audiobook structured span editor.** The big UX uplift: structured per-span view over `AudiobookPlan`, per-span text/voice/emotion edit, stale chip + ↻, raw-script toggle. Rides 03b/03c.
- **03f — Emotion/style-per-segment composition.** Wire the emotion/style field into `span_fingerprint` (re-TTS bucket) or a longform fit-style fingerprint (re-mix bucket) per the owner's Q1 decision; symmetric with dub's existing `direction`.

(03a, 03b can land in parallel; 03d depends on 03c; 03e depends on 03b+03c; 03f is last.)

---

## Testing strategy

**The load-bearing assertion (every surface): a single-line edit regenerates exactly one segment; all others are cache-hits.** This is already proven for dub — the new tests **lift that exact contract** to longform.

- **Reuse + extend `tests/test_redub_incremental.py`.** It already asserts the dub contract: `test_one_edit_marks_exactly_one_segment_stale` (101–118), `test_edited_line_produces_different_cached_output` (228–281: edited line's WAV changes, **untouched line's WAV reused byte-for-byte** 272–273, TTS ran exactly once 266, final track rebuilt 281). 03a adds a test that editing **only `text_original`** does *not* flip the fingerprint, but a re-translate that changes `text` does (composes with `test_direction_change_flips_fingerprint`, 131–134).
- **New `tests/test_longform_incremental.py`** (the centerpiece, mirrors the dub test with a stub `synth`):
  - `span_fingerprint` parity: server-parsed span vs client-raw span hash identically (the #281 class, reusing `_canon_value`).
  - **One-edit-one-span**: a 3-span chapter renders all 3; edit span 1's text; assert the planner marks **exactly** span 1 stale; regen reuses spans 0 and 2's cached WAVs **byte-for-byte**, re-synthesizes span 1 only (stub `synth` call-count == 1), and the re-stitched chapter WAV changed.
  - **Voice reassign**: changing a span's `voice_id` flips its fingerprint (and only its); a *cast*-level reassign that M spans inherit marks exactly M stale.
  - **Cross-chapter isolation**: editing a span in chapter 2 leaves chapter 1's cached chapter WAV untouched (chapter-key still hits).
  - **Lexicon edit fan-out**: editing a lexicon entry marks stale exactly the spans whose respelled text changed (composes with the lexicon-in-key behavior, `audiobook.py:338–341`).
- **Back-compat tests**: existing dub job with stored `seg_hashes` from an older build still matches (`test_backcompat_with_hashes_stored_by_previous_builds`, 87–98); an existing longform render with **no** `span_hashes` is treated as all-stale exactly once, then incremental thereafter — and produces byte-identical audio to a full render.
- **Cross-platform**: the cache-path/realpath tests run on all three OSes in CI; assert `span_{key}.wav` path construction and containment hold on Windows path separators.
- **Frontend**: a Playwright/unit test that editing one line shows the stale chip and that "Regenerate changed (N)" sends `regen_only` with exactly the stale ids.
- **Keep main green**: any `frontend/package.json` touch regenerates root `bun.lock` and passes `bun install --frozen-lockfile` (Docker parity); parser twin change re-runs the golden-corpus equality test (#27).

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Span-cache explosion** (one WAV per span per fingerprint → thousands of files for a long book). | Content-addressed names self-dedupe; reuse the existing `prune_cache_dir` (`audiobook.py:494`) with an LRU/size cap; only the *current* project's fresh spans are kept hot. |
| **Fingerprint parity drift** (server vs client hash differently → every span looks stale → degrades to full render, the #281 regression class). | Reuse `incremental._canon_value` verbatim; add the server-vs-client parity test first (TDD), exactly as dub did. |
| **Parser-twin divergence** (Python `longform_parser` vs JS `longformParser.js` mint different span ids). | Stable ids derived from `(chapter_index, span_index)` are computed identically in both; the existing golden-corpus byte-for-byte test (#27) gates it. |
| **Stitch seams** (per-span WAVs stitched may click vs a monolithic chapter render). | `synthesize_chapter` already crossfades spans (50 ms) and hard-concats silences (`services/audiobook.py:121–139`) — the seam behavior is identical whether a span was freshly rendered or cache-loaded (same WAV bytes). |
| **smart_fit-style double-processing on dub** (reusing a slotted WAV under smart_fit). | Already solved: the strategy-transition guard (`dub_generate.py:122–123`) + `seg_wav_kind` (830) force a full regen when the cached WAVs are the wrong kind. No new exposure. |
| **Existing projects forced to re-render.** | First edit treats unknown-hash spans as stale **once** (correct output), never corrupts cache; no upgrade-time mass re-render. |
| **Emotion/style field lands in the wrong fingerprint bucket** (re-TTS when it should re-mix, or vice-versa, wasting compute or shipping stale audio). | Q1 decision pins the bucket per field; the `fit_fingerprint` precedent (incremental.py:70–116) gives both buckets a tested home; 03f ships last, after the field's semantics are known. |

---

## Open questions / decisions for the owner

1. **Emotion/style field → which fingerprint bucket?** If the per-segment emotion/style field is fed to the engine as an instruct/direction (changes TTS output), it's a **`span_fingerprint`/`segment_fingerprint` input** (re-TTS on change). If it's a post-render DSP/style transfer (re-mix), it belongs in a **fit-style fingerprint** (re-mix, no re-TTS). Dub's `direction` is already the former. Please confirm the bucket per the emotion/style spec when it lands (drives 03f).
2. **Audiobook span ids vs the raw-script-blob single-source-of-truth.** Editing a span writes back inline `[voice:NAME]`/text into the `script` string (so the blob stays authoritative, per spec 31). Stable span ids derived from `(chapter_index, span_index)` shift when the user inserts a paragraph above. Acceptable to treat an inserted span as "new → stale" and shift downstream ids (cheap, correct), or do we want content-anchored ids? Recommendation: positional ids + "shifted = stale once"; revisit only if users report churn.
3. **Single-id re-translate cost.** `POST /dub/translate` (`dub_translate.py:222`) loads a translation model; a per-line re-translate pays that once per call. Cache the loaded model module-level (nllb already is, 232–306) so single-id calls are cheap — confirm acceptable, or batch re-translate the stale set instead of per-line.
4. **`POST /audiobook/preview-span` — build it or reuse client-side preview?** Stories previews client-side (`previewTrack`). If audiobook structured view needs server-side single-span audition, add the thin endpoint; otherwise reuse the client path. Owner call on whether the thin endpoint is worth it for 03e.
5. **Scope of "timing" for longform.** Confirmed non-goal: longform has no per-line slots, so per-segment *timing* stays dub-only; longform "timing" = existing `[pause]` + per-line `speed`. Flag if the owner wants longform pause/speed surfaced as first-class per-span timing controls (small add to the span row).
