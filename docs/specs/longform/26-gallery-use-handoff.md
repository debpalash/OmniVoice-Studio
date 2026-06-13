# Spec — TASK #26: Gallery "Use in Stories" / "Set as Audiobook default" + create-voice handoff

## TL;DR

Today the Gallery's "Use voice" action materializes an archetype/community voice into a profile and hard-codes a handoff into the **Studio** synthesis view (`frontend/src/pages/VoiceGallery.jsx:199-210` for archetypes; `frontend/src/App.jsx:254-268` for the studio-side pickup). There is no path from the Gallery into the **Stories** cast or the **Audiobook** default narrator. This task adds two quick-actions to gallery + community cards — "Use in Stories" and "Set as Audiobook default" — that (a) materialize the voice into a real profile (same backend call as today) and (b) land it in the right destination: appended to the Stories cast as a new character, or set as the persisted Audiobook default voice. The Audiobook default currently has no store binding at all, so this task also promotes it from local `useState` to a persisted store field.

This is a **default-mode, pure-frontend** feature: it ships out of the box with no opt-in toggle and no OS-specific code, so it must (and does — see §Constraints) behave identically on macOS/Windows/Linux. No cloud, no accounts, no new deps; the only persistence change is a localStorage (zustand) key + version bump (no DB / no alembic).

## Problem

- **[grounded]** `VoiceGallery.jsx` archetype `onUse` (`:199-210`) materializes a profile via `useArchetypeAsProfile(a.id, a.name)` then forces `setPendingProfileId(r.profile_id)` + `setMode('studio')` + `setDefineMethod('audio')`. Community `onUse` (`:502-509`) only calls `addCommunityItem(item.id, item.name)` and flashes a success toast (`gallery.saved_as_profile` — **[grounded]** `en.json:920` = `"Added \"{{name}}\" to your voices."`) — it doesn't even hand off to studio.
- A user building a multi-character story or an audiobook has to: leave Stories/Audiobook → open Gallery → Use voice (which yanks them to Studio) → go back to Stories → manually add a cast member (`StoriesEditor.jsx:159-163` `addCharacter`) → manually pick the just-created voice from the cast `<select>` (`StoriesEditor.jsx:550-558`). That's the friction this task removes.
- **[grounded]** The `pendingProfileId` handoff lives in `App.jsx`: the field/setter are read at `:247-248`, and the pickup effect runs `:254-268`. It is single-purpose — it always finds the profile in `profiles` and calls `handleSelectProfile(prof)` (a Studio-only selection). It can't express "put this profile into the Stories cast" or "make it the Audiobook default."
- **[grounded]** The **Audiobook default voice has no store binding at all** — it's local `const [defaultVoice, setDefaultVoice] = useState('')` in `AudiobookTab.jsx:22`. `AudiobookTab` also receives the profile list as a **prop** (`export default function AudiobookTab({ profiles = [] })`, `:19`), rendered from `App.jsx:1080` as `<AudiobookTab profiles={profiles} />` when `mode === 'audiobook'` (`App.jsx:1077`). So even if we hand a profile id over, there's nowhere to put it that survives navigation. We must add a persisted store field for it.

## Goal / Non-goals

### Goals
1. Add a "Use in Stories" quick-action to archetype and community gallery cards. Clicking it materializes the voice into a profile (existing endpoint) AND adds it to the Stories cast as a new character, then navigates to `mode: 'stories'`.
2. Add a "Set as Audiobook default" quick-action that materializes the voice AND sets it as the Audiobook default narrator voice (new persisted store field), then navigates to `mode: 'audiobook'`.
3. Generalize the `App.jsx` `pendingProfileId` handoff so the destination is driven by a companion `pendingProfileTarget` field (`'studio' | 'stories' | 'audiobook'`), keeping `studio` as the default so existing "Use voice" behavior is unchanged.
4. Keep the existing "Use voice" (→ Studio) action exactly as-is; the two new actions are additive.

### Non-goals
- No backend changes. The materialize endpoints (`POST /archetypes/{id}/use`, `POST /community/items/{id}/use`) are reused verbatim; both already return `{ profile_id, name }` (verified at the wire in `backend/api/routers/archetypes.py:310` / `community.py:280`, and in the TS wrappers `api/archetypes.ts:79-85` / `api/community.ts:68-71`). **(Constraint note: reusing the existing same-origin endpoints keeps the local-first guarantee intact — no new network surface, no cloud, no telemetry.)**
- Not building the shared `<VoiceSelector>` (task #22) or inline "Create Voice" (task #25) — those are separate. This task only adds *handoff destinations*.
- No `.ovsvoice` import (#29), no Dub handoff (#30), no longform-project unification (#31).
- Not changing how Stories resolves effective voice (`utils/storyCast.js` `effectiveProfile`, `:21-25`) — we add a cast member with a `profileId`, the existing resolution applies.
- **Not** validating that the materialized profile actually exists/loads before navigating (the destination views already tolerate an as-yet-unloaded profile id; see §Edge cases). We do not block the nav on a profile-list refresh.
- **Not** de-duplicating the Audiobook default beyond "last write wins" — picking a second voice simply overwrites the field.
- **Not** adding any opt-in toggle, settings field, env var, or CLI flag. This feature is default-on and cross-platform-uniform by construction (§Constraints); no platform-only behavior is introduced that would require gating.

## API / data shapes — the canonical contract

> **This is a load-bearing section.** Everything below is verified at the wire (Python router), the TS wrapper, and the consuming React/store code. Implement against these shapes; do not infer.

### A. Backend `/use` endpoints (reused verbatim — NO change)

Two POST routes materialize a catalog voice into a real on-disk profile. **[grounded — wire-verified]**

#### A.1 `POST /archetypes/{archetype_id}/use`
- **Source:** `backend/api/routers/archetypes.py:260-310` (`async def use_archetype(archetype_id: str, name: Optional[str] = Query(None))`).
- **Request:** path param `archetype_id`; optional query `?name=<url-encoded string>`. No request body. Method `POST`.
- **Side effects (in order):** mints `profile_id = str(uuid.uuid4())[:8]` (`:276` — an **8-char lowercase hex slug**, e.g. `"a3f9c1d2"`, NOT a full UUID), writes `<profile_id>.wav` (`:277`), inserts the profile row (`:300`), then emits the realtime event:
  ```python
  event_bus.emit("profiles", {"action": "created", "id": profile_id})   # archetypes.py:309
  ```
- **Response (200):** exactly
  ```json
  { "profile_id": "a3f9c1d2", "name": "Calm Narrator" }
  ```
  (`return {"profile_id": profile_id, "name": profile_name}`, `:310`). `name` is the **server-resolved** name (the `?name=` query if supplied, else a backend default) — the client must treat `response.name` as authoritative.

#### A.2 `POST /community/items/{item_id}/use`
- **Source:** `backend/api/routers/community.py:217-280`.
- **Request:** path param `item_id`; optional query `?name=`. No body. Method `POST`. Handles both `type: 'preset'` and `type: 'voice'` community items (no `instruct` gating).
- **Side effects:** identical pattern — `profile_id = str(uuid.uuid4())[:8]` (`:236`), `<profile_id>.wav` (`:237`), row insert (`:272`), then:
  ```python
  event_bus.emit("profiles", {"action": "created", "id": profile_id})   # community.py:279
  ```
- **Response (200):** exactly `{ "profile_id": "<8hex>", "name": "<server name>" }` (`:280`).
- **Failure (both routes):** non-2xx → `apiFetch`/`apiJson` throws (the wrapper rejects); the Gallery `try/catch` handles it (§Gallery handler shapes). No partial profile is exposed to the client on error.

### B. Realtime profiles refresh (the WS event that backfills dropdown names)

**[grounded — wire+client verified]** The `/use` routes emit `event_bus.emit("profiles", { action: "created", id })`. On the client, `useAppData.js:114` subscribes:
```js
profiles: () => loadProfiles(),     // useAppData.js:114
```
where `loadProfiles` (`:105`) = `setProfiles(await listProfiles())`, and `listProfiles()` (`api/profiles.ts:4`) = `apiJson<Profile[]>('/profiles')`. **Net contract for this task:** after a `/use` POST resolves, the `"profiles"` WS event fires → the profile list re-fetches → the new `Profile` (with `id === r.profile_id`) appears in both the Stories cast `<select>` (`StoriesEditor.jsx:557`) and the Audiobook `<select>` (`AudiobookTab.jsx:223`). The Gallery handlers do **not** await this — they use the synchronous `r.profile_id` / `r.name` from the POST response. The WS only backfills the *display name* in dropdowns. **(Test note: this WS/refresh path is intentionally NOT unit-tested — it's an integration seam owned by `useAppData`. The handler tests assert the *synchronous* writes only; see Test plan §"What we do NOT test.")**

### C. TS API wrappers (existing — NO change)

```ts
// api/archetypes.ts:79-85
export const useArchetypeAsProfile = (
  id: string,
  name?: string,
): Promise<{ profile_id: string; name: string }>;   // POST /archetypes/{id}/use[?name=]

// api/community.ts:68-71
export const addCommunityItem = (
  id: string,
  name?: string,
): Promise<{ profile_id: string; name: string }>;    // POST /community/items/{id}/use[?name=]
```
Both append `?name=${encodeURIComponent(name)}` **only when `name` is truthy** (`archetypes.ts:83`, `community.ts:69`) — a blank name sends no query and the backend assigns its own default. **Always read `r.name` from the response, never the input `a.name`/`item.name`.** **(Test note: these two functions are the exact `vi.mock(...)` boundary — see Test plan §5. Mocking them is what keeps the handler tests off the network.)**

### D. Consuming type — `Profile` (existing, `api/types.ts:109`)

```ts
// api/types.ts:109 — the shape both <select>s and handleSelectProfile() consume
export interface Profile {
  id: string;                 // === the /use response `profile_id`
  name: string;
  kind: ProfileKind;
  language_code?: string;
  ref_audio?: string;
  ref_text?: string;
  description?: string;
  created_at?: string;
  is_locked?: boolean;
  verified_own_voice?: boolean | number;
  consent_text?: string;
  consent_recorded_at?: number | null;
}
```
The cast/audiobook `<select>`s render `profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)`, keyed on `Profile.id` — which equals the `/use` `profile_id`. This is why a `CastMember.profileId === r.profile_id` resolves once the WS refresh lands.

### E. Store additions — `uiSlice.ts`

```ts
// uiSlice.ts  (field next to pendingProfileId at :55; interface setter at :67;
//              init at :87; impl at :99)
export type PendingProfileTarget = 'studio' | 'stories' | 'audiobook';

interface UiSlice {
  // ...existing
  pendingProfileId: string | null;                                                 // :55 (unchanged)
  pendingProfileTarget: PendingProfileTarget;                                       // NEW — default 'studio'; TRANSIENT (not persisted)
  // CHANGED signature (was `(id: string | null) => void` at :67) — second arg optional, defaults 'studio'
  setPendingProfileId: (id: string | null, target?: PendingProfileTarget) => void; // :67
}

// init (:87) — add next to `pendingProfileId: null,`
pendingProfileTarget: 'studio',

// impl (:99) — null clears BOTH (normalize target so a stale non-studio target can't leak):
setPendingProfileId: (id, target = 'studio') =>
  set({ pendingProfileId: id, pendingProfileTarget: id == null ? 'studio' : target }),
```

**[grounded]** Current impl is `setPendingProfileId: (id) => set({ pendingProfileId: id })` (`uiSlice.ts:99`), interface `(id: string | null) => void` (`:67`), init `pendingProfileId: null` (`:87`), field+doc-comment `:50-55`. The single-arg call sites (`VoiceGallery.jsx:204`, the clear at `App.jsx:259`) are **source-compatible** with the new optional second arg — TS optional params don't break existing callers. **[grounded]** `createUiSlice` is the `StateCreator` export at `uiSlice.ts:80` — directly callable in a unit harness (see Test plan §4), identical shape to `createStoriesSlice`/`createUpdaterSlice`.

**[constraint] `pendingProfileTarget` is transient, NOT persisted.** It is deliberately omitted from `partialize` (`index.ts:72-114`) — like `pendingProfileId` itself, which is not in the partialize list and so resets to its slice default on reload (per the `uiSlice.ts:50-54` doc comment: hand-offs are one-shot). This means it adds **zero** persisted-shape surface and the store `version` bump (below) is driven solely by `audiobookDefaultVoice`.

### F. Store additions — `storiesSlice.ts`

```ts
// storiesSlice.ts  (interface :36-51; init :67-70; impl ~:71)
interface StoriesSlice {
  // ...existing
  audiobookDefaultVoice: string;                       // NEW — profile id; '' = engine default. PERSISTED (only new partialize key).
  setAudiobookDefaultVoice: (id: string) => void;      // NEW
}

// init — add next to `storyTracks: []` (:67)
audiobookDefaultVoice: '',

// impl — add next to `setStoryTracks`/`setCast` (:71-72)
setAudiobookDefaultVoice: (audiobookDefaultVoice) => set({ audiobookDefaultVoice }),
```

**[grounded]** `storiesSlice.ts` is 114 lines; the `StoriesSlice` interface is `:36-51`; slice init opens at `:66` (`createStoriesSlice = ... => ({` then `storyTracks: []` at `:67`); existing setters `setStoryTracks`/`setCast` at `:71-72`. `createStoriesSlice` and `DEFAULT_CAST` are both exported (the test harness already imports both — `storiesSlice.test.ts:2`).

**[completeness] Project-load isolation (decision):** `audiobookDefaultVoice` is a **global longform preference**, NOT part of a saved `StoryProject`. It must therefore be **excluded** from `saveProject`/`loadProject`/`newProject` (`storiesSlice.ts:84-106`). **[grounded — verified]** `loadProject` (`:104`) does `set({ storyTracks: …, cast: …, currentProjectId: id })`, `newProject` (`:106`) does `set({ storyTracks: [], cast: …, currentProjectId: null })`, and `saveProject` (`:84-100`) snapshots only `{ id, name, tracks, cast, updatedAt }` into the `StoryProject` — all **explicit-key** writes, so the new field is untouched today. Keep it that way; do not add it. The `StoryProject` interface (`:28-34`) is therefore **unchanged**:
```ts
interface StoryProject { id: string; name: string; tracks: StoryTrack[]; cast: CastMember[]; updatedAt: number; }
```
**(Test note: this isolation is pinned by Test plan §3 — a pure-slice test, no React.)**

**[grounded]** `AudiobookTab.jsx` then reads/writes the store instead of local `useState`. The component does **not** currently import or use the store — it takes `profiles` as a prop only. You'll add a `useAppStore` import and two selectors:
```js
import { useAppStore } from '../store';
const defaultVoice    = useAppStore(s => s.audiobookDefaultVoice);
const setDefaultVoice = useAppStore(s => s.setAudiobookDefaultVoice);
```
Keeping the local names `defaultVoice`/`setDefaultVoice` means the four consumers need **no further edits**:
- the `<select>` at `:220-221` (`value={defaultVoice}` / `onChange={(e) => setDefaultVoice(e.target.value)}`),
- `onPreview` at `:72` (`audiobookPlan({ text, default_voice: defaultVoice || null })`),
- `onPreviewChapter` at `:103` (`default_voice: defaultVoice || null`),
- `onCreate` at `:132` (`default_voice: defaultVoice || null`),
- and the three `useCallback` deps arrays that list `defaultVoice` (`:78`, `:111`, `:175`).

**[grounded] Downstream wire shape it feeds (audiobook API):** the bound `defaultVoice` flows as `default_voice` (a profile id `string | null`) into three request bodies — `audiobookPlan({ text, default_voice })` (`api/audiobook.ts:20-29`), `audiobookPreviewChapter({ text, chapter_index, default_voice, lexicon })` (`:39-48`), and `audiobookGenerate({ text, default_voice, format, loudness, cover_path, metadata, lexicon })` (`:76-82`, body type `AudiobookGenerateBody` at `:60-69`). The `|| null` coercion means `''` → `null` (engine default) on the wire, exactly today's behavior. **No request-shape change** — only the *source* of `default_voice` moves from local state to the store.

**[completeness] Stale-id rendering:** the `<select>` (`:220-223`) renders one `<option>` per `profiles` prop entry plus a fixed `<option value="">` engine-default. If `audiobookDefaultVoice` is a profile id **not** in `profiles` (deleted profile, or set from the Gallery before the WS refresh lands), the controlled `<select value={defaultVoice}>` shows a blank/unmatched value. This is acceptable and must NOT auto-reset the store value — the id may still be valid backend-side and may become matchable once `profiles` refreshes. The `default_voice: defaultVoice || null` calls (`:72/:103/:132`) pass the raw id to the backend regardless; the backend is the authority on whether it resolves. Do **not** add client-side "scrub unknown id to ''" logic — it would silently lose a freshly-handed-off voice during the refresh window. **(Test note: this no-scrub guarantee is pinned by Test plan §6's unmatched-id render case.)**

### G. Store persistence — `store/index.ts`

**[grounded]** `index.ts` `partialize` is `:72-114`; the Stories block is `:107-113` (`storyTracks`, `cast`, `storyProjects`, `currentProjectId`). Add one line:
```js
// inside partialize, append to the Stories block (after currentProjectId at :113)
audiobookDefaultVoice: s.audiobookDefaultVoice,
```
Bump the version:
```js
version: 5,   // was 4 at index.ts:115
```
**[grounded]** `migrate` is `:120-130` and is a pass-through for every version (`return persisted as Partial<AppStore>` in both the `if (version < 4)` branch and the fallthrough). Extend the comment-or-guard to `< 5` (no logic change needed — both branches already pass through). A v4-persisted state has no `audiobookDefaultVoice` key; on rehydrate zustand merges persisted-over-init, so the missing key falls through to the slice default `''` (engine default). **No migration code beyond the version bump is required.** **[constraint]** Do **not** add `pendingProfileTarget` to `partialize` — it's transient (matches `pendingProfileId`, also absent), so the only new persisted key is `audiobookDefaultVoice`.

**(Test note: `partialize`/`migrate` are NOT unit-tested today — there is no test that exercises `index.ts`'s persist config. The migration is verified two ways: indirectly by the slice-default test [§1, the field defaults `''`], and by the manual v4→v5 rehydrate in Acceptance §11. Do not invent a brittle test that reaches into zustand-internal persist plumbing.)**

### H. `AppMode` union — `uiSlice.ts:16-30`

**[grounded — verified]** The union currently contains: `launchpad | generate | dub | studio | clone | design | stories | voice | tools | batch | settings` (`:17-30`). `'stories'` is present (`:26`); **`'audiobook'` is genuinely missing** even though it's used as a bare string literal at `App.jsx:170`, `:1077`. Add it:
```ts
export type AppMode =
  | 'launchpad' | 'generate' | 'dub' | 'studio'
  | 'clone' | 'design' | 'stories' | 'voice' | 'tools' | 'batch' | 'settings'
  | 'audiobook';   // NEW — required for setMode('audiobook') to type-check
```
(`'gallery'`, `'transcriptions'`, `'donate'`, `'queue'`, `'enterprise'` are used as string literals elsewhere in `App.jsx` but are out of scope here — don't conflate them.) **(Test/CI note: this is the one change in this task that the `typecheck:ci` gate — `tsc --noEmit --checkJs false`, `ci.yml:103` — directly enforces. `setPendingProfileId(id, 'audiobook')` and `setMode('audiobook')` in `.ts` call sites fail typecheck until `'audiobook'` is in the union. The `.jsx` Gallery handlers are NOT type-gated, so the union edit is the load-bearing type safety net.)**

### I. Cast member shape (existing — `storiesSlice.ts:21-26`)

```ts
interface CastMember { id: string; name: string; color: string; profileId: string | null; }
```
The Stories handoff appends one of these via `upsertCastMember` (signature `(member: CastMember) => void`, `storiesSlice.ts:43`; impl `:73-80` dedups by `id` — appends if new, shallow-merges if the `id` already exists). **[grounded]** The existing `upsertCastMember` test is `storiesSlice.test.ts:30-37` (adds `{id:'fox',…}` then updates by same id) — the new gallery-shaped-member test (§2) mirrors it.

### J. Gallery handler shapes (Option B — self-contained, with in-flight guard)

```js
// In VoiceGallery() body (the component at :56). `flash`, `setMode`, `t` are
// already in scope (:81, :68, :57). Add selectors:
//   const upsertCastMember        = useAppStore(s => s.upsertCastMember);
//   const setAudiobookDefaultVoice = useAppStore(s => s.setAudiobookDefaultVoice);
// and `import { nextCastColor } from '../utils/storyCast';`
//
// One busy ref shared across the new handlers prevents concurrent/double-tap
// double-materialize on a single card.
const busyRef = useRef(null);   // holds the in-flight card id, else null

// makeCastId mirrors StoriesEditor.jsx genCastId (:95-97) — module-local & not exported,
// so inline an equivalent rather than import it:
const makeCastId = () => `c_${Math.random().toString(36).slice(2, 8)}`;

// archetype zone (siblings of onUse at VoiceGallery.jsx:199)
const onUseInStories = async (a) => {
  if (busyRef.current) return;                 // guard: ignore re-entry while a use is mid-flight
  busyRef.current = a.id;
  try {
    const r = await useArchetypeAsProfile(a.id, a.name);   // -> { profile_id: string, name: string }
    upsertCastMember({
      id: makeCastId(),
      name: r.name,                                          // r.name (backend-authoritative; may be CJK — runtime data, not a source literal)
      color: nextCastColor(useAppStore.getState().cast),    // reads live cast (storiesSlice top-level field)
      profileId: r.profile_id,                              // === Profile.id once WS refresh lands
    });
    flash(t('gallery.added_to_stories', { defaultValue: 'Added "{{name}}" to your Stories cast.', name: r.name }));
    setMode('stories');                                     // flash BEFORE nav (toast host is Gallery-local; best-effort either way — edge 5)
  } catch {
    flash(t('gallery.use_failed', { defaultValue: 'Could not create that voice — the engine may be loading.' }));
    // on failure: do NOT setMode — user stays in the Gallery to retry. No cast mutation happened.
  } finally {
    busyRef.current = null;
  }
};

const onUseAsAudiobookDefault = async (a) => {
  if (busyRef.current) return;
  busyRef.current = a.id;
  try {
    const r = await useArchetypeAsProfile(a.id, a.name);
    setAudiobookDefaultVoice(r.profile_id);                // string profile id; persisted
    flash(t('gallery.set_as_default', { defaultValue: 'Set "{{name}}" as the Audiobook default.', name: r.name }));
    setMode('audiobook');                                  // requires 'audiobook' in AppMode (section H)
  } catch {
    flash(t('gallery.use_failed', { defaultValue: 'Could not create that voice — the engine may be loading.' }));
  } finally {
    busyRef.current = null;
  }
};

// community zone (inline in CommunityZone, :490-513) — identical structure, but
// `const r = await addCommunityItem(item.id, item.name);` instead of useArchetypeAsProfile.
// Same guard, same r.name usage, same on-failure "stay put" behavior.
```

**[grounded]** Both `useArchetypeAsProfile` and `addCommunityItem` resolve to `{ profile_id: string; name: string }`. No new API surface.

**[completeness] Optional `profileId`-dedup before the Stories append** (edge 7) — if taken, the shape is:
```js
const cast = useAppStore.getState().cast;
if (cast.some(c => c.profileId === r.profile_id)) {
  flash(t('gallery.already_in_cast', { defaultValue: '"{{name}}" is already in your Stories cast.', name: r.name }));
} else {
  upsertCastMember({ id: makeCastId(), name: r.name, color: nextCastColor(cast), profileId: r.profile_id });
}
setMode('stories');
```

**[testability note — extract the handler bodies if you want a pure test.]** The four handlers above are defined inside `VoiceGallery()`, so the *most direct* way to test them is a component test (§5) that drives the rendered Menu items. If the reviewer prefers a **pure** (React-free) handler test, factor the materialize→write→navigate body into a small free function in `utils/storyCast.js` or a new `utils/galleryHandoff.js`, e.g.:
```js
// utils/galleryHandoff.js — pure, dependency-injected; testable with plain vi.fn() stubs, no React render
export async function handoffToStories(materialize, { id, name }, { upsertCastMember, setMode, flash, t, getCast, makeCastId }) {
  const r = await materialize(id, name);
  upsertCastMember({ id: makeCastId(), name: r.name, color: nextCastColor(getCast()), profileId: r.profile_id });
  flash(t('gallery.added_to_stories', { defaultValue: 'Added "{{name}}" to your Stories cast.', name: r.name }));
  setMode('stories');
  return r;
}
```
This is **optional** but recommended: a DI'd free function turns §5's success/failure/`r.name` assertions into pure unit tests that need no DOM, no jsdom, no `@testing-library/react` — matching the "pure/handler-direct" strategy used for the slices. The component test (§5b) then only needs to assert the *wiring* (Menu item → handler called once), not the full behavior. If the extraction isn't taken, §5 runs entirely as a component test; both are documented in the Test plan.

**[constraint] No user-input regex introduced.** None of the handlers, `makeCastId`, or the store setters build or run a regex over user-supplied text (the `c_*` id uses `Math.random().toString(36)`, not parsing). There is therefore **no CodeQL `py/polynomial-redos` (or JS-equivalent `js/redos`) surface** in this task — see §Constraints. If a future revision adds name-validation, it must follow the ReDoS guidance in the memory note (no overlapping `\s*`/`.+`, exclude both delimiters in `[^x]*`).

### K. i18n keys (en.json `gallery` block, `:892-`)

**[grounded]** Add as siblings of `gallery.use_voice` (`:916`); existing neighbors include `saved_as_profile` (`:920`) and `use_failed` (`:921`) — reuse `use_failed` for the failure path. New keys (all via `t(..., { defaultValue })`, never bare literals):

| key | defaultValue | interpolation |
|-----|--------------|---------------|
| `gallery.use_in_stories` | `"Use in Stories"` | — (Menu item label) |
| `gallery.set_audiobook_default` | `"Set as Audiobook default"` | — (Menu item label) |
| `gallery.more_actions` | `"More actions"` | — (Menu trigger aria-label) |
| `gallery.added_to_stories` | `"Added \"{{name}}\" to your Stories cast."` | `{ name }` |
| `gallery.set_as_default` | `"Set \"{{name}}\" as the Audiobook default."` | `{ name }` |
| `gallery.already_in_cast` *(only if dedup mitigation taken)* | `"\"{{name}}\" is already in your Stories cast."` | `{ name }` |
| `gallery.use_failed` *(existing, reused)* | `"Could not create that voice — the engine may be loading."` | — |

Other locale files fall back to the English `defaultValue` (i18next default; consistent with the rest of the file). **(Test note: `src/test/setup.js` initializes the real i18n instance with `fallbackLng:'en'`, so component/handler tests can assert on the real rendered English strings — not bare keys. Test plan §8 asserts the keys exist + the CJK lint passes.)**

## Design

### 1. Generalize the pending handoff (store)

Add `pendingProfileTarget` (section E) next to `pendingProfileId`. It defaults to `'studio'`, is folded into `setPendingProfileId(id, target?)`, and is normalized to `'studio'` on the clear path (`setPendingProfileId(null)`) so a cleared handoff never leaves a dangling non-studio target that a later legacy single-arg call would inherit.

This field is only strictly needed if the **studio** path is the funnel for all destinations. Under the recommended **Option B** (below) the new actions are self-contained and don't route through the `App.jsx` effect, so `pendingProfileTarget` is added for *consistency/future use* but the new buttons don't depend on it. Adding it is cheap and keeps the door open for a single-funnel refactor.

### 2. Audiobook default voice → persisted store

Add `audiobookDefaultVoice` + `setAudiobookDefaultVoice` to `storiesSlice.ts` (section F), persist it (section G), and repoint `AudiobookTab.jsx:22` from local `useState` to the store (section F). Excluded from project load/save (global pref). Stale-id rendering is tolerated (no scrub).

### 3. App.jsx handoff effect — branch by target

**[grounded]** The effect at `App.jsx:254-268` waits for the profile to appear in `profiles` (from `useTTS`/`useAppData`), calls `handleSelectProfile(prof)`, clears via `setPendingProfileId(null)`, and otherwise refreshes once via `loadProfiles()` (guarded by `pendingRefreshRef`). `setMode` is a store selector at `App.jsx:110`.

If we route stories/audiobook through here, branch on `pendingProfileTarget`:
- `'studio'` (default, existing): wait for the profile in `profiles`, `handleSelectProfile(prof)`, clear.
- `'stories'`: `upsertCastMember(...)` keyed off the new profile, `setMode('stories')`, clear.
- `'audiobook'`: `setAudiobookDefaultVoice(profileId)`, `setMode('audiobook')`, clear.

Because the Stories/Audiobook targets don't need to wait for `profiles` to reload, two options:

- **Option A (minimal):** keep `pendingProfileId` as just the id; for stories, App.jsx waits for `profiles` (same as studio) to read the profile's `name`. Downside: cast member doesn't appear until `loadProfiles` returns. **[completeness]** Option A also inherits the existing effect's failure mode: if `loadProfiles()` never returns the id (materialize succeeded backend-side but the profile is filtered out, or the WS event is dropped), `pendingProfileId` stays set and `pendingRefreshRef` pins to that id — the effect will not re-fire `loadProfiles` again (guard at `:264`), so the handoff silently stalls with no cast member ever appended.
- **Option B (recommended):** the Gallery does the materialize + destination write *itself* (it already has `{profile_id, name}` in hand), then only navigates. No `pendingProfileTarget` plumbing needed for stories/audiobook — the handoff stays studio-only. The new profile shows up in dropdowns when the realtime `profiles` WS event (section B) refreshes the list.

**Decision: Option B for stories/audiobook destinations.** **[grounded]** The realtime refresh is wired at `useAppData.js:114` (`profiles: () => loadProfiles()`). The Gallery directly calls `upsertCastMember(...)` / `setAudiobookDefaultVoice(...)` + `setMode(...)` using the synchronous POST response. The `pendingProfileTarget` generalization is still added for the *studio* path consistency, but the new actions don't depend on the App.jsx effect — matching how the existing community `onUse` already does its own client-side work.

**[completeness] Why Option B is correct under failure:** Option B's cast-member/default write uses the `profile_id` returned *synchronously* by the resolved materialize promise — it does not depend on the WS refresh, `loadProfiles`, or the profile appearing in any list. The only thing the WS refresh affects is the *display name* in the dropdowns. If the WS event never arrives, the cast member still exists (it stores `profileId` + the `name` from the response, not a list lookup), and the Audiobook default is still set + persisted; the dropdown just shows the stored name (cast) / blank until a manual reload (audiobook). There is no stuck-spinner / lost-handoff failure mode like Option A's. **(Test note: this is precisely why §5's handler tests are robust — they assert only the synchronous writes from the resolved promise, with no WS/refresh dependency to flake on.)**

> If the reviewer prefers a single funnel through App.jsx, Option A is documented above as the fallback — but Option B is the recommended slice (and avoids Option A's stall).

### 4. Gallery card UI

**[grounded]** `ArchetypeCard` (`VoiceGallery.jsx:393-450`) currently has 3 footer buttons inside `.arch-foot` (`:436-447`): Preview (`onPreview`, `:437`), "Use voice" (`onUse`, `:441`, label `gallery.use_voice`), and a Designer icon button (`onDesign`, `:444`). Add the two new destinations.

To avoid footer crowding (especially in `list` viewMode), use the existing `Menu` UI primitive. **[grounded] Menu API (verified against `frontend/src/ui/Menu.jsx`):** default export, re-exported from `../ui` via `ui/index.js`. **Item-array-driven**, not children-as-menu-items:
```jsx
// Menu.jsx prop contract (:19-27)
<Menu
  items={[ /* item | 'separator' */ ]}     // each item: { id?, label, icon?, onSelect?, disabled?, destructive?, shortcut?, trailing? }
  placement="bottom-end"                    // 'bottom-start'|'bottom-end'|'top-start'|'top-end'
  disabled={busy}                           // disables the TRIGGER (:51)
  // open / onOpenChange / width also supported
>
  {/* exactly ONE child — the trigger element (must be a valid React element, :37-39) */}
  <button className="..." aria-label={t('gallery.more_actions', { defaultValue: 'More actions' })}>
    <ChevronDown size={14} />
  </button>
</Menu>
```
Item rendering: `item.icon` is a `lucide-react` component rendered at `size={12}` (`Menu.jsx:76`); `item.label` is the text span (`:77`); `onSelect` fires once and Radix auto-closes the menu (`:74`). Already imported and used this way in `StoriesEditor.jsx:16` (import) and `:719` (usage).

So the "split-button dropdown" is: a primary "Use voice" button (unchanged `onUse`) plus a chevron button wrapped in:
```jsx
<Menu
  placement="bottom-end"
  disabled={busyRef.current === a.id}
  items={[
    { id: 'stories',   label: t('gallery.use_in_stories', { defaultValue: 'Use in Stories' }),         icon: BookOpen,   disabled: busyRef.current === a.id, onSelect: () => onUseInStories(a) },
    { id: 'audiobook', label: t('gallery.set_audiobook_default', { defaultValue: 'Set as Audiobook default' }), icon: BookMarked, disabled: busyRef.current === a.id, onSelect: () => onUseAsAudiobookDefault(a) },
  ]}
>
  <button className="arch-more-btn" aria-label={t('gallery.more_actions', { defaultValue: 'More actions' })}><ChevronDown size={14} /></button>
</Menu>
```

**[constraint] Menu item labels must be localized.** Every `item.label` is user-facing — it must come through `t('gallery.…', { defaultValue: '…' })`, never a bare string literal. The `icon` is a `lucide-react` component (non-textual, no i18n).

**[completeness] Menu/trigger edge cases (verified against `Menu.jsx`):**
- The `Menu` trigger child must be a valid React element or the component returns the child/`null` (`Menu.jsx:37-39`) — pass a real `<button>`, not a fragment/text.
- Radix `onSelect` fires once and auto-closes the menu (`Menu.jsx:74`). Don't `preventDefault`. The async handler runs after close; don't assume the menu is still mounted — all UI feedback (toast/nav) goes through store/`flash`, never menu-local state.
- **In-flight guard:** `disabled: busyRef.current === a.id` on both items (Menu honors `item.disabled`, `:72-73`) plus the handler-level `if (busyRef.current) return` early-return (which also covers the primary "Use voice" button). Recommend the handler-level guard as the primary defense since it's destination-agnostic; the `disabled` flag is the visible affordance.
- The chevron trigger uses the `Menu` `disabled` prop (`:26,:51`) bound to the same busy flag.

> **Note:** because `busyRef` is a `useRef`, toggling it does **not** re-render `ArchetypeCard`, so a `disabled` bound to `busyRef.current` won't visually update mid-flight. If a *visible* disabled affordance is required, mirror the busy id into a `useState` (e.g. `const [busyId, setBusyId] = useState(null)`) set alongside the ref, and bind `disabled` to `busyId === a.id`. The ref guard remains the correctness mechanism; the state is purely for the affordance. (Mirrors the existing per-card `loadingPreviewId` state pattern at `:76`.)

The three handlers (`onUse`, `onUseInStories`, `onUseAsAudiobookDefault`) are passed into `ArchetypeCard` via `cardProps` (`VoiceGallery.jsx:283-289`) and reused by `CommunityZone` (`:490-513`).

### 5. Community parity

**[grounded]** Community `onUse` (`VoiceGallery.jsx:502-509`) calls `addCommunityItem(item.id, item.name)` → `{ profile_id, name }` and flashes `gallery.saved_as_profile`. The `CommunityZone` reuses `ArchetypeCard` (`:490-513`) with **inline** handlers (not the archetype-zone `cardProps`), so the new `onUseInStories`/`onUseAsAudiobookDefault` must be added inline there too. Recorded community voices (no `instruct`, `type: 'voice'`) still materialize fine — `addCommunityItem` handles both `preset` and `voice` types (see `CommunityItem` in `api/community.ts:8-23`).

**[completeness] Community item without a usable name:** `CommunityItem.name` is required (`api/community.ts:8-11`), but if a manifest entry ships with an empty string, `addCommunityItem(id, '')` sends no `?name=` query (the helper only appends it when truthy, `community.ts:69`) and the backend assigns its own default name. The returned `r.name` is authoritative — always use `r.name` for the cast member, never `item.name`.

**[constraint] Community item names may legitimately contain CJK** (a community-shared persona could be named in any of the 646 languages). This is **not** a hardcoded-CJK violation: the name is *runtime data* from the backend response (`r.name`) flowing into a `CastMember.name` / `<option>` label, never a literal in source. The CJK lint (`tests/test_no_hardcoded_cjk.py`) scans source files for literal CJK, not runtime values, so no allowlist entry is needed. The cast-member name renders as-is (user/community content); the surrounding chrome (button labels, toasts) is localized via `t()`. **(Test note: §5 includes a deliberate CJK `r.name` assertion to prove runtime non-English names flow through unmangled — exercising the runtime path the lint does NOT cover.)**

## Integration points (file:line — all verified)

- `frontend/src/store/uiSlice.ts` — `pendingProfileId` field at **:55** (doc comment **:50-54**); add `pendingProfileTarget` next to it (init at **:87**, value `'studio'`). Add `PendingProfileTarget` type export. Change the interface setter at **:67** to `(id: string | null, target?: PendingProfileTarget) => void` and the impl at **:99** to set both fields with the null-normalization (section E). `createUiSlice` is the `StateCreator` export at **:80** (unit-harnessable).
- `frontend/src/store/uiSlice.ts:16-30` — `AppMode` union; add `'audiobook'` (section H). `'stories'` already present (`:26`). **This is the change `typecheck:ci` gates on.**
- `frontend/src/store/storiesSlice.ts:36-51` — `StoriesSlice` interface; add `audiobookDefaultVoice: string` + `setAudiobookDefaultVoice`. Init near **:67** (`audiobookDefaultVoice: ''`), impl near **:71** (section F). **[completeness]** Do **not** add it to `saveProject`/`loadProject`/`newProject` (`:84-106`) — global pref, not project data.
- `frontend/src/store/index.ts:72-114` — `partialize`; append `audiobookDefaultVoice: s.audiobookDefaultVoice` to the Stories block (after `currentProjectId` at **:113**). Bump `version: 4`→`5` at **:115**. `migrate` (**:120-130**) is already a full pass-through; extend the `< 4` comment/guard to `< 5` (no logic change). Only one new persisted key.
- `frontend/src/pages/AudiobookTab.jsx:22` — replace `const [defaultVoice, setDefaultVoice] = useState('')` with the two store selectors; add `import { useAppStore } from '../store';`. Keeping the local names means `<select>` (**:220-221**) and consumers (**:72**, **:103**, **:132**, deps **:78/:111/:175**) need no further edits (section F).
- `frontend/src/pages/VoiceGallery.jsx:59-73` — store selectors block (`setMode` at **:68**, `setPendingProfileId` at **:70**). Add `upsertCastMember`, `setAudiobookDefaultVoice` selectors; import `nextCastColor` from `../utils/storyCast`; import `BookOpen`/`BookMarked`/`ChevronDown` from `lucide-react` (existing import block **:9-12**). `Menu` import from `../ui`. `const { t } = useTranslation()` already in scope at **:57**. `flash` defined at **:81** (sets `notice` at **:78**, rendered at **:184**).
- `frontend/src/pages/VoiceGallery.jsx:199-217` — archetype zone props (`ArchetypesZone` props object); add `onUseInStories` / `onUseAsAudiobookDefault` siblings of `onUse` (**:199**).
- `frontend/src/pages/VoiceGallery.jsx:283-289` — `cardProps`; thread the two new handlers (destructured in `ArchetypesZone`'s signature at **:243-246** and `ArchetypeCard`'s at **:393-396**).
- `frontend/src/pages/VoiceGallery.jsx:393-450` / `:436-447` — `ArchetypeCard` `.arch-foot`; render the split-button + `Menu` (section 4).
- `frontend/src/pages/VoiceGallery.jsx:490-513` — `CommunityZone` card; mirror the new handlers inline using `addCommunityItem` (not via `cardProps`).
- `frontend/src/App.jsx:247-268` — `pendingProfileId` field/setter reads (**:247-248**) + pickup effect (**:254-268**). Under Option B this stays studio-only; the single-arg `setPendingProfileId(null)` clear at **:259** still works (now also normalizes target). `setMode` at **:110**; audiobook render at **:1077-1080**.
- `frontend/src/store/storiesSlice.ts:73-80` — `upsertCastMember` (the exact API the Stories handoff uses; dedups by `id`, `:75`). **[completeness]** Fresh random `c_*` ids per click → repeated clicks append duplicates unless the optional `profileId`-dedup (section J) is added in the Gallery handler.
- `frontend/src/components/StoriesEditor.jsx:95-97` — **[grounded]** `genCastId()` lives **here** (module-local, **not exported**): returns `` `c_${Math.random().toString(36).slice(2, 8)}` ``. The Gallery inlines an equivalent `makeCastId` (section J). `addCharacter` (**:159-163**) uses `{ id: genCastId(), name, color: nextCastColor(cast), profileId: null }`.
- `frontend/src/i18n/locales/en.json:892-936` — `gallery` block; `use_voice` at **:916**, `saved_as_profile` at **:920**, `use_failed` at **:921**. Add the new keys (section K) as siblings. **[grounded]** `en.json` is the canonical source loaded at `i18n/index.ts:4`; English-only new keys are sufficient (other locales fall back to English).
- `frontend/src/hooks/useAppData.js:105,:114` — `loadProfiles` (`:105`, `setProfiles(await listProfiles())`) and the `"profiles"` WS subscription (`:114`, `profiles: () => loadProfiles()`). The backfill mechanism for dropdown names (section B). No edit needed; documented for the contract.
- `backend/api/routers/archetypes.py:260-310` / `community.py:217-280` — the `/use` routes. No edit; the wire contract (section A).
- **Test files (new / extended — see §Test plan):** `frontend/src/store/storiesSlice.test.ts` (extend), `frontend/src/store/uiSlice.test.ts` (**new**), `frontend/src/pages/VoiceGallery.test.jsx` (**new**, or a pure `frontend/src/utils/galleryHandoff.test.js` if §J's extraction is taken), `frontend/src/pages/AudiobookTab.test.jsx` (**new**). All under `src/**/*.test.{js,jsx,ts,tsx}` so the existing `bunx vitest run` include glob picks them up automatically — no config change.

## Edge cases, failure & empty states (completeness)

Every branch the two new actions must survive, with the verified-on-disk behavior. **Each edge that a test pins names its Test-plan item.**

### Materialize call (the `POST .../use` round-trip)
1. **Network/backend failure (engine loading, 5xx, timeout):** the wrapper rejects → the `try/catch` flashes `gallery.use_failed`, **does not navigate**, **does not mutate** cast/default. The user stays in the Gallery; the card returns to idle (busy guard cleared in `finally`). Mirrors the existing `onUse` failure path (`:207-209`). **(Test §5 failure path.)**
2. **Success but slow:** the POST can take seconds (model warmup). During that window the busy guard blocks repeat clicks. No partial state is written until the promise resolves with `{ profile_id, name }`. **(Test §5 in-flight guard exercises this with a deferred promise.)**
3. **Double-tap / concurrent click on the *same* card:** blocked by `busyRef.current` early-return → exactly one `POST` and one cast member / one default write. **(Test §5 in-flight guard.)**
4. **Clicks on *two different* cards in quick succession:** the single `busyRef` serializes them (second dropped while the first is in flight). Acceptable; documents the trade-off vs. a per-id busy map.
5. **App/tab unmounts (user navigates away) mid-flight:** `setMode`/`upsertCastMember`/`setAudiobookDefaultVoice` are store writes, not component-local — they land even if `VoiceGallery` unmounted. **[grounded]** `notice`/`flash` are local to `VoiceGallery` (`:78-85`), so after `setMode` the toast host is gone; the toast won't be visible post-nav regardless of ordering. **Decision:** rely on the destination view's own surfaced state (new cast member visibly present in Stories; pre-filled default `<select>` visibly set in Audiobook) as the success signal; treat the Gallery `flash` as best-effort only.

### Stories destination
6. **A Story project is currently loaded/being edited when the handoff lands:** `upsertCastMember` appends to the *live* `cast` array (`storiesSlice.ts:73-80`), the same array `StoriesEditor` renders. The new member appears immediately; the user's in-progress tracks/cast are preserved (append-only). It's **not** auto-saved to the persisted `StoryProject` until the user saves — consistent with `addCharacter`.
7. **Repeated "Use in Stories" of the same archetype:** each click mints a fresh `c_*` id → `upsertCastMember` appends a *new* member every time (id-dedup at `:75` doesn't collapse them). Result: multiple cast members all pointing at the same `profileId`. **Mitigation (recommended):** the `profileId`-dedup in section J. If the reviewer prefers parity with `addCharacter` (allows dups), leave it append-only and document the bloat. **(Test §2 pins the chosen behavior either way.)**
8. **`cast` at/over the palette length when picking a color:** `nextCastColor` (`storyCast.js:15-18`) wraps by `cast.length % CAST_COLORS.length` (8 colors) — never throws.
9. **`cast` empty (shouldn't happen — `DEFAULT_CAST` seeds a Narrator):** `nextCastColor([])` → `CAST_COLORS[0]`; `upsertCastMember` appends fine.
10. **Stories `<select>` shows the new member before `profiles` refreshes:** the cast member exists with `name` (from `r.name`) and `profileId`; the cast-row `<select>` (`StoriesEditor.jsx:550-558`) lists *profiles*, so until the WS refresh the `<option>` for `r.profile_id` may be absent and the per-character voice picker shows unmatched. Self-heals on the `"profiles"` WS event (`useAppData.js:114`). The cast member's own name label renders correctly immediately.

### Audiobook destination
11. **Overwriting an existing default:** `setAudiobookDefaultVoice` is last-write-wins. A second pick replaces the first silently — intended. No confirm dialog. **(Test §1.)**
12. **Default id not yet in the `profiles` prop:** the `<select value={defaultVoice}>` (`AudiobookTab.jsx:220-223`) has no matching `<option>` until the WS refresh re-renders `App.jsx` and re-passes `profiles`. Controlled-select with an unmatched value renders blank; the *stored* value is correct and is sent to the backend as `default_voice` on preview/create. Self-heals on refresh. Do not scrub. **(Test §6 unmatched-id render case.)**
13. **Default id points at a profile the user later deletes:** the stored id becomes a dangling reference; `<select>` shows blank, backend resolves `default_voice` as "not found" and falls back (existing behavior). No client crash. Out of scope to auto-clean.
14. **`audiobookDefaultVoice === ''` (engine default):** the `|| null` coercion at `:72/:103/:132` sends `null`, exactly today's behavior. The new field defaults to `''` so a fresh / migrated user is unchanged. **(Test §1 reset-to-`''` case.)**
15. **AudiobookTab not mounted when default is set from Gallery:** `setMode('audiobook')` mounts it (`App.jsx:1077`); on mount it reads `audiobookDefaultVoice` from the store and the `<select>` reflects it. If the user navigates elsewhere instead, the value still persists for next time. **(Test §6 seeded-store render.)**

### Community zone specifics
16. **Offline / empty community manifest:** `CommunityZone` renders the empty state (`:483-486`) when `items.length === 0`; no cards → no new actions to invoke. **(Local-first: an offline community manifest degrades to an empty state — archetype cards and both new actions keep working with no network.)**
17. **Recorded voice (`type: 'voice'`, no `instruct`):** materializes via `addCommunityItem` like a preset (handles both types, `community.ts:8-23,:68-71`). "Use in Stories" / "Set as default" work identically; only the Designer action (`onDesign`, `:510-512`) gates on `instruct`. The two new actions must **not** gate on `instruct`. **(Test §5 community variant.)**
18. **Community item with blank `name`:** use `r.name` from the response (§5), never `item.name`. **(Test §5 `r.name`-over-`item.name` case.)**

### Store / persistence
19. **v4 → v5 migration:** v4 state lacks `audiobookDefaultVoice`; pass-through migrate + slice default `''` covers it (no data loss for unrelated keys). The migrate (`index.ts:120-130`) is a pass-through for all versions; bumping to 5 is behavior-preserving. **(Manual rehydrate, Acceptance §11; field default pinned indirectly by Test §1.)**
20. **localStorage unavailable / quota exceeded:** zustand `persist` with `createJSONStorage(() => localStorage)` (`index.ts:70`) governs this for the whole store; the new key adds negligible bytes and inherits the existing failure behavior.
21. **Concurrent tabs (two app windows):** persisted store is per-tab in memory; last writer to localStorage wins on next hydrate. Pre-existing behavior.

### Type / navigation
22. **`setMode('audiobook')` without the union member:** TS error until `'audiobook'` is added to `AppMode` (`uiSlice.ts:16-30`, section H). **(CI: `typecheck:ci`, `ci.yml:103`.)**
23. **`setMode('stories')`:** `'stories'` already in the union (`:26`); rendered by App.jsx's mode switch — no new route wiring.

### Menu / UI
24. **Menu trigger not a valid element:** `Menu.jsx:37-39` returns the child/null; pass a real `<button>`.
25. **Menu item `onSelect` after unmount:** see edge 5 — handlers write to the store, safe; toast best-effort.
26. **`list` viewMode footer crowding:** the split-button + single chevron `Menu` keeps the footer to ≤4 controls in both `grid` and `list` (`.arch-foot`, `:436-447`).
27. **`busyRef` (a ref) doesn't re-render the card:** binding `disabled` to `busyRef.current` won't visually flip mid-flight; mirror into `useState` if a visible disabled affordance is required (§Design 4 note). Correctness still rests on the handler-level ref guard.

### Localization / platform
28. **Non-English active locale:** the new `t('gallery.…')` keys exist only in `en.json`; locales without a translation fall back to the English `defaultValue` (i18next default). No crash, no missing-string blank. **(Test §8; the test-suite i18n is initialized with `fallbackLng:'en'` in `src/test/setup.js`.)**
29. **Windows vs. macOS vs. Linux:** pure React/zustand + same-origin fetch + `setMode`; no OS-API/shell/path code, so the user-visible behavior is byte-identical across platforms (no platform branch).

## Constraints

This feature ships in **default mode** (out-of-the-box, no opt-in toggle), so it falls under the strict cross-platform-parity rule. Each relevant OmniVoice hard rule and how it's satisfied:

- **Cross-platform parity (strict rule, 2026-05-20).** The entire surface is frontend React + zustand store writes + a same-origin `fetch` to the local backend + `setMode` navigation. There is **no OS-API, no shell, no filesystem-path, no native-dep code** anywhere in the touched files (`uiSlice.ts`, `storiesSlice.ts`, `store/index.ts`, `AudiobookTab.jsx`, `VoiceGallery.jsx`, optionally `App.jsx`). The user-visible default behavior — both quick-actions, the persisted Audiobook default, the cast append, the navigation — is byte-identical on macOS (Apple Silicon + Intel), Windows (x64), and Linux (AppImage + deb). No platform branch is introduced; no opt-in gating is needed (edge 29). This is **not** a platform-only feature, so it correctly stays default-on. **(CI: the `tauri-cross-platform` matrix in `ci.yml` `cargo check`s all three OS targets; this pure-frontend task touches no Rust, so that gate is a no-op regression net here.)**
- **Local-first guarantee preserved.** No cloud calls, accounts, API keys, or third-party telemetry are added. The materialize endpoints (`POST /archetypes/{id}/use` at `archetypes.py:260`, `POST /community/items/{id}/use` at `community.py:217`) are the **existing same-origin local backend** routes — reused verbatim, no new network surface. The only new persistence is browser localStorage via the existing zustand `persist` middleware (`index.ts:68-70`), which never leaves the machine. With the community manifest offline, archetype cards and both new actions keep working (edge 16). Nothing touches the opt-in bug-reporting path. **(Test note: the handler tests `vi.mock` the API wrappers, so they prove the handlers issue exactly the existing same-origin calls and never reach for a new endpoint.)**
- **Backward-compatible project data.** Two distinct data surfaces, both handled:
  - *Client store (localStorage):* one new persisted key `audiobookDefaultVoice` → bump the zustand `persist` `version` from `4` (`index.ts:115`) to `5`. The pass-through `migrate` (`index.ts:120-130`) + the slice default `''` mean a v4-persisted state rehydrates without losing any unrelated pref and picks up `''` (engine default) for the new key (edge 19). This is the localStorage analogue of a tested alembic upgrade path — **no alembic / DB schema change is involved** because this feature touches no `omnivoice_data/` DB tables.
  - *Saved Story projects:* `audiobookDefaultVoice` is a **global pref, NOT part of `StoryProject`** (`storiesSlice.ts:28-34`) — excluded from `saveProject`/`loadProject`/`newProject` (`:84-106`, explicit-key `set(...)`), so existing persisted `storyProjects` snapshots are unchanged in shape and loading an old project is a no-op for the new field (§Design 2, edge 9). **(Test §3 pins this isolation as a pure-slice test.)**
- **CodeQL `py/polynomial-redos` (and JS `js/redos`).** This task introduces **no regex over user-controlled input**. The handlers don't parse text; the `c_*` cast id is `Math.random().toString(36)` (no regex); `r.name` flows straight into a `CastMember.name` / `<option>` without pattern matching. No ReDoS-reachable path for CodeQL to gate on. (Per the codeql-redos memory note, a later name-validation revision must avoid overlapping `\s*`/`.+` quantifiers and exclude both delimiters in `[^x]*`; flagged proactively, not needed now.)
- **Localization (hard rule).** Every new user-facing string goes through `t('gallery.…', { defaultValue: '…' })` — the menu item labels (`gallery.use_in_stories`, `gallery.set_audiobook_default`, `gallery.more_actions`), the success toasts (`gallery.added_to_stories`, `gallery.set_as_default`, optional `gallery.already_in_cast`), and the failure toast (`gallery.use_failed`, reused). `const { t } = useTranslation()` is in scope at `VoiceGallery.jsx:57`. New keys go in `en.json`'s `gallery` block (`:892-`, sibling to `use_voice` at `:916`); other locales fall back to the English `defaultValue` (edge 28). The only CJK that can appear is *runtime* community/profile names (`r.name`), which are user/community content, not source literals — the CJK lint (`tests/test_no_hardcoded_cjk.py`, allowlist prefix `frontend/src/i18n/` at `:40`) scans source, not runtime values, so no new allowlist entry is required (§5). **(CI: the CJK lint runs under `uv run pytest tests/`, `ci.yml:67`. Test plan §8 asserts the keys exist; Test §5 proves a CJK `r.name` renders unmangled — the runtime path the lint does not cover.)**
- **Versioning (hard rule, continuous-to-main patch).** No app-version change: `frontend/src-tauri/tauri.conf.json`, `frontend/src-tauri/Cargo.toml`, `pyproject.toml` untouched (main already rides latest-release+1-patch). The only integer that changes is the zustand `persist` `version` (`4` → `5`), an internal client-store-schema number **unrelated** to the app's semver. No RC, no codename, no minor/major bump.
- **Docs-sync (hard rule).** Gallery quick-actions are user-facing but not described in README.md / CONTRIBUTING.md / SECURITY.md / SUPPORT.md / `docs/**` install or feature flows — verify with a grep for "gallery"/"Use voice"/"Audiobook default" across `docs/**` and root markdown; if any feature/screenshot list is found, update it **in the same PR**. Most likely no doc change is required. **(CI: `docs-drift.yml` exists; a markdown change in the same PR satisfies it.)**
- **GSD workflow enforcement.** All edits land through a GSD command (`/gsd-quick` for the store-foundation slice, `/gsd-execute-phase` if part of a planned phase) so planning artifacts stay in sync; no direct out-of-workflow repo edits.

## Test plan

**Runner & strategy.** Vitest (frontend), `bunx vitest run` (the exact CI command, `ci.yml:106`; also `bun run test`). Config verified at `frontend/vite.config.js` `test` block: `globals: true`, `environment: 'jsdom'`, `setupFiles: ['./src/test/setup.js']`, `include: ['src/**/*.test.{js,jsx,ts,tsx}']`, `css: false`. New test files only need to live anywhere under `src/**` ending in `.test.{js,jsx,ts,tsx}` to be collected — **no config change.**

**Pure / handler-direct strategy (the load-bearing part of this lens — avoids importing main + torch/GPU locally):**

1. **Slice tests are 100% pure — zero React, zero backend, zero torch.** They import only the slice factory and call it with a plain closure, exactly like the two existing slice tests:
   - `storiesSlice.test.ts:4-10` builds `state = createStoriesSlice(set, get, {})` with `const set = (fn) => { state = {...state, ...(typeof fn==='function'?fn(state):fn)} }; const get = () => state;`.
   - `updaterSlice.test.ts:5-9` does the same for a different slice — proving the pattern is generic.
   - The **new** `uiSlice.test.ts` calls `createUiSlice(set, get, {})` (the `StateCreator` export at `uiSlice.ts:80`) with the identical harness. **This never touches `store/index.ts`, never instantiates the full zustand store, never imports a React hook, and never imports any backend/torch module.** This is the local-runnable core that satisfies the "don't import main + torch/GPU locally" rule — the local pytest segfault (torch/Triton) memory note does not apply to the frontend suite at all, and these slice tests have no Python/torch surface whatsoever.

2. **Handler tests mock the network at the API-wrapper boundary, not the transport.** The VoiceGallery handlers call `useArchetypeAsProfile` / `addCommunityItem` (`api/archetypes.ts`, `api/community.ts`). Tests `vi.mock('../api/archetypes', () => ({ useArchetypeAsProfile: vi.fn() }))` and `vi.mock('../api/community', ...)` and drive `mockResolvedValue` / `mockRejectedValue`. This means **no `fetch`, no backend process, no model load** — the same `vi.fn()` discipline already used in `components/NetworkToggle.test.jsx:12,19`. The store the handlers write to is the **real** zustand store (or the real slice in the DI variant) — so assertions read actual post-write state, not mock spies on the store.

3. **Component tests use `@testing-library/react`** (`render`, `renderHook` — in devDeps, used by 14 existing tests; `store/store.test.js` is the canonical `renderHook(() => useAppStore(...))` example). `src/test/setup.js` boots the real i18n (`fallbackLng:'en'`) and an in-memory `localStorage` mock, so rendered strings are real English and persistence is honest without disk.

**What we do NOT test (and why):** the `"profiles"` WS event → `loadProfiles()` refresh (§B) is an integration seam owned by `useAppData`; the handler tests deliberately assert only the *synchronous* writes from the resolved materialize promise (this is why Option B has no flaky refresh dependency, §Design 3). The zustand `persist` `partialize`/`migrate` plumbing (`index.ts`) is not unit-tested today — migration is verified by the slice-default test (§1) plus the manual v4→v5 rehydrate (Acceptance §11). The backend `/use` routes are out of scope (no backend change); their contract is pinned in §A and exercised by existing `backend/tests` under the isolated pytest session (`ci.yml:81`).

### Test cases — assertions, file, names

**`storiesSlice.test.ts`** (extend the existing file; pure-slice harness):

1. **Audiobook default field** — *`it('audiobookDefaultVoice starts empty, sets, overwrites, and resets')`*: starts `''`; `setAudiobookDefaultVoice('a3f9c1d2')` → `'a3f9c1d2'`; `setAudiobookDefaultVoice('b1c2d3e4')` overwrites (last-write-wins, edge 11); `setAudiobookDefaultVoice('')` resets to engine default (edge 14). (This indirectly pins the slice default `''` that the v4→v5 migration relies on, §G/edge 19.)
2. **Gallery-shaped cast member round-trips** — *`it('upsertCastMember accepts a gallery c_* member and keeps duplicates by distinct id')`*: extend the `:30-37` test or add a sibling. Assert a `{ id: 'c_ab12cd', name: 'X', color: '#…', profileId: 'a3f9c1d2' }` member lands; then a **second** append with a **different** `c_*` id but the **same** `profileId` produces **two** members (proving the dup-bloat behavior, edge 7) — so the chosen mitigation (or its absence, section J) is pinned by a test. If the `profileId`-dedup is implemented in the handler (not the slice), this slice test documents that `upsertCastMember` itself does NOT dedup by `profileId` (only by `id`).
3. **Project isolation** — *`it('load/new/save Project does not clobber audiobookDefaultVoice')`*: seed `setAudiobookDefaultVoice('a3f9c1d2')`, then `saveProject('A')` / `loadProject(id)` / `newProject()` and assert `get().audiobookDefaultVoice === 'a3f9c1d2'` after each (§Design 2, §Constraints backward-compat, edge 9). Also assert the saved `storyProjects[0]` object has **no** `audiobookDefaultVoice` key (it's not part of `StoryProject`).

**`uiSlice.test.ts`** (new file; pure-slice harness mirroring `storiesSlice.test.ts:4-10`, calling `createUiSlice`):

4. **pendingProfileTarget + combined setter** — *`it('setPendingProfileId sets id and target, defaults studio, and normalizes target to studio on null clear')`*:
   - default state: `pendingProfileId === null`, `pendingProfileTarget === 'studio'`.
   - `setPendingProfileId('a3f9c1d2', 'stories')` → both `pendingProfileId === 'a3f9c1d2'` and `pendingProfileTarget === 'stories'`.
   - `setPendingProfileId('a3f9c1d2')` (single-arg) → `pendingProfileTarget === 'studio'` (default applied; backward-compat for `:204`).
   - `setPendingProfileId('a3f9c1d2', 'audiobook')` then `setPendingProfileId(null)` → `pendingProfileId === null` **and** `pendingProfileTarget === 'studio'` (the null-normalization, §Design 1 / §E — a stale non-studio target must not leak).

**`VoiceGallery.test.jsx`** (new file — no VoiceGallery test exists today). `vi.mock('../api/archetypes')` + `vi.mock('../api/community')` resolving `{ profile_id: 'a3f9c1d2', name: 'X' }`. Drive the handlers via the rendered Menu items (`@testing-library/react` `render` + `screen.getByRole/getByText`, fire the menu item) **or**, if §J's pure-function extraction is taken, run these as plain unit tests against `utils/galleryHandoff.js` with `vi.fn()` collaborators (no DOM). Either way, assert against the real store via `useAppStore.getState()`:

5. **Handler behavior** —
   - *`it('Use in Stories appends a cast member with r.profile_id + r.name and navigates to stories')`*: after invoke, exactly one new `CastMember` exists with `profileId === 'a3f9c1d2'` and `name === 'X'`; `useAppStore.getState().mode === 'stories'`.
   - *`it('Set as Audiobook default sets the store field and navigates to audiobook')`*: `useAppStore.getState().audiobookDefaultVoice === 'a3f9c1d2'`; `mode === 'audiobook'`.
   - *`it('failed materialize flashes use_failed, does not navigate, does not mutate cast/default')`*: mock the materialize fn to `mockRejectedValue(new Error())` → assert the `gallery.use_failed` notice text renders (real i18n English), `mode` is **unchanged** (still `'gallery'`/initial), cast length unchanged, `audiobookDefaultVoice` unchanged (edge 1).
   - *`it('in-flight guard fires exactly one materialize call on double-invoke')`*: resolve the mock via a manually-deferred promise; invoke the handler twice before resolving → `useArchetypeAsProfile` called **once**, exactly **one** cast member appended (edge 3, edge 2).
   - *`it('uses backend r.name not the input item.name, and passes CJK through unmangled')`*: mock returns `{ profile_id: 'a3f9c1d2', name: '语音助手' }` while the input card name is `'English Label'` → the appended `CastMember.name === '语音助手'` (proves §5 / edge 18 and the localization-of-runtime-data constraint; this CJK is runtime data, not a source literal, so it does not touch the CJK lint).
   - *`it('community Use in Stories materializes via addCommunityItem for a type:voice item without instruct')`*: the community variant calls `addCommunityItem` (not `useArchetypeAsProfile`), works for `type:'voice'`, and does **not** gate on `instruct` (edge 17).

**`AudiobookTab.test.jsx`** (new file; component render with `@testing-library/react`, real store seeded):

6. **Store-bound default voice** —
   - *`it('renders the seeded audiobookDefaultVoice in the default-voice select')`*: seed `useAppStore.setState({ audiobookDefaultVoice: 'a3f9c1d2' })`, render `<AudiobookTab profiles={[{ id:'a3f9c1d2', name:'Narrator', kind:'cloned' }]} />`; assert the `<select>` (`:220-221`) value is `'a3f9c1d2'`; change it and assert the store updates.
   - *`it('renders without crash when the default id is absent from profiles and does not scrub it')`*: seed `audiobookDefaultVoice: 'zz99zz99'` with a `profiles` prop that does NOT contain it → component renders (no throw), and `useAppStore.getState().audiobookDefaultVoice` is **still** `'zz99zz99'` (no auto-reset, edge 12).

**Regression / cross-cutting:**

7. *`it('Use voice still routes to studio with audio define-method')`* (in `VoiceGallery.test.jsx`): existing archetype `onUse` is unchanged — calls `setPendingProfileId(r.profile_id)` resolving to `pendingProfileTarget === 'studio'`, `setMode('studio')`, `setDefineMethod('audio')` (no change to `VoiceGallery.jsx:199-210`). Also covered structurally by `uiSlice.test.ts` §4 (single-arg setter → `'studio'`).

8. **i18n / lint** —
   - *`it('en.json gallery block defines the new keys')`* (a tiny test importing `en.json`, or asserting `i18next.exists('gallery.use_in_stories')` after `import '../i18n'`): assert `gallery.use_in_stories`, `gallery.set_audiobook_default`, `gallery.more_actions`, `gallery.added_to_stories`, `gallery.set_as_default`, and `gallery.use_failed` (existing) resolve to non-empty strings; assert `gallery.already_in_cast` only if the dedup mitigation (edge 7) is taken.
   - **CI-side lint gate (not a vitest test):** `uv run pytest tests/` (`ci.yml:67`) runs `tests/test_no_hardcoded_cjk.py`, which fails on any literal CJK in scanned source outside the `frontend/src/i18n/` allowlist. The handlers and Menu labels use `t(...)` with `defaultValue` (no bare literals), and the only CJK is runtime `r.name` (not a source literal), so this gate passes with **no** new allowlist entry. Run `uv run pytest tests/test_no_hardcoded_cjk.py -q` locally before pushing if any new string was added.

### CI gates that apply (verified against `.github/workflows/ci.yml`)

The PR-gated `test` job runs, in this order — **all must be green before merge** (per the merge-discipline memory note: never merge before checks are green):

| Step (ci.yml) | Command | What it catches for this task |
|---|---|---|
| `:67` | `uv run pytest tests/ -q` | **`tests/test_no_hardcoded_cjk.py`** — a bare non-English literal in a new Menu label/toast fails here. (No backend code changed, but the lint lives in this suite.) |
| `:81` | `uv run pytest backend/tests/ -q` (isolated) | Backend `/use` route contract regressions (none expected — no backend edit). |
| `:103` | `bun run typecheck:ci` (`tsc --noEmit --checkJs false`) | **The `AppMode` `'audiobook'` addition (§H)** — `setMode('audiobook')` / `setPendingProfileId(id,'audiobook')` in `.ts` fail typecheck without it. Also the new `PendingProfileTarget` type + setter signature. `.jsx` files are NOT type-gated, so the union edit is the type safety net. |
| `:106` | `bunx vitest run` | **All new/extended tests above** (slices, handlers, AudiobookTab, i18n). The local loop must run this (`bunx vitest run`) before pushing. |
| `:108` | legacy node:test (`tests/frontend/*.test.mjs`) | Unaffected (no new `.test.mjs`); kept green. |
| `tauri-cross-platform` (`needs: test`) | `cargo check` ×3 OS | No Rust change → no-op regression net (cross-platform parity gate). |

A markdown change in the same PR (if Docs-sync §Constraints finds a feature list to update) is checked by `docs-drift.yml`. No `evals.yml` / `security.yml` (CodeQL) surface is added (no user-input regex, §Constraints).

**Local loop (before push):** `bunx vitest run` (frontend) **and** `uv run pytest tests/test_no_hardcoded_cjk.py -q` (the one Python gate that this frontend change can trip). The frontend slice/handler tests are pure JS/TS in jsdom — they do **not** import any Python/torch module, so the local-pytest-segfault (torch/Triton) memory caveat is irrelevant here; the full `bunx vitest run` is safe to run locally and is the authoritative local signal.

## Dependencies

- No new npm/python deps. Reuses `lucide-react` icons (`BookOpen` imported in `StoriesEditor.jsx:13`; `BookMarked` in `AudiobookTab.jsx:3`; `VoiceGallery.jsx` imports `BookOpen`/`BookMarked`/`ChevronDown` fresh from its `:9-12` block), the existing `Menu`/`Button` UI primitives (`frontend/src/ui/Menu.jsx`, item-array API), the `useArchetypeAsProfile`/`addCommunityItem` API fns (typed `Promise<{ profile_id: string; name: string }>`), and `nextCastColor` from `utils/storyCast.js`. **[grounded]** There is **no** `genCastId` in `utils/storyCast.js` — it's module-local to `StoriesEditor.jsx:95-97`; inline `makeCastId` in the Gallery handlers (section J). Test deps are all already present: `vitest ^4.1.5`, `@testing-library/react ^16.3.2`, `@testing-library/jest-dom ^6.9.1`, `jsdom`. **(Zero new deps keeps cross-platform parity trivial and preserves local-first.)**
- Soft dependency / sequencing: task #22 (shared `<VoiceSelector>`) and #25 (inline create-voice) touch the same cast/default-voice surfaces. This task should land first or coordinate — its store additions (`audiobookDefaultVoice`) are exactly what #25's "Audiobook narrator" inline-create would also write to, so define the field here and let #25 reuse it.

## Risk

- **Low–medium.** Main risk is the store `version` bump dropping unrelated persisted prefs if `migrate` is mishandled — mitigated by the existing pass-through migrate (`index.ts:120-130`; every field has a slice default; "Upgrade > crash"). Unit test (Test §1, slice default) + manual v4→v5 rehydrate (acceptance 11) pin this.
- **Audiobook default behavior change:** moving `defaultVoice` from local `useState` (`AudiobookTab.jsx:22`) to persisted store means it now *sticks across sessions*. Intended UX but a subtle behavior change — call it out in the PR. If undesired, scope to session only by omitting from `partialize` (which would also obviate the `version` bump).
- **Cast bloat:** repeatedly clicking "Use in Stories" appends duplicate cast members (fresh random `c_*` id each, so `upsertCastMember`'s id-dedup at `:75` won't collapse them). Acceptable (mirrors `addCharacter`); recommended mitigation is the `profileId`-dedup in the Gallery handler (section J) — pinned by Test §2 either way.
- **Double-materialize on fast clicks:** without the in-flight guard, a double-tap fires two `POST .../use` calls (two profiles, two cast members). Mitigated by the `busyRef` guard (section J); tested in Test §5 (in-flight guard).
- **Stale / unmatched profile id in dropdowns during the WS refresh window:** the cast `<select>` and Audiobook `<select>` may briefly show no matching option for a freshly-handed-off id; self-heals on the `"profiles"` WS event (`useAppData.js:114`, payload `{action:'created', id}`). No scrub logic; pinned by Test §6 (unmatched-id render).
- **Toast not visible after navigation:** `flash`/`notice` are `VoiceGallery`-local (`:78-85`); after `setMode` swaps the view the toast host unmounts, so the success toast is best-effort only. The destination view's own visible state is the real confirmation (edge 5). (Test §5 asserts the *write*, not the toast persistence — robust to this.)
- **`busyRef` doesn't drive a re-render:** the disabled affordance won't flip mid-flight unless mirrored into `useState` (§Design 4 note); correctness still rests on the ref guard.
- **Type drift:** `AppMode` (`uiSlice.ts:16-30`) is missing `'audiobook'` even though `App.jsx:170/:1077` already use it. Adding `'audiobook'` is required for `setMode('audiobook')` to type-check — enforced by `typecheck:ci` (`ci.yml:103`).
- **Naming collision:** community recorded voices and archetypes can produce identically-named cast members — harmless (cast ids are random), only the display label collides.
- **Localization regression:** forgetting `t()` on a new Menu label or toast fails the hardcoded-string/CJK lint — caught in CI (`uv run pytest tests/`, `ci.yml:67`), pinned by Test §8.

## PR slices

(All slices land continuous-to-main per the beta cadence — no RC, no soak. No app-version bump in any slice.)

1. **PR 1 — store foundation:** add `audiobookDefaultVoice` to `storiesSlice` + `partialize` + version bump to 5; add `pendingProfileTarget` (transient) + `PendingProfileTarget` type + the combined `setPendingProfileId(id, target?)` signature (with null-normalization) to `uiSlice`; extend `AppMode` with `'audiobook'`. Unit tests for both slices (new `uiSlice.test.ts` §4, extended `storiesSlice.test.ts` §§1-3) including project-isolation and null-clear. No UI change yet (AudiobookTab still uses local state, fully backward compatible). Small, isolated, green CI. **Gates exercised: `typecheck:ci` (AppMode), `bunx vitest run` (slice tests), `pytest tests/` (CJK — vacuous, no new strings yet).**
2. **PR 2 — AudiobookTab binds to store:** swap `AudiobookTab.jsx:22` local `defaultVoice` for the store field (add the `useAppStore` import). Render test (`AudiobookTab.test.jsx` §6) incl. the unmatched-id case. (Can merge with PR 1 if reviewer prefers.)
3. **PR 3 — Gallery quick-actions:** add `onUseInStories` / `onUseAsAudiobookDefault` to archetype (`VoiceGallery.jsx:199-217`/`:283-289`) + community (`:490-513`) zones with the in-flight guard + `r.name` usage + optional dedup, render the split-button/`Menu` in `ArchetypeCard` (`:436-447`), thread through `cardProps`, add i18n keys (all via `t(...)` with `defaultValue`). Handler/component tests `VoiceGallery.test.jsx` (§§5,7) + i18n test (§8). **This PR is the one where the CJK lint (`pytest tests/`) is load-bearing** — verify locally with `uv run pytest tests/test_no_hardcoded_cjk.py -q`.

(If the team wants one PR, merge 1+2+3 — slicing is for review ergonomics, not hard coupling.)

## Acceptance criteria

1. On any archetype gallery card, a "Use in Stories" action materializes the voice (creates a profile via `POST /archetypes/{id}/use`, which returns `{ profile_id, name }`) AND the app navigates to Stories (`mode: 'stories'`) with a new cast member whose `profileId === r.profile_id` and whose `name === r.name` (the **endpoint-returned** name); the new profile appears in the cast/line voice dropdowns (`StoriesEditor.jsx:550-558`) once profiles refresh via the `"profiles"` WS event (`useAppData.js:114`). *(Pinned by Test §5 success path.)*
2. On any archetype gallery card, a "Set as Audiobook default" action materializes the voice AND navigates to Audiobook (`mode: 'audiobook'`, rendered at `App.jsx:1077-1080`) with the default-voice `<select>` (`AudiobookTab.jsx:220-224`) pre-set to `r.profile_id`; the selection persists across an app reload (it's in `partialize`). *(Pinned by Test §5 + §6; reload by Acceptance 11 manual.)*
3. The same two actions are available on Community cards (`VoiceGallery.jsx:490-513`) and work for both `preset` and `voice` community items (via `POST /community/items/{id}/use`, same `{ profile_id, name }` response); neither action gates on `instruct`. *(Pinned by Test §5 community variant.)*
4. The existing "Use voice" action is unchanged: it still creates the profile and lands in Studio with `defineMethod: 'audio'` (`VoiceGallery.jsx:199-210`); single-arg `setPendingProfileId(id)` still resolves to `pendingProfileTarget: 'studio'`. *(Pinned by Test §7 + §4.)*
5. Audiobook default voice is read from / written to the store (no longer local `useState`); preview (`:72`), preview-chapter (`:103`), and create (`:132`) all consume it as `default_voice`; selecting it overwrites any prior default; `''` sends `null` (engine default) exactly as today. *(Pinned by Test §1 + §6.)*
6. **Failure path:** when the materialize call rejects (engine loading / network), the action flashes the localized failure toast (`gallery.use_failed`), does NOT navigate, and does NOT mutate cast or default — the user remains in the Gallery and can retry; the card returns to idle. *(Pinned by Test §5 failure path.)*
7. **In-flight guard:** rapidly clicking a new action twice on the same card produces exactly one materialize call and exactly one cast member / one default write. *(Pinned by Test §5 in-flight guard.)*
8. **Stale-id tolerance:** setting a default (or appending a cast member) for a `profile_id` not yet present in the loaded `profiles` list does not crash and is not auto-cleared; the dropdown self-heals once the `"profiles"` WS event lands. *(Pinned by Test §6 unmatched-id render.)*
9. **Project isolation:** loading, creating, or saving a Story project does not change `audiobookDefaultVoice`. *(Pinned by Test §3.)*
10. **Localization:** all new strings are localized (`t(...)` with `defaultValue`, keys in `en.json` under `gallery.*`); no hardcoded-string / CJK lint failures (`tests/test_no_hardcoded_cjk.py` passes under `ci.yml:67`); a non-English active locale falls back to the English `defaultValue` without a blank string; runtime non-English (incl. CJK) community/profile names (`r.name`) render unmangled. *(Pinned by Test §8 + §5 CJK case.)*
11. **Backward-compatible client data:** `bunx vitest run` passes including new slice + handler tests (success, failure, guard, dedup, project-isolation, null-clear); the store `version` bump (4 → 5) migrates a v4 persisted state without clearing unrelated prefs and picks up `audiobookDefaultVoice: ''` (manual rehydrate verification). No `omnivoice_data/` DB / alembic change is involved.
12. **Cross-platform parity:** behavior is identical across macOS/Windows/Linux — verified by the absence of any platform branch, OS-API, shell, or filesystem-path code in the touched files; the feature stays default-on (no opt-in toggle) because nothing diverges per platform.
13. **Local-first:** no new network surface, accounts, API keys, or telemetry; the only persistence change is browser localStorage via the existing zustand `persist` middleware; the feature remains functional (archetype actions) with the community manifest offline.
14. **Versioning:** no `tauri.conf.json` / `Cargo.toml` / `pyproject.toml` app-version change; only the zustand `persist` `version` integer changes; lands continuous-to-main with no RC.
15. **CI green:** the full `ci.yml` `test` job passes — `uv run pytest tests/` (incl. CJK lint), `uv run pytest backend/tests/`, `bun run typecheck:ci` (incl. the new `'audiobook'` `AppMode` member), `bunx vitest run` (all new/extended tests), legacy node:test — plus the `tauri-cross-platform` `cargo check` matrix (no-op for this frontend task). No check is skipped or merged red.
