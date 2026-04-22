# Studio / Projects — v1 spec

**Goal:** ElevenLabs-Studio parity for long-form narration. A user pastes (or drags in) a 10-page script, the app splits it into blocks, they assign a voice per block, preview inline, then hit Generate to get one stitched WAV.

Not in v1: video sync, multi-track mixing, music beds, SFX, realtime playback of unstitched audio. Those come later.

## 1 — Data model

Reuse `studio_projects`. Add a strict shape to `state_json`:

```ts
interface ProjectState {
  kind: 'studio';           // discriminates from dub projects (same table)
  blocks: Block[];
  default_voice_id: string; // profile_id used for blocks that don't pin one
  default_lang?: string;
  created_by_version: string;
}

interface Block {
  id: string;               // uuid, stable across edits
  text: string;
  voice_id?: string;        // overrides project default; null → inherit
  pause_before_ms?: number; // inserted silence (0–5000)
  pause_after_ms?: number;
  // Generation state — server-owned, not user-edited
  gen?: {
    audio_path: string;     // absolute path to per-block WAV in scratch
    duration_ms: number;
    hash: string;           // SHA-256 of (text, voice_id, gen knobs) — cache key
    generated_at: number;
  };
}
```

Two migrations needed:
- `ALTER TABLE studio_projects ADD COLUMN kind TEXT DEFAULT 'dub'` so we can filter studio vs dub projects in list views.
- A `project_block_cache` table keyed by `hash` so re-opening a project replays existing audio without re-generating. (Can skip for v1 and just store paths inside `state_json.blocks[*].gen` — single-writer, no concurrent edits.)

## 2 — Backend endpoints

Only two new routes; everything else reuses existing generation:

```
POST /studio/projects/{id}/blocks/{block_id}/generate
   body: { text, voice_id, knobs? }  (knobs = same FormData shape as /generate)
   response: { audio_path, duration_ms, hash }
   Internally calls the same TTS pipeline /generate does, just writes to
   scratch under projects/{id}/ instead of the global history dir.

POST /studio/projects/{id}/stitch
   body: { include_block_ids?: string[] }   // defaults to all
   response: { audio_path, duration_ms }
   Reads blocks in order, inserts silence for pause_before/after_ms,
   concatenates via ffmpeg, returns final WAV.
```

Plus extend the existing `PUT /projects/{id}` to accept the new `state_json` shape — zero code change since it's already JSON blob passthrough.

Everything else (list, create, delete, the profiles endpoint for voice picker) is already built.

## 3 — UI shape

One new route: `/studio/:projectId`. Lazy-load like you do for CloneDesignTab.

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Projects    [project title, inline-edit]        [Export WAV] │
├────────────────┬────────────────────────────────────────────────┤
│                │                                                │
│  BLOCK LIST    │  BLOCK EDITOR (selected block)                 │
│  (left rail)   │                                                │
│                │   ┌─────────────────────────────────────────┐  │
│  ┌───────────┐ │   │  [textarea — the text for this block]   │  │
│  │ Block 1 ▸ │ │   │                                         │  │
│  │ "In a…"   │ │   └─────────────────────────────────────────┘  │
│  │ [voice:A] │ │                                                │
│  │ ▶ 0:12    │ │   Voice:  [SearchableSelect — profiles ▾]      │
│  └───────────┘ │   Pause before: [___] ms                       │
│  ┌───────────┐ │   Pause after:  [___] ms                       │
│  │ Block 2 ▸ │ │                                                │
│  │ "The…"    │ │   [Generate block] [Preview] [⚙ advanced ▾]    │
│  │ [voice:B] │ │                                                │
│  │ ▶ 0:08    │ │   ── Generated audio ──────────────────────    │
│  └───────────┘ │   [waveform] [▶ play] [hash: 3f2a…]            │
│  ┌───────────┐ │                                                │
│  │ + add     │ │                                                │
│  └───────────┘ │                                                │
│                │                                                │
├────────────────┴────────────────────────────────────────────────┤
│  TRANSPORT                                                      │
│  [▶ play all]  [Regenerate stale (3)]  [Stitch & export WAV]    │
│  ▓▓▓▓▓▓▓▓▓░░░░░░░░  block 3 of 12 · 1:42 / 6:10                │
└─────────────────────────────────────────────────────────────────┘
```

Key UX calls:
- **Paste-to-split**: a user pasting a long script should get auto-split into blocks on paragraph breaks (reuse `backend/services/subtitle_segmenter.py` — it already does sentence boundaries). No manual block-creation for v1.
- **Stale indicator**: if `block.gen.hash` ≠ `hash(current text+voice+knobs)`, show a 🔄 badge. "Regenerate stale" button in transport acts on all stale blocks in parallel (backend already parallel-safe via `loop.create_task`).
- **Voice inheritance**: blank voice on a block = use project default. Drop-down shows "↳ Default (Voice A)" so it's obvious.
- **No timeline ruler in v1.** Blocks are a vertical list, not a horizontal timeline. Horizontal timeline with per-block length visualization is v2 — it's a lot of UI work and users don't need it until they're composing with music beds.

## 4 — Reusable primitives (already built)

| Thing | Where | Reuse as |
|---|---|---|
| `SearchableSelect` | `frontend/src/components/` | voice picker |
| `WaveformTimeline` | `frontend/src/components/` | per-block playback |
| Profiles API (`listProfiles`) | `frontend/src/api/profiles.ts` | voice dropdown source |
| TTS generation | `backend/api/routers/generation.py` (`/generate`) | per-block generate |
| Subtitle segmenter | `backend/services/subtitle_segmenter.py` | paste-to-split |
| SSE progress | `backend/utils/hf_progress.py` | stream generation status |
| ffmpeg concat | `backend/services/ffmpeg_utils.py` | stitching |

## 5 — Golden path (flow the user walks)

1. Home → Projects → **New Studio Project** → auto-creates id, lands in `/studio/:id`
2. Paste 5 paragraphs of text → auto-split into 5 blocks, all assigned to project default voice
3. Click block 3 → change voice to a second profile (narrator → character)
4. Click **Regenerate stale** → backend fires 5 parallel `/studio/.../generate` calls, progress streams back
5. Click **▶ play all** → client plays each block's audio in sequence with silences (no stitch needed for preview)
6. **Stitch & export WAV** → backend concatenates, returns file path, Tauri reveals in Finder

## 6 — Week-of-work breakdown

| Day | Work |
|---|---|
| **Day 1** | Backend: schema migration, `/studio/projects/{id}/blocks/{block_id}/generate` route, `/studio/projects/{id}/stitch` route. Reuse `subtitle_segmenter` for paste-split. |
| **Day 2** | Frontend: `StudioPage.jsx` skeleton + routing + new-project creation. Block list left rail. Block editor right panel (text + voice + pauses). |
| **Day 3** | Per-block generate wiring + stale-hash detection + transport bar + parallel regen. Reuse WaveformTimeline for preview. |
| **Day 4** | Play-all sequencing (client-side — Web Audio queue), stitch-and-export. Toast + Finder reveal. |
| **Day 5** | Paste-to-split, keyboard shortcuts (⌘↩ regen, ⌘S save, ⌘E export), empty states, polish. |
| **Day 6** | Ship-test: on the fresh-install DMG, create a 10-block project, swap voices, export. Fix whatever breaks. |
| **Day 7** | Buffer / docs / cut a release. |

## 7 — Explicitly out of scope for v1

- Horizontal time-ruler / waveform-scrubbing timeline
- Inter-block transitions (crossfade, duck)
- Music / SFX beds
- Multi-track (parallel voice layers)
- Import from `.docx` / `.fdx` (screenwriter formats)
- Shareable project links (local-first — skip)
