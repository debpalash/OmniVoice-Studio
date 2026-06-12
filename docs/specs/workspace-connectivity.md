# Workspace Navigation, Connectivity & Sharing — spec

**Goal:** Make the app feel like one connected studio instead of eight sibling tabs. Three moves: (1) a **simpler navigation IA** with a consistent workspace shell; (2) **one universal handoff** so any asset (voice, audio, transcript, project, video) can move between workspaces via a single "Use in ▸" affordance — replacing today's ~9 ad-hoc bridges; (3) a **unified asset + local-sharing model** so OmniDrive is the canonical hub and export/reveal/copy-path is one action everywhere.

**Hard constraint — local-first (from `CLAUDE.md`):** "Sharing" here means **on-device handoff + file export**, never cloud links, accounts, or telemetry. No network egress is introduced. Every workspace stays fully functional offline.

Companion to `docs/specs/voice-studio-unification.md` — that spec merges Clone+Design into one **Voice** workspace and generalizes the right-side history panel (P1, already built). This spec assumes that direction and extends the right-history pattern to every workspace ("etc").

Today's reality (grounding): `NavRail.jsx` is a flat 8-item rail (`launchpad, clone, design, dub, stories, gallery, transcriptions, projects`); "OmniDrive" is the label for `pages/Projects.jsx` (aggregates `voice_profiles + studio_projects + generation_history + dub_history + export_history + transcriptions`); Transcripts is a localStorage-only STT log (`pages/Transcriptions.jsx`). Handoffs are one-offs: `pendingProfileId`, `setVdStates`+`setMode`, `restoreHistory`, `loadProject`, `restoreDubHistory`, `handleSaveHistoryAsProfile`, etc.

---

## Part A — Navigation IA (simpler)

### A.1 Grouped rail, fewer primaries

Collapse to a grouped rail (visual dividers, not new clicks). Clone+Design → **Voice** (per the unification spec) drops the primary count 8 → 6:

```
  HOME
   ◉ Launchpad
  ─────────────
  CREATE
   ◉ Voice          (clone + design merged)
   ◉ Stories
   ◉ Dub
  ─────────────
  LIBRARY
   ◉ Gallery        (voices to bring in)
   ◉ OmniDrive      (everything you've made)
  ─────────────
  CAPTURE
   ◉ Transcribe
  ─────────────
   ◉ Settings (footer)
```

- `NavRail.jsx`: render group labels + dividers; same `setMode` mechanism. `tools`/`queue`/`donate`/`enterprise` stay non-rail (reached contextually), `voice` stays the modal profile overlay.
- `AppMode` (`uiSlice.ts`): `clone|design → studio` (unification spec §2). No other id churn.

### A.2 One consistent workspace shell

Every CREATE workspace uses the same three-zone shell (the Voice layout from the unification spec, generalized):

```
[ LEFT rail ] [ contextual library ] [        work column        ] [ right: history/output ]
              (collapsible)            (prompt/canvas/timeline)      (this workspace's runs)
```

- **Right history panel** = the P1 `<WorkspaceHistory>` generalized: Voice shows clone/design gens; **Dub** shows dub jobs; **Stories** shows rendered audiobooks. Each scoped to its workspace, each row reusing the shared `<WaveformPlayer>` and the same "Use in ▸" menu (Part B). This is the literal "history for each … on the right, etc." ask.
- **Left contextual library**: Projects (Dub/Stories) or Saved profiles (Voice) — already partly there via the sidebar; standardized.

No backend in Part A.

---

## Part B — Universal handoff ("Use in ▸")

### B.1 One bridge replaces nine

Generalize the `pendingProfileId` pattern (`uiSlice.ts` + the consumer effect in `App.jsx`) into a single typed handoff in the store:

```ts
// store/handoffSlice.ts
type AssetKind = 'voice' | 'design' | 'audio' | 'transcript' | 'project' | 'video';
interface Handoff {
  target: AppMode;          // 'studio' | 'dub' | 'stories' | 'transcribe' | ...
  kind: AssetKind;
  payload: Record<string, unknown>;  // e.g. {profileId} | {vdStates} | {audioPath} | {text,lang} | {projectId}
  ts: number;
}
interface HandoffSlice {
  handoff: Handoff | null;
  sendTo(target: AppMode, kind: AssetKind, payload): void;   // sets handoff + setMode(target)
  consumeHandoff(): Handoff | null;                          // returns & clears (one-shot)
}
```

- `sendTo` sets `handoff` and navigates (`setMode(target)`).
- Each workspace, on becoming active, calls `consumeHandoff()`; if `handoff.target` matches and the kind is one it accepts, it applies the payload (and waits for async loads exactly like the P1 `pendingProfileId` effect does for a freshly-created profile). One-shot; cleared on read.
- **Migrate existing one-offs onto it:** `pendingProfileId` (voice→studio), gallery `attrs`→design, `restoreHistory`, `loadProject`, `restoreDubHistory`, `handleSaveHistoryAsProfile` all become `sendTo(...)` + a per-workspace consumer. Net: one mechanism, testable in isolation, instead of scattered `setMode`+setter pairs.

### B.2 The affordance

A single **`<UseInMenu asset={…} />`** dropdown rendered on every asset card (history row, profile card, gallery card, transcript row, OmniDrive card, dub-segment voice picker). It lists only **valid targets** for that asset kind:

| Asset kind | Origin examples | "Use in ▸" targets |
|---|---|---|
| `voice` (profile) | Gallery, OmniDrive, Voice profiles strip | Voice (load), Dub (set segment/default voice), Stories (assign cast) |
| `design` (vd_states) | Gallery archetype, a design gen | Voice → By design (prefill sliders) |
| `audio` (a generation) | Voice history, OmniDrive | Save as profile, Use in Stories (as a line take), Export |
| `transcript` (text+lang) | Transcribe page, **Dub auto-transcript** | New Dub (seed segments), New Story (seed lines), Copy text |
| `project` | OmniDrive, Launchpad recents | Open in Dub / Stories |
| `video` | Dub source | Re-open in Dub |

This table *is* the gap-closure from the connectivity audit (design→dub, clone-gen→stories, dub-transcript→transcribe, stories-cast→profile, transcript→dub/stories) — each gap is just one row's target becoming available.

---

## Part C — Unified asset substrate & local sharing

### C.1 Assets are first-class

OmniDrive already aggregates five tables + localStorage transcripts. Formalize a read model so every surface (OmniDrive, the per-workspace right panel, `<UseInMenu>`) speaks one shape:

```ts
interface Asset {
  id: string; kind: AssetKind;
  title: string; subtitle?: string;
  created_at: number;
  preview?: { audio_path?: string; thumb?: string };
  source: AppMode;                 // where it was made
  targets: AppMode[];             // valid "Use in ▸" destinations (from the B.2 table)
}
```

- Pure derivation over existing tables for v1 — **no new storage** for profiles/gens/dubs/exports. A `GET /assets?kind=&source=&limit=` endpoint (optional) can centralize this later; v1 derives client-side in `useAppData`.

### C.2 Promote transcripts to the backend

Transcripts are the one orphan (localStorage `omni_transcriptions`, no backend, no handoff). To make them first-class assets and reliably hand-off-able:

- New table `transcriptions(id, text, language, duration_s, segments_json, source, created_at)` via **alembic `0004`** (idempotent, same pattern as `0002/0003`).
- `CaptureWidget` and the **Dub auto-transcript** both write here (closes the "dub transcript → Transcribe" gap). Backward-compat: one-time import of any existing `omni_transcriptions` localStorage entries on first load, then localStorage becomes a cache only.
- WS `transcriptions` event (mirrors the existing `generation_history`/`profiles` events) for live updates.

### C.3 Sharing = local, unified

One **Export** path for every audio/video asset, surfaced via `<UseInMenu>` → Export:

- Single dialog: format (WAV/MP3 for audio; MP4/WAV/stems/SRT for dub/stories), destination, "Reveal after". Reuses today's `handleNativeExport`/`triggerDownload`/`exportRecord` — just consolidated behind one component and logged to `export_history` (→ OmniDrive Downloads).
- "Share" affordances, all on-device: **Export file**, **Reveal in folder** (`exportReveal`), **Copy file path**. Explicitly **no** cloud upload / share links (local-first). Browser/Docker builds fall back to blob download as today.

---

## Phasing (continuous-to-main; each shippable alone)

1. **C0 — `<UseInMenu>` + `handoffSlice`** wrapping the *existing* handoffs (voice→studio, gallery→design, restore/loadProject). Pure refactor to one mechanism; no new destinations yet. De-risks everything after.
2. **A1 — Grouped NavRail** + extend `<WorkspaceHistory>` to Dub & Stories (right panel everywhere). Frontend only.
3. **B-gaps — New targets** one row at a time: voice→Dub segment, design→Voice, audio→Stories, transcript→Dub/Stories. Each is a consumer + a menu entry.
4. **C2 — Transcripts to backend** (alembic `0004`, dub-transcript write-through, localStorage import). Backend + frontend.
5. **C3 — Unified Export dialog** consolidating the three export paths; OmniDrive becomes the single asset browser over the `Asset` read model.

---

## Backward-compat, risks, tests

- **Data:** only additive (alembic `0004` transcripts; existing tables untouched). localStorage transcripts imported once, never dropped. Existing project/profile/history flows keep working because C0 wraps them rather than replacing semantics.
- **Cross-platform:** all default behavior identical on macOS/Win/Linux; native save/reveal already abstract per-OS; browser build keeps blob-download fallback. No platform-only default introduced (local-first + parity rules).
- **Mode-id churn:** only `clone|design→studio` (shared with the unification spec); a restore shim maps legacy ids/payloads.
- **Docs-sync:** NavRail/IA changes touch any `docs/**`/README that describes the tabs → update in the same PR.
- **Tests:** `handoffSlice` consume-once semantics (unit); each `<UseInMenu>` lists only valid targets per kind; a handoff applied after async asset load (the P1 wait-for-profile case) lands on the right asset; alembic `0004` upgrade/downgrade + localStorage import; export dialog logs to `export_history` and reveals on each OS path.

---

## Open decisions (cheap to flip)

- **OmniDrive as home?** This spec keeps **Launchpad** as home and OmniDrive as the asset library. If you'd rather OmniDrive *be* the landing hub (everything starts from "your stuff"), that's a Launchpad/OmniDrive merge — say so and it folds into A1.
- **Drag-and-drop vs menu.** v1 ships the `<UseInMenu>` dropdown (discoverable, keyboard-friendly). Drag an asset card onto a rail item is a later additive layer over the same `sendTo`.
- **`GET /assets` endpoint.** v1 derives assets client-side; promote to a backend read model only if OmniDrive paging needs it.
