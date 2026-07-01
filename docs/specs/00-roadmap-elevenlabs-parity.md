# OmniVoice → True ElevenLabs Alternative — Spec Roadmap

This directory holds the implementation-ready specs that close the gap between
OmniVoice Studio and ElevenLabs **without giving up what makes OmniVoice
different**: fully local, no accounts, no API keys, no telemetry, 646 languages,
cross-platform. The thesis is *counter-positioning*, not feature-cloning — we
match the capabilities creators actually feel, and we win on "your voice never
leaves your machine."

## The thesis

ElevenLabs' moat is **perceived voice quality + expressive control**, and its
2025-26 expansion is **voice agents**. Everything else (library, studio editor,
dubbing depth, API) is table-stakes polish. OmniVoice already has the hard parts
— multi-engine TTS/ASR, cloning, design, dubbing, live dictation, an MCP server,
a local-LLM adapter, streaming TTS, echo cancellation. The gap is mostly **the
last mile of control and polish on top of infrastructure that already exists.**

## Gap analysis

| ElevenLabs capability | OmniVoice today | Spec that closes it |
|---|---|---|
| Expressive/emotional delivery (v3 audio tags) | Voice *design* attributes only; no per-utterance emotion | **01 — Expressive TTS** |
| Pronunciation dictionaries (IPA/phoneme) | `pronunciation.py` alias/respell, not user-editable/persisted | **01 — Expressive TTS** |
| Conversational AI / voice agents | Pieces exist (streaming STT+TTS, local LLM, AEC) but no loop | **02 — Conversational Agent** |
| Projects / Dubbing Studio (per-line regen, edit transcript/translation, reassign speaker) | Dub already content-addresses segments; longform caches only per-chapter; no unified editor | **03 — Long-form Studio Editor** |
| Voice Library / shareable voices / marketplace | Local profiles only; no portable/shareable format | **04 — Voice Packs (local library)** |
| Streaming latency (Flash ~75ms) + SDKs | Streaming TTS exists; latency + API/SDK ergonomics unbenchmarked | **05 — Streaming latency + API/SDK parity** |
| Voice Isolator (denoise), Sound Effects | Demucs is in the dub stack; not exposed as tools | **06 — Audio cleanup + Sound FX** |
| Accounts, cloud sync, hosted marketplace, usage analytics | *(none — intentionally)* | **Won't build** (see below) |

## The specs

### Tier 1 — the moat-closers (highest leverage)

- **[01 — Expressive TTS](01-expressive-tts.md)** — engine-agnostic emotion/style
  intent (inline tags + controls) *lowered* onto each engine's real mechanism
  (OmniVoice `instruct`, CosyVoice NL-instruct/`[laughter]`, IndexTTS2 emotion
  vector, VoxCPM2 prefix), degrading **visibly** never silently; plus a
  user-editable, per-language, DB-persisted **pronunciation dictionary** (IPA/CMU/
  respell) applied pre-synthesis. Builds on `services/ssml_lite.py`,
  `services/pronunciation.py`, `services/longform_parser.py`. Adds
  `services/expression.py`, `api/routers/pronunciation.py`, alembic 0008.
  *Status: spec complete, 5 shippable slices.*

- **[02 — Conversational Agent](02-conversational-agent.md)** — fully-offline
  full-duplex voice assistant: VAD → streaming STT → local LLM → streaming TTS
  with **barge-in** (Silero VAD on AEC-cleaned mic) and a single server-side
  `/ws/converse` orchestrator. Reuses `capture_ws.py` streaming ASR, `tts_stream.py`,
  `aec.py`, `llm_backend.py` (Ollama/OpenAI-compat), `mcp_server.py`. Opt-in;
  half-duplex/push-to-talk fallback on weak hardware. *Status: spec complete, 6 slices.*

- **[03 — Long-form Studio Editor](03-longform-studio-editor.md)** — per-segment
  edit / **regenerate-one-line** / reassign-voice / per-segment emotion / timing,
  across dubbing, audiobooks, stories. Dubbing already content-addresses segments
  (`incremental.py`, `regen_only`, `seg_hashes`); the spec extends that **span-level
  cache to longform** (which today only caches per-chapter) and unifies the editor
  UX. *Status: spec complete, 6 slices, no alembic needed.*

### Tier 2 — ecosystem & developer parity (drafts — expand before implementation)

- **04 — Voice Packs (local Voice Library).** A portable, importable voice-pack
  format (profile + reference + design `instruct` + pronunciation overrides +
  license/attribution, signed/hashed) and an **import/export** flow, plus an
  opt-in community **GitHub index** (a JSON manifest repo, not a hosted service)
  the app can browse and pull from. Local-first replacement for the marketplace:
  creators share packs as files/links; nothing is hosted by us. *Touchpoints:*
  voice profile storage, `omnivoice_data/`, the model-store download UI pattern.
  *Open: pack schema, signing/trust, NSFW/abuse stance on the index.*

- **05 — Streaming latency + API/SDK parity.** Honest benchmark of streaming TTS
  **time-to-first-audio** and real-time-factor per engine/device, a latency
  budget, and a documented **OpenAI-compatible + native streaming HTTP/WS API**
  with thin Python/JS SDK wrappers so developers can drop OmniVoice in where they
  used ElevenLabs. *Touchpoints:* `tts_stream.py` (`/ws/tts`), the MCP server, the
  generate path. *Open: which engines get the low-latency "Flash-class" path; SDK
  surface; OpenAI `/v1/audio/speech` compatibility scope.*

- **06 — Audio cleanup + Sound FX.** Expose **Voice Isolator** (vocal/denoise via
  the Demucs already vendored in the dub stack) and a **text-to-sound-effects**
  generator as first-class tools (and MCP tools), reusing existing audio I/O.
  *Touchpoints:* the dub separation stage, `services/audio_dsp.py`, MCP. *Open:
  which local SFX model; scope vs. core TTS focus (likely lowest priority).*

## Dependencies & recommended sequencing

```
01 Expressive TTS ──► (emotion/style field) ──► 03 Studio Editor (per-segment emotion)
        │
        └──► 02 Conversational Agent (expressive replies)
02 reuses: 01's streaming TTS quality + the existing live-dictation STT
05 (API/latency) underpins 02's "feels real-time" and is independently shippable
04 / 06 are independent and can slot in anytime
```

Recommended order on the v0.3.x line (each spec is already sliced so early slices
ship value without the whole feature):
1. **01 Expressive TTS** — biggest perceived-quality win, unblocks 03's emotion-
   per-segment and 02's expressive replies. Start with the pronunciation
   dictionary slice (fast, high-trust) + inline emotion tags.
2. **03 Studio Editor** — the dub transcript-edit + single-line-regen slice is
   small (the cache already exists) and immediately feels "pro."
3. **02 Conversational Agent** — the headline new *category*; ship half-duplex
   first, then barge-in. Pair with the 05 latency benchmark.
4. **05 / 04 / 06** — as capacity allows; 05 makes OmniVoice a real developer
   drop-in, 04 builds community gravity, 06 is breadth.

## Cross-cutting principles (every spec obeys these)

- **Local-first, always.** No cloud calls, accounts, or keys on any default path.
  New capabilities run on-device; "share" means files/links the user controls.
- **Cross-platform default parity (hard rule).** Default behavior identical on
  macOS / Windows / Linux; anything platform-specific is opt-in (Settings toggle,
  env var, CLI flag). CPU-capable baselines everywhere.
- **Back-compat (hard rule).** Existing engines, on-disk model state, and
  `omnivoice_data/` keep working with no forced reinstall or re-render; schema
  changes go through tested alembic upgrades.
- **Sliceable onto v0.3.x.** No big-bang merges, no v0.4 deferrals — every spec is
  decomposed into independently-shippable slices with fail-before/pass-after tests.
- **Degrade visibly.** When an engine/host can't do something (an emotion an
  engine lacks, latency on weak hardware), tell the user — never fail silently or
  fake it.

## What we deliberately will NOT build

Accounts, login, cloud sync, a hosted voice marketplace, server-side rendering,
and usage analytics/telemetry are ElevenLabs *features* that are **anti-features**
for a local-first tool. We don't measure parity against them. "Fully local, no
keys, 646 languages, free, your voice never leaves your machine" is the
counter-position — these specs make OmniVoice match ElevenLabs on the things
creators feel, while staying on the right side of that line.

## Prior art & reconciliation

This roadmap (00 + 01–03) is the single source of truth for the ElevenLabs-parity
program as of **2026-06-25**. The table below classifies every pre-existing spec in
`docs/specs/` against it: **(S) Superseded** — substantial overlap, the new specs
are more current/grounded (a banner now points here); **(F) Folded-in** — distinct,
still-valuable detail referenced from the new specs; **(K) Keep as-is** — distinct
scope, no parity overlap, left untouched.

| Pre-existing doc | Class | Disposition |
|---|---|---|
| `2026-06-12-elevenlabs-parity-program.md` | **S** | The previous parity roadmap. Its waves are reorganized into Tier 1/2 here; 01 explicitly carries forward its "perceived-quality half." Banner added. |
| `2026-06-13-stories-audiobook-maturity.md` | **S** | Stories/Audiobook convergence + maturity. Its "one shared chapterized render core" and per-line/incremental asks are absorbed by **03** (longform Studio editor + span-level cache). Banner added. |
| `studio-v1.md` | **S** | Long-form block editor v1 (paste→split→assign→stitch). Subsumed by **03**'s unified longform editor across Dub/Audiobook/Stories. Banner added. |
| `voice-console-10x.md` | **K** | Voice-workspace *UI polish* (pinned action bar, identity line, a11y). No parity-capability overlap; left as-is. |
| `voice-studio-unification.md` | **K** | Clone+Design → one "Voice" workspace + data-model unification. UI/IA scope, not parity capability. Left as-is. |
| `workspace-connectivity.md` | **K** | Navigation IA + universal "Use in ▸" handoff + transcripts-to-backend. Cross-workspace plumbing, distinct scope. Left as-is. |
| `2026-05-29-v0.3.0-stabilization-sweep.md` | **K** | Stabilization/bug-cluster + review/security gate program. Orthogonal to parity. Left as-is. |
| `longform/` (#21–#34) | **F** | Granular per-task implementation specs (tied to tasks #21–34). Their capabilities feed the new specs: incremental/longform render → **03**; `.ovsvoice` (#29) → **04 Voice Packs**; ACX two-pass mastering (#28), EPUB/m4b export (#24/#30), transcriptions import (#23), shared voice selector (#22) → the longform editor + Voice Library work; phone calls (#32) → the **deliberately deferred** telephony note (gated on guardrails). Retained as the detailed build specs. |

### Salvaged ideas now referenced (don't lose these)

Concrete deliverables in the pre-existing docs that the new 01–03 did **not** already
surface, captured here so they aren't dropped:

- **GPU-compat preflight — "no silent CPU fallback"** (`longform/21-gpu-compat-matrix.md`). A
  canonical device-family probe + per-engine *effective device*/routing status, surfaced at
  engine-select and **every** synth entry point with an explicit warning when the active engine
  can't use the user's GPU. This is the concrete enforcement of this roadmap's "degrade visibly"
  principle and a "first-run that actually works" win — fold into the platform-robustness track.
- **Standalone `.txt` chapter cue-sheet export** (`longform/33-cue-sheet-export.md`). A
  human-readable `HH:MM:SS<TAB>Title` cue sheet for the longform front doors (for mp3/show-notes/
  YouTube chapters), reusing existing `formatTimecode`/`buildCueSheet` helpers — no backend change.
  A small, high-value nicety for **03**'s longform editor surfaces.
- **Consent-locked voice profiles + AudioSeal watermarking on agentic/shared output**
  (parity-program items 0.2/5.3/5.4; `longform/29-ovsvoice-format.md`, `longform/32-phone-calls.md`).
  The consent/attestation + watermark guardrail is a hard prerequisite for **04 Voice Packs**
  (sharing) and **02**'s agentic output (EU AI Act Art 50, applies 2026-08-02). The new specs assume
  local-first sharing but don't yet spell out the consent-lock/watermark gate — it must land **with**
  04 and any agentic-output path, not as a follow-up.
- **Two-pass ACX loudness mastering + chaptered m4b/cover/metadata** (`2026-06-13-stories-audiobook-maturity.md`,
  `longform/28-two-pass-acx-mastering.md`, `#24`). The audiobook-grade mastering/packaging detail lives
  in those specs; **03** assumes the shared longform render core exists and should consume this rather
  than re-specify it.
