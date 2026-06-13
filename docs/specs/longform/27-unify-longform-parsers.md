# TASK #27 — Unify the 3 longform parsers (kill client/server/SSML drift)

## TL;DR

The longform marker dialect (`# heading`, `[voice:NAME]`, `[pause …]`, `[slow]/[fast]/[emphasis]/[spell]`) is parsed by **three independent code paths** that already disagree:

- **Client** `parseStoryText` (`frontend/src/utils/storyTokens.js:25`) + `storyToSpans` (`frontend/src/utils/storyToSpans.js:21`) + `ssmlLite.js` (`parseSsmlLite`, `spellOut`) — used by the Stories Editor preview/highlight (`StoriesEditor.jsx:307`) and the `/longform/render` plan compile (`StoriesEditor.jsx:363`).
- **Server** `parse_audiobook_script` / `_parse_spans` (`backend/services/audiobook.py:135` / `:93`) + `parse_pause_markers` (`omnivoice/utils/text.py:253`) + `ssml_lite.py` (`parse_ssml_lite`, `spell_out`) — used by `/audiobook`, `/audiobook/plan`, `/audiobook/preview`, `/audiobook/import` (router call sites `backend/api/routers/audiobook.py:82,121,321,480`).
- A **third, partial** dialect baked into the client regexes that is *narrower than* the server's. Concretely `storyTokens.js:23` `TOKEN_RE` is one combined alternation `\[(?:pause\s+(\d+(?:\.\d+)?)\s*s?|voice:\s*([^\]]+))\]` — its pause branch accepts only `[pause Ns]` (optional `s`), so `[pause 500ms]` and bare `[pause]` don't match the marker at all and fall through as literal text.

This spec introduces a single canonical pure parser, **`parse_script_to_spans`** (Python, in a new `backend/services/longform_parser.py`), that `parse_audiobook_script` builds on, plus a **mechanically-mirrored JS port** (`frontend/src/utils/longformParser.js`) that the Stories Editor's `storyToSpans`/`parseStoryText` use. A **cross-impl golden-fixture test** (one JSON corpus, asserted byte-for-byte against both impls) makes drift a CI failure. ReDoS-safe regexes only; CodeQL `security-and-quality` (`py/polynomial-redos` + `js/redos`) stays green.

The confirmed drifts to fix (verified against current code):

| Dimension | Client today | Server today | Canonical |
|---|---|---|---|
| Chapter heading | `^#{1,6}\s+` (H1–H6) — `storyExport.js:64` `isChapterLine` | `^[ \t]*#[ \t]+(\S.*)$` (H1 only) — `audiobook.py:36` `_HEADING_RE` | **H1 only** (`# `) — H2–H6 narrate as body |
| Pause units | `[pause Ns]` only — `storyTokens.js:23` `TOKEN_RE` pause branch | `[pause]`, `[pause Nms]`, `[pause Ns]`, `[pause N.Ns]` — `text.py:233` `_PAUSE_RE` | **all four** |
| `[voice:]` content | `voice:\s*([^\]]+)` (≥1 char, allows `[`) — `storyTokens.js:23`; **empty `[voice:]` doesn't match → spoken literally** | `\[voice:([^\]\[]*)\]` (allows empty, forbids `[`) — `audiobook.py:42` `_VOICE_RE` | **`[^\]\[]*`**, empty/whitespace → default |
| SSML-lite | `ssmlLite.js` (`parseSsmlLite`/`spellOut`) | `ssml_lite.py` (`parse_ssml_lite`/`spell_out`) | one shared contract, two ports |
| Span layering | `storyToSpans.js:35-50` (over `parseStoryText`) | `audiobook.py:_parse_spans:93-132` | one algorithm, two ports |

---

## Problem

There are two full reimplementations of the same grammar plus a regex-level third dialect, and they already produce **different span plans for the same script**. Concretely, from reading the code:

1. **Chapter-heading drift** — `frontend/src/utils/storyExport.js:64` `isChapterLine` matches `/^#{1,6}\s+/` (after `.trim()`), so a track whose text is `## Part Two` opens a *new chapter* in the Stories Editor. `backend/services/audiobook.py:36` `_HEADING_RE = re.compile(r"^[ \t]*#[ \t]+(\S.*)$", re.MULTILINE)` matches only H1, so the same `## Part Two` is *narrated as body text* on the server. A story that previewed with 5 chapters can render with 2. This also means client-side cue sheets (`storyExport.js:95` `buildCueSheet`) and server FFMETADATA `[CHAPTER]` blocks (built by `services.longform_render.build_ffmetadata`, aliased at `audiobook.py:223` `build_chapter_ffmetadata`) disagree.

2. **Pause-dialect drift** — `frontend/src/utils/storyTokens.js:23` `TOKEN_RE` pause branch is `pause\s+(\d+(?:\.\d+)?)\s*s?`, which accepts `[pause 0.5s]` / `[pause 0.5]` but **does not match** `[pause 500ms]` or bare `[pause]` — those fall through as literal text in a chunk and get spoken. `omnivoice/utils/text.py:233` `_PAUSE_RE = re.compile(r"\[\s*pause(?>\s+(\d+(?:\.\d+)?)\s*(ms|s)?)?\s*\]", re.IGNORECASE)` accepts all forms (bare → `PAUSE_DEFAULT_MS = 350`, `text.py:226`). A user who types `[pause 300ms]` (a documented audiobook form per `text.py:223`, issue #276) gets it *narrated aloud* in Stories but *honored as silence* in the audiobook.

3. **`[voice:]` content-class drift** — the client voice branch `voice:\s*([^\]]+)` requires ≥1 char and permits `[` inside; the server `audiobook.py:42` `_VOICE_RE = \[voice:([^\]\[]*)\]` allows the empty form `[voice:]` (→ revert to default) and forbids `[`. Note the client *already* maps an *empty-after-trim* captured id to default (`storyTokens.js:45`: `(id === 'default' || id === '') ? defaultProfileId : id`), but because the regex needs ≥1 char, the literal text `[voice:]` never matches the marker and is **spoken as `[voice:]`** rather than reverting the voice. Edge inputs resolve differently across the two impls.

4. **Duplicate SSML-lite + duplicate span layering** — `backend/services/ssml_lite.py` ↔ `frontend/src/utils/ssmlLite.js` and `audiobook.py:_parse_spans` ↔ `storyToSpans.js` are hand-kept "in sync" (the `ssmlLite.js:2` header literally says "keep in sync with backend/services/ssml_lite.py"). Each future tweak risks one side drifting. There is **no test that compares the two impls** — `tests/test_ssml_lite.py` and `frontend/src/test/ssmlLite.test.js` test each side independently against hand-written expectations (the vitest suite's `describe` is even titled "client port — parity with ssml_lite.py", `ssmlLite.test.js:4`), so a divergence passes both suites.

5. **Two structurally different chapter-split models, not just two regexes.** This is the deepest asymmetry and the spec must not gloss it: the **server** parses a single multi-line text blob and finds chapter boundaries with a *multiline regex* over the whole string (`audiobook.py:142` `_HEADING_RE.finditer(text)`); the **client** never sees one blob — `storyToSpans` iterates an array of *per-line track objects* (`{text, character, profileId, speed}`) and treats a whole track as a chapter heading when `isChapterLine(tk.text)` is true (`storyToSpans.js:28`). So the client's "chapter boundary" is a *track* boundary, while the server's is a *line-within-text* boundary. The unification must therefore (a) make the JS `parseScriptToSpans` operate on the same single-blob contract as Python, and (b) keep `storyToSpans` as the adapter that joins per-line tracks into the canonical input — see "Speed plumbing & the track→blob adapter" below.

6. **No single source of marker precedence.** Both sides implement the same intended order (`# chapter` → `[voice:]` → `[pause]` → SSML-lite → `[spell]`) but in separately-evolving code (`audiobook.py:99-132` vs `storyToSpans.js:35-50`).

---

## Goal / Non-goals

### Goals
- One canonical Python parser `parse_script_to_spans(text, *, default_voice, default_speed) -> list[ChapterDict]` that is the **single source of grammar truth** server-side, consumed by `parse_audiobook_script` (the four router call sites flow through it). The `/longform/render` endpoint consumes a *pre-built* plan and is reconciled only via the shared span-keep rule (see below) — it does not call the parser itself.
- One JS port `parseScriptToSpans` whose output is **byte-identical** to the Python parser for the shared golden corpus.
- A **cross-impl golden-fixture test**: a JSON corpus of `{name, input, default_voice, default_speed, expected}` cases, asserted in *both* `tests/` (pytest) and `frontend/src/test/` (vitest) against the same expected output. CI fails on any divergence in either suite.
- Reconcile the dialect drifts above to the **canonical column** in the TL;DR table (H1-only chapters, full pause units, `[^\]\[]*` voice class).
- All regexes remain ReDoS-safe; CodeQL `security-and-quality` (`py/polynomial-redos`, `js/redos`) passes with no new alerts.

### Non-goals
- **No new markers / no grammar features.** This is a consolidation, not a feature. (SSML expansion, new tags = separate task.)
- **No engine/synth changes.** `synthesize_chapter` (`audiobook.py:163`, signature `synthesize_chapter(spans, synth, sample_rate, *, crossfade_ms=50, lexicon=None)` where `synth: Callable[[str, Optional[str], Optional[float]], object]` reads `span.text`, `span.voice_id`, `span.speed`, `span.pause_ms_after`), `services.chunked_tts.split_text_into_chunks`/`concatenate_audio_chunks`, the `longform_render` ffmpeg/mux core (`backend/services/longform_render.py`) are untouched.
- **No DB/schema change**, no `omnivoice_data/` migration. Scripts are free-text; nothing persisted changes shape. **(See "DB schema & migration" below for the explicit no-op confirmation a reviewer can check.)**
- **No UI redesign.** `StoriesEditor.jsx` keeps its current preview/highlight behavior; only the parser it calls changes.
- **No EPUB/plaintext-import grammar change** — `backend/services/longform_import.py` only *produces* `# Heading` + body and stays as is; it already targets the canonical H1-only grammar (`longform_import.py:26` `_H1_RE = re.compile(r"^[ \t]*#[ \t]+\S", re.MULTILINE)`, `chapterize_plaintext:34` no-ops when H1 already present).
- **No new i18n keys / no UI-string churn.** Marker keywords are functional grammar, not user-facing copy (see Constraints → Localization). This task touches zero `locales/*.json` and zero `t('…')` keys.
- **No request/response wire-shape change.** The four Pydantic request models (`AudiobookPlanRequest`, `AudiobookPreviewRequest`, `AudiobookRequest`, `LongformRenderRequest`) and the three response shapes (`AudiobookPlan.to_dict()`, the `/audiobook/preview` dict, the `/audiobook` & `/longform/render` SSE event stream) are **byte-for-byte unchanged** — pinned exactly below. This task changes only which span plan those shapes carry, not the shapes themselves.

---

## Design

### Canonical contract (one document, two implementations)

A **chapter** is a dict `{ "title": str, "spans": [SpanDict, …] }`. A **span** is `{ "voice_id": str|None, "text": str, "pause_ms_after": int, "speed": float|None }` — exactly the shape the `Span` dataclass (`audiobook.py:45-60`, with `to_dict()` at `:58`) and the `LongformSpan`/`LongformChapter` Pydantic models (`backend/api/routers/audiobook.py:493-502`) already use. **Key order matters for the JSON corpus's byte-level equality** — both ports must emit the dict with keys in the order `voice_id`, `text`, `pause_ms_after`, `speed` (matching `Span.to_dict()` at `audiobook.py:59-60`). Pytest's `==` and vitest's `toEqual`/`deepEqual` are order-insensitive for dicts, so key order does **not** break the assertion; it only matters if a future test serializes to JSON-string and string-compares — note it, don't enforce it.

`parse_script_to_spans(text, *, default_voice=None, default_speed=None)` returns an ordered `list[chapter]`. Grammar, in strict precedence (outer→inner), unchanged in intent from today but now defined once:

1. **Chapter split** — a line matching `^[ \t]*#[ \t]+(\S.*)$` (multiline) opens a chapter; its title is the captured text, stripped. Text before the first heading becomes an untitled lead-in chapter (titled `Chapter N` if it has renderable spans). **H1 only** — `##`…`######` are body text. This is the server's current `_HEADING_RE` (`audiobook.py:36`); the client narrows from H1–H6 to H1.
2. **Voice split** — within a chapter body, `\[voice:([^\]\[]*)\]` switches the active narrator for following text; empty/whitespace name → `default_voice`. (server's current `_VOICE_RE`, `audiobook.py:42`; the empty-→default behavior matches `_parse_spans:102` `cur_voice = (m.group(1).strip() or default_voice)`.)
3. **Pause split** — within a voice run, `parse_pause_markers`'s dialect (`text.py:253`): `[pause]` (→ `PAUSE_DEFAULT_MS` = 350 ms), `[pause Nms]`, `[pause Ns]`, `[pause N.Ns]`, clamped to `PAUSE_MAX_MS` = 10 000 ms. Trailing pause attaches to the last SSML segment of the run; a leading/standalone pause becomes a silent span (`text=""`); adjacent pauses merge their durations (`text.py:282-284`).
4. **SSML-lite** — within pause-split text, `parse_ssml_lite` (`ssml_lite.py:87`) segments `[slow]/[fast]/[emphasis]/[spell]` (innermost-wins, unclosed-to-EOL, stray-close-ignored, adjacent-identical-merge). `[spell]` runs are `spell_out`-spaced (`ssml_lite.py:142`).
5. **Speed** — per-line speed (Stories' slider) rides as the span default; an inline SSML speed (`[fast]` etc.) overrides it for that segment. This is the only piece the **Python `_parse_spans` does not know about** today (it never takes a per-line speed; speed only arrives pre-resolved on `LongformSpan.speed`) — see "Speed plumbing" below.

The **Python `parse_script_to_spans` becomes the home** of the layering currently in `audiobook.py:_parse_spans` (lines 93–132) + the chapter split in `parse_audiobook_script` (lines 142–159). `parse_audiobook_script` becomes a thin wrapper that calls it and wraps the dicts in the `AudiobookPlan`/`Chapter`/`Span` dataclasses (preserving its current public return type and all four existing router call sites).

### Edge cases & failure paths — the exhaustive enumeration (COMPLETENESS)

Every state the parser must handle, drawn from a verified read of all five impls. **Each row is a fixture case** (see Test plan). Behaviors marked **[verified]** were run against the actual `re`/JS engine; **[invariant]** is a property the two ports must preserve identically.

#### A. Input-level / whole-document states
- **Empty input** (`""`) → `[]`. **[invariant]** (`parse_audiobook_script:141` coerces `None`→`""`; `parse_pause_markers:270` short-circuits; `parse_ssml_lite:93` returns `[]`).
- **`None` input** (Python only — JS callers always pass a string) → `parse_audiobook_script` coerces `text or ""` (`audiobook.py:141`); `parse_script_to_spans` must accept `None` and coerce, or callers must coerce before calling. Pick one: **`parse_script_to_spans` coerces `text = text or ""` at the top** so the contract matches the wrapper. JS `parseScriptToSpans(undefined)` → `[]` (guard `if (!text) return []`).
- **Whitespace-only input** (`"   \n\t  "`) → `[]` (no renderable spans → no chapters). **[invariant]**
- **No headings at all** → one untitled lead-in chapter titled `Chapter 1` (if it has spans), else `[]` (`parse_audiobook_script:143-144,159`). **[verified]**
- **Headings only, no body** (`"# A\n# B"`) → **`[]`**: each chapter body is empty → `_parse_spans` returns `[]` → chapter dropped (`:157-158`). Lock this — it is *not* "two empty chapters."
- **Lead-in present then heading** (`"intro\n# One\nbody"`) → chapter `Chapter 1` (the intro) + chapter `One`. Lead-in is only emitted when `intro.strip()` is truthy (`:148`); a blank lead-in (`"\n# One\nbody"`) emits no lead-in chapter, and `One` stays `One` (the title comes from the heading, not the post-drop counter). Numbering (`Chapter {len(chapters)+1}`) only fires for *untitled* bodies (`:159`).
- **Chapter numbering is post-drop** — `Chapter {len(chapters)+1}` uses the count of *already-kept* chapters, so dropped empty chapters do not consume a number. Fixture: `"intro\n# \nmore\n# Real\nx"` where `# ` is body (see below) must still number correctly. **[invariant]**

#### B. Chapter-heading edge cases **[verified against `_HEADING_RE`]**
- `# Title` → heading "Title". `#\tTitle` (tab separator) → heading "Title" (separator class is `[ \t]+`). `   # Title` (leading spaces/tabs) → heading "Title" (`^[ \t]*`).
- `##`…`######` (H2–H6) → **body, not heading** (regression lock, drift #1).
- `#Title` (no space after `#`) → **body** (requires `[ \t]+`).
- `#` alone, `# ` (hash + only whitespace), `#   ` (hash + spaces, no `\S`) → **body** — the title capture starts with `\S`, so a heading marker with no non-space title narrates literally. Lock this; it is a real input (user typing a `#` mid-draft).
- `# Title   ` (trailing whitespace in title) → title `.strip()`-ed to "Title".
- Heading **not at line start** (e.g. `text # not a heading`) → body (no `^` match; `re.MULTILINE` only resets `^` after `\n`).
- `# ` line whose body run is *all markers* (`"# H\n[pause]"`) → chapter `H` with a single silent span (`text=""`, `pause_ms_after=350`) — *kept*, because `pause_ms > 0` (`_parse_spans:124-125`). A chapter that is *only* whitespace+empty-voice markers (`"# H\n[voice:]"`) → **dropped** (no span survives the `not t and pause_ms==0` filter at `:115`). Fixture both.
- Title with markers in it (`"# [voice:x] Title"`) → the title is the **raw captured text** `"[voice:x] Title"` (the title is *not* run through voice/pause/SSML parsing — only the body is). **[verified]** This is current server behavior; lock it so the JS adapter's `chapterTitle` does the same (strip only the leading `# `, keep the rest verbatim).

#### C. Voice-split edge cases **[verified against `_VOICE_RE`]**
- `[voice:p_fox]` → switch to `p_fox`. `[voice:a][voice:b]` (adjacent) → `a` then `b`; `a` governs zero chars of text (no span between them), so only `b`'s run produces spans. **[verified]**
- `[voice:]`, `[voice:   ]` (empty/whitespace) → revert to `default_voice` (drift #3 fix — currently *spoken literally* on the client). **[verified]**
- `[voice:[nested]]` → **NO MATCH** (the inner `[` breaks `[^\]\[]*`); the whole `[voice:[nested]]` is **spoken literally**. **[verified]** Lock both ports to this — a naive JS `[^\]]*` would match `[voice:[nested]` and diverge.
- `[voice:a b]` (space in id) → captures `"a b"` (`.strip()` keeps the internal space) → voice id `"a b"`. (Not a valid profile id, but the parser is voice-id-agnostic; it passes through. The renderer's voice lookup handles unknown ids elsewhere — out of scope here.)
- **Voice persists across pause/SSML to chapter end** — a `[voice:x]` at chapter start governs every subsequent span until the next `[voice:]` or chapter boundary. A new chapter (`#` line) **resets** the active voice to `default_voice` (each chapter body is parsed independently). **[invariant]** Lock with a fixture: `"# A\n[voice:x] hi\n# B\nbye"` → chapter B's span has `voice_id = default_voice`, not `x`.
- **Voice marker before any text in a chapter** (`"# A\n[voice:x]\nbody"`) → the leading run before the marker is empty (dropped), the run after carries `voice_id=x`.
- **`[voice:` unclosed** (no `]`, e.g. `"[voice:x hello"`) → NO MATCH → spoken literally as `[voice:x hello`. **[invariant]**

#### D. Pause edge cases **[verified against `_PAUSE_RE`]**
- Forms that **match** (become silence): `[pause]`→350, `[pause 500ms]`→500, `[pause 1s]`→1000, `[pause 1.5s]`→1500, `[pause 0.5s]`→500, `[pause 0.5]` (no unit, treated as ms)→0… **wait**: `0.5` ms `int(round(0.5))`=0 → **0ms** (a span with `pause_ms_after=0`). `[pause 0s]`→0. `[pause 0]`→0. **[verified]** Lock the no-unit-is-ms semantic explicitly (`_pause_ms:248`: unit `s`→×1000, else ms).
- Whitespace tolerance: `[ pause  3  ms ]` → matches, 3ms (spaces around `pause`, the number, and the unit all tolerated). **[verified]**
- Case-insensitive: `[PAUSE 2S]` → 2000ms. **[verified]**
- **Clamp**: `[pause 99s]`, `[pause 10.5s]`, `[pause 999999ms]` → all clamp to `PAUSE_MAX_MS`=10000. **[verified]**
- Forms that **DO NOT match** (spoken literally — lock these, they are the precise boundary of the dialect): `[pause -5s]` (negative — `\d+` has no sign), `[pause .5s]` (leading dot, no integer part — `\d+` requires ≥1 digit before the dot), `[pause 1.2.3s]` (double dot), `[pause1s]` (no space after `pause`), `[pausexyz]`, `[pause 5x]` (unknown unit), `[pause 5 x]`, `[pause 5sx]` (trailing junk after unit), `[pause 5ms s]` (two units), `[pause 12abc]`. **[verified — all NO MATCH in both Python and JS]**
- **Negative-number subtlety**: `[pause -5s]` does not match the *whole* marker, but the substring `-` is just text, and `5s]` etc. are text — the entire literal `[pause -5s]` is spoken. Do not "rescue" the number.
- **Adjacent pauses sum** (`"a[pause 1s][pause 2s]b"`) → after "a", one merged 3000ms pause, then "b" (`text.py:282-284`). Adjacent that would *exceed* the cap (`[pause 8s][pause 8s]`) → clamped to 10000 on the *sum* (`min(prev+pause, PAUSE_MAX_MS)`). **[verified]**
- **Leading pause** (`"[pause 1s]hi"`) → first segment `("", 1000)` then `("hi", 0)`; the empty leading segment becomes a **silent span** `{text:"", pause_ms_after:1000}` (`_parse_spans:124-125`), then a real span for "hi". **[verified]**
- **Trailing pause** (`"hi[pause 1s]"`) → segment `("hi", 1000)`; the 1000ms rides as `pause_ms_after` on hi's span. If "hi" SSML-splits into multiple segments, the pause attaches to the **last** one (`_parse_spans:130`, `j == len(rendered)-1`). **[invariant]**
- **Standalone pause** (`"[pause 1s]"` alone) → single silent span `{text:"", pause_ms_after:1000}`. **Empty-with-zero** (`""`-text run with `pause_ms==0`) → no span (`:115`).
- **`parse_pause_markers` enters the bracket branch on any `[`** (`text.py:270` short-circuits only when `"[" not in text`). So a run like `[voice:a] hi` (after voice-split has *already* consumed the voice marker, this shouldn't happen — but if a stray `[` survives) walks the full path and emits the literal `[` as part of `span_text`. **This is why voice-split must run before pause-split** (precedence step 2 before 3) — locked by the precedence order; add a fixture proving a literal `[` (e.g. `"a [ b"`) is preserved verbatim in the span text.

#### E. SSML-lite edge cases **[verified against `parse_ssml_lite`]**
- Each tag alone: `[slow]x[/slow]`→speed 0.85; `[fast]`→1.15; `[emphasis]`→0.92 + `emphasis` flag *(note: `emphasis` is computed but the span dict only carries `speed`; the emphasis bool does not reach `SpanDict` — verify it is intentionally dropped, matching `_parse_spans:121` which only reads `seg["speed"]` and `seg["spell"]`)*; `[spell]`→`spell=True`, text spaced by `spell_out`.
- **Nesting innermost-wins**: `[slow][fast]x[/fast]y[/slow]` → "x" at 1.15, "y" at 0.85. `[slow][spell]A[/spell][/slow]` → "A" spaced *and* at 0.85 (spell + slow compose; spell does not touch speed). **[verified — `_resolve` walks stack outer→inner]**
- **Unclosed tag → to EOL**: `[slow]rest of line` → whole rest at 0.85.
- **Stray close ignored**: `[/slow]x` → "x" plain (the unmatched close is dropped, text emitted plain).
- **Only-markers → no span**: `[slow][/slow]` → `parse_ssml_lite` returns `[]` (`ssml_lite.py:136-138`) → the pause-split segment produces no `rendered` entries → if its pause is 0, no span; if it had a trailing pause, a silent span carries the pause (`_parse_spans:122-125`).
- **Adjacent-identical merge**: `[slow]a[/slow][slow]b[/slow]` → one merged segment "ab" at 0.85 (not two). **[verified]**
- **`[spell]` whitespace**: `spell_out` collapses *all* internal whitespace (spaces, tabs, newlines) then single-spaces the characters — `"go USA"`→`"g o U S A"`, `"\tX\nY"`→`"X Y"`, `"  a b  "`→`"a b"`, `""`→`""`, single-char `"A"`→`"A"`. **[verified Python and JS produce identical output on all these]** — but the two impls compute it *differently* (Python `" ".join("".join(word.split()))` `ssml_lite.py:154-155` vs JS `(word||'').split(/\s+/).join('').split('').join(' ')` `ssmlLite.js:81`); the corpus must lock the equality, including the **empty-string** path (JS `''.split('').join(' ')` → `''`, Python `if not word: return ''` → `''`; both `''` **[verified]**).
- **Segment text is `.strip()`-ed after spell-out** (`_parse_spans:119`): a segment that is whitespace-only after rendering is dropped (`if st:`). So `[slow]   [/slow]` → no span (whitespace-only segment).
- **Tag names are case-insensitive** (`[SLOW]`, `[Slow]`) and lowercased before lookup (`ssml_lite.py:124` `.lower()`, JS `m[2].toLowerCase()` `ssmlLite.js:66`). Lock a fixture.
- **Unknown tag** (`[whisper]x[/whisper]`) → NOT in `_TAGS` → the `_TAG_RE` alternation doesn't match it → spoken literally as `[whisper]x[/whisper]`. **[invariant]** Lock — a future-tag user-typed string must not silently vanish.

#### F. The double-strip + whitespace-preservation invariant
- A chapter body is **not** stripped as a whole before span-splitting; the **per-segment** text is `.strip()`-ed twice along the path: once implicitly via `parse_pause_markers` segment boundaries, once explicitly at `_parse_spans:114` (`t = span_text.strip()`) and again at `:119` (`st = (...).strip()`). **Net effect:** internal newlines *inside* a single uninterrupted run are **preserved** (e.g. `"# One\nintro\n## Still One\nmore"` → span text `"intro\n## Still One\nmore"`, **[verified]** — the `## Still One` line is body, newlines kept, leading/trailing stripped). Fixtures must encode the **real** server output (newlines preserved internally), not an idealized single-line normalization. **[verified]**

#### G. `/longform/render` reconciliation (the parser is not the only span producer)
- The `/longform/render` endpoint (`router:516-543`) does **not** call the parser — it ingests a pre-built plan and applies its **own** span-keep rule (`:530-532`): `text=(s.text or "").strip()`, kept if `((s.text and s.text.strip()) or s.pause_ms_after > 0)`, and `pause_ms_after=max(0, int(s.pause_ms_after))`. This must agree with the parser's keep rule (`_parse_spans:115`: drop iff `text` empty *and* `pause_ms == 0`). **Cross-check**: a span `{text:"  ", pause_ms_after:0}` → dropped by both; `{text:"", pause_ms_after:500}` → kept by both; `{text:"x", pause_ms_after:-5}` → router clamps to 0 (parser never emits negative). The JS adapter must not emit a span that the router would silently drop or re-clamp differently. Lock with a fixture asserting the adapter output, post-clamp, equals the parser output for the same logical script.
- **Negative `pause_ms_after` from the wire** (a malformed client plan) → router clamps to 0; the parser/adapter never produce negatives (`_pause_ms:250` `max(0, …)`). No span is *added or removed* by the clamp.
- **`_MAX_CHAPTERS` guard** (`:523-524`, `_MAX_CHAPTERS = 10_000` at `:94`) → unrelated, stays; a plan exceeding it raises `HTTPException(status_code=422, detail="too many chapters (max 10000)")` before any span work. Not the parser's concern.

#### H. Adapter-specific edge cases (`storyToSpans` track→canonical) — JS only
- **Empty track list** (`storyToSpans([], cast)`) → `[]`. **Null/undefined tracks** → `[]` (`for (const tk of tracks || [])`).
- **Track with empty/whitespace text** → contributes no spans; does not flush the chapter.
- **A chapter-heading track flushes the current chapter** *only if it has spans* (`flush()` pushes only when `cur.spans.length`); a heading following another heading with no body between → first chapter dropped, just like the server drops empty chapters. **[invariant]**
- **Adjacent-pause fold *across tracks*** — a pause-only track (or a track ending in a pause) followed by another track: the leading pause of the next track must fold into the previous span's `pause_ms_after`, matching `storyToSpans.js:38-40`. A pause that leads a *chapter* (no previous span) → silent span. The adapter must preserve this; the per-track canonical call cannot do it (it has no cross-track memory) → **the fold stays in the adapter loop**, applied to the spans the canonical call returns. Lock with a two-track fixture.
- **Per-track speed** — each track's `tk.speed || null` is the `defaultSpeed` for that track's canonical call; inline SSML speed overrides it per-segment (`s.speed != null ? s.speed : speed`, `storyToSpans.js:47`). A track with `speed: 0` → `0 || null` → **null** (falsy `0` becomes the engine default, not a 0× speed). Lock this (`tk.speed=0` must yield `speed:null`, matching current `tk.speed || null`).
- **Per-track resolved voice** — `effectiveProfile(tk, cast)` resolves *before* the canonical call (per-line `track.profileId` → cast member's `profileId` → `null`, `storyCast.js:21-25`). A track whose text *also* contains `[voice:other]` → the canonical parser's voice-split overrides the resolved cast voice *within that track's text* (the resolved voice is the `defaultVoice` arg; an inline `[voice:other]` switches mid-text, and `[voice:]` reverts to the resolved cast voice — **not** to `null`). Lock a fixture: track `character=alice`(cast resolves to `p_alice`), text `"hi [voice:p_bob] there [voice:] back"` → spans `[p_alice "hi", p_bob "there", p_alice "back"]`.
- **A `#`-line *inside* a multi-line track text** — must **not** re-chapter (the track is the unit; the canonical line-body call must be told *not* to look for chapter headings, or the adapter must only ever pass single-track text that the canonical body-parser treats as one chapter body). Concretely: the adapter calls the **voice/pause/SSML layering** (`parseVoiceRuns`→`parsePauseMarkers`→`parseSsmlLite`) via the exported **`parseChapterBody`**, **not** the full `parseScriptToSpans` (which would chapter-split on an embedded `#`). Lock: a track text `"line one\n# not a chapter\nline two"` → one chapter (the current one), span text containing `# not a chapter` literally. **(This is the single biggest correctness trap — see Risk.)**

#### I. `parseStoryText` (highlight overlay) edge cases — must not regress
- `parseStoryText` keeps its `{type:'chunk'|'pause', …}` event shape for the StoriesEditor highlight (`StoriesEditor.jsx:307`). After widening `TOKEN_RE`:
  - `[pause]` (bare) → must emit `{type:'pause', seconds: 0.35}` (350ms→0.35s). Currently bare `[pause]` is NOT matched and spoken — after the fix it highlights as a pause. The ms→seconds map is `seconds = pause_ms_after / 1000`.
  - `[pause 500ms]` → `{type:'pause', seconds: 0.5}`.
  - `[pause 0s]` / `[pause 0]` → `pause_ms_after=0` → `seconds=0` → the current guard `Number.isFinite(seconds) && seconds > 0` (`storyTokens.js:40`) **drops** zero-duration pauses from the event list (no `{type:'pause'}` emitted) but the marker is still **consumed** (not spoken). Lock this: a `[pause 0s]` neither speaks nor adds a visible pause overlay, but the literal text vanishes from the highlighted chunks.
  - `[voice:]` (now matching) → consumed as a voice switch to default; not spoken (drift #3 fix in the highlight path too). Verify `hasStoryMarkers` (`:57`) also recognizes the widened forms — its regex `/\[(?:pause\s+\d|voice:)/i` already matches `voice:` but **not** bare `[pause]` or `[pause 500ms]`-via-`\d` (it requires `pause\s+\d`, which `500ms` satisfies but bare `[pause]` does not). **Widen `hasStoryMarkers` too** so bare `[pause]` is recognized as "has markers" (otherwise the highlight path and the render path disagree on whether a line needs special-casing). Lock a fixture.

### Speed plumbing & the track→blob adapter (the real asymmetries)

Two asymmetries, not one:

**(a) Speed.** The server `_parse_spans` has no per-line "speed" input — speed only arrives on the wire as `LongformSpan.speed` (the client already resolved it). The client `storyToSpans` *does* take per-line `tk.speed` and applies "SSML speed overrides line speed, else line speed" (`storyToSpans.js:34,47`: `const speed = tk.speed || null;` then `s.speed != null ? s.speed : speed`).

Canonical resolution: `parse_script_to_spans` gains an optional `default_speed: float | None = None`. Span speed = `ssml_segment["speed"] if ssml_segment["speed"] is not None else default_speed`. The server `parse_audiobook_script` caller passes `default_speed=None` (a whole-script slider is not an audiobook concept yet, and `Span.speed` defaults to `None`, `audiobook.py:56`). **Falsy-zero note:** the JS adapter passes `tk.speed || null`, so `tk.speed=0`→`null`; the Python `default_speed` must treat only `None` as "unset" (`is not None`), so a literal `default_speed=0.0` *would* be honored — but no caller passes 0, and the adapter never sends 0. Lock the `tk.speed=0`→`null` behavior in the JS suite so the two never diverge on the zero edge.

**(b) Single blob vs. per-line tracks.** `parse_script_to_spans` is defined on a **single text blob** (matching the server's existing model). But `storyToSpans` consumes an **array of tracks** and applies *per-track* speed/voice. The adapter must therefore call the canonical parser's **line-body layering** (voice→pause→SSML, *without* chapter-split) once per spoken track, **not** the full `parseScriptToSpans` over a joined blob, because (i) each track may carry a different `speed` and resolved cast voice, and (ii) a `#` line *inside* a track's text must not re-chapter. Practical shape of the new `storyToSpans`:

- Iterate tracks; when `isChapterLine(tk.text)` (now narrowed to H1) → flush current chapter, start new one with `chapterTitle(tk.text)`.
- For each spoken track, resolve `voice_id = effectiveProfile(tk, cast)` (`storyCast.js:21`) and `default_speed = tk.speed || null`, then run the track's text through the exported **line-body** function `parseChapterBody(text, { defaultVoice: voice_id, defaultSpeed: speed })`, appending the resulting spans to the current chapter.
- **Adjacent-pause folding across tracks** (`storyToSpans.js:38-40`) is applied by the adapter *after* the per-track call: if the track's first span is a silent span (`text:"", pause_ms_after>0`) and the chapter already has a previous span, fold the pause into the previous span's `pause_ms_after` instead of pushing the silent span. Leading-pause-at-chapter-start stays a silent span.

This keeps cast resolution and per-track speed client-side (the canonical parser stays voice-id-agnostic and blob-oriented), while the voice/pause/SSML *layering* lives in one place per language. `storyToSpans.test.js` line-speed expectations (`:40-55`) stay green by construction.

### File layout

- **New** `backend/services/longform_parser.py` — `parse_script_to_spans` + a reusable line-body helper (`_parse_chapter_body`) (so the wrapper and any future caller share the voice→pause→SSML layering) + the heading/voice regexes (moved from `audiobook.py:36,42`). Imports `parse_pause_markers` from `omnivoice.utils.text` and `parse_ssml_lite`/`spell_out` from `services.ssml_lite`. Pure, import-light (no torch). Coerces `text = text or ""` at entry; normalizes `\r\n`/`\r`→`\n` at entry (see Constraints → cross-platform).
- `backend/services/audiobook.py` — `_HEADING_RE`/`_VOICE_RE`/`_parse_spans` deleted (lines 36, 42, 93-132); the `from services.ssml_lite import parse_ssml_lite, spell_out` (currently a *function-local* import at `audiobook.py:106`) moves into `longform_parser.py`; `parse_audiobook_script` re-expressed as `AudiobookPlan(chapters=[Chapter(...) from parse_script_to_spans(...)])`. The dataclasses `Span`/`Chapter`/`AudiobookPlan` (`audiobook.py:45-90`) stay so downstream `.to_dict()` / `synthesize_chapter` / `_render_chapter_cached` (`router :276` reads `s.voice_id, s.text, s.pause_ms_after, s.speed`) are untouched. **`audiobook.py` retains `from omnivoice.utils.text import parse_pause_markers` (`:29`) only if still referenced elsewhere in the file; it is the *only* import of that symbol and is consumed solely by `_parse_spans:113` — once `_parse_spans` is deleted, the import is dead, so drop `audiobook.py:29`** (re-grep `parse_pause_markers` in `audiobook.py` before deleting to confirm).
- **New** `frontend/src/utils/longformParser.js` — `parseScriptToSpans(text, { defaultVoice, defaultSpeed })` + the exported line-body layering the adapter uses. Mirrors the Python algorithm exactly; imports `parseSsmlLite`/`spellOut` from `ssmlLite.js` and exposes shared `parsePauseMarkers`/`parseVoiceRuns`. Guards `if (!text) return []`; normalizes `\r\n`/`\r`→`\n` at entry.
- `frontend/src/utils/storyTokens.js` — `parseStoryText` keeps its public signature/output shape (StoriesEditor highlight at `StoriesEditor.jsx:307` depends on the `{type:'chunk'|'pause', …}` event list) **but** its `TOKEN_RE` (`storyTokens.js:23`) pause branch is widened to the canonical dialect (`[pause]`, `Nms`, `Ns`) and the voice branch to `[^\]\[]*` (so `[voice:]` reverts to default instead of being spoken). `hasStoryMarkers` (`:57`) **is widened** to recognize bare `[pause]` (and the `ms` form) so the highlight path and render path agree on which lines "have markers." `applyInlineVoice` (`:68`), `insertToken` (`:85`) are unchanged. *(Note: `parseStoryText` returns `{type:'pause', seconds}` for the highlight overlay — keep that shape; only widen what the regex matches. The canonical ms→seconds is `seconds = pause_ms_after / 1000`; the existing `Number.isFinite(seconds) && seconds > 0` guard keeps a 0-duration pause from rendering a visible overlay while still consuming the marker.)*
- `frontend/src/utils/storyExport.js` — `isChapterLine` (`:64`, `/^#{1,6}\s+/`) narrowed to H1 (`/^#[ \t]+\S/` after trim, or equivalently the H1-only test that *also rejects `# ` with no non-space title* to match `_HEADING_RE`'s `\S` requirement); `chapterTitle` (`:69`, `.replace(/^#+\s+/, '')`) adjusted to strip only the single leading H1 marker (`/^#[ \t]+/`) and keep the remainder verbatim (so `# [voice:x] T`→`[voice:x] T`, matching the server's raw-title behavior). Consumers `tracksByCharacter` (`:82`), `exportStoryAudio` (`:109`), `exportStems` (`:154`) inherit the change — intentional, covered by tests. **Edge:** `isChapterLine("# ")` and `isChapterLine("#   ")` must now return **false** (H1 with no `\S` title narrates as body), matching `_HEADING_RE`. The current `/^#{1,6}\s+/` returns `true` for `# ` — this is a behavior change; lock it.
- `frontend/src/utils/storyToSpans.js` — reimplemented as the track→canonical adapter described above (cast resolution via `effectiveProfile` still happens here; per-track text + resolved voice + speed feed the canonical line-body layering; adjacent-pause fold applied by the adapter). **Public signature unchanged**: `storyToSpans(tracks, cast) -> Array<{ title, spans }>` (consumed at `StoriesEditor.jsx:363`, posted as `longformRender({ chapters, format })`).
- `frontend/src/utils/ssmlLite.js` ↔ `backend/services/ssml_lite.py` — keep both; both now exercised by the shared corpus so drift is caught.

### Shared fixture corpus

One JSON file `tests/fixtures/longform_parser_cases.json` (array of cases) under the **already-existing** `tests/fixtures/` dir (currently holds `sentence_chunker_scenarios.json`, `whisper_clean.json`, `whisper_screenshot.json` — **confirmed present**). It is the single source of expected output. Read by:
- `tests/test_longform_parser.py` (pytest) — `parse_script_to_spans(case["input"], default_voice=case["default_voice"], default_speed=case.get("default_speed")) == case["expected"]`.
- `frontend/src/test/longformParser.test.js` (vitest) — imports the same JSON and asserts `parseScriptToSpans(...)` deep-equals `case.expected`.

Because both suites load the *same* JSON, a divergence cannot pass both — the side that drifts fails its own assertion against the shared truth.

---

## Integration points (file:line — verified against current code)

- `backend/services/audiobook.py:36` `_HEADING_RE`, `:42` `_VOICE_RE`, `:93-132` `_parse_spans`, `:135-160` `parse_audiobook_script`, `:106` function-local `from services.ssml_lite import parse_ssml_lite, spell_out`, `:29` `from omnivoice.utils.text import parse_pause_markers` → move/rewrite; parser logic relocates to `longform_parser.py`; drop the now-dead `:29` import (its only consumer is `_parse_spans`).
- `backend/api/routers/audiobook.py:29` `from services.audiobook import parse_audiobook_script, synthesize_chapter`; call sites `:82` (`/audiobook/plan`), `:121` (`/audiobook/import`), `:321` (`/audiobook/preview`), `:480` (`/audiobook`) → unchanged signatures (wrapper preserved). All four call `parse_audiobook_script(text, default_voice=…)`; `/audiobook/import` (`:121`) calls it with no `default_voice` (positional `script` only).
- `backend/api/routers/audiobook.py:516-543` `/longform/render` — consumes a pre-built plan; the inline `Span(...)` normalization (`:530-532`) does `text=(s.text or "").strip()`, `pause_ms_after=max(0, int(s.pause_ms_after))`, `speed=s.speed`, and keeps a span if `((s.text and s.text.strip()) or s.pause_ms_after > 0)`. This span-keep rule must match the canonical parser's keep rule (parser drops a span only when text is empty *and* `pause_ms == 0`, mirroring `_parse_spans:115`); cross-check in tests (see edge-case §G). `_MAX_CHAPTERS` guard at `:523-524` is unrelated and stays.
- `omnivoice/utils/text.py:226` `PAUSE_DEFAULT_MS = 350`, `:227` `PAUSE_MAX_MS = 10_000`, `:233` `_PAUSE_RE`, `:239` `_pause_ms`, `:253` `parse_pause_markers` → **canonical pause source**, reused unchanged by Python; its constants/dialect (atomic group `(?>…)` for ReDoS safety, `text.py:228-234`) become the spec the JS `parsePauseMarkers` mirrors. The JS port uses a non-atomic `(?:…)?` group, which is **[verified]** equivalent on every dialect form because the optional group has no internal alternation that could force backtracking — confirm parity is covered by the ReDoS fixture and the NO-MATCH boundary cases in §D.
- `frontend/src/utils/storyTokens.js:23` `TOKEN_RE` → widen pause grammar to match `_PAUSE_RE` (add `ms` unit + bare `[pause]`) and widen voice class to `[^\]\[]*`; `:57` `hasStoryMarkers` → widen to recognize bare/ms pause.
- `frontend/src/utils/storyExport.js:64` `isChapterLine` (`/^#{1,6}\s+/`) → narrow to H1 + require `\S` title (so `# ` is body); `:69` `chapterTitle` strip regex adjusted to strip only the single leading H1 marker, remainder verbatim.
- `frontend/src/utils/storyToSpans.js:21-54` → reimplement over the canonical line-body layering (track→blob adapter; per-track voice/speed; cross-track pause fold).
- `frontend/src/utils/storyCast.js:21` `effectiveProfile(track, cast)` → unchanged; called by the adapter before invoking the canonical parser. Resolves `track.profileId || castMember.profileId || null`.
- `frontend/src/utils/ssmlLite.js` (`TAG_RE = /\[(\/?)(slow|fast|emphasis|spell)\]/gi`, fixed-literal alternation, `ssmlLite.js:26`) ↔ `backend/services/ssml_lite.py` (`_TAG_RE`, fixed-literal alternation built from `re.escape` of the tag names, `ssml_lite.py:60-63`) → keep both; both now exercised by the shared corpus.
- `frontend/src/components/StoriesEditor.jsx:18` imports `parseStoryText, hasStoryMarkers, applyInlineVoice, insertToken`; `:25` imports `storyToSpans`; `:294` `hasStoryMarkers(raw)` (preview-path gate); `:307` `parseStoryText(raw, pid)` (highlight + chained preview, consuming `{type, text, profileId}` / `{type, seconds}`); `:363` `storyToSpans(usable, cast)` (render plan, then `longformRender({ chapters, format })` at `:368`) → no API change; verify highlight + render-plan still build and that the widened `hasStoryMarkers` doesn't change which lines get the marker-aware highlight path in a surprising way.
- `frontend/src/api/audiobook.ts:100-122` `LongformRenderBody` / `longformRender(body)` → request body shape pinned below; **note the TS interface omits `lexicon`** even though the backend `LongformRenderRequest` accepts it (`:513`) — this is a pre-existing client/server shape gap, out of scope to fix here, but flag it so this task doesn't accidentally "fix" the wire shape.
- `.github/workflows/security.yml:94-105` CodeQL config — `paths-ignore` (verified) includes `omnivoice/eval`, `research`, `tests`, `backend/migrations`, and the four `**/*.test.{js,jsx,ts,tsx}` globs, so the fixture JSON (under `tests/`) and the `*.test.js` files are **not** scanned; the **new `longform_parser.py` IS scanned** (under `backend/`, build-mode `none`/interpreted). Its regexes must be ReDoS-safe. `longformParser.js` IS scanned (only `*.test.*` are ignored, not regular `.js`).
- `.github/workflows/ci.yml:67` `uv run pytest tests/ -q --tb=short` picks up `test_longform_parser.py`; `:107` `bunx vitest run` picks up `longformParser.test.js`; `:81` `uv run pytest backend/tests/` and `:256` `tests/smoke/` are unaffected — no CI YAML change needed. CI Python is pinned **`3.11`** (`ci.yml:32` and `:223`) — this satisfies the atomic-group (`(?>…)`) requirement that `_PAUSE_RE` depends on.
- `frontend/vite.config.js:30-36` `test` block — `include: ['src/**/*.test.{js,jsx,ts,tsx}']`, `environment: 'jsdom'`, **no `server.fs.allow` override**. Vitest inherits Vite's default `server.fs.allow` whose root is the config dir (`frontend/`). The fixture lives at `tests/fixtures/longform_parser_cases.json`, **outside `frontend/`** — see Dependencies for the import-resolution spike (a static `import cases from '../../../tests/fixtures/…json'` is resolved by Vite at transform time, *not* gated by `server.fs.allow` for test files, but **verify in slice 2** before committing to the layout).

---

## API / data shapes

This section pins every shape a developer needs so they can implement against it without guessing. **Nothing here changes the request/response wire shapes** — they are reproduced verbatim from the current code so the contract is unambiguous; only the span plan they carry converges.

### Function signatures — Python

#### New: `backend/services/longform_parser.py`
```python
from __future__ import annotations
import re
from typing import Optional

# Moved verbatim from audiobook.py:36,42 (both already CodeQL-cleared there —
# keep the ReDoS-reasoning comments from audiobook.py:31-42).
_HEADING_RE = re.compile(r"^[ \t]*#[ \t]+(\S.*)$", re.MULTILINE)
_VOICE_RE = re.compile(r"\[voice:([^\]\[]*)\]")

def parse_script_to_spans(
    text: str | None,
    *,
    default_voice: str | None = None,
    default_speed: float | None = None,
) -> list[dict]:
    """Return [{"title": str, "spans": [span_dict, …]}, …].

    span_dict == {"voice_id": str | None, "text": str,
                  "pause_ms_after": int, "speed": float | None}
    (key order: voice_id, text, pause_ms_after, speed — matches Span.to_dict()).

    Contract:
      * None / "" / whitespace-only input → [].
      * \\r\\n and bare \\r normalized to \\n at entry (cross-platform parity).
      * H1 (`# <non-space>…`) opens a chapter; H2–H6 and `# ` (no \\S title) are body.
      * Each chapter body resets the active voice to default_voice (chapters parsed
        independently).
      * A span is dropped iff its text is empty AND pause_ms_after == 0.
      * Chapters with no surviving spans are dropped; untitled bodies are numbered
        `Chapter {kept_so_far + 1}` (post-drop numbering).
    """

def _parse_chapter_body(  # the reusable line-body layering the JS adapter mirrors
    body: str,
    *,
    default_voice: str | None,
    default_speed: float | None,
) -> list[dict]:
    """Voice→pause→SSML layering for ONE chapter body (no chapter split).

    Returns [span_dict, …]. Used by parse_script_to_spans per-chapter; the JS
    twin (parseChapterBody) is what storyToSpans calls per spoken track."""
```
- Both module-level regexes are moved verbatim (no edit) from `audiobook.py:36,42`, retaining the no-overlap / both-brackets-excluded ReDoS comments at `audiobook.py:31-42`.
- `_parse_chapter_body` does the function-local `from services.ssml_lite import parse_ssml_lite, spell_out` (relocated from `audiobook.py:106`) and `from omnivoice.utils.text import parse_pause_markers` at module top.

#### Wrapper: `backend/services/audiobook.py` (unchanged public type)
```python
def parse_audiobook_script(text: str, *, default_voice: Optional[str] = None) -> AudiobookPlan:
    chapters = [
        Chapter(title=c["title"], spans=[Span(**s) for s in c["spans"]])
        for c in parse_script_to_spans(text or "", default_voice=default_voice)
    ]
    return AudiobookPlan(chapters=chapters)
```
- `Span(**s)` is valid because the dict keys `voice_id`/`text`/`pause_ms_after`/`speed` exactly match the `Span` dataclass fields (`audiobook.py:53-56`); `pause_ms_after` and `speed` keep their dataclass defaults (`0`, `None`) but the parser always supplies all four keys, so unpacking is total.
- Wrapper passes `default_speed=None` implicitly (the kwarg defaults to `None`); `Span.speed` then stays `None` for the audiobook path, matching current behavior.

#### Unchanged Python dataclasses (`audiobook.py:45-90`) — reproduced for the contract
```python
@dataclass
class Span:
    voice_id: Optional[str]
    text: str
    pause_ms_after: int = 0
    speed: Optional[float] = None
    def to_dict(self) -> dict:  # → {"voice_id","text","pause_ms_after","speed"}

@dataclass
class Chapter:
    title: str
    spans: list[Span] = field(default_factory=list)
    @property
    def char_count(self) -> int: ...   # sum(len(s.text) for s in spans)
    def to_dict(self) -> dict:  # → {"title","char_count","spans":[...]}

@dataclass
class AudiobookPlan:
    chapters: list[Chapter] = field(default_factory=list)
    @property
    def char_count(self) -> int: ...
    def to_dict(self) -> dict:  # → {"chapters":[...],"chapter_count":int,"char_count":int}
```

### Function signatures — JS

#### New: `frontend/src/utils/longformParser.js`
```js
// Mirrors parse_script_to_spans. Returns
//   [{ title: string, spans: [{ voice_id: string|null, text: string,
//                               pause_ms_after: number, speed: number|null }] }]
export function parseScriptToSpans(text, { defaultVoice = null, defaultSpeed = null } = {})

// The reusable per-chapter-body layering the storyToSpans adapter calls
// (no chapter split — a '#' inside body text stays literal):
//   → [{ voice_id, text, pause_ms_after, speed }, …]
export function parseChapterBody(body, { defaultVoice = null, defaultSpeed = null } = {})

// Shared sub-parsers mirroring the Python dialect:
export function parsePauseMarkers(text)             // → [[spanText, pauseMsAfter], …]  (mirrors text.py:parse_pause_markers)
export function parseVoiceRuns(body, defaultVoice)  // → [[voiceId, runText], …]        (mirrors audiobook.py:_parse_spans:99-104)

export const PAUSE_DEFAULT_MS = 350;
export const PAUSE_MAX_MS = 10000;
```
- `parseScriptToSpans(undefined)` / `parseScriptToSpans('')` → `[]` (guard `if (!text) return []`).
- `\r\n`/`\r`→`\n` normalization at entry: `text = text.replace(/\r\n?/g, '\n')`.
- **`parsePauseMarkers` must replicate Python banker's rounding** in its ms resolver (`int(round(ms))` → round-half-to-even), NOT `Math.round` (half-up) — see Risk. Helper: `roundHalfToEven(x)`.

#### Reimplemented: `frontend/src/utils/storyToSpans.js` (signature unchanged)
```js
// Compiles cast + ordered tracks → the /longform/render chapter plan.
//   tracks: Array<{ text: string, character?: string, profileId?: string|null, speed?: number|null }>
//   cast:   Array<{ id: string, profileId?: string|null, color?: string }>
//   → Array<{ title: string, spans: [{ voice_id, text, pause_ms_after, speed }] }>
export function storyToSpans(tracks, cast)
```

#### `frontend/src/utils/storyTokens.js` (signature unchanged, regex widened)
```js
// Widened TOKEN_RE — pause branch matches the full _PAUSE_RE dialect
// (bare [pause], Nms, Ns, N.Ns); voice branch widened to [^\]\[]*.
// One ReDoS-safe candidate (fixed alternation, no nested quantifiers):
//   /\[(?:\s*pause(?:\s+(\d+(?:\.\d+)?)\s*(ms|s)?)?\s*|voice:\s*([^\]\[]*))\]/gi
// → group 1 = pause number, group 2 = pause unit, group 3 = voice id.
// (Note the GROUP RENUMBERING vs today's 2-group pattern — parseStoryText must
//  read group 3 for voice, and resolve pause ms via _pause_ms semantics, then
//  seconds = ms/1000 for the {type:'pause', seconds} event.)
export function parseStoryText(text, defaultProfileId = null)  // → [{type:'chunk',text,profileId} | {type:'pause',seconds}]
export function hasStoryMarkers(text)   // widened: matches bare [pause], [pause Nms], [pause Ns], [voice:…]
export function applyInlineVoice(text, selectionStart, selectionEnd, voiceId)  // unchanged
export function insertToken(text, caret, token)  // unchanged
```
- **Group renumbering is load-bearing**: the current `TOKEN_RE` has 2 capture groups (1=pause secs, 2=voice). Widening the pause branch to `(\d+(?:\.\d+)?)\s*(ms|s)?` adds a unit group, shifting voice to group 3. `parseStoryText` (`:38-46`) reads `match[1]`/`match[2]` today — it must be rewritten to read group 1+2 for pause (compute ms via the `_pause_ms` rule, then `seconds = ms/1000`) and group 3 for voice. **Lock this in `storyTokens.test.js`.**

#### `frontend/src/utils/storyExport.js` (signatures unchanged, regexes narrowed)
```js
export function isChapterLine(text)    // /^#[ \t]+\S/ on trimmed text — H1 + non-space title only
export function chapterTitle(text)     // strip only leading /^#[ \t]+/, keep remainder verbatim
```

### Request shapes (Pydantic — UNCHANGED, pinned for reference)

```python
# backend/api/routers/audiobook.py — all four reproduced verbatim:

class AudiobookPlanRequest(BaseModel):       # POST /audiobook/plan
    text: str
    default_voice: str | None = None

class AudiobookPreviewRequest(BaseModel):    # POST /audiobook/preview
    text: str
    chapter_index: int = 0
    default_voice: str | None = None
    lexicon: dict | None = None

class AudiobookRequest(BaseModel):           # POST /audiobook
    text: str
    default_voice: str | None = None
    bitrate: str = "128k"
    format: str = "m4b"                      # "m4b" | "mp3"
    loudness: str | None = None              # None/"off" | "acx" | "podcast"
    cover_path: str | None = None
    metadata: dict | None = None
    lexicon: dict | None = None

class LongformSpan(BaseModel):
    voice_id: str | None = None
    text: str
    pause_ms_after: int = 0
    speed: float | None = None

class LongformChapter(BaseModel):
    title: str = ""
    spans: list[LongformSpan] = []

class LongformRenderRequest(BaseModel):      # POST /longform/render
    chapters: list[LongformChapter] = []
    default_voice: str | None = None
    bitrate: str = "128k"
    format: str = "m4b"
    loudness: str | None = None
    cover_path: str | None = None
    metadata: dict | None = None
    lexicon: dict | None = None
```

### Response shapes (UNCHANGED, pinned)

**`POST /audiobook/plan` → 200** (`audiobook.py:83`, `plan.to_dict()`):
```json
{
  "chapters": [
    { "title": "One",
      "char_count": 23,
      "spans": [
        { "voice_id": "v1", "text": "intro\n## Still One\nmore",
          "pause_ms_after": 0, "speed": null }
      ] }
  ],
  "chapter_count": 1,
  "char_count": 23
}
```

**`POST /audiobook/import` → 200** (`audiobook.py:122`): `{ "text": "<script>", "chapters": <int> }` (the `chapters` value is `plan.chapter_count`).

**`POST /audiobook/preview` → 200** (`audiobook.py:337-342`):
```json
{ "output": "longform_cache/abc123.wav", "duration_s": 12.34, "cached": false, "title": "One" }
```
Error paths: `400 {"detail":"no chapters parsed from the script"}` (`:323`), `400 {"detail":"chapter_index out of range (0..N-1)"}` (`:326`).

### SSE event stream — `POST /audiobook` and `POST /longform/render` (UNCHANGED, pinned)

Both endpoints return `StreamingResponse(..., media_type="text/event-stream")`; each event is `data: <json>\n\n` (`_emit`, `audiobook.py:383`). The exhaustive event-type union the client must handle (read with the `sseParse` helpers, per `audiobook.ts:113`):

| `type` | Emitted at | Payload fields (besides `type`) |
|---|---|---|
| `error` | `:386,390,435,474` | `error: str` (terminal; e.g. `"nothing to render (no chapters)"`, `"ffmpeg not available; the output needs it"`, `"all chapters failed to render"`, `"render failed (see backend log)"`) |
| `started` | `:412` | `job_id: str`, `chapters: int` (total) |
| `chapter` | `:430-432` | `index: int`, `total: int`, `title: str`, `duration_s: float` (2dp), `cached: bool` |
| `chapter_error` | `:424-425` | `index: int`, `total: int`, `title: str`, `error: "chapter failed to render"` (non-terminal — stream continues) |
| `assembling` | `:438` | *(none)* |
| `done` | `:463-465` | `output: str` (filename, e.g. `story_<jobid>.m4b`), `chapters: int` (succeeded), `duration_s: float`, `cached_chapters: int`, `failed_chapters: list[int]` |

The `job_type` discriminator differs by front door (`"audiobook"` vs `"story"`, `:485`/`:540`) and feeds the `output` filename prefix + the `job_store` row type — **not** an SSE field. This task touches none of these events; they are pinned so a reviewer can confirm the converged span plan still drives the identical stream.

### Client wire shape — `frontend/src/api/audiobook.ts:100-122` (UNCHANGED, pinned)
```ts
export interface LongformRenderBody {
  chapters: Array<{ title?: string; spans: Array<{ voice_id: string | null; text: string; pause_ms_after: number; speed?: number | null }> }>;
  default_voice?: string | null;
  bitrate?: string;
  format?: 'm4b' | 'mp3';
  loudness?: 'off' | 'acx' | 'podcast' | null;
  cover_path?: string | null;
  metadata?: AudiobookMetadata | null;
}
// longformRender(body) → Promise<Response>  (raw SSE stream, read via sseParse)
```
`storyToSpans(usable, cast)` output is spread directly into `chapters` at `StoriesEditor.jsx:368` (`longformRender({ chapters, format })`), so the adapter's `{title, spans:[{voice_id,text,pause_ms_after,speed}]}` shape **is** the wire shape — it must match `LongformChapter`/`LongformSpan` exactly (it does; `title` optional, span keys identical).

### DB schema & migration — explicit NO-OP (pin so a reviewer can check it off)

**No schema change, no alembic migration, no `omnivoice_data/` migration.** Verified:
- The parser is **pure text→plan**; it persists nothing.
- The only DB touch anywhere near this code is `_resolve_voice` (`audiobook.py` router `:160-…`), which does a **read-only** `SELECT * FROM voice_profiles WHERE id=?` to map a voice id to ref audio — **unchanged** by this task (the parser is voice-id-agnostic and never queries the DB).
- Stories projects are persisted client-side (cast + tracks), not in the backend DB; their shape (`{text, character, profileId, speed}` per track) is **unchanged** — the adapter consumes the same shape it does today (`storyToSpans.js:26-34`).
- Consequence: existing in-progress story projects keep loading byte-for-byte; only their *rendered output* converges to server behavior (Risk). **No `alembic` revision, no `localStorage` version bump, no data-shape edit.**

### Fixture — `tests/fixtures/longform_parser_cases.json` (schema + example)

**Schema** — array of case objects:
```jsonc
{
  "name": "string — unique, used as the pytest/vitest test id",
  "input": "string — the raw script (may contain \\n, \\r\\n, CJK, markers)",
  "default_voice": "string | null — the default_voice arg",
  "default_speed": "number | null — optional; omitted ⇒ null (read via case.get('default_speed'))",
  "expected": [ /* list of chapter dicts, the canonical truth */
    { "title": "string",
      "spans": [
        { "voice_id": "string | null", "text": "string",
          "pause_ms_after": 0, "speed": null }
      ] }
  ]
}
```
**Example case** (the §F internal-newline lock):
```json
{
  "name": "h2_is_body_not_chapter",
  "input": "# One\nintro\n## Still One\nmore",
  "default_voice": "v1",
  "default_speed": null,
  "expected": [
    { "title": "One", "spans": [
      { "voice_id": "v1", "text": "intro\n## Still One\nmore",
        "pause_ms_after": 0, "speed": null }
    ]}
  ]
}
```
Note: `expected` matches `parse_script_to_spans` output exactly (the chapter dict has only `title`+`spans`, NOT `char_count` — `char_count` appears only in `AudiobookPlan.to_dict()`, which the corpus does not assert against). Span `text` retains internal newlines exactly as the server emits them after the double-`.strip()` (`_parse_spans:114,119`). **[verified]** Write `expected` from **actual Python output**, then make JS match — never the reverse (Risk).

---

## Test plan

**Cross-impl golden corpus (the anti-drift core).** `tests/fixtures/longform_parser_cases.json`, **≥ 40 cases** (raised from 25 to cover the edge enumeration above; one case per row in §A–I), must include at least one case per drift + per grammar rule + every enumerated edge case:

- **Document-level (§A):** empty `""`→`[]`; whitespace-only→`[]`; no-headings (lead-in→`Chapter 1`); headings-only `"# A\n# B"`→`[]`; lead-in present then heading; blank lead-in (no lead-in chapter emitted); chapter-numbering-is-post-drop (`"intro\n# \nmore\n# Real\nx"` numbers `Real` correctly given `# ` is body).
- **Chapter (§B):** H1 opens chapter; **H2–H6 are body** (regression lock, drift #1); `#Title` (no space) is body; `#`/`# `/`#   ` (no `\S` title) is body; `   # T` / `#\tT` are headings; `# T  ` title stripped; heading-not-at-line-start is body; `"# [voice:x] T"` title kept **verbatim** (not voice-parsed); `"# H\n[pause]"` → chapter with one silent span (kept); `"# H\n[voice:]"` → dropped (no surviving span).
- **Pause (§D):** `[pause]`(→350), `[pause 500ms]`(→500), `[pause 1s]`(→1000), `[pause 1.5s]`(→1500), `[pause 0.5]`(no unit → 0ms via int(round(0.5))), `[pause 0s]`(→0), `[ pause  3  ms ]`(→3), `[PAUSE 2S]`(→2000), `[pause 99s]`/`[pause 10.5s]` clamp to 10000; **NO-MATCH/spoken-literally lock-set**: `[pause -5s]`, `[pause .5s]`, `[pause 1.2.3s]`, `[pause1s]`, `[pausexyz]`, `[pause 5x]`, `[pause 5sx]`, `[pause 5ms s]`, `[pause 12abc]`; **bare `[pause]` and `[pause 500ms]` honored as silence** (regression lock, drift #2); leading pause→silent span; trailing pause→rides last span; adjacent pauses sum (incl. sum-clamp `[pause 8s][pause 8s]`→10000); standalone pause→one silent span; literal `[` preserved (`"a [ b"`).
- **Voice (§C):** `[voice:p_fox]` switches; `[voice:]`/`[voice:   ]` revert to default (drift #3 — currently spoken literally on client); `[voice:[nested]]` spoken literally (NO MATCH); `[voice:a b]` (space) passes through; mid-line switch; `[voice:a][voice:b]` adjacent; voice persists to chapter end; **voice resets at chapter boundary** (`"# A\n[voice:x] hi\n# B\nbye"`→B's span is `default_voice`); voice marker before any text; unclosed `[voice:x` literal.
- **SSML-lite (§E):** each tag; nesting innermost-wins (`[slow][fast]x[/fast]y[/slow]`); `[slow][spell]A` compose; unclosed-to-EOL; stray close ignored; only-markers `[slow][/slow]`→no span; `[spell]` spacing across whitespace (`"go USA"`, `"\tX\nY"`, single char, empty); whitespace-only segment dropped (`[slow]   [/slow]`); adjacent-identical merge; case-insensitive tag; **unknown tag `[whisper]` spoken literally**; **`emphasis` flag does not reach the span dict** (only `speed`/`spell` consumed — an `[emphasis]` span has `speed:0.92` and no other distinguishing field).
- **Speed (§(a)):** `default_speed` rides plain segments; inline `[fast]` overrides; `default_speed=None`→`speed:null`; **`tk.speed=0`→`null`** (JS adapter falsy-zero lock, in `storyToSpans.test.js`).
- **Cross-platform line endings (§Constraints):** a `\r\n`-authored input (e.g. `"# One\r\nbody\r\n"`) → identical output in both ports (title `"One"`, span text `"body"`, no stray `\r`) — locks the `\r`-normalization decision.
- **Combined precedence:** `"[voice:x] a [pause 300ms] [slow]b[/slow]"` exercising full outer→inner order; a script combining all five layers + multi-chapter.
- **Pause-rounding parity (Risk):** `[pause 0.5]` (0.5 ms) → `0` in **both** (Python `int(round(0.5))`=0 banker's-rounding; JS `roundHalfToEven(0.5)`=0). Add a second tie: `[pause 1.5]` (1.5 ms) → `2` in both (`round(1.5)`=2, `roundHalfToEven(1.5)`=2) to prove the JS helper rounds half-to-even, not half-up (`Math.round(0.5)`=1 would fail the first case).
- **Adapter (§H, JS-only fixtures in `storyToSpans.test.js` since they need the track shape):** empty/null track list→`[]`; whitespace track→no spans; heading track flushes only if current chapter has spans; **cross-track pause fold**; per-track speed incl. `0→null`; per-track cast voice + inline `[voice:]` reverting to the *resolved cast voice* not `null` (`alice→[voice:p_bob]→[voice:]`); **`#` inside a multi-line track text does NOT re-chapter**.
- **`/longform/render` reconciliation (§G):** assert the adapter's emitted spans, after the router's `(text.strip(), max(0,int(pause)))` normalization + keep-filter, equal the parser's spans for the same logical script (no span added/dropped/re-clamped differently); a `{text:"  ",pause:0}` span dropped by both; `{text:"",pause:500}` kept by both.
- **Highlight (§I, `storyTokens.test.js` — NEW file):** bare `[pause]`→`{type:'pause',seconds:0.35}`; `[pause 500ms]`→`{type:'pause',seconds:0.5}`; `[pause 0s]`→consumed, no overlay, not spoken; `[voice:]`→consumed as default switch, not spoken; `[voice:p_x]`→subsequent chunk has `profileId:'p_x'`; chunk/pause event ordering preserved; `hasStoryMarkers` recognizes bare `[pause]`, `[pause 500ms]`, `[voice:]`. **Note: `frontend/src/test/storyTokens.test.js` does not exist today — it is a new file.**
- **Pathological/ReDoS:** 5000× `[slow]`, 5000× `[pause`, 5000× `[voice:`, 5000× `# ` lines, and a 5000× mixed-bracket blob — assert each completes < 1 s in both suites (mirrors `ssmlLite.test.js:54`, which uses `'[slow]'.repeat(5000)` and `expect(Date.now()-t0).toBeLessThan(1000)`).

**Python** `tests/test_longform_parser.py`:
- Parametrized over the JSON corpus (`json.load` from `tests/fixtures/longform_parser_cases.json`, `pytest.mark.parametrize` over the array, `ids=[c["name"] for c in cases]`): `parse_script_to_spans(case["input"], default_voice=case["default_voice"], default_speed=case.get("default_speed")) == case["expected"]`.
- `parse_audiobook_script` wrapper still returns `AudiobookPlan`; `.to_dict()` shape unchanged (incl. `char_count`/`chapter_count`). The existing `tests/test_audiobook.py` is the regression net — it already covers (verified line refs): no-headings single chapter (`:22`), H1 chapter split (`:30`), lead-in (`:37`), `[voice:alice]` switch (`:44`), default voice without tag (`:53`), `[pause 500ms]`→500 (`:58`, drift #2 lock already present server-side), empty-chapter drop (`:67`), `.to_dict()` shape (`:72`), ffmetadata + m4b builders (`:81-112`), `synthesize_chapter` stitches spans+silence (`:122`, `:131`). Keep all green.
- Add a direct unit test that `parse_script_to_spans(None)` → `[]` (the wrapper coerces, but the parser must not raise on `None`).
- Existing `tests/test_ssml_lite.py`, `tests/test_pause_markers.py` stay green (those modules are unchanged).

**JS** `frontend/src/test/longformParser.test.js` (NEW):
- Imports the same JSON (spike the resolution path — see Dependencies); `parseScriptToSpans(case.input, { defaultVoice: case.default_voice, defaultSpeed: case.default_speed ?? null })` `toEqual` `case.expected` (`describe.each`/`it.each` over the array, test id = `case.name`).
- ReDoS timing case mirrored.
- `frontend/src/test/storyToSpans.test.js` (current cases verified at `:9-87`): the existing suite already expects H1 chapters (`:23-32`), per-line speed (`:40-43`), SSML override (`:46-55`), `[pause 0.5s]` fold (`:57-62`), mid-line `[voice:]` (`:64-69`), empty-chapter drop (`:71-80`), leading-pause silent span (`:82-87`) — verify the new adapter keeps all passing; **add** the §H adapter cases: `##`-is-body, `[pause 500ms]`/bare `[pause]` fold to silence, cross-track pause fold, `#`-inside-track-text-doesn't-re-chapter, `[voice:]`-reverts-to-cast-voice-not-null, `tk.speed=0→null`.
- `frontend/src/test/storyTokens.test.js` (NEW) — the §I highlight cases above.
- `frontend/src/test/ssmlLite.test.js` unchanged.

**Local gate** (per merge-discipline memory): `uv run pytest tests/test_longform_parser.py tests/test_audiobook.py tests/test_pause_markers.py tests/test_ssml_lite.py -q` and `bunx vitest run`. (Endpoint/torch-importing tests deselected locally per the local-pytest-segfault memory; CI validates the full suite.)

**CodeQL**: confirm `longform_parser.py` regexes carry no overlapping quantifiers; rely on the moved-verbatim heading/voice regexes (already cleared at `audiobook.py:36,42`) and the unchanged `_PAUSE_RE` atomic group (`text.py:233`). For `longformParser.js` (scanned — only `*.test.*` are path-ignored), the pause/voice/tag patterns must be linear (no nested quantifiers, fixed-literal SSML alternation as in `ssmlLite.js:26`). The JS pause regex uses a non-atomic `(?:…)?` optional group (JS has no `(?>…)`); **[verified]** it produces identical match/no-match results to the Python atomic group on the entire dialect + boundary set, and the optional group cannot backtrack polynomially because it contains no internal alternation reachable after a partial match. The widened `storyTokens.js` `TOKEN_RE` is scanned (regular `.js`) — keep it a flat alternation of fixed literals + the same `(\d+(?:\.\d+)?)\s*(ms|s)?` numeric spec (no overlapping `\s*` runs). No new alerts expected.

---

## Constraints

This task is touched by several of OmniVoice's hard rules (CLAUDE.md). Each is satisfied as follows — every relevant rule is stated explicitly so a reviewer can check it off:

- **Cross-platform parity (P0 default rule — macOS/Windows/Linux, default behavior identical):** The parser is pure string→plan logic with **no OS, path, shell, or filesystem call** — so it is identical on all three platforms by construction, and introduces no platform branch and no opt-in toggle. The marker-parsing behavior ships in default mode (no user customization), so the P0 "default must work identically everywhere" rule applies and is met. **One cross-platform subtlety that must be locked, not assumed:** `_HEADING_RE` uses `re.MULTILINE`, whose `^`/`$` anchor on `\n`. A script authored on Windows with `\r\n` line endings: `$` matches before `\n`, so `(\S.*)` could capture a trailing `\r` (e.g. title `"One\r"`), and span text could carry an embedded `\r`. Python `$` and JS `RegExp` `$` (without the JS `s`/`m` `\r` special-casing) both leave a trailing `\r` in the capture. If the two ports normalized `\r` differently the byte-identical contract would break silently on Windows-authored scripts — a default-behavior platform divergence, i.e. a P0 bug. **Decision (locked): normalize `\r\n`/`\r`→`\n` at parser entry in *both* ports** (Python `text = text.replace("\r\n", "\n").replace("\r", "\n")`, JS `text = text.replace(/\r\n?/g, '\n')`) so titles and span text never carry a stray `\r` on any OS. A `\r\n` fixture in the shared corpus proves both ports agree. No other platform-specific behavior exists in this task, so nothing needs an opt-in gate.
- **Local-first guarantee preserved:** No network call, no cloud endpoint, no account, no API key, no telemetry — the parser runs entirely in-process on the user's machine, like the code it replaces. The change adds **no** new outbound path of any kind. (CLAUDE.md "Local-first guarantee preserved".)
- **Backward-compatible engine / on-disk model state:** Parser is text→plan only; no model, weights, or engine code touched. `synthesize_chapter` (`audiobook.py:163-206`), the `chunked_tts` chunker, and `longform_render` are untouched, so users with installed IndexTTS/CosyVoice/etc. need no reinstall. (CLAUDE.md "Existing engine compatibility".)
- **Backward-compatible project data (no migration):** Scripts are free text; **nothing persisted changes shape**. No DB column changes → **no alembic migration** needed (see "DB schema & migration" above for the explicit verified no-op). No `omnivoice_data/` (voices/projects/settings) format change → **no lazy localStorage migration** needed. Existing in-progress story projects keep loading; only their *rendered output* converges to server behavior (see Risk for the intended, user-visible behavior change). (CLAUDE.md "Backward-compatible project data".)
- **Localization (no hardcoded CJK; all UI via i18n `t()`):** This task adds **zero user-facing strings** — it touches no React component copy, no `locales/*.json`, no `t('…')` key, no `LANGUAGES` entry. The marker keywords (`pause`/`voice`/`slow`/`fast`/`emphasis`/`spell`) are **functional grammar tokens** the user types into a script, not localizable UI copy, so they correctly stay as literal English in the parser (the same status the existing `audiobook.py`/`text.py`/`ssml_lite.py` tokens have). The fixture corpus *may* include CJK **narration text** as functional test data (recommended — a `[spell]` case on CJK characters and a `[pause]` between CJK clauses exercise byte-level Python↔JS parity). **CJK-test impact (corrected):** `tests/test_no_hardcoded_cjk.py`'s `_is_allowed` already exempts any path whose components include `tests`/`test`, and any basename matching `.test.`/`test_`/`_test.py` (`test_no_hardcoded_cjk.py:81-94`). The fixture lives at `tests/fixtures/longform_parser_cases.json` (contains `tests`) and the test files are `tests/test_longform_parser.py` / `frontend/src/test/longformParser.test.js` / `frontend/src/test/storyTokens.test.js` (under `tests`/`test`, `.test.` basename) — **all are already allowlisted by the path rule; no `_ALLOWED_FILES` edit is required** even if they carry CJK narration. (If, and only if, a *generated mirror* lands outside any `tests`/`test` path — see Dependencies — and it carries CJK, *that* file would need an `_ALLOWED_FILES` entry; the canonical-single-file layout avoids this.) (CLAUDE.md "Localization (hard rule)".)
- **CodeQL ReDoS-gated (`py/polynomial-redos` + `js/redos`):** Only fixed-literal alternations, atomic groups, and non-overlapping character classes are introduced — per the codeql-redos-regex memory: exclude both delimiters in `[^x]*` (the voice class is `[^\]\[]*`, excluding both brackets), no overlapping `\s*`/`.+` quantifiers, atomic groups OK on Python ≥3.11 (the project mandates 3.11 — verified at `ci.yml:32,223`). The Python heading/voice regexes are **moved verbatim** from `audiobook.py:36,42` where CodeQL has already cleared them; `_PAUSE_RE`'s atomic `(?>…)` group is unchanged. The new `longform_parser.py` is scanned (`backend/`, build-mode none); `longformParser.js` and the widened `storyTokens.js` are scanned (only `*.test.*` are path-ignored, not regular `.js`); the JSON fixture and the test files are **not** scanned (under `tests/` / `*.test.js` `paths-ignore`, `security.yml:97-105`). The JS pause regex uses a non-atomic `(?:…)?` group (JS has no `(?>…)`), proven linear because the optional group has no internal alternation reachable after a partial match (covered by the ReDoS timing fixture). No new alerts expected.
- **Versioning (continuous-to-main patch, no RCs):** This is a behavior-converging **consolidation**, not a release trigger — **no version bump**. Main already rides `0.3.6` (verified across the three lockstep files: `pyproject.toml:7`, `frontend/src-tauri/tauri.conf.json:4`, `frontend/src-tauri/Cargo.toml:3`). The work merges continuously to main in the slices below; the owner tags a `v0.3.Z` patch from main whenever worth cutting. No `-rc` tag, no soak, no `v0.4` deferral.
- **Docs-sync (same-PR rule):** A `docs/`-wide grep for `[pause` / `[voice:` / the chapter-heading dialect found **no user-facing doc** (README, generation-parameters.md) that documents the Stories/audiobook marker units. The only hits are internal spec/competitive docs (`docs/specs/2026-06-13-stories-audiobook-maturity.md:108`, `docs/competitive-analysis.md:1072,1086`, `docs/superpowers/specs/2026-05-30-stories-editor-studio-design.md:57,78`), which describe architecture, not the user-typed grammar. So the docs-sync burden is light — but **re-grep before merge** in case a user-facing dialect doc lands in the interim, and update it in the **same PR** if so. If such a doc lands, it MUST document the exact NO-MATCH boundary (e.g. "`[pause .5s]` and `[pause -5s]` are NOT pauses — they are spoken; only `# <text>` opens a chapter, `##`…`######` narrate as body") so users aren't surprised by the now-converged behavior. (CLAUDE.md "Docs-sync (hard rule)".)
- **GSD workflow enforcement:** Per CLAUDE.md, this planned consolidation executes via `/gsd-execute-phase` (or `/gsd-quick` per slice if the owner prefers) — no raw repo edits outside a GSD workflow unless the owner explicitly bypasses it.

---

## Dependencies

- **No new runtime or dev dependencies.** Pure-Python (`re`, stdlib) + pure-JS. Reuses `omnivoice.utils.text.parse_pause_markers`, `services.ssml_lite` (`parse_ssml_lite`/`spell_out`), `frontend/src/utils/ssmlLite.js` (`parseSsmlLite`/`spellOut`).
- Test infra already present: pytest (`tests/`, run at `ci.yml:67`), vitest (`frontend/src/test/`, run at `ci.yml:107`), shared `tests/fixtures/` dir (already exists with JSON fixtures).
- **Vitest cross-`frontend/` JSON import — pinned facts to spike in slice 2:** `frontend/vite.config.js:30-36` declares the `test` block with **no `server.fs.allow` override**, so vitest inherits Vite's default allow-root = the config dir (`frontend/`). The fixture is at `tests/fixtures/longform_parser_cases.json`, i.e. `../../../tests/fixtures/longform_parser_cases.json` relative to `frontend/src/test/longformParser.test.js` — **outside** `frontend/`. A *static* `import cases from '...json'` is resolved by Vite's transform at load time (which is generally **not** gated by `server.fs.allow` for imported modules, only the dev-server's HTTP file-serving is) and JSON imports are on by default — so the static import is **expected to work**, but **must be verified in slice 2** (`bunx vitest run frontend/src/test/longformParser.test.js`) before committing to the layout. If the static import is blocked, fall back options in order of preference:
  1. Read via Node `fs` in the test (`readFileSync(new URL('../../../tests/fixtures/longform_parser_cases.json', import.meta.url))` + `JSON.parse`) — works in vitest's node-context, no Vite resolution involved.
  2. Add `test.server.fs.allow: ['..']` (or the repo root) to `vite.config.js` `test` block — smallest config change.
  3. **Last resort:** a generated mirror under a `tests`/`test` path inside `frontend/` (e.g. `frontend/src/test/fixtures/longform_parser_cases.json`) regenerated by a CI step. **If a mirror is used, the generator must run in CI and CI must fail if the mirror is stale** (`git diff --exit-code` after regenerating), else the mirror becomes a fourth drift surface — exactly what this task exists to kill. A mirror placed outside a `tests`/`test` path would also fall outside the CJK-test path exemption — keep any mirror under a `tests`/`test` path.

  **Prefer the single canonical file** (`tests/fixtures/longform_parser_cases.json`) via option 1 or 2; only fall to option 3 if both fail.

---

## Risk

- **Behavior change is user-visible** (intended): `##`–`######` lines stop opening chapters in Stories; `# ` / `#   ` (hash with no non-space title) stops opening a chapter and narrates literally; `[pause 500ms]`/bare `[pause]` stop being spoken aloud and become silence; `[voice:]` reverts to default instead of being spoken; `[voice:[nested]]` is spoken literally; `[pause .5s]`/`[pause -5s]`/`[pause 1.2.3s]` are spoken literally (were never pauses, but the convergence makes the boundary sharp). This can change existing in-progress story projects' rendered output. *Mitigation*: it converges client to the already-shipped server behavior (the audiobook side was always H1-only / full-pause / empty-voice→default), the change is documented, and the cross-impl tests pin the new truth. Low blast radius (beta, scripts are re-renderable, **nothing persisted changes shape** so no migration is needed — see Constraints → backward-compatible data).
- **JS↔Python output equality is exacting.** Three concrete divergence risks, all pinned with the exact source lines:
  - **`spell_out` whitespace** — Python `" ".join("".join(word.split()))` (`ssml_lite.py:154-155`) vs JS `(word||'').split(/\s+/).join('').split('').join(' ')` (`ssmlLite.js:81`), **[verified]** identical including the empty-string path.
  - **Double-`.strip()`** of segment text (`_parse_spans:114,119`) — the JS twin must strip at the same two points.
  - **Pause rounding — THE most likely silent divergence.** Python `_pause_ms` does `int(round(ms))` (`text.py:249`), and Python `round()` uses **banker's rounding** on `.5` ties (`round(0.5)`=0, `round(1.5)`=2, `round(2.5)`=2). JS `Math.round` rounds **half-up** (`Math.round(0.5)`=1, `Math.round(1.5)`=2, `Math.round(2.5)`=3) → **DIVERGENCE on exact `.5`-millisecond ties.** The corpus will catch it via `[pause 0.5]`→0 (Python) vs 1 (naïve JS). *Mitigation*: **the JS port must implement round-half-to-even** (`roundHalfToEven`) for its pause-ms resolver, not `Math.round`; lock with `[pause 0.5]`→0 and `[pause 1.5]`→2 fixtures (the second proves the helper isn't just "always floor"). Write all fixtures from actual Python output, then make JS match — never the reverse.
- **`parse_audiobook_script` is a hot path** (4 router call sites: `audiobook.py` router `:82,121,321,480`). *Mitigation*: wrapper preserves exact return type (`AudiobookPlan`) and `.to_dict()` shape; `tests/test_audiobook.py` is the regression net.
- **`storyToSpans` is track-array-shaped, not blob-shaped.** The biggest correctness trap: naïvely joining tracks into one blob and calling `parseScriptToSpans` would (a) lose per-track `speed` and per-track resolved cast voice, (b) let a multi-line *track text* be re-chaptered by `#` lines inside it, and (c) lose the cross-track adjacent-pause fold. *Mitigation*: keep the track loop in `storyToSpans`; call the canonical **`parseChapterBody`** (no chapter split) per track with that track's `defaultVoice`/`defaultSpeed`; only chapter-flush on `isChapterLine(tk.text)`; apply the adjacent-pause fold in the adapter after each per-track call. Cross-check `storyToSpans.test.js:40-87` + the new §H cases.
- **`storyTokens.js` group renumbering.** Widening the pause branch adds a third capture group, shifting voice from group 2 to group 3. `parseStoryText` (`:38-46`) reads `match[1]`/`match[2]` today and must be rewritten (pause = groups 1+2 via `_pause_ms` then `seconds=ms/1000`; voice = group 3). A missed renumber silently mis-routes voice as pause or vice versa. *Mitigation*: the new `storyTokens.test.js` §I cases assert both event types end-to-end.
- **`emphasis` flag is silently dropped from the span dict.** The SSML segment carries an `emphasis` bool but `SpanDict` only has `speed`/`spell`-derived fields; `_parse_spans` reads only `seg["speed"]`/`seg["spell"]`. This is current behavior (`[emphasis]` only affects speed → 0.92), but a reviewer may expect emphasis to survive. *Mitigation*: lock it in a fixture (an `[emphasis]` span has `speed:0.92` and no other distinguishing field) and note it's intentional/out-of-scope (no new markers/features).
- **Vitest reading a file under `tests/`** may need config. *Mitigation*: spike the JSON import in slice 2 before committing (the import is expected to work statically; fall-back ladder in Dependencies); a generated mirror is the last resort and must be CI-staleness-gated and kept under a `tests`/`test` path.
- **`storyToSpans` cast resolution** (`effectiveProfile`, `storyCast.js:21`) stays client-only — the canonical parser is voice-id-agnostic. Ensure the adapter resolves cast → voice_id *before* calling `parseChapterBody`, matching today's `storyToSpans.js:33` behavior, and that an inline `[voice:]` reverts to the *resolved cast voice* (the `defaultVoice` passed in), **not** to `null`.
- **`\r\n` line endings** (Windows-authored scripts) could leave a stray `\r` in titles/body and diverge silently between the two `$`-anchor implementations — a cross-platform default-behavior divergence (P0). *Mitigation*: normalize `\r\n`/`\r`→`\n` at parser entry in **both** ports (locked decision in Constraints); lock with a `\r\n` fixture.

---

## PR slices

Each slice is independently green and small enough to review. Each merges continuously to main (no RC, no soak — versioning rule); no version bump.

1. **PR 27a — Python canonical parser + fixture corpus.** Add `backend/services/longform_parser.py` (`parse_script_to_spans`, `_parse_chapter_body`, moved heading/voice regexes from `audiobook.py:36,42`, moved `ssml_lite` import from `audiobook.py:106`, `\r\n`-normalization + `None`-coercion at entry), rewrite `parse_audiobook_script` (`audiobook.py:135`) as a wrapper, delete `_parse_spans` (`:93-132`), drop the now-dead `from omnivoice.utils.text import parse_pause_markers` (`audiobook.py:29`), add `tests/fixtures/longform_parser_cases.json` (≥40 cases per the enumerated edges) + `tests/test_longform_parser.py` (parametrized over the corpus + a direct `None`-input unit test). `tests/test_audiobook.py` stays green. No frontend change. (CodeQL runs on the new module.)
2. **PR 27b — JS canonical port + cross-impl test.** Add `frontend/src/utils/longformParser.js` (`parseScriptToSpans`, `parseChapterBody`, `parsePauseMarkers`, `parseVoiceRuns`, `roundHalfToEven` for `_pause_ms`, `\r`-normalization, empty-guard, exported `PAUSE_DEFAULT_MS`/`PAUSE_MAX_MS`) + `frontend/src/test/longformParser.test.js` consuming the **same** corpus (spike the cross-`frontend/` JSON import here first per Dependencies). Widen `storyTokens.js:23` `TOKEN_RE` (pause units + `[^\]\[]*` voice, group renumber) and `:57` `hasStoryMarkers` (bare/ms pause); narrow `storyExport.js:64` `isChapterLine` (H1 + `\S` title) / `:69` `chapterTitle` to H1 (remainder verbatim). Reimplement `storyToSpans.js:21-54` as the track→canonical adapter (per-track voice/speed, cross-track pause fold, no re-chapter on embedded `#`). Add `frontend/src/test/storyTokens.test.js` (NEW, §I highlight cases). Update `frontend/src/test/storyToSpans.test.js` for the H1/pause/voice convergence + the new §H adapter cases. Verify `StoriesEditor.jsx:294,307` preview + `:363,368` `/longform/render` plan still build (wire shape `LongformRenderBody` unchanged), and that the §G router-keep-rule reconciliation holds.
3. **PR 27c — Docs + cleanup.** Update any user-facing `docs/**` marker-dialect reference if one has landed (re-grep `[pause`/`[voice:`/chapter-heading); if added, document the NO-MATCH boundary. Remove the now-misleading "keep in sync with backend/services/ssml_lite.py" header comment (`ssmlLite.js:2`) — replace with "verified by the cross-impl corpus in `tests/fixtures/longform_parser_cases.json`". Add a one-line note in `CLAUDE.md` Architecture recording the canonical-parser location if the owner wants it.

(27a + 27b could merge as one PR if the owner prefers atomic convergence; keeping them split lets the Python core land and bake first.)

---

## Acceptance criteria

- [ ] `parse_script_to_spans` exists in `backend/services/longform_parser.py` with signature `parse_script_to_spans(text: str | None, *, default_voice: str | None = None, default_speed: float | None = None) -> list[dict]` (accepts `None`, normalizes `\r\n`/`\r`→`\n`); `_parse_chapter_body(body, *, default_voice, default_speed) -> list[dict]` exported for the JS twin to mirror; `parse_audiobook_script` (`audiobook.py`) delegates to it and still returns an `AudiobookPlan` with the same `.to_dict()` shape (`{"chapters":[{"title","char_count","spans":[{"voice_id","text","pause_ms_after","speed"}]}],"chapter_count","char_count"}`); `_parse_spans`/`_HEADING_RE`/`_VOICE_RE` removed from `audiobook.py`; the dead `parse_pause_markers` import (`audiobook.py:29`) dropped.
- [ ] `parseScriptToSpans(text, { defaultVoice, defaultSpeed })` exists in `frontend/src/utils/longformParser.js` with `parseChapterBody(body, { defaultVoice, defaultSpeed })`, `parsePauseMarkers`, `parseVoiceRuns` exported (and the same `\r`-normalization, `roundHalfToEven` pause rounding, `PAUSE_DEFAULT_MS`/`PAUSE_MAX_MS` constants); `storyToSpans(tracks, cast)` reimplemented over `parseChapterBody` as the per-track adapter (cast + speed resolved before the call; cross-track pause fold; no re-chapter on embedded `#`), public signature `→ Array<{title, spans:[{voice_id,text,pause_ms_after,speed}]}>` unchanged.
- [ ] `tests/fixtures/longform_parser_cases.json` exists with **≥ 40 cases** matching the documented schema (`{name, input, default_voice, default_speed?, expected}` where `expected` is a list of `{title, spans:[{voice_id,text,pause_ms_after,speed}]}`), covering every drift + grammar rule + edge case in the Test plan (§A–I), including the NO-MATCH pause lock-set, the `\r\n` case, the `.5`-tie pause-rounding cases (`[pause 0.5]`→0, `[pause 1.5]`→2), the `[voice:[nested]]` literal case, the `# `-no-title-is-body case, and the chapter-voice-reset case.
- [ ] `tests/test_longform_parser.py` (pytest, parametrized over the JSON) and `frontend/src/test/longformParser.test.js` (vitest, same JSON) both pass; manually mutating one impl's output makes its suite fail (drift is caught); `parse_script_to_spans(None)`→`[]` covered by a direct unit test.
- [ ] Drift #1 fixed: `## Heading` (and `###`…) narrates as body in **both** impls; `# ` / `#   ` (no non-space title) narrates as body in both; only `# <non-space>…` opens a chapter (`isChapterLine` narrowed to H1 + `\S`, matching `_HEADING_RE`).
- [ ] Drift #2 fixed: `[pause]`, `[pause 500ms]`, `[pause 1.5s]` all become silence (never spoken) in **both** impls, with identical `pause_ms_after` (350/500/1500); the NO-MATCH boundary (`[pause .5s]`/`[pause -5s]`/`[pause 1.2.3s]`/`[pause1s]`) is identical in both (spoken literally); `storyTokens.js` `TOKEN_RE` no longer drops `ms`/bare forms (group renumbered, `parseStoryText` reads group 1+2 for pause, group 3 for voice); `hasStoryMarkers` recognizes bare `[pause]`.
- [ ] Drift #3 fixed: `[voice:]` / `[voice:  ]` revert to default in both impls (no longer spoken literally on the client); `[voice:[nested]]` spoken literally in both; voice class is `[^\]\[]*` in both; voice resets to default at each chapter boundary.
- [ ] Speed: inline SSML speed overrides per-line `default_speed`; `default_speed=None`→`speed:null`; `tk.speed=0`→`speed:null` (adapter falsy-zero). `storyToSpans.test.js:40-55` speed cases pass.
- [ ] Pause-rounding parity: JS `parsePauseMarkers` uses `roundHalfToEven` on `.5`-ms ties (`[pause 0.5]`→0 and `[pause 1.5]`→2 in both ports).
- [ ] Cross-platform parity: a `\r\n`-authored input produces byte-identical output in both ports (no stray `\r` in title or span text); default marker behavior is identical on macOS/Windows/Linux (no platform branch, no opt-in gate needed because nothing platform-specific is introduced).
- [ ] Request/response wire shapes unchanged: `AudiobookPlanRequest`/`AudiobookPreviewRequest`/`AudiobookRequest`/`LongformRenderRequest` (+ `LongformSpan`/`LongformChapter`) identical; `/audiobook/plan` & `/audiobook/preview` JSON responses identical; the SSE event union (`started`/`chapter`/`chapter_error`/`assembling`/`done`/`error`) and field sets identical; `frontend/src/api/audiobook.ts` `LongformRenderBody` unchanged (the pre-existing `lexicon` omission is left as-is, not "fixed").
- [ ] `StoriesEditor.jsx:294` preview gate (`hasStoryMarkers`), `:307` highlight (`parseStoryText`) and `:363` render plan (`storyToSpans`) build and behave as before, except the intended H1/pause/voice convergence; the `/longform/render` span-keep + clamp rule (`router :530-532`) agrees with the parser's keep rule for the reconciliation fixtures (§G); no span is added/dropped/re-clamped differently between adapter output and parser output.
- [ ] Existing `tests/test_audiobook.py`, `tests/test_ssml_lite.py`, `tests/test_pause_markers.py`, `frontend/src/test/ssmlLite.test.js`, `frontend/src/test/storyToSpans.test.js` remain green.
- [ ] ReDoS cases (5000× `[slow]`/`[pause`/`[voice:`/`# `/mixed) complete < 1 s in both suites; CodeQL `security-and-quality` reports **no new** `py/polynomial-redos` / `js/redos` alerts on `longform_parser.py` / `longformParser.js` / the widened `storyTokens.js`.
- [ ] `bunx vitest run` and the local pytest subset pass; full CI (`ci.yml` + `security.yml`) green before merge (per merge-discipline gate). If a generated fixture mirror is used, CI fails on a stale mirror.
- [ ] No version bump (main stays `0.3.6` across the three lockstep version files); **no DB/alembic migration and no `omnivoice_data/` migration** introduced (scripts are free text; verified no-op per "DB schema & migration").
- [ ] Any user-facing `docs/**` page describing the marker dialect updated in the same PR if present (docs-sync rule; current grep shows none — re-verify at merge); `tests/test_no_hardcoded_cjk.py` green with **no `_ALLOWED_FILES` edit** (the fixture + test files are already exempt by the `tests`/`test` path rule, even if they carry CJK narration data).
