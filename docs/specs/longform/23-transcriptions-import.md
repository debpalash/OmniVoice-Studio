# TASK #23 — Import from Transcriptions → script / lines

## TL;DR

Add a "From Transcriptions" picker that reads the existing `localStorage['omni_transcriptions']` history and lets a user seed longform work from a past dictation:

- **Audiobook tab** (`frontend/src/pages/AudiobookTab.jsx`) → inserts/replaces the script `<textarea>` (the `text` state at `AudiobookTab.jsx:21`) with the chosen transcription's text.
- **Stories editor** (`frontend/src/components/StoriesEditor.jsx`) → routes the chosen text into the existing "Paste & auto-split" panel (`splitText`/`splitOpen` state at `StoriesEditor.jsx:144-145`), so the user can then hit **Paste & Split** (`applySplit`, `StoriesEditor.jsx:236` → one Narrator track per chunk via `splitIntoChunks`) or **Auto-cast** (`autoCast`, `StoriesEditor.jsx:175` → `parseScript()` → cast + attributed lines).

No backend changes. The transcriptions store already exists (`Transcriptions.jsx` writes it via the exported `addTranscription`; `Projects.jsx` reads it). We'll extract a tiny shared reader util to kill the third copy of the localStorage parse, add a reusable `<TranscriptionPicker>` modal (wrapping the existing `Dialog` primitive — see Design), and wire it into both `AudiobookTab.jsx` and `StoriesEditor.jsx`. All strings go through i18n.

This is a **default, no-opt-in feature** (a toolbar button visible out-of-the-box in two tabs). Per the OmniVoice cross-platform-parity hard rule, that means its user-visible behavior must be **identical on macOS / Windows / Linux** — which it is by construction (pure browser-side React + localStorage + the existing Radix `Dialog`; no OS APIs, no shell, no native paths). See the **Constraints** section for how every relevant hard rule is satisfied.

## Problem

Users record dictation in the Transcriptions page; the text lands in `localStorage` under `omni_transcriptions` (capped at 200 entries — see `Transcriptions.jsx:41-42`, `if (list.length > 200) list.length = 200;`). Today there is **no path** to take that captured text into the longform tools — they must manually copy from the Transcriptions detail panel and paste into the Audiobook script box or the Stories split panel. The two tools already accept pasted text (`AudiobookTab` `text` state at line 21; Stories `splitText` at line 145 with `applySplit`/`autoCast`), but there is no in-app bridge from the transcription history.

Secondary problem: the localStorage read logic is **duplicated** —
- `frontend/src/pages/Transcriptions.jsx:21-24` defines `loadTranscriptions()` against a module-local `STORAGE_KEY = 'omni_transcriptions'` (line 18) and `TXN_EVENT = 'omni:transcription-added'` (line 19). **Verified current body:** `function loadTranscriptions() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }` — note it has **no `Array.isArray` guard** today.
- `frontend/src/pages/Projects.jsx:116-119` re-implements the same `JSON.parse(localStorage.getItem('omni_transcriptions') || '[]')` with a try/catch inline in a `useState` initializer, and again at `Projects.jsx:121-128` (the event listener, hardcoding `'omni:transcription-added'`).

Adding a third inline copy in two more components is the wrong move.

> **Side observation (out of scope, do not fix here):** `Transcriptions.jsx:77-82` declares a local `const copyText = useCallback(...)` that shadows the imported `copyText` (line 11) and calls *itself* recursively (`copyText(text).then(...)`). This is a latent bug in existing code; it is unrelated to this task and the refactor below does not touch it. Flag it for a separate fix if noticed during review.

## Goal / Non-goals

### Goals
- A reusable picker (modal) that lists transcription history (newest-first — the store is already stored newest-first because `addTranscription` does `list.unshift(newEntry)` at `Transcriptions.jsx:40`, so render in array order, no re-sort needed), searchable, showing text preview + relative time + language chip + duration, and on select fires a callback with the chosen entry.
- **Audiobook**: a "From Transcriptions" button in the `audiobook-tab__actions` toolbar (`AudiobookTab.jsx:189-200`, next to the existing Import `<label>` at lines 190-193) → picker → fills the script textarea. If the textarea already has content, ask whether to **Replace** or **Append** (don't silently clobber).
- **Stories**: a "From Transcriptions" toolbar button in the "Content" `stories-editor__group` (`StoriesEditor.jsx:460-473`, next to the `pasteSplit` button at lines 464-466) → picker → routes text into the existing split panel (`setSplitText(entry.text)` + `setSplitOpen(true)`), so the user drives Paste & Split or Auto-cast from there (reusing existing `applySplit`/`autoCast`/`parseScript`). No new parsing code in Stories.
- Extract `frontend/src/utils/transcriptionsStore.js` as the single reader (`loadTranscriptions()` + the key/event consts), and refactor `Transcriptions.jsx` + `Projects.jsx` to import it.
- Empty-state handling: if there are zero transcriptions, the picker shows an empty message and the entry point is still discoverable (button present but opens to the empty state — see Design).
- All user-facing text via `t('...')`; English keys added under a new `transcriptionPicker.*` block in `frontend/src/i18n/locales/en.json` (plus the two new entry-point keys `audiobook.from_transcriptions` and `stories.fromTranscriptions`, and the Replace/Append prompt keys).

### Non-goals
- No backend endpoint, no DB, no new API. Transcriptions stay client-side in localStorage. (This keeps the **local-first guarantee** trivially intact — no network surface is added; see Constraints.)
- No new segment-level / timestamped import (we import the flat `text`, not per-segment splitting). The `segments` array on each entry is ignored for v1.
- No change to `parseScript()` behavior (`frontend/src/utils/parseScript.js`), `splitIntoChunks` (`StoriesEditor.jsx:64`), `storyTokens` (`frontend/src/utils/storyTokens.js`), or `storyToSpans` (`frontend/src/utils/storyToSpans.js`). We reuse them as-is.
- No new "Transcriptions → Dub" path (out of scope; #30 covers Dub-side flows).
- Not touching the Projects page transcription tile behavior (`Projects.jsx:212-225`) beyond the shared-reader refactor.
- **No write/delete/clear from the picker.** The picker is read-only. Deleting/clearing/exporting transcriptions stays exclusively in `Transcriptions.jsx`. Picking does not consume or mutate the entry (the source row remains in history). This also means the picker introduces **no localStorage schema change** → no migration needed (see Constraints → Backward-compatible data).

---

## API / data shapes (authoritative — implement against these exactly)

This task adds **no HTTP API, no SSE, no DB, no migration.** The "API" surface here is (a) the localStorage entry shape, (b) the new util's exported functions/consts, (c) the React component prop contracts, and (d) the i18n key set. All four are pinned exactly below so the feature can be implemented without guessing shapes.

### A.1 — localStorage entry shape (producer contract, verified `Transcriptions.jsx:30-46`)

The store at key `'omni_transcriptions'` is a JSON **array** of entries, newest-first (`addTranscription` does `list.unshift(newEntry)`). Each entry as written by the producer:

```ts
interface Transcription {
  id: number;            // Date.now() at capture (verified Transcriptions.jsx:33)
  text: string;          // flat dictation text  ← the ONLY field we import (default '')
  language: string;      // e.g. 'en'; default 'unknown' when unknown
  duration_s: number;    // seconds; default 0 when unknown
  segments: Array<{ start: number; end: number; text: string }>;  // default []; IGNORED in v1
  timestamp: string;     // ISO 8601, new Date().toISOString()
}
```

Producer defaults (verified `Transcriptions.jsx:32-39`) — the picker relies on these being the *typical* shape but must not assume them (next block):

```js
const newEntry = {
  id: Date.now(),
  text: entry.text || '',
  language: entry.language || 'unknown',
  duration_s: entry.duration_s || 0,
  segments: entry.segments || [],
  timestamp: new Date().toISOString(),
};
```

200-entry cap (verified `Transcriptions.jsx:42`): `if (list.length > 200) list.length = 200;` — **unchanged** by this task.

### A.2 — Defensive read shape (what the picker MUST tolerate at render time)

Entries may be legacy, hand-edited, or written by a different app version. Any field may be absent or wrong-typed. The picker normalizes **per row, for display only** (read-time tolerance — never a write-back rewrite of the user's history):

```ts
type RawTranscription = Partial<Transcription> & Record<string, unknown>;
// Per-field display normalization the picker applies (exact rules):
//   id?:         number | string | undefined  → React key = entry.id ?? idx
//   text?:       unknown                       → String(entry.text ?? ''); empty-after-trim row HIDDEN
//   language?:   unknown                       → chip iff (entry.language && entry.language !== 'unknown')
//   duration_s?: unknown                       → chip iff (typeof === 'number' && entry.duration_s > 0)
//   timestamp?:  unknown                       → time chip iff Date parses (!Number.isNaN(d.getTime()))
//   segments?:   unknown                       → ignored (v1)
```

### A.3 — `frontend/src/utils/transcriptionsStore.js` (NEW) — exact module API

```js
// Storage contract (do NOT change these literals — pinned by a test, see Test plan #1):
export const TRANSCRIPTIONS_KEY  = 'omni_transcriptions';
export const TRANSCRIPTION_EVENT = 'omni:transcription-added';

/**
 * Read the transcription history. Never throws; always returns an array.
 * @returns {Array<object>} stored entries, newest-first; [] on any failure.
 */
export function loadTranscriptions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRANSCRIPTIONS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
```

**Exported symbol signatures (the full public surface of this module):**

| Export | Type | Value / Signature |
|---|---|---|
| `TRANSCRIPTIONS_KEY` | `string` (const) | `'omni_transcriptions'` |
| `TRANSCRIPTION_EVENT` | `string` (const) | `'omni:transcription-added'` |
| `loadTranscriptions` | `() => Array<object>` | parse + array-guard, `[]` on failure |

This module exports **no default** and renders no UI (so it carries no i18n keys and is not CJK-relevant).

> **Backward-compat note (data migration rule):** the storage key (`'omni_transcriptions'`), the entry shape, and the 200-entry cap are **unchanged**. This util only *relocates* the reader and the key/event consts; it does not version, rename, or rewrite the store. There is therefore **no localStorage migration** to perform — existing dictation history loads as-is. (localStorage is not under alembic; the CLAUDE.md "alembic for DB schema changes" rule applies to `omnivoice_data/` server-side state, not client-side localStorage. The relevant client-side discipline here is *lazy tolerance of legacy/partial shapes at read time*, which the picker does per-row — see Component B "Defensive read".)

> **Completeness note on the `Array.isArray` guard:** the *current* `Transcriptions.jsx:21-24` does **not** guard the shape — `JSON.parse('"foo"')` or `JSON.parse('{}')` would return a non-array and then `.filter`/`.map`/`.length` would either throw downstream or behave oddly. To stay strictly behavior-preserving for the existing consumers (which only ever see arrays the producer wrote), the `Array.isArray` guard is a **superset** — it never changes behavior for valid stored arrays, and only hardens the new picker (and the refactored consumers) against a localStorage value that was hand-edited, corrupted, or written by a different app version. This guard is the single defense; do **not** scatter `Array.isArray` checks at every call site. If a reviewer objects to even this superset change in a "behavior-preserving refactor" slice, the guard can move to the picker's own normalization step (see Component B "Defensive read") instead — but it must live in exactly one place.

**`loadTranscriptions()` failure/edge matrix (all must be handled by returning `[]`, never throwing):**

| localStorage state | `getItem` returns | `loadTranscriptions()` returns |
|---|---|---|
| key absent | `null` → `'[]'` | `[]` |
| empty string `''` | `''` → falsy → `'[]'` | `[]` |
| `'[]'` | `'[]'` | `[]` |
| malformed JSON (`'[{'`) | throws in `JSON.parse` | `[]` (caught) |
| valid JSON but not an array (`'"x"'`, `'{}'`, `'5'`, `'null'`) | non-array / `null` | `[]` (Array.isArray guard) |
| valid array of entries | the array | the array (no re-sort, no de-dup) |
| `localStorage` access throws (private-mode / disabled storage) | throws | `[]` (caught) |

> **Test-harness caveat for the empty-string row:** the bundled `localStorage` mock (`frontend/src/test/setup.js:8-24`) implements `getItem(key) { return store[key] || null; }`, so `setItem(KEY, '')` round-trips to `null` (empty string is falsy), not `''`. Under the test mock the "empty string" row therefore behaves identically to the "key absent" row — both reach `'[]'`. This is fine (the production `Storage.getItem` would return `''`, which `|| '[]'` also coerces to `'[]'`). The test for the empty-string case can assert `[]` regardless. The mock also stringifies on write (`store[key] = value.toString();`, `setup.js:15`) and does **not** implement `key`/`length`/`removeItem`-via-`length`. (It *does* implement `clear()` and `removeItem(key)`, `setup.js:17-22`.)

### A.4 — `<TranscriptionPicker>` prop contract (NEW component)

```ts
interface TranscriptionPickerProps {
  open: boolean;                       // controlled visibility (forwarded to Dialog)
  onClose: () => void;                 // called on X / ESC / backdrop (Dialog onOpenChange) AND by us after a pick
  onPick: (entry: Transcription) => void;  // receives the ORIGINAL stored object (un-normalized; entry.text is a string per producer contract)
}
// No `profiles`, no other props. The picker reads localStorage directly; App.jsx wiring is unchanged.
```

`onPick` receives the **full, un-normalized original `entry`** (display normalization is for rendering only; the consumer reads the real `entry.text`). Whitespace inside `text` is preserved (no trim on the picked value — trimming/joining is the consumer's job).

### A.5 — `Dialog` primitive contract (the picker wraps this; verified `frontend/src/ui/Dialog.jsx`)

```ts
// Exported default from '../ui' barrel (ui/index.js:18). Props (verified Dialog.jsx:20-28):
interface DialogProps {
  open: boolean;
  onClose?: () => void;       // invoked via onOpenChange(false) only when dismissable (Dialog.jsx:29-31)
  title?: string | ReactNode; // null → header-less (an sr-only RadixDialog.Title is still rendered, Dialog.jsx:67)
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';   // default 'md'
  dismissable?: boolean;      // default true → X button + ESC + backdrop all close
  children: ReactNode;
}
```

Key verified facts the picker relies on:
- `onClose` fires on `onOpenChange(false)` (Dialog.jsx:29-31) → covers (a) built-in X button (Dialog.jsx:58-64, rendered only when `dismissable`), (b) ESC (`onEscapeKeyDown`, Dialog.jsx:33-35/47), (c) backdrop pointer-down (`onPointerDownOutside`, Dialog.jsx:37-39/48) — all when `dismissable` is true (default).
- Content renders through `RadixDialog.Portal` (Dialog.jsx:43) → mounts **outside** the component subtree; tests must query via `screen.*`/`findBy*`, not `container.querySelector`.
- When `open={false}`, Radix renders nothing → no manual `if (!open) return null` guard needed in the picker.
- The Dialog supplies the X close button itself (Dialog.jsx:58-64, `aria-label="Close"`), so the picker imports **no** `X` icon. (Note that `aria-label="Close"` is a *hardcoded English literal in the existing `Dialog.jsx`* — pre-existing, out of scope, and `Dialog.jsx` is the shared primitive, not something this task edits.)

### A.6 — Audiobook internal state shapes (NEW state in `AudiobookTab.jsx`)

```ts
const [pickerOpen, setPickerOpen]       = useState/* <boolean> */(false);
// staged import held only while the textarea is non-empty and awaiting Replace/Append/Cancel:
const [pendingImport, setPendingImport] = useState/* <{ text: string } | null> */(null);
```

`onPickTranscription` signature + resolution table:

```ts
function onPickTranscription(entry: Transcription): void;
```

| Condition at pick time | Action |
|---|---|
| `String(entry?.text ?? '').trim() === ''` | `setPickerOpen(false)` only — no-op (defensive; picker hides empty-text rows) |
| `text.trim() === ''` (empty textarea) | `setText(incoming); setPlan(null); setPickerOpen(false)` |
| `text.trim() !== ''` (non-empty textarea) | `setPickerOpen(false); setPendingImport({ text: incoming })` — open inline prompt; do NOT mutate `text` yet |

| Prompt button | Resolution |
|---|---|
| **Replace** | `setText(pendingImport.text); setPlan(null); setPendingImport(null);` |
| **Append** | `setText(text + '\n\n' + pendingImport.text); setPlan(null); setPendingImport(null);` |
| **Cancel** | `setPendingImport(null);` — `text` and `plan` untouched |

`incoming` is read once: `const incoming = String(entry?.text ?? '');`. `setPlan(null)` mirrors `onImport` (`AudiobookTab.jsx:88-89`: `setText(r.text); setPlan(null);`). **Cancel does not clear the plan.**

### A.7 — Stories internal state shape (NEW state in `StoriesEditor.jsx`)

```ts
const [pickerOpen, setPickerOpen] = useState/* <boolean> */(false);

function onPickTranscription(entry: Transcription): void {
  const incoming = String(entry?.text ?? '');
  if (!incoming.trim()) { setPickerOpen(false); return; }          // defensive no-op
  setSplitText(incoming); setSplitOpen(true); setPickerOpen(false); // route to existing split panel
}
```

No `pendingImport` analog — Stories routes through the split panel (scratch state), so no Replace/Append prompt (see Component D rationale).

### A.8 — i18n key set (English only; exact key names + values to add to `en.json`)

New keys (verified absent today; siblings confirmed: `stories.pasteSplit`=`"Paste & Split"` at en.json:37, `audiobook.import`=`"Import"` at en.json:147, `audiobook.plan_heading`=`"Plan — {{count}} chapter(s)"` at en.json:121, `audiobook.script`=`"Script"` at en.json:115):

```jsonc
// under "transcriptionPicker": { … }  (NEW block)
"title":              "Import from Transcriptions",
"search_placeholder": "Search transcriptions…",
"empty":              "No transcriptions yet — record one in the Transcriptions page.",
"empty_search":       "No matching transcriptions",

// under "audiobook": { … }  (add to existing block)
"from_transcriptions":   "From Transcriptions",
"import_replace_prompt": "The script already has text. Replace it or append?",
"import_replace":        "Replace",
"import_append":         "Append",
"import_cancel":         "Cancel",

// under "stories": { … }  (add to existing block)
"fromTranscriptions": "From Transcriptions"
```

**Reused (do NOT duplicate)** — relative time, verified `en.json:982-984`, simple `{{count}}` interpolation (not i18next plural suffixes, so no `_one`/`_other` variants needed):
- `transcriptions.just_now` = `"Just now"`
- `transcriptions.m_ago` = `"{{count}}m ago"` — call `t('transcriptions.m_ago', { count })`
- `transcriptions.h_ago` = `"{{count}}h ago"` — call `t('transcriptions.h_ago', { count })`

i18n config (verified `i18n/index.ts:63-65`): `partialBundledLanguages: true`, `fallbackLng: 'en'`, `interpolation: { escapeValue: false }`. → Missing keys in the other 20 locales render the English fallback; **do not edit the other locale JSONs.**

### A.9 — Confirmation: NO backend / SSE / API touched

The Audiobook synth path (`onCreate`/`onPreview`/`onPreviewChapter`, `AudiobookTab.jsx:68-175`) calls `../api/audiobook` (`audiobookPlan`/`audiobookGenerate`/`audiobookPreviewChapter`/`audiobookUploadCover`/`audiobookImport`/`longformRender`) and `../api/generate` (`audioUrl`). **None of these are added, removed, or altered by this task.** For reference, the request/response shapes already defined in `frontend/src/api/audiobook.ts` (which this task does **not** modify) include `AudiobookPlan { chapters[], chapter_count, char_count }`, `audiobookGenerate(): Promise<Response>` (SSE stream with event types `started|chapter|assembling|chapter_error|done|error`, parsed at `AudiobookTab.jsx:151-167`), and `audiobookImport(): Promise<{ text: string; chapters: number }>`. The import-from-transcriptions path writes only React state (`setText`/`setPlan`/`setSplitText`/`setSplitOpen`) and never calls these — that's the local-first / no-network posture. **Test consequence:** because the import path never touches `../api/*`, picker/store unit tests need **no** network mock; only the Audiobook *integration* tests that happen to render the synth buttons must `vi.mock('../api/audiobook')` + `vi.mock('../api/generate')` so an accidental `onCreate`/`onPreview` click can't make a real `fetch` (see Test plan #3).

---

## Design

### Component A — shared reader util (`frontend/src/utils/transcriptionsStore.js`) — NEW
Pure, no React. Single source of truth for the storage key + event name + parse. Exact module API is pinned in **A.3** above. Mirrors the current implementation in `Transcriptions.jsx:18-24` so the refactor is behavior-preserving (plus the `Array.isArray` superset guard). **Because it is a pure module with no React and no torch/GPU/backend dependency, its test (Test #1) imports it directly and exercises the full edge matrix in milliseconds — this is the cheapest, highest-leverage test in the set.**

Refactor consumers to import these instead of re-declaring:
- **`Transcriptions.jsx`**: import `loadTranscriptions`, `TRANSCRIPTIONS_KEY`, `TRANSCRIPTION_EVENT` from `../utils/transcriptionsStore`. Remove the local `STORAGE_KEY` (line 18), `TXN_EVENT` (line 19), and the `loadTranscriptions` definition (lines 21-24). Keep `saveTranscriptions` (lines 26-28, now referencing the imported `TRANSCRIPTIONS_KEY`) and `addTranscription` (lines 30-46, now dispatching the imported `TRANSCRIPTION_EVENT`) — it owns the writes. Update the `useEffect` listener (lines 55-61) and `useState` initializer (line 50) to use the imported symbols. (Note: `useState(loadTranscriptions)` passes the function as a lazy initializer — keep that shape.)
- **`Projects.jsx`**: import `loadTranscriptions` + `TRANSCRIPTION_EVENT` from `../utils/transcriptionsStore`. Replace the inline parse in the `useState` initializer (lines 116-119) with `useState(loadTranscriptions)`, and replace both the literal `'omni_transcriptions'` parse and the literal `'omni:transcription-added'` in the listener (lines 121-128) with `loadTranscriptions()` and `TRANSCRIPTION_EVENT`.

This is required by CLAUDE.md "reuse" sensibilities and avoids drift if the key/limit ever changes.

### Component B — picker (`frontend/src/components/TranscriptionPicker.jsx`) — NEW
A self-contained, controlled modal. It does **not** know about Audiobook vs Stories — it only knows "user picked an entry." Prop contract pinned in **A.4**.

> **No-CJK / no-hardcoded-UI-text rule (this is a brand-new file, NOT in the CJK allowlist):** `TranscriptionPicker.jsx` is a new component and is **not** in `_ALLOWED_FILES` in `tests/test_no_hardcoded_cjk.py` (`StoriesEditor.jsx` *is* allowlisted at line 56, but that exemption does not extend to the new picker). Every user-facing string the picker renders must be a `t('...')` lookup against `en.json`; there must be **zero hardcoded literals (English or CJK)** in JSX. Do not add this file to the allowlist — keep it clean so the CJK CI gate passes for free. (The new util `transcriptionsStore.js` is also not allowlisted, but it renders no UI text, so it's a non-issue; the new `*.test.*` files are auto-allowed by the `.test.` rule at `test_no_hardcoded_cjk.py:90`.)

**Wrap the existing `Dialog` primitive — do NOT hand-roll an overlay.** Contract in **A.5**. `frontend/src/ui/Dialog.jsx` already exists and is exported from the `../ui` barrel (`frontend/src/ui/index.js:18`). It is backed by `@radix-ui/react-dialog` (`package.json` dep `@radix-ui/react-dialog@^1.1.15`) and provides focus trapping, Escape-to-close, scroll lock, a built-in close (`X`) button, and proper ARIA out of the box. Two components already wrap it this way — see `frontend/src/components/DirectionDialog.jsx` and `frontend/src/components/AudioTrimmer.jsx` for the call pattern. This removes the spec's earlier "hand-rolled overlay + `TranscriptionPicker.css` backdrop" assumption: **no backdrop CSS and no manual `X` button are needed.** A small `TranscriptionPicker.css` may still be added for the list/row layout only. (Reusing Radix here also means cross-platform parity is *inherited* — Radix's focus/dismiss behavior is identical across OS webviews; see Constraints.)

> **Dialog close-path completeness:** `Dialog.jsx:29-31` calls `onClose` on Radix `onOpenChange(false)`, which fires for (a) the built-in `X` button, (b) Escape, and (c) backdrop pointer-down — but **only when `dismissable` is true** (the default; `handleOpenChange` guards `if (!nextOpen && dismissable) onClose?.()`). The picker uses `dismissable` default (true), so all three close routes invoke our `onClose`. There is **no double-fire risk** when picking a row (we call `onPick(entry)` then `onClose()` ourselves; `onClose` flips `open` to `false`, which does *not* re-trigger `onOpenChange` from Radix on a controlled-prop change). Closing while a row is mid-click is harmless — `onPick` runs synchronously before `onClose`.

Behavior:
- Render `<Dialog open={open} onClose={onClose} title={t('transcriptionPicker.title')} size="md">…</Dialog>`. Dialog already renders nothing when `open={false}` (Radix), so no manual `if (!open) return null` guard is required — but keep the `loadTranscriptions()` read gated to mount/open to avoid reading on every render.
- **Read timing / state:** keep the list in local state (`const [entries, setEntries] = useState([])`). Read on open: a `useEffect([open])` that, when `open` becomes true, calls `setEntries(loadTranscriptions())`. (Fresh read each open — cheap, ≤200 entries.) When `open` is false, do not read. Optionally clear `search` to `''` on each open so a stale query from a prior open doesn't hide rows.
- **Live updates while open:** subscribe to `TRANSCRIPTION_EVENT` only while `open` is true (mirror the listener pattern at `Transcriptions.jsx:55-61`); the handler re-runs `setEntries(loadTranscriptions())`. Add/remove the listener in the same `useEffect([open])` cleanup so it's never attached while closed. Edge: an event that fires the moment the user is mid-search just refreshes the underlying list — the active `search` filter re-applies on the next render, so the new row appears only if it matches the query (acceptable; mirrors the Transcriptions page).
- **Defensive read / per-field normalization (mandatory — rules pinned in A.2):** never assume a field exists. The producer (`addTranscription`) defaults `text→''`, `language→'unknown'`, `duration_s→0`, `segments→[]`, and sets `id` + `timestamp` (verified `Transcriptions.jsx:32-39`), but older or externally-written entries may omit any of these. This per-row tolerance **is** the client-side analog of the backward-compatible-data rule: read-time normalization, never a write-back rewrite of the user's stored history. Normalize per row before rendering:
  - `text`: `String(entry.text ?? '')`. A row with empty `text` after trim → **hidden** (do not render; see "empty-text rows" below).
  - `id`: used as the React `key`. If `id` is missing/duplicate, fall back to the array index (`key={entry.id ?? idx}`) so React never warns or mis-reconciles. (Projects.jsx already does this defensively with `tr.id || String(Math.random())` at `Projects.jsx:215`.)
  - `language`: chip only when `entry.language && entry.language !== 'unknown'` (mirrors `Transcriptions.jsx:188`). Missing/`'unknown'`/`''` → no chip.
  - `duration_s`: show `duration_s.toFixed(1)`s only when `typeof duration_s === 'number' && duration_s > 0` (mirror `Transcriptions.jsx:193-194`, plus the `typeof` guard so a string or `undefined` doesn't throw on `.toFixed`).
  - `timestamp`: pass to `formatTime`; if missing or unparseable, `new Date(undefined)` → `Invalid Date` → the relative-time math (`now - d`) yields `NaN`, which falls through to `toLocaleDateString` returning `"Invalid Date"`. Guard: if `Number.isNaN(d.getTime())`, render no time chip (or a neutral dash) rather than the literal string "Invalid Date".
- **Empty-text rows:** filter out entries whose normalized `text.trim()` is empty *before* both the search filter and the row render. Rationale (grounded in downstream behavior): an empty-text pick would no-op everywhere — `AudiobookTab.canRun` (line 178, `text.trim().length > 0 && !busy`) requires non-empty trimmed text; Stories `applySplit` early-returns when `splitIntoChunks` yields `[]` (which it does for blank input, `StoriesEditor.jsx:67`/`88`); `autoCast` toasts `stories.autocastEmpty` (line 177) because `parseScript('')` returns `[]` (`parseScript.js:45`). Hiding zero-text rows removes a dead-end the user could otherwise click. If *every* entry has empty text, the picker shows the same empty state as a zero-length store.
- **Search:** input filtering on text + language. Reuse the filter shape from `Transcriptions.jsx:63-70`: `entry.text.toLowerCase().includes(q) || (entry.language || '').toLowerCase().includes(q)` (operate on the *normalized* `text`/`language`). When `search.trim()` is empty, show all (visible, non-empty-text) rows. The `../ui` barrel exports `Input`/`Textarea`/`Field` from `Input.jsx` (`index.js:17`); `Input` is `forwardRef(({ size='md', className='', ...rest }) => …)` (verified `Input.jsx:42-53`) — use `Input` for the search box (or a plain input with the existing `txn-search` styling); do not import a select.
  - **Search edge cases:** (a) query that matches nothing → render the *search-specific* empty state (`transcriptionPicker.empty_search` — distinct from the no-entries-at-all `transcriptionPicker.empty`, mirroring how `Transcriptions.jsx:164-170` distinguishes `empty_search_title` from `empty_title`). (b) whitespace-only query → treated as empty (show all). (c) query is matched case-insensitively (`.toLowerCase()` both sides). (d) very long query: no special handling needed (substring `.includes`, no regex, so no ReDoS surface — **this is the CodeQL `py/polynomial-redos` posture for this feature: the only user-input string-matching path uses `String.prototype.includes`, never a constructed `RegExp`**; see Constraints → CodeQL ReDoS. **Do not** convert the search to a `RegExp` — that would create exactly the polynomial-regex-on-user-input surface the CodeQL gate flags).
- Each row: truncated text (≤120 chars — mirror `Transcriptions.jsx:182`: `text.length > 120 ? text.slice(0, 120) + '…' : text`), relative time, language chip, duration. Clicking a row calls `onPick(entry)` then `onClose()`. **Pass the full, un-normalized original `entry`** to `onPick` (per A.4 contract). Whitespace inside `text` is preserved for the consumer (no trim on the picked value).
  - **Row interaction completeness:** the row must be keyboard-activatable (it's a clickable, not a `<button>` in the existing Transcriptions list). Make each row a real `<button type="button">` (or add `role="button"` + `tabIndex={0}` + Enter/Space `onKeyDown`) so focus-trap (Dialog) lands somewhere sensible and the picker is usable without a mouse. This is an *improvement* over the existing `<div onClick>` rows in `Transcriptions.jsx:175-180` — acceptable since it's a new component, and it keeps keyboard parity identical across platforms. **Test consequence:** a `<button>` row is queryable via `screen.getByRole('button', { name: … })` and activatable with both `fireEvent.click` and a keyboard event — Test #2 asserts both (see "keyboard-activatable").
- Empty state (no entries / all hidden): icon (`Mic`) + `t('transcriptionPicker.empty')` with a hint to record one in the Transcriptions page. The button/entry-point stays present and openable even with zero entries (discoverability) — opening just shows this state.
- Icons via `lucide-react` (`Mic`, `Search`, `Clock`, `Languages`, `FileText` are all already imported in `Transcriptions.jsx:13` — reuse the same names). The `X` close icon is **not** needed (Dialog supplies it).
- **`formatTime` — reuse the verified logic from `Transcriptions.jsx:111-119`, defined *inside* the component** (it depends on `t`). Exact reference implementation to mirror, **plus** the missing Invalid-Date guard:

  ```js
  const formatTime = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;   // ← NEW guard; original (Transcriptions.jsx) lacks it.
    const now = new Date();                        // Caller renders the time chip only when this returns non-null.
    const diff = now - d;
    if (diff < 60000)   return t('transcriptions.just_now');
    if (diff < 3600000) return t('transcriptions.m_ago', { count: Math.floor(diff / 60000) });
    if (diff < 86400000)return t('transcriptions.h_ago', { count: Math.floor(diff / 3600000) });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  ```
  Reuse the existing `transcriptions.just_now` / `transcriptions.m_ago` / `transcriptions.h_ago` keys — do **not** duplicate them under `transcriptionPicker.*`. The unparseable-`timestamp` case is the one input that otherwise makes `formatTime` emit a junk `"Invalid Date"` string; the guard returns `null` so the row simply omits the time chip. Note the final-branch `toLocaleDateString(undefined, …)` uses the host locale, which differs by OS/browser; that is acceptable locale-aware formatting (the *relative* strings above it go through `t()` and are i18n-driven — the only divergence is the absolute-date fallback, which is locale formatting, not untranslated UI text). **Test note:** because `formatTime`'s branch boundaries are wall-clock-relative, integration tests should seed timestamps as `new Date(Date.now() - N).toISOString()` (e.g. `Date.now() - 30_000` for "Just now") rather than hardcoded ISO strings, so the relative-time assertion isn't time-bomb-fragile. The Invalid-Date guard is asserted with a literally bad timestamp (`timestamp: 'not-a-date'`).

### Component C — Audiobook wiring (`frontend/src/pages/AudiobookTab.jsx`)
State + handler shapes pinned in **A.6**.
- Add `Mic` to the existing `lucide-react` import at `AudiobookTab.jsx:3` (current import is `BookMarked, Loader, Download, Image as ImageIcon, X, Play, Upload, Plus` — `Mic` is **not** yet imported here, unlike in `Transcriptions.jsx`).
- Add `const [pickerOpen, setPickerOpen] = useState(false);` and `const [pendingImport, setPendingImport] = useState(null);` (alongside the other `useState` hooks, e.g. near lines 21-30).
- Add a button in `audiobook-tab__actions` (`AudiobookTab.jsx:189-200`), next to the Import `<label>` (lines 190-193): label `t('audiobook.from_transcriptions')` with a `Mic` icon, `disabled={busy}` (the `busy` flag is computed at line 177: `planLoading || generating || importing`). Match the existing `className="ui-btn ui-btn--subtle"` styling of the sibling Preview/Import controls.
  - **Disabled-state completeness:** while `busy` (a plan preview, a generate stream, or a file import is in flight), the button is disabled, so the picker cannot be opened mid-operation. If the picker is *already open* when the user starts a generate (not possible via this UI since the toolbar is the only entry, but defensively): picking still only mutates `text`/`plan` state, never the in-flight stream — `onCreate` already snapshotted `text` into its closure at call time (`AudiobookTab.jsx:131`), so a late import does not corrupt the running synthesis. No guard needed beyond the `disabled` on the open button.
- Render `<TranscriptionPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={onPickTranscription} />` (e.g. just before the closing `</div>` of the tab, alongside other top-level render).
- `onPickTranscription(entry)` — full resolution table in **A.6**. Summary:
  - Read once: `const incoming = String(entry?.text ?? '')`. If `incoming.trim()` is empty → **no-op**: `setPickerOpen(false)`, do nothing else (don't open the prompt, don't clear the plan). Belt-and-suspenders guard (picker already hides empty-text rows).
  - **Close the picker immediately** on pick (`setPickerOpen(false)`) regardless of branch — the picker should not stay open behind the Replace/Append prompt.
  - **Empty textarea** (`text.trim() === ''`) → `setText(incoming); setPlan(null);` directly, no prompt.
  - **Non-empty textarea** (`text.trim() !== ''`) → `setPendingImport({ text: incoming })`. Do **not** mutate `text` yet. Resolve via Replace / Append / Cancel (see A.6 table).
    - **Append join semantics:** `text + '\n\n' + pendingImport.text` joins with `\n\n` — a paragraph break; `parseScript` splits paragraphs on `\n\s*\n` per `parseScript.js:48`, and the audiobook backend treats blank lines as paragraph breaks. **Cross-platform note:** the join uses `\n` (LF), never `\r\n` — and the downstream splitters (`parseScript` `.replace(/\r\n/g,'\n')` at `parseScript.js:44`, `splitIntoChunks` `.replace(/\r\n/g,'\n')` at `StoriesEditor.jsx:66`) normalize `\r\n`→`\n` first, so the seam behaves identically on Windows. Edge: if existing `text` already ends with a trailing newline, the result has `…\n\n\n…` — harmless (the splitter collapses runs of blank-ish lines via `\n\s*\n`), so no need to trim/normalize the seam.
  - Either successful branch sets `setPlan(null)` to invalidate the previously previewed plan — mirroring `onImport` at `AudiobookTab.jsx:88-89`. **Cancel does not clear the plan.**
  - **Pending-prompt lifecycle edge cases:**
    - If a `pendingImport` prompt is open and the user picks *again* (not possible while the prompt is shown if the picker stays closed — but defensively): the latest pick overwrites `pendingImport`, never queues. One prompt at a time.
    - The prompt is plain inline state (a small row above the script `<textarea>` region, `AudiobookTab.jsx:203-214`, inside `audiobook-tab__script`), **not** a `window.confirm` (i18n-able + testable; also identical across platforms — `window.confirm` chrome/wording varies by OS, an i18n inline prompt does not). It uses `audiobook.import_replace_prompt` text with `import_replace` / `import_append` / `import_cancel` buttons. It does not trap focus and does not block other UI; if the user ignores it and edits the textarea directly, that's fine — Append reads `text` at resolution time, so manual edits between pick and resolve are respected. **Test consequence:** because the prompt is real DOM (not `window.confirm`, which jsdom stubs and which would need a `vi.spyOn(window, 'confirm')`), Test #3 asserts the prompt text and clicks the three buttons directly with `screen`/`fireEvent` — no `window.confirm` mock anywhere.
    - The prompt does not persist across tab switches/unmount (it's local component state, intentionally ephemeral).

### Component D — Stories wiring (`frontend/src/components/StoriesEditor.jsx`)
State + handler shape pinned in **A.7**.
- `Mic` is **already imported** in the `lucide-react` import at `StoriesEditor.jsx:13` — no import change needed for the icon. (You will still need to import `TranscriptionPicker`.)
- Add `const [pickerOpen, setPickerOpen] = useState(false);` (alongside the other UI-state hooks, e.g. near `StoriesEditor.jsx:142-156`).
- Add a toolbar `<Button size="sm" variant="ghost">` in the "Content" group (`StoriesEditor.jsx:460-473`, e.g. right after the `pasteSplit` button at lines 464-466): label `t('stories.fromTranscriptions')` with a `Mic` icon, matching the existing `Button` call shape used by its siblings (`<Button size="sm" variant="ghost" onClick={…} aria-label={…}><Mic size={13} /> {label}</Button>`).
  - **CJK-allowlist subtlety:** `StoriesEditor.jsx` is in `_ALLOWED_FILES` (`test_no_hardcoded_cjk.py:56`) because it already contains functional CJK (text-processing). That exemption does **not** license adding *new hardcoded UI text* here — the new button label must still go through `t('stories.fromTranscriptions')`. The allowlist suppresses the CJK *scan* for this file, not the i18n hard rule.
- Render `<TranscriptionPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={onPickTranscription} />` (e.g. near the other conditionally-rendered panels around `StoriesEditor.jsx:499+`).
- `onPickTranscription(entry)` — exact body in **A.7**:
  - Read once: `const incoming = String(entry?.text ?? '')`. If `incoming.trim()` is empty → no-op + `setPickerOpen(false)` (defensive; picker hides empty-text rows).
  - Otherwise route into the existing split panel so the user chooses Split vs Auto-cast (do **not** auto-apply): `setSplitText(incoming); setSplitOpen(true); setPickerOpen(false);`
  - This reuses `applySplit` (`StoriesEditor.jsx:236-242`) and `autoCast` (`StoriesEditor.jsx:175-200`) verbatim — no new parsing.
  - **Overwrite edge:** routing through the split panel **overwrites any in-progress `splitText`** the user had typed (same as the existing `onImportFile` at `StoriesEditor.jsx:202-214`, which does `setSplitText(text)` unconditionally at line 208). This is acceptable and consistent: the split panel is a scratch/staging area, not durable project state. The durable state is `tracks`/`cast`, which `applySplit`/`autoCast` only *append* to (`setTracks((prev) => [...prev, ...])`, `StoriesEditor.jsx:195`/`239`) — never overwrite. So Stories has **no clobber of real work**, only of un-applied scratch text. (Contrast with Audiobook, where `text` *is* the durable script → hence the Replace/Append prompt there.)
  - **Downstream no-op / failure paths (already handled by reused code, listed for completeness):**
    - `applySplit` with text that yields no chunks (e.g. only whitespace) → `splitIntoChunks` returns `[]` → `applySplit` early-returns (`StoriesEditor.jsx:238`, `if (!chunks.length) return;`), no tracks added, panel stays open. (Won't happen via the picker since empty-text rows are hidden, but pasting/clearing the staged text could reach it.)
    - `autoCast` with text that yields no parsed lines → `parseScript` returns `[]` → toast `stories.autocastEmpty` (`StoriesEditor.jsx:177`), panel stays open.
    - `autoCast` on prose (no `NAME:` and no quoted-attribution) → `parseScript` produces all-Narrator lines (`parseScript.js:78`, `out.push({ speaker: 'Narrator', text: para })`) → one Narrator cast member + N Narrator tracks. Not an error, just the expected "everything is narration" outcome (this is *why* we land in the split panel — see rationale below).
    - `applySplit`/`autoCast` always *append* to existing tracks; importing a second transcription appends again. There is no de-dup; repeated picks stack lines. Acceptable (matches existing import behavior).

### Why route Stories through the split panel (not direct auto-cast)
`parseScript()` (`frontend/src/utils/parseScript.js:42`) on raw dictation will mostly produce Narrator-only lines (dictation rarely has `NAME:` screenplay structure — see the screenplay regex at `parseScript.js:55`, `/^([A-Za-z][A-Za-z0-9 ._'-]{0,30}):\s+(.+)$/` — or quoted-attribution structure handled at `parseScript.js:62-83`). Landing the user in the split panel lets them pick the sentence-aware chunker (`splitIntoChunks`, `StoriesEditor.jsx:64`, clamps `maxChars` to `[40,2000]`) — the right default for prose narration — via `applySplit`, or `autoCast` if their dictation happens to be screenplay-shaped. This matches the existing import-file flow (`onImportFile`, `StoriesEditor.jsx:202-214`), which also sets `splitText` + opens the split panel rather than auto-applying.

### Data flow diagram
```
localStorage['omni_transcriptions']  (JSON array of Transcription, newest-first)
        │  loadTranscriptions()  (utils/transcriptionsStore.js → A.3)
        │    ├─ key absent / '' / malformed JSON / non-array → []
        │    └─ valid array → entries (newest-first, no re-sort)
        ▼
 <TranscriptionPicker open onClose onPick(entry) >   (wraps ui/Dialog, A.4/A.5)
        │  per-row normalize (A.2) · hide empty-text rows · search filter (String.includes, NO RegExp)
        │  empty store / all-hidden → transcriptionPicker.empty
        │  search-no-match → transcriptionPicker.empty_search
        │  onPick(entry) → ORIGINAL stored object (un-normalized)
        ├──(Audiobook A.6)──► incoming = String(entry?.text ?? '')
        │     ├─ incoming blank   → setPickerOpen(false)  [no-op]
        │     ├─ textarea empty   → setText(incoming); setPlan(null)
        │     └─ textarea non-empty → setPendingImport({text:incoming}) → prompt (inline i18n, not window.confirm)
        │           ├─ Replace → setText(incoming); setPlan(null); setPendingImport(null)
        │           ├─ Append  → setText(text+'\n\n'+incoming); setPlan(null); setPendingImport(null)   [LF join, CRLF-safe downstream]
        │           └─ Cancel  → setPendingImport(null)  [text + plan kept]
        │                                  └──► onPreview/onCreate (unchanged → /audiobook/* + /longform/render SSE)
        └──(Stories A.7)────► setSplitText(incoming); setSplitOpen(true)  [overwrites scratch only]
                                   ├──► applySplit  → append Narrator tracks (splitIntoChunks)
                                   │       └─ no chunks → early-return, panel stays open
                                   └──► autoCast     → parseScript() → append cast + lines
                                           └─ no lines → toast stories.autocastEmpty, panel stays open
```

## Integration points (file:line — verified against current source)

- `frontend/src/utils/transcriptionsStore.js` — **NEW** util (exact API in A.3). Not in the CJK allowlist (renders no UI text — fine).
- `frontend/src/pages/Transcriptions.jsx:18-19` — `STORAGE_KEY` / `TXN_EVENT` consts to remove and import from the util.
- `frontend/src/pages/Transcriptions.jsx:21-24` — `loadTranscriptions` definition to remove (import instead). **Verified: current body has no `Array.isArray` guard** — the util adds it as a superset.
- `frontend/src/pages/Transcriptions.jsx:26-46` — `saveTranscriptions` (lines 26-28) + `addTranscription` (lines 30-46) stay; rewire to imported consts. (Confirms `addTranscription` defaults `text:''`, `language:'unknown'`, `duration_s:0`, `segments:[]`, `id:Date.now()`, `timestamp:new Date().toISOString()` — the source of the legacy/partial-field edge cases the picker must tolerate. Confirms the 200-cap at line 42, unchanged.)
- `frontend/src/pages/Transcriptions.jsx:50,55-61` — `useState(loadTranscriptions)` initializer + `TXN_EVENT` listener to rewire.
- `frontend/src/pages/Transcriptions.jsx:111-119` — `formatTime` relative-time logic to mirror in the picker (uses `transcriptions.just_now` / `transcriptions.m_ago` / `transcriptions.h_ago` keys; the two `_ago` keys take `{ count }` interpolation, not plural suffixes). **Add the `Number.isNaN(d.getTime())` Invalid-Date guard the original lacks** (see Component B `formatTime` snippet).
- `frontend/src/pages/Transcriptions.jsx:63-70,182,188,193-194` — filter shape + row truncation + lang/duration display to mirror (add `typeof duration_s === 'number'` guard on `.toFixed`).
- `frontend/src/pages/Transcriptions.jsx:164-170` — distinct empty vs empty-search states; mirror that distinction in the picker (`transcriptionPicker.empty` vs `transcriptionPicker.empty_search`).
- `frontend/src/pages/Projects.jsx:116-119` — inline parse in `useState` initializer → `useState(loadTranscriptions)`.
- `frontend/src/pages/Projects.jsx:121-128` — listener hardcoding `'omni:transcription-added'` + inline parse → `TRANSCRIPTION_EVENT` + `loadTranscriptions()`.
- `frontend/src/pages/Projects.jsx:215` — existing `tr.id || String(Math.random())` precedent for the missing-`id` React-key edge.
- `frontend/src/ui/Dialog.jsx` (props verified, see A.5) + `frontend/src/ui/index.js:18` — the `Dialog` primitive the picker wraps (exported from `../ui`). Close fires via `onOpenChange` for X/ESC/backdrop (all when `dismissable` default true), confirmed `Dialog.jsx:29-39`. Content renders in a `RadixDialog.Portal` (`Dialog.jsx:43`).
- `frontend/src/components/DirectionDialog.jsx`, `frontend/src/components/AudioTrimmer.jsx` — reference call patterns for wrapping `Dialog`.
- `frontend/src/components/settings/ApiKeysPanel.test.jsx` — **reference test** for a Radix-`Dialog`-backed component in this harness (uses `render(...)` + `screen.getByRole`/`getByText`/`getByPlaceholderText`, `fireEvent.click`, `waitFor`; confirms Radix renders in jsdom and that dialog content is reachable via `screen`, not `container`). Mirror its structure for the picker test.
- `frontend/src/ui/Input.jsx:42-53` — `Input` `forwardRef(({ size='md', className='', ...rest }) => <input className={`ui-input ui-input--size-${size} …`} {...rest}/>)`, exported via barrel `index.js:17`. Use for the search box.
- `frontend/src/pages/AudiobookTab.jsx:3` — `lucide-react` import; **add `Mic`** (not currently imported here).
- `frontend/src/pages/AudiobookTab.jsx:21` — `text` state (import target).
- `frontend/src/pages/AudiobookTab.jsx:23` — `plan` state / `setPlan` (clear on successful import; keep on Cancel).
- `frontend/src/pages/AudiobookTab.jsx:80-95` — `onImport` (sibling pattern: `setText(r.text); setPlan(null);`).
- `frontend/src/pages/AudiobookTab.jsx:177-178` — `busy = planLoading || generating || importing` (use for `disabled`); `canRun = text.trim().length > 0 && !busy` (downstream no-op guard for empty text → justifies hiding empty-text rows).
- `frontend/src/pages/AudiobookTab.jsx:189-200` — `audiobook-tab__actions` toolbar (add the button here; Import `<label>` is at 190-193).
- `frontend/src/pages/AudiobookTab.jsx:203-214` — `audiobook-tab__script` region (inline Replace/Append/Cancel prompt lands above the `<textarea>`; the textarea has `aria-label={t('audiobook.script')}` at line 212 — **the integration test's stable selector for the script box**).
- `frontend/src/api/audiobook.ts` — **unchanged.** Reference only: `audiobookPlan`/`audiobookGenerate`/`audiobookPreviewChapter`/`audiobookUploadCover`/`audiobookImport`/`longformRender` shapes. The import path never calls any of these. **Test:** `vi.mock('../api/audiobook')` (and `vi.mock('../api/generate')`) in the AudiobookTab integration test so a stray synth-button click can't hit the network — see Test #3.
- `frontend/src/components/StoriesEditor.jsx:13` — `lucide-react` import (`Mic` already present).
- `frontend/src/components/StoriesEditor.jsx:17` — `useAppStore` from `../store` (zustand, **with `persist` middleware** — see Test #4 store-reset note).
- `frontend/src/components/StoriesEditor.jsx:144-145` — `splitText` / `splitOpen` state (import target; overwriting scratch is acceptable).
- `frontend/src/components/StoriesEditor.jsx:175-200` — `autoCast` (reused, no change; toasts `stories.autocastEmpty` when `parseScript` is empty at line 177; appends via `setTracks(prev => [...prev, ...newTracks])` at line 195).
- `frontend/src/components/StoriesEditor.jsx:202-214` — `onImportFile` (sibling pattern: `setSplitText(text)` + `setSplitOpen(true)`, overwrites scratch unconditionally — precedent).
- `frontend/src/components/StoriesEditor.jsx:236-242` — `applySplit` (reused, no change; early-returns on zero chunks at line 238; appends Narrator tracks at line 239).
- `frontend/src/components/StoriesEditor.jsx:64-88` — `splitIntoChunks` (clamps `maxChars` to `[40,2000]` at line 68, normalizes CRLF at line 66, filters empties at line 87 — returns `[]` for blank input).
- `frontend/src/components/StoriesEditor.jsx:460-473` — "Content" `stories-editor__group` toolbar (add the button; `pasteSplit` button at 464-466 is the sibling to match).
- `frontend/src/utils/parseScript.js:42-45` — `parseScript()` reused via `autoCast`; returns `[]` for empty/whitespace (`if (!src) return out;`); normalizes CRLF at line 44; no change. **Unit-tested already in `parseScript.test.js`** — the Stories integration test only needs a *light* assertion that auto-cast produced the expected cast members, not a re-test of parsing.
- `frontend/src/store/storiesSlice.ts` — `createStoriesSlice` exposing `storyTracks`/`cast`/`setStoryTracks`/`upsertCastMember` etc.; `DEFAULT_CAST` (one `narrator` member). Reset target for Test #4.
- `frontend/src/store/index.ts:54-55` — `useAppStore = create()(persist(...))`; exposes `useAppStore.setState`/`getState` (standard zustand API) **and** persists to localStorage via `persist` middleware — so Test #4 must reset store state in `beforeEach` AND `localStorage.clear()` to avoid persisted-state bleed between tests.
- `frontend/src/store/storiesSlice.test.ts:4-10` — the `harness()` pattern unit-tests the *slice factory directly* (calls `createStoriesSlice(set,get,api)` against a local object). **This does NOT reset the real `useAppStore`** — it's a pure-function test of the slice. For the StoriesEditor *integration* test (Test #4) you must reset the live store via `useAppStore.setState({ storyTracks: [], cast: [...DEFAULT_CAST] })`, not via this harness.
- `frontend/src/i18n/locales/en.json` — add the keys in **A.8**: `transcriptionPicker.{title,search_placeholder,empty,empty_search}` + `audiobook.{from_transcriptions,import_replace_prompt,import_replace,import_append,import_cancel}` + `stories.fromTranscriptions`. (Confirmed absent today; `audiobook.import`=`"Import"` at en.json:147, `stories.pasteSplit`=`"Paste & Split"` at en.json:37, `audiobook.script`=`"Script"` at en.json:115, `audiobook.plan_heading`=`"Plan — {{count}} chapter(s)"` at en.json:121 already exist; relative-time keys at en.json:982-984 reused.) This path is under `frontend/src/i18n/` → covered by the CJK-test `_ALLOWED_PREFIXES` (`test_no_hardcoded_cjk.py:40`), so the locale file is the *correct* home for these strings.
- `frontend/src/i18n/index.ts:63-65` — `partialBundledLanguages: true`, `fallbackLng: 'en'`, `interpolation: { escapeValue: false }`. Confirms missing keys in non-English locales render the English fallback → **no need to edit the other 20 locale JSONs** (see Constraints → Localization). The test setup (`src/test/setup.js:6`, `import '../i18n'`) initializes this real instance with English bundled, so test assertions can match resolved English strings.
- `frontend/src/App.jsx:1071-1082` — both tabs already mounted with `profiles` (`StoriesEditor` at line 1074, `AudiobookTab` at line 1080); the picker reads localStorage directly and takes no `profiles` prop, so **no prop wiring change in App.jsx is needed**.

## Test plan

### Harness facts (verified — drive every test below)

- **Framework / config:** vitest with `globals: true`, `environment: 'jsdom'`, `setupFiles: ['./src/test/setup.js']`, `include: ['src/**/*.test.{js,jsx,ts,tsx}']`, `css: false` (verified `frontend/vite.config.js:30-36`). npm script `test` = `vitest run` (the local + CI gate command). Use `@testing-library/react` (`render`, `screen`, `fireEvent`, `waitFor`) + `@testing-library/jest-dom/vitest` matchers (loaded by setup, `setup.js:1`).
- **i18n in tests is REAL English:** `setup.js:6` imports `../i18n`, which initializes the singleton with the English bundle and `fallbackLng: 'en'`. So `t('transcriptionPicker.title')` resolves to `"Import from Transcriptions"` *in tests* — assertions match the **resolved English string**, and a missing/typo'd key shows up as the bare key (`'transcriptionPicker.title'`) → a leakage assertion catches it (Test #2 "no i18n leakage").
- **localStorage mock (verified `setup.js:8-28`):** module-level `store` object behind `window.localStorage` with `getItem`/`setItem`/`clear`/`removeItem`. Two consequences that the tests MUST honor:
  1. **Not auto-cleared between tests** — every describe that touches the store needs `beforeEach(() => localStorage.clear())`.
  2. `getItem` is `store[key] || null`, so `setItem(KEY,'')` reads back as `null` (empty-string row asserts `[]` either way); `setItem` stringifies (`value.toString()`).
- **Radix Portal:** `Dialog` content mounts via `RadixDialog.Portal` **outside** the rendered subtree → query with `screen.*` / `findBy*`, **never** `container.querySelector`. Precedent that Radix renders in this jsdom harness: `ApiKeysPanel.test.jsx` (a `Dialog`-backed component) uses `screen.getByRole`/`getByText` successfully.
- **No existing tab tests:** there is no `AudiobookTab.test.jsx`, `StoriesEditor.test.jsx`, `Transcriptions.test.jsx`, or `Projects.test.jsx` today — all tab-integration tests below are **new files**, not extensions.

### Testing strategy — "pure first, handler-direct / leaf-mount, mock the edges" (the local-no-torch analog)

This is a **frontend-only** task, so the CLAUDE.md "don't import `main`+torch/GPU locally" rule has no *literal* Python application here (the only Python in CI is the unrelated CJK gate). But the **same discipline** maps cleanly onto the JS side and is the explicit strategy for this feature: **never mount the whole app or hit the backend to test this feature.** Concretely:

1. **Pure-module first (cheapest, most of the coverage).** `transcriptionsStore.js` is React-free and dependency-free — Test #1 imports it directly and runs the entire `loadTranscriptions` edge matrix with zero render, zero network, zero store. This is the analog of testing a pure Python helper without importing `main`.
2. **Leaf-component mount, not app mount.** Render `<TranscriptionPicker>`, `<AudiobookTab>`, `<StoriesEditor>` **in isolation** (`render(<TranscriptionPicker open onClose onPick/>)` etc.), never `<App/>`. This keeps the render tree tiny and deterministic — the analog of "handler-direct, don't pull in the world."
3. **Mock the edges (the `../api/*` modules) so no `fetch` ever fires.** The import path is local-only (A.9), so picker/store tests need **no** mocks at all. The only place a backend module is *importable into the render tree* is `AudiobookTab` (it imports `../api/audiobook` + `../api/generate` at module top) — so the AudiobookTab integration test does `vi.mock('../api/audiobook', () => ({...}))` and `vi.mock('../api/generate', () => ({...}))` up front. This makes the test hermetic (no network, no SSE, no real `Response`) — the JS analog of stubbing the GPU/engine boundary so the test exercises *our* state logic, not the engine.
4. **Reset shared state in `beforeEach`.** localStorage mock is sticky (`localStorage.clear()`); the zustand store is sticky AND persisted (`useAppStore.setState({...})` + `localStorage.clear()` for Test #4). This is the analog of "reset module/global state between cases so torch-style singletons don't leak."
5. **Don't re-test reused seams.** `parseScript`, `splitIntoChunks`, `splitSSEBuffer` are already unit-tested (`parseScript.test.js` etc.). The integration tests assert **the wiring outcome** (panel opened with the right text; tracks appended; plan cleared), not the internals of the reused functions — keeps the integration tests fast and non-brittle.

> Net: the heaviest test in this feature mounts a single leaf component with two tiny `vi.mock` factories. Nothing imports a backend server, a real engine, or torch; nothing makes a network call. The suite runs in well under a second alongside the rest of `bunx vitest run`.

### #1 — `frontend/src/utils/transcriptionsStore.test.js` (NEW, pure module)
`beforeEach(() => localStorage.clear())`. Import `{ loadTranscriptions, TRANSCRIPTIONS_KEY, TRANSCRIPTION_EVENT }` directly — no render. Assert the full A.3 matrix:
- **returns `[]` when key absent** — no `setItem` at all.
- **returns `[]` for empty-string value** — `setItem(TRANSCRIPTIONS_KEY, '')` (mock coerces to `null`; assert `[]`).
- **returns `[]` on malformed JSON and does not throw** — `setItem(TRANSCRIPTIONS_KEY, '[{')`; wrap in `expect(() => loadTranscriptions()).not.toThrow()` then assert `[]`.
- **returns `[]` for valid-but-non-array JSON** — parametrize over `'"x"'`, `'{}'`, `'5'`, `'null'` (the `Array.isArray` guard); each asserts `[]`.
- **returns the parsed array unchanged (no re-sort/de-dup)** — `setItem(TRANSCRIPTIONS_KEY, JSON.stringify([{id:3,text:'c'},{id:2,text:'b'},{id:1,text:'a'}]))` → `loadTranscriptions()` deep-equals that array in the same order.
- **returns `[]` when `localStorage.getItem` throws** — temporarily `vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); })` (private-mode analog); assert `[]`, no throw; restore.
- **backward-compat pin (CRITICAL):** `expect(TRANSCRIPTIONS_KEY).toBe('omni_transcriptions')` and `expect(TRANSCRIPTION_EVENT).toBe('omni:transcription-added')`. This single assertion is the contract lock that guards every existing producer/consumer against an accidental rename.

Concrete test names:
- `loadTranscriptions › returns [] when the key is absent`
- `loadTranscriptions › returns [] on malformed JSON without throwing`
- `loadTranscriptions › returns [] for valid-but-non-array JSON (%s)` (`it.each(['"x"','{}','5','null'])`)
- `loadTranscriptions › returns the stored array in original order`
- `loadTranscriptions › returns [] when localStorage.getItem throws`
- `transcriptionsStore › pins the storage key and event name (backward-compat)`

### #2 — `frontend/src/components/TranscriptionPicker.test.jsx` (NEW, leaf mount)
`beforeEach(() => localStorage.clear())`. Helper `seed(arr) => localStorage.setItem(TRANSCRIPTIONS_KEY, JSON.stringify(arr))`. Render `<TranscriptionPicker open onClose={onClose} onPick={onPick} />` with `onClose`/`onPick` as `vi.fn()`. Query via `screen`/`findBy` (Portal). Resolve strings via the real i18n: import `i18next` and use `i18next.t('transcriptionPicker.title')` in assertions, or assert the literal English (`"Import from Transcriptions"`).
- **closed → renders nothing:** render with `open={false}` → `expect(screen.queryByText('Import from Transcriptions')).toBeNull()`.
- **lists rows newest-first:** seed 3 entries (already newest-first, mirroring `unshift`); assert all 3 text previews render in DOM order matching the array order.
- **search filters by text and by language:** seed entries with distinct text + `language`; type in the search `Input` (`fireEvent.change`); assert only matching rows remain. Separate case: whitespace-only query (`'   '`) shows all rows.
- **search-no-match → `empty_search` (not `empty`):** seed entries, search a string matching none → assert `"No matching transcriptions"` present and `"No transcriptions yet — record one in the Transcriptions page."` absent.
- **click row → `onPick(originalEntry)` then `onClose`:** seed an entry with leading/trailing/internal whitespace in `text`; click its row; `expect(onPick).toHaveBeenCalledWith(<deep-equal of the exact seeded object>)` (asserts un-normalized, whitespace-preserving pass-through); `expect(onClose).toHaveBeenCalled()`; assert call order (onPick before onClose) via `onPick.mock.invocationCallOrder[0] < onClose.mock.invocationCallOrder[0]`.
- **keyboard-activatable row:** the row is a `<button>` (or `role="button"` + key handler); `const row = screen.getByRole('button', { name: /<text>/ })`, `row.focus()`, `fireEvent.keyDown(row, { key: 'Enter' })` (or `fireEvent.click`) → `onPick` fires.
- **empty store → `empty`:** no seed → assert `"No transcriptions yet…"` text present; the row list is empty.
- **empty-text rows hidden:** seed `[{id:1,text:''},{id:2,text:'   '},{id:3,text:'real'}]` → only the `'real'` row renders. Separate case: a store of *only* empty-text entries renders the `empty` state.
- **legacy/partial entry tolerance (A.2):** seed one entry `{ text:'hi' }` with **no `id`**, **no `timestamp`** (or `timestamp:'not-a-date'`), `language:'unknown'`, `duration_s:'oops'` (string). Assert: row renders without throwing; **no time chip** (Invalid-Date guard → no literal `"Invalid Date"` in DOM: `expect(screen.queryByText(/Invalid Date/)).toBeNull()`); **no language chip** (no `unknown` text); **no duration chip** (no `.toFixed` throw); and **no React key warning** — spy on `console.error` (`vi.spyOn(console,'error')`) and assert it wasn't called with a key warning.
- **non-array store → empty, no throw:** `seed` replaced with raw `localStorage.setItem(TRANSCRIPTIONS_KEY, '"x"')` → picker shows `empty`, does not throw.
- **no i18n leakage:** assert the resolved title equals `"Import from Transcriptions"` (NOT the bare key `"transcriptionPicker.title"`), proving the label flows through `t()`. Repeat for the empty-state string.
- **live refresh while open:** open with one seeded entry; `seed([...two entries])`; `window.dispatchEvent(new CustomEvent(TRANSCRIPTION_EVENT, { detail: {} }))`; `await waitFor(() => expect(screen.getAllByRole('button', {name:/…/}).length).toBe(2))` → new row appears.
- **listener not attached while closed:** render with `open={false}`; dispatch `TRANSCRIPTION_EVENT`; assert no throw and no state churn (e.g. still nothing rendered). Then re-render `open={true}` and confirm the listener now responds (open→close→open attach/detach via the `useEffect([open])` cleanup).

Concrete test names:
- `TranscriptionPicker › renders nothing when open is false`
- `TranscriptionPicker › lists stored transcriptions newest-first`
- `TranscriptionPicker › filters by text and by language; whitespace query shows all`
- `TranscriptionPicker › shows empty_search (not empty) when the query matches nothing`
- `TranscriptionPicker › onPick receives the original un-normalized entry, then onClose fires`
- `TranscriptionPicker › row is keyboard-activatable (Enter fires onPick)`
- `TranscriptionPicker › shows the empty state for a zero-length store`
- `TranscriptionPicker › hides empty/whitespace-text rows`
- `TranscriptionPicker › tolerates legacy/partial entries without throwing or rendering "Invalid Date"`
- `TranscriptionPicker › falls back to the empty state for a non-array store`
- `TranscriptionPicker › renders resolved English strings, never bare i18n keys`
- `TranscriptionPicker › refreshes live on the transcription-added event while open`
- `TranscriptionPicker › does not respond to the event while closed`

### #3 — `frontend/src/pages/AudiobookTab.test.jsx` (NEW, leaf mount + edge-mock)
Top of file: `vi.mock('../api/audiobook', () => ({ audiobookPlan: vi.fn(), audiobookGenerate: vi.fn(), audiobookUploadCover: vi.fn(), audiobookPreviewChapter: vi.fn(), audiobookImport: vi.fn() }))` and `vi.mock('../api/generate', () => ({ audioUrl: vi.fn() }))` — keeps the test hermetic; the import path never calls these, the mocks just prevent an accidental synth click from hitting `fetch`. `beforeEach(() => localStorage.clear())`. Render `<AudiobookTab profiles={[]} />`. Script box selector: `screen.getByLabelText('Script')` (the textarea's `aria-label={t('audiobook.script')}`). "From Transcriptions" button: `screen.getByRole('button', { name: /from transcriptions/i })`.
- **empty textarea → no prompt, fills script:** seed one transcription; click "From Transcriptions"; pick the row in the picker; assert the script textarea's `value` === the entry text AND the Replace/Append prompt (`"The script already has text…"`) is **absent**.
- **non-empty → Replace:** `fireEvent.change(textarea, { target:{ value:'existing' }})`; pick; assert the prompt appears; click `screen.getByRole('button',{name:/^replace$/i})`; assert textarea === entry text; prompt gone.
- **non-empty → Append:** as above; click `screen.getByRole('button',{name:/^append$/i})`; assert textarea === `'existing' + '\n\n' + entryText`; prompt gone.
- **non-empty → Cancel keeps text AND plan:** seed a plan first (drive a fake plan into state — easiest path: mock `audiobookPlan` to resolve a plan and click "Preview plan", then assert the `audiobook.plan_heading` "Plan — N chapter(s)" heading is present); then pick → click `screen.getByRole('button',{name:/^cancel$/i})`; assert textarea unchanged AND the plan heading **still present** (Cancel does not clear plan).
- **plan cleared on Replace/Append (empty branch too):** with a previously-set plan heading visible, do a successful import (empty branch, or Replace) → assert the `audiobook.plan_heading` heading is **gone** (`setPlan(null)`).
- **button disabled while busy:** put the tab in a busy state (e.g. make `audiobookImport` a never-resolving promise and trigger the file `<input>` so `importing` is true) → assert `screen.getByRole('button',{name:/from transcriptions/i})` has `disabled`. (Alternatively assert the simpler path: the button shares the `disabled={busy}` expression with the verified-disabled Preview/Create buttons.)
- **picker closes immediately on pick in both branches:** after a pick, assert the dialog title `"Import from Transcriptions"` is gone even while the Replace/Append prompt is showing.

Concrete test names:
- `AudiobookTab › picking into an empty script fills it with no prompt`
- `AudiobookTab › Replace overwrites the existing script and clears the plan`
- `AudiobookTab › Append joins existing + "\n\n" + imported and clears the plan`
- `AudiobookTab › Cancel leaves the script and the previewed plan untouched`
- `AudiobookTab › the From Transcriptions button is disabled while busy`
- `AudiobookTab › the picker closes immediately when a row is picked`

### #4 — `frontend/src/components/StoriesEditor.transcriptions.test.jsx` (NEW, leaf mount + store reset)
**Store reset is mandatory and store-specific:** `StoriesEditor` reads `useAppStore` (`../store`), a zustand store created with `persist` middleware (`store/index.ts:54-55`) that writes to localStorage. So `beforeEach` must do **both**: `localStorage.clear()` AND `useAppStore.setState({ storyTracks: [], cast: [...DEFAULT_CAST] })` (reset the live store — the `storiesSlice.test.ts` `harness()` does NOT do this; it tests the slice factory in isolation). Import `DEFAULT_CAST` from `../store/storiesSlice` (or read it once and re-seed). Assert track/cast outcomes by reading `useAppStore.getState().storyTracks` / `.cast` after actions (light assertions — parsing itself is covered by `parseScript.test.js`).
- **pick → split panel opens pre-filled:** seed a transcription; click "From Transcriptions" (`screen.getByRole('button',{name:/from transcriptions/i})`); pick; assert the split panel's textarea (`splitText`) === the entry text and the picker dialog is gone.
- **overwrites scratch:** open the split panel and type scratch into `splitText` first, then pick → assert `splitText` === the new entry text (overwrite confirmed; matches `onImportFile` precedent).
- **Paste & Split appends Narrator tracks:** after the panel is pre-filled, click "Paste & Split" (`screen.getByRole('button',{name:/paste & split/i})`) → `expect(useAppStore.getState().storyTracks.length).toBeGreaterThan(0)`, all `character === 'narrator'`. Pick + split a *second* time → assert track count increased again (append/stack, no de-dup).
- **Auto-cast on screenplay text → multi-speaker cast:** seed `text: 'FOX: hi\nOWL: bye'`; pick; click "Auto-cast"; assert `useAppStore.getState().cast` contains members for `fox` and `owl` (case-insensitive id check — light assertion; `parseScript` correctness lives in `parseScript.test.js`).
- **Auto-cast on prose → narrator-only, no error toast:** seed a plain prose `text`; pick; Auto-cast; assert cast is just `narrator` + N narrator tracks, and `stories.autocastEmpty` toast text was **not** rendered (`expect(screen.queryByText(/nothing to auto-cast/i)).toBeNull()`).

Concrete test names:
- `StoriesEditor (transcriptions) › picking opens the split panel pre-filled`
- `StoriesEditor (transcriptions) › picking overwrites un-applied scratch split text`
- `StoriesEditor (transcriptions) › Paste & Split appends Narrator tracks (stacks on repeat)`
- `StoriesEditor (transcriptions) › Auto-cast on screenplay text builds a multi-speaker cast`
- `StoriesEditor (transcriptions) › Auto-cast on prose yields narrator-only lines with no error`

### #5 — No-regression (refactor safety net)
- **`Transcriptions.jsx` still loads/saves after the refactor:** smoke render `<TranscriptionsPage />` (`beforeEach(() => localStorage.clear())`), assert the `transcriptions.title` heading renders; seed one entry (`localStorage.setItem(TRANSCRIPTIONS_KEY, JSON.stringify([{id:1,text:'kept',language:'en',duration_s:1,timestamp:new Date().toISOString()}]))`) before render → assert the entry text lists. (New file `Transcriptions.test.jsx`, or fold into #1's describe if kept small.)
- **`Projects.jsx` transcription tiles render from the shared reader:** smoke render `<Projects />` with whatever minimal props it needs (`studioProjects=[]`, etc.) and a seeded transcription → assert the transcripts tile appears. (New file `Projects.test.jsx`.)
- **Refactor literal-grep guard (acceptance check, can be a CI step or a manual gate):** `grep -rn "omni_transcriptions\|omni:transcription-added" frontend/src` shows the literals **only** in `transcriptionsStore.js` (and may legitimately appear in the new `transcriptionsStore.test.js` — exclude `*.test.*` from the grep or assert "only in `transcriptionsStore.js`"). This proves the de-dup actually happened and no fourth copy crept in.

### Local + CI gates (which apply to this PR)
- **Frontend gate (the load-bearing one for this task) — `bunx vitest run` in `frontend/`** (npm script `test`): must pass with the four new test files + the no-regression smokes. This is the per-MEMORY merge-discipline local loop, and it is the CI gate that actually exercises this feature. Run it locally before pushing; do not merge before it's green in CI.
- **ESLint — `bun run lint`** on changed files: the new `.jsx`/`.js` must be lint-clean (no unused imports — e.g. don't import an unused `X`; hooks deps correct on the `useEffect([open])`).
- **Python CJK gate — `tests/test_no_hardcoded_cjk.py`** (CI): applies because new source files are added. It must stay green for free — `TranscriptionPicker.jsx` and `transcriptionsStore.js` are **not** in `_ALLOWED_FILES` and must contain **zero hardcoded UI literals and zero CJK** (all strings via `t()`); the new `*.test.*` files are auto-allowed by the `.test.` rule (`test_no_hardcoded_cjk.py:90`). No new functional CJK is added, so no allowlist edit is needed.
- **CodeQL `py/polynomial-redos`** (CI): trivially satisfied — this PR adds **no Python and no `RegExp`**; the picker search uses `String.prototype.includes`. Nothing reachable from user input constructs a regex (consistent with the CodeQL-ReDoS memory). Do not "optimize" search into a `RegExp`.
- **No backend pytest involvement:** there is **no Python test for this feature** and nothing here imports `main`/torch/an engine. The local pytest-segfault concern (torch/Triton) from MEMORY is **not in scope** — this is a frontend-only change, validated entirely by `vitest`. (Confirming the local-no-torch posture: the heaviest test mounts a single React leaf with two `vi.mock` factories; no engine, no GPU, no backend process.)
- **Docs-only?** No — this PR has code, so it is **not** a docs-only PR (full `gh pr checks` watch per MEMORY merge-discipline applies; do not merge before green). The README one-liner (docs-sync) rides along in the same PR.

## Constraints

This feature ships in **default mode** (a visible toolbar button in two tabs, no opt-in toggle). Each relevant OmniVoice hard rule and how it's satisfied:

- **Cross-platform parity (strict, default-feature rule, 2026-05-20):** A default feature must behave **identically on macOS / Windows / Linux**. This one does, by construction: it is pure browser-side React + `localStorage` + the existing Radix `Dialog` — **no OS APIs, no shell, no `path`/`fs`, no Tauri command, no native picker**. The Radix Dialog supplies focus-trap/ESC/scroll-lock/close uniformly across webviews; the row buttons are keyboard-activatable on every platform. The only line touching newline semantics — the Append join `text + '\n\n' + incoming` — uses **LF**, and the downstream parsers (`parseScript` `.replace(/\r\n/g,'\n')` at `parseScript.js:44`, `splitIntoChunks` at `StoriesEditor.jsx:66`) normalize `\r\n`→`\n` first, so Windows-pasted CRLF text behaves the same. The inline Replace/Append/Cancel prompt is i18n-driven inline state (deliberately **not** `window.confirm`, whose chrome/wording varies by OS). There is **no platform-only code path and no opt-in needed** → no P0 parity risk. (Tested platform-independently: vitest+jsdom runs the same on every CI OS; the Append-LF/CRLF-safety is covered by the `'existing' + '\n\n' + entryText` assertion in Test #3.)
- **Local-first guarantee:** **No network call, no account, no API key, no telemetry** is added. The picker reads `localStorage` only; `onPickTranscription` mutates React state only (`setText`/`setPlan`/`setSplitText`/`setSplitOpen`/`setPendingImport`/`setPickerOpen`). The import path never calls the backend (the existing `onCreate`/`onPreview` calls to `../api/*` are unchanged and unrelated to importing — see A.9). The app remains fully functional with or without this feature touched. No third-party endpoint, no opt-in reporting surface. (Tested: picker/store tests need **no** network mock at all; the AudiobookTab test's `vi.mock('../api/*')` is purely defensive against a stray synth-button click, and the test asserts the import path never invokes those mocks.)
- **Backward-compatible data:** The `localStorage['omni_transcriptions']` **key, entry shape (A.1), and 200-entry cap are unchanged** — the shared-reader test pins the key + event strings (`transcriptionsStore.test.js`, Test #1). The picker is **read-only over existing data** and tolerates legacy/partial/cross-version entries via per-row normalization at read time (A.2 — never a write-back rewrite). No alembic migration is involved because this is client-side `localStorage`, not the server-side `omnivoice_data/` SQLite DB the alembic rule governs; the corresponding client-side discipline — *lazy tolerance of older/missing fields* — is satisfied by the Defensive read in Component B and asserted by Test #2's "legacy/partial entry tolerance" case. No migration step, no data loss path.
- **CodeQL `py/polynomial-redos` (regex on user input):** The picker's search — the only place that processes a user-typed string against stored content — uses `String.prototype.includes` (substring), **not a constructed `RegExp`**. There is no polynomial-regex-on-user-input surface to flag. (The CodeQL ReDoS gate primarily targets backend Python; this task adds **no** Python and no regex. The reused `parseScript`/`splitIntoChunks` regexes are pre-existing and out of scope — this task does not author or alter them.) **Do not** "optimize" search into a `RegExp` — that would introduce exactly the surface the rule guards against. Consistent with the CodeQL-ReDoS memory.
- **Localization (hard rule):** Every new user-facing string goes through `t('...')` against `frontend/src/i18n/locales/en.json`; no hardcoded English/CJK literals in JSX. New `TranscriptionPicker.jsx` and `transcriptionsStore.js` are **not** in the CJK allowlist and must stay CJK-/literal-free; `StoriesEditor.jsx` *is* allowlisted (line 56) for *functional* CJK, but that does not license a new hardcoded label there — the button still uses `t('stories.fromTranscriptions')`. **New keys (English only) — exact set in A.8:** `transcriptionPicker.{title, search_placeholder, empty, empty_search}`, `audiobook.{from_transcriptions, import_replace_prompt, import_replace, import_append, import_cancel}`, `stories.fromTranscriptions`. **Reuse** existing `transcriptions.{just_now, m_ago, h_ago}` for relative time (`{{count}}` interpolation, not plural-suffixed) — do not duplicate. **Do not edit the other 20 locale JSONs:** verified there is **no locale-parity workflow** in `.github/workflows/` and no locale-fill script in `frontend/package.json`; the non-English locales are lazy-loaded with `partialBundledLanguages: true` + `fallbackLng: 'en'` (`index.ts:63-64`), so missing keys render the English fallback. The CJK CI gate (`tests/test_no_hardcoded_cjk.py`) checks only for *hardcoded CJK outside the i18n layer* — it does **not** enforce key presence across locales. Add the English keys only. (Tested: Test #2's "no i18n leakage" case asserts rendered text equals the resolved English string, catching any missing/typo'd key — since the test i18n is the real English bundle.)
- **Versioning (continuous-to-main, no RC):** No version bump and no RC. This is a single additive change that goes continuous-to-main; the owner cuts a `v0.3.Z` patch from main whenever worth it. The version files (`tauri.conf.json`, `Cargo.toml`, `pyproject.toml`) are **not** touched by this PR — they already read the next-patch number per the versioning rule. No `-rc` tag, no minor/major bump, no "defer to v0.4" — this is absorbed into the open v0.3.x line.
- **Docs-sync (hard rule):** README lists "📖 Audiobook Editor — chapter-aware long-form narration" (README.md:310) and a Dictation Widget (README.md:76) but mentions no Transcriptions→longform bridge. **Decision (explicit, not deferred):** add a one-line mention of the "From Transcriptions" import near the Audiobook/Stories feature entry in README.md **in the same PR**, since it's a user-visible feature worth listing. No other doc (CONTRIBUTING/SECURITY/SUPPORT/`docs/**`) describes behavior this change alters, so no further doc edits are required.
- **GSD workflow:** start via `/gsd-quick` (small, additive feature) before editing files, per CLAUDE.md.

## Dependencies

- None new. Uses existing `react`, `react-i18next`, `react-hot-toast`, `lucide-react`, and `../ui` (`Button`, `Dialog`, optionally `Input`) — `@radix-ui/react-dialog` is already a pinned dependency (`frontend/package.json`, `^1.1.15`). All already imported across these files. Test deps (`vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`) are already configured (`vite.config.js`, `src/test/setup.js`). (No new runtime dep keeps the local-first / cross-platform surface unchanged.)
- Depends on the existing transcription writer (`Transcriptions.jsx addTranscription`, exported at line 30) being unchanged — it is the only producer of the store.
- Loosely related (not blocking): #22 shared `<VoiceSelector>` and #27 longform-parser unification touch the same files but don't gate this. Coordinate merge order to minimize conflicts in `StoriesEditor.jsx` toolbar (`stories-editor__group` at lines 460-473) / `AudiobookTab.jsx` actions (lines 189-200) if those land first.

## Risk

- **Low overall.** Additive, client-only, reuses existing tested seams (`applySplit`, `autoCast`, `parseScript`, `setText`, `Dialog`).
- **Cross-platform parity risk (none):** no OS-specific code, no opt-in branch; default behavior is identical on all three platforms (browser-only; Append uses LF and downstream parsers normalize CRLF; inline prompt instead of `window.confirm`). No P0.
- **Merge conflict risk (medium):** `StoriesEditor.jsx` and `AudiobookTab.jsx` are hot files (tasks #22, #25, #27 all touch them). Mitigate by keeping the picker self-contained and the per-tab diffs tiny (one icon import (Audiobook only) + one/two state hooks + one button + one handler + one render line each).
- **UX risk (low):** silently overwriting a half-written audiobook script would be bad → mitigated by the Replace/Append/Cancel inline prompt (covered by Test #3). Stories routes through the split panel (non-destructive to durable state — `applySplit`/`autoCast` *append* tracks via `setTracks((prev) => [...prev, ...])`; only the scratch `splitText` is overwritten, matching `onImportFile`), so no clobber of real work there (covered by Test #4 "overwrites scratch").
- **Portal/test risk (low):** the picker's content lives in a Radix Portal; tests must query via `screen`, not `container` (called out in the Harness facts; `ApiKeysPanel.test.jsx` is the working precedent).
- **Store-state-bleed test risk (low, called out):** the zustand store has `persist` middleware; the Stories integration test (#4) must reset BOTH the live store (`useAppStore.setState`) and `localStorage.clear()` in `beforeEach`, and must NOT rely on the `storiesSlice.test.ts` `harness()` (which tests the slice factory, not the live store).
- **Bad-data / backward-compat risk (low, explicitly handled + tested):** legacy/hand-edited/cross-version entries with missing or wrong-typed fields are normalized per row at read time (id→index key, text→String, timestamp→Invalid-Date guard returning `null`, duration→`typeof` guard, language→`'unknown'` filter) — never rewritten back. A non-array or malformed store value resolves to `[]` → empty state. No throw path remains. (Covered by Test #1's matrix and Test #2's "legacy/partial entry tolerance".)
- **Empty `text` edge:** transcriptions with empty/whitespace `text` are **hidden** in the picker (they would no-op downstream: `AudiobookTab.canRun` line 178 requires non-empty trimmed text; Stories `applySplit` early-returns on zero chunks; `autoCast` toasts `stories.autocastEmpty` line 177). The `onPickTranscription` handlers additionally no-op defensively if handed an empty-text entry. If *all* entries are empty-text, the picker shows the same empty state as an empty store. (Covered by Test #2 "hides empty/whitespace-text rows".)
- **ReDoS / CodeQL (none):** search uses plain `String.includes` substring matching, not `RegExp` — no polynomial-regex surface (consistent with the CodeQL `py/polynomial-redos` memory). No Python added. Do not refactor search to a constructed `RegExp`.
- **i18n drift risk (low):** English keys added to `en.json`; other 20 locales fall back to English (no locale-parity CI gate exists). Relative-time keys reused, not duplicated. New picker file is CJK-clean (not allowlisted) → CJK CI gate stays green. The "no i18n leakage" test catches a missing/typo'd new key.

## PR slices

Single PR is reasonable (small), but if split:

1. **Slice 1 — shared reader refactor (no behavior change for valid arrays):** add `frontend/src/utils/transcriptionsStore.js` (exact API in A.3, with the `Array.isArray` superset guard) + `transcriptionsStore.test.js` (Test #1); refactor `Transcriptions.jsx` and `Projects.jsx` to import the key/event/reader; add the #5 no-regression smokes. Green on its own; the literal-grep guard passes; the key/event-string pin test locks the backward-compatible localStorage contract.
2. **Slice 2 — picker component:** `frontend/src/components/TranscriptionPicker.jsx` (prop contract A.4, wrapping `ui/Dialog` A.5, with per-row normalization A.2, empty-text hiding, empty vs empty-search states, keyboard-activatable rows, open-gated read+listener, all-`t()` strings) + optional `TranscriptionPicker.css` + `TranscriptionPicker.test.jsx` (Test #2). Not yet wired anywhere. CJK gate stays green (new file, no CJK/literals).
3. **Slice 3 — wire both tabs + `en.json` keys (A.8, English only) + tab integration tests (#3, #4) + README one-liner (docs-sync).** Audiobook gets the Replace/Append/Cancel prompt (state shapes A.6); Stories routes to the split panel (A.7).

If shipped as one PR, land it in that internal order to keep each commit independently green (`bunx vitest run` passes after each slice).

## Acceptance criteria

- [ ] `frontend/src/utils/transcriptionsStore.js` exports exactly `TRANSCRIPTIONS_KEY` (`'omni_transcriptions'`), `TRANSCRIPTION_EVENT` (`'omni:transcription-added'`), and `loadTranscriptions(): Array<object>` (A.3); it is the only place that references those two literals; `Transcriptions.jsx` and `Projects.jsx` import from it (`grep -rn "omni_transcriptions\|omni:transcription-added" frontend/src` shows the literals only in the util, modulo the util's own `.test.` file). The key + event strings are pinned by a test (backward-compat contract — Test #1).
- [ ] `loadTranscriptions()` returns `[]` (never throws) for: absent key, empty string, malformed JSON, valid-but-non-array JSON, and a throwing `localStorage`; returns the stored array unchanged (no re-sort/de-dup) otherwise (full matrix per A.3, asserted by Test #1).
- [ ] `<TranscriptionPicker>` matches the prop contract in A.4 (`open`, `onClose`, `onPick(entry)`), wraps `ui/Dialog` (A.5) with `size="md"` and `title={t('transcriptionPicker.title')}`, passes the **original un-normalized** entry to `onPick`, and takes no other props (asserted by Test #2 "onPick receives the original un-normalized entry").
- [ ] In the Audiobook tab, a "From Transcriptions" control (in `audiobook-tab__actions`, disabled while `busy`) opens a picker listing past transcriptions newest-first, searchable; selecting one resolves per the A.6 table — fills the script `<textarea>` (empty case, no prompt) or prompts Replace/Append/Cancel (non-empty case). Replace/Append clear any previewed plan (`setPlan(null)`); Cancel changes nothing (text and plan preserved). The picker closes immediately on pick in both branches. (All six branches asserted by Test #3.)
- [ ] In the Stories editor, a "From Transcriptions" control (in the "Content" toolbar group) opens the same picker; selecting one runs the A.7 handler — opens the Paste & auto-split panel pre-filled with the text (overwriting only un-applied scratch), from which existing **Paste & Split** (`applySplit`, appends Narrator tracks) and **Auto-cast** (`autoCast`, appends cast + lines via `parseScript`) both work end-to-end; auto-cast on screenplay-shaped text produces a multi-speaker cast, on prose produces narrator-only lines (no error). (Asserted by Test #4.)
- [ ] Empty transcription history — or a history where every entry has empty/whitespace text — shows `transcriptionPicker.empty`; a search matching nothing shows `transcriptionPicker.empty_search`. (Asserted by Test #2.)
- [ ] The picker tolerates legacy/partial/wrong-typed entries per A.2: missing `id` (key falls back to index, no React key warning), unparseable/missing `timestamp` (`formatTime` returns `null`, no "Invalid Date" rendered), `language: 'unknown'`/missing (no chip), non-numeric/zero `duration_s` (no chip); empty-text rows are hidden. (Backward-compatible data: legacy/cross-version shapes load and display without rewrite — asserted by Test #2 "legacy/partial entry tolerance".)
- [ ] The picker wraps `ui/Dialog` (no hand-rolled overlay/backdrop); it gets focus-trap/ESC/scroll-lock/close-button for free, closes via X/ESC/backdrop, and rows are keyboard-activatable. The list is read fresh on open and refreshes live via `TRANSCRIPTION_EVENT` while open (listener attached only while open). (Live-refresh + closed-listener cases asserted by Test #2.)
- [ ] **Cross-platform parity:** the feature is default (no opt-in) and behaves identically on macOS/Windows/Linux — browser-only, no OS APIs, Append uses LF, parsers normalize CRLF, inline i18n prompt (not `window.confirm`). No platform-specific code path. (The LF-Append seam is asserted by Test #3's Append case; jsdom/vitest run identically on all CI OSes.)
- [ ] **Local-first:** no backend/API/DB change (A.9); no new runtime dependency; no network call; no account/key/telemetry. (Picker/store tests use no network mock; the AudiobookTab test mocks `../api/*` only defensively and the import path never calls them.)
- [ ] **Localization:** all new strings are the exact i18n keys in A.8, present in `en.json`; relative-time reuses existing `transcriptions.*` keys; no hardcoded user-facing English in JSX, no CJK outside `frontend/src/i18n/`. New `TranscriptionPicker.jsx`/`transcriptionsStore.js` are CJK-/literal-free (not allowlisted). The other 20 locale files are NOT edited (fallback covers them; no CI locale-parity gate exists). The CJK CI gate (`tests/test_no_hardcoded_cjk.py`) passes; Test #2's "no i18n leakage" assertion proves the labels flow through `t()`.
- [ ] **CodeQL ReDoS:** search uses substring matching (`String.includes`, no `RegExp`) — no `py/polynomial-redos` surface; no Python or regex added.
- [ ] **Versioning / docs-sync:** no version-file bump (continuous-to-main, no RC); README gets a one-line mention of the Transcriptions import near the Audiobook/Stories feature entry in the same PR.
- [ ] **Test gates:** `bunx vitest run` passes (incl. the four new test files #1–#4 + the #5 no-regression smokes, covering the edge matrices above); `bun run lint` (eslint) clean on changed files; the Python CJK gate stays green; `gh pr checks` all green before merge (not a docs-only PR).
- [ ] Existing Transcriptions and Projects behavior unchanged after the refactor (smoke tests #5 pass; literal-grep guard confirms single source of the storage literals).
