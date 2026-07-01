# Local Conversational Voice Agent — Implementation Spec

**Date:** 2026-06-25
**Status:** Proposed
**Owner:** debpalash
**Spec #:** 02

A fully-offline, low-latency full-duplex voice assistant for OmniVoice Studio:
**VAD → streaming STT → local LLM (streaming tokens) → streaming TTS**, with
barge-in / turn-taking and echo cancellation so the agent never hears itself.
Opt-in, heavier "Conversation" mode. Composes components OmniVoice already ships
(sub-second streaming ASR, sentence-chunked streaming TTS, an NLMS echo
canceller, an OpenAI-compatible local LLM adapter, far-end audio bus) rather
than introducing a parallel stack.

---

## Context & Problem

### The category gap

Voice **agents** are the product ElevenLabs (Conversational AI), OpenAI (Realtime
API), and the open-source frameworks (LiveKit Agents, Pipecat, Ten) are all
racing on. The defining UX is *full-duplex conversation*: you talk, it answers in
~250–450 ms, and you can **interrupt it mid-sentence** and it stops and listens.
Every production stack today is **cloud-tethered** — the STT, the LLM, and often
the TTS are remote API calls, which means an account, an API key, per-minute
billing, and your microphone audio leaving the machine.

### Why OmniVoice is uniquely positioned

OmniVoice already has **every pipeline stage** of a voice agent, running locally,
and they were each built (and hardened) for the live-dictation feature that just
landed:

| Agent stage | Already in the codebase | Path |
|---|---|---|
| Streaming STT with endpointing | sherpa-onnx `OnlineRecognizer`, frame-by-frame decode, `is_endpoint()` turn detection, <300 ms perceived latency on CPU | `backend/api/routers/capture_ws.py:414-533` (`_run_sherpa_streaming`), `backend/services/sherpa_dictation.py:275-316` |
| Echo cancellation (anti-self-trigger) | `NlmsEchoCanceller` with Geigel double-talk detector, server-side so it's platform-identical | `backend/services/aec.py:75-282` |
| Far-end reference plumbing | publish/subscribe far-end bus + playback tap worklet feeding the AEC reference frame | `frontend/src/utils/aec/farEndBus.js`, `playbackTap.js`, `public/aec-worklet.js` |
| Streaming TTS | `/ws/tts` sentence-chunked synthesis, <100 ms TTFA target, conversational keep-open socket | `backend/api/routers/tts_stream.py:54-272` |
| Local LLM "brain" | OpenAI-compat adapter (Ollama / LM Studio / llama.cpp server), structured chat-messages surface | `backend/services/llm_backend.py:66-141` |
| Tool surface | FastMCP server (`generate_speech`, `list_voices`, `transcribe`, …) | `backend/mcp_server.py:101-246` |

No competitor can offer **"voice agent, zero cloud, your voice never leaves the
box, runs on a CPU laptop."** OmniVoice can, because the parts are already here
and already cross-platform. This spec wires them into one full-duplex loop.

### The problem this solves for users

Today a user can *dictate* to OmniVoice and *generate speech* from OmniVoice, but
the two are disconnected. They cannot **talk to** it. The asks already arriving in
Issues/Discord — "local Alexa", "offline ChatGPT voice mode", "talk to my docs
without an API key" — all reduce to the same missing primitive: a turn-taking
voice loop. That primitive is also the substrate for later agentic features
(voice-driven dubbing direction, hands-free batch control via the MCP tools).

---

## Goals / Non-goals

### Goals

1. **Full-duplex conversation mode** — speak, get a spoken answer in a natural
   turn gap (target **median end-of-speech → first-audio ≤ 700 ms** on Apple
   Silicon / discrete GPU; degrade gracefully on CPU, see Phasing).
2. **Barge-in** — the user can interrupt the agent mid-utterance; TTS playback
   stops within **≤ 200 ms** and the loop returns to listening.
3. **No self-trigger** — the agent's own TTS playback, leaking into the mic, must
   not be transcribed as user speech. Reuse the existing AEC + far-end bus.
4. **Fully local & opt-in** — no cloud, no keys, no accounts. Off by default;
   one Settings toggle turns it on. Functions with reporting/telemetry disabled.
5. **Cross-platform parity** — identical default behavior on macOS / Windows /
   Linux. Any platform-only optimization is opt-in.
6. **CPU-capable** — usable (if slower) on a CPU-only machine with a small quant
   LLM and a CPU-realtime TTS engine; never a hard GPU requirement.
7. **Conversation persistence** — turn history kept across a session and
   resumable, with an additive alembic migration and no migration of existing
   `omnivoice_data/`.
8. **Engine back-compat** — no change to on-disk engine/model state; existing
   IndexTTS/CosyVoice/etc. installs are untouched.

### Non-goals

- **Bundling an LLM in the installer.** We *standardize on* a local runtime and
  guide the user to install a model (one-click where possible), but the ~1–4 GB
  weights are a first-use download, not installer payload (mirrors the existing
  TTS model-on-first-use pattern).
- **A new TTS engine.** Real-time uses the engines already present (KittenTTS /
  MOSS-TTS-Nano / Kokoro-via-MLX); no sample-level streaming engine is added.
- **Telephony / SIP / multi-party.** Single local user, one mic, one speaker.
- **Sample-level (sub-sentence) TTS streaming.** Sentence-chunked streaming is
  the latency mechanism; sub-sentence is an open question, not a v0.3.x goal.
- **Cloud LLM as a default.** Cloud OpenAI-compat endpoints remain *possible*
  (the adapter already supports them) but stay opt-in and never the default.
- **Wake-word / always-listening.** Mode is explicitly entered; no background
  hot-mic.

---

## User Experience

### Entering the mode

- **Opt-in gate.** Settings → *Conversation (beta)* toggle (`prefs` key
  `conversation.enabled`, default `false`). While off, nothing in the loop loads
  and no new socket opens — zero footprint, identical to today on every platform.
- A new left-nav entry **"Talk"** appears only when the toggle is on. First entry
  runs a **readiness check**: is a local LLM reachable (`llm_backend.is_available()`),
  is a streaming sherpa ASR model installed, is a real-time-capable TTS engine
  selected? Any miss shows an inline, actionable card (the project's house error
  style) — e.g. *"No local LLM detected. Install Ollama and pull `llama3.2:3b`,
  then click Recheck"* with a copy-paste command per OS. Nothing auto-installs.

### The conversation screen

A single focused view:

- **Big mic orb** at center with four visible states: *Idle* → *Listening*
  (waveform reacts to mic) → *Thinking* (LLM streaming) → *Speaking* (orb pulses
  with TTS playback). State transitions are the user's mental model of whose turn
  it is.
- **Live transcript rail** — the user's partial ASR text appears as they speak
  (greyed, italic), commits on endpoint, then the agent's reply streams in token
  by token as it's generated, with a speaker label and the **voice profile** the
  agent is using (any saved clone/design voice — reuse the profile picker).
- **Barge-in affordance** — while *Speaking*, a subtle "interrupt anytime" hint;
  starting to talk visibly cuts the agent off (orb snaps Listening, the agent's
  half-spoken line is marked *(interrupted)* in the rail).
- **Controls** — push-to-talk vs. open-mic toggle (open-mic is VAD-gated;
  push-to-talk is the CPU-friendly / noisy-room fallback), voice picker, LLM
  model indicator, *End conversation* (persists + closes the session), mute.
- **System prompt / persona** — a small "Agent persona" field (persisted per
  conversation) so the user can set behavior ("You are a terse coding helper").
  Defaults to a neutral, concise assistant prompt.

### Core flow (happy path)

1. User clicks **Talk**, mode initializes (warm the ASR recognizer, TTS model,
   and confirm LLM reachable — show a one-time spinner).
2. User speaks. Partial transcript streams (existing `partial` frames). On
   `is_endpoint()` (trailing-silence turn detection) the utterance commits.
3. The committed user turn (+ short rolling history + persona system prompt) is
   sent to the local LLM, which **streams tokens**.
4. Tokens feed the existing `SentenceChunker`; each completed sentence is handed
   to streaming TTS the moment it's ready (first sentence starts speaking while
   the LLM is still generating the rest — the core latency trick).
5. TTS audio plays; **every playback frame is published to the far-end bus** and
   sent to the ASR socket as an AEC reference (tag `0x01`) so the agent doesn't
   transcribe itself.
6. The mic stays open (open-mic mode): if the user starts talking (VAD speech +
   AEC-cleaned energy over threshold for the barge-in window) → **barge-in**:
   cancel the LLM stream, flush the TTS queue, stop playback, return to step 2.
7. On *End conversation*, the turn history is persisted and the sockets close.

### Degraded / edge flows

- **Weak hardware:** if warm-up profiling predicts response latency over a
  threshold, the UI suggests **push-to-talk + half-duplex** (no barge-in) and a
  smaller LLM/TTS, but still works.
- **No LLM:** mode is unavailable with the actionable install card; the rest of
  the app is untouched.
- **Noisy room / open-mic false triggers:** a sensitivity slider and a
  push-to-talk escape hatch; barge-in defaults conservative to avoid the agent
  interrupting itself on its own echo tail.

---

## Technical Design

### The full-duplex pipeline

```
 mic ──worklet──► PCM16 frames ──┐
                                 │  (tag 0x00 near-end)
 TTS playback ──playbackTap──► far-end bus ──► PCM16 (tag 0x01 far-end)
                                 │
                                 ▼
   ┌──────────────  /ws/converse  (NEW orchestration socket)  ──────────────┐
   │                                                                         │
   │  NlmsEchoCanceller.process_near_end()  ── clean mic ──► OnlineRecognizer│
   │        (services/aec.py)                          (sherpa streaming)    │
   │                                                          │ partial/final│
   │                                                  is_endpoint() → TURN    │
   │                                                          ▼              │
   │              ConversationSession (NEW)  ── history + persona ──►        │
   │                          │                                              │
   │                          ▼ streaming chat                               │
   │              llm_backend.chat_messages_stream() (NEW streaming surface) │
   │                          │ tokens                                       │
   │                          ▼                                              │
   │              SentenceChunker.push() ── sentence ──► TTS generate        │
   │                          │                     (services/tts_backend)   │
   │                          ▼ PCM16 chunks                                 │
   │              ◄── audio frames back to client ──►  (barge-in cancels)    │
   └─────────────────────────────────────────────────────────────────────────┘
```

The whole loop is one **server-side orchestrator** so turn-state, barge-in
cancellation, and history live in one place rather than being coordinated across
three independent client sockets. The client streams mic+reference PCM up and
receives transcript/state/audio frames down — one connection.

### Files/services to add or extend

**New — backend**

- `backend/api/routers/converse_ws.py` — the `/ws/converse` orchestration
  endpoint. Models on `capture_ws.py`'s loopback guard + `ws_remote_authorized`
  pattern (`capture_ws.py:139-142`), the AEC-tagged PCM transport
  (`_demux_aec_frame`, `_recv_pcm_frame` at `capture_ws.py:62-73, 383-411`), and
  the sherpa streaming decode loop (`capture_ws.py:457-497`). Owns the
  per-session `ConversationSession` and the cancellation token.
- `backend/services/conversation.py` — `ConversationSession`: holds the rolling
  message list (system persona + last *N* turns, token-budgeted), drives one
  turn (ASR-final → LLM stream → sentence-chunk → TTS), and exposes an
  `asyncio.Event`-based **interrupt** that barge-in trips to cancel the in-flight
  LLM generation + drain the TTS queue. Persists turns via the new store.
- `backend/services/conversation_store.py` — CRUD over the new `conversations`
  and `conversation_turns` tables (below). Thin, mirrors `mcp_bindings.py`.
- `backend/services/vad.py` — Silero-VAD wrapper (ONNX, CPU, ~1 MB) for
  **barge-in detection** specifically: scores AEC-*cleaned* mic frames while the
  agent is speaking, so the agent's own echo tail can't trip it. Endpointing of
  the *user's* turn stays with sherpa's `is_endpoint()` (already tuned, rule1
  2.4 s / rule2 1.2 s trailing silence — `sherpa_dictation.py:298-301`); VAD is a
  fast speech-onset gate, not a replacement for endpointing.

**Extend — backend**

- `backend/services/llm_backend.py` — add `chat_messages_stream(messages, …)`
  yielding token deltas. The `openai` client already supports `stream=True`;
  this is an additive surface alongside the existing one-shot `chat_messages`
  (`llm_backend.py:123-141`). `OffBackend` raises the same clear error.
- `backend/services/tts_backend.py` — reuse `get_active_tts_backend` /
  `generate` unchanged; add a thin per-sentence helper that the session calls so
  TTS runs in the GPU/CPU pool exactly as `tts_stream.py:188-209` does today.
- `backend/core/prefs.py` — new `conversation.*` keys (enabled, llm_model,
  tts_engine, mode `open-mic|push-to-talk`, vad_sensitivity, persona_default).
  Mirrors the existing `dictation.*` namespace and rebuild-on-change pattern
  (`api/routers/dictation.py:99-127`).

**New — frontend**

- `frontend/src/components/Conversation/ConversationView.jsx` — the screen.
  Reuses `startMicCapture` (`utils/aec/micCapture.js`), `frameFromFloat` +
  `AEC_NEAR`/`AEC_FAR` tags (`utils/aec/pcm.js`), `subscribeFarEnd`
  (`utils/aec/farEndBus.js`), and the voice/profile picker.
- `frontend/src/utils/conversationSocket.js` — opens `/ws/converse?aec=1&sr=16000
  &model=<sherpa>`, multiplexes: uploads tagged mic + far-end PCM, receives
  `partial`/`final`/`token`/`state`/audio-bytes/`done` frames.
- `frontend/src/utils/conversationPlayer.js` — a **gapless PCM16 queue player**
  (Web Audio `AudioBufferSourceNode` scheduling) that (a) plays streamed agent
  audio with minimal gaps between sentences and (b) **publishes each played frame
  to `publishFarEnd()`** so it becomes the AEC reference — closing the
  anti-self-trigger loop. Exposes `flush()` for instant barge-in stop. This is
  the one genuinely new client primitive (today's TTS path buffers a whole WAV
  then plays via `playBlobAudio`; a conversation needs incremental, interruptible
  playback).

### Per-stage latency budget

Production voice agents target a **200–450 ms** end-of-user-speech → first-audio
gap (human turn-taking rhythm), and **< 200 ms** barge-in stop
([LiveKit](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection),
[FutureAGI](https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/)).
We split the gap as follows. Two budgets: a **GPU/Apple-Silicon** target and an
honest **CPU-only** reality.

| Stage | What | GPU/MPS target | CPU-only realistic |
|---|---|---|---|
| Endpoint detection | sherpa `is_endpoint()` trailing-silence commit | ~150–250 ms (silence rule, inherent) | same |
| ASR finalize | drain stream for committed text (already decoded incrementally) | < 30 ms | < 80 ms |
| LLM TTFT | first token from local model | 80–250 ms (3B 4-bit) | 300–600 ms (1–3B) |
| First sentence ready | enough tokens for `SentenceChunker` first emit (aggressive first-clause flush, `sentence_chunker.py:475-555`) | +50–150 ms | +150–400 ms |
| TTS TTFA | synth first sentence, first PCM chunk out | 80–200 ms (Kokoro/Kitten) | 150–400 ms (Kitten/MOSS-Nano) |
| Playback startup | queue player schedules first buffer | < 30 ms | < 30 ms |
| **Perceived gap** | end-of-speech → first audio | **≈ 450–750 ms** | **≈ 1.0–1.9 s** |
| **Barge-in stop** | VAD onset → playback flush + LLM cancel | **< 200 ms** | < 250 ms |

Notes grounding the numbers:
- Local LLM TTFT for 1–3B models is the long pole on CPU; small-model streaming
  runs ~9–14 ms/token with sub-500 ms TTFT on modern hardware, slower on old CPUs
  ([daily.dev](https://daily.dev/blog/running-llms-locally-ollama-llama-cpp-self-hosted-ai-developers/),
  [quantizelab](https://www.quantizelab.dev/articles/vllm-vs-llama-cpp-vs-ollama-benchmark-guide)).
  The CPU path is *usable*, not snappy — hence push-to-talk + half-duplex on weak
  hardware, set honestly by warm-up profiling rather than hidden.
- The **sentence-chunk overlap is the core trick**: the first sentence speaks
  while the LLM finishes the rest, so perceived latency is *first-sentence*
  latency, not whole-response latency. `SentenceChunker`'s aggressive-first-flush
  (emit first clause at ≥ 40 chars on a comma/dash) already exists to shave
  200–500 ms off TTFA.
- The **endpoint silence rule is itself ~1.2–2.4 s** in the current dictation
  tuning, which is too slow for snappy conversation. The session will run a
  **conversation-tuned endpoint profile** (shorter `rule2` trailing silence, e.g.
  ~0.6–0.8 s) configured at recognizer build time — a new spec on
  `sherpa_dictation.py`'s online builder, *not* a change to the dictation
  defaults (back-compat).

### Barge-in + AEC handling

This is the make-or-break of full-duplex, and the existing AEC plumbing is what
makes it tractable locally and identically cross-platform.

1. **Reference path.** Every agent-audio frame the `conversationPlayer` schedules
   is also `publishFarEnd()`-ed; `conversationSocket` subscribes and sends it up
   tagged `0x01`. Server-side, `converse_ws` feeds it to
   `NlmsEchoCanceller.push_far_end()` and cleans the mic with
   `process_near_end()` before *either* ASR or VAD sees it
   (`aec.py:153-207`). The canceller already passes-through when the far-end is
   stale (`aec.py:_FAR_STALE_S`), so it won't buzz once the agent stops talking.
2. **Onset detection.** While state == *Speaking*, the Silero VAD scores the
   **cleaned** mic frames. Sustained speech for a short window (e.g. ≥ 120–200 ms,
   `vad_sensitivity`-tunable) = barge-in. Using cleaned audio + a sustain window
   is what prevents the agent's residual echo from self-interrupting (the classic
   "agent talks over itself" bug).
3. **Cancellation.** On barge-in the session: trips the interrupt `Event` →
   the LLM stream generator is cancelled (stop pulling tokens, the `openai`
   stream is closed), the pending-sentence TTS queue is dropped, a `state:
   listening` + `interrupted` frame is sent, and the client `conversationPlayer.flush()`
   stops playback **immediately** (Web Audio `stop()` on scheduled sources). The
   committed-so-far agent text is saved as a partial turn.
4. **Turn handoff.** The recognizer stream is `reset()` (as in
   `capture_ws.py:493`) and the user's new utterance is decoded fresh.

Server-side AEC was a deliberate cross-platform-parity choice for dictation
(`aec.py:1-27`: browser `echoCancellation` quality/availability varies per
webview, which would make a *default* behave differently per OS). The same
reasoning applies — and is now load-bearing — for the agent.

### LLM runtime choice (with alternatives)

**Standardize on the existing OpenAI-compatible adapter pointed at a local
server — recommend Ollama as the default local runtime, llama.cpp's
`llama-server` as the power-user equal.** Rationale:

- **Zero new code path.** `llm_backend.OpenAICompatBackend` already speaks this
  shape and already names Ollama (`http://localhost:11434/v1`) and LM Studio as
  first-class (`llm_backend.py:66-90`). Adding streaming is one additive method.
- **Local-first & cross-platform.** Ollama ships for macOS/Windows/Linux, runs
  CPU or GPU, auto-detects, streams over SSE with consistent inter-token latency
  — same default behavior everywhere, which the parity rule demands.
- **No weights in our installer.** Model is a guided first-use pull (e.g.
  `ollama pull llama3.2:3b`), matching how OmniVoice already does models.
- **Recommended default model:** a small instruct model (~3B, 4-bit) for the GPU
  path; a ~1–1.5B for the CPU path. Selectable in Settings; we ship *guidance*,
  not weights.

Alternatives considered:

| Option | When to prefer | Why not the default |
|---|---|---|
| **llama.cpp `llama-server`** (OpenAI-compat) | Power users wanting GGUF control / no Ollama daemon; lowest TTFT single-user | Same OpenAI-compat surface — *fully supported* via base-url, just less turn-key to install than Ollama. Documented as the equal alternative. |
| **In-process `llama-cpp-python`** | Eliminate the localhost hop, bundle-friendlier | Adds a native build dep per platform (the very cross-platform fragility we avoid elsewhere); the localhost hop costs < 5 ms. Revisit only if a "no external daemon" install becomes a top ask. |
| **`transformers` in-process** | Reuse the Python env | Heavy load, weak streaming ergonomics, GPU-memory contention with TTS in the single-worker `_gpu_pool` (`model_manager.py:71-104`). Wrong tool for low-latency chat. |
| **Cloud OpenAI-compat** | User explicitly opts in | Violates the local-first default; allowed but never default, never required. |

### Concurrency reality

`model_manager._gpu_pool` is **1 worker on MPS/CPU and budget-limited on CUDA**
(`model_manager.py:71-104`) — ASR, TTS, and a `transformers` LLM would *serialize*
on one GPU. Standardizing the LLM on a **separate local server process** (Ollama /
llama-server) sidesteps this entirely: the LLM runs in its own process/accelerator
context, ASR runs on its sherpa CPU/ONNX path, and TTS uses the existing pool —
three independent lanes, which is exactly what overlapping the pipeline stages
requires. For CPU-only, choosing a **CPU-realtime TTS** (KittenTTS English /
MOSS-TTS-Nano multilingual / Kokoro-via-MLX on Apple) keeps TTS off the LLM's
cores enough to stay usable.

---

## API / Schema / Data-model changes

### WebSocket protocol — `/ws/converse`

Loopback-guarded (or `OMNIVOICE_API_KEY` bearer for the thin-client case), exactly
like `/ws/transcribe`. Query: `?aec=1&sr=16000&model=<sherpa_id>&conversation=<id?>`.

**Client → server**
- Binary frames: tagged PCM16 mono, `0x00` near-end (mic), `0x01` far-end
  (agent-playback reference) — identical framing to the AEC dictation transport.
- JSON control frames:
  - `{"type":"start","persona":"...","voice":"<profile_id>","llm_model":"...","mode":"open-mic|push-to-talk"}`
  - `{"type":"barge_in"}` — explicit interrupt (push-to-talk re-key / UI button); server also detects barge-in via VAD autonomously.
  - `{"type":"end"}` — persist + close.

**Server → client**
- `{"type":"state","value":"idle|listening|thinking|speaking"}`
- `{"type":"partial","text":"..."}` — user ASR interim (reused frame shape).
- `{"type":"final","text":"...","role":"user"}` — committed user turn.
- `{"type":"token","text":"...","role":"assistant"}` — streamed LLM delta.
- `{"type":"start_audio","sample_rate":N,"format":"pcm16","engine":"..."}` then
  binary PCM16 chunks (mirrors `tts_stream.py`'s `start` + bytes contract).
- `{"type":"interrupted","spoken_text":"..."}` — barge-in fired; partial agent turn.
- `{"type":"turn_done","turn_id":N}` / `{"type":"error","detail":"..."}`.

### REST endpoints (loopback-gated, Settings UI)

- `GET/POST /conversation/prefs` — read/write the `conversation.*` prefs +
  readiness status (LLM reachable, ASR model installed, TTS engine real-time).
  Mirrors `dictation.py` prefs router.
- `GET /conversations` — list saved conversations (id, title, started_at, turn_count).
- `GET /conversations/{id}` — full turn history.
- `DELETE /conversations/{id}` — delete one.

### Persistence — additive alembic migration

New migration `0008_conversations.py` (next after `0007_*`), additive only, no
backfill, existing `omnivoice_data/` untouched:

```sql
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,         -- uuid
  title         TEXT,                     -- first user turn, truncated
  persona       TEXT,                     -- system prompt for the session
  voice_profile TEXT,                     -- profile_id the agent speaks with
  llm_model     TEXT,                     -- model id used
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL
);
CREATE TABLE conversation_turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,          -- 'user' | 'assistant'
  text            TEXT NOT NULL,
  interrupted     INTEGER NOT NULL DEFAULT 0,
  created_at      REAL NOT NULL
);
CREATE INDEX ix_turns_conversation ON conversation_turns(conversation_id, id);
```

**Privacy:** transcripts are stored locally only (same trust boundary as
existing history). **No audio is persisted** — only text turns. The auto
bug-reporter must never attach conversation transcripts (extend its scrub
allow/deny exactly as it strips reference audio today).

### Prefs (`core/prefs.py`, JSON store)

`conversation.enabled` (bool, default false), `conversation.mode`
(`open-mic|push-to-talk`, default `push-to-talk` for the safe first run),
`conversation.llm_model`, `conversation.tts_engine`,
`conversation.vad_sensitivity` (float), `conversation.endpoint_profile`
(`conversation|dictation`), `conversation.persona_default` (str). Env overrides
follow the existing `prefs.resolve` precedence.

---

## Local-first & Cross-platform compliance

- **No cloud, no keys, no accounts.** STT (sherpa ONNX), VAD (Silero ONNX), TTS
  (local engines), AEC (server NLMS) all run on-device. The LLM runs on a
  **local** server (Ollama/llama-server) by default. A cloud OpenAI-compat
  endpoint is only reachable if the user explicitly configures one — never the
  default, never required.
- **Opt-in by definition.** Off until the Settings toggle; while off, no socket,
  no model load, no nav entry — the app is byte-for-byte today's behavior on
  every platform. This satisfies the strict opt-in rule for a heavy new mode.
- **Identical default behavior on mac/win/linux.** Server-side AEC was *chosen*
  over browser `echoCancellation` precisely so the default behaves the same on
  every webview (`aec.py:1-27`); the agent inherits that. The mic worklet, PCM
  framing, sherpa decode, sentence chunker, and queue player are platform-neutral
  JS/Python. The one platform-specific *implementation* allowance is the
  Apple-only Kokoro-via-MLX TTS fast path — and it's behind the engine picker
  (opt-in), with a cross-platform default (KittenTTS/MOSS-Nano) so the
  *user-visible default* never diverges. No P0 platform gap.
- **CPU-capable.** A 1–1.5B quant LLM + a CPU-realtime TTS + the CPU sherpa ASR +
  the numpy NLMS AEC is the documented CPU path. Slower turns, push-to-talk +
  half-duplex by default on weak hardware (set by warm-up profiling), but
  functional — no hard GPU requirement.
- **Engine back-compat.** Reuses `get_active_tts_backend` and the LLM adapter as-is;
  no on-disk engine/model state changes; existing installs untouched.
- **Docs-sync.** Lands with a `docs/` page (setup: install Ollama, pull a model,
  pick a voice; the CPU vs GPU expectation table) **in the same PR** as the
  feature, per the docs-sync rule. README feature grid updated.

---

## Phasing (sliceable on the v0.3.x line)

Each phase is an independently-mergeable, bisectable PR (or small cluster) with
tests in the same PR, continuous-to-main — no RC, no version bump beyond the
standing patch. Value lands incrementally.

- **P0 — Streaming LLM surface.** Add `chat_messages_stream()` to
  `llm_backend.py` (+ `OffBackend` parity, + tests). Independently useful
  (dictation refinement could stream later). *No UI.*
- **P1 — Half-duplex conversation (the spine).** `/ws/converse` +
  `ConversationSession` wiring ASR-final → LLM-stream → sentence-chunk → TTS →
  client queue player. **Push-to-talk, no barge-in, no AEC reference loop yet**
  (user holds to talk, releases, listens to the full answer). `ConversationView`
  with the orb + transcript rail. This alone is a shippable "talk to your local
  LLM, get a spoken answer" feature.
- **P2 — Persistence.** `0008` migration + `conversation_store` + history list /
  resume + the `GET/DELETE /conversations` endpoints. Bug-reporter scrub guard.
- **P3 — AEC reference loop.** `conversationPlayer` publishes far-end frames;
  `converse_ws` cancels echo via the existing `NlmsEchoCanceller`. Enables
  **open-mic** safely (agent stops self-transcribing). Still no interruption.
- **P4 — Barge-in.** `services/vad.py` (Silero) on cleaned mic during *Speaking*,
  interrupt `Event`, LLM-stream cancel, TTS-queue flush, client `flush()`. This
  is the full-duplex payoff. Conversation-tuned endpoint profile lands here.
- **P5 — Graceful degradation + polish.** Warm-up latency profiling →
  auto-suggest push-to-talk/half-duplex + smaller models on weak hardware;
  sensitivity tuning; persona presets; readiness-card install guidance per OS;
  docs page + README.

---

## Testing strategy

- **Unit (backend):**
  - `chat_messages_stream` yields deltas, cancels cleanly on interrupt, `OffBackend`
    raises (mock the `openai` stream).
  - `ConversationSession` turn lifecycle: final→tokens→sentences→tts calls in
    order; interrupt `Event` cancels mid-stream and saves the partial turn.
  - `conversation_store` CRUD; `0008` migration **up-then-down** on a copy of a
    real `omnivoice_data/` DB (back-compat: existing tables untouched).
  - VAD barge-in gate: synthetic cleaned-mic frames with/without speech onset →
    fires only on sustained speech, **never** on a far-end echo fixture (the
    self-interrupt regression — a fail-before/pass-after test per the fix-quality
    rule).
  - Conversation-tuned endpoint profile builds without touching dictation defaults.
- **Integration (backend):** a fake LLM (deterministic token stream) + a fake
  fast TTS through real `/ws/converse`; assert frame ordering
  (`state`/`partial`/`final`/`token`/audio/`turn_done`) and that a `barge_in`
  frame mid-speech produces `interrupted` + returns to `listening`.
- **Frontend (vitest):** `conversationPlayer` gapless scheduling + instant
  `flush()`; far-end publish on each played frame; `conversationSocket` framing
  (tags `0x00`/`0x01`, control frames). Reuse the existing AEC PCM test patterns
  (`frontend/src/test/aecPcm.test.js`, `aecFarEndBus.test.js`).
- **Latency harness (non-gating, like the eval tier):** a scripted turn measures
  endpoint→TTFT→TTFA→first-audio on the CI box and on a CPU-only profile, logging
  the budget table so regressions are visible. Not a hard gate (hardware-variable)
  but tracked.
- **Cross-platform / full-matrix green:** no `frontend/package.json` dep churn
  expected beyond a tiny Silero ONNX asset (verify root `bun.lock` regen +
  `bun install --frozen-lockfile` for Docker), `uv tree` clean after adding the
  Silero/onnxruntime path (onnxruntime already transitively present), Tauri cargo
  build unaffected (no Rust change). CodeQL/security re-run on the new socket.
- **Off-by-default proof:** a test that with `conversation.enabled=false`, no
  conversation route/socket is reachable and no model loads — the opt-in guarantee.

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **CPU latency feels sluggish** (LLM TTFT is the long pole). | High on old CPUs | Honest warm-up profiling → default to push-to-talk + half-duplex + smaller model; sentence-overlap so perceived latency is first-sentence; never advertise sub-second on CPU. |
| **Self-trigger / feedback loop** (agent transcribes itself, or interrupts itself). | High without care | Server AEC cleans mic *before* ASR+VAD; barge-in scores **cleaned** audio with a sustain window; far-end-stale pass-through already handled (`aec.py`). The dedicated VAD-vs-echo regression test gates this. |
| **NLMS AEC is "good-enough," not WebRTC AES3** (`aec.py:14-18`) — residual echo on loud speakers. | Medium | Conservative barge-in sensitivity default; recommend headphones in the readiness card; sustain window; optional future upgrade to a stronger canceller is isolated behind the `aec.py` interface. |
| **GPU contention** (LLM + TTS on one accelerator). | Medium | Standardize LLM on a **separate process** (Ollama/llama-server), keeping it off the single-worker `_gpu_pool`; CPU-realtime TTS option. |
| **Endpoint silence too slow → laggy turns** (dictation tuning is 1.2–2.4 s). | Medium | Conversation-specific endpoint profile (shorter trailing silence) built at recognizer init; *dictation defaults unchanged* (back-compat). |
| **User has no local LLM installed.** | High at launch | Readiness card with copy-paste per-OS install (Ollama) + Recheck; mode simply unavailable until satisfied; rest of app untouched. |
| **Open-mic false triggers in noisy rooms.** | Medium | Push-to-talk is the default first-run mode; sensitivity slider; VAD sustain window. |
| **Privacy regression via bug reporter.** | Low but serious | No audio persisted; transcripts excluded from auto bug reports by scrub rule + a test asserting it. |

## Open questions / decisions for the owner

1. **Default local LLM runtime + model.** Recommend **Ollama + `llama3.2:3b`
   (GPU) / a ~1–1.5B (CPU)** as the documented default, llama-server as the
   equal power-user path. Approve, or prefer llama-server-first / a different
   default model?
2. **Default first-run mode.** Spec proposes **push-to-talk** (safe, CPU-kind,
   no false barge-in) with open-mic as opt-in once P3/P4 land. Agree, or
   open-mic-first on capable hardware?
3. **Ship half-duplex (P1) standalone?** It's a real, useful "talk to your local
   LLM" feature before barge-in exists. Ship it as soon as it's green, or hold
   the whole mode until P4?
4. **Bundle the Silero VAD ONNX asset** (~1–2 MB) in-repo/installer vs.
   first-use download? It's tiny and load-bearing for barge-in — leaning bundle,
   but it's a (small) installer-size decision.
5. **Conversation persistence default.** On (resumable history) or off
   (ephemeral, nothing written) by default? Privacy-conservative would be
   **ephemeral by default, opt-in to save**.
6. **Persona / system-prompt library.** Ship a small preset set (concise
   assistant, coding helper, tutor) or just a free-text field for v1?
7. **MCP tool-calling in v1?** The agent *could* call the FastMCP tools
   (`generate_speech`, `list_voices`, …) to act on the app by voice. Powerful but
   adds tool-call orchestration + latency. Recommend **deferring tool-calling to
   a follow-up spec** and shipping a pure conversational loop first — confirm.

---

**Sources (turn-taking, barge-in, local-LLM latency):**
[LiveKit — Turn Detection: VAD, Endpointing, Model-Based](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection) ·
[FutureAGI — Voice AI Barge-In & Turn-Taking 2026](https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/) ·
[Sparkco — Optimizing Barge-in Detection 2025](https://sparkco.ai/blog/optimizing-voice-agent-barge-in-detection-for-2025) ·
[Softcery — Real-Time vs Turn-Based Voice Agents](https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture) ·
[daily.dev — Running LLMs Locally 2026 (Ollama/llama.cpp)](https://daily.dev/blog/running-llms-locally-ollama-llama-cpp-self-hosted-ai-developers/) ·
[QuantizeLab — vLLM vs llama.cpp vs Ollama Benchmarks](https://www.quantizelab.dev/articles/vllm-vs-llama-cpp-vs-ollama-benchmark-guide)
