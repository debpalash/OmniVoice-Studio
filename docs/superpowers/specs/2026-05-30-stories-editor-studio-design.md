# Stories Editor — Pro Studio — Design Spec

- **Date:** 2026-05-30
- **Status:** Approved direction (maxed features, line-card model, all four capability bundles) — pending written review
- **Ships on:** v0.3.0 (continuous-to-main, in phases)
- **Supersedes:** `docs/superpowers/plans/2026-05-30-stories-editor.md` ("The works" plan) — that plan's scope is absorbed as **Phase 1** here.

## 1. Purpose

The Stories Editor turns a **written story or script into a fully-voiced audio production** — narrator plus a distinct cloned/designed voice per character, with pacing and per-line direction — and generates **one cohesive audiobook** (plus pro outputs: per-character stems, chapter markers).

It is the step up from the Clone/Design tabs (one voice, one block) to a **multi-voice production tool**: VoiceStudio's "audiobook / radio-drama studio." Target users: indie authors (chapter → audiobook), podcasters/creators (dramatized readings), game & animation devs (batch character lines), hobbyists (bring a story to life).

## 2. Design philosophy — simple by default, deep on demand

The editor must feel **no-brain** at the surface and **studio-grade** underneath, via **progressive disclosure**:

- **Surface (the 30-second path):** paste a story → **Auto-cast** detects who's speaking and assigns voices → press **Generate** → audiobook.
- **Depth (revealed only when you click into a line / open a panel):** per-line voice override, emotion/tone, speed, pauses, inline mid-line voice switches, drag-reorder, regenerate-a-single-line, per-character stems, chapter markers, import/export.

Nothing studio-grade is on the default surface; everything is one click away.

### Calm production-desk refinement (2026-08-11)

- A restrained production header keeps only story identity and delivery controls visible; project, cast, and pacing setup live in a persistent left rail.
- The manuscript is the visual center: dense editable line cards, persistent line numbers, quieter metadata, and studio controls that strengthen only on hover or keyboard focus.
- Cast, project, and import surfaces use bounded scrolling so large productions keep the manuscript and export controls reachable.
- Long scripts use `content-visibility` on line cards, while narrow shells reflow each line into text, casting, and action rows without horizontal overflow.
- The bottom status dock remains calm and persistent: lines, used characters, estimated duration, character count, and live render progress.

### Full-height pro workflow (2026-08-11)

1. **Start working immediately:** on a pristine install, Stories creates and opens **The Lighthouse at Wits' End** as a normal saved project. Its 2 chapters, 3-character cast, pauses, expressive tags, and voice assignments exercise the real preview, stems, and Generate paths—not a visual mock.
2. **Set up on the left:** a persistent production rail owns project naming/saving, saved projects, cast-to-voice mapping, global pacing, and stems. Sections collapse independently without covering the manuscript.
3. **Write in the center:** the full-height manuscript canvas owns import, paste/auto-cast, line and chapter creation, editing, reorder, preview, and per-line direction. Long stories stay fast through `content-visibility`.
4. **Deliver from the header:** story length, runtime, format, progress, and Generate stay reachable while the manuscript scrolls.

The hierarchy is spatial instead of label-heavy: setup rail → manuscript → output header. The default sample is authored content stored through the same project actions as user work, automatically adopts installed voice profiles, and remains fully editable or deletable.

## 3. Interaction model (chosen: line cards)

Each **line** is a card: `[character ▾] [voice ▾]  <editable text>  ▶ ⏸ ⋯ 🗑`, draggable to reorder. A line expands (click `⋯` / the card) to reveal its **studio drawer**: emotion chips, speed, pause-insert, inline-voice, regenerate. A **Cast panel** maps each character → a voice once (lines inherit their character's voice unless overridden). A sticky **toolbar** holds the primary actions: Paste & Auto-cast, Add Line, Generate. A **footer** shows live stats (lines, characters, est. duration, total chars) and export progress.

```
┌ Stories ───── [⌜Paste & Auto-cast⌟] [+ Add Line] [ ▶ Generate ▾ ] ┐
│ CAST  ● Narrator→Sasha  ● Fox→Milo  ● Owl→Vera   [+ voice] [Auto✨] │
│ ─────────────────────────────────────────────────────────────────── │
│ ⠿ [Narrator▾][Sasha▾] Once upon a time, in a land far away…  ▶ ⋯ 🗑 │
│ ⠿ [Fox     ▾][⤷cast ▾] "Where are we going?"                  ▶ ⋯ 🗑 │
│      ▼ drawer: 😀tone  ⏩speed 1.0  ⏸pause  🔀inline-voice  ↻regen   │
│ ⠿ [Owl     ▾][Vera ▾] "Somewhere safe," said the owl.        ▶ ⋯ 🗑 │
│ ─────────────────────────────────────────────────────────────────── │
│ 📝 3 lines · 🎭 3 voices · ⏱ ~1 min · 📊 71 chars      [export 0%]  │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. Data model

A single persisted **project** (Phase 1) → **named projects** (Phase 4):

```ts
StoryTrack  = { id, character, text, profileId|null, emotion|null, speed|null }   // transient at runtime: generating, audioUrl
CastMember  = { id, name, color, profileId|null }                                  // id used as track.character
StoryProject = { id, name, tracks: StoryTrack[], cast: CastMember[], updatedAt }
```

- Effective voice for a track = `track.profileId ?? cast[track.character].profileId ?? null` (→ /generate default).
- Effective emotion/speed = per-line override, else cast/global default.
- Persistence: zustand `persist` splits unbounded project/manuscript data into the local IndexedDB database `omnivoice.longform`; `omnivoice.app` localStorage retains bounded preferences and ids. **No backend DB / no alembic.** Transient fields (`generating`, `audioUrl`) are stripped at the durable commit boundary. Existing v8 localStorage data migrates only after IndexedDB commits successfully (#1636).

## 5. Backend touchpoints

- **TTS:** reuse the existing **job-less `/generate`** endpoint via `generateSpeech(FormData)` (same-origin + PIN-aware; the #176 fix). Fields: `text`, `profile_id`, `speed`, `instruct` (emotion/tone), `language`. **No new synth endpoint.**
- **Audiobook stitch (Phase 1 & 4):** client-side **Web Audio API** — fetch each chunk's WAV from `/generate`, decode, concatenate with timed silence for `[pause]`, encode one 16-bit PCM WAV, download. No backend change.
- **MP3 / heavy encode (Phase 4, optional):** a backend `/stories/encode` endpoint that pipes the stitched WAV through the existing `spawn_subprocess(ffmpeg …)` (the #175-hardened helper) to MP3/M4B. Only added if MP3/chapters-in-container is wanted; WAV path needs no backend.
- **Import parsing:** client-side for `.txt`/`.srt`/paste; `.epub` via a small client lib (zip+xhtml). PDF deferred.

## 6. Capability bundles → phases

Each phase is independently shippable to `main` and leaves the editor more useful.

### Phase 1 — Foundation: "it actually makes an audiobook" (absorbs the prior plan)
- **Persistence:** `storiesSlice` (tracks + cast) via zustand persist; drop the hardcoded "Once upon a time" seed → clean first-run empty state.
- **Cast:** `CastMember[]`, Cast panel (name + color + voice per character), per-line inheritance.
- **Real Generate:** `exportStoryAudio()` (Web Audio stitch → single WAV download) with progress + cancel; per-line preview already shipped (#176).
- **Reorder:** native HTML5 drag-and-drop (`reorder()` pure helper).
- **i18n:** all strings via `t('stories.*')` (en + zh-CN).

### Phase 2 — Auto-cast + import (the no-brain ingestion)
- **`parseScript(text)`** → `[{speaker, text}]`: detect quoted dialogue + dialogue tags ("said the fox", "the owl replied"), classify narration vs. speakers; pure + heavily tested.
- **Auto-cast ✨:** map detected speakers → new cast members, round-robin assign installed voice profiles; user retweaks.
- **Import:** `.txt` (read), `.srt` (cues→lines), smart paste; `.epub` (chapters) if the client lib is light, else deferred to a follow-up.

### Phase 3 — Studio per-line depth
- **Line drawer:** emotion/tone chips (→ `instruct` via existing `buildDesignInstruct`), speed slider, `[pause]` insert (markers exist), inline mid-line voice switch (`applyInlineVoice` exists), **regenerate-this-line**.
- **Duration estimate per line** (chars/rate) and a cached preview waveform thumbnail.

### Phase 4 — Pro output + projects
- **Per-character stems:** one WAV per cast voice (mute others), zipped.
- **Chapter markers:** explicit "Chapter" break lines → a sidecar cue sheet (and embedded if M4B).
- **MP3/M4B export:** optional backend `/stories/encode` via ffmpeg.
- **Named projects:** multiple saved stories (rename/duplicate/delete), persisted in IndexedDB.
- **Regenerate-one + export panel** with format/quality choices.

## 7. File structure

**Create:** `frontend/src/store/storiesSlice.ts` (+ test), `frontend/src/utils/storyExport.js` (+ test), `frontend/src/utils/storyReorder.js` (+ test), `frontend/src/utils/parseScript.js` (+ test, Phase 2), `frontend/src/utils/importStory.js` (+ test, Phase 2), `frontend/src/components/stories/CastPanel.jsx`, `frontend/src/components/stories/StoryLine.jsx`, `frontend/src/components/stories/LineDrawer.jsx` (Phase 3) — splitting the monolithic `StoriesEditor.jsx` into focused units as it grows.

**Modify:** `frontend/src/components/StoriesEditor.jsx` (orchestrator), `frontend/src/store/index.ts` (compose + partialize), `frontend/src/i18n/locales/{en,zh-CN}.json`, `StoriesEditor.css`.

**Reference:** `frontend/src/api/generate.ts` (`generateSpeech`), `frontend/src/utils/storyTokens.js` (`parseStoryText`/`hasStoryMarkers`/`applyInlineVoice`), `frontend/src/utils/voiceInstruct.js` (`buildDesignInstruct`), `backend/api/routers/generation.py:93` (`/generate` fields).

## 8. Error handling

- **Generate with no voice / no text:** disabled primary action + inline hint; lines with empty text are skipped (logged in footer, never silently).
- **A chunk fails mid-export:** surface which line failed, keep the partial, offer retry-from-here; never produce a silently-truncated file.
- **`/generate` unreachable / model loading:** the #173 timeouts + a toast; export aborts cleanly.
- **Auto-cast finds nothing** (no quotes): everything becomes narrator; toast "No dialogue detected — all narration."
- **Import parse failure:** keep existing tracks, toast the reason.

## 9. Testing

- **Pure utils (unit, Vitest):** `storyExport` (WAV header, silence length, concat order), `storyReorder` (move/no-op/missing), `parseScript` (quotes, tags, nested/edge), `importStory` (srt cue parsing), `storiesSlice` reducers.
- **Component (Vitest + RTL):** Generate disabled until usable; cast inheritance; drawer reveals controls; drag reorder; auto-cast populates cast.
- **Backend (pytest, only if Phase 4 encode lands):** `/stories/encode` happy-path + ffmpeg-missing.
- **CI parity:** `typecheck:ci`, `test:legacy`, full `vitest`, `build`; CJK guard for the i18n additions.

## 10. Constraints honored

- **No backend DB / alembic:** browser-owned projects use IndexedDB; bounded preferences/ids remain in localStorage.
- **Default features work on every platform:** Web Audio, IndexedDB, localStorage, native DnD, `/generate`, `spawn_subprocess` (cross-platform-hardened) — no platform divergence; no opt-in needed.
- **PIN/LAN-share safe:** all synth goes through `apiFetch` (API base + PIN).
- **Localization hard rule:** all user-facing strings via i18n; any CJK only in `i18n/locales/zh-CN.json`.
- **No new runtime deps** for Phases 1–3 (Web Audio + hand-rolled WAV + native DnD). Phase 2 `.epub` and Phase 4 MP3 may add one small dep each, evaluated at that phase.

## 11. Build order

Phase 1 → 2 → 3 → 4, each its own implementation plan + PR(s) to `main`. Phase 1 begins immediately. The editor is genuinely useful (real audiobook output, persisted, cast-driven) after Phase 1.
