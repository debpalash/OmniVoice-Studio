# Spec — TASK #33: Standalone chapter cue-sheet (.txt) export

## TL;DR
Add a downloadable plain-text chapter cue sheet (`HH:MM:SS<TAB>Title`, one line per chapter) for both longform front doors (Audiobook + Stories). The data is already streamed: each `chapter` SSE event from the shared renderer (`_render_longform_sse`, `backend/api/routers/audiobook.py:345`) carries `title` + `duration_s`. The frontend currently uses those events only for progress and throws the durations away. We accumulate per-chapter start times client-side over the **successful** chapters (skipping `chapter_error`), build the cue sheet with the **already-existing, already-tested** `formatTimecode` + `buildCueSheet` helpers in `frontend/src/utils/storyExport.js`, and expose a "Download cue sheet (.txt)" action next to the existing audio download. **No backend change, no new dependency.** The m4b already embeds chapters; this is the nicety for players/formats that don't read embedded chapters (e.g. mp3, or external chapter-aware players).

## Problem
- The shared chapterized renderer streams a `chapter` SSE event per rendered chapter that includes `duration_s` (`backend/api/routers/audiobook.py:430-432`), but the two consumers — `AudiobookTab.jsx` (`onCreate`, `frontend/src/pages/AudiobookTab.jsx:113-175`) and `StoriesEditor.jsx` (`generateAll`, `frontend/src/components/StoriesEditor.jsx:360-402`) — read `chapter`/`chapter_error` events **only to drive a progress percentage** (Audiobook: lines 153-158; Stories: combined branch at lines 387-388) and **discard `duration_s`**.
- The **m4b** output embeds chapters via FFMETADATA (`build_ffmetadata`, `backend/services/longform_render.py:173-197`), but:
  - the **mp3** output format does not get chapter markers in any player-portable way, and
  - users want a human-readable / re-importable cue sheet (timestamps + titles) for show-notes, YouTube chapters, external editors, podcast platforms, etc.
- The helpers to produce such a cue sheet (`formatTimecode` at `frontend/src/utils/storyExport.js:72-79`, `buildCueSheet` at `:94-97`) already exist and are unit-tested in `frontend/src/utils/storyExport.test.js` (the `chapter helpers` block, `:44-61`), but are only wired into the **legacy client-side** `exportStoryAudio` path (`storyExport.js:109-148`) — which currently does **not** surface its returned `chapters` array to the user. Neither helper has any caller in `frontend/src/**` outside `storyExport.js` / its test (verified by grep this session — `buildCueSheet` is referenced only at `storyExport.js:96` and `storyExport.test.js:4,57-58`; `formatTimecode` only at `storyExport.js:73,96` and `storyExport.test.js:4,52-55`), so the current shared SSE-driven renderer that both tabs actually use produces no cue sheet at all.

## Goal / Non-goals
**Goals**
- After a successful longform render (Audiobook or Stories), the user can download a `.txt` cue sheet with one `HH:MM:SS<TAB>Title` line per **successfully-rendered** chapter, start times accumulated from `duration_s`.
- Cue-sheet start times exactly match the embedded m4b chapter START offsets (same source: successful chapters, in order — see `chapters_meta` below).
- Works identically on macOS / Windows / Linux (pure client-side text + Blob download — satisfies the "default features work on every platform" constraint).
- Reuse the existing `formatTimecode` + `buildCueSheet` helpers; do not introduce a second timecode formatter.

**Non-goals**
- No new backend endpoint and no change to the SSE event shape (`duration_s` is already there).
- No alternate cue formats (CUE sheet `INDEX`/`FILE`, WebVTT chapters, ffmetadata re-export) in this slice — plain `HH:MM:SS<TAB>Title` only. (Format variants are a clean follow-up; the accumulator is format-agnostic.)
- No re-import of cue sheets.
- No change to mp3 chapter embedding (out of scope; the cue sheet is the portable alternative).
- Not touching the legacy client-side `exportStoryAudio`/`exportStems` paths.

## Design

### Where the data comes from (already exists)
`_render_longform_sse` (`backend/api/routers/audiobook.py:345`) emits, per rendered chapter:
```
{"type":"chapter","index":i,"total":N,"title":<title>,"duration_s":round(dur,2),"cached":<bool>}
```
(`backend/api/routers/audiobook.py:430-432` — note `duration_s` is `round(dur, 2)`, i.e. 2-decimal seconds)
and for a failed chapter:
```
{"type":"chapter_error","index":i,"total":N,"title":<title>,"error":"chapter failed to render"}
```
(no duration — `backend/api/routers/audiobook.py:424-425`)

The muxed file (and its embedded FFMETADATA chapters) only contains **successful** chapters: `chapters_meta.append((chapter.title, int(round(dur * 1000))))` runs **only on success**, immediately before the `chapter` event (`backend/api/routers/audiobook.py:428`), inside the `try`/`except` chapter loop (`:414-432`). On failure the loop `continue`s after emitting `chapter_error` (`:420-426`), so neither `chapters_meta` nor the cue accumulator advances. **The cue sheet must mirror this exactly**: only `chapter` events contribute a cue; `chapter_error` events are skipped. This is the single load-bearing correctness invariant.

A `cached` chapter (resumed from the content-addressed cache) still emits a full `chapter` event with a real `duration_s` (`audiobook.py:429-432` runs whether or not `was_cached`), so resumed chapters contribute cues identically to freshly-rendered ones — there is no separate "cached, no duration" case to handle.

Note the rounding asymmetry, relevant to the drift discussion below: the m4b chapter START/END are built from `int(round(dur * 1000))` **milliseconds** (`audiobook.py:428` → `build_ffmetadata`, `longform_render.py:186-196`), while the SSE `duration_s` the client receives is `round(dur, 2)` **seconds**. Both descend from the same per-chapter `dur` float; the only divergence is rounding granularity (ms vs. centiseconds), which is sub-second per chapter.

### SSE event catalogue — exact JSON shapes (read-only, no change)
The full set of events `_render_longform_sse` can emit over the stream both front doors consume. Each is one `data: <json>\n\n` frame (`_emit`, `audiobook.py:377-383`). The client reads them via `splitSSEBuffer` → `parseSSELine` (`frontend/src/utils/sseParse.js:14,29`) — `parseSSELine` strips the `data:` prefix, `JSON.parse`s the rest, and returns `null` on a malformed/non-`data:` line. **None of these shapes change**; the cue feature only changes which ones contribute a cue and which gate the download. All numeric fields are JSON numbers (not strings); `index`/`total`/`chapters`/`cached_chapters` are integers; `duration_s` is a float (already `round()`-ed); `cached` is a boolean; `failed_chapters` is an array of integers; `output`/`title`/`error` are strings.

| Event JSON (exact) | Source line | Precondition | Cue impact | Sets `output`? |
|---|---|---|---|---|
| `{"type":"started","job_id":"<16-hex>","chapters":<int N>}` | `audiobook.py:412` | always (once, after plan & ffmpeg checks pass) | reset accumulator to `[]` | no |
| `{"type":"chapter","index":<int i>,"total":<int N>,"title":"<str>","duration_s":<float>,"cached":<bool>}` | `audiobook.py:430-432` | per **successful** chapter (fresh or cached) | **push one cue** `{title, duration_s}` | no |
| `{"type":"chapter_error","index":<int i>,"total":<int N>,"title":"<str>","error":"chapter failed to render"}` | `audiobook.py:424-425` | per **failed** chapter | **skip** (no cue, no time advance) | no |
| `{"type":"assembling"}` | `audiobook.py:438` | once, after ≥1 chapter succeeded, before mux | none | no |
| `{"type":"done","output":"<job_type>_<job_id>.<ext>","chapters":<int succeeded>,"duration_s":<float>,"cached_chapters":<int>,"failed_chapters":[<int>,…]}` | `audiobook.py:463-465` | once, only when `chapter_files` non-empty | finalize → enable button | **yes** |
| `{"type":"error","error":"<str>"}` | `audiobook.py:386,390,435,474` | any terminal failure (see below) | none | **no** |

`error` is emitted at four distinct points, each with a fixed `error` string the client may surface verbatim:
- **No chapters in plan** → `{"type":"error","error":"nothing to render (no chapters)"}` (`audiobook.py:386`) — `started` never fires, accumulator stays `[]`.
- **ffmpeg missing** → `{"type":"error","error":"ffmpeg not available; the output needs it"}` (`audiobook.py:390`) — `started` never fires.
- **All chapters failed** → after the loop, `if not chapter_files: {"type":"error","error":"all chapters failed to render"}` (`audiobook.py:434-435`) — `started` fired, but every event was a `chapter_error`, so the accumulator is `[]` and there is no `done`/`output`.
- **Unhandled mid-render exception** (e.g. ffmpeg mux fails) → `{"type":"error","error":"render failed (see backend log)"}` (`audiobook.py:466-474`) — `started` and one or more `chapter` events may already have fired, so the accumulator is **non-empty** but there is **no `done`/`output`**. The button must still **not** appear, because the audio file the cues describe does not exist. **The button is gated on `output` being set by `done`, never on the accumulator being non-empty.**

Crucially, `done` is emitted **only when `chapter_files` is non-empty** (`audiobook.py:434-436` returns before `done` otherwise), so "successful `done` with zero cues" is structurally impossible. The accumulator is guaranteed ≥1 cue whenever `output` is set. A defensive `cues.length > 0` check is still applied (cheap belt-and-suspenders against a future backend change) but is not the primary gate.

**Field-name collision warning (Audiobook loop):** `AudiobookTab.onCreate` destructures the stream-reader result as `const { done, value } = await reader.read()` (`AudiobookTab.jsx:143`) — this `done` is the **reader's** end-of-stream boolean, a *different binding* from the SSE event whose `evt.type === 'done'`. The new code must `setCues(localCues)` inside the `evt.type === 'done'` branch (`:159-164`), **not** in any block that references the reader's `done`. The two never need to be referenced together; this note exists only to prevent a wrong-variable edit.

### Fields the client reads (and ignores) — pinned
| Field | From event | Read by cue feature? | Notes |
|---|---|---|---|
| `evt.type` | all | yes (branch key) | exact string match against the six values above |
| `evt.index` | `chapter`, `chapter_error` | progress only (unchanged) | 0-based; both branches keep using `evt.index + 1` for the progress %|
| `evt.total` | `chapter`, `chapter_error`, `started` (`chapters`) | progress only | Stories uses `total` (set from `started`) for the denominator |
| `evt.title` | `chapter`, `chapter_error` | **yes (chapter only)** | string; goes into the cue `title` (trimmed) |
| `evt.duration_s` | `chapter` | **yes (chapter only)** | float seconds; accumulated into start time |
| `evt.cached` | `chapter` | no | does not affect cue inclusion |
| `evt.output` | `done` | **yes** | the gate; also the source for `cueSheetFilename` |
| `evt.chapters` | `done` (succeeded count), `started` (planned N) | no (Audiobook uses for `done` panel already) | distinct meaning per event — see catalogue |
| `evt.cached_chapters` / `evt.failed_chapters` | `done` | no (Audiobook already surfaces in the done panel) | unchanged |
| `evt.error` | `error`, `chapter_error` | no (surfaced as existing toast/error state) | unchanged |

### New pure helper (cue accumulation) — exact signature
Add one small pure function to `frontend/src/utils/storyExport.js` (co-located with the existing `formatTimecode`/`buildCueSheet` at `:72-97`, and unit-testable in the existing `frontend/src/utils/storyExport.test.js`):

```js
/**
 * @typedef {Object} ChapterEvent
 * @property {string} [title]       chapter heading (may be missing/blank)
 * @property {number|string} [duration_s]  seconds (may be NaN/negative/missing)
 *
 * @typedef {Object} Cue
 * @property {number} time   start-time in seconds (float; floored only at display)
 * @property {string} title  resolved title (trimmed, or `Chapter {n}` fallback)
 */

/**
 * Accumulate {time,title} cues from the ordered list of successful chapter
 * events ({title, duration_s}). The start time of cue k is the summed duration
 * of chapters 0..k-1 — i.e. cue 0 is at 00:00:00. Mirrors the START offsets
 * the backend writes into the m4b's FFMETADATA chapters (successful chapters
 * only, in order — see build_ffmetadata), so the .txt and the embedded chapters agree.
 *
 * @param {ChapterEvent[]|null|undefined} chapters
 * @returns {Cue[]}   total function: never throws, never returns NaN time
 */
export function cuesFromChapters(chapters) {
  const cues = [];
  let t = 0;
  for (const c of chapters || []) {
    cues.push({ time: t, title: (c.title || '').trim() || `Chapter ${cues.length + 1}` });
    t += Math.max(0, Number(c.duration_s) || 0);
  }
  return cues;
}
```
Then `buildCueSheet(cuesFromChapters(rendered))` yields the file body.

**Edge cases the helper must handle (all covered by `Math.max(0, Number(c.duration_s) || 0)` and the title fallback):**
- **Empty list** (`[]`, `null`, `undefined`) → `[]`. `buildCueSheet([])` → `''` (empty `.map().join` → empty string). Callers must not offer the button in this state (gated by `output`, see above), so an empty `.txt` is never written — but the helper itself is total.
- **`duration_s` missing / `undefined` / `null`** → `Number(undefined)` is `NaN`, `NaN || 0` is `0` → contributes a 0-length chapter; time does not advance. No `NaN` ever enters `t` (`NaN` would poison every subsequent timecode).
- **`duration_s` negative** (should never happen from the backend `round(dur,2)` of a real audio duration, but defend anyway) → `Math.max(0, …)` clamps to 0; **time never goes backward**, so cues stay monotonically non-decreasing.
- **`duration_s === 0`** (legitimately: a successful but silent/near-empty chapter) → the next cue shares the **same timestamp** as this one. Two consecutive identical `HH:MM:SS` lines is correct (it mirrors a zero-length m4b chapter: `START==END` in `build_ffmetadata` when `dur_ms==0`). **Do not deduplicate** identical timestamps.
- **`duration_s` a string** (defensive) → `Number("42.5")` coerces fine; `Number("abc")` → `NaN` → 0.
- **`title` empty / whitespace-only / missing** → falls back to `Chapter {n}` where `n` is the 1-based position **among successful cues** (`cues.length + 1`), not the backend `index` (which counts failed chapters too). This is intentional: the cue sheet's chapter numbering is contiguous over the successful set, matching the m4b's contiguous embedded chapters. (On the localization-vs-data classification of this English literal, see Constraints → Localization.)
- **`title` with internal/leading/trailing whitespace** → `.trim()` strips leading/trailing; internal whitespace (including tabs) is preserved verbatim. A title containing a literal newline would break the one-line-per-cue contract; titles come from chapter headings (`storyToSpans`/`parse_audiobook_script`), which are single lines by construction, so a multi-line title is not reachable, but if it ever were, the file would simply have an extra line — acceptable, not corrupting (and not worth a guard this slice).
- **Very long list (hundreds of chapters)** → linear accumulation on a float; sub-second rounding drift is bounded per chapter and discussed under Risk. No overflow concern (`Number` is float64).

**Separator change.** The existing `buildCueSheet` (`storyExport.js:95-96`) currently joins timecode and title with a single space:
```js
export function buildCueSheet(chapters) {
  return (chapters || []).map((c) => `${formatTimecode(c.time)} ${c.title}`).join('\n');
}
```
Change the single space to a TAB (`\t`) so titles with leading spaces stay aligned and the file is spreadsheet/parse-friendly (see API/data shapes). The exact new form:
```js
/**
 * Build a chapter cue sheet string from {time,title} cues.
 * One `HH:MM:SS<TAB>Title` line per cue, joined by LF. No trailing newline.
 * @param {Array<{time:number,title:string}>|null|undefined} chapters
 * @returns {string}
 */
export function buildCueSheet(chapters) {
  return (chapters || []).map((c) => `${formatTimecode(c.time)}\t${c.title}`).join('\n');
}
```
The one existing test that asserts the space form (`storyExport.test.js:57-59`) is updated in the same slice. `buildCueSheet` has **no production caller** today (confirmed by grep this session — only `storyExport.test.js` references it), so the change is contained.

`formatTimecode` (`storyExport.js:73-78`) already handles the timecode edge cases: it `Math.max(0, Math.floor(sec || 0))` (negative/NaN/undefined → `00:00:00`), and `HH` is `padStart(2,'0')` so durations **≥ 100 hours** render with 3+ digit hours (e.g. `100:00:00`) rather than truncating — correct, just wider than two columns. Its signature (unchanged): `formatTimecode(sec: number): string`. No change needed; reuse as-is.

### Shared filename helper (recommended) — exact signature
Both tabs derive `<basename>.txt` from `output`. To avoid the two derivations drifting (and to centralize the extension-allowlist + fallback), add a tiny pure helper to `storyExport.js`:
```js
/**
 * Derive the cue-sheet filename from a render output name (m4b/mp3 → txt).
 * Strips any path prefix, then swaps a trailing `.m4b`/`.mp3` for `.txt`;
 * falls back to `cuesheet.txt` when no recognized extension is present.
 * @param {string|null|undefined} output  e.g. "audiobook_ab12.m4b" or "/outputs/story_cd34.mp3"
 * @returns {string}  e.g. "audiobook_ab12.txt" | "story_cd34.txt" | "cuesheet.txt"
 */
export function cueSheetFilename(output) {
  const base = String(output || '').split('/').pop();
  const txt = base.replace(/\.(m4b|mp3)$/i, '.txt');
  return /\.txt$/i.test(txt) ? txt : 'cuesheet.txt';
}
```
- Handles the **path-prefixed** Stories case (`.split('/').pop()`) and the **bare** Audiobook case alike.
- **No recognized extension** (`output` lacks `.m4b`/`.mp3`) → the replace is a no-op, `txt` does not end in `.txt`, so it falls back to `cuesheet.txt`. (We deliberately do **not** blindly strip any extension and append `.txt`, to avoid `report.tar.gz` → `report.tar.txt` surprises; the allowlist is the two formats the backend actually produces — `audiobook.py:445` sets `ext = "mp3" if … else "m4b"`.)
- **Empty / null `output`** → `base` is `''` → `txt` is `''` → fallback `cuesheet.txt`.
- **Regex safety (CodeQL):** both literals — `/\.(m4b|mp3)$/i` and `/\.txt$/i` — are anchored (`$`), use a fixed alternation / fixed literal, and contain **no unbounded repetition** (`*`/`+`) and no overlapping/nested quantifiers, so they are not polynomial-ReDoS reachable even though `output`/`title` are user-influenced (the title comes from a user-authored chapter heading). See Constraints → CodeQL.
- Unit-testable; eliminates the drift risk flagged under Risk.

### Frontend wiring — Audiobook (`frontend/src/pages/AudiobookTab.jsx`)
1. Add state `const [cues, setCues] = useState([])` (array of `{title, duration_s}` captured during the stream — i.e. the raw `ChapterEvent[]`, **not** yet the `Cue[]`; the conversion to cues happens at download time via `cuesFromChapters`). **Reset it at the top of `onCreate` alongside the existing resets** (`AudiobookTab.jsx:114-117`: `setError('')`, `setOutput('')`, `setDone(null)`, `setProgress({...})`) so a **re-render** (the user clicks Create a second time) clears the previous run's cues before the new stream starts. Without this reset, a failed second run could leave the first run's `cues` paired with a stale-or-empty `output`; the `output`-gating prevents a wrong file, but resetting keeps state coherent.
2. In `onCreate`'s stream loop (`:142-169`), declare a local `const localCues = []` **before** the `while` (`:142`). In the existing `evt.type === 'chapter'` branch (currently `:153-154`), also `localCues.push({ title: evt.title, duration_s: evt.duration_s })`. Do **not** push in the `chapter_error` branch (`:157-158`) — leave it advancing only the progress bar. On the `evt.type === 'done'` branch (`:159-164`), call `setCues(localCues)` paired with `setOutput(evt.output)`, so `cues` and `output` are set together (or neither — on `error`, both stay empty/from-reset). (See the field-name collision warning above: this is the SSE `done`, not the reader `done`.)
   - **Abort path:** `AudiobookTab` has `abortRef` (`:31,119,142`). If the user aborts mid-stream, the `while (!abortRef.current)` loop exits **without** an SSE `done` event, so `setCues` is never called and `output` stays `''` — the button never appears for an aborted (incomplete) render. The `localCues` accumulated so far are simply dropped. Correct: there is no audio file to pair them with.
   - **Network drop / truncated stream:** identical to abort — `reader.read()` either throws (→ `catch`, `:170-171`, sets error, no `setCues`) or the loop ends without `done`. Either way `output` stays empty; no button.
3. In the existing `output && (...)` results block (`AudiobookTab.jsx:329-349`), add a second action next to the existing "Download" anchor (`:343-347`):
   ```jsx
   {cues.length > 0 && (
     <a className="ui-btn ui-btn--subtle" onClick={downloadCueSheet}>
       <FileText size={14} /> {t('audiobook.download_cues')}
     </a>
   )}
   ```
   The whole block is already inside `{output && (…)}`, so the button is doubly gated: `output` (a real file exists) **and** `cues.length > 0` (defensive). `downloadCueSheet` is defined as:
   ```js
   const downloadCueSheet = useCallback(() => {
     const body = buildCueSheet(cuesFromChapters(cues));
     if (!body) return; // unreachable when output set; defensive
     download(new Blob([body], { type: 'text/plain;charset=utf-8' }), cueSheetFilename(output));
   }, [cues, output]);
   ```
   **AudiobookTab has no Blob-download helper today** — its existing audio download is a plain `<a href={audioUrl(output)} download={output}>` anchor (`:344-346`), and the shared `browserDownload` (`frontend/src/utils/download.js:34`) has signature `browserDownload(url, fallbackName, deps={})` and **fetches a URL** (`await _fetch(url)` at `download.js:39`), not a Blob, so it is not reusable here. Add a tiny inline `download(blob, filename)` mirroring `StoriesEditor.jsx:32-41` exactly:
   ```js
   function download(blob, filename) {
     const url = URL.createObjectURL(blob);
     const a = document.createElement('a');
     a.href = url; a.download = filename;
     document.body.appendChild(a); a.click(); a.remove();
     setTimeout(() => URL.revokeObjectURL(url), 10000);
   }
   ```
   (or factor a shared one — see below; lower-value, out of scope this slice).
   - **Filename derivation:** the Audiobook `done` event's `output` is the **bare** name `f"{job_type}_{job_id}.{ext}"` (`audiobook.py:446,463`) with **no path prefix** (unlike Stories — see that section). Use the shared `cueSheetFilename(output)` so the two derivations cannot drift; for Audiobook it yields `audiobook_<job_id>.txt`.

### Frontend wiring — Stories (`frontend/src/components/StoriesEditor.jsx`)
Same pattern in `generateAll` (`StoriesEditor.jsx:360-402`):
1. Declare a local `const localCues = []` before the `while` (alongside the existing `let total = 0; let output = ''` at `:375-376`). State is **not required** for Stories because the `.txt` download fires immediately on the `done` branch (see step 3), in the same place `output` is consumed — there is no persisted results panel rendering a button, unlike Audiobook. (If a future iteration adds a persisted Stories results panel with an explicit button, promote `localCues` to `const [cues, setCues]` state; not needed now.)
2. The current loop has a **combined** `chapter`/`chapter_error` branch that only advances the progress bar (`StoriesEditor.jsx:387-388`):
   ```js
   else if (evt.type === 'chapter' || evt.type === 'chapter_error') {
     setExportPct(total ? Math.round(((evt.index + 1) / total) * 100) : 0);
   }
   ```
   **Split it** so progress still advances for both (the percentage uses `evt.index`, which is present on both event types), but only `evt.type === 'chapter'` pushes `{ title: evt.title, duration_s: evt.duration_s }` to `localCues`. Concretely:
   ```js
   else if (evt.type === 'chapter') {
     localCues.push({ title: evt.title, duration_s: evt.duration_s });
     setExportPct(total ? Math.round(((evt.index + 1) / total) * 100) : 0);
   } else if (evt.type === 'chapter_error') {
     setExportPct(total ? Math.round(((evt.index + 1) / total) * 100) : 0);
   }
   ```
3. After the existing audio download `downloadUrl(audioUrl(output), output.split('/').pop())` (`StoriesEditor.jsx:394`), also trigger the cue-sheet download using the **existing local `download(blob, filename)` helper** (`StoriesEditor.jsx:32-41`) — this one IS Blob-based (signature `download(blob: Blob, filename: string): void`; revokes the object URL on a 10s timeout). Do **not** use `downloadUrl` (`:44-51`, signature `downloadUrl(url: string, filename: string): void` — takes a same-origin URL).
   - **Build (exact):**
     ```js
     const body = buildCueSheet(cuesFromChapters(localCues));
     if (localCues.length && body) {
       download(new Blob([body], { type: 'text/plain;charset=utf-8' }), cueSheetFilename(output));
     }
     ```
   - This is inside the `if (!output) throw …; … toast.success(…)` success region (`:393-395`), so it only runs when `output` is truthy.
   - **Filename derivation (differs from Audiobook):** the Stories code does `output.split('/').pop()` (`:394`), implying `output` **may** carry a path-ish prefix in this call site's mental model even though the backend emits a bare name. To be robust to either, derive via the shared `cueSheetFilename(output)` (it does the `.split('/').pop()` internally) so the two derivations cannot drift.
   - **Empty-cues guard:** because this runs only when `output` is set and `done` guarantees ≥1 successful chapter, `localCues` is non-empty here. Still, guard `if (localCues.length && body)` before the cue download so a hypothetical future change can't write an empty `.txt`.
   - **Stories has no abort flag** — `generateAll`'s loop is `while (true)` (`:377`), exiting only on `done`/`error`/network end. A thrown read (`catch`, `:396-398`) sets the error toast and never reaches the cue download. A stream that ends without `done` leaves `output === ''` → `if (!output) throw new Error('no output produced')` (`:393`) → caught → error toast, no cue download. So the failure/abort states are already handled by the existing `output` gate; the cue download inherits that gate by living after it.
4. Optionally `toast.success(t('stories.cuesDownloaded'))` after the cue download (or rely on the single existing `toast.success(t('stories.exportDone'))` at `:395` and skip the extra toast to avoid double-toasting). Recommended: skip the extra toast; the `.txt` simply downloads alongside the audio. The `stories.cuesDownloaded` key is listed below as optional.
5. Stories already imports the cue helpers' module for `exportStems` (`StoriesEditor.jsx:24`: `import { exportStems } from '../utils/storyExport';`); extend it to `import { exportStems, buildCueSheet, cuesFromChapters, cueSheetFilename } from '../utils/storyExport';` (drop `cueSheetFilename` from the import if the shared helper is not adopted).

### Why client-side (not a backend `/cue` endpoint)
- The data is already on the wire; a backend endpoint would re-run or re-read the job. Client accumulation is zero extra work and zero new attack surface (no new path-handling — relevant given the recent CodeQL path-injection churn on this exact router, `audiobook.py`).
- Pure text + `Blob` download is platform-identical (Tauri webview on mac/win/linux), satisfying the cross-platform default-behavior constraint with no platform branches.
- Pure client-side text generation means **no network call, no cloud, no account** — the file is built from data the app already holds and written to local disk by the browser/webview. This keeps the local-first guarantee intact (see Constraints → Local-first).

(The Blob-download primitive itself differs slightly between call sites — Stories already has the helper; Audiobook adds a copy — and could also be shared, but is lower-value and out of scope this slice.)

## Integration points (file:line)
- `backend/api/routers/audiobook.py:345` — `_render_longform_sse(plan, *, default_voice, fmt="m4b", bitrate="128k", loudness=None, cover_path=None, metadata=None, lexicon=None, job_type="audiobook")` (the shared SSE generator both front doors stream through; **read-only**, no change).
- `backend/api/routers/audiobook.py:377-383` — `_emit(payload: dict) -> str` writes each event as `data: <json>\n\n`; the JSON shapes the client parses are exactly the dict literals passed here.
- `backend/api/routers/audiobook.py:386,390` — early `error` events (no chapters / no ffmpeg) — `started` never fires; accumulator stays empty (button never shows).
- `backend/api/routers/audiobook.py:412` — `started` event (resets the per-run accumulator).
- `backend/api/routers/audiobook.py:430-432` — `chapter` SSE event already carries `title` + `duration_s` (`round(dur, 2)`), emitted for both fresh and `cached` chapters; source of truth (**read-only**).
- `backend/api/routers/audiobook.py:424-426` — `chapter_error` event (skipped by the accumulator) + the `continue` (the backend's own "skip failed chapter" the cue sheet mirrors).
- `backend/api/routers/audiobook.py:428` — `chapters_meta.append((title, int(round(dur*1000))))`, on success only, showing the backend includes only successful chapters in the m4b (the invariant the cue sheet mirrors).
- `backend/api/routers/audiobook.py:434-436` — `if not chapter_files: error("all chapters failed to render")` then `return` — the all-failed terminal (no `done`, empty accumulator).
- `backend/api/routers/audiobook.py:445-446,463-465` — `ext = "mp3" if (fmt or "").lower()=="mp3" else "m4b"`; `done` event carries the bare `output` name `f"{job_type}_{job_id}.{ext}"` plus `chapters` (success count), `duration_s` (`round(total_s,2)`), `cached_chapters` (int), `failed_chapters` (list[int]); this is the only event that sets `output`.
- `backend/api/routers/audiobook.py:466-474` — mid-render exception → generic `error`, no `done` (accumulator may be non-empty but `output` stays empty — button still gated off).
- `backend/services/longform_render.py:173-197` — `build_ffmetadata(chapters: Iterable[tuple[str,int]], global_meta: Optional[dict]=None) -> str` cumulative-ms START/END logic (`:186-196`), including the `end = start + max(0, int(dur_ms))` clamp and `START==END` for zero-length chapters; cue START times must agree with this.
- `frontend/src/utils/storyExport.js:72-79` — `formatTimecode(sec: number): string` (reuse; floors to whole seconds; clamps negative/NaN to 0; ≥100h widens `HH`).
- `frontend/src/utils/storyExport.js:94-97` — `buildCueSheet(chapters: Array<{time,title}>): string` (reuse; switch separator from single space to TAB).
- `frontend/src/utils/storyExport.js` — add `cuesFromChapters(chapters: ChapterEvent[]): Cue[]` (+ recommended `cueSheetFilename(output: string): string`), co-located near `:72-97`.
- `frontend/src/utils/storyExport.test.js:4` — extend the import (`cuesFromChapters`, optional `cueSheetFilename`).
- `frontend/src/utils/storyExport.test.js:57-59` — update the existing `buildCueSheet` expectation to the TAB separator; add `cuesFromChapters` cases (in/near the `chapter helpers` describe block, `:44-61`).
- `frontend/src/pages/AudiobookTab.jsx:113-175` — `onCreate` stream loop: add `cues` state + reset (at `:114-117`), declare `localCues` before the `while` (`:142`), accumulate in the `chapter` branch (`:153-154`), `setCues(localCues)` on the SSE `done` branch (`:159-164`); add `downloadCueSheet` + a small Blob `download` helper.
- `frontend/src/pages/AudiobookTab.jsx:143` — reader `const { done, value } = await reader.read()` — name collision with SSE `done`; `setCues` goes in the `evt.type === 'done'` branch only (see warning).
- `frontend/src/pages/AudiobookTab.jsx:31,119,142,170-171` — abort flag (`abortRef`) + catch: confirm `setCues` is reached only inside the SSE `done` branch, so abort/error never enables the button.
- `frontend/src/pages/AudiobookTab.jsx:329-349` — results block (already gated by `output &&`): add the cue-sheet download action, additionally gated by `cues.length > 0`, next to the existing `<a href={audioUrl(output)} download={output}>` at `:344-346`.
- `frontend/src/pages/AudiobookTab.jsx:3` — lucide-react import line (`import { BookMarked, Loader, Download, Image as ImageIcon, X, Play, Upload, Plus } from 'lucide-react'`); add `FileText`.
- `frontend/src/pages/AudiobookTab.jsx:5-10` — add `import { buildCueSheet, cuesFromChapters, cueSheetFilename } from '../utils/storyExport';` (AudiobookTab does **not** import storyExport today).
- `frontend/src/components/StoriesEditor.jsx:360-402` — `generateAll` stream loop: declare `localCues` near `:375-376`, split the combined `chapter`/`chapter_error` branch (`:387-388`) accumulating cues on `chapter` only; trigger `.txt` download after the audio download at `:394` (inside the `output` success region).
- `frontend/src/components/StoriesEditor.jsx:24` — extend the existing `import { exportStems } from '../utils/storyExport';` with `buildCueSheet, cuesFromChapters` (+ `cueSheetFilename`).
- `frontend/src/components/StoriesEditor.jsx:32-41` — reuse the existing local `download(blob, filename)` helper (Blob-based; revokes the object URL on a 10s timeout). Do **not** use `downloadUrl` at `:44-51`, which is URL-based.
- `frontend/src/utils/download.js:34,39` — `browserDownload(url, fallbackName, deps={})` exists but is URL-fetch based (`await _fetch(url)` at `:39`); **not** used for the client-built text Blob (documented here to prevent a wrong-helper mistake).
- `frontend/src/utils/sseParse.js:14,29` — `splitSSEBuffer(buffer: string): {lines: string[], rest: string}` / `parseSSELine(line: string): object|null` (existing parse utilities both loops already use; no change). Already directly unit-tested in `frontend/src/test/sseParse.test.js` — the cue tests reuse this exact parse path to replay event frames (see Test plan).

## API / data shapes
**No HTTP/SSE schema change.** The full SSE event catalogue (consumed, all existing) is pinned in the table under Design → "SSE event catalogue". The two events the cue feature reads:

```jsonc
// type === "chapter"  (one per SUCCESSFUL chapter; backend/api/routers/audiobook.py:430-432)
// All fields always present. index/total int; duration_s float; cached bool.
{ "type": "chapter", "index": 0, "total": 3, "title": "Chapter One",
  "duration_s": 42.51, "cached": false }

// type === "done"  (once, ≥1 chapter succeeded; backend/api/routers/audiobook.py:463-465)
// output = bare "<job_type>_<job_id>.<ext>" (ext ∈ {m4b, mp3}); no path prefix.
{ "type": "done", "output": "audiobook_4f3a1b2c9d8e7f60.m4b",
  "chapters": 3, "duration_s": 309.9, "cached_chapters": 1, "failed_chapters": [] }
```

**Client-internal accumulator shapes (not on the wire):**
```jsonc
// localCues entry (pushed per `chapter` event) — raw passthrough:
{ "title": "Chapter One", "duration_s": 42.51 }
// Cue (produced by cuesFromChapters) — fed to buildCueSheet:
{ "time": 0, "title": "Chapter One" }   // time is float seconds; floored at display only
```

**Cue-sheet file body** (`Blob` with MIME `text/plain;charset=utf-8`, LF (`\n`) line separators, **no trailing newline** — `Array.join('\n')`):
```
00:00:00	Chapter One
00:00:43	Chapter Two
00:05:10	Chapter Three
```
(the gap between the timecode and title in each line is a single literal TAB, `U+0009`.)
- `HH:MM:SS` from `formatTimecode` (`storyExport.js:72-79`, floors to whole seconds via `Math.floor`). START times accumulate from float `duration_s`, then are floored per-line — matches the m4b's whole-second-visible chapter offsets closely; sub-second drift across many chapters is bounded because accumulation is on the float, only the display floors.
- Separator: a single TAB (`\t`, `U+0009`) between timecode and title (change from current single-space `buildCueSheet`).
- One line per **successful** chapter; failed chapters omitted (mirrors `chapters_meta`). A zero-`duration_s` successful chapter yields a line whose timestamp equals the previous line's (not deduped).
- **Empty body is unreachable in practice** (`done` guarantees ≥1 cue), and the button/download is gated so an empty `.txt` is never written.
- Filename: `<output-basename>.txt` via `cueSheetFilename(output)` (e.g. `audiobook_<jobid>.txt` / `story_<jobid>.txt`, derived from the `done` event's `output`, which is `f"{job_type}_{job_id}.{ext}"` — `audiobook.py:446`), fallback `cuesheet.txt` when no `.m4b`/`.mp3` extension matches.

**Function signatures added/changed (pinned)**
| Function | File | Signature | Change |
|---|---|---|---|
| `cuesFromChapters` | `storyExport.js` | `(chapters: ChapterEvent[]\|null\|undefined) => Cue[]` | **new** |
| `cueSheetFilename` | `storyExport.js` | `(output: string\|null\|undefined) => string` | **new** (recommended) |
| `buildCueSheet` | `storyExport.js:94-97` | `(chapters: Array<{time:number,title:string}>\|null\|undefined) => string` | separator space → TAB (sig unchanged) |
| `formatTimecode` | `storyExport.js:72-79` | `(sec: number) => string` | unchanged (reuse) |
| `download` (AudiobookTab) | `AudiobookTab.jsx` | `(blob: Blob, filename: string) => void` | **new** inline (mirror of StoriesEditor) |
| `download` (StoriesEditor) | `StoriesEditor.jsx:32-41` | `(blob: Blob, filename: string) => void` | unchanged (reuse) |
| `downloadCueSheet` (AudiobookTab) | `AudiobookTab.jsx` | `() => void` (useCallback, deps `[cues, output]`) | **new** |

where:
```ts
type ChapterEvent = { title?: string; duration_s?: number | string };
type Cue = { time: number; title: string };
```

**New i18n keys**
- `audiobook.download_cues`: `"Download cue sheet (.txt)"`
- `stories.cuesDownloaded` (optional toast — include only if the extra toast is kept): `"Cue sheet downloaded"`
(Strings go through `t()` only — no hardcoded user-facing text, per the localization hard rule. Both keys are new — verified absent from `en.json` this session — so they must be added to all 21 locale files, not just `en.json`.)

## Test plan

### Strategy — pure helpers + handler-direct replay, never importing main+torch
The entire feature is **pure JavaScript + DOM** (accumulator math, string building, a Blob `<a>` click). There is **zero backend change**, so the test surface is entirely in `frontend/`'s **vitest** suite (jsdom env, `@testing-library/react`, `setupFiles: ['./src/test/setup.js']`, include glob `src/**/*.test.{js,jsx,ts,tsx}` — confirmed in `frontend/vite.config.js`'s `test` block this session). Three deliberate layers, all on the fast/local path:

1. **Pure-function unit tests (primary, load-bearing).** `cuesFromChapters`, `cueSheetFilename`, the TAB-separator `buildCueSheet`, and `formatTimecode` reuse are plain functions with no React, no network, no DOM — assert them directly. This is where the correctness invariants live (skip-error, NaN/negative clamp, monotonicity, title fallback, no trailing newline). They run in the existing `frontend/src/utils/storyExport.test.js` and need no mocks.
2. **Handler-direct stream replay (integration of the accumulation logic, no component mount).** The load-bearing behavior in the two tabs is *"feed an ordered list of SSE frames, accumulate only `chapter` events, gate the download on `done.output`."* That logic must be exercised **without** mounting `AudiobookTab`/`StoriesEditor` (which would drag in the i18n provider, the API client, lucide, the store, etc.) and **without** any backend/torch import. The strategy: replay the **exact event JSON** from the catalogue through the *same* parse path the tabs use — `parseSSELine` from `frontend/src/utils/sseParse.js` (already directly tested in `frontend/src/test/sseParse.test.js`) — into a tiny copy of the branch logic, then assert `cuesFromChapters(localCues)` and the `output` gate. The accumulation reducer is small enough to test as a pure step function; this mirrors how `sseParse.test.js` tests the parse layer in isolation rather than mounting a consumer. No `main`/FastAPI/torch/GPU is imported anywhere in this layer — the backend SSE generator is **read-only** and is *not* re-imported; its event shapes are pinned as test fixtures (the catalogue table is the contract).
3. **Blob-download via dependency injection (optional, mirrors `download.test.js`).** If the inline `download(blob, filename)` is exercised in a test, follow the established pattern in `frontend/src/utils/download.test.js`: pass faked `document`/`url` (a `makeDeps`-style object with `createElement`/`createObjectURL`/`revokeObjectURL` as `vi.fn()`s) so the `<a>` click and `URL.createObjectURL`/`revokeObjectURL` calls are asserted without a real browser or Tauri runtime. (The current inline helper reads the globals directly; if it's left global-coupled, jsdom's `document`/`URL` are present in the vitest env, so a lightweight assertion still works — but DI is the cleaner, regression-proof form and matches the "works with no Tauri globals" test at `download.test.js:61-65`.)

**Why not mount the components / why no backend test:** mounting the tabs adds no coverage of the load-bearing math (which is in the pure helpers) while importing a large dependency graph; per project memory, tests that import `main`+`torch` segfault locally (CI is fine), so the whole plan deliberately stays on `frontend/` vitest, which has no Python/torch coupling at all. The backend is untouched, so backend pytest gates (`tests/`, `backend/tests/`) neither change nor need new cases — the existing `build_ffmetadata`/longform-render tests under `tests/` remain the source-of-truth for the START offsets the cue sheet mirrors.

### Unit (vitest, `frontend/src/utils/storyExport.test.js`) — the load-bearing tests
Extend the import at `:4` with `cuesFromChapters` (and `cueSheetFilename` if adopted). Add a `describe('cuesFromChapters', …)` and `describe('cueSheetFilename', …)` block alongside the existing `chapter helpers` block (`:44-61`); update the one existing `buildCueSheet` assertion (`:57-59`) in place.

- **`cuesFromChapters_emptyOrNullish_returnsEmptyArray`** — `cuesFromChapters([])` → `[]`; `cuesFromChapters(undefined)` → `[]`; `cuesFromChapters(null)` → `[]` (total function, no throw).
- **`cuesFromChapters_accumulatesStartTimesFromPriorDurations`** — `cuesFromChapters([{title:'A',duration_s:43.2},{title:'B',duration_s:266.7},{title:'C',duration_s:10}])` → `[{time:0,title:'A'},{time:43.2,title:'B'},{time:309.9,title:'C'}]` (start of k = sum of prior durations; cue 0 at 0). Assert each `time` with a float tolerance — `43.2 + 266.7` is `309.90000000000003` in float64; use `toBeCloseTo` on each `time`, or assert against the same float arithmetic.
- **`cuesFromChapters_blankOrMissingTitle_fallsBackToChapterN`** — empty / whitespace-only / missing `title` → `Chapter {n}` where `n` is the 1-based position **among successful cues** (e.g. `cuesFromChapters([{duration_s:5},{title:'   ',duration_s:5}])` → `[{time:0,title:'Chapter 1'},{time:5,title:'Chapter 2'}]`).
- **`cuesFromChapters_trimsTitleButPreservesInternalWhitespace`** — leading/trailing whitespace stripped; internal whitespace preserved (`{title:'  A  B  '}` → `title:'A  B'`).
- **`cuesFromChapters_badDuration_neverPoisonsTimeOrGoesBackward`** — `duration_s` of `undefined`, `null`, `NaN`, a non-numeric string (`'abc'`), a numeric string (`'42.5'` → 42.5), and a **negative** value are each handled; assert **no `NaN` propagates** into any later `time` and **time never decreases** (e.g. `cuesFromChapters([{title:'A',duration_s:-5},{title:'B',duration_s:3}])` → `[{time:0,title:'A'},{time:0,title:'B'}]`; then a third `{title:'C',duration_s:2}` → `time:3`). Spot-check every `time` is `Number.isFinite`.
- **`cuesFromChapters_zeroDurationChapter_keepsCueAtSameTimestamp`** — `cuesFromChapters([{title:'A',duration_s:0},{title:'B',duration_s:5}])` → `[{time:0,title:'A'},{time:0,title:'B'}]` (two cues at `00:00:00`, **not** deduped); `buildCueSheet(...)` of this → `'00:00:00\tA\n00:00:00\tB'`.
- **`buildCueSheet_joinsTabSeparatedLinesNoTrailingNewline`** — `buildCueSheet(cuesFromChapters([...]))` end-to-end → expected `HH:MM:SS\tTitle` lines joined by `\n`, **no trailing newline**. **Update the existing assertion at `storyExport.test.js:57-59`** from the space form (`'00:00:00 Intro\n00:01:05 Two'`) to the TAB form (`'00:00:00\tIntro\n00:01:05\tTwo'`).
- **`buildCueSheet_emptyOrNull_returnsEmptyString`** — `buildCueSheet([])` → `''` and `buildCueSheet(null)` → `''` (empty body, no throw).
- **`formatTimecode_accumulatesPast1hAnd100h`** — `formatTimecode` rollover already covered (`storyExport.test.js:52-55`, incl. `3661`→`01:01:01`); add a `>= 1h` case via `cuesFromChapters` (sum durations past 3600s and assert `HH` advances), and a `>= 100h` case asserting `HH` widens to 3 digits (`360000` → `100:00:00`) rather than truncating.
- **`cueSheetFilename_*`** (if adopted): `'audiobook_abc.m4b'` → `'audiobook_abc.txt'`; `'story_abc.mp3'` → `'story_abc.txt'`; path-prefixed `'/outputs/story_abc.m4b'` → `'story_abc.txt'`; uppercase `'X.M4B'` → `'X.txt'`; no recognized extension `'weird.wav'` → `'cuesheet.txt'`; double-ext `'report.tar.gz'` → `'cuesheet.txt'` (not `report.tar.txt`); empty `''`/`null`/`undefined` → `'cuesheet.txt'`.
- **`cueSheetFilename_adversarialLength_returnsPromptly`** — feed a ReDoS-style input (e.g. `'a'.repeat(100000) + '.m4b'`); assert it returns `'…a.txt'` and completes well within the default vitest timeout (proves the anchored `/\.(m4b|mp3)$/i` / `/\.txt$/i` are linear — see Constraints → CodeQL). Optionally wrap in a tight `performance.now()` budget assertion.
- Run: `cd frontend && bunx vitest run src/utils/storyExport.test.js` (per MEMORY: local loop must include `bunx vitest run`).

### Integration — stream-replay reducer tests (handler-direct, no component mount)
Drive a tiny pure copy of the per-event branch logic with an **ordered array of the exact event JSON from the catalogue**, parsed through the real `parseSSELine` (`frontend/src/utils/sseParse.js`, the same util both tabs use). Each test builds `data: <json>\n` frames, runs them through `parseSSELine`, applies the branch step (`chapter` → push `{title,duration_s}` to `localCues`; `chapter_error` → no-op for cues; `done` → set `output`), then asserts on `cuesFromChapters(localCues)` and `output`. Put these in `frontend/src/test/cueSheetStream.test.js` (the `frontend/src/test/` dir is the established home for cross-cutting/replay tests like `sseParse.test.js`, `storyToSpans.test.js`).

- **`cueStream_skipsChapterError_doesNotAdvanceTime`** — feed `[chapter{idx0,dur5}, chapter_error{idx1}, chapter{idx2,dur7}]`; assert `cuesFromChapters(localCues)` is `[{time:0},{time:5}]` (the error contributes **no** cue and does **not** advance time — the second surviving chapter starts at `5`, not `5+error`). Mirrors the backend `continue` at `audiobook.py:426`.
- **`cueStream_allFailed_noOutputNoCues`** — feed `started{chapters:2}`, `chapter_error`×2, `error{"all chapters failed to render"}` (no `done`); assert `localCues` is `[]`, `output` stays `''`, and the cue button/download is **not** triggered.
- **`cueStream_midRenderException_cuesNonEmptyButOutputUnsetGatesButton`** — feed `started{chapters:3}`, `chapter`×2, `error{"render failed (see backend log)"}` (no `done`); assert `localCues` length is 2 (non-empty) **but** `output` is `''`, so the button is **not** shown (proves the `output` gate, not the cue-count gate, protects the missing-file case).
- **`cueStream_cachedChapterContributesCueLikeFresh`** — feed `chapter{idx0,dur5,cached:true}`, `chapter{idx1,dur7,cached:false}`, `done`; assert both contribute cues (`[{time:0},{time:5}]`) — `cached` does not affect inclusion (`audiobook.py:429-432` runs regardless of `was_cached`).
- **`cueStream_doneSetsOutputAndEnablesDownload`** — feed `started`, `chapter`×3, `done{output:'audiobook_x.m4b'}`; assert `localCues` length 3 and `output === 'audiobook_x.m4b'`, and `cueSheetFilename(output)` is `'audiobook_x.txt'`.
- **`cueStream_filenameForBothBaseShapes`** — assert `cueSheetFilename` produces `*.txt` for both the bare Audiobook `done.output` (`'audiobook_x.m4b'`) and a path-prefixed Stories shape (`'/outputs/story_x.mp3'` → `'story_x.txt'`).

### Component-level (lightweight, optional — only if mounting is cheap)
If `AudiobookTab` mounts cleanly under jsdom (it has done so for sibling tabs — see `frontend/src/test/EngineCompatibilityMatrix.test.jsx`, mounted with `@testing-library/react`), one focused test adds value the reducer tests can't:

- **`AudiobookTab_reRunResetsCuesState`** — simulate a successful `onCreate` run (cues populated, the "Download cue sheet (.txt)" action visible via `getByText(t-key)`), then start a second `onCreate`; assert `cues` is reset to `[]` at the top (the action disappears until the new stream's `done`) so a stale list is never paired with a new/empty `output`. This is the one behavior tied to React state (`useState` + reset) rather than pure logic. If mounting `AudiobookTab` proves to drag in heavy providers, demote this to a reducer-level assertion that the documented top-of-`onCreate` reset clears `localCues`/`cues` before the loop, and cover the visible-button toggle manually (see runtime verify).

### Manual / runtime verify (ties into TASK #34)
- Audiobook: render a 3-chapter script, download the `.txt`, confirm 3 lines, first at `00:00:00`, TAB-separated, and the START offsets visually match the m4b chapters in a player.
- Stories: render a multi-chapter cast/lines story (chapters delimited by markdown `# heading` lines, per `storyToSpans`/`isChapterLine`), confirm the `.txt` downloads alongside the audio and titles match chapter headings.
- Force a chapter failure (e.g. an empty/broken chapter) and confirm the `.txt` omits it and the subsequent timestamps don't include the failed chapter's (absent) duration; confirm the `.txt` chapter set equals the m4b's embedded chapter set.
- Force an **all-failed** render (every chapter broken) and confirm **no** `.txt` is offered/downloaded (no `done`/`output`).
- Abort an Audiobook render mid-stream and confirm no `.txt` button appears for the incomplete run.
- mp3 format: render with `format: 'mp3'`, confirm the `.txt` is offered (this is the format that has no embedded chapters — the cue sheet's primary use case) and named `*.txt`.
- **Cross-platform (per the cross-platform-parity hard rule):** confirm the download fires identically in the Tauri webview on macOS, Windows, **and** Linux (no `shell.open`/path logic involved — pure Blob), and that the saved `.txt` opens with LF line endings on all three. No platform branch exists in the code, so a single-platform pass plus a code review for platform conditionals is sufficient evidence; record the OS used for the manual pass.

### CI gates that apply (verified against `.github/workflows/` this session)
The PR is gated by the existing checks; the cue feature only touches the frontend + locale JSON, so:
- **`ci.yml` → "Run Vitest (frontend)"** (`working-directory: frontend`, `bunx vitest run`, `ci.yml:105-107`) — the **primary gate**: all the unit + stream-replay (+ optional component) tests above run here. Must be green.
- **`ci.yml` → "Frontend typecheck"** (`bun run typecheck:ci`, `ci.yml:101-103`) — `.ts` files block; the new code is `.js`/`.jsx` (not type-checked under the CI `--checkJs false` override), but keep JSDoc signatures accurate so the IDE/`typecheck` (full) stays clean.
- **`ci.yml` → "Run frontend node:test (legacy)"** (`tests/frontend/*.test.mjs`, `ci.yml:110-112`) — unaffected (no `.test.mjs` touched); will stay green.
- **`ci.yml` → "Run pytest" / "Run pytest (backend/tests, isolated)"** — **no new backend tests**; these stay green because the backend is unchanged. (This is also why the plan never imports `main`+torch: the heavy import chain lives only in these Python jobs, kept off the local loop per MEMORY.)
- **i18n key-parity** is enforced by the **deterministic probe** `tests/probe/specs/i18n_parity.probe.yaml` (probe judges are the only i18n gate that runs in `ci.yml`; LLM-judge evals in `evals.yml` are non-gating). Adding `audiobook.download_cues` (+ optional `stories.cuesDownloaded`) to **all 21** `locales/*.json` keeps this green; adding to `en.json` only would fail it.
- **`tests/test_no_hardcoded_cjk.py`** (runs inside the `ci.yml` pytest step) — scans `frontend/src/**` for hardcoded CJK; this slice introduces **no** CJK literal (the `Chapter {n}` fallback is ASCII), so the `_ALLOWED_FILES` allowlist needs **no** edit and the check stays green.
- **`security.yml` → CodeQL** (`language: [python, javascript-typescript]`, `security.yml:64-108`) — the two new **JS** regexes in `cueSheetFilename` are scanned by the `javascript-typescript` analysis; both are anchored/non-backtracking (see Constraints → CodeQL), so no `js/polynomial-redos`. **No new Python regex** → `py/polynomial-redos` has nothing new to flag. The adversarial-length unit test documents the linear behavior.
- **`ci.yml` → `tauri-cross-platform` (`cargo check` on macOS/Windows/Linux, `ci.yml` `tauri-cross-platform` job)** — unaffected (no Rust/Tauri-config change); stays green and is the standing evidence of cross-platform parity at the shell level.

Local pre-push loop (per MEMORY: must include `bunx vitest run`): `cd frontend && bun run typecheck:ci && bunx vitest run`. No local pytest needed (no backend change); let CI validate the unchanged Python jobs.

## Constraints
This section states, rule by rule, how the slice satisfies each OmniVoice hard rule. (Only the rules with real surface here are expanded; the rest are noted N/A with the reason.)

- **Cross-platform parity (hard rule — "default features work on every platform"):** The cue sheet is a **default** feature (it appears automatically after any successful render on both tabs — no Settings toggle, no env var, no opt-in). It is therefore required to behave **identically** on macOS, Windows, and Linux. It does: the entire path is `cuesFromChapters` → `buildCueSheet` → `new Blob([text], {type:'text/plain;charset=utf-8'})` → an `<a download>` click in the Tauri webview. There are **no platform branches, no OS APIs, no shell/path logic, no `shell.open`** — the same code runs on all three. LF line endings are emitted unconditionally (the file is data, not a platform-native text file, so we do not CRLF-normalize on Windows). This avoids a P0 default-divergence bug by construction. The manual verify above records the OS used and a code review confirms no `process.platform`/`navigator`-keyed conditional was introduced; the `tauri-cross-platform` CI job stays green (no Rust change).
- **Local-first guarantee (hard rule):** Building the cue sheet is **purely local** — it consumes SSE data the app already received and writes a file via the browser/webview Blob download. **No new network call, no cloud endpoint, no account, no API key, no telemetry.** The app remains fully functional offline, and the feature adds **zero** new outbound traffic. Explicitly rejected the alternative of a backend `/cue` endpoint precisely because it would add server work and attack surface for no benefit (see "Why client-side"); the chosen design is the most local-first option available.
- **Localization (hard rule — no hardcoded user-facing text outside the i18n layer):** The two new **UI strings** (`audiobook.download_cues`, and the optional `stories.cuesDownloaded`) are added as `t('...')` keys to all **21** `locales/*.json` files and referenced only via `t()` — no string literal in JSX. The cue-sheet **file body** is data, not UI chrome: timecodes are numeric, and titles flow through **verbatim from the user's own script** (chapter headings), so they are neither translatable nor subject to the i18n rule. The one English literal in the data path is the `Chapter {n}` title **fallback** in `cuesFromChapters` — a programmatic placeholder for a missing/blank user-supplied title, written into a data file (not rendered as UI), so it is allowed under the rule's "model/engine vocabulary & identifiers / programmatic" intent. (If a future pass wants it localized, route it through `t('audiobook.chapter_n', { n })` — noted as a follow-up, not done here.) **No CJK or other non-English literal is introduced anywhere**, so the `tests/test_no_hardcoded_cjk.py` allowlist needs no edit, and the `i18n_parity.probe.yaml` gate stays green once the keys land in all 21 locales.
- **CodeQL `py/polynomial-redos` (and JS ReDoS) on user-input regexes:** This slice adds/changes regexes only on the frontend, and only in `cueSheetFilename`: `/\.(m4b|mp3)$/i` and `/\.txt$/i`. Both consume **user-influenced** input (`output`/`title` derive from a user-authored chapter heading and a `job_id`), so they are in scope for ReDoS scrutiny (the `security.yml` CodeQL `javascript-typescript` analysis covers them). Both are safe: each is **anchored** (`$`), uses a **fixed alternation / fixed literal** with **no unbounded repetition** (`*`/`+`), and has **no overlapping or nested quantifiers** — i.e. no polynomial backtracking is reachable regardless of input length. The `buildCueSheet` separator change touches no regex. No new **Python** regex is added (the backend is read-only), so CodeQL's `py/polynomial-redos` query has nothing new to flag on the server. A unit test feeds a 100k-char adversarial input to `cueSheetFilename` and asserts it returns promptly, documenting the linear behavior.
- **Backward-compatible project data (hard rule):** **No DB schema change** (no alembic migration needed) and **no localStorage/persisted-state change** (no lazy migration needed). The only added React state is transient, per-render `cues` in `AudiobookTab` (never persisted; reset at the top of each `onCreate`). Existing `omnivoice_data/`, prior render outputs, and in-flight jobs are unaffected. **Engine compatibility:** no engine/model code is touched, so on-disk model state for IndexTTS/CosyVoice/etc. is untouched.
- **Versioning (hard rule — continuous-to-main patch, no RCs):** This is a feature merged to `main`, which already carries the next-patch version per the lockstep rule; **no version bump** in `tauri.conf.json` / `Cargo.toml` / `pyproject.toml` is performed by this PR. No RC, no codename, no `v0.4` deferral — it lands in the open v0.3.x line.
- **Docs-sync (hard rule — same-PR doc updates):** Verified this session that user-facing docs barely enumerate export outputs: `README.md` mentions the "Audiobook Editor" feature but lists **no** export formats, so it needs **no** change. The audiobook/stories sections under `docs/specs/**` and `docs/competitive-analysis.md` are internal spec/analysis docs, not user install/feature docs, and need no change for a `.txt` add. **Action in the PR:** re-grep `README.md` + `docs/**` for `m4b`/`cue sheet`/`audiobook export` and, if any user-facing doc enumerates output formats, add the cue sheet there in the same PR; otherwise state "no doc change needed (README/docs do not enumerate export formats)" in the PR description.
- **Beta cadence / GSD:** the change is small (helpers + two wirings + locale keys) and goes continuous-to-main; entry via a GSD `/gsd-quick` (or phase) workflow per the project's GSD enforcement rule.

## Dependencies
- **None new.** Reuses `lucide-react` (`FileText` icon — already a dep, imported in both files' lucide import lines), the existing `formatTimecode`/`buildCueSheet` (`storyExport.js:72-97`), the existing local `download(blob,filename)` helper in StoriesEditor (`:32-41`) plus a small inline equivalent in AudiobookTab, and the existing SSE parse utilities (`splitSSEBuffer`/`parseSSELine`, `sseParse.js:14,29`). Test-only: the already-present `vitest` + `@testing-library/react` + `jsdom` (`frontend/package.json`) — no new dev dep.

## Risk
- **Low overall.**
- *Timecode/START drift vs. m4b* — Mitigated by accumulating on float `duration_s` and only flooring at display time. Residual: the m4b START/END use `int(round(dur*1000))` ms (`audiobook.py:428`) while the SSE gives `round(dur,2)` s and the `.txt` shows whole seconds, so a chapter boundary can differ by up to ~1s visually — acceptable for a cue sheet; document as expected. (Note: float64 accumulation produces values like `309.90000000000003`; this is invisible after `Math.floor` in `formatTimecode`, but unit tests asserting raw `Cue.time` must use `toBeCloseTo`.)
- *Failed-chapter desync* — The highest-value risk: if the accumulator counted `chapter_error` or used a duration of 0 for a failed chapter, the `.txt` would diverge from the m4b. Mitigated by the explicit "skip `chapter_error`" rule (which mirrors the backend `continue` at `audiobook.py:426`) + the dedicated `cueStream_skipsChapterError_doesNotAdvanceTime` stream-replay test. Note this is **distinct** from a *successful* zero-`duration_s` chapter, which **does** get a cue (same timestamp as the next) — the two zero cases must not be conflated, and each has its own test.
- *Button shown without a file (mid-render exception)* — If the button were gated on `cues.length` instead of `output`, an exception after some chapters rendered (`audiobook.py:466-474`, no `done`) would offer a `.txt` for a file that does not exist. Mitigated by gating on `output` (set only by the SSE `done`); `cues.length > 0` is a secondary defensive check, never the sole gate. Covered by `cueStream_midRenderException_cuesNonEmptyButOutputUnsetGatesButton`.
- *NaN / negative duration poisoning the timeline* — A single `NaN` added to the running float would render every subsequent timecode as `NaN` (and `formatTimecode(NaN)` → `00:00:00`, silently wrong). Mitigated by `Math.max(0, Number(c.duration_s) || 0)` in `cuesFromChapters` + the `cuesFromChapters_badDuration_neverPoisonsTimeOrGoesBackward` unit test.
- *Stale cues on re-run (Audiobook)* — A second render whose stream fails could leave the first run's `cues` in state. Mitigated by resetting `cues` at the top of `onCreate` (with the other resets) and by the `output`-gate (a failed second run clears `output`). Covered by `AudiobookTab_reRunResetsCuesState` (or its reducer-level fallback).
- *SSE-`done` vs reader-`done` variable shadowing (Audiobook)* — `AudiobookTab.jsx:143` already binds `const { done, value }` from `reader.read()`; the new `setCues(localCues)` must live in the `evt.type === 'done'` branch, not anywhere referencing the reader's `done`. Low risk, flagged explicitly to prevent a wrong-variable edit. (The stream-replay tests catch a mis-wire here because they assert `output`/cues only after the SSE `done` frame, not on reader end.)
- *`buildCueSheet` separator change (space → TAB)* — One existing test asserts the space form (`storyExport.test.js:57-59`); it is updated in the same slice. `buildCueSheet` has **no other caller** in `frontend/src/**` (verified by grep this session; the legacy `exportStoryAudio` returns `chapters` but does not call `buildCueSheet`, and never surfaces a cue sheet to the user), so the change is fully contained — re-verify with a repo grep before changing.
- *Wrong download primitive in AudiobookTab* — `browserDownload` (`download.js:34`, `await _fetch(url)` at `:39`) and `downloadUrl` (`StoriesEditor.jsx:44`) both take a **URL**, not a Blob; using either for the client-built text would fail/misbehave. Mitigated by using the Blob-based `download(blob,filename)` (`StoriesEditor.jsx:32-41`) / a copied inline equivalent, called out explicitly in Integration points and the signature table; the optional DI download test (mirroring `download.test.js`) asserts the Blob path.
- *Filename derivation drift across two tabs* — Audiobook's `output` is bare; Stories' call site does `.split('/').pop()`. Mitigated by factoring the derivation into `cueSheetFilename(output)` in `storyExport.js` (handles both shapes + the no-extension/empty fallbacks), shared by both tabs and unit-tested (`cueSheetFilename_*`, `cueStream_filenameForBothBaseShapes`).
- *Duplicate accumulation logic across two tabs* — Mitigated by factoring the accumulator into `cuesFromChapters` (and the filename into `cueSheetFilename`) in `storyExport.js`, exercised once by the shared stream-replay tests.
- *i18n key-parity (cross-platform/localization gate)* — Adding a key to `en.json` only would fail the `i18n_parity.probe.yaml` gate and leave non-English locales missing the string. Mitigated by adding the new key(s) to all 21 `locales/*.json` in the same PR (English fallback text is acceptable; the key must exist everywhere).

## PR slices
1. **PR 1 — pure helpers + tests (no UI):** add `cuesFromChapters` (and `cueSheetFilename`) to `frontend/src/utils/storyExport.js`; switch `buildCueSheet` (`:95-96`) to TAB; update `storyExport.test.js:57-59` and add the `cuesFromChapters` / `cueSheetFilename` / empty / NaN / negative / zero-duration / title-fallback / ≥1h / ≥100h / adversarial-ReDoS-length cases; add the `frontend/src/test/cueSheetStream.test.js` stream-replay tests (skip-error / all-failed / mid-render-exception / cached / done / filename-shapes). Self-contained, green on `bunx vitest run`. Confirm no other `buildCueSheet` caller via grep.
2. **PR 2 — wire both front doors:** accumulate cues in `AudiobookTab.onCreate` (`:113-175`, with the `cues` state, the top-of-`onCreate` reset, `localCues`, `setCues` only inside the SSE `done` branch, the inline Blob `download`, and `downloadCueSheet`) and `StoriesEditor.generateAll` (`:360-402`, splitting the `:387-388` combined branch, `localCues`, cue download after `:394` inside the `output` region); add the Audiobook "Download cue sheet (.txt)" action in the results block (`:329-349`, gated `output && cues.length > 0`) + the `FileText` import (`:3`) + the `storyExport` import (`:5-10`); extend the Stories import at `:24`; add `audiobook.download_cues` (+ optional `stories.cuesDownloaded`) to all 21 `locales/*.json`; the optional `AudiobookTab_reRunResetsCuesState` component test (or its reducer fallback). Docs-sync re-grep in the same PR.

(Could ship as one PR given the size; two slices keep the pure-logic test gate cleanly separable.)

## Acceptance criteria
- After a successful Audiobook render, a "Download cue sheet (.txt)" action appears alongside the existing audio download (`AudiobookTab.jsx:344-346`) and produces a `.txt` with one `HH:MM:SS<TAB>Title` line per successful chapter, first line at `00:00:00`, no trailing newline.
- After a successful Stories full-export, the same `.txt` is auto-downloaded after the audio download at `StoriesEditor.jsx:394`, named from the output via `cueSheetFilename`.
- A chapter that emits `chapter_error` contributes no cue line and does not shift later timestamps; the `.txt` chapter set equals the m4b's embedded chapter set (the `chapters_meta`/`build_ffmetadata` set). (Proven by `cueStream_skipsChapterError_doesNotAdvanceTime`.)
- An **all-failed** render (terminal `error`, no `done`) offers **no** `.txt`; a **mid-render exception** (some chapters rendered, then `error`, no `done`) also offers **no** `.txt` (button gated on `output`, not on cue count); an **aborted** Audiobook render offers **no** `.txt`. (Proven by `cueStream_allFailed_noOutputNoCues` + `cueStream_midRenderException_cuesNonEmptyButOutputUnsetGatesButton`.)
- A successful **zero-`duration_s`** chapter still contributes a cue (its timestamp equals the next cue's); failed chapters are the only omitted case. (Proven by `cuesFromChapters_zeroDurationChapter_keepsCueAtSameTimestamp`.)
- Cue START times are derived solely from accumulated `duration_s` (with NaN/negative/missing clamped to 0, monotonic non-decreasing) and visibly agree with the m4b's embedded chapter offsets (within the documented whole-second display tolerance). (Proven by `cuesFromChapters_badDuration_neverPoisonsTimeOrGoesBackward` + `cuesFromChapters_accumulatesStartTimesFromPriorDurations`.)
- mp3 renders also offer the `.txt` (the primary use case — mp3 has no embedded chapters), named `*.txt` via `cueSheetFilename`.
- All UI strings are `t()` keys present in **all 21** locale files; no hardcoded user-facing text (the `Chapter {n}` title fallback is a programmatic placeholder in the data body, not UI chrome), and no CJK literal is added (the `test_no_hardcoded_cjk.py` allowlist is untouched); the `i18n_parity.probe.yaml` gate stays green.
- The two new filename regexes are anchored/non-backtracking (CodeQL `py/polynomial-redos` is N/A — no new Python regex; the JS regexes are linear under the `security.yml` `javascript-typescript` analysis), proven by `cueSheetFilename_adversarialLength_returnsPromptly`.
- No DB/localStorage/engine change → no alembic migration, no lazy migration, no engine reinstall.
- `cd frontend && bunx vitest run` passes including the new `cuesFromChapters` / `cueSheetFilename` / `cueSheetStream` cases and the updated `buildCueSheet` (TAB) expectation; the existing vitest suite and the legacy `node:test` runner stay green; the unchanged backend pytest jobs (`tests/`, `backend/tests/`) stay green.
- No backend change, no new dependency, no version bump; behavior identical across macOS / Windows / Linux (no platform branch; `tauri-cross-platform` CI job green); fully local (no network call).
