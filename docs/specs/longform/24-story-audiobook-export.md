# TASK #24 — Story ⇄ Audiobook export / convert

## TL;DR

Add two reciprocal client-side converters and the UI to drive them:

1. **Stories → Audiobook** ("Export as Audiobook"): compile the Stories cast + ordered lines into a chapter-delimited audiobook **script** (`# ` headings + inline `[voice:NAME]` / `[pause]` / SSML-lite markup) plus prefilled **metadata** (title, narrator, default voice), then hand off to `AudiobookTab` with that script + metadata pre-populated.
2. **Audiobook → Story** ("Save as Story"): parse the audiobook script back into a Stories project (cast members + tracks), reusing the existing client tokenizer + chapter heuristic, then hand off to `StoriesEditor`.

Both features are **pure client-side text transforms** layered on top of the *already-shipped* convergence: Stories and Audiobook both render through `POST /longform/render` (route declared at `backend/api/routers/audiobook.py:516`, handler streams via `_render_longform_sse` at `:345`). This task does **not** touch the renderer; it adds the two *editing surfaces* that let a user move a project between the two front doors without re-typing it. New pure utils: `frontend/src/utils/storyToScript.js` (Stories→script) and `frontend/src/utils/scriptToStory.js` (script→Stories cast/tracks). `frontend/src/utils/storyToSpans.js` is reused unchanged for the render path; the new export reuses the same chapter/cast-resolution helpers (`isChapterLine`/`chapterTitle` from `storyExport.js`, `effectiveProfile` from `storyCast.js`) but emits *script text* (not spans).

> **Codebase note:** Today the Stories full export does **not** serialize a script — `generateAll` (`StoriesEditor.jsx:360-402`) calls `storyToSpans(usable, cast)` (`StoriesEditor.jsx:363`) and posts the resulting **chapter/span plan** directly to `longformRender({ chapters, format })` (imported from `../api/audiobook`, `StoriesEditor.jsx:23`; signature `frontend/src/api/audiobook.ts:116`). There is no `[voice:…]`/`# `-text intermediate. This task introduces that text serialization for the first time.

## Problem

Stories and Audiobook are two front doors onto the same chapterized renderer, but a user who builds a multi-voice story has no way to:

- Take that story into the **Audiobook** tab to add a cover, ID3/m4b metadata, ACX/podcast loudness, and the pronunciation lexicon — all of which live only in `AudiobookTab.jsx` (the `meta` state object at `AudiobookTab.jsx:36-38`, `loudness` at `:35`, cover at `:39-40`, lexicon `lex` at `:42`), not in `StoriesEditor.jsx`.
- Conversely, a user who pasted a long script into Audiobook (with `[voice:NAME]` tags) cannot pull it into the **Stories** line-card editor to fine-tune per-line voice, speed, tone, and ordering.

Today the only bridge is `storyToSpans` → `/longform/render` (a render-only path, `StoriesEditor.jsx:360-402`). There is **no** script-text serialization and **no** reverse parse into the Stories store. The two editors share zero project state: `StoriesEditor` reads cast + tracks from the zustand `storiesSlice` (`StoriesEditor.jsx:115-127`), while `AudiobookTab` keeps `text`/`meta`/`lex` in local `useState` (`AudiobookTab.jsx:21-48`). Re-creating a project in the other tab means retyping it.

A second, subtler problem: the two sides use **different voice identifiers**. Stories spans carry `voice_id` = a **voice-profile id** (e.g. `p_fox`), resolved via `effectiveProfile` (`frontend/src/utils/storyCast.js:21`). The Audiobook script grammar uses `[voice:NAME]` where **NAME** is matched by `_VOICE_RE` (`backend/services/audiobook.py:42`, `re.compile(r"\[voice:([^\]\[]*)\]")`) and is treated as an opaque voice key. A correct round-trip has to bridge those two namespaces deliberately (see Design § "Voice-identity bridge").

## Goal / Non-goals

### Goals
- **G1** — "Export as Audiobook" button in `StoriesEditor`: serialize cast + tracks → a single chapter-delimited script string + a prefilled metadata object (title from project name, narrator/default voice from the dominant cast voice), navigate to `audiobook` mode with both pre-loaded.
- **G2** — "Save as Story" button in `AudiobookTab`: parse the current script textarea (`text` state, `AudiobookTab.jsx:21`) → a Stories project (cast + tracks), load it into the stories store, navigate to `stories` mode.
- **G3** — Two pure, unit-tested transform utils (`storyToScript`, `scriptToStory`) with no React/DOM/network deps, mirroring the existing `storyToSpans` / `storyExport` style.
- **G4** — Round-trip fidelity for the common case: a Story exported to a script and re-imported yields an equivalent cast + tracks (chapters, voices, pauses, per-line markup preserved). Document every place it is lossy (see Risk and § "Loss / fidelity matrix").
- **G5** — Cross-tab handoff via the store (one-shot prefill fields), modeled on the existing `pendingProfileId` handoff (`uiSlice.ts:55,67,87,99`; consumed in `App.jsx:254-268`). No prop-drilling, no URL params.
- **G6** — Both editors continue to render through the unchanged `/longform/render`; this task only adds editing-surface conversion.

### Non-goals
- **NG1** — No backend changes. `/longform/render`, `parse_audiobook_script`, the cache, ffmpeg mux all stay as-is. (If a tiny helper endpoint turns out cleaner than a JS port, that is called out as an explicit alternative in Design, but the default is client-side.)
- **NG2** — Not unifying the 3 longform parsers (that is **task #27**) and not building the `LongformProject` store (**task #31**). This task is the *user-facing convert action*; #31 is the deeper state merge. Keep the converters small enough that #31 can later absorb them.
- **NG3** — No new render features (loudness/cover/lexicon already exist in `AudiobookTab`; we only *prefill the script + metadata*, the user still drives the AudiobookTab controls).
- **NG4** — No auto-save / no new persisted project type. "Save as Story" loads into the live stories working set (via `setStoryTracks`/`setCast`, `storiesSlice.ts:71-72`); the user can then Save in the Stories project UI. Symmetric with how "Export as Audiobook" just prefills the live AudiobookTab.
- **NG5** — No transcription/dub import (those are tasks #23 / #30).
- **NG6** — No *confirmation/merge* UX. Both handoffs **replace** the destination's working set wholesale; there is no "append to existing" or "merge cast" path (see § "Destructive-handoff hazard" for the warning behavior, which is the only mitigation in scope).

## Design

### Overview

```
StoriesEditor                                AudiobookTab
   cast + tracks (zustand storiesSlice)         text + meta + lexicon (local useState)
        │                                              │
        │  "Export as Audiobook"                       │  "Save as Story"
        ▼                                              ▼
  storyToScript(tracks, cast, opts)             scriptToStory(text, profiles)
        │  → { script, metadata, defaultVoice }        │  → { tracks, cast }
        ▼                                              ▼
  store.setAudiobookPrefill({script,meta,...})   store.setStoryPrefill({tracks,cast})
  setMode('audiobook')                           setMode('stories')
        │                                              │
        ▼                                              ▼
  AudiobookTab reads+clears prefill on mount    StoriesEditor reads+clears prefill on mount
        │                                              │
        └──────────────── both still render through ──┘
                          POST /longform/render  (unchanged)
```

### Voice-identity bridge (the load-bearing decision)

Stories `voice_id` = **profile id** (`p_fox`); audiobook `[voice:NAME]` = a **key** that the backend resolver maps to a voice. The backend's `_resolve_voice` and `_build_synth.resolve` — **both in `backend/api/routers/audiobook.py`** (`_resolve_voice` at `:160`, `_build_synth` at `:200`, its inner `resolve(voice_id)` at `:213`) — look up the voice key as a **profile id** in `voice_profiles`. The exact SQL is `conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,))` (`backend/api/routers/audiobook.py:173`); a missing row returns the all-`None` engine-default dict (`:166,174-175`). The resolver caches per key (`resolve` at `:213-217`: `key = voice_id or default_voice`), so an empty/None voice id falls through to `default_voice`.

> **Corrected file attribution:** the prior draft placed `_resolve_voice`/`resolve` in `backend/services/audiobook.py`. They are not there. `backend/services/audiobook.py` owns the **parser** (`_VOICE_RE` `:42`, `_parse_spans` `:93`, `parse_audiobook_script` `:135`) and the `Span`/`Chapter`/`AudiobookPlan` dataclasses (`:45-90`). The **voice resolution** (profile-id → DB row → ref audio) lives in the **router** file. Keep both citations correct.

So:

- **Audiobook `[voice:X]` is ALREADY resolved as a profile id by the backend** when it reaches `/longform/render`. The "NAME" wording in the markup-reference UI (`audiobook.markup_hint`, `en.json:155`) is aspirational; the actual resolver keys on profile id.
- Therefore the **canonical, render-safe** interchange token is the **profile id**, not the display name. `storyToScript` MUST emit `[voice:<profileId>]`, never `[voice:<DisplayName>]`, so the resulting script renders identically through either front door.
- A `# Cast:` lead block is **not** viable: `# ` opens a chapter (`_HEADING_RE` at `backend/services/audiobook.py:36`). Emit profile-id voice tags and rely on AudiobookTab's existing default-voice dropdown (`AudiobookTab.jsx:220-224`, bound to `defaultVoice` state) for the narrator. Document that the exported script is "machine-faithful, profile-id based" rather than "pretty names."
- `scriptToStory` reverses: a `[voice:<id>]` whose id matches a known profile (`profiles` prop, the `[{id,name}]` list `StoriesEditor`/`AudiobookTab` already receive — see `App.jsx:1074,1080`) becomes a track `profileId` override and a cast member keyed on that profile; an unknown token becomes a cast member named after the raw token, **with `profileId` set to the raw token** (best-effort, lossless on the render key — see R-divergence below and AC2).

This keeps the **render output identical** across both doors — the single most important correctness property, since the whole feature exists because they converge on one renderer.

#### Three real client/server divergences `storyToScript` / `scriptToStory` must respect

All three are exposed by reading the backend parser and the client tokenizer directly; emitting (or re-parsing) script that trips any of them would silently change the render:

1. **Heading depth.** The backend `_HEADING_RE` is `re.compile(r"^[ \t]*#[ \t]+(\S.*)$", re.MULTILINE)` (`backend/services/audiobook.py:36`). It matches **only a single `#` (H1)** with a **non-empty** title (the capture starts with `\S`). The client `isChapterLine` (`storyExport.js:63`) matches `^#{1,6}\s+` after a `.trim()` (the regex literal is `/^#{1,6}\s+/`). Consequences:
   - `storyToScript` must emit **single-`#`** chapter headings only. A Stories chapter line that the editor stored as `## …` (the editor's `isChapterText` at `StoriesEditor.jsx:59` and `addChapter` at `:230-233` only ever write `# `, so this is rare but possible via paste/import) must be re-emitted as `# `.
   - A chapter line with an **empty title** (`# ` / `#`) is **not** a chapter on the backend (`\S` requires a visible char) and `_HEADING_RE` won't match it → its body merges into the previous chapter. `storyToScript` should drop empty-title headings (where `chapterTitle(text) === ''`) rather than emit a bare `# `. Document as lossy (see R7).
   - **Indentation edge:** `_HEADING_RE` tolerates leading `[ \t]*` (a heading indented by spaces/tabs still opens a chapter). `chapterTitle` (`storyExport.js:68`, `String(text).trim().replace(/^#+\s+/, '').trim()`) strips after the leading `#`s and whitespace. `storyToScript` emits a **canonical, un-indented** `# <title>` — never preserve user indentation on the heading, so the two sides agree.
2. **`[voice:default]` semantics.** The client `parseStoryText` treats `[voice:default]` (or empty `[voice:]`) as *revert to the track's default profile* (`storyTokens.js:45`, `currentProfile = (id === 'default' || id === '') ? defaultProfileId : id`). The backend does **not**: `_parse_spans` sets `cur_voice = (m.group(1).strip() or default_voice)` (`backend/services/audiobook.py:102`), so `[voice:default]` yields the **literal string `"default"`** as the voice id, which `_resolve_voice` then fails to find (`SELECT … WHERE id='default'` → no row → engine default). It happens to *also* fall back to the engine default, but for the wrong reason; an **empty** `[voice:]` *does* match (`or default_voice` fires on the empty string). `storyToScript` must therefore **not emit `[voice:default]`** to mean "narrator"; instead it omits the tag entirely on default-voice lines (a missing tag keeps `cur_voice` at `default_voice` on both sides). Inline mid-line `[voice:default]` that the user already typed is passed through verbatim (documented edge; render uses backend semantics).
3. **`[pause]` dialect mismatch (NEW — confirmed by reading both regexes).** The **backend** `_PAUSE_RE` (`omnivoice/utils/text.py:233-236`) is `re.compile(r"\[\s*pause(?>\s+(\d+(?:\.\d+)?)\s*(ms|s)?)?\s*\]", re.IGNORECASE)`, and `_pause_ms` (`:239-250`) resolves: bare `[pause]` → `PAUSE_DEFAULT_MS` (= **350**, `:226`); `[pause 500]` (no unit) → **500 ms**; `[pause 500ms]` → 500 ms; `[pause 2s]` → 2000 ms; clamped to `PAUSE_MAX_MS` (= **10000**, `:227`). The **client** `TOKEN_RE` (`storyTokens.js:23`) is `/\[(?:pause\s+(\d+(?:\.\d+)?)\s*s?|voice:\s*([^\]]+))\]/gi` and `parseStoryText` does `const seconds = parseFloat(match[1])` then keeps it only when `Number.isFinite(seconds) && seconds > 0` (`:39-41`), interpreting the bare number as **seconds**, requiring a number (no bare `[pause]`), and recognizing only an optional `s` suffix (**no `ms`**). Consequences for **both** utils:
   - `storyToScript` emits pause tokens **only by passing through the user's existing inline text verbatim** — it never *synthesizes* a pause token, so it cannot introduce a dialect mismatch. (Documented; no transform needed.)
   - `scriptToStory` uses `parseStoryText` *only for leading-`[voice:]` detection*, **never** to re-emit pause markup. Pause tokens stay **in the track text byte-for-byte**, so at render time the backend `_PAUSE_RE` (not the client one) interprets them — i.e. a `[pause 500ms]` or bare `[pause]` authored in the Audiobook tab survives the round-trip into Stories and back to the renderer unchanged. **Do not** normalize, re-emit, or "seconds-convert" pause tokens in either util. (R8.)

> **CodeQL / ReDoS note (memory: codeql-redos-regex).** Both utils **reuse the already-shipped, CI-clean** `TOKEN_RE` (`storyTokens.js:23`) and `isChapterLine`/`chapterTitle` regexes (`storyExport.js:63,68`); they **must not introduce a new regex over user-controlled input.** If a slug/normalization regex is unavoidable, mirror the existing `slug()` helper (`StoriesEditor.jsx:173`, a simple `[^a-z0-9]+` character-class replace — linear, no nested/overlapping quantifiers) and never write `[^x]*…[^x]*` or overlapping `\s*`/`.+` quantifiers that CodeQL `py/polynomial-redos` (and its JS analogue) flags. This task adds **no** Python regex over user input (the constraint's `py/polynomial-redos` rule is satisfied trivially — no backend code changes), but the JS-side analogue still applies, so keep all new string processing to fixed-substring splits (`split('\n')`, `.startsWith`, the reused linear tokenizer) rather than bespoke catastrophic patterns.

### Reused-function contracts (exact signatures the new utils call)

Pinned so the implementer never guesses a return shape. **None are modified by this task.**

```js
// frontend/src/utils/storyTokens.js
const TOKEN_RE = /\[(?:pause\s+(\d+(?:\.\d+)?)\s*s?|voice:\s*([^\]]+))\]/gi; // :23 (CI-clean; reuse, don't reauthor)
// :25 — returns chunk/pause events; whitespace-only chunks dropped; voice 'default'/'' reverts to defaultProfileId
function parseStoryText(text: string, defaultProfileId: string|null = null):
  Array<{ type: 'chunk', text: string, profileId: string|null }
       | { type: 'pause', seconds: number }>;

// frontend/src/utils/storyExport.js
function isChapterLine(text: string): boolean;   // :63 — /^#{1,6}\s+/.test(String(text).trim())
function chapterTitle(text: string): string;     // :68 — String(text).trim().replace(/^#+\s+/, '').trim()

// frontend/src/utils/storyCast.js
const CAST_COLORS: string[];                      // :9-12 — 8-entry gruvbox palette
function nextCastColor(cast: CastMember[]): string;       // :15 — first unused color; wraps by count when exhausted
function effectiveProfile(track: StoryTrack, cast: CastMember[]): string|null; // :21 — track.profileId → cast member's profileId → null

// frontend/src/utils/storyToSpans.js — the render-path compiler (unchanged; used in round-trip tests)
function storyToSpans(tracks: StoryTrack[], cast: CastMember[]):
  Array<{ title: string, spans: Array<{ voice_id: string|null, text: string, pause_ms_after: number, speed: number|null }> }>; // :21

// StoriesEditor.jsx:173 — slug pattern to MIRROR (not import); linear, CodeQL-clean
// const slug = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'') || 'char';
```

### Util 1 — `frontend/src/utils/storyToScript.js`

Pure function. Reuses the chapter/voice-resolution **rules** from `storyToSpans` (`storyToSpans.js:21-54`) and the chapter-heading helpers `isChapterLine`/`chapterTitle` (`storyExport.js:63-70`), but emits **script text** instead of spans.

```js
/**
 * Compile the Stories cast + ordered lines into a chapter-delimited Audiobook
 * SCRIPT (the text the Audiobook tab + parse_audiobook_script consume), plus a
 * prefill metadata bundle. The script uses profile-id voice tags so it renders
 * identically through /longform/render from either front door.
 *
 * @param {StoryTrack[]} tracks   // {id,character,text,profileId,emotion,speed}; null/undefined tolerated
 * @param {CastMember[]} cast     // {id,name,color,profileId}; null/undefined tolerated
 * @param {{ projectName?: string }} [opts]
 * @returns {ScriptExport}        // see § API / data shapes
 */
export function storyToScript(tracks, cast, opts = {}) { ... }
```

**Return type (exact):**
```ts
interface ScriptExport {
  script: string;                                   // chapter-delimited; single-# headings; [voice:<profileId>] tags
  defaultVoice: string | null;                      // most-used effective profile id (deterministic tie-break)
  metadata: { title?: string; narrator?: string };  // ONLY keys whose value is a non-empty string
}
```

Rules:
- **Default-voice selection:** the most-used effective profile id across spoken (non-chapter) lines, resolved with `effectiveProfile(tk, cast)` (`storyCast.js:21`); that becomes `defaultVoice` (→ AudiobookTab's `defaultVoice` state / `audiobook.default_voice` dropdown). Count is by **line** (one vote per spoken track regardless of inline switches), keyed on the line's effective profile id. Lines in the default voice emit **no** `[voice:]` tag. **Tie-break (deterministic):** when two profile ids tie for most-used, pick the one whose **first spoken occurrence** is earliest in track order (stable, reproducible across runs — required for the round-trip test to be deterministic). **All-null case:** if every spoken line resolves to `null` (no cast voice, no override — e.g. a fresh story with the default narrator), `defaultVoice = null` and **no** line gets a `[voice:]` tag (matches AudiobookTab's empty `defaultVoice` = engine default).
- **Chapter lines** (`isChapterLine(text)`, `storyExport.js:63`) → a single-`#` `# <title>` line (title from `chapterTitle(text)`, `storyExport.js:68`), blank line separated. Empty-title headings (`chapterTitle` returns `''`): **drop** the line (R7) — do not emit a bare `# `.
- **Pre-heading lines** (lines before the first chapter) → emitted under no heading (the backend parser treats pre-heading text as an untitled lead-in chapter, `parse_audiobook_script` `backend/services/audiobook.py:147-149`; its title becomes `f"Chapter {len(chapters)+1}"` at `:159`). A story that is *all* pre-heading (no chapters at all) emits a flat script with no `#` lines — valid; the backend's `if not matches:` branch (`:143`) handles it as one untitled chapter.
- **Spoken lines:** if a line's effective profile differs from the **running script voice**, prepend `[voice:<profileId>]`; then the line text **verbatim** (it already contains the user's inline `[pause]` / `[voice:]` / SSML-lite / emotion (`[laughter]` etc.) markup — do NOT re-tokenize, to avoid drift with the backend `_parse_spans`). The "running script voice" starts at `defaultVoice` and updates on each emitted tag, mirroring backend `cur_voice` semantics, so a tag is emitted *only on change* (matching `storyToSpans`' voice-coalescing).
  - **Inline-tag interaction edge:** if a spoken line *already begins* with a `[voice:<x>]` that the user typed, and the line's effective profile equals the running voice, **do not** prepend a second tag (avoid `[voice:A][voice:A]…`). Detection: compare the line's leading-token voice (via `parseStoryText`/`TOKEN_RE`, `storyTokens.js:23,45`) to the effective profile; only prepend when the *effective* profile differs from the running voice **and** the line does not already lead with a tag for that same profile. Inline mid-line tags are always left untouched.
  - **`null` effective profile on a spoken line while running voice is non-null:** emit **`[voice:default]`? No** — that breaks the backend (divergence #2). Instead this is a documented loss: a line that resolves to "engine default" *mid-script* cannot be expressed without `[voice:default]`. Behavior: treat `null` as "no change" only when running voice is already `null`; if running voice is non-null and the line is `null`, **keep the running voice for that line** (i.e. do not switch, emit no tag) and **document** that "revert to engine default mid-script" does not round-trip (R9). (In practice this only arises in hand-built mixed casts; the common path keeps every line on a real profile or all-null.)
- **Per-line `speed`** (`StoryTrack.speed`, `storiesSlice.ts:18`) has **no script representation** in the audiobook grammar (only inline `[slow]/[fast]/[emphasis]` exist; `_parse_spans` reads `speed` only from SSML-lite segments, `backend/services/audiobook.py:118-121`) → drop it (documented loss; R3). It round-trips to `null`.
- **Per-line `emotion`** (`StoryTrack.emotion`, `storiesSlice.ts:17`): the Stories editor injects emotion as inline tags **into the track text** (e.g. `[laughter]`, via `insertToken`, `storyTokens.js:85`), so emotion that the user added is already *in `tk.text`* and rides through verbatim. The `emotion` **field** itself is metadata the editor may set separately; it has **no script token** → if non-null and not already reflected in the text, it is dropped (documented loss; R10). Most stories carry emotion in-text, so this is rare.
- **`metadata`:** `{ title?: opts.projectName, narrator?: <name of default-voice cast member> }` — **only include keys with non-empty values** (so the mount effect's `{...m, ...metadata}` merge never blanks an existing field with `''`). Shape is a subset of AudiobookTab's `meta` (`AudiobookTab.jsx:36-38`, full key set `title`/`author`/`narrator`/`year`/`genre`/`description`). `narrator` = the `name` of the cast member whose `profileId === defaultVoice`; if `defaultVoice` is `null` or no cast member matches it, **omit** `narrator`. `title` omitted when `opts.projectName` is empty/undefined. Result for a fresh narrator-only story: `metadata = {}`.
  - **Localization note:** `metadata.title` is the user's own project name and `metadata.narrator` is a cast member's user-set name — both are **user content**, not UI chrome, so they are *not* i18n keys (and may legitimately contain CJK the user typed; that is allowed — the hard-rule allowlist already excludes user-authored project/voice data). No hardcoded non-English string is introduced by these utils; they only move user text.
- **Output shape on empty/degenerate input** (enumerated in tests below): no tracks, or only chapter lines, or only whitespace lines → `{ script: '', metadata: {}, defaultVoice: null }`. The caller's empty-guard keys off `!script.trim()`.

Edge cases to cover in tests:
- empty `tracks` (`[]`/`null`/`undefined`) → `{script:'', metadata:{}, defaultVoice:null}`.
- only chapter lines (no spoken body) → `{script:'', …}` (the backend would drop spanless chapters anyway, `:157-158`; we emit nothing so there's no dangling `#`).
- only whitespace-text lines → treated as no spoken content → empty script.
- single narrator, no chapters → flat script, no `[voice:]` tags, no `#`.
- mid-line `[voice:]` already present → don't double-tag (the leading-tag-equals-running-voice case above).
- a line whose only content is a chapter heading with empty title (`# `) → dropped.
- a `##`/`###` heading → downgraded to `#`.
- a heading indented with spaces/tabs → emitted un-indented.
- pause-only line (`tk.text === '[pause 0.5s]'`) → emitted verbatim as a body line (renders as leading silence on the backend; not dropped).
- a spoken line that begins with `# ` text the user *typed as body* but `isChapterLine` would catch → **it is a chapter** by the shared heuristic; this is intentional and matches `storyToSpans`. Documented (no special-case).

### Util 2 — `frontend/src/utils/scriptToStory.js`

Pure function. The reciprocal. Rather than re-implement the backend chapter/voice parser in JS (drift risk → task #27), reuse the **existing client tokenizer** `parseStoryText` (`storyTokens.js:25`) per line for leading `[voice:]` detection, and split chapters with the same `isChapterLine` heuristic used everywhere (`storyExport.js:63`).

```js
/**
 * Parse a chapter-delimited Audiobook script into a Stories project.
 * @param {string} text                          // # headings, [voice:id], [pause], SSML-lite
 * @param {{id:string,name:string}[]} [profiles] // map [voice:id] tags → named cast members
 * @returns {StoryImport}                         // see § API / data shapes
 */
export function scriptToStory(text, profiles = []) { ... }
```

**Return type (exact):**
```ts
interface StoryImport {
  // EXACTLY the persisted StoryTrack shape (storiesSlice.ts:12-19) — no transient generating/audioUrl
  tracks: Array<{ id: number; character: string; text: string; profileId: string|null; emotion: null; speed: null }>;
  cast:   Array<{ id: string; name: string; color: string; profileId: string|null }>; // ALWAYS includes a narrator clone
}
```

Rules:
- **Line splitting:** normalize `\r\n` → `\n` (the Audiobook textarea can receive Windows-pasted text; `splitIntoChunks` already does this at `StoriesEditor.jsx:66`), then split on `\n`. Each physical line is one track candidate. (This `\r\n` normalization is what makes the converter **cross-platform-identical** — a script pasted from a Windows editor and the same script on macOS/Linux produce byte-for-byte identical tracks; see § Constraints.)
- **Chapter lines:** an `isChapterLine` line becomes a chapter track shaped like the **persisted** `StoryTrack` (`storiesSlice.ts:12-19`): `{ id, character:'narrator', text:'# Title', profileId:null, emotion:null, speed:null }`. **Re-emit the heading canonically** as `# <chapterTitle>` (strip the user's original `##`/indentation/trailing space via `chapterTitle`) so the stored chapter line round-trips cleanly back out through `storyToScript`. Do **not** carry the transient `generating`/`audioUrl` fields (`makeTrack` adds them at `StoriesEditor.jsx:92`, but `setStoryTracks` persists via `snapshotTracks` partialize at `store/index.ts:109-110` which strips them — emit the persisted shape directly).
  - **Empty-title heading edge:** a line that is bare `#` with no trailing space is **not** a chapter (client `isChapterLine` is `/^#{1,6}\s+/`, requires a space) → it becomes a *spoken* track of text `"#"`. A `# ` with a trailing space *is* a chapter with empty title. For an empty-title chapter, keep it as a chapter track with `text: '# '` (the editor's lenient `isChapterText` keeps it a chapter during edit, `StoriesEditor.jsx:59`); on a subsequent export it would be dropped (R7). Documented; lossless within Stories, lossy back to the renderer.
- **Body lines:** a non-empty (after-trim) body line becomes a spoken track. Determine the line's **leading voice**:
  - Use `parseStoryText(line, null)` (`storyTokens.js:25`) and inspect whether the **first token** in the raw line is a `[voice:<id>]` (i.e. the line starts, modulo leading whitespace, with a voice tag). Equivalent: match the leading `TOKEN_RE` (`storyTokens.js:23`) at index 0.
  - If a **leading** `[voice:<id>]` is found: **strip it from the stored text** and set the track's `profileId = <id>` (and ensure a cast member exists — see Cast assembly). The remaining text (which may still contain *mid-line* `[voice:]`/`[pause]`/SSML-lite/emotion) is stored **verbatim**.
  - If **no** leading tag: `profileId = null`, `character = 'narrator'`, text stored verbatim.
  - **`[voice:default]` / empty `[voice:]` as the leading tag:** `parseStoryText` reverts it to the `defaultProfileId` we passed (`null`), so `profileId = null` and the track is the narrator. Strip the tag from stored text (it was leading and meaningless once mapped to narrator). Mid-line `[voice:default]` stays in the text verbatim (R2).
  - **Inline mid-line `[voice:]` tags stay in the text** verbatim — do **not** flatten them into separate tracks (`storyToSpans` already handles inline switches via `parseStoryText` at render time; splitting would break editability and the round-trip). One physical line = one track, period.
- **Blank lines:** a fully blank/whitespace line between chapters or paragraphs is **dropped** (not emitted as an empty track) — matches the backend's "pure whitespace between markers — nothing to render" (`_parse_spans:115-116`) and keeps the imported card list clean. (Edge: a blank line that the user intended as a paragraph break is lost; acceptable — the renderer ignores it too.)
- **Cast assembly:**
  - Start from a **fresh clone** of `DEFAULT_CAST` (`storiesSlice.ts:53-55`, the single `narrator` member `{ id:'narrator', name:'Narrator', color:'#fabd2f', profileId:null }`) — `DEFAULT_CAST.map(c => ({...c}))`, never the shared reference (mutating the exported constant would corrupt every new story; cf. `newProject` at `storiesSlice.ts:106`).
  - For every **distinct leading-voice profile id** seen across body lines, create a `CastMember` (`storiesSlice.ts:21-26`, `{id,name,color,profileId}`): `id` = a stable slug derived from the profile id (mirror the `slug()` helper at `StoriesEditor.jsx:173`: lowercase, non-alnum → `-`, trim leading/trailing `-`, fallback `'char'`); `name` = the matching `profiles` entry's `name` or the raw id if unknown; `color` = `nextCastColor(<cast-so-far>)` (`storyCast.js:15`, cycles the palette, wraps by count when exhausted); `profileId` = the id.
  - **Slug-collision edge:** two different profile ids that slug to the same string (e.g. `p_fox` and `p-fox` both → `p-fox`) → the second must get a **de-duplicated** id (append `-2`, `-3`, …) so cast ids stay unique (the editor's `upsertCastMember` keys on `id`, `storiesSlice.ts:73-80`; a collision would silently merge two voices). The `narrator` id is reserved — a profile that slugs to `narrator` also gets de-duped.
  - **Profile-id equals `'narrator'` edge:** if a `[voice:narrator]` tag appears (a profile literally named that, or a leftover), it maps to the existing narrator member only if its `profileId` matches; otherwise de-dupe per above. Don't overwrite the default narrator's `profileId` (it must stay `null`).
  - Assign each spoken track's `character` to the cast member whose `profileId` matches its leading voice (so the Cast panel shows real names); fall back to `'narrator'` when leading voice is `null` (an unknown id still gets a cast member, so it still gets a non-narrator character).
- **Track ids:** `StoryTrack.id` is a `number` (`storiesSlice.ts:13`). Assign **sequential numeric ids starting at 1** in line order. These load through `setStoryTracks` (`storiesSlice.ts:71`); `StoriesEditor`'s mount effect reseeds the module-level `_trackId` counter (`StoriesEditor.jsx:90`) from `max(id)` (`StoriesEditor.jsx:136-140`) **on mount only** — so the prefill effect must run such that the reseed sees the imported ids (see UI wiring § ordering). New lines added after import then start above the max imported id, no collision.
- **Output shape on empty/degenerate input:**
  - empty / whitespace-only / `null` / `undefined` script → `{ tracks: [], cast: DEFAULT_CAST.map(c => ({...c})) }` (cast is **always** at least the narrator clone, never `[]`).
  - script with no headings → all spoken tracks, zero chapter tracks.
  - script that is **only** headings (consecutive `# A` / `# B`, no body) → chapter tracks preserved (the editor allows empty chapters; the backend render drops spanless chapters, `backend/services/audiobook.py:157-158`, so a later render skips them — documented, not an error).
  - script whose every body line resolves to the narrator → tracks all `character:'narrator'`, cast is just the narrator clone.

Edge cases to cover in tests:
- `# H` lines → chapter tracks; body lines → spoken tracks.
- leading `[voice:<id>]` stripped → track `profileId` set + cast member created with matching `profiles` name.
- leading `[voice:default]` / `[voice:]` → `profileId:null`, narrator, tag stripped.
- mid-line `[voice:]` left in text (not split into a new track).
- **unknown voice id → cast member name = raw id, `profileId = the raw id`** (so it round-trips back out as `[voice:<rawid>]`). Only the *display name* is unknown; the **stored `profileId` is the raw token** so the render still keys on it. (Clarified vs. prior draft, which said `profileId:null` — that would lose the tag on re-export.)
- two ids slugging to the same value → unique cast ids.
- a profile id that slugs to `narrator` → de-duped, narrator untouched.
- `\r\n` line endings normalized.
- consecutive headings (empty chapters) preserved.
- empty script → `{tracks:[], cast:[narrator-clone]}`.
- sequential numeric `id`s starting at 1; track shape matches persisted `StoryTrack` (`{id,character,text,profileId,emotion,speed}`), `emotion:null`, `speed:null` always.
- body text preserved byte-for-byte (R2 guard), including any `[pause 500ms]` / bare `[pause]` the client tokenizer would mis-read (R8 — they stay in text, never re-emitted).

### Loss / fidelity matrix (what survives the round-trip)

| Datum | Story→Script | Script→Story | Round-trips? | Risk |
|-------|--------------|--------------|--------------|------|
| Chapter heading (H1) | `# title` | chapter track | ✓ | — |
| Chapter heading (H2–H6) | downgraded to `# ` | chapter track | depth lost (always H1) | R7 |
| Empty-title heading | dropped | (re-import keeps as `# `) | ✗ (lost on export) | R7 |
| Effective voice (real profile) | `[voice:<id>]` on change | `profileId` + cast member | ✓ | — |
| Default/most-used voice | no tag + `defaultVoice` | narrator + `defaultVoice` dropdown | ✓ (via dropdown) | — |
| Mid-script revert to engine default | not expressible (no tag) | n/a | ✗ | R9 |
| Inline mid-line `[voice:]` | verbatim | verbatim in text | ✓ | — |
| `[pause N s/ms]`, bare `[pause]` | verbatim | verbatim in text | ✓ (render uses backend dialect) | R8 |
| SSML-lite `[slow]/[fast]/[emphasis]/[spell]` | verbatim | verbatim | ✓ | — |
| Emotion tags in text (`[laughter]`) | verbatim | verbatim | ✓ | — |
| Per-line `speed` slider | dropped | `speed:null` | ✗ | R3 |
| Per-line `emotion` field (not in text) | dropped | `emotion:null` | ✗ | R10 |
| Cast display names | not in script | reconstructed from `profiles` or raw id | name lost if profile unknown | R1-adjacent |
| Cast colors | not in script | re-assigned via `nextCastColor` | ✗ (colors differ) | low/cosmetic |

### Destructive-handoff hazard (NEW)

Both handoffs **overwrite** the destination's live working set, and neither destination is auto-saved:

- **Export as Audiobook** replaces `AudiobookTab`'s `text`/`meta`/`defaultVoice` (via `setText`/`setMeta`/`setDefaultVoice`) — clobbering any unsaved script the user had typed in the Audiobook tab.
- **Save as Story** replaces `storyTracks` + `cast` via `setStoryTracks`/`setCast` — clobbering the live (possibly unsaved) Stories working set. (It does **not** touch `storyProjects` or `currentProjectId`, so *saved* projects survive; only the live editing buffer is replaced.)

Mitigation (in scope, minimal): the **Save as Story** button guards on the destination having unsaved content. Simplest correct rule: if `useAppStore.getState().storyTracks.length > 0`, show a confirm (`window.confirm(t('audiobook.saveAsStoryConfirm'))`) before overwriting; on cancel, no nav, no state change. For **Export as Audiobook**, the destination (`text`) is local `useState` not yet mounted at click time, so any guard would belong in the *mount effect*; but because the user explicitly clicked "Export as Audiobook," replacing the Audiobook draft is the expected action; keep the overwrite but document it (and the textarea is the *first thing* they see, so loss is visible, not silent). Tests assert the Save-as-Story confirm path (proceed + cancel).

> **Cross-platform note:** `window.confirm` is the **default** mitigation and must behave identically on all three OSes. It is a standard webview API available in the Tauri WebView on macOS (WKWebView), Windows (WebView2), and Linux (WebKitGTK) — no platform branch, no native-dialog plugin. This keeps the confirm a default-everywhere feature (satisfies the strict default-features rule); we deliberately do **not** reach for a platform-native confirm dialog, which would be a divergence.

### UI wiring

**StoriesEditor** (`StoriesEditor.jsx`): add an "Export as Audiobook" action. Cheapest correct placement is the **Output** button group (`StoriesEditor.jsx:477-495`, the `stories-editor__group` holding Stems / format `<select>` / `generateAll`), as a new `<Button size="sm" variant="ghost">` next to Stems, or a `Menu` item (the `Menu` component is already imported from `../ui` at `StoriesEditor.jsx:16`) to avoid toolbar crowding. `tracks`, `cast`, and `currentProject` are already in scope (`:115`, `:117`, `:217`). On click:
```js
const usable = tracks.filter((tk) => (tk.text || '').trim());           // mirror generateAll:361
const { script, metadata, defaultVoice } = storyToScript(usable, cast, { projectName: currentProject?.name });
if (!script.trim()) { toast.error(t('stories.exportFailed')); return; } // toast already imported :14; reuse existing key
setAudiobookPrefill({ script, metadata, defaultVoice });
setMode('audiobook');
toast.success(t('stories.toAudiobookDone'));
```
- **Disabled state:** mirror the existing Output buttons — `disabled={tracks.length === 0 || exporting}` (`StoriesEditor.jsx:479,492`). Don't fire mid-render.
- **No `usable` lines** (all chapter/whitespace) → `storyToScript` returns empty script → `toast.error` guard fires, no nav. (Same guard as `generateAll:364`.)
- **i18n:** every label/toast above is a `t('…')` key (see § Constraints). The button label is `t('stories.toAudiobook')`; no English literal in JSX.

**AudiobookTab** (`AudiobookTab.jsx`): add a "Save as Story" button in the `audiobook-tab__actions` group (`AudiobookTab.jsx:189-201`, alongside Import / Preview plan / Create — these are raw `<button className="ui-btn …">`, not the `Button` component; match that markup). On click:
```js
if (!text.trim()) { setError(t('audiobook.saveAsStoryEmpty')); return; }      // setError exists :28
const { tracks, cast } = scriptToStory(text, profiles);                       // text :21, profiles prop :19
if (!tracks.length) { setError(t('audiobook.saveAsStoryEmpty')); return; }    // defensive: all-blank case (headings still make tracks)
if (useAppStore.getState().storyTracks.length > 0 &&
    !window.confirm(t('audiobook.saveAsStoryConfirm'))) return;               // destructive-handoff guard
setStoryPrefill({ tracks, cast });
setMode('stories');
```
- **Disabled state:** reuse the existing `canRun`/`busy` gating (`AudiobookTab.jsx:177-178`: `busy = planLoading || generating || importing`; `canRun = text.trim().length > 0 && !busy`) — disable while `busy` (importing/generating/planning) so a Save-as-Story can't race a synth stream.
- **i18n:** `t('audiobook.saveAsStory')` label, `t('audiobook.saveAsStoryEmpty')` error, `t('audiobook.saveAsStoryConfirm')` confirm message — all keys, no literals.

On mount, `AudiobookTab` reads+clears `audiobookPrefill` (place next to the existing cover-cleanup `useEffect` at `AudiobookTab.jsx:64`):
```js
const audiobookPrefill = useAppStore(s => s.audiobookPrefill);
const setAudiobookPrefill = useAppStore(s => s.setAudiobookPrefill);
useEffect(() => {
  if (!audiobookPrefill) return;
  setText(audiobookPrefill.script);                              // setText :21
  if (audiobookPrefill.defaultVoice) setDefaultVoice(audiobookPrefill.defaultVoice);  // :22; falsy/null → leave at '' (engine default)
  if (audiobookPrefill.metadata) setMeta(m => ({ ...m, ...audiobookPrefill.metadata }));  // :36; metadata only has non-empty keys, so no field is blanked
  setPlan(null);                                                 // :23 stale plan from a prior script
  setError('');                                                  // :28 clear any stale error
  setAudiobookPrefill(null);                                     // one-shot clear
}, []); // one-shot on mount
```
- **`defaultVoice` not in `profiles`:** if the prefilled `defaultVoice` profile id isn't in the AudiobookTab `profiles` prop (e.g. the profile was deleted between tabs), `setDefaultVoice(id)` still sets the state; the `<select>` (`AudiobookTab.jsx:220-224`) has no matching `<option>` so it renders as the placeholder (`audiobook.engine_default`, `:222`). The render call still sends `default_voice: id` (`LongformRenderBody.default_voice`, `frontend/src/api/audiobook.ts:102`) and the backend `_resolve_voice` returns engine default (no row, `:174-175`). **Acceptable** — same as typing an unknown id. (Optionally guard: only `setDefaultVoice` if `profiles.some(p => p.id === id)`; otherwise leave `''`. Document the choice.)

> **Codebase note:** `AudiobookTab` does **not** currently import the store — it is a pure-props component (`AudiobookTab.jsx:19`, only `profiles` prop) but already wires i18n (`useTranslation` at `AudiobookTab.jsx:2,20`). Adding `import { useAppStore } from '../store'` is a new (small) import. `StoriesEditor` already imports the store and i18n.

**StoriesEditor** reads+clears `storyPrefill` on mount via `setStoryTracks` + `setCast` (`storiesSlice.ts:71-72`, both already selected at `StoriesEditor.jsx:116,118`), then clears. **Ordering is load-bearing:** the existing `_trackId` reseed effect (`StoriesEditor.jsx:136-140`) runs on mount and seeds the counter from `max(track.id)`. Fold the reseed into the prefill effect:
```js
// Option A — single combined effect (preferred): apply prefill, THEN reseed from the applied ids.
useEffect(() => {
  const pf = useAppStore.getState().storyPrefill;
  if (pf) {
    setStoryTracks(pf.tracks);
    setCast(pf.cast);
    useAppStore.getState().setStoryPrefill(null);
  }
  const src = pf ? pf.tracks : useAppStore.getState().storyTracks;
  const maxId = src.reduce((m, tk) => Math.max(m, tk.id || 0), 0);
  if (maxId > _trackId) _trackId = maxId;
}, []); // replaces the existing reseed effect (don't run two competing mount effects)
```
Do **not** keep a *separate* prefill effect that runs concurrently with the existing reseed effect: React doesn't guarantee inter-effect ordering relative to the state batch, and a reseed that reads the *pre-prefill* `tracks` would seed too low → id collision on the next added line. Fold the reseed into the prefill effect (Option A) so the counter always reflects the imported ids.
- **`currentProjectId` after import:** `setStoryTracks`/`setCast` do **not** change `currentProjectId` — so after a Save-as-Story import, the Stories project header still shows the *previously open* project name while the working set is the imported one. Known minor confusion. Do **not** call `newProject()` (it resets cast/tracks, `storiesSlice.ts:106`, which would clobber the prefill). Leave `currentProjectId` as-is and document: the imported story is "unsaved"; the user clicks Save to name it. The `projectName` input effect (`StoriesEditor.jsx:218-221`) keys on `currentProjectId` only, so it won't auto-relabel. Acceptable; note in docs. (R12.)

### Store changes (`frontend/src/store/uiSlice.ts`)
- Add `'audiobook'` to the `AppMode` union (`uiSlice.ts:16-30`). **Bug confirmed by reading code:** `AppMode` (`uiSlice.ts:16-30`) lists `launchpad | generate | dub | studio | clone | design | stories | voice | tools | batch | settings`. It **omits** `audiobook`, `projects`, `gallery`, `transcriptions`, `queue`, `donate`, `enterprise` — even though `App.jsx` routes on those strings (`App.jsx:1031-1083`) and `NavRail.jsx` calls `setMode(it.id)` (`NavRail.jsx:48`) with ids including `'audiobook'`. `setMode(mode: AppMode)` (`uiSlice.ts:62,94`) is therefore under-typed today. Minimally add `'audiobook'` (the one this task needs) and ideally the rest in the same PR (low-risk cleanup, all already accepted at runtime). Keep scope tight: at least `'audiobook'`. **Do not remove the legacy ids `'clone'`/`'design'`** — they are intentionally retained (commented at `uiSlice.ts:21-23`) so persisted UI state / history items that still say `'clone'`/`'design'` type-check while the restore shims map them to `'studio'`; deleting them would break backward-compatible persisted-state hydration (R4).
- Add two one-shot prefill fields + setters to `UiSlice`, modeled on `pendingProfileId` (`:55` decl, `:67` setter sig, `:87` default, `:99` setter impl). **Exact edits:**

  Interface (after `:55` `pendingProfileId`):
  ```ts
  // One-shot Story⇄Audiobook handoffs (transient; NOT persisted — see partialize).
  audiobookPrefill: { script: string; defaultVoice: string | null; metadata: Record<string, string> } | null;
  storyPrefill: { tracks: StoryTrack[]; cast: CastMember[] } | null;
  ```
  Setter sigs (after `:67`):
  ```ts
  setAudiobookPrefill: (v: UiSlice['audiobookPrefill']) => void;
  setStoryPrefill: (v: UiSlice['storyPrefill']) => void;
  ```
  Factory defaults (after `:87` `pendingProfileId: null,`):
  ```ts
  audiobookPrefill: null,
  storyPrefill: null,
  ```
  Setter impls (after `:99` `setPendingProfileId`):
  ```ts
  setAudiobookPrefill: (v) => set({ audiobookPrefill: v }),
  setStoryPrefill: (v) => set({ storyPrefill: v }),
  ```
  Add `import type { StoryTrack, CastMember } from './storiesSlice';` at the top of `uiSlice.ts` (the file currently imports only `StateCreator` at `:14`).

- **Do NOT persist** these (transient handoff). The `partialize` allowlist in `frontend/src/store/index.ts:74-114` is **opt-in** — it explicitly lists every persisted key, so fields not added there never serialize. **Confirmed by reading the code:** the allowlist enumerates dub prefs (`:75-80`), `mode`/`defineMethod`/sidebar/`uiScale`/`locale`/`theme`/`font` (`:81-89`), generate knobs (`:91-101`), gallery prefs (`:103-106`), and the Stories project (`storyTracks` mapped to its persisted shape at `:109-110`, `cast` `:111`, `storyProjects` `:112`, `currentProjectId` `:113`) — `pendingProfileId`/`modeBeforeVoice`/`activeVoiceId`/`activeProjectId` are deliberately *absent* (transient). The two new prefill fields will likewise be absent → never serialized into localStorage. ✓ (AC6 asserts the partialize diff adds nothing.)
- **No localStorage migration needed (backward-compatible data, hard rule).** The store uses a versioned `persist` with `version: 4` (`store/index.ts:115`) and a `migrate` fn (`:120-130`) that returns the prior persisted object unchanged for `version < 4`, relying on each slice's defaults for new keys. Because the two new fields are **not persisted**, the persisted shape (and `version`) is **unchanged** — no version bump, no migrate-fn edit. A user on a v4-persisted store who upgrades to this build sees `audiobookPrefill`/`storyPrefill` initialized to `null` from `createUiSlice`'s factory defaults (`uiSlice.ts:80-93`), with zero hydration work.
- **DB / `omnivoice_data/` is untouched** — this task adds no alembic migration because it makes no schema change (it only moves client-side text through the store). The voice resolution it relies on (`SELECT … FROM voice_profiles WHERE id=?`, `backend/api/routers/audiobook.py:173`) reads the *existing* schema, unchanged.
- **Reload-while-prefill-set edge:** because the prefill fields aren't persisted, a hard reload (or app restart) *between* setting the prefill and the destination tab mounting drops the handoff entirely. Acceptable (the handoff is an in-session action), but **must not crash**: the mount effects guard on `if (!prefill) return;` / `if (pf) {…}` so a `null` prefill is a no-op. (R5-adjacent.)

### Why client-side (not a backend endpoint)
- `storyToSpans` is already client-side (`storyToSpans.js`); the spans→render path (`StoriesEditor.jsx:363-371`) proves the client can fully compile a plan. Adding two text transforms keeps the data local (**local-first constraint**) and avoids a round-trip.
- The reverse direction needs to populate the *Stories store* (client state, `storiesSlice.ts`) anyway; a backend parse would still need a JS adapter. Net: pure JS is simpler and testable without a server.
- Explicit alternative (documented, not chosen): a `POST /story/from-script` returning cast+tracks could share the backend `parse_audiobook_script` (`backend/services/audiobook.py:135`) and kill drift — but that is **task #27's** mandate, and a new endpoint would add a network call (and a Python regex over user-supplied script) that the client-side approach avoids entirely. Defer.

## Integration points (file:line)

- **`frontend/src/components/StoriesEditor.jsx:477-495`** — `stories-editor__group` Output cluster (Stems, format `<select>`, `generateAll`); add "Export as Audiobook" action (`Button` or `Menu` item), `disabled={tracks.length === 0 || exporting}`.
- **`frontend/src/components/StoriesEditor.jsx:114-127`** — store selectors block; add `setAudiobookPrefill`, `setStoryPrefill`, `setMode`. (`setStoryTracks`/`setCast` already selected at `:116,118`; read `storyPrefill` via `getState()` in the effect.)
- **`frontend/src/components/StoriesEditor.jsx:136-140`** — existing `_trackId` reseed `useEffect`; **replace** with the combined prefill+reseed effect (Option A) so ordering is deterministic.
- **`frontend/src/components/StoriesEditor.jsx:217`** — `currentProject` (already computed) supplies `opts.projectName`.
- **`frontend/src/components/StoriesEditor.jsx:360-364`** — `generateAll`'s `usable` filter (`tracks.filter((tk) => (tk.text || '').trim())`) + `exportFailed` guard (`if (!chapters.length) { toast.error(t('stories.exportFailed')); return; }`); the new export reuses the same filter + guard key.
- **`frontend/src/pages/AudiobookTab.jsx:189-201`** — `audiobook-tab__actions`; add "Save as Story" `<button className="ui-btn ui-btn--subtle" onClick={…} disabled={!canRun}>`, matching the sibling `<button>` markup (Import/Preview/Create).
- **`frontend/src/pages/AudiobookTab.jsx:19-49`** — props + state hooks; add `import { useAppStore } from '../store'`, the prefill selectors, and the one-shot mount effect (place near the existing cover-cleanup `useEffect` at `:64`). Uses `setText` (`:21`), `setDefaultVoice` (`:22`), `setPlan` (`:23`), `setMeta` (`:36`), `setError` (`:28`). `useTranslation`/`t` already in scope (`:2,20`). `busy`/`canRun` gating at `:177-178`.
- **`frontend/src/store/uiSlice.ts:14`** (add `import type { StoryTrack, CastMember } from './storiesSlice'`), **`:16-30`** (`AppMode` union — add `'audiobook'`; keep `'clone'`/`'design'`), **`:55,67,87,99`** (clone the `pendingProfileId` 4-point pattern for the two new fields/setters).
- **`frontend/src/store/index.ts:74-114`** — `partialize` allowlist; verify the two new fields are **not** added (transient). **`:115`** `version: 4` / **`:120-130`** `migrate` — **no change** (no persisted-shape change).
- **`frontend/src/utils/storyToSpans.js:1-4`** — reuse pattern: identical imports (`parseStoryText`, `isChapterLine`, `chapterTitle`, `effectiveProfile`) for the new `storyToScript`. Return shape `Array<{title, spans:[{voice_id,text,pause_ms_after,speed}]}>` (`:19,21`) is the round-trip oracle.
- **`frontend/src/utils/storyExport.js:62-70`** — `isChapterLine` (`/^#{1,6}\s+/` on `.trim()`) / `chapterTitle` (`.replace(/^#+\s+/, '')`) reused by both new utils.
- **`frontend/src/utils/storyTokens.js:23-54`** — `TOKEN_RE` + `parseStoryText` (returns `{type:'chunk',text,profileId}|{type:'pause',seconds}`) reused by `scriptToStory` for leading-voice detection; `slug` pattern mirrored from `StoriesEditor.jsx:173`. **Note the pause-dialect divergence (R8): never re-emit pause tokens via this tokenizer.** Reuse these existing (CI-clean) regexes; do not author a new user-input regex.
- **`frontend/src/utils/storyCast.js:9-25`** — `CAST_COLORS`, `nextCastColor(cast)`, `effectiveProfile(track, cast)` for cast assembly + default-voice resolution.
- **`frontend/src/store/storiesSlice.ts:12-34,53-55,62-64`** — `StoryTrack`/`CastMember`/`StoryProject`/`DEFAULT_CAST` shapes the new utils must emit; `snapshotTracks` (`:62-64`) defines the persisted field set (`{id,character,text,profileId,emotion,speed}`); clone `DEFAULT_CAST` (`:53`), never reuse the reference.
- **`frontend/src/api/audiobook.ts:100-122`** — `LongformRenderBody` (chapters/spans/`default_voice`/`format`/`loudness`/`cover_path`/`metadata`) + `longformRender(body)` signature; the contract the exported plan must satisfy at render time. **Read-only** reference (the prefill never calls this directly — Create/Generate do).
- **`backend/api/routers/audiobook.py:516`** (`/longform/render` route), **`:345`** (`_render_longform_sse`), **`:160,200,213`** (voice resolution), **`:173`** (the `voice_profiles` SQL) — the resolution contract the exported `[voice:<id>]` must satisfy. **Read-only**; not modified.
- **`backend/services/audiobook.py:36,42,93-160`** (`_HEADING_RE` `:36`, `_VOICE_RE` `:42`, `_parse_spans` `:93-132`, `parse_audiobook_script` `:135-160`) — the script grammar the exported text must satisfy. Note `cur_voice` at `:102`, spanless-chapter drop at `:157-158`, untitled-lead-in at `:147-149`, `Chapter {n}` fallback at `:159`. **Read-only**; not modified.
- **`omnivoice/utils/text.py:226-250`** (`PAUSE_DEFAULT_MS`=350, `PAUSE_MAX_MS`=10000, `_PAUSE_RE` `:233`, `_pause_ms` `:239`), **`:253`** (`parse_pause_markers`) — the backend pause dialect. Diverges from the client `TOKEN_RE`; the basis for R8. **Read-only**.
- **`frontend/src/i18n/locales/en.json`** (`stories` block; `exportFailed` key), (`audiobook` block; `markup_hint` at `:155`) — add new string keys to `en.json` only; non-English locales fall back to English automatically via `fallbackLng: 'en'` (`frontend/src/i18n/index.ts:64`), so no per-locale edits and no CI key-parity gate.
- **`frontend/src/App.jsx:1071-1082`** — existing `mode === 'stories'` / `mode === 'audiobook'` routing (no change needed; confirms both modes already mount with `profiles={profiles}`).

## API / data shapes

**No new HTTP endpoints.** The two utils produce in-process objects that drive existing local state; rendering still goes through the unchanged `/longform/render` SSE endpoint when the user clicks Create (AudiobookTab) or Generate (StoriesEditor). All shapes below are pinned from source.

### New in-process util shapes

```ts
// frontend/src/utils/storyToScript.js — storyToScript(tracks, cast, opts?) → ScriptExport
interface ScriptExport {
  script: string;                                   // chapter-delimited, single-# headings, [voice:<profileId>] tags
  defaultVoice: string | null;                      // most-used effective profile id (deterministic tie-break) → AudiobookTab defaultVoice
  metadata: { title?: string; narrator?: string };  // ONLY non-empty keys; subset of AudiobookTab meta (:36-38)
}

// frontend/src/utils/scriptToStory.js — scriptToStory(text, profiles?) → StoryImport
interface StoryImport {
  // EXACTLY the persisted StoryTrack shape (storiesSlice.ts:12-19) — no transient generating/audioUrl
  tracks: Array<{ id: number; character: string; text: string; profileId: string | null; emotion: null; speed: null }>;
  // CastMember (storiesSlice.ts:21-26); ALWAYS includes a narrator clone (never [], never the shared DEFAULT_CAST ref)
  cast: Array<{ id: string; name: string; color: string; profileId: string | null }>;
}
```

### Store additions (`uiSlice.ts`) — transient, NOT in `partialize`, NOT persisted

```ts
audiobookPrefill: { script: string; defaultVoice: string | null; metadata: Record<string, string> } | null;
storyPrefill:     { tracks: StoryTrack[]; cast: CastMember[] } | null;     // StoryTrack/CastMember from ./storiesSlice
setAudiobookPrefill: (v: UiSlice['audiobookPrefill']) => void;  // set({ audiobookPrefill: v })
setStoryPrefill:     (v: UiSlice['storyPrefill']) => void;      // set({ storyPrefill: v })
```

### Persisted entities the converters read/write (source-pinned)

```ts
// storiesSlice.ts:12-26
interface StoryTrack { id: number; character: string; text: string; profileId: string|null; emotion: string|null; speed: number|null; }
interface CastMember { id: string; name: string; color: string; profileId: string|null; }
// storiesSlice.ts:53-55 — DEFAULT_CAST (clone, never share the reference)
const DEFAULT_CAST = [{ id: 'narrator', name: 'Narrator', color: '#fabd2f', profileId: null }];

// AudiobookTab.jsx:36-38 — local meta state (storyToScript.metadata is a subset of these keys)
meta = { title: '', author: '', narrator: '', year: '', genre: '', description: '' };
// AudiobookTab.jsx:22 — defaultVoice state ('' = engine default; else a profile id)
```

### Render-time contract the exported plan must satisfy (unchanged endpoint, for reference)

`StoriesEditor.generateAll` and `AudiobookTab.onCreate` both ultimately POST to `/longform/render` with this body (`frontend/src/api/audiobook.ts:100-108`):

```ts
interface LongformRenderBody {                       // POST /longform/render, Content-Type: application/json
  chapters: Array<{
    title?: string;
    spans: Array<{ voice_id: string | null; text: string; pause_ms_after: number; speed?: number | null }>;
  }>;
  default_voice?: string | null;                     // ← the prefilled defaultVoice flows here on the Audiobook side
  bitrate?: string;
  format?: 'm4b' | 'mp3';
  loudness?: 'off' | 'acx' | 'podcast' | null;
  cover_path?: string | null;
  metadata?: AudiobookMetadata | null;               // ← the prefilled title/narrator flow here
}
```

Stories posts a **pre-built** `chapters` plan (from `storyToSpans`); Audiobook posts a **script string** that the backend parses into the same `chapters` shape via `parse_audiobook_script` then `_parse_spans`. The Stories `Span` and the backend `Span` are byte-identical in field set (`backend/services/audiobook.py:45-60`: `{voice_id, text, pause_ms_after, speed}`), which is **why** the exported script must render identically — the round-trip invariant (AC3) checks exactly this.

### SSE event grammar emitted by `/longform/render` (read-only; pinned from `_render_longform_sse`)

Read with `splitSSEBuffer`/`parseSSELine` (the existing helpers, `frontend/src/utils/sseParse.js`; consumed in `StoriesEditor.generateAll` `:381-394`). Each line is `data: <json>\n\n`. Event types and exact payloads (`backend/api/routers/audiobook.py:386-465`):

```ts
type LongformEvent =
  | { type: 'started';       job_id: string; chapters: number }                                 // :412
  | { type: 'chapter';       index: number; total: number; title: string; duration_s: number; cached: boolean }  // :430-432
  | { type: 'chapter_error'; index: number; total: number; title: string; error: string }       // :424-425
  | { type: 'assembling' }                                                                       // :438
  | { type: 'done';          output: string; chapters: number; duration_s: number;
                             cached_chapters: number; failed_chapters: number[] }                // :463-465
  | { type: 'error';         error: string };                                                    // :386,390,435,474
```

This task does **not** change these events; they are documented so the round-trip / runtime tests can assert "Create after Export" emits a `done` with `chapters > 0`.

### Exported-script grammar (must match `parse_audiobook_script` `:135` and `_parse_spans` `:93`)

- `^[ \t]*#[ \t]+<non-empty title>$` → chapter break (**H1 only**, `_HEADING_RE` `:36`). Emit single `#`, un-indented; never emit `##…`; never emit empty-title `# `.
- `[voice:<profileId>]` → voice switch; resolved as a profile id by `_resolve_voice` (`backend/api/routers/audiobook.py:160`, SQL `:173`). Never emit `[voice:default]` to mean narrator (`_parse_spans:102` reads it as the literal id `"default"`); omit the tag instead.
- `[pause <n>s]` / `[pause <n>ms]` / `[pause <n>]` (bare→ms) / `[pause]` (default 350 ms) → silence (backend dialect via `parse_pause_markers`, `omnivoice/utils/text.py:253`, `_PAUSE_RE` `:233`, clamp `PAUSE_MAX_MS`=10000). **Passed through verbatim from the user's text; never synthesized by these utils** (client `TOKEN_RE` would mis-read `ms`/bare — R8).
- `[slow]…[/slow]`, `[fast]…[/fast]`, `[emphasis]…[/emphasis]`, `[spell]…[/spell]` → SSML-lite, passed through verbatim (`parse_ssml_lite`/`spell_out`, imported in `backend/services/audiobook.py:106`).
- Emotion tags (`[laughter]`, `[sigh]`, …) → not special to the parser; pass through verbatim (the engine reads them).

## Test plan

> **Codebase correction:** there is **no** `frontend/src/utils/storyToSpans.test.js` to mirror. The closest existing pure-util vitest patterns are `frontend/src/utils/storyExport.test.js`, `frontend/src/utils/storyTokens.test.js`, and `frontend/src/utils/storyCast.test.js` — mirror those (plain `import { describe, it, expect } from 'vitest'`, no RTL).

### Unit (vitest, pure utils)
New `frontend/src/utils/storyToScript.test.js`:
- resolves each line's effective voice via `effectiveProfile` → emits `[voice:<id>]` only on change.
- most-used voice becomes `defaultVoice`; **tie → earliest first occurrence** (assert determinism with a constructed tie).
- all-null cast → `defaultVoice:null`, no `[voice:]` tags anywhere.
- default-voice lines carry **no** tag (and never `[voice:default]`).
- chapter line → single-`#` `# Title`; `##`/`###` input downgraded to `#`; **indented** heading emitted un-indented; empty-title heading dropped; pre-heading lines emitted before first `#`; all-pre-heading story emits flat script.
- line already leading with `[voice:A]` where effective == running voice → not double-tagged.
- metadata: only non-empty keys present; `title` from `opts.projectName`; `narrator` from default-voice cast member name; `narrator`/`title` omitted when null/empty.
- inline `[pause 500ms]`/`[pause]`/`[voice:]`/SSML-lite/`[laughter]` passed through **byte-for-byte** (no re-tokenization, R8 guard).
- empty/`null`/`undefined` tracks → `{script:'', metadata:{}, defaultVoice:null}`; only-chapter / only-whitespace tracks → empty script; pause-only line preserved verbatim.
- per-line `speed`/`emotion` field dropped (assert no token leaks into script).

New `frontend/src/utils/scriptToStory.test.js`:
- `# H` lines → chapter tracks (heading re-emitted canonically as `# <title>`); body lines → spoken tracks.
- `\r\n` normalized; blank lines dropped (no empty tracks). **(Cross-platform determinism: same input with `\r\n` vs `\n` yields identical tracks — guards the default-everywhere rule.)**
- leading `[voice:<id>]` stripped → track `profileId` set + cast member created with matching `profiles` name; **unknown id → cast member name = raw id, `profileId = raw id`** (round-trips back out).
- leading `[voice:default]`/`[voice:]` → `profileId:null`, narrator, tag stripped.
- mid-line `[voice:]`/`[pause 500ms]`/bare `[pause]` left in text (not split, not normalized — R8).
- two ids slugging to the same value → unique cast ids; an id slugging to `narrator` → de-duped, default narrator's `profileId` stays `null`.
- empty/whitespace/`null` script → `{tracks:[], cast:[narrator-clone]}` (cast never empty; clone, not the shared `DEFAULT_CAST` reference — assert mutating the result doesn't affect `DEFAULT_CAST`).
- only-headings script → chapter tracks, no spoken tracks.
- sequential numeric `id`s starting at 1; track shape matches persisted `StoryTrack` (`{id,character,text,profileId,emotion:null,speed:null}`), no `generating`/`audioUrl` keys (`expect(Object.keys(track).sort())` equals the 6 persisted keys).
- body text preserved byte-for-byte (R2 guard).
- **CJK-content passthrough:** a body line of user-typed CJK (e.g. Japanese narration) survives byte-for-byte into the track text — confirms the util treats non-English text as opaque user content (not a UI string) and never mangles it.

### Round-trip (the property that matters)
- **Render-equivalence invariant:** for the common case, let `ex = storyToScript(T, C, {projectName})`, `im = scriptToStory(ex.script, P)`; then `storyToSpans(im.tracks, im.cast)` is **render-equivalent** to `storyToSpans(T, C)` — same chapter `title` sequence, same span `voice_id` sequence, same span `text`, same `pause_ms_after`. Speed differences are expected (R3) → compare spans **ignoring `speed`**, or assert `speed === null` on the round-tripped side. Fixtures: (a) single narrator no chapters; (b) two voices, two chapters; (c) chapters + inline `[pause 750ms]` + bare `[pause]` + inline mid-line `[voice:]` + `[emphasis]`; (d) unknown voice id (asserts `profileId` survives via the raw token → identical `voice_id` in the round-tripped spans).
- **Lossy-case assertions:** H2 heading → H1 after round-trip (R7); per-line `speed` → `null` (R3).

### Component (vitest + RTL, light)
- `StoriesEditor`: clicking "Export as Audiobook" with non-empty tracks calls `setAudiobookPrefill` with a non-empty `script` + `setMode('audiobook')`; with empty/only-chapter tracks shows `toast.error(t('stories.exportFailed'))` and does **neither**. (If a full mount is unwieldy, drive `storyToScript` + a thin click handler unit test.)
- `AudiobookTab`: with `audiobookPrefill` set, mount populates `text`/`defaultVoice`/`meta`, clears `plan`/`error`, and clears the prefill — assert **one-shot** (a forced re-render does not re-apply; `setText` not called twice).
- `AudiobookTab`: `defaultVoice` not in `profiles` → mount still sets it (or leaves `''` per the documented choice); no crash, no console error.
- `AudiobookTab`: clicking "Save as Story" with non-empty `text` and **empty** `storyTracks` calls `setStoryPrefill` + `setMode('stories')` (no confirm); with **non-empty** `storyTracks` shows the confirm — proceed → sets prefill + nav; cancel → no prefill, no nav. Empty `text` → `setError(t('audiobook.saveAsStoryEmpty'))`, no nav.
- `StoriesEditor`: with `storyPrefill` set, mount applies `setStoryTracks`/`setCast`, clears the prefill, and the `_trackId` reseed accounts for the imported max id (add a line after import → id > max imported).
- **Null-prefill no-op:** both mount effects with `null` prefill do nothing (guards the reload-while-pending case, R5-adjacent).
- **i18n keys resolve:** assert the rendered button/toast/confirm text comes from `t('…')` (e.g. the test i18n instance returns the key or the English string), confirming no hardcoded literal slipped in.

### Manual / runtime (memory: runtime-verify shipped longform features)
- Build a 2-character, 2-chapter story → Export as Audiobook → confirm script + default voice + title/narrator prefilled (`AudiobookTab.jsx:209` textarea, `:220` default-voice select, title input in the meta panel) → Preview plan (`:194`) shows 2 chapters → Create (`:197`) → SSE stream ends in a `done` event with `chapters===2`, output renders, chapters intact. Then Save as Story from that same script → confirm cast (2 voices, real names) + 2 chapter cards reappear → Generate (`StoriesEditor.jsx:492`) → render is equivalent.
- **Edge runs:** (a) story with only the narrator and no chapters → Export → script has no `#`/no `[voice:]` → renders as one untitled chapter; (b) an Audiobook script with a `[pause 750ms]` and a bare `[pause]` → Save as Story → re-export → render keeps both pauses (R8 verification); (c) Save as Story while a non-empty Stories project is open → confirm dialog appears, cancel preserves the open story.
- **Backward-compat run:** open the app against an **existing pre-this-build `omnivoice.app` localStorage** (a v4-persisted store with a saved Stories project) → confirm the saved project hydrates unchanged and the two new prefill fields are `null` (no migration prompt, no console error).
- Cross-platform: it is a text transform + nav + a `window.confirm`, so behavior is identical on macOS/Windows/Linux. No platform branches; verify on at least Linux (dev) and confirm no platform code exists in the diff (`git grep -i 'process.platform\|navigator.platform\|os.platform' frontend/src/utils/storyToScript.js frontend/src/utils/scriptToStory.js` → empty).

### Gates (memory: merge discipline)
- `bunx vitest run` green locally before push.
- `bun run lint` / typecheck (the `AppMode` union edit + the two typed prefill fields + the `StoryTrack`/`CastMember` import in `uiSlice.ts` must compile).
- `tests/test_no_hardcoded_cjk.py` — N/A for new *backend* code (none added); all new UI strings go through i18n; the new files contain no hardcoded CJK, so `_ALLOWED_FILES` needs no edit.
- **CodeQL** (`py/polynomial-redos` and JS analogue): no new Python is added, so the `py/`-prefixed rule is trivially clear; the JS side reuses only existing linear regexes. (memory: codeql-redos-regex.)
- CI `gh pr checks` must be green before merge.

## Constraints

This section states, per OmniVoice hard rule, exactly how the spec satisfies it.

- **Cross-platform parity / default-features-everywhere (P0 rule).** Ships in **default mode** (no toggle, no env var, no opt-in). Pure JS text transforms + a zustand store handoff + `setMode` nav + a `window.confirm` dialog — all webview-standard APIs identical on macOS (WKWebView), Windows (WebView2), and Linux (WebKitGTK). **No platform branches** in `storyToScript.js`/`scriptToStory.js`/the UI wiring; the one place line endings could diverge (`\r\n` from a Windows paste) is normalized to `\n` in `scriptToStory` *before* parsing, so the transform is byte-for-byte deterministic on every OS (unit-tested).
- **Local-first guarantee.** No network call, no new HTTP endpoint, no account/token, no telemetry. Both conversions run in-process on the client. The render path it hands off to (`/longform/render`) is the existing fully-local renderer — unchanged.
- **Backward-compatible project data.**
  - **No DB schema change → no alembic migration.** Voice resolution reads the existing `voice_profiles` schema unchanged (`backend/api/routers/audiobook.py:173`). `git diff backend/ omnivoice/` is empty (AC7).
  - **localStorage: lazy default, no migration step.** The two new store fields are **transient** — excluded from the opt-in `partialize` allowlist (`store/index.ts:74-114`), so the persisted shape and `version: 4` (`:115`) are unchanged and the `migrate` fn (`:120-130`) is untouched. Existing `omnivoice.app` stores hydrate as-is; the new fields initialize to `null` from the slice factory (`uiSlice.ts:80-93`).
  - **Imported tracks emit the persisted `StoryTrack` shape** (`{id,character,text,profileId,emotion,speed}`, no transient `generating`/`audioUrl`), so a Save-then-reload re-hydrates cleanly through the existing partialize mapping (`store/index.ts:109-110`, identical field destructure).
- **CodeQL (`py/polynomial-redos` + JS ReDoS analogue).** No backend Python added. Both utils **reuse the already-shipped, CI-clean** regexes (`TOKEN_RE` `storyTokens.js:23`, `isChapterLine`/`chapterTitle` `storyExport.js:63,68`, the linear `slug()` `StoriesEditor.jsx:173`) and process user-controlled script via fixed-substring operations (`split('\n')`, `.startsWith`, the reused linear tokenizer) — **no new regex over user input**.
- **Localization (i18n hard rule).** Every new user-facing string is a `t('…')` key added to `frontend/src/i18n/locales/en.json` only; non-English locales fall back to English via `fallbackLng: 'en'` (`frontend/src/i18n/index.ts:64`). **New keys:** `stories.toAudiobook`, `stories.toAudiobookDone` (inside the `stories` block); `audiobook.saveAsStory`, `audiobook.saveAsStoryEmpty`, `audiobook.saveAsStoryConfirm` (inside the `audiobook` block) — plus any tooltip/aria labels. Reuse `stories.exportFailed` for the empty-export guard. The two utils carry **user content** (project title, cast names, narration — which may legitimately be CJK); that is allowed (user data is not UI chrome) and the utils treat it as opaque (byte-for-byte passthrough, unit-tested with a CJK fixture).
- **Render-equivalence (self-imposed correctness invariant).** A script exported from a story must render identically through `/longform/render` regardless of which front door produced it — enforced by emitting profile-id voice tags + single-`#` headings + no synthesized/`default` voice tags + verbatim pause/SSML passthrough, and by the round-trip unit test (AC3).
- **Versioning (continuous-to-main, no RC).** Feature PR onto `main` (already at *latest release + 1 patch*). **No version bump in this PR**; no `-rc` tag, no soak, no `v0.4` deferral. The `AppMode` edit is additive type-cleanup, not a versioned milestone.
- **Docs-sync (hard rule).** The Stories editor spec at `docs/superpowers/specs/2026-05-30-stories-editor-studio-design.md` (referenced at `StoriesEditor.jsx:5,10` and `storiesSlice.ts:5`) gains a "Convert ⇄ Audiobook" note (including the loss/fidelity matrix and the destructive-handoff confirm) in the **same PR**. The Audiobook markup-reference string (`audiobook.markup_hint`, `en.json:155`) keeps `[voice:NAME]` but adds a one-line clarification that NAME is resolved as a profile id (matches `backend/api/routers/audiobook.py:160,173`). No README/CONTRIBUTING/SECURITY/SUPPORT/install/Docker/platform doc is affected.

## Dependencies

- **No new packages** — uses existing `react-i18next` (`StoriesEditor.jsx:15`, `AudiobookTab.jsx:2`), `react-hot-toast` (`StoriesEditor.jsx:14`; `AudiobookTab` uses `setError` state, not toast), the zustand store, and in-repo utils (`storyTokens.js`, `storyExport.js`, `storyCast.js`, `ssmlLite.js`).
- **Depends on (already shipped)**: `/longform/render` (`backend/api/routers/audiobook.py:516`), the shared SSE renderer `_render_longform_sse` (`:345`) and its event grammar (pinned above), `longformRender(body)` client (`frontend/src/api/audiobook.ts:116`), `parse_audiobook_script` (`backend/services/audiobook.py:135`), the shared pause dialect `parse_pause_markers` (`omnivoice/utils/text.py:253`), SSML-lite client/server parity (`frontend/src/utils/ssmlLite.js` ↔ `backend/services/ssml_lite.py`), and `fallbackLng: 'en'` (`frontend/src/i18n/index.ts:64`).
- **Related (do not couple to / do not block on)**: #27 (parser unification — would later let `scriptToStory` reuse one canonical parser, removing the **three** divergences above), #31 (unified LongformProject store — would subsume `audiobookPrefill`/`storyPrefill` into one project object; keep the prefill fields small so it can replace them cleanly). #22 (shared VoiceSelector), #23/#30 (other import sources) are independent.

## Risk

- **R1 — Voice-namespace confusion (HIGH→mitigated)**: emitting display names in `[voice:]` would break the render (backend keys on profile id via `_resolve_voice`, `backend/api/routers/audiobook.py:160-175`). Mitigation: emit profile ids; round-trip test asserts render-equivalence. The markup-reference UI says "NAME" but the resolver proves it is a profile id; document so a future contributor doesn't "fix" it to names.
- **R2 — Parser drift (MEDIUM)**: `scriptToStory` uses the client `parseStoryText` (`storyTokens.js:25`, regex `TOKEN_RE` `:23`) while the *render* uses the backend `_parse_spans` (`backend/services/audiobook.py:93`, regexes `_VOICE_RE` `:42` / `parse_pause_markers`). They already coexist (#27 target). Keep `scriptToStory` to *leading-voice + chapter* structure only, leaving inline markup verbatim in the text. Test asserts body text is untouched.
- **R3 — Per-line `speed` is lossy through the script (LOW, documented)**: the audiobook grammar has no per-line speed token (`_parse_spans` reads `speed` only from inline SSML segments, `backend/services/audiobook.py:118-121`). Story→script drops the `StoryTrack.speed` slider value (`storiesSlice.ts:18`); it round-trips to `null`. Inline `[slow]/[fast]` tags *do* round-trip. Note in the export toast / docs.
- **R4 — `AppMode` union edit ripple (LOW)**: adding `'audiobook'` is purely additive; `setMode` (`:62,94`) already receives those strings at runtime (`NavRail.jsx:48`, `App.jsx:1031-1083`). **Do not remove `'clone'`/`'design'`** (load-bearing for persisted-state shims, `uiSlice.ts:21-23`).
- **R5 — One-shot prefill double-apply / reload-drop (LOW)**: empty deps `[]` + immediate clear (`setAudiobookPrefill(null)` / `setStoryPrefill(null)`); guard `if (!prefill) return;` so a `null` prefill is a safe no-op; component test asserts single application. (The `pendingProfileId` handoff in `App.jsx:254-268` is a *polling* effect; this spec's prefill is simpler and genuinely one-shot.)
- **R6 — Empty/degenerate input (LOW)**: guard both buttons (empty/only-chapter export → `toast.error(t('stories.exportFailed'))`; empty script → `setError(t('audiobook.saveAsStoryEmpty'))`) with no navigation. `scriptToStory` always returns at least the narrator cast (never `[]`).
- **R7 — Heading-depth / empty-title loss (LOW, documented)**: backend `_HEADING_RE` (`:36`) is H1-only and requires a non-empty title; client `isChapterLine` (`storyExport.js:63`) accepts H1–H6. `storyToScript` normalizes to single `#` and drops empty-title headings; a deeper Stories heading silently becomes narrated body on the backend. Loss matrix + docs.
- **R8 — `[pause]` dialect mismatch (MEDIUM, mitigated by passthrough)**: client `TOKEN_RE` (`storyTokens.js:23`) reads bare `[pause N]` as **seconds**, requires a number, ignores `ms`; backend `_PAUSE_RE` (`omnivoice/utils/text.py:233`) reads bare `[pause N]` as **ms**, accepts bare `[pause]` (default 350 ms) and `ms`/`s` suffixes. **Mitigation:** neither util ever synthesizes or normalizes a pause token — pause markup is passed through byte-for-byte, so the **backend** dialect (the one that renders) always interprets it. Fixture (c) + the byte-for-byte body assertion guard this. #27 will unify the dialects.
- **R9 — Mid-script "revert to engine default" not expressible (LOW, documented)**: because `[voice:default]` can't be emitted (divergence #2), a Stories line that resolves to `null` *while the running script voice is non-null* cannot be serialized as "back to engine default"; `storyToScript` keeps it on the running voice instead. Only arises in hand-built mixed casts; loss matrix.
- **R10 — Per-line `emotion` field lost if not in text (LOW, documented)**: emotion added via the tone drawer is injected as inline tags into `tk.text` (survives), but a bare `emotion` field with no in-text tag has no script token → dropped; round-trips to `null`. Loss matrix.
- **R11 — Destructive handoff overwrites unsaved work (MEDIUM, mitigated)**: both handoffs replace the destination working set. Save-as-Story guards with a `window.confirm` when `storyTracks` is non-empty; Export-as-Audiobook overwrites the Audiobook draft (visible, user-initiated). Saved `storyProjects` never touched. Confirm path tested.
- **R12 — Stale project header after import (LOW, documented)**: Save-as-Story replaces tracks/cast but leaves `currentProjectId` → the header may show a previously-open project name over imported content. Treat the import as unsaved; user clicks Save. Documented; no code change beyond the note.
- **R13 — i18n key only in `en.json` (LOW, by-design)**: new keys are added only to `en.json`; non-English locales render English until translated — consistent with `fallbackLng: 'en'` (`frontend/src/i18n/index.ts:64`); no CI parity gate.

## PR slices

Single small PR is feasible, but if split:

1. **Slice 1 — pure utils + tests** (`frontend/src/utils/storyToScript.js`, `frontend/src/utils/scriptToStory.js`, plus `storyToScript.test.js` / `scriptToStory.test.js` mirroring `storyExport.test.js` style). No UI, no store. Independently mergeable, fully unit-tested, zero user-visible change. Establishes the render-equivalence invariant + the loss matrix.
2. **Slice 2 — store + wiring + i18n + UI buttons**: `uiSlice.ts` (`AppMode` + the two transient prefill fields/setters + the `StoryTrack`/`CastMember` import), the two buttons, the two one-shot mount effects (incl. the StoriesEditor combined prefill+reseed effect and the Save-as-Story confirm guard), new `en.json` keys (English-only; auto-fallback), component tests, docs-sync note (incl. loss matrix + destructive-handoff confirm) in `docs/superpowers/specs/2026-05-30-stories-editor-studio-design.md`. Depends on Slice 1.

(If shipped as one PR, order the diff utils-first for reviewability. Either way: feature PR onto `main`, no version bump, no RC.)

## Acceptance criteria

- **AC1** — `storyToScript(tracks, cast, {projectName})` returns `{script, metadata, defaultVoice}` of the exact `ScriptExport` shape above; `[voice:]` tags carry **profile ids** (never `[voice:default]` for narrator); default-voice lines carry no tag; ties in default-voice selection break deterministically (earliest occurrence); chapters become **single-`#`** un-indented headings; empty-title headings dropped; inline markup (incl. `[pause Nms]`/bare `[pause]`) verbatim; `metadata` has only non-empty keys (`title`/`narrator` subset of `meta`). Empty/only-chapter/only-whitespace input → `{script:'', metadata:{}, defaultVoice:null}`. Unit tests pass.
- **AC2** — `scriptToStory(text, profiles)` returns `{tracks, cast}` of the exact `StoryImport` shape; chapter cards (canonical `# `), leading-voice → `profileId` + named cast member, **unknown id → cast member named after the raw token with `profileId = the raw id`** (round-trips), `[voice:default]`/empty → narrator, slug collisions de-duped (narrator's `profileId` stays `null`), `\r\n` normalized (cross-platform-identical), blank lines dropped, sequential numeric ids from 1, and **always** the narrator clone in `cast` (never `[]`, never the shared `DEFAULT_CAST` reference). Track shape is exactly the 6 persisted keys (`{id,character,text,profileId,emotion:null,speed:null}`, no transient fields). Unit tests pass.
- **AC3** — Round-trip: `storyToSpans(scriptToStory(storyToScript(T,C).script, P).tracks, scriptToStory(...).cast)` is render-equivalent to `storyToSpans(T,C)` for the common case (same `title`/`voice_id`/`text`/`pause_ms_after` sequence; speed compared ignoring or asserted `null`; H2→H1 and speed/emotion-field loss documented). Test asserts this across the four fixtures.
- **AC4** — "Export as Audiobook" in `StoriesEditor` (`:477-495` group) calls `setAudiobookPrefill({script,metadata,defaultVoice})` + `setMode('audiobook')`; the AudiobookTab mount effect prefills `text`/`defaultVoice`/`meta`, clears `plan`/`error`, and clears the prefill (one-shot); clicking Create produces a `done` SSE with chapters intact. Empty/only-chapter story → `toast.error(t('stories.exportFailed'))`, no nav.
- **AC5** — "Save as Story" in `AudiobookTab` (`:189-201` actions) calls `setStoryPrefill({tracks,cast})` + `setMode('stories')`; the StoriesEditor mount effect loads cast + tracks (incl. chapter cards); clicking Generate produces an equivalent render. Empty script → `setError(t('audiobook.saveAsStoryEmpty'))`, no nav. With a non-empty open Stories project, a `window.confirm` (cross-platform default) gates the overwrite (proceed applies, cancel is a no-op).
- **AC6** — Prefill is one-shot (consumed + cleared on mount; **not in the `partialize` allowlist** at `store/index.ts:74-114` → never serialized; a re-render does not re-apply; a `null` prefill is a safe no-op). The StoriesEditor `_trackId` reseed accounts for imported ids (new line after import gets `id > max imported`). Existing v4-persisted stores hydrate unchanged (no migration). Component tests confirm.
- **AC7** — No backend changes; `/longform/render` (`backend/api/routers/audiobook.py:516`), `parse_audiobook_script` (`backend/services/audiobook.py:135`), and `parse_pause_markers` (`omnivoice/utils/text.py:253`) untouched. `git diff backend/ omnivoice/` is empty (→ no alembic migration, no `py/polynomial-redos` surface).
- **AC8** — All new strings are i18n keys (no hardcoded JSX literals, English or CJK); keys added to `en.json` only with English auto-fallback; `AppMode` (`uiSlice.ts:16`) includes `'audiobook'` (and retains `'clone'`/`'design'`), the two prefill fields are typed via `StoryTrack`/`CastMember` imported from `./storiesSlice`, and the project typechecks.
- **AC9** — Default-everywhere: the diff contains no platform branch (`git grep` over the two new util files for `process.platform`/`navigator.platform`/`os.platform` is empty); the round-trip is byte-for-byte deterministic regardless of `\r\n`/`\n` input. No opt-in toggle needed (no platform-only behavior introduced).
- **AC10** — `bunx vitest run`, lint/typecheck, and CI PR checks all green before merge. Feature lands continuous-to-main with no version bump and no RC tag.
