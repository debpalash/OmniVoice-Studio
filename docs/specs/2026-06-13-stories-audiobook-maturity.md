# Stories Editor & Audiobook — Maturity Spec

> Compiled 2026-06-13. Targets the v0.3.x continuous-to-main line. Grounds every
> work item in the two features' current implementation (file:line refs below).

## 0. TL;DR — the central decision

Stories Editor and Audiobook are **two authoring frontends over the same job**:
*chapterized long-form TTS → a chapter-marked audio file*. Today they're built
on divergent stacks, and that divergence is the root cause of most maturity gaps:

| | Stories Editor | Audiobook |
|---|---|---|
| Render | **Client-side** Web Audio stitch (`decodeAudioData` per chunk, concat in RAM) | **Server-side** GPU pool → ffmpeg `.m4b` |
| State | localStorage only (`omnivoice.app`) | best-effort `job_store`, discarded on exit |
| Strength | multi-character dialogue, per-line voice/speed, auto-cast | chapter markers, SSE progress, scales to long books |
| Ceiling | can't render a 10-hour book (browser RAM, no resume, no loudness norm) | single textarea, no cover/metadata, no preview/retry/resume |

**Recommendation: converge on one server-side chapterized render core; keep two
distinct authoring frontends.** Stories Editor's "Generate full" compiles its
cast/lines into the same `Chapter[]`/`Span[]` model the Audiobook backend already
uses and submits the same job. This kills the duplication, lifts the browser
scale ceiling off Stories, and gives *both* features resume, loudness
normalization, cover art, and metadata for free.

Stories keeps its fast **client-side single-line preview** (low latency, no job
overhead). Only the full export moves server-side.

> **Alternative considered:** keep them fully separate and mature each stack
> independently. Rejected — it doubles the work (two metadata systems, two
> normalization paths, two resume mechanisms) and leaves Stories permanently
> unable to render book-length output. If the owner wants them kept separate,
> only §2 + §3-frontend apply and §1 is dropped.

---

## 1. Shared render core (new) — backend

**New module `backend/services/longform_render.py`**, generalizing the audiobook
pipeline (which already has the right shape).

- **Canonical job model** (already exists in `backend/services/audiobook.py:47-86`):
  `Project → Chapter(title, spans) → Span(voice_id, text, pause_ms_after)`.
  Promote it here; Audiobook and Stories both compile to it.
- **Reuse** `synthesize_chapter` (audiobook.py:140), `build_chapter_ffmetadata`
  (:186), `build_concat_list` (:207), `build_m4b_cmd` (:221). Generalize
  `build_*_cmd` to take metadata + cover + format.
- **Add capabilities** (each is a discrete, testable pure builder + a wiring step):
  1. **Global metadata** → FFMETADATA `[global]`: `title`, `artist` (author),
     `album`, `composer`/`narrator`, `date` (year), `genre`, `comment`.
  2. **Cover art** → ffmpeg `-i cover.jpg -map 2 -disposition:v attached_pic`
     (MP4 `COVR`). Validate image (size/type) server-side.
  3. **Loudness normalization** → two-pass ffmpeg `loudnorm` to an **ACX preset**
     (target ≈ -19…-21 LUFS integrated, ≤ -3 dB true peak, noise floor < -60 dB).
     Toggle + preset (`ACX` / `Podcast -16 LUFS` / `Off`).
  4. **Per-chapter checkpoint / resume**: cache each rendered chapter WAV keyed
     by `hash(span_texts + voice_ids + pauses + engine + voice refs)`. On retry,
     skip chapters whose hash already has a cached WAV → resume a failed/long job
     without re-rendering completed chapters.
  5. **Parallel chapter synth**: submit chapters to the existing `_gpu_pool`
     concurrently (bounded by pool size) instead of strictly sequential.
  6. **Output formats**: `m4b` (chaptered AAC, current), `mp3` (chaptered via
     ID3 CHAP frames), `per-chapter files` (zip), `stems` (one track per voice —
     Stories' existing stems concept, server-side).
- **Job persistence / library**: new alembic table `longform_jobs`
  (id, kind=`audiobook`|`story`, title, status, output_path, chapters json,
  metadata json, created_at). A finished book/story reappears in Projects/Library
  and is re-downloadable. Backward-compatible migration (additive table).

---

## 2. Audiobook tab — maturity (frontend + thin backend)

Anchors: `frontend/src/pages/AudiobookTab.jsx`, `frontend/src/api/audiobook.ts`,
`backend/api/routers/audiobook.py`, `backend/services/audiobook.py`.

**P0**
- **Metadata panel**: title, author, narrator, year, genre, description, **cover
  image** picker. Pipes to §1.1/§1.2.
- **Per-chapter preview**: render a single chapter (new `POST /audiobook/preview`
  reusing `synthesize_chapter`) so users audition before committing the full book.
- **Chapter-level retry**: a failed chapter doesn't kill the job; mark it, let the
  user re-run just that chapter (uses §1.4 checkpoints).
- **Resume**: reconnect to / restart an interrupted job, skipping cached chapters.
- **Loudness-norm toggle** (ACX preset default-off; explicit opt-in).

**P1**
- **Import → auto-chapter**: `.txt` (split on `# H1` / `^Chapter \d+`), **EPUB**
  (spine + TOC → chapters; local parse, no network), drag-drop file.
- **Pronunciation lexicon**: per-project word→phoneme/respelling overrides applied
  pre-synthesis (shared with Stories).
- **ETA + richer progress** (chapters done / total, elapsed, est. remaining).

**P2**
- SSML-lite (`[emphasis]`, `[slow]`/`[fast]`, `[spell]`) mapped to engine instruct
  + chunk rate. Batch (queue multiple books).

---

## 3. Stories Editor — maturity (frontend + backend)

Anchors: `frontend/src/components/StoriesEditor.jsx` (749-line monolith),
`frontend/src/store/storiesSlice.ts`, `frontend/src/utils/storyExport.js`,
`frontend/src/utils/parseScript.js`.

**P0**
- **Move "Generate full" to the shared server-side job** (§1). Add a
  `storyToSpans()` compiler: cast + lines + `[voice:]`/`[pause]` markers →
  `Chapter[]`/`Span[]`. `storyExport.js` shrinks to **preview-only** (keep the
  snappy single-line client playback at `StoriesEditor.jsx:271-322`).
- **Per-line regenerate** (currently only full export exists).
- **Abort/cancel** an in-progress export (today the loop has no abort signal).
- **Wire the emotion/tone field → `instruct`** (`storiesSlice.ts:17` "Phase 3"
  stub; tone chips insert text markers but never reach synthesis).

**P1**
- **Component split**: `CastPanel.jsx` / `StoryLine.jsx` / `LineDrawer.jsx`
  (already flagged in `docs/superpowers/specs/2026-05-30-stories-editor-studio-design.md`).
- **Per-line waveform + duration** thumbnail.
- **Chaptered M4B export** with markers (reuse §1; Stories already detects
  `# ` chapter lines at `StoriesEditor.jsx:46`).
- **Optional server-persisted projects** (DB) so large casts/long scripts survive
  localStorage limits; lazy-migrate existing localStorage projects.

**P2**
- EPUB/screenplay import polish; richer auto-cast (gender/voice matching).

---

## 4. Cross-cutting

- **Loudness norm, metadata+cover, resume/checkpoint, parallel synth** all live in
  §1 and are consumed by both features — built once.
- **Pronunciation lexicon** shared service (used by Audiobook P1 + Stories).
- **DB**: `longform_jobs` (+ optional `story_projects`) via alembic, additive,
  tested upgrade path. Existing `omnivoice_data/` and localStorage untouched.
- **i18n**: new keys under `audiobook.*` and `stories.*`; no hardcoded CJK.
- **Tests**: extend `tests/test_audiobook.py` — loudnorm argv (two-pass shape),
  global-metadata + cover ffmeta/argv, `storyToSpans()` compiler, resume-skip
  (cached chapter hash → skipped), EPUB→chapter parse. Frontend: metadata panel,
  per-line regen, abort.

## 5. Constraints honored

- **Cross-platform parity**: ffmpeg `loudnorm` / `COVR` / `aac` work identically on
  mac/Win/Linux (ffmpeg already bundled). Loudness toggle ships **off by default**
  → no default-behavior divergence. EPUB parse is local.
- **Local-first**: no cloud, no accounts; all rendering/import on-device.
- **Backward-compat data**: alembic additive tables; localStorage projects migrate
  lazily, never break.
- **Versioning**: ships as continuous-to-main patches on the v0.3.x line; no RCs,
  no new minor unless the owner asks.

## 6. Suggested PR slicing (order, each independently shippable)

1. **Shared `longform_render` core** + loudnorm + global-metadata/cover builders
   (backend only, wired behind Audiobook). Pure builders + tests first.
2. **Audiobook metadata + cover UI**.
3. **Per-chapter preview + retry + resume** (checkpoints).
4. **Text/EPUB import + auto-chapter**.
5. **Stories "Generate" → shared job**; `storyToSpans()`; per-line regen; emotion→instruct.
6. **Stories component split + per-line waveform**; chaptered M4B.
7. **DB job library** (Projects/Library shows finished books/stories).
8. (P2) SSML-lite, batch, pronunciation lexicon UI.
