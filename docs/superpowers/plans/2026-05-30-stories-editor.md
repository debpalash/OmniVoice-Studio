# Stories Editor — Make It Actually Work (Full Polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Stories Editor from a reachable-but-non-functional demo into a working multi-track audiobook tool: live per-line preview, a real "Generate All" audiobook export, persisted projects, per-character voice casting, drag-to-reorder, and i18n'd strings.

**Architecture:** The editor stays a single React component (`StoriesEditor.jsx`) but (1) preview/export route through the existing **job-less `/generate`** endpoint via the PIN-/same-origin-safe `apiFetch` client (never the broken `/api/dub/preview-segment/__stories__` path); (2) export stitches per-chunk WAVs client-side with the Web Audio API into one downloadable file (no backend change, consistent with preview, YAGNI for v0.3.0); (3) tracks + cast persist via the existing zustand `persist`→`localStorage` + `partialize` pattern (**no DB/alembic change**); (4) reorder uses **native HTML5 drag events** (no new dependency); (5) all UI strings move into the i18n layer.

**Tech Stack:** React + zustand (`persist`/`partialize`), the existing `frontend/src/api/generate.ts` (`generateSpeech(formData)`), the existing `frontend/src/utils/storyTokens.js` tokenizer, Web Audio API (`AudioContext`, `decodeAudioData`), i18next (`useTranslation`/`t`), Vitest + node:test.

**Key design decisions (review these before executing):**
- **Preview & export use `/generate`, not `/dub/preview-segment/{job_id}`.** The dub endpoint requires a real dub job (`_get_job(job_id)` → 404 for `"__stories__"`), and the current call also uses a relative `/api/...` URL with no `API` base or PIN header. `/generate` is the standalone TTS path and already flows through `apiFetch`.
- **Export is client-side (Web Audio).** Fine for typical stories; if multi-hour books become a real workload later, a backend concat endpoint can be added behind the same `exportStoryAudio()` interface without UI changes.
- **Persistence is `localStorage` via the existing store**, not `omnivoice_data/` DB — no migration, satisfies the backward-compatible-project-data constraint trivially.
- **"Generate All" becomes self-contained** (calls the internal exporter) — the dead, never-passed `onGenerate` prop is removed.

---

## File Structure

**Create:**
- `frontend/src/utils/storyExport.js` — pure audio helpers: `silenceBuffer`, `concatBuffers`, `encodeWav`, and the orchestrator `exportStoryAudio`.
- `frontend/src/utils/storyExport.test.js` — Vitest for the pure helpers (WAV header, silence length, concat ordering).
- `frontend/src/store/storiesSlice.ts` — zustand slice: `storyTracks`, `setStoryTracks`, `characterVoices`, `setCharacterVoice`.
- `frontend/src/store/storiesSlice.test.ts` — slice reducers (set tracks, set cast voice).
- `frontend/src/utils/storyReorder.js` — pure `reorder(list, fromId, toId)` helper.
- `frontend/src/utils/storyReorder.test.js` — reorder edge cases.

**Modify:**
- `frontend/src/components/StoriesEditor.jsx` — preview via `/generate`; self-contained "Generate All"; store-backed tracks + cast; Cast panel; native DnD; `t()` strings.
- `frontend/src/store/index.ts` — compose `storiesSlice`, add its persisted keys to `partialize`.
- `frontend/src/store/storiesSlice.ts` re-exported types into `AppStore` (in `index.ts`).
- `frontend/src/i18n/locales/en.json` — add the `stories.*` namespace.
- `frontend/src/i18n/locales/zh-CN.json` — add the `stories.*` namespace (translated).
- `frontend/src/components/StoriesEditor.css` — `.stories-cast` panel + `.stories-track--dragover` styles.

**Reference (read, do not change):**
- `frontend/src/api/generate.ts` — `generateSpeech(formData)` contract.
- `backend/api/routers/generation.py:93` — `/generate` accepted `Form` fields.
- `frontend/src/utils/storyTokens.js` — `parseStoryText`, `hasStoryMarkers`, `applyInlineVoice`.
- `frontend/src/store/index.ts:46-74` — the `persist`/`partialize` pattern to mirror.

---

## Task 1: Fix preview — route through the working `/generate` endpoint

**Files:**
- Modify: `frontend/src/components/StoriesEditor.jsx` (`fetchChunkAudio`, lines ~147-156; import at line ~19)

The bug: `fetch('/api/dub/preview-segment/__stories__', …)` is a relative URL (no `API` base, no PIN header) hitting a route that doesn't exist at that path and requires a real dub job. Replace the fetch body with the standalone `/generate` call.

- [ ] **Step 1: Add the import**

At the top of `StoriesEditor.jsx`, next to the existing util import:

```jsx
import { generateSpeech } from '../api/generate';
```

- [ ] **Step 2: Rewrite `fetchChunkAudio` to use `/generate`**

Replace the existing `fetchChunkAudio` (the `useCallback` that POSTs to `/api/dub/preview-segment/__stories__`) with:

```jsx
const fetchChunkBlob = useCallback(async (text, profileId) => {
  const fd = new FormData();
  fd.append('text', text);
  fd.append('speed', '1.0');
  if (profileId) fd.append('profile_id', profileId);
  const res = await generateSpeech(fd); // apiFetch under the hood: API base + PIN header
  return res.blob(); // WAV bytes
}, []);

const fetchChunkAudio = useCallback(async (text, profileId) => {
  const blob = await fetchChunkBlob(text, profileId);
  return URL.createObjectURL(blob);
}, [fetchChunkBlob]);
```

(`fetchChunkBlob` is reused by Task 2's exporter; keep both.)

- [ ] **Step 3: Verify the rest of `previewTrack` still type-checks**

`previewTrack` already consumes `fetchChunkAudio(text, profileId)` and `parseStoryText` — no further change needed. Confirm no other reference to the old endpoint remains:

Run: `rg -n "preview-segment|__stories__|/api/dub" frontend/src/components/StoriesEditor.jsx`
Expected: no matches.

- [ ] **Step 4: Frontend typecheck + build**

Run: `cd frontend && bun run typecheck:ci && bun run build`
Expected: exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/StoriesEditor.jsx
git commit -m "fix(stories): preview via job-less /generate (was 404 on /api/dub/preview-segment/__stories__)"
```

---

## Task 2: "Generate All" — real client-side audiobook export

**Files:**
- Create: `frontend/src/utils/storyExport.js`
- Test: `frontend/src/utils/storyExport.test.js`
- Modify: `frontend/src/components/StoriesEditor.jsx` (`generateAll`, header button, remove `onGenerate`)

### 2a — Pure audio helpers (TDD)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/utils/storyExport.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { silenceBuffer, concatBuffers, encodeWav } from './storyExport';

// Minimal fake AudioBuffer: { sampleRate, numberOfChannels, length, getChannelData(i) }
function fakeBuffer(samples, sampleRate = 24000) {
  const data = Float32Array.from(samples);
  return {
    sampleRate,
    numberOfChannels: 1,
    length: data.length,
    getChannelData: () => data,
  };
}

describe('silenceBuffer', () => {
  it('produces sampleRate * seconds zeroed samples (mono)', () => {
    const b = silenceBuffer(0.5, 24000);
    expect(b.length).toBe(12000);
    expect(b.numberOfChannels).toBe(1);
    expect(b.getChannelData(0).every((v) => v === 0)).toBe(true);
  });
});

describe('concatBuffers', () => {
  it('joins buffers in order into one of summed length', () => {
    const out = concatBuffers([fakeBuffer([1, 2]), fakeBuffer([3, 4, 5])], 24000);
    expect(out.length).toBe(5);
    expect(Array.from(out.getChannelData(0))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('encodeWav', () => {
  it('writes a 44-byte RIFF/WAVE PCM16 header', () => {
    const wav = encodeWav(fakeBuffer([0, 0.5, -0.5]), 24000);
    const dv = new DataView(wav);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(36)).toBe('data');
    expect(dv.getUint16(22, true)).toBe(1);       // mono
    expect(dv.getUint32(24, true)).toBe(24000);    // sample rate
    expect(dv.getUint16(34, true)).toBe(16);       // bits/sample
    expect(wav.byteLength).toBe(44 + 3 * 2);       // header + 3 int16 samples
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd frontend && bunx vitest run src/utils/storyExport.test.js`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement `storyExport.js` helpers**

Create `frontend/src/utils/storyExport.js`:

```js
/**
 * Story audiobook export helpers.
 *
 * Renders each track (chunks + [pause] gaps) to audio via the job-less
 * `/generate` endpoint, decodes with the Web Audio API, stitches into one
 * mono buffer with timed silences, and encodes a single 16-bit PCM WAV.
 *
 * The pure helpers (silenceBuffer/concatBuffers/encodeWav) take and return
 * plain {sampleRate, numberOfChannels, length, getChannelData} shapes so they
 * are testable without a real AudioContext.
 */

/** Mono buffer of `seconds` of silence at `sampleRate`. */
export function silenceBuffer(seconds, sampleRate) {
  const length = Math.max(0, Math.round(seconds * sampleRate));
  const data = new Float32Array(length);
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/** Concatenate mono buffers (channel 0) in order. */
export function concatBuffers(buffers, sampleRate) {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(b.getChannelData(0).subarray(0, b.length), offset);
    offset += b.length;
  }
  return { sampleRate, numberOfChannels: 1, length: total, getChannelData: () => out };
}

/** Encode a mono buffer to a 16-bit PCM WAV ArrayBuffer. */
export function encodeWav(buffer, sampleRate) {
  const samples = buffer.getChannelData(0);
  const n = buffer.length;
  const ab = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(ab);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);        // PCM chunk size
  dv.setUint16(20, 1, true);         // PCM format
  dv.setUint16(22, 1, true);         // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate (mono * 2 bytes)
  dv.setUint16(32, 2, true);         // block align
  dv.setUint16(34, 16, true);        // bits per sample
  writeStr(36, 'data');
  dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return ab;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd frontend && bunx vitest run src/utils/storyExport.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the orchestrator `exportStoryAudio` (no test — it needs a real AudioContext + network; covered by manual QA)**

Append to `frontend/src/utils/storyExport.js`:

```js
import { parseStoryText } from './storyTokens';

/**
 * Render an ordered track list to one WAV blob.
 * @param tracks    [{ text, character, profileId }]
 * @param resolveProfile (track) => profileId|null   // applies cast fallback
 * @param fetchChunkBlob (text, profileId) => Promise<Blob>   // /generate WAV
 * @param onProgress (done, total) => void
 * @returns Blob (audio/wav)
 */
export async function exportStoryAudio(tracks, resolveProfile, fetchChunkBlob, onProgress) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    // Flatten every track into an ordered chunk/pause segment list.
    const segments = [];
    for (const tk of tracks) {
      const pid = resolveProfile(tk);
      for (const seg of parseStoryText(tk.text || '', pid)) segments.push(seg);
    }
    const chunkCount = segments.filter((s) => s.type === 'chunk').length;
    let done = 0;
    const buffers = [];
    for (const seg of segments) {
      if (seg.type === 'pause') {
        buffers.push(silenceBuffer(seg.seconds, ctx.sampleRate));
        continue;
      }
      const blob = await fetchChunkBlob(seg.text, seg.profileId);
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      buffers.push(decoded); // decodeAudioData resamples to ctx.sampleRate → safe to concat
      onProgress?.(++done, chunkCount);
    }
    const combined = concatBuffers(buffers, ctx.sampleRate);
    return new Blob([encodeWav(combined, ctx.sampleRate)], { type: 'audio/wav' });
  } finally {
    ctx.close?.();
  }
}
```

### 2b — Wire "Generate All" in the component

- [ ] **Step 6: Replace `generateAll` and remove the dead `onGenerate` prop**

In `StoriesEditor.jsx`, change the signature `export default function StoriesEditor({ profiles = [], onGenerate })` → `export default function StoriesEditor({ profiles = [] })`. Add export state near the other `useState`s:

```jsx
const [exporting, setExporting] = useState(false);
const [exportPct, setExportPct] = useState(0);
```

Replace the `generateAll` callback with:

```jsx
const generateAll = useCallback(async () => {
  const usable = tracks.filter((t) => (t.text || '').trim());
  if (!usable.length || exporting) return;
  setExporting(true);
  setExportPct(0);
  try {
    const blob = await exportStoryAudio(
      usable,
      (tk) => tk.profileId || characterVoices[tk.character] || null,
      fetchChunkBlob,
      (d, total) => setExportPct(total ? Math.round((d / total) * 100) : 0),
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'story.wav';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    console.warn('Story export failed:', err);
    toast.error(t('stories.exportFailed'));
  } finally {
    setExporting(false);
  }
}, [tracks, characterVoices, fetchChunkBlob, exporting, t]);
```

Add the imports at the top:

```jsx
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { exportStoryAudio } from '../utils/storyExport';
```

(`characterVoices`/`t` are introduced in Tasks 3 and 6; until then, stub `const characterVoices = {};` and use literal strings, OR implement Tasks 3 & 6 first — the recommended order is 1 → 6 → 3 → 2 → 4 → 5, but tasks are written standalone. If executing strictly in number order, temporarily inline `characterVoices = {}` and `'Export failed'`, then remove the stubs in Tasks 3/6.)

- [ ] **Step 7: Update the "Generate All" button to show progress**

Replace the Generate-All `<Button>` in the header:

```jsx
<Button size="sm" onClick={generateAll} disabled={tracks.length === 0 || exporting}>
  <Download size={13} /> {exporting ? `${exportPct}%` : t('stories.generateAll')}
</Button>
```

- [ ] **Step 8: Confirm no orphan `onGenerate` references**

Run: `rg -n "onGenerate" frontend/src/components/StoriesEditor.jsx frontend/src/App.jsx`
Expected: no matches (App.jsx already mounts `<StoriesEditor profiles={profiles} />` with no `onGenerate`).

- [ ] **Step 9: Typecheck + build + run new tests**

Run: `cd frontend && bun run typecheck:ci && bunx vitest run src/utils/storyExport.test.js && bun run build`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/utils/storyExport.js frontend/src/utils/storyExport.test.js frontend/src/components/StoriesEditor.jsx
git commit -m "feat(stories): real Generate-All audiobook export (client-side WAV stitch via /generate)"
```

---

## Task 3: Persist tracks + cast (zustand store, drop the hardcoded seed)

**Files:**
- Create: `frontend/src/store/storiesSlice.ts`, `frontend/src/store/storiesSlice.test.ts`
- Modify: `frontend/src/store/index.ts`, `frontend/src/components/StoriesEditor.jsx`

- [ ] **Step 1: Write the failing slice test**

Create `frontend/src/store/storiesSlice.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createStoriesSlice } from './storiesSlice';

function harness() {
  let state: any = {};
  const set = (fn: any) => { state = { ...state, ...(typeof fn === 'function' ? fn(state) : fn) }; };
  const get = () => state;
  state = createStoriesSlice(set as any, get as any, {} as any);
  return { get };
}

describe('storiesSlice', () => {
  it('starts with empty tracks and cast', () => {
    const { get } = harness();
    expect(get().storyTracks).toEqual([]);
    expect(get().characterVoices).toEqual({});
  });
  it('setStoryTracks replaces the list', () => {
    const { get } = harness();
    get().setStoryTracks([{ id: 1, character: 'narrator', text: 'hi', profileId: null }]);
    expect(get().storyTracks).toHaveLength(1);
  });
  it('setCharacterVoice maps a character to a profile (null clears)', () => {
    const { get } = harness();
    get().setCharacterVoice('char-0', 'p1');
    expect(get().characterVoices['char-0']).toBe('p1');
    get().setCharacterVoice('char-0', null);
    expect(get().characterVoices['char-0']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd frontend && bunx vitest run src/store/storiesSlice.test.ts`
Expected: FAIL — `createStoriesSlice` not found.

- [ ] **Step 3: Implement the slice**

Create `frontend/src/store/storiesSlice.ts`:

```ts
import type { StateCreator } from 'zustand';

export interface StoryTrack {
  id: number;
  character: string;
  text: string;
  profileId: string | null;
}

export interface StoriesSlice {
  storyTracks: StoryTrack[];
  characterVoices: Record<string, string>;
  setStoryTracks: (tracks: StoryTrack[]) => void;
  setCharacterVoice: (character: string, profileId: string | null) => void;
}

export const createStoriesSlice: StateCreator<StoriesSlice, [], [], StoriesSlice> = (set) => ({
  storyTracks: [],
  characterVoices: {},
  setStoryTracks: (storyTracks) => set({ storyTracks }),
  setCharacterVoice: (character, profileId) =>
    set((s) => {
      const next = { ...s.characterVoices };
      if (profileId) next[character] = profileId;
      else delete next[character];
      return { characterVoices: next };
    }),
});
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd frontend && bunx vitest run src/store/storiesSlice.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Compose into the root store + persist**

In `frontend/src/store/index.ts`: add the import and the type to `AppStore`, spread the slice, and add the two keys to `partialize`.

```ts
import type { StoriesSlice } from './storiesSlice';
import { createStoriesSlice } from './storiesSlice';
```
```ts
export type AppStore = PrefsSlice & GlossarySlice & UiSlice & DubSlice & GenerateSlice & PillSlice & StoriesSlice;
```
Inside the `create(...)` object add `...createStoriesSlice(set, get, api),` alongside the other slices, and inside `partialize` add — **stripping transient fields** so a dead `blob:` `audioUrl` or a stuck `generating: true` never rehydrates from localStorage:
```ts
        storyTracks:      s.storyTracks.map(({ id, character, text, profileId }) => ({ id, character, text, profileId })),
        characterVoices:  s.characterVoices,
```

- [ ] **Step 6: Move the component off local seeded state onto the store**

In `StoriesEditor.jsx`:
- Remove the `useState(() => [ makeTrack('narrator', 'Once upon a time…'), … ])` seed.
- Replace with store-backed state:

```jsx
import { useAppStore } from '../store';
```
```jsx
const tracks = useAppStore((s) => s.storyTracks);
const setStoryTracks = useAppStore((s) => s.setStoryTracks);
const characterVoices = useAppStore((s) => s.characterVoices);
const setCharacterVoice = useAppStore((s) => s.setCharacterVoice);
const setTracks = useCallback((updater) => {
  setStoryTracks(typeof updater === 'function' ? updater(useAppStore.getState().storyTracks) : updater);
}, [setStoryTracks]);
```

Every existing `setTracks(prev => …)` call keeps working unchanged because `setTracks` now proxies to the store. The empty-state UI (`tracks.length === 0`) already exists and will show on a clean first run.

**Reseed the id counter on mount** so `makeTrack()` ids don't collide with persisted ones (`_trackId` resets to 0 on reload, but persisted tracks already hold ids 1..N):

```jsx
useEffect(() => {
  const maxId = tracks.reduce((m, t) => Math.max(m, t.id || 0), 0);
  if (maxId > _trackId) _trackId = maxId;
}, []); // once on mount
```

- [ ] **Step 7: Typecheck + tests + build**

Run: `cd frontend && bun run typecheck:ci && bunx vitest run src/store/storiesSlice.test.ts && bun run build`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/store/storiesSlice.ts frontend/src/store/storiesSlice.test.ts frontend/src/store/index.ts frontend/src/components/StoriesEditor.jsx
git commit -m "feat(stories): persist tracks + cast to localStorage; drop hardcoded sample seed"
```

---

## Task 4: Per-character voice casting (assign once, inherit per line)

**Files:**
- Modify: `frontend/src/components/StoriesEditor.jsx`, `frontend/src/components/StoriesEditor.css`

Effective voice for a track = `track.profileId ?? characterVoices[track.character] ?? null`. The export (Task 2) already uses this fallback. Now expose a Cast panel and reflect inheritance in the per-track profile select.

- [ ] **Step 1: Add a Cast panel toggle + state**

Near the other panel state add `const [castOpen, setCastOpen] = useState(false);` and add a header button next to "Paste & Split":

```jsx
<Button size="sm" variant="ghost" onClick={() => setCastOpen((v) => !v)} aria-label={t('stories.cast')}>
  <Users size={13} /> {t('stories.cast')}
</Button>
```

- [ ] **Step 2: Render the Cast panel (one row per character currently used)**

Insert after the split panel block:

```jsx
{castOpen && (
  <div className="stories-cast" role="region" aria-label={t('stories.castAria')}>
    {[...new Set(tracks.map((t) => t.character))].map((charId) => {
      const c = charInfo(charId);
      return (
        <div key={charId} className="stories-cast__row">
          <span className="stories-cast__dot" style={{ background: c.color }} />
          <span className="stories-cast__name">{c.label}</span>
          <select
            className="stories-cast__select"
            value={characterVoices[charId] || ''}
            onChange={(e) => setCharacterVoice(charId, e.target.value || null)}
            aria-label={`${c.label} ${t('stories.voice')}`}
          >
            <option value="">{t('stories.defaultVoice')}</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      );
    })}
    {tracks.length === 0 && <p className="net-toggle__hint">{t('stories.castEmpty')}</p>}
  </div>
)}
```

- [ ] **Step 3: Show inheritance in the per-track profile select**

Change the per-track profile `<option value="">Default</option>` to reflect the inherited cast voice:

```jsx
<option value="">
  {characterVoices[track.character]
    ? `${t('stories.cast')}: ${(profiles.find((p) => p.id === characterVoices[track.character]) || {}).name || t('stories.defaultVoice')}`
    : t('stories.defaultVoice')}
</option>
```

- [ ] **Step 4: Add Cast styles**

Append to `StoriesEditor.css`:

```css
.stories-cast { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; margin-bottom: 10px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; }
.stories-cast__row { display: flex; align-items: center; gap: 8px; }
.stories-cast__dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.stories-cast__name { font-size: 12px; min-width: 96px; color: var(--text, #ebdbb2); }
.stories-cast__select { flex: 1; }
```

- [ ] **Step 5: Typecheck + build**

Run: `cd frontend && bun run typecheck:ci && bun run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/StoriesEditor.jsx frontend/src/components/StoriesEditor.css
git commit -m "feat(stories): per-character voice casting with per-line inheritance"
```

---

## Task 5: Drag-to-reorder tracks (native HTML5 DnD, no new dep)

**Files:**
- Create: `frontend/src/utils/storyReorder.js`, `frontend/src/utils/storyReorder.test.js`
- Modify: `frontend/src/components/StoriesEditor.jsx`, `frontend/src/components/StoriesEditor.css`

- [ ] **Step 1: Write the failing reorder test**

Create `frontend/src/utils/storyReorder.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { reorder } from './storyReorder';

const list = [{ id: 1 }, { id: 2 }, { id: 3 }];

describe('reorder', () => {
  it('moves an item to before the target id', () => {
    expect(reorder(list, 3, 1).map((x) => x.id)).toEqual([3, 1, 2]);
  });
  it('is a no-op when from === to', () => {
    expect(reorder(list, 2, 2).map((x) => x.id)).toEqual([1, 2, 3]);
  });
  it('returns the same order when an id is missing', () => {
    expect(reorder(list, 9, 1).map((x) => x.id)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd frontend && bunx vitest run src/utils/storyReorder.test.js`
Expected: FAIL — `reorder` not found.

- [ ] **Step 3: Implement `reorder`**

Create `frontend/src/utils/storyReorder.js`:

```js
/** Move the item with id `fromId` to sit immediately before `toId`. Pure. */
export function reorder(list, fromId, toId) {
  if (fromId === toId) return list.slice();
  const from = list.findIndex((x) => x.id === fromId);
  const to = list.findIndex((x) => x.id === toId);
  if (from < 0 || to < 0) return list.slice();
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  const insertAt = next.findIndex((x) => x.id === toId);
  next.splice(insertAt, 0, moved);
  return next;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd frontend && bunx vitest run src/utils/storyReorder.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire native DnD into the track rows**

In `StoriesEditor.jsx` import the helper and add a drag-target state:

```jsx
import { reorder } from '../utils/storyReorder';
```
```jsx
const dragId = useRef(null);
const [dragOver, setDragOver] = useState(null);
```

On the track `<div>` (the `role="listitem"` element), add:

```jsx
draggable
onDragStart={(e) => { dragId.current = track.id; e.dataTransfer.effectAllowed = 'move'; }}
onDragOver={(e) => { e.preventDefault(); if (dragOver !== track.id) setDragOver(track.id); }}
onDragLeave={() => setDragOver((d) => (d === track.id ? null : d))}
onDrop={(e) => {
  e.preventDefault();
  if (dragId.current != null && dragId.current !== track.id) {
    setTracks((prev) => reorder(prev, dragId.current, track.id));
  }
  dragId.current = null;
  setDragOver(null);
}}
```

Add `dragOver === track.id ? 'stories-track--dragover' : ''` to the row's className array. Keep the existing `<GripVertical>` as the visual affordance (the whole row is now draggable).

- [ ] **Step 6: Add the drag-over style**

Append to `StoriesEditor.css`:

```css
.stories-track { cursor: grab; }
.stories-track--dragover { box-shadow: inset 0 2px 0 0 var(--color-accent, #b8bb26); }
```

- [ ] **Step 7: Typecheck + tests + build**

Run: `cd frontend && bun run typecheck:ci && bunx vitest run src/utils/storyReorder.test.js && bun run build`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/utils/storyReorder.js frontend/src/utils/storyReorder.test.js frontend/src/components/StoriesEditor.jsx frontend/src/components/StoriesEditor.css
git commit -m "feat(stories): drag-to-reorder tracks (native HTML5 DnD)"
```

---

## Task 6: Move UI strings into i18n

**Files:**
- Modify: `frontend/src/i18n/locales/en.json`, `frontend/src/i18n/locales/zh-CN.json`, `frontend/src/components/StoriesEditor.jsx`

The CJK hard-rule forbids hardcoded CJK; it does not forbid English. But the NavRail already uses `tKey: 'stories'`, so the panel should be consistent. Add a `stories` namespace and replace literals.

- [ ] **Step 1: Add the `stories` namespace to `en.json`**

Add this object at the top level of `frontend/src/i18n/locales/en.json` (match the file's existing key style/placement):

```json
"stories": {
  "title": "Stories Editor",
  "subtitle": "Multi-track audiobook with per-character voice assignment",
  "pasteSplit": "Paste & Split",
  "addLine": "Add Line",
  "generateAll": "Generate All",
  "cast": "Cast",
  "castAria": "Assign a voice to each character",
  "castEmpty": "Add a line to start casting characters.",
  "voice": "voice",
  "defaultVoice": "Default",
  "exportFailed": "Audiobook export failed — check the backend is running.",
  "emptyText": "Start your story by adding dialogue and narration tracks. Assign a unique voice to each character.",
  "addFirst": "Add First Line",
  "narrator": "Narrator",
  "lines": "{{count}} lines",
  "characters": "{{count}} characters",
  "minutes": "~{{count}} min",
  "chars": "{{count}} chars"
}
```

- [ ] **Step 2: Add the translated `stories` namespace to `zh-CN.json`**

Add the same keys to `frontend/src/i18n/locales/zh-CN.json` with translations:

```json
"stories": {
  "title": "故事编辑器",
  "subtitle": "多轨有声书，可为每个角色分配语音",
  "pasteSplit": "粘贴并拆分",
  "addLine": "添加台词",
  "generateAll": "全部生成",
  "cast": "配音",
  "castAria": "为每个角色分配语音",
  "castEmpty": "添加台词以开始为角色配音。",
  "voice": "语音",
  "defaultVoice": "默认",
  "exportFailed": "有声书导出失败——请检查后端是否运行。",
  "emptyText": "添加对白和旁白轨道，开始你的故事。为每个角色分配独特的语音。",
  "addFirst": "添加第一句",
  "narrator": "旁白",
  "lines": "{{count}} 句",
  "characters": "{{count}} 个角色",
  "minutes": "约 {{count}} 分钟",
  "chars": "{{count}} 字符"
}
```

(These CJK strings live in the translation layer — the only place the hard-rule allows them.)

- [ ] **Step 3: Use `t()` in the component**

`const { t } = useTranslation();` is already imported (Task 2). Replace the literals:
- Title `Stories Editor` → `{t('stories.title')}`; subtitle → `{t('stories.subtitle')}`.
- Buttons: `Paste & Split` → `{t('stories.pasteSplit')}`, `Add Line` → `{t('stories.addLine')}`, `Add First Line` → `{t('stories.addFirst')}`.
- Empty-state text → `{t('stories.emptyText')}`.
- Footer stats → `{t('stories.lines', { count: tracks.length })}`, `{t('stories.characters', { count: uniqueChars })}`, `{t('stories.minutes', { count: estMinutes })}`, `{t('stories.chars', { count: totalChars })}` (drop the manual `toLocaleString`; i18next formats counts).
- The `CHARACTERS` array's `Narrator` label: keep the array stable but render `charId === 'narrator' ? t('stories.narrator') : c.label` where the label is shown, OR leave "Character N" as-is (English numerals are locale-neutral). Minimum: translate `Narrator`.

- [ ] **Step 4: Confirm no hardcoded-CJK test regression + i18n completeness**

Run: `cd frontend && bun run typecheck:ci && bun run build`
Run (CJK guard, from repo root): `python -m pytest tests/test_no_hardcoded_cjk.py -q`
Expected: PASS — the only CJK added is inside `i18n/locales/zh-CN.json`, which the guard allows.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/i18n/locales/en.json frontend/src/i18n/locales/zh-CN.json frontend/src/components/StoriesEditor.jsx
git commit -m "feat(stories): route Stories Editor strings through i18n (en + zh-CN)"
```

---

## Final verification (run before opening the PR)

- [ ] **Full frontend CI-equivalent:**

```bash
cd frontend && bun run typecheck:ci && bun run test:legacy && bunx vitest run && bun run build
```
Expected: all green; new test files (`storyExport`, `storiesSlice`, `storyReorder`) included in the vitest count.

- [ ] **CJK guard (repo root):** `python -m pytest tests/test_no_hardcoded_cjk.py -q` → PASS.

- [ ] **Manual smoke (dev):** `bun desktop` → open the **Stories** tab → confirm:
  1. Empty first-run state (no "Once upon a time…" seed); add two lines.
  2. Per-line **Preview** plays audio (no 404 in the network tab; request goes to `/generate`).
  3. **Cast** panel assigns a voice to a character; a line with "Default" inherits it.
  4. **Drag** a line to reorder; order persists.
  5. **Generate All** downloads `story.wav` that plays back the lines with `[pause]` gaps.
  6. Reload the app → tracks + cast survive (localStorage).
  7. Switch locale to zh-CN → all Stories strings localize.

- [ ] **Branch + PR:** `feat/stories-editor`, base `main`, continuous-to-`main` per the v0.3.0 cadence.

---

## Notes / constraints honored
- **No backend change, no DB/alembic migration** — preview/export reuse `/generate`; persistence is `localStorage`. Backward-compatible project data is trivially preserved.
- **Default behavior identical on every platform** — Web Audio export, localStorage, native DnD, and `/generate` are platform-agnostic (no opt-in needed; no platform divergence).
- **PIN/LAN-share safe** — preview/export go through `apiFetch` (`API` base + `X-OmniVoice-Pin`), inheriting the #171 fix; remote LAN devices can preview/export too.
- **No new dependency** — DnD is native; WAV encode is hand-rolled; QR/i18n/zustand already present.
