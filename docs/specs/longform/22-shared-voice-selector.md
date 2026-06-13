# TASK #22 — Shared `<VoiceSelector>` component (Stories / Audiobook / Dub)

> **Grounding note (lens pass 1/10, verified against working tree on `feat/stories-shared-render`):** every `file:line` below was re-checked against the actual code. Several line ranges in the prior draft were stale (the files have grown). Corrected anchors are inline; where a prior reference was wrong or non-existent it is called out with **[corrected]**. Frontend paths are rooted at `frontend/src/`.
>
> **Grounding note (lens pass 2/10 — COMPLETENESS, re-verified against working tree):** This pass enumerates every edge case, empty/error/failure path, and state the component must handle. It corrects three latent bugs the prior draft hand-waved past, all confirmed against the actual `SearchableSelect` and `VoicePreview` source: (a) `SearchableSelect.commit` **unconditionally pushes the committed value into recents** (`SearchableSelect.jsx:120-129`, the write at `:123-127`) — so `''`/`preset:`/`auto:` sentinels would pollute recents and re-surface as unresolvable pinned rows; (b) `SearchableSelect.currentLabel` **falls back to the raw value string or placeholder** when the value isn't found in `options` (`:58-61`) — so an engine-default `''` value rendered as a "fixed top row outside the searchable array" (the prior design) would display the *placeholder*, not the intended default label, and a `preset:`/`auto:` value would show its raw machine string on the trigger; (c) `VoicePreview` **only re-syncs its internal `voiceId` when `initialProfileId` is truthy** (`VoicePreview.jsx:34-36`) — re-opening preview for an engine-default (`''`) selection leaves the previous voice stale. The design below resolves all three explicitly rather than leaving them as "and then it just works."
>
> **Grounding note (lens pass 3/10 — PROJECT CONSTRAINTS, re-verified against working tree):** This pass makes the spec *explicitly* satisfy each OmniVoice hard rule (see the expanded **Constraints** section), and corrects/sharpens four constraint-relevant facts confirmed in source: (i) there are exactly **21** locale files in `frontend/src/i18n/locales/` (`ar de en es fr hi id it ja ko nl pl pt ru sv th tr uk vi zh-CN zh-TW`) and **none** currently contains a `voiceSelector` namespace (`grep voiceSelector en.json` → 0 hits) — so all keys in this task are net-new and must land in all 21 in the same PR; (ii) the only user-input-touching regex in the whole feature is the auto-speaker slug `/\s+/g` at `DubSegmentRow.jsx:298` — it is linear (single `\s` char-class, one `+`, no nesting/overlap), so it is **ReDoS-clean**, and because CodeQL's `py/polynomial-redos` is a *Python* query it does not scan JS at all; this task touches **zero Python**, so the ReDoS gate is N/A by construction and the one JS regex is clean regardless; (iii) recents persistence is `localStorage` only (`SearchableSelect.jsx:7-18`), read through a malformed-data-tolerant `try { JSON.parse } catch { return [] }` (`:7-12`), so the "backward-compatible project data" rule is met by *lazy tolerance*, not alembic — there is **no DB and no schema** in this frontend-only change; (iv) the existing `recentsKey` convention is `omnivoice.recents.*` (live use at `CloneDesignTab.jsx:675`), which the four new per-site keys follow exactly.
>
> **Grounding note (lens pass 4/10 — API + DATA SHAPES, re-verified against working tree):** This pass pins every request/response shape, event type, persisted-data layout, and function signature a developer touches, so nothing is guessed. Corrections/sharpenings confirmed in source this pass: (1) **there is no new HTTP API and no SSE in this task** — the only network call any code path here reaches is the *existing* `generateSpeech(formData, { signal })` → `POST /generate` (`api/generate.ts:3-9`, **note: it is `generate.ts`, not `generate.js`**), invoked indirectly when the preview button opens `VoicePreview`; its exact `FormData` request shape is now pinned below (§ **API / data shapes → Preview request contract**) because that is the single "wire shape" this feature can produce; (2) the audiobook SSE stream (`started`/`chapter`/`assembling`/`chapter_error`/`done`/`error`, `AudiobookTab.jsx:151-167`) is **read by `AudiobookTab`, not by `VoiceSelector`** — VoiceSelector emits only the `default_voice` *string* that feeds those existing calls, so the SSE event types are documented here as **context the selector must not break**, not as something it parses; (3) the one persisted client-side data structure is the recents `localStorage` blob — pinned below as an exact type (`string[]`, cap 8, no version field, `JSON.stringify`'d, key = `recentsKey`); (4) the option object that `SearchableSelect` consumes is now given a precise schema with required/optional fields and the exact `getVal`/`getLabel` contract it must satisfy (`SearchableSelect.jsx:45-50`); (5) the store field types are confirmed verbatim — `CastMember.profileId: string | null` (`storiesSlice.ts:25`), `StoryTrack.profileId: string | null` (`:16`), and `openVoiceProfile(id: string)` (`uiSlice.ts:75`, impl `:108-115`); (6) `Profile` (`api/types.ts:109-123`) confirmed to **not** declare `instruct` and to declare `kind: 'clone' | 'design'` (`:107`, `:112`) — the grouping uses runtime `.instruct`, not `.kind` (see Option model note).

## TL;DR

Three tabs each hand-roll their own voice `<select>` with subtly different option groupings, none of them share recents/search, and only one (`VoicePreview`) lets you hear a voice before committing. Extract a single `frontend/src/components/VoiceSelector.jsx` that wraps the existing `SearchableSelect` (`frontend/src/components/SearchableSelect.jsx`, 216 lines), renders the four standard option groups (clone profiles / designed voices / presets / engine-default, plus optional dub "from video" auto-speakers), and exposes three optional adornments: an **inline preview** button (absorbs QW6), an **inline "Create voice"** slot (sets the pattern for #25), and a **"Open in gallery"** jump. Then migrate the cast picker + per-line override in `StoriesEditor.jsx`, the default-voice picker in `pages/AudiobookTab.jsx`, and the per-segment picker in `DubSegmentRow.jsx` onto it. Pure frontend; **no new HTTP endpoint, no new SSE event, no backend, no API surface change, no DB schema**, no Python touched, no DB migration, no new dependency. The only wire shape any path here can reach is the *pre-existing* `POST /generate` multipart call that `VoicePreview` already makes (pinned below). Default behavior is identical on all three platforms (constraint-clean by construction — see **Constraints**).

## Problem

Voice picking is duplicated and inconsistent across the codebase. **Verified locations:**

- **StoriesEditor cast panel** — plain `<select className="stories-cast__select">` (`StoriesEditor.jsx:550-558`, class at `:551`): options are `profiles.map((p) => <option …>)` (`:557`) with a single "Default" option (`:556`, `t('stories.defaultVoice')`), **no preset/designed grouping, no search**. `onChange` calls `setCharacterVoice(c.id, e.target.value || null)` (`:553`). Pain at scale: a user with 50 cloned voices scrolls a flat list per cast member.
- **StoriesEditor per-line override** — second plain `<select className="stories-track__character">` (`StoriesEditor.jsx:708-716`, class at `:709`): same flat list (`:715`), plus an inherited-voice hint rendered into the `''` option only — `{inheritedName ? \`↳ ${inheritedName}\` : t('stories.defaultVoice')}` (`:714`). `onChange` calls `updateTrack(track.id, 'profileId', e.target.value || null)` (`:711`). `inheritedName` is derived at `:670` via `profileName(inheritedId)` (`profileName` defined at `:434`).
  - **[corrected]** There is also a *third* `<select className="stories-track__voice-select">` at `StoriesEditor.jsx:698-705` (class at `:699`) — but that one picks the **cast character** for a line (`updateTrack(track.id, 'character', …)` at `:701`), **not** a voice profile. It is out of scope (same exclusion class as the dub speaker-name input). Do **not** migrate it.
- **AudiobookTab default voice** — plain `<select className="input-base">` (`pages/AudiobookTab.jsx:220-224`): flat `profiles.map` (`:223`), `t('audiobook.engine_default')` sentinel for `''` (`:222`), no presets, no search, no preview. `value={defaultVoice}` / `onChange={(e) => setDefaultVoice(e.target.value)}` (`:220-221`).
- **DubSegmentRow per-segment** — plain `<select className="input-base seg-profile-select">` (`DubSegmentRow.jsx:288-313`): the *most* complete grouping — from-video auto-speakers (`:295-302`) + clone profiles (`:303-307`) + presets (`:308-312`) — but still no search and no preview. `onChange={(e) => onEditField(seg.id, 'profile_id', e.target.value)}` (`:292`).
- **VoicePreview** (`components/VoicePreview.jsx`, 183 lines) — the only picker with full clone/designed/preset grouping (`<select>` at `:113-140`, grouping `:119-139`), and the only path with audible preview. It is a floating bottom-right popover, not an inline field. **[corrected]** The grouping/instruct anchors moved: grouping is `VoicePreview.jsx:119-139`, preset/instruct derivation is `VoicePreview.jsx:58-67`, and the network call it makes is `generateSpeech(fd, { signal })` at `VoicePreview.jsx:72` (request shape pinned in **API / data shapes**).

Net effect: four different option-grouping rules, **three** different "default" sentinel labels (`stories.defaultVoice`, `audiobook.engine_default`, `segment.voice_default`), zero shared search/recents, and preview only reachable from the global floating card. QW6 (inline preview) and #25 (inline create) both need a home; without consolidation they'd get bolted onto three files independently.

## Goal / Non-goals

**Goals**

1. One `<VoiceSelector>` used by StoriesEditor (cast + per-line override), AudiobookTab (default voice), and DubSegmentRow (per-segment).
2. Consistent option grouping: **Clone profiles** / **Designed voices** / **Presets** / an **engine-default** sentinel, plus an opt-in **From video** group (dub auto-speakers).
3. Searchable + recents (reuse `SearchableSelect`), so 50-voice casts are usable.
4. **Inline preview** (QW6): an optional play button beside the field that auditions the selected voice without leaving the tab. Reuses the existing `VoicePreview` open mechanism — no new audio plumbing, no new endpoint (the audition reuses the existing `POST /generate` call inside `VoicePreview`).
5. **Inline create** slot (#25 pattern): an optional "+ Create voice" affordance; this PR wires the *slot and callback prop only*, #25 fills the actual create flow.
6. **Open in gallery** jump: optional affordance that calls `openVoiceProfile(id)` (`store/uiSlice.ts:75` decl, `:108-115` impl).
7. Identical default behavior across macOS / Windows / Linux (no platform branches — see **Constraints**).

**Non-goals**

- Building the actual inline-create form/flow — that is #25; this task only exposes `onCreateVoice` + a render slot and proves it fires.
- Touching the backend, `/generate`, `/profiles`, the audiobook SSE stream, or any schema. **No new HTTP route, no new SSE event type, no request/response field added or changed.** Zero new deps. **Zero Python.** No alembic migration (frontend-only; no DB column changes).
- Replacing the `VoicePreview` floating card itself (it stays; the selector just *triggers* it).
- **[corrected]** Replacing the `seg.speaker_id` speaker-name **datalist input** in `DubSegmentRow.jsx:213-229` (`<input className="seg-speaker-input">` + `<datalist id={speakerListId}>`) — that is detected-speaker *labeling*, not voice selection; out of scope.
- **[corrected]** Migrating the StoriesEditor *character* picker (`StoriesEditor.jsx:698-705`, `stories-track__voice-select`), the StoriesEditor per-line *menu* voice shortcut (`StoriesEditor.jsx:719-732`, the `Users`-icon `<Menu>` calling `setVoiceForSelection`), or the `CloneDesignTab` language `SearchableSelect` (`pages/CloneDesignTab.jsx:671`). None of these are voice-profile `<select>`s in the target pattern.
- Migrating `WorkspaceVoices` / `CloneDesignTab`. (`WorkspaceVoices.jsx` has no voice `<select>` — it's a card grid.)
- i18n key removal — keep the existing per-tab keys working; add a shared `voiceSelector.*` namespace.

## Design

### New file: `frontend/src/components/VoiceSelector.jsx`

A thin, controlled wrapper over `SearchableSelect` that:

1. Builds a flat `options` array (one entry per voice) tagged with a `group` field, then renders via `SearchableSelect`'s existing `renderOption` / `renderLabel` hooks (`SearchableSelect.jsx:46-50`, `:201`). `SearchableSelect` already supports search (`:63-67`), keyboard nav (`:131-139`), recents (`recentsKey` → `readRecents`/`writeRecents`, `:7-18`, `:69-85`), and a `MAX_DISPLAY = 200` cap (`:5`, `:87`) — we reuse all of it rather than reimplementing.
2. Normalizes the **value contract** to match what callers already send to the backend: profile id (e.g. `"p_abc"`), `"preset:<id>"`, dub `"auto:<slug>"`, or `""` (engine default). No translation layer — the value the selector emits is exactly what `setCharacterVoice` / `updateTrack('profileId', …)` / `setDefaultVoice` / `onEditField(seg.id, 'profile_id', …)` already expect. (This identity is what makes the **backward-compatible project data** rule trivially hold — see **Constraints**.)
3. Renders optional trailing adornments in a flex row: **preview** (`Play`/`Loader` from `lucide-react`), **gallery jump** (`ExternalLink`), and the **create** slot.

**The engine-default sentinel is an option IN the searchable array, not a separate fixed row. [corrected — completeness]** The prior draft said "The engine-default sentinel (`''` value) is rendered as a fixed top row, not part of the searchable array." That is **wrong** for two reasons confirmed in source:
- `SearchableSelect.currentLabel` (`SearchableSelect.jsx:58-61`) computes the **trigger** text by looking up `byVal.get(value)`. If `''` is not in `options`, `byVal.get('')` is `undefined`, and the trigger falls back to `(value || placeholder)` → renders the `placeholder` ("Select…"), **never the intended "Engine default" / "↳ Aria" label.** The current `<select>`s all show the default label on the closed control; we must preserve that.
- Selecting "engine default" must commit `''` through `onChange`. A fixed row outside the array would need its own click handler bypassing `commit`, duplicating logic and skipping the recents/highlight machinery.

  **Therefore VoiceSelector prepends the engine-default option `{ value: '', label: <defaultLabel||t('voiceSelector.engineDefault')>, group: 'default', groupLabel: '' }` as the **first** entry of the `options` array (no group header for it — `groupLabel: ''` suppresses the header; see grouping mechanism). It is searchable like any other row, its trigger label resolves correctly, and selecting it commits `''`.** The `defaultLabel` prop overrides only this row's label text (for the Stories inherited "↳ Aria" case).

**Recents must NOT capture sentinel values. [corrected — completeness]** `SearchableSelect.commit` (`:120-129`) **always** writes the committed value into recents when `recentsKey` is set (write at `:123-127`) — including `''`, `preset:<id>`, and `auto:<slug>`. Consequences if left unguarded:
- `''` would become a pinned "recent," rendering as the engine-default row duplicated in the pinned header — and on a different `recentsKey` collision could even surface as an empty-string ghost row.
- A `preset:` / `auto:` value lands in recents; on the *next* mount of a selector with a different prop config (e.g. a Stories cast picker where `presets` is off), `byVal.get('preset:narrator')` returns `undefined`, so `pinned` (`:73-85`) silently skips it (`if (o && …)` at `:75`), but the recents list still carries dead entries that crowd out real ones (cap of 8, `:17`/`:124`).

  **Resolution: VoiceSelector passes a `recentsKey` ONLY for the four migration sites, and adds a guard so sentinels are not stored.** Since `commit` lives in `SearchableSelect`, add an optional `isRecentable?: (value: string) => boolean` prop to `SearchableSelect` (default `() => true`, backward compatible) consulted at `:123` before pushing to recents. VoiceSelector passes `isRecentable={(v) => !!v && !v.startsWith('preset:') && !v.startsWith('auto:')}` so **only real profile ids are recorded as recents.** This keeps recents meaningful (a user's recently-used *voices*, not "I picked engine default once"). Test #11 covers it. (This guard also keeps the persisted `localStorage` recents format forward/backward-clean — see the **backward-compatible project data** note in **Constraints**, and the exact persisted shape in **API / data shapes → Persisted recents shape**.)

**Grouping mechanism — `SearchableSelect` extension.** `SearchableSelect` today renders a single flat list (`flatItems`, `:89-94`) with one optional pinned "recents/popular" header (the only existing `.ss-group-label` usage, `:178-182`). It has no per-group headers. **Chosen approach:** add a minimal, backward-compatible `renderGroupHeaders` boolean prop (default `false`, so the two existing call sites are unaffected) that, when `true`, emits a `.ss-group-label` row whenever `option.group` changes **and `option.groupLabel` is non-empty** while walking `flatItems` in the render at `:184-206`. Grouping logic stays in one place (VoiceSelector builds an already-group-ordered `options` array) and reuses the `.ss-group-label` class already defined at `index.css:1660`. The group-label *text* is supplied per option via a new optional `groupLabel` field on the option object (VoiceSelector sets it from `t('voiceSelector.*')`); `SearchableSelect` only decides *when* to emit a header (group changed AND groupLabel truthy AND `it.kind === 'main'`) and renders `option.groupLabel`.

> **Header-emit pseudocode (so the developer doesn't guess the placement at `:184-206`):**
> ```jsx
> // inside the flatItems.map at SearchableSelect.jsx:184, before the <div className="ss-option">:
> let lastGroup;                                  // declared once outside the map
> // ...
> const opt = it.o;
> const showHeader =
>   renderGroupHeaders &&
>   it.kind === 'main' &&                          // never for recent/popular pinned rows
>   opt && opt.groupLabel &&                       // skip the engine-default row (groupLabel: '')
>   opt.group !== lastGroup;                        // first option of a new group only
> if (it.kind === 'main') lastGroup = opt?.group;  // advance only on main rows
> return (
>   <React.Fragment key={`${it.kind}-${v}-${idx}`}>
>     {showHeader && <div className="ss-group-label">{opt.groupLabel}</div>}
>     <div data-idx={idx} className={`ss-option …`} …>…</div>
>   </React.Fragment>
> );
> ```
> `lastGroup` is reset to `undefined` on each render (it's a `let` inside the JSX return body, recomputed every render — do not memoize it). This keeps the header purely a function of group-order in `flatItems`.

**Group headers interact with the pinned-recents header — spell out the ordering. [completeness]** `flatItems` (`:89-94`) is `[...pinned, ...displayed]`. The existing pinned header (`:178-182`) renders once, before everything. When `renderGroupHeaders` is on:
- **State: query empty, recents present.** The pinned "Recent & Popular" header renders first (`:178`, key `common.recent_and_popular`), then the recent/popular rows (which carry `kind: 'recent'|'popular'`, not `'main'`, and whose underlying `option.group` we **must not** emit a group header for — the `it.kind === 'main'` guard handles this). Then the grouped main list begins, emitting Clone/Designed/Presets/From-video headers as `option.group` changes. This is the intended behavior; a recent voice appears twice (once pinned, once in its group) — that matches `SearchableSelect`'s existing pinned-vs-main duplication and is acceptable.
- **State: query non-empty.** `pinned` is `[]` (`:70`), so no pinned header; only the matching grouped rows with their headers. A group whose filtered members are all excluded by search emits **no** header (because no `main` option with that `group` survives the walk → `opt.group !== lastGroup` is only checked against surviving rows). Verified-by-design: the header is emitted lazily as we encounter the first option of a new group, so empty groups never produce a stray header.
- **State: a group has zero members** (e.g. no designed voices). VoiceSelector simply omits those options from the array, so the walk never sees that `group` → no header. No "Designed voices (empty)" artifact.
- **MAX_DISPLAY truncation (`:87`, `:208`).** If `filtered.length > 200`, `displayed` is the first 200 *in group order* (VoiceSelector already group-orders the array, so truncation cuts the tail groups, not the middle). The existing "showing N of M" footer (`:208-210`, key `common.showing_of` with `{ shown, total }` interpolation) still renders. A user with 200+ voices may not see the Presets group if it sorts after 200 clones — acceptable and pre-existing behavior; documented in the prop JSDoc. (Search narrows below the cap, so presets remain reachable by typing.)

> **[corrected]** The prior draft claimed grouping "matches the existing `.ss-group-label` styling already in index.css" and cited a range `1603-…`. Verified: `.ss-*` block runs from `index.css:1603` (`.ss-wrap`) through the list styles; `.ss-group-label` is the single rule at `index.css:1660`. Reuse it; no new CSS rule strictly required for the header, though VoiceSelector's own adornment row needs styling (see CSS file below).

### Option model (exact schema)

The object `SearchableSelect` consumes is **untyped today** — `getVal`/`getLabel` (`SearchableSelect.jsx:45-50`) accept either a string or `{ value, label }`. VoiceSelector always emits the object form. Pin the schema so the two new optional fields (`group`, `groupLabel`) are unambiguous:

```ts
/** What SearchableSelect consumes. VoiceSelector emits these, group-ordered. */
interface VoiceOption {
  value: string;          // REQUIRED. '' | profileId | 'preset:<id>' | 'auto:<slug>'.
                          //   This is exactly what getVal() returns (SearchableSelect.jsx:45)
                          //   and exactly what commit() passes to onChange (:121-122).
  label: string;          // REQUIRED, non-empty. Trigger + row text. getLabel() coalesces
                          //   label ?? value ?? '' (:49) but VoiceSelector guarantees a
                          //   non-empty human string (never the raw id for a real voice).
  group: 'default' | 'fromVideo' | 'clone' | 'designed' | 'preset';  // REQUIRED. Sort/header key.
  groupLabel: string;     // REQUIRED. Header text for this group; '' suppresses the header
                          //   (used for the 'default' row). Read by SearchableSelect only when
                          //   renderGroupHeaders && it.kind === 'main' && groupLabel (see pseudocode).
}
```

Concrete instances (the literal strings a developer should expect to see):

```js
// engine-default sentinel — FIRST, no header (groupLabel '')
{ value: '',                 label: t('voiceSelector.engineDefault'), group: 'default',   groupLabel: '' }
// cloned profile (falsy .instruct)
{ value: 'p_abc',            label: 'Aria',                           group: 'clone',     groupLabel: t('voiceSelector.clone') }
// designed profile (truthy .instruct)
{ value: 'p_xyz',            label: 'Narrator',                       group: 'designed',  groupLabel: t('voiceSelector.designed') }
// preset (PRESETS[].id)
{ value: 'preset:narrator',  label: '🎙️ Authoritative',              group: 'preset',    groupLabel: t('voiceSelector.presets') }
// dub auto-speaker (slug of speakerClones key) — dub only
{ value: 'auto:speaker_1',   label: '🎤 Speaker 1',                   group: 'fromVideo', groupLabel: t('voiceSelector.fromVideo') }
// ghost: value present but profile deleted (see edge cases)
{ value: 'p_gone',           label: t('voiceSelector.missingVoice'),  group: 'clone',     groupLabel: t('voiceSelector.clone') }
```

> **Localization note (constraint):** the `🎙️`/`🎤` glyphs are emoji, not CJK, and already live in `PRESETS[].name` (`constants.js:34-45`, e.g. `'🎙️ Authoritative'` at `:34`) and the dub label (`DubSegmentRow.jsx:299`, `🎤 {spk}`); they are functional/visual identifiers, not user-facing translatable copy, so they have **no** `test_no_hardcoded_cjk` impact. Every *textual* label above (`engineDefault`, `clone`, `designed`, `presets`, `fromVideo`, `missingVoice`) resolves through `t('voiceSelector.*')` — no string literal escapes the i18n layer (see **Constraints → Localization**). Note `PRESETS` includes `'🌶️ 四川话'` (`constants.js:44`) — that CJK lives in `constants.js`, is already shipped, and is a model-vocabulary identifier, not new copy this task introduces.

Group **order** is fixed: `default` → `fromVideo` (dub only) → `clone` → `designed` → `preset`. (Mirrors `DubSegmentRow.jsx:294-312`, which puts from-video first; for non-dub sites the `fromVideo` group is simply absent.)

Grouping rule (single source of truth in VoiceSelector; mirrors `VoicePreview.jsx:119-139` and `DubSegmentRow.jsx:295-312`):
- `group: 'default'` → always present when `engineDefault` is true (default); value `''`, label = `defaultLabel ?? t('voiceSelector.engineDefault')`; `groupLabel: ''` (no header).
- `group: 'clone'` → `profiles.filter(p => !p.instruct)` (matches `VoicePreview.jsx:121`)
- `group: 'designed'` → `profiles.filter(p => !!p.instruct)` (matches `VoicePreview.jsx:128`)
- `group: 'preset'` → `PRESETS` (`utils/constants.js:33-46`) when `presets` prop is true; option value `preset:${p.id}`, label `p.name` (matches `VoicePreview.jsx:136`, `DubSegmentRow.jsx:310`)
- `group: 'fromVideo'` → `Object.keys(speakerClones)` mapped to `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}`, label `🎤 ${spk}` — **slug rule copied verbatim from `DubSegmentRow.jsx:298`** (the existing code defends against a null key with `(spk || '')` — copied above) so emitted `auto:` values stay byte-identical to today's dub output. **Regex-safety (constraint):** `/\s+/g` is a single-character-class quantifier with no nesting or alternation overlap → linear-time, ReDoS-clean; it is also JS (not Python), so CodeQL's `py/polynomial-redos` does not apply (see **Constraints → CodeQL**).

> **[corrected — grouping uses `.instruct`, not `.kind`]** `Profile.kind` is `'clone' | 'design'` (`api/types.ts:107`, `:112`). It would be tempting to group on `kind === 'design'`, but the codebase splits clone-vs-designed on the **runtime `.instruct` string**, not `kind` (every existing reader: `VoicePreview.jsx:119`/`:126`, etc.). To stay byte-identical to `VoicePreview`'s grouping, VoiceSelector **must** use `!!p.instruct`, not `p.kind`. Treat falsy/empty-string `.instruct` as "clone", any non-empty string as "designed".

**Edge cases in option construction — every one enumerated:**
- **Empty `profiles` array.** No clone/designed options. With `engineDefault` true, the array still has the `''` row, so the picker is never empty. (StoriesEditor separately shows a `stories.noProfiles` hint at `:571` — leave that; it's outside the selector.) With `engineDefault` false (no current call site uses this, but the prop allows it) **and** empty profiles **and** no presets/speakerClones, the array is `[]`; `SearchableSelect` renders the `.ss-empty` "no matches" row (`:174-176`, key `common.no_matches`) and the trigger shows `placeholder`. VoiceSelector must pass a sensible `placeholder` (default to `t('voiceSelector.engineDefault')`) so the empty trigger isn't the bare "Select…".
- **`null`/`undefined` `profiles`.** Default the prop to `[]` (`profiles = []`) so `.filter`/`.map` never throw. (StoriesEditor/AudiobookTab/DubTab all pass a real array, but `DubSegmentTable`'s virtualized `Row` could momentarily pass `undefined` during a re-mount — defensive default required.)
- **A profile with no `name`.** `label` falls back to `p.name?.trim() || p.id` — `SearchableSelect.getLabel` already coalesces `label ?? value ?? ''` (`:49`), but a literal empty label is unsearchable and confusing. VoiceSelector sets `label: p.name?.trim() || p.id` so search-by-id still works (search matches both label and value, `:66`).
- **Duplicate profile ids** (shouldn't happen, but `byVal` is a `Map`, `:52-56` — last-writer-wins). Not VoiceSelector's job to dedupe; the backend guarantees unique ids. No special handling.
- **`speakerClones` is `{}` (empty object) vs `null`.** Both yield zero `fromVideo` options; the `Object.keys(...).length > 0` guard (mirroring `DubSegmentRow.jsx:295`) prevents an empty group header. Default the prop to `null`.
- **Two detected speakers slugging to the same `auto:` value** (e.g. "Speaker 1" and "speaker  1" → both `auto:speaker_1`). The slug rule collapses them; `byVal` last-writer-wins. Pre-existing in DubSegmentRow; out of scope to fix. Note it in JSDoc.
- **Currently-selected value not present in any group** (a *deleted profile still referenced by a cast member / segment / audiobook default* — a real state: user deletes a cloned voice that a track still points at). `byVal.get(value)` is `undefined` → `currentLabel` falls back to the raw id string (`:60`). **VoiceSelector must render this gracefully:** detect when `value` is a non-empty profile-id not in `profiles` (and not a `preset:`/`auto:` sentinel), and synthesize a transient "ghost" option `{ value, label: t('voiceSelector.missingVoice'), group: 'clone', groupLabel: t('voiceSelector.clone') }` so the trigger shows a human label (not the raw `p_abc`) and the user can re-pick. Do **not** auto-clear the value (that would silently mutate the user's project data — see **Constraints → Backward-compatible project data**). Add `voiceSelector.missingVoice` i18n key. Test #12 covers it.

> **[corrected]** `Profile` (TS interface, `api/types.ts:109-123`) has fields `id`, `name`, `kind` (`'clone' | 'design'`), `language_code?`, `ref_audio?`, `ref_text?`, `description?`, `created_at?`, `is_locked?`, `verified_own_voice?`, `consent_text?`, `consent_recorded_at?`. It does **not** declare `instruct`. The runtime profile objects carry an extra `.instruct` string that the JSX consumers read directly (confirmed readers: `VoicePreview.jsx:119`/`:126`/`:66`, plus `Sidebar.jsx`, `WorkspaceVoices.jsx`, `DubTab.jsx`, `VoiceGallery.jsx`, `VoiceProfile.jsx`, `CloneDesignTab.jsx`, and others via `grep -l '\.instruct'`). VoiceSelector reads `p.instruct` the same way (treat a falsy/empty-string `.instruct` as "clone", any non-empty string as "designed" — matches the `!!p.instruct` test at `VoicePreview.jsx:126`). If touching the TS type is desired, add `instruct?: string;` to the `Profile` interface in the same PR — but it is not required for the JSX migration. (This is a type-annotation-only change; it carries **no** runtime, schema, or data-format impact, so it does not engage the backward-compat rule.)

### Inline preview (QW6)

The selector does **not** own audio. It surfaces a preview button that calls the `onPreview(voiceValue)` prop. The shared `VoicePreview` popover is owned by `App.jsx` via state destructured from the `useProfiles` hook — `isVoicePreviewOpen` / `setIsVoicePreviewOpen` / `voicePreviewProfileId` / `setVoicePreviewProfileId` (`App.jsx:222-223`; the hook is `frontend/src/hooks/useProfiles.js`). The component renders at `App.jsx:1325-1331` (`<VoicePreview open={isVoicePreviewOpen} onClose={…:1329} … initialProfileId={voicePreviewProfileId} :1331 />`). **Local-first note:** `VoicePreview` synthesizes the audition through the same fully-local backend used for generation — no cloud call, no account, no telemetry (see **Constraints → Local-first**, and the exact request shape below).

#### Preview request contract (the only wire shape this feature can reach)

When the user clicks preview, the value flows: VoiceSelector → `onPreview(value)` → migration closure → `setVoicePreviewProfileId(value)` + `setIsVoicePreviewOpen(true)` → `VoicePreview` (with `initialProfileId=value`) → on the user pressing Play inside the popover, `VoicePreview.handleGenerate` (`:38-86`) builds a `FormData` and calls `generateSpeech(fd, { signal })` (`:72`). **VoiceSelector never builds this FormData and never calls the API** — it only hands a string to `setVoicePreviewProfileId`. The exact request (`api/generate.ts:3-9` → `apiFetch('/generate', { method:'POST', body: formData })`) is pinned here so the developer knows what the value they pass turns into downstream:

```http
POST /generate
Content-Type: multipart/form-data
```
| FormData field | Value (always sent) | Source line |
|----------------|---------------------|-------------|
| `text` | the user-typed preview sentence | `VoicePreview.jsx:48` |
| `num_step` | `"8"` (fast preview) | `:49` |
| `guidance_scale` | `"2.0"` | `:50` |
| `speed` | `"1.0"` | `:51` |
| `denoise` | `"true"` | `:52` |
| `postprocess_output` | `"true"` | `:53` |
| `profile_id` | **conditional** — appended only if `profileId` non-empty after preset-stripping (`:69`) | `:69` |
| `instruct` | **conditional** — appended only if non-empty (`:70`) | `:70` |

Response: the full `Response` object (`generateSpeech` returns it, `generate.ts:7`); `VoicePreview` reads `res.ok`/`res.status` (`:73`) then `res.blob()` (`:75`) → a WAV blob played via `WaveformPlayer`. **No JSON body, no SSE** on this path.

How `VoicePreview` maps the value VoiceSelector passes into `profile_id`/`instruct` (`VoicePreview.jsx:55-70`) — this is exactly the per-value-type behavior the preview button inherits:

| `value` passed to `onPreview` | `profile_id` field | `instruct` field | Result |
|-------------------------------|--------------------|------------------|--------|
| `''` (engine default) | *(omitted)* | *(omitted)* | engine-default voice (`:69` skips, `:70` skips) |
| `'p_abc'` real id | `'p_abc'` | `match.instruct` if designed, else omitted (`:65-66`) | the cloned/designed voice |
| `'preset:narrator'` | *(omitted — cleared to `''` at `:63`)* | preset attrs joined `', '` (`:61`) | the preset character |
| `'auto:speaker_1'` | `'auto:speaker_1'` (falls through `else`, no match found, stays) | `''` (no `.instruct` match) | backend resolves `auto:` or 422/500s |

**Preview button states (all enumerated):**
- **No `onPreview` prop** → button not rendered at all.
- **`onPreview` present, `previewLoading` false** → `Play` icon, enabled, `aria-label={t('voiceSelector.preview')}`. Clicking calls `onPreview(value)` (the *current* selected value, read from the controlled `value` prop at click time, not a stale closure).
- **`previewLoading` true** → swap to `Loader` icon (add a spin class), `disabled`, so a second click can't fire while the popover is generating. (Mirrors `VoicePreview`'s own loading button at `VoicePreview.jsx:162-177`.)
- **`value === ''` (engine default) and `onPreview` present** → button stays **enabled**; previewing the engine default is meaningful (`VoicePreview` handles `''` by sending no `profile_id`, `:69`). Do not disable it.
- **Click happens while the dropdown popup is open** → the adornment row lives *outside* the `SearchableSelect` `ss-pop` (it's a sibling in VoiceSelector's flex row), so clicking it does not interfere with the `mousedown`-to-close handler (`SearchableSelect.jsx:98-102`). No special handling needed; the popup, if open, closes on outside-mousedown as usual.

> **[corrected]** The prior draft pointed at `App.jsx:1231-1234` / `:1273-1276` as where the popover state lives. The migration closures to copy are the two existing `onOpenVoicePreview` closures: one passed to `WorkspaceVoices` (the `setVoicePreviewProfileId(profileId || ''); setIsVoicePreviewOpen(true);` pair at `App.jsx:1232-1233`) and one to `Sidebar` (the identical pair at `:1274-1275`). The exact closure to thread:
> ```jsx
> onOpenVoicePreview={(profileId) => {
>   setVoicePreviewProfileId(profileId || '');   // App.jsx:1232 / :1274
>   setIsVoicePreviewOpen(true);                  // App.jsx:1233 / :1275
> }}
> ```
> The migration threads an identical (`useCallback`-wrapped — see memo note) closure into StoriesEditor / AudiobookTab / DubTab as a new `onOpenVoicePreview` prop, mirroring those two existing call sites exactly.

**`VoicePreview` stale-state bug we must not trip. [completeness]** `VoicePreview` syncs its internal `voiceId` from `initialProfileId` **only when `initialProfileId` is truthy** (`VoicePreview.jsx:34-36`: `if (initialProfileId) setVoiceId(initialProfileId)`). The `onOpenVoicePreview` closure already does `setVoicePreviewProfileId(profileId || '')` (`:1232`) — so if the user previews an **engine-default (`''`)** selection right after previewing a real voice, `voicePreviewProfileId` becomes `''`, but `VoicePreview`'s internal `voiceId` retains the *previous* voice. The user sees the wrong voice pre-selected in the popover. **Two acceptable resolutions; pick (a) for this PR:**
  - **(a) Out of scope to fix in `VoicePreview`; document it.** The pre-existing `WorkspaceVoices`/`Sidebar` callers have the same behavior, so we're not regressing. The popover is a *secondary* control; the user can re-pick inside it. Note in the migration PR description.
  - **(b) Optional polish (defer):** change `VoicePreview.jsx:34-36` to sync unconditionally (`setVoiceId(initialProfileId)`) — but that risks a behavior change for the existing two callers, so keep it out of this task's critical path unless trivially testable. (Either resolution is identical on all platforms — no parity concern.)

**Preview value-resolution degradation:** `auto:<slug>` previews a from-video speaker; if the backend resolves `auto:` ids (it does for the dub pipeline), preview works; if it 422/500s, `VoicePreview.handleGenerate` catches it (`:79-82`, logs `'Preview generation failed:'` to console, no audio) — **acceptable degradation for a preview** (documented in JSDoc), not a crash.

### Inline create slot (#25 pattern)

When `onCreateVoice` is provided, VoiceSelector appends a fixed, always-visible **"+ Create voice"** row at the bottom of the popup list. `SearchableSelect` has no footer hook today, so add an optional `footer` render prop (default `null`, backward compatible) rendered after the `.ss-list` map at `SearchableSelect.jsx:206-211` (inside `.ss-list`, pinned at the bottom, after the `.ss-more` row at `:208-210`). Selecting it calls `onCreateVoice()` and does **not** commit a value (i.e. it does not go through `commit`/`onChange` at `:120-129`).

**Create-slot edge cases:**
- **No `onCreateVoice`** → no footer; `footer` prop stays `null`; `SearchableSelect` render at `:206-211` is byte-identical to today.
- **Footer click must close the popup** but **not** alter `value`. The footer's `onMouseDown` (use `onMouseDown` + `e.preventDefault()` to match how `commit` is wired at `:194`, so focus doesn't bounce) calls `onCreateVoice()` then must close the popup. Since the close lives in `SearchableSelect` (`setOpen(false)`), expose it: the render-prop form `footer({ close })` receives the `() => setOpen(false)` closer; VoiceSelector's footer calls `onCreateVoice()` then `close()`. (If we keep `footer` a plain node, the popup stays open after create — acceptable but worse UX; the render-prop form is cleaner. Use the render-prop form in 22a; either way it must **not** commit a value.)
- **Footer interaction with keyboard nav.** The footer is *not* part of `flatItems`, so ArrowDown/Enter (`:131-139`) never lands on it; it's mouse/tap only for this PR. Acceptable for a #25-seam; #25 can promote it into the navigable list if desired. Document.
- **Footer with `MAX_DISPLAY` truncation.** The footer renders after the `.ss-more` "showing N of M" row (`:208-210`) — so with 200+ voices the order is: list → "showing 200 of N" → "+ Create voice". Visually fine.

This PR proves the callback fires (test + a console-noop wiring); #25 replaces the noop with the real flow.

### Gallery jump

When `onOpenInGallery` is provided and the current value is a real profile id (not `''`/`preset:`/`auto:`), render an `ExternalLink` adornment that calls `onOpenInGallery(profileId)`. Migration wires it to `openVoiceProfile(id)` (`store/uiSlice.ts:75` decl, `:108-115` impl), which sets `mode: 'voice'`, `activeVoiceId: id`, and remembers `modeBeforeVoice` (the prior mode unless already `'voice'`, `:113`) so the voice-profile page's "Back" (`closeVoiceProfile`, `:116-123`) restores the originating tab.

**Gallery-jump visibility states (every value type) — the single predicate is below them:**
- `value === ''` → **hidden** (nothing to open).
- `value` startsWith `'preset:'` → **hidden** (presets aren't gallery profiles).
- `value` startsWith `'auto:'` → **hidden** (auto-speakers aren't saved profiles).
- `value` is a profile id **present in `profiles`** → **shown**, fires `onOpenInGallery(value)`.
- `value` is a profile id **NOT in `profiles`** (deleted/ghost case) → **hidden** — opening the gallery for a non-existent voice would land on a broken voice page (`activeVoiceId` points at nothing). Suppress the affordance for ghost values.
- **No `onOpenInGallery` prop** → never rendered.

The single predicate: `onOpenInGallery && value && !value.startsWith('preset:') && !value.startsWith('auto:') && profiles.some(p => p.id === value)`.

## Integration points (file:line) — all re-verified

**New**
- `frontend/src/components/VoiceSelector.jsx` (new)
- `frontend/src/components/VoiceSelector.css` (new; for the adornment flex row + create-row styling — the `.ss-*` classes are reused for the list itself)
- `frontend/src/components/VoiceSelector.test.jsx` (new; lives where vitest expects: `include: ['src/**/*.test.{js,jsx,ts,tsx}']`, `vite.config.js:34`)

**Reused as-is / extended**
- `frontend/src/components/SearchableSelect.jsx` — add three optional props, all default-off so existing renders are byte-identical:
  - `renderGroupHeaders` (default `false`; group-header emit hooks into the map at `:184-206`, gated on `it.kind === 'main' && option.groupLabel && option.group !== lastGroup`; pseudocode above).
  - `footer` (default `null`; `React.ReactNode | (({ close }) => React.ReactNode)`; rendered inside `.ss-list` near `:206-211`, after the `.ss-more` row).
  - `isRecentable` (default `() => true`; `(value: string) => boolean`; consulted in `commit` at `:123` before writing recents, so VoiceSelector can exclude `''`/`preset:`/`auto:` sentinels).
- **[corrected] SearchableSelect existing call sites:** the only place that *renders* `<SearchableSelect>` is `pages/CloneDesignTab.jsx:671` (language picker, `recentsKey="omnivoice.recents.genLang"` at `:675`). `pages/DubTab.jsx:12` is an **`import` that is currently unused** (`grep -c '<SearchableSelect' pages/DubTab.jsx` → 0). So there is effectively **one** live call site to regression-guard, not two. (Note for cleanup: the dead DubTab import could be removed, but that is out of scope.)
- `frontend/src/components/SearchableSelect.jsx` recents persistence: `readRecents`/`writeRecents` (`:7-18`) use `window.localStorage` with a `try { JSON.parse } catch { return [] }` guard (`:7-12`) and an `8`-item cap (`writeRecents` slices `list.slice(0, 8)` at `:17`; `commit` re-slices to 8 at `:124`). **No format/version field** — recents are a plain `string[]` (exact shape in **API / data shapes → Persisted recents shape**). The `isRecentable` guard keeps only profile-id strings in that array; if a stored id later refers to a deleted voice, `pinned` (`:73-85`) skips it silently, so even a stale persisted recents blob degrades gracefully without migration (see **Constraints → Backward-compatible project data**).
- `frontend/src/index.css` — the `.ss-*` block starts at `index.css:1603` (`.ss-wrap`), with `.ss-trigger` (`:1604`), `.ss-pop` (`:1618`), `.ss-list` (`:1652`), `.ss-group-label` (`:1660`). Reuse `.ss-group-label`.
- `frontend/src/utils/constants.js:33-46` — `PRESETS` (preset group source; **6** entries, each `{ id, name, tags, attrs }`; `id`s: `narrator`, `excited_child`, `anxious_whisper`, `surprised_woman`, `elderly_story`, `sichuan`).
- `frontend/src/api/types.ts:109-123` — `Profile` shape (`kind: 'clone' | 'design'` at `:107`/`:112`). **Does not list `instruct`** (see corrected note in Option model); JSX reads `p.instruct` at runtime and groups on it, not on `kind`.
- `frontend/src/components/VoicePreview.jsx` — preview semantics this absorbs: grouping at `:119-139`, preset/instruct derivation at `:58-67`, the `FormData` build + `generateSpeech` call at `:47-72`, and the **conditional `initialProfileId` re-sync at `:34-36`** (the stale-state caveat above).
- `frontend/src/api/generate.ts:3-9` — `generateSpeech(formData: FormData, { signal }?: { signal?: AbortSignal }): Promise<Response>`. **Not called by VoiceSelector**; reached only via `VoicePreview`. Pinned in **API / data shapes** as the one wire shape this feature can produce.
- `frontend/src/utils/storyCast.js` — `effectiveProfile(track, cast)` (**`.js`, not `.ts`**): returns `track.profileId` if set, else the cast member's `profileId`, else `null` (resolves track override → cast voice → null). Confirms the emitted value stays a profile id or null.

**Migration sites**
- `frontend/src/components/StoriesEditor.jsx:550-558` — cast voice `<select>` → `<VoiceSelector value={c.profileId || ''} onChange={(v) => setCharacterVoice(c.id, v || null)} engineDefault recentsKey="omnivoice.recents.storiesCastVoice" />`. `setCharacterVoice` is read from the store at `StoriesEditor.jsx:121` (`setCharacterVoice: (castId: string, profileId: string | null) => void`, `storiesSlice.ts:45`).
- `frontend/src/components/StoriesEditor.jsx:708-716` — per-line override `<select>` → `<VoiceSelector value={track.profileId || ''} onChange={(v) => updateTrack(track.id, 'profileId', v || null)} engineDefault defaultLabel={inheritedName ? \`↳ ${inheritedName}\` : t('stories.defaultVoice')} recentsKey="omnivoice.recents.storiesLineVoice" />`. `inheritedName` already computed at `:670`; `updateTrack` is a `useCallback` at `:268` (`(id, field, value) => …`). **Note:** the `defaultLabel` only changes the `''` row's label; passing `t('stories.defaultVoice')` (en: `"Default"`, `en.json:71`) — **not** `t('voiceSelector.engineDefault')` — as the non-inherited fallback keeps the on-screen copy byte-identical to today (no localization regression for an existing string).
- `frontend/src/pages/AudiobookTab.jsx:220-224` — default voice `<select>` → `<VoiceSelector value={defaultVoice} onChange={setDefaultVoice} engineDefault presets={false} recentsKey="omnivoice.recents.audiobookVoice" />`. The audiobook backend takes a profile id or `null`; `defaultVoice` feeds **three** existing calls, all wrapping with `|| null`: `audiobookPlan({ text, default_voice: defaultVoice || null })` (`:72`), `audiobookPreviewChapter({ …, default_voice: defaultVoice || null })` (`:103`), `audiobookGenerate({ …, default_voice: defaultVoice || null })` (`:132`). Keep presets off until the parser is confirmed (see Risk). **Note:** AudiobookTab's `onChange` is `setDefaultVoice` directly (no `|| null` wrapper at the UI layer, `:221`); the three API calls do the `|| null`. VoiceSelector emits `''` for engine default, which `setDefaultVoice('')` stores — byte-identical to today.
  - **SSE-context note (this feature must not break):** `audiobookGenerate` returns a streaming `Response` whose body is an SSE stream `AudiobookTab.onCreate` parses (`:139-169`) via `splitSSEBuffer`/`parseSSELine` (`utils/sseParse.js`) into events `started {chapters}` (`:151`), `chapter {index,total,title}` (`:153`), `assembling` (`:155`), `chapter_error {index,total,title}` (`:157`), `done {output,cached_chapters,failed_chapters}` (`:159`), `error {error}` (`:165`). **VoiceSelector touches none of this** — it only changes how `defaultVoice` (the `default_voice` string) is *picked*; the stream contract, event names, and field shapes are unchanged. Listed here so the migration is verified not to perturb the audiobook generate path.
- `frontend/src/components/DubSegmentRow.jsx:288-313` — per-segment `<select>` → `<VoiceSelector value={seg.profile_id || ''} onChange={(v) => onEditField(seg.id, 'profile_id', v)} speakerClones={speakerClones} presets engineDefault size="sm" recentsKey="omnivoice.recents.dubSegmentVoice" />`. **Recents on a per-row virtualized control:** all dub rows share one `recentsKey`, so "recent voices" is global across segments (desirable — you usually reuse the same handful of voices across a dub). The `isRecentable` guard keeps `auto:`/`preset:` out so only real cloned voices accumulate. (Note: `onEditField(seg.id, 'profile_id', v)` passes the value through *without* `|| null` — matching today's `e.target.value` at `:292`, which can be `''`; the dub store accepts `''`.)

**Prop threading (preview/gallery)**
- `frontend/src/App.jsx:1074` — `<StoriesEditor profiles={profiles} />` → add `onOpenVoicePreview={…}` (the `useCallback`-wrapped closure mirroring `:1232-1233`) + `openVoiceProfile={openVoiceProfile}` (`openVoiceProfile` already in scope at `App.jsx:166`).
- `frontend/src/App.jsx:1080` — `<AudiobookTab profiles={profiles} />` → add `onOpenVoicePreview` + `openVoiceProfile`.
- `frontend/src/App.jsx:1115-1209` — `<DubTab …>` already receives `profiles`, `speakerClones`, `fileToMediaUrl`, `segmentPreviewLoading`, `handleSegmentPreview`. Add `onOpenVoicePreview` + `openVoiceProfile`.
- **[corrected] Dub threading is NOT a one-hop prop pass.** `DubTab` renders `<DubSegmentTable>` (`pages/DubTab.jsx:1210`, lazy-imported at `:34`), which **virtualizes rows with react-window**: it bundles row inputs into a memoized `rowProps` object (`components/DubSegmentTable.jsx:111-116`) and reads them inside a `Row` `useCallback` with an **empty dependency array** (`:118`/`:142`, destructuring `filtered`, `profiles`, `speakerClones`, `onEditField`, `onPreview`, … and passing them to `<DubSegmentRow>` at `:128-141`). Therefore `onOpenVoicePreview` (and `openVoiceProfile` for the gallery jump) must be:
  1. added to `DubSegmentTable`'s prop list (`:23-25`),
  2. added to the `rowProps` object **and its `useMemo` dependency array** (`:111-116` — both the object literal at `:112-114` and the deps array at `:115-116`),
  3. destructured in the `Row` `useCallback` signature (`:118`, the long `({ index, style, filtered: fl, … })` param) and forwarded to `<DubSegmentRow>` (`:128-141`).
  Skipping any of these three yields a stale/undefined handler inside virtualized rows. **Completeness note on the empty-dep `Row`:** because `Row`'s `useCallback` dep array is `[]` (`:142`), `Row` itself never recreates — it relies *entirely* on the props react-window passes via `rowProps`. Two failure modes if mis-wired: (a) callback omitted from `rowProps` → `undefined` inside `Row` → clicking preview throws `TypeError: x is not a function`; (b) callback in `rowProps` but omitted from the destructure (`:118`) → `undefined` again. Both are silent until a user clicks the per-segment preview in a *virtualized* (scrolled) row, which is exactly why the manual smoke must scroll the dub list and click preview on an off-screen-then-scrolled-in row, not just row 0.
- **DubSegmentRow `memo` comparator (`:396-411`).** It currently compares `seg`, `disabled`, `isActive`, `isDone`, `isPlaying`, `timelineSelected`, `previewLoading`, `onDirect`, `onSeek`, `selected`, `canMerge`, `profiles`, `speakerClones` (and `idx` per `:408-409` continuation) — but **not** `onPreview`/`onEditField`/`onOpenVoicePreview`/`openVoiceProfile`. These callbacks must have **stable identity** across `DubTab` renders or the row won't re-render when they change. **The safe path:** thread the *stable* `openVoiceProfile` store action and a `useCallback`-wrapped `onOpenVoicePreview`; then no comparator change is needed and the row updates correctly when the *data* props (`seg`, `profiles`, `speakerClones`) change. If any can change identity, add it to the comparator. Verify by previewing a row, editing its voice, and confirming the trigger label updates.
- `frontend/src/store/uiSlice.ts:75`/`:108-115` — `openVoiceProfile(id: string): void` already exists; reuse for the gallery jump.

## API / data shapes

> **Scope reminder:** this is a **frontend-only** task. It introduces **no new HTTP endpoint, no new SSE event type, no request/response field, and no DB schema**. The shapes below are: (1) the new component's prop interface; (2) the option object `SearchableSelect` consumes; (3) the additive `SearchableSelect` prop signatures; (4) the one persisted client-side data structure (`localStorage` recents); (5) the *existing* `POST /generate` request the preview path reaches; (6) the unchanged value contract per call site; (7) the relevant store field/action types. Everything is pinned so a developer implements without guessing.

### 1. `<VoiceSelector>` props

```ts
interface VoiceSelectorProps {
  value: string;                 // '' | profileId | 'preset:<id>' | 'auto:<slug>'  (REQUIRED)
  onChange: (value: string) => void;   // REQUIRED; emits exactly one of the above strings
  profiles?: Profile[];          // runtime profile objects (read .id, .name, .instruct); default []

  // Option groups
  presets?: boolean;             // include PRESETS group (default: false)
  speakerClones?: Record<string, unknown> | null; // dub "From video" group keys; default: null
  engineDefault?: boolean;       // include the '' engine-default option as the FIRST row (default: true)
  defaultLabel?: string;         // override the '' row's label (e.g. inherited "↳ Aria")

  // Adornments (all optional; absent ⇒ not rendered)
  onPreview?: (value: string) => void;        // QW6 inline preview (fires with current `value`)
  previewLoading?: boolean;                   // swaps Play→Loader, disables the preview button (default false)
  onCreateVoice?: () => void;                 // #25 inline-create slot (footer row; does NOT commit a value)
  onOpenInGallery?: (profileId: string) => void; // gallery jump; shown only for a real profile id present in `profiles`

  // Passthrough to SearchableSelect
  recentsKey?: string;           // e.g. 'omnivoice.recents.storiesCastVoice'; sentinels excluded via isRecentable
  size?: 'sm' | 'md';            // default 'md' (maps to SearchableSelect size, .jsx:34/:141)
  disabled?: boolean;            // when true, trigger is disabled AND all adornments are disabled (default false)
  ariaLabel?: string;            // applied to the trigger button
  placeholder?: string;          // trigger text when value resolves to nothing; default t('voiceSelector.engineDefault')
}
```

**Prop-state edge cases:**
- **`disabled` true** → `SearchableSelect` already guards open (`:149`); VoiceSelector must *also* disable the preview/gallery/create adornments (don't let a user preview while the parent has the whole row disabled, e.g. dub `disabled` during generation, `DubSegmentRow.jsx:291`). Adornment buttons take `disabled={disabled || previewLoading}`.
- **`engineDefault` false + value `''`** → the `''` option isn't in the array; trigger falls back to `placeholder`. Only matters if a future caller sets `engineDefault={false}`; no current site does. Documented.
- **`defaultLabel` provided but `engineDefault` false** → `defaultLabel` is ignored (no `''` row to label). Harmless.

### 2. `VoiceOption` (object consumed by `SearchableSelect`)

Full schema given in **Design → Option model**. Restated as the contract `SearchableSelect` relies on: `getVal(o) === o.value` (`SearchableSelect.jsx:45`), `getLabel(o) === o.label ?? o.value ?? ''` (`:46-50`, no `renderLabel` passed by VoiceSelector so the default applies), and the two new fields `group`/`groupLabel` read only by the group-header logic. `value` is the exact string `commit` forwards to `onChange` (`:121-122`).

### 3. `SearchableSelect` additive props (backward compatible)

```ts
renderGroupHeaders?: boolean;     // default false — when true, emit .ss-group-label (index.css:1660)
                                  //   between groups using option.group / option.groupLabel,
                                  //   ONLY for items with kind === 'main' and a truthy groupLabel,
                                  //   on the first option of each new group, inside the map at :184-206
footer?: React.ReactNode | (({ close }: { close: () => void }) => React.ReactNode);
                                  // default null — fixed row pinned at popup bottom (after .ss-more),
                                  //   rendered near :206-211; render-prop form gets close() to dismiss the
                                  //   popup (setOpen(false)) WITHOUT committing (used for "+ Create voice")
isRecentable?: (value: string) => boolean;
                                  // default () => true — consulted in commit() at :123 before writing recents;
                                  //   VoiceSelector passes a predicate excluding ''/preset:/auto: sentinels
```

Exact `commit` change at `SearchableSelect.jsx:120-129` (the only behavioral edit to `commit`):
```js
const commit = (o) => {
  const v = getVal(o);
  onChange?.(v);
  if (recentsKey && isRecentable(v)) {            // <-- guard added; default isRecentable = () => true
    const next = [v, ...recents.filter(r => r !== v)].slice(0, 8);
    setRecents(next);
    writeRecents(recentsKey, next);
  }
  setOpen(false);
};
```

### 4. Persisted recents shape (the only persisted client artifact)

```ts
// localStorage[recentsKey] — written by writeRecents (SearchableSelect.jsx:15-18), read by readRecents (:7-13)
type RecentsBlob = string[];   // JSON.stringify'd array of *values*, most-recent-first, max 8 (slice(0,8))
                               // NO version field. Each element is a VoiceOption.value.
                               // With VoiceSelector's isRecentable guard, only real profileIds are stored
                               // (never '', 'preset:*', 'auto:*').
```
Keys this task introduces (net-new namespaces; existing `omnivoice.recents.genLang` from `CloneDesignTab.jsx:675` is untouched):
- `omnivoice.recents.storiesCastVoice`
- `omnivoice.recents.storiesLineVoice`
- `omnivoice.recents.audiobookVoice`
- `omnivoice.recents.dubSegmentVoice`

Read tolerance: `readRecents` returns `[]` on missing key or `JSON.parse` throw (`:9-12`) — so a corrupt/legacy blob never crashes; a stored id pointing at a deleted voice is silently skipped by `pinned` (`:73-85`). No migration step exists or is needed.

### 5. Preview request contract (existing `POST /generate`, reached only via `VoicePreview`)

Pinned in full under **Design → Inline preview → Preview request contract** (the `FormData` field table + the value→`profile_id`/`instruct` mapping table). Repeated key facts: `generateSpeech(formData, { signal }): Promise<Response>` (`api/generate.ts:3-9`); multipart body; response is a WAV blob (`res.blob()`, no JSON/SSE). **VoiceSelector itself makes no HTTP call** — it only hands the value string to `setVoicePreviewProfileId`.

### 6. Value contract (unchanged from today — must match these existing call sites)
- **Stories cast** → `setCharacterVoice(c.id, value || null)` (`StoriesEditor.jsx:553`); store field `CastMember.profileId: string | null` (`store/storiesSlice.ts:25`); action sig `setCharacterVoice(castId: string, profileId: string | null): void` (`:45`). Synthesis resolves via `effectiveProfile(track, cast)` (`storyCast.js`) → returns `track.profileId || member.profileId || null`. No `preset:`/`auto:` here; selector emits a profile id or `''`. (The selector is *configured* with `presets={false}` and no `speakerClones` for Stories, so it can only ever emit `''` or a real id — the value contract can't be violated by the UI.)
- **Stories per-line** → `updateTrack(track.id, 'profileId', value || null)` (`StoriesEditor.jsx:711`); store field `StoryTrack.profileId: string | null` (`store/storiesSlice.ts:16`).
- **Audiobook** → all three calls take `default_voice: string | null`: `audiobookPlan` (`api/audiobook.ts:20`, called `AudiobookTab.jsx:72`), `audiobookPreviewChapter` (`audiobook.ts:39`, called `:103`), `audiobookGenerate` (`audiobook.ts:76`, called `:130-138`). UI emits `''`/id; the `|| null` happens at each call site. Configured `presets={false}`, no `speakerClones` → emits only `''`/id.
- **Dub segment** → `onEditField(seg.id, 'profile_id', value)` (`DubSegmentRow.jsx:292`); accepts `''` / id / `preset:<id>` / `auto:<slug>` (current grouping at `:295-312`). This is the only site where `presets` and `speakerClones` are both on, so it's the only emitter of `preset:`/`auto:` values — matching exactly what `onEditField` accepts today (no `|| null` applied here).

### 7. Store types touched (read-only reuse; no shape change)
- `CastMember.profileId: string | null` (`storiesSlice.ts:25`); `StoryTrack.profileId: string | null` (`:16`). Unchanged.
- `openVoiceProfile(id: string): void` (`uiSlice.ts:75`, impl `:108-115`). Reused for gallery jump. Unchanged.
- `seg.profile_id` (dub segment, runtime object) — emitted value written via `onEditField`. Unchanged.

No backend changes: the selector is a presentation layer over values the backend already accepts.

## Test plan

Vitest + Testing Library. Config: `frontend/vite.config.js` → `environment: 'jsdom'` (`:32`), `setupFiles: ['./src/test/setup.js']` (`:33`), `include: ['src/**/*.test.{js,jsx,ts,tsx}']` (`:34`); run `bunx vitest run` per merge-discipline memory. Existing component tests (e.g. `src/test/DemoPresetGrid.test.jsx`, `src/components/EngineCompatibilityMatrix.test.jsx`) are the pattern to follow. **`localStorage` is jsdom-backed but persists across tests in a file — call `window.localStorage.clear()` in `beforeEach`** so recents-state tests don't bleed.

New `frontend/src/components/VoiceSelector.test.jsx`:

1. **Renders groups** — given profiles (mix of `.instruct`/non-`.instruct`) + `presets`, the popup shows Clone / Designed / Presets group headers with the right members; designed = those with truthy `.instruct` (mirrors `VoicePreview.jsx:121`/`:128` split). Also assert **group order**: default → clone → designed → preset. Assert each emitted option's `{ value, label, group, groupLabel }` shape against §2.
2. **From-video group** — with `speakerClones={{ 'Speaker 1': {} }}` a "From video" group renders an option `{ value: 'auto:speaker_1', label: '🎤 Speaker 1', group: 'fromVideo' }` (slug per `DubSegmentRow.jsx:298`). With `speakerClones={{}}` and `speakerClones={null}`, **no** "From video" header renders.
3. **Engine-default sentinel** — `engineDefault` shows the `''` row as the first option, **with no group header above it** (`groupLabel: ''`); the **trigger shows the default label** when `value=''` (regression guard for the `currentLabel` fallback bug, `SearchableSelect.jsx:58-61`); `defaultLabel="↳ Aria"` overrides its text (reproduces `StoriesEditor.jsx:714`). With `engineDefault={false}`, the `''` row is absent and the trigger shows `placeholder`.
4. **onChange value contract** — picking a clone emits its exact id string; a preset emits `'preset:<id>'`; an auto-speaker emits `'auto:<slug>'`; engine default emits `''`. (Asserts the strings match each migration call site's expectation in §6 byte-for-byte.)
5. **Preview adornment** — when `onPreview` given, the play button calls `onPreview(currentValue)` with the current `value` string; `previewLoading` swaps to the `Loader` spinner and **disables** the button; preview button **enabled** when `value=''`; **absent** when `onPreview` not given.
6. **Create slot (#25 seam)** — when `onCreateVoice` given, the "+ Create voice" footer row fires `onCreateVoice` and does **not** call `onChange` (i.e. does not reach `SearchableSelect.commit`); the popup closes after create (the render-prop `close()` form). When `onCreateVoice` absent, no footer row.
7. **Gallery jump** — when `onOpenInGallery` given **and** value is a profile id present in `profiles`, the jump adornment fires `onOpenInGallery(id)` with the exact id; **hidden** when value is `''`, `'preset:…'`, `'auto:…'`, **or** a profile id NOT in `profiles` (ghost). (Asserts the §Gallery-jump predicate.)
8. **Search** — typing filters across all groups (delegated to `SearchableSelect.jsx:63-67`); a query matching only clones shows the Clone header but **not** the empty Designed/Presets headers; a non-matching query yields `t('common.no_matches')` (the `.ss-empty` row, `:174-176`); searching by **profile id** (not just name) also matches (delegated to `:66`).
9. **a11y** — trigger has `aria-haspopup="listbox"` / `aria-expanded` (`SearchableSelect.jsx:151-152`); `ariaLabel` applied to the trigger; preview/gallery/create buttons have `aria-label`s.
10. **Empty / defensive states** — `profiles={[]}` with `engineDefault` renders only the default row (no crash, no empty group headers); `profiles={undefined}` does not throw (prop default `[]`); a profile with empty `name` is searchable by id and shows a non-empty label (`p.id`).
11. **Recents exclusion (isRecentable)** — with a `recentsKey`, picking a real clone records it in `localStorage` (assert `JSON.parse(localStorage[key])` equals `['p_abc']` — exact §4 shape); picking engine default (`''`), a `'preset:…'`, or an `'auto:…'` value does **NOT** add it to `localStorage` recents (the `isRecentable` guard — assert the key is absent or unchanged); a recorded clone re-appears in the pinned recents header on next render.
12. **Ghost (deleted) profile** — `value="p_gone"` not in `profiles` renders the trigger with `t('voiceSelector.missingVoice')` (not the raw `p_gone`), the value is **not** auto-cleared (`onChange` not called on mount — proves the **backward-compatible project data** rule), the gallery jump is hidden, and selecting a real voice clears the ghost.
13. **Localization coverage (constraint guard)** — render the component under a fresh i18n init and assert that **no rendered label equals its raw key string** (e.g. the engine-default row text is not the literal `"voiceSelector.engineDefault"`); this catches a key missing from `en.json`. (A lightweight assertion; the cross-locale completeness is enforced by the existing i18n key-coverage CI check across all 21 locales — see **Constraints → Localization**.)

Plus a `SearchableSelect.test.jsx` (none exists today — confirmed no `src/**/SearchableSelect.test.*`) asserting the three new props don't regress the one live call site:
- with `renderGroupHeaders=false` / `footer=undefined` / `isRecentable=undefined` the render is behaviorally identical (no extra `.ss-group-label` beyond the existing pinned-recents header at `:178-182`, no footer row, recents recorded for every commit as before).
- with `renderGroupHeaders=true` and group-tagged options, headers emit only on `kind === 'main'` group changes and skip empty-`groupLabel` options (assert against the §3 pseudocode behavior).
- with `isRecentable` returning false for a value, `commit` skips the recents write (assert `localStorage[key]` unchanged) but still calls `onChange` with the value and closes (`setOpen(false)`).

Manual smoke (per `verify` skill, 3-process dev runtime):
- **Stories** → cast picker searchable + preview plays; per-line override shows `↳ Name` inherited label; recents pin after picking; inspect `localStorage['omnivoice.recents.storiesCastVoice']` is a `string[]` of ids only.
- **Audiobook** → default voice picker; no Presets group (presets off); preview of engine default works; confirm `audiobookGenerate`/`Plan`/`PreviewChapter` still receive `default_voice` and the SSE stream (`started`/`chapter`/`done`) renders unchanged.
- **Dub** → per-segment picker still drives synthesis; **scroll the segment list and click preview on a row that virtualized in after scroll** (the react-window threading is the high-risk spot, `DubSegmentTable.jsx:111-141`); edit a segment's voice and confirm the trigger label updates (memo-comparator check); confirm `auto:`/`preset:` values still emit byte-identically (inspect the value written to `seg.profile_id`).
- **Ghost path** → delete a cloned voice that a Stories track still references; reopen Stories and confirm the line shows a "missing voice" label rather than a raw id, and the project doesn't lose the reference (`track.profileId` still equals the deleted id).

Confirm on at least Linux locally; the change has no platform branches, so macOS/Windows parity is **structural** (see **Constraints → Cross-platform parity** for why running once on Linux suffices for this class of change).

## Constraints

This section states explicitly how the task satisfies each OmniVoice hard rule. (Several were referenced inline above; collected and made auditable here.)

- **Cross-platform parity / default-features rule (P0):** `<VoiceSelector>` ships in **default mode** on all four migration sites (no toggle, no opt-in, no env var) — so by the strict 2026-05-20 rule its user-visible behavior must be **identical** on macOS / Windows / Linux. It is, by construction:
  - Implementation uses only React, `react-i18next`, `lucide-react` icons, the existing `SearchableSelect`, and the existing `VoicePreview` opener — **no OS branches, no platform-only APIs, no native modules, no shell/path/keychain calls.** There is no `process.platform`/`navigator.platform`/Tauri-OS check anywhere in the new or modified code.
  - The only persistence is `localStorage` recents (`SearchableSelect.jsx:7-18`), which behaves identically across the three Tauri webviews (WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows). No filesystem, no OS keychain.
  - Because there is **no platform-conditional code path**, a single Linux run exercises the same code the other two platforms run; parity is structural, not test-coverage-dependent. No platform-only feature is introduced, so the "opt-in for platform-only" clause does not apply.
- **Local-first guarantee:** the feature adds **no** cloud call, account, API key, or telemetry, and **no new endpoint of any kind.** The inline-preview audition routes through the **same fully-local backend** call already used for synthesis — the *existing* `POST /generate` multipart request inside `VoicePreview.handleGenerate` (`:72`, shape pinned in **API / data shapes §5**); the gallery jump is a pure in-app store action (`openVoiceProfile`, `uiSlice.ts:108-115`); recents are local `localStorage`. The app remains fully functional with no network (preview simply fails-soft to a console log, `VoicePreview.jsx:79-82`). No new outbound endpoint is introduced (the opt-in GitHub-Issues reporter from CLAUDE.md is unrelated and untouched here).
- **Backward-compatible project data:** **no DB schema change → no alembic migration required** (this is a frontend-only change; there is no SQLAlchemy model, column, or table touched, and no new request/response field). Project data shapes are preserved exactly: `storiesSlice` keeps `CastMember.profileId` / `StoryTrack.profileId` as `string | null` (`store/storiesSlice.ts:16`, `:25`, re-verified); dub keeps `seg.profile_id`; audiobook keeps `defaultVoice` (and `default_voice: string | null` on the wire). The selector emits the **same string values** stored today (`''` / id / `preset:<id>` / `auto:<slug>`), so existing `omnivoice_data/` projects load and round-trip unchanged with no manual migration.
  - **Lazy-migration story for the one persisted client artifact (recents):** recents live in `localStorage` as a plain `string[]` (exact shape, **API / data shapes §4**) with **no version field**, read through a malformed-data-tolerant `try { JSON.parse } catch { return [] }` (`SearchableSelect.jsx:7-12`). Any pre-existing recents blob (from `CloneDesignTab`'s `omnivoice.recents.genLang`) is untouched; the four new keys are net-new namespaces. A stored id pointing at a since-deleted voice is silently skipped by `pinned` (`:73-85`) — graceful lazy tolerance, no migration step, no data loss. The new `isRecentable` guard only *prevents writing* sentinels going forward; it never rewrites or invalidates existing entries.
  - **The ghost-profile handling explicitly preserves a dangling profile id rather than auto-clearing it** (Option-model edge case + test #12): silently nulling a reference on render would mutate the user's project and violate this rule. The value is kept; the UI shows `voiceSelector.missingVoice` until the user re-picks.
- **CodeQL `py/polynomial-redos` (user-input regex):** **N/A by construction, and clean regardless.** (a) `py/polynomial-redos` is a *Python* query; this task touches **zero Python** (frontend-only `.jsx`/`.css`/`.json`), so the gate cannot fire on any file changed here. (b) The single user-input-touching regex in the whole feature is the auto-speaker slug `(spk || '').toLowerCase().replace(/\s+/g, '_')` (copied verbatim from `DubSegmentRow.jsx:298`, where `spk` is a user-editable detected-speaker name): `\s+` is one character class with one unbounded quantifier, no nesting, no alternation, no overlapping `\s*`/`.+` adjacency — strictly **linear-time**, ReDoS-clean (also satisfies the project's CodeQL-ReDoS memory guidance for JS regex). No new regex is introduced; we reuse the existing one byte-for-byte. The `value.startsWith('preset:')` / `startsWith('auto:')` predicates are plain string prefix checks, not regex.
- **Localization (hard rule):** all new user-facing strings go through `t('voiceSelector.*')`; **no** hardcoded English or CJK string literal in JSX. Verified there are exactly **21** locale files (`frontend/src/i18n/locales/`: `ar de en es fr hi id it ja ko nl pl pt ru sv th tr uk vi zh-CN zh-TW`) and **none currently contains a `voiceSelector` namespace** (`grep voiceSelector en.json` → 0), so the following **9** keys are net-new and must be added to **all 21** in the same PR (PR 22a), with `en.json` as the source of truth:
  `voiceSelector.engineDefault`, `voiceSelector.clone`, `voiceSelector.designed`, `voiceSelector.presets`, `voiceSelector.fromVideo`, `voiceSelector.preview`, `voiceSelector.createVoice`, `voiceSelector.openInGallery`, **`voiceSelector.missingVoice`**.
  Existing per-tab strings stay working and are not removed (`stories.defaultVoice` `en.json:71` = `"Default"`, `audiobook.engine_default`, `segment.voice_default`/`segment.from_video`/`segment.clone_profiles`/`segment.design_presets`); the Stories per-line migration deliberately passes `t('stories.defaultVoice')` as `defaultLabel` to keep that on-screen string identical. `SearchableSelect`'s own keys (`common.search`/`common.no_matches`/`common.recent_and_popular`/`common.popular_label`/`common.showing_of`, `en.json:1288-1292`) are already present and reused. The `🎙️`/`🎤` glyphs are emoji functional identifiers already in `PRESETS[].name` / the dub label — **not CJK**, so `tests/test_no_hardcoded_cjk.py` is unaffected and needs no allowlist change (the only CJK in `PRESETS`, `'四川话'` at `constants.js:44`, is pre-existing model vocabulary, not introduced here).
- **Versioning (continuous-to-main patch, no RC):** **no version bump** — `main` already rides next-patch (`X.Y.(Z+1)`), and a frontend refactor with no new dep does not change `pyproject.toml` / `frontend/src-tauri/Cargo.toml` / `frontend/src-tauri/tauri.conf.json` (all three stay untouched, in lockstep). Ships continuous-to-main as ordinary patch-line work; no `-rc` tag, no soak, no `v0.4` deferral. The owner tags whenever main is worth cutting.
- **Docs-sync (hard rule):** internal-component refactor with **no** user-facing change to install flows / Docker tag semantics / platform support / versioning/release behavior / supported versions — so no `README.md` / `CONTRIBUTING.md` / `SECURITY.md` / `SUPPORT.md` / `docs/**` update is required. If a screenshot of any tab's voice picker exists under `docs/**`, refresh it in the same PR (search before merge). The new `voiceSelector.*` JSDoc + prop table in this spec is the developer-facing documentation.
- **CI gates (merge-discipline memory):** do not merge before PR checks are green; the local loop must include `bunx vitest run` (covering the 13 `VoiceSelector` cases + the `SearchableSelect` additive-props regression test) before pushing. Watch `gh pr checks` to green per the merge-discipline memory; the i18n key-coverage check (all-21-locale parity) and `test_no_hardcoded_cjk` must both pass.

## Dependencies

- **None new.** Reuses `SearchableSelect` (`frontend/src/components/SearchableSelect.jsx`), `PRESETS` (`frontend/src/utils/constants.js:33`), `lucide-react` (already imported across components — `Play`, `Loader`, `Plus`, `ExternalLink` are all in `lucide-react`; `VoicePreview.jsx:3` and `SearchableSelect.jsx:2` already import from it), `react-i18next`, and the existing `VoicePreview` opener wired through `App.jsx` / `hooks/useProfiles.js`. **No Python dep, no Rust crate, no JS package** — so no `pyproject.toml`/`Cargo.toml`/`package.json` change and no `uv tree`/lockfile churn.
- **Soft dependency direction:** sets the inline-create pattern for **#25** (provides `onCreateVoice` slot) and the gallery-handoff for **#26** (provides `onOpenInGallery`). Neither blocks this PR; this PR ships the seams as no-ops/console wiring.

## Risk

- **Audiobook preset support unknown.** `AudiobookTab` sends `default_voice` (string|null) to the backend audiobook parser via `audiobookGenerate`/`audiobookPlan`/`audiobookPreviewChapter` (`pages/AudiobookTab.jsx:72`/`:103`/`:130-138`); it's unverified whether the parser accepts `preset:<id>`. **Mitigation:** ship Audiobook with `presets={false}` (profiles + engine default only) — matches today's `AudiobookTab.jsx:220-224` exactly. Enable presets later once the parser is confirmed (overlaps #27 parser unification).
- **`SearchableSelect.commit` writes recents unconditionally (`:120-129`).** Without the new `isRecentable` guard, sentinel values (`''`/`preset:`/`auto:`) pollute recents and re-surface as unresolvable pinned rows. **Mitigation:** the `isRecentable` prop (added in 22a, exact `commit` diff in **API / data shapes §3**) excludes sentinels; test #11 enforces it.
- **`currentLabel` raw-value fallback (`:58-61`).** If the engine-default `''` is *not* in `options`, the trigger renders `placeholder` instead of the default label, and a `preset:`/`auto:` selection would show its machine string. **Mitigation:** the `''` row is included as the first searchable option (not a separate fixed row), so `byVal.get('')` resolves; ghost ids resolve to `voiceSelector.missingVoice`; presets/auto-speakers carry human labels (`🎙️ Authoritative` / `🎤 Speaker 1`). Test #3 + #12 enforce it.
- **`VoicePreview` can't resolve `auto:`/`preset:` perfectly, and stale-syncs on `''`.** Preview of a dub auto-speaker may fall back to engine default or a backend error (`VoicePreview.jsx:64-67`/`:79-82`); previewing engine default after a real voice leaves `VoicePreview`'s internal `voiceId` stale (`:34-36` only re-syncs on truthy `initialProfileId`). **Mitigation:** acceptable for an audition; document in the prop JSDoc and migration PR. Presets already resolve in `VoicePreview` (`:58-63`). The stale-`''` case is pre-existing for `WorkspaceVoices`/`Sidebar` callers — not a regression; optional one-line fix at `:34-36` deferred. (No platform divergence in any of these paths.)
- **`SearchableSelect` group-header / footer / isRecentable injection** could regress the one live call site (`CloneDesignTab.jsx:671` language picker). **Mitigation:** all three new props default-off (`false`/`null`/`() => true`); add the regression test; `.ss-group-label` (`index.css:1660`) already exists so no new CSS risk for the header itself.
- **Prop-drilling depth for dub preview + react-window.** **[corrected, expanded]** `DubSegmentRow` is `memo`-wrapped with an explicit comparator (`DubSegmentRow.jsx:396-411`) that does **not** currently list `onPreview`/`onEditField` (it lists `seg`, `disabled`, `isActive`, `isDone`, `isPlaying`, `timelineSelected`, `previewLoading`, `onDirect`, `onSeek`, `selected`, `canMerge`, `profiles`, `speakerClones`, `idx`). Adding `onOpenVoicePreview`/`openVoiceProfile` for the *VoiceSelector* preview/gallery means either (a) they're **stable** callbacks (`openVoiceProfile` is a store action; wrap the App preview closure in `useCallback`) so they don't need comparator entries **provided** they reach the row, or (b) if they can change identity, add them to the comparator. **More important:** the row receives props through the react-window `rowProps`/`Row`-`useCallback` indirection in `DubSegmentTable.jsx:111-141`, whose `Row` has an empty dep array (`:142`) — any new callback MUST be added to `rowProps` object (`:112-114`), its `useMemo` deps (`:115-116`), and the `Row` destructure+forward (`:118`, `:128-141`). This is the single highest-risk part of the migration; the manual smoke must exercise it **on a scrolled-in virtualized row**, not just the first row.
- **MAX_DISPLAY (200) can hide tail groups for huge libraries.** A user with 200+ clones may not see the Presets/From-video groups in the unfiltered list (they sort after the truncation point). **Mitigation:** search narrows below the cap (presets/auto-speakers become reachable by typing), and the "showing N of M" footer (`:208-210`) signals truncation. Document in JSDoc; not a blocker.
- **Stories per-line "inherited" label.** Current code shows `↳ Name` only on the `''` option (`StoriesEditor.jsx:714`, fed by `inheritedName` from `:670`/`profileName` at `:434`). **Mitigation:** the `defaultLabel` prop reproduces this exactly (pass `t('stories.defaultVoice')` as the non-inherited fallback to avoid a copy change); verified in test #3.
- **i18n drift across 21 locales.** Net-new `voiceSelector.*` keys (incl. `missingVoice`) must land in **all 21** locale files or the i18n key-coverage CI check fails and untranslated locales fall back to the key string. **Mitigation:** add all 9 keys to every locale in PR 22a; test #13 is the local fast-fail; CI key-coverage is the cross-locale gate (Constraints → Localization).
- **[corrected] `AppMode` union gap.** `App.jsx` renders the audiobook tab via `mode === 'audiobook'` (`App.jsx:1077`), but `'audiobook'` is **not** in the `AppMode` union in `store/uiSlice.ts:16-30` (it lists `stories` at `:26` but not `audiobook`). This is a pre-existing latent type gap unrelated to this task; do **not** widen scope to fix it here, but be aware navigating to Audiobook works at runtime via string compare. (`openVoiceProfile` sets `mode: 'voice'`, which restores to `modeBeforeVoice` on close (`uiSlice.ts:117-119`) — if you opened the gallery jump from Audiobook, "Back" returns to `'audiobook'`, which renders fine.)

## PR slices

1. **PR 22a — VoiceSelector + SearchableSelect props.** New `VoiceSelector.jsx` + `VoiceSelector.css` + `VoiceSelector.test.jsx`; additive `renderGroupHeaders`/`footer`/`isRecentable` on `SearchableSelect.jsx` (exact `commit` diff in **API / data shapes §3**) + new `SearchableSelect.test.jsx` regression test; i18n `voiceSelector.*` keys (all **9**, incl. `missingVoice`) in **all 21** locales (`en.json` source of truth). No call-site migration yet. No version-file change, no Python, no new dep. Green `bunx vitest run` + i18n key-coverage + `test_no_hardcoded_cjk`.
2. **PR 22b — Migrate the three tabs.** Swap the four `<select>` sites (Stories cast `:550-558` + override `:708-716`, Audiobook default `:220-224`, Dub segment `:288-313`) to `<VoiceSelector>` with per-site `recentsKey`s (`omnivoice.recents.{storiesCastVoice,storiesLineVoice,audiobookVoice,dubSegmentVoice}`); thread `onOpenVoicePreview` (a `useCallback`-stable closure copied from `App.jsx:1232-1233`) + `openVoiceProfile` (stable store action) from `App.jsx:1074`/`:1080`/`:1115` into Stories/Audiobook/Dub; **extend the `DubSegmentTable` `rowProps`/`Row` indirection (`:111-141`)** and, if needed, the `DubSegmentRow` memo comparator (`:396-411`). Wire `onPreview` → the existing `setVoicePreviewProfileId`+`setIsVoicePreviewOpen` closure and `onOpenInGallery` → `openVoiceProfile`. `onCreateVoice` left as a console-noop seam. Manual smoke must cover the virtualized-dub-row preview and the ghost-profile path.
3. *(Out of scope, downstream)* #25 fills `onCreateVoice`; #26 fills the gallery handoff actions.

Optionally collapse to one PR if review prefers, but 22a/22b keeps the additive-`SearchableSelect`-change reviewable in isolation and de-risks the one live call site.

## Acceptance criteria

- [ ] `frontend/src/components/VoiceSelector.jsx` exists and is the only voice-profile picker rendered by StoriesEditor (cast `:550-558` + per-line `:708-716`), AudiobookTab (default voice `:220-224`), and DubSegmentRow (per-segment `:288-313`). No remaining hand-rolled voice `<select>` in those four locations. (The StoriesEditor *character* select at `:698-705` and the dub *speaker-name* datalist at `:213-229` are intentionally untouched.)
- [ ] Option groups render consistently per the §2 schema: engine-default sentinel (first, no header) / Clone profiles / Designed voices / Presets (where enabled) / "From video" (dub). Designed = profiles with truthy `.instruct` (per `VoicePreview.jsx:128`), **not** `kind`. Empty groups emit no header; group order is fixed (default → fromVideo → clone → designed → preset).
- [ ] The closed trigger shows the correct human label for **every** value type — engine default (or `↳ inherited`), clone name, designed name, preset name, `🎤` speaker name, and a **deleted/ghost id** (shows `voiceSelector.missingVoice`, never the raw id), without auto-clearing the stored value.
- [ ] Emitted `onChange` values match the §6 contract exactly (`''` / id / `preset:<id>` / `auto:<slug>`) and the per-site wrappers (`|| null` where applicable) are preserved; no synthesis/dub/audiobook regression in manual smoke (especially the virtualized dub rows scrolled into view, and the audiobook SSE stream rendering unchanged).
- [ ] Picker is searchable with recents (delegated to `SearchableSelect`, per-site `recentsKey`) on all four sites; the persisted `localStorage` recents blob matches the §4 shape (`string[]`, max 8, ids only) — sentinels (`''`/`preset:`/`auto:`) excluded via `isRecentable`.
- [ ] Inline preview (QW6): a play button beside the field auditions the selected voice via the existing local `VoicePreview` opener (`App.jsx:1325-1331` popover, state at `:222-223`) — which reaches only the pre-existing `POST /generate` multipart call (§5) — without leaving the tab; `previewLoading` shows the `Loader` spinner and disables the button; preview is enabled for engine-default and degrades gracefully (no crash) for `auto:`/`preset:`.
- [ ] Inline-create seam (#25): when `onCreateVoice` is provided a "+ Create voice" row appears and fires the callback without committing a value (proven by test; wired to a noop pending #25).
- [ ] Gallery jump: shown only when value is a real profile id present in `profiles` (the §Gallery-jump predicate); calls `openVoiceProfile(id)` (`uiSlice.ts:108-115`) and lands on the voice page; hidden for `''`/`preset:`/`auto:`/ghost ids.
- [ ] Defensive against empty/undefined `profiles`, empty/null `speakerClones`, and unnamed profiles — no crash, no stray empty group headers.
- [ ] `bunx vitest run` green, including new `VoiceSelector.test.jsx` (13 cases incl. recents-exclusion, ghost-profile, value-contract-byte-match, and the localization-coverage guard) and the `SearchableSelect` additive-props regression test (group-header / footer / isRecentable, asserting the §3 `commit` diff).
- [ ] **Constraints satisfied and auditable:** no platform branch (cross-platform default-parity rule met by construction); no cloud/account/telemetry and **no new endpoint** (local-first met; only the existing `POST /generate` reached via preview); no DB schema change / no alembic / no new wire field / dangling profile ids preserved not auto-cleared (backward-compatible data met); zero Python and one linear `\s+` regex (CodeQL `py/polynomial-redos` N/A and JS regex ReDoS-clean); all new strings via `t('voiceSelector.*')` with all 9 keys (incl. `missingVoice`) present in **every one of the 21** `locales/*.json` and `test_no_hardcoded_cjk` unaffected; no version-file change (continuous-to-main patch).
- [ ] No new dependency (`pyproject.toml`/`Cargo.toml`/`tauri.conf.json`/`package.json` untouched).
- [ ] PR checks green before merge (CI-gate memory), including i18n key-coverage across all 21 locales.
