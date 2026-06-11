# Competitive Analysis — voicebox · pyvideotrans · Patter

*Compiled 2026-06-11 from four parallel research passes (one per competitor repo + a
full feature-surface inventory of this codebase). Star counts and versions are
as-of-date snapshots. OmniVoice grades (A–D) come from the self-inventory: code
signals, test coverage, TODO density, and open-issue mentions — not marketing.*

## TL;DR

| | [voicebox](https://github.com/jamiepine/voicebox) | [pyvideotrans](https://github.com/jianchang512/pyvideotrans) | [Patter](https://github.com/PatterAI/Patter) |
|---|---|---|---|
| What | Local-first voice studio (ElevenLabs + WisprFlow alt) — **our most direct competitor** | Desktop video translate/dub pipeline (GUI + CLI) | Telephony voice-agent SDK (self-hosted Vapi/Retell alt) — adjacent, not competing |
| Stack | Tauri v2 + React + FastAPI (same as us) | PySide6 (Qt) + FFmpeg, 100 % Python | Python + TS dual SDK |
| Maturity | v0.5.0, ~29.7k★, fast cadence, beta-grade hardware backlog | V4.01, ~17.9k★, 2.5 yrs mature, monthly releases | v0.6.x, ~511★, 2 months old, exceptionally well-engineered |
| License | **MIT** | **GPL-3.0** | **MIT** |
| Code reuse for us | ✅ **Port directly** (keep MIT attribution header) | ⚠️ **Reimplement ideas only — never copy** | ✅ **Port directly** (keep MIT attribution header) |

**License ground rule.** OmniVoice Studio is **AGPL-3.0-only with a commercial
dual-license offering**. MIT code can be incorporated (attribution preserved) and
stays compatible with selling commercial exceptions. GPL-3.0 code is technically
combinable with AGPL-3.0 (GPLv3 §13), **but** copied GPL files stay GPL-3.0 forever
under the original author's copyright — which would break the commercial-license
model (we can only sell exceptions for code we own). So pyvideotrans is a
*design-document*, not a code source: study `_rate.py`, write our own.

Fun fact discovered en route: **pyvideotrans already integrates OmniVoice Studio as
a first-class TTS/clone backend** (`videotrans/tts/_omnivoice.py`, via our Gradio
API). We are upstream for 17.9k-star project users. Action item below.

---

## Big feature matrix

Legend — **Us**: A–D maturity grade from the self-inventory. **Them**: ✅ stable ·
🟡 beta/partial · ❌ absent. *(bold = they beat us; this is the gap list)*

| Capability | Us | voicebox | pyvideotrans | Patter | Notes |
|---|---|---|---|---|---|
| **Generation & cloning** |
| Zero-shot voice cloning | B | ✅ | ✅ (via clone-TTS engines) | ❌ | Parity; their multi-sample profiles are slightly ahead |
| Preset voice library (no reference audio) | B+ (20+ archetypes) | ✅ **50+ presets** (Kokoro/Qwen) | ❌ | ❌ | They win on count, we win on curation + degenerate-check |
| Voice design from text description | B | 🟡 (personality descriptors) | ❌ | ❌ | We're ahead (#317 shipped a deterministic mapper) |
| **Unlimited-length generation (chunk + crossfade)** | ❌ (no auto-chunking) | ✅ `chunked_tts.py` | ✅ (per-subtitle by design) | ❌ | **Gap.** Their crossfade chunker removes the length ceiling |
| Paralinguistic tags (`[laugh]`, `[sigh]`) | ❌ | ✅ (Chatterbox Turbo) | ❌ | ❌ | Engine-dependent; we'd get it by adding Chatterbox Turbo |
| Delivery instructions ("whisper", "slowly") | B (instruct field) | ✅ (Qwen NL control) | ❌ | ❌ | Parity-ish |
| Generation queue w/ cancel + SSE | B+ (job store, SSE replay) | ✅ | ✅ (9-queue pipeline) | n/a | Parity; our SSE reconnect-replay is ahead of voicebox |
| Post-processing FX chain (reverb/pitch/comp) | B (effect chain exists) | ✅ **Pedalboard, per-profile presets** | ❌ | ❌ | Theirs is richer + has preset UX |
| Multi-track timeline editor (stories/podcasts) | ❌ | ✅ **Stories editor (v0.5.0)** | ❌ | ❌ | **Gap** — also the #280-item-3 timeline ask |
| Audio watermarking (AudioSeal) | B | ❌ | ❌ | ❌ | **We're unique here** |
| **Dubbing pipeline** |
| Full video dub (ASR→translate→TTS→mux) | A– | ❌ | ✅ (1200-line battle-tested pipeline) | ❌ | Two-horse race; we're competitive |
| Incremental re-dub (change 1 line, regen 1 segment) | A– (#281 fixed) | ❌ | ❌ | ❌ | **We're unique here** |
| **Dub-length fitting (audio speedup + video slowdown)** | C (onset snap #280, speed adapt) | ❌ | ✅ **`_rate.py` — the crown jewel** | ❌ | **Biggest algorithmic gap.** See Action 1 |
| Vocal/BGM separation + re-mix | A– (Demucs 4-stem) | ❌ | ✅ (UVR/Spleeter ONNX) | ❌ | Parity; their ONNX models are lighter than Demucs |
| **Clone refs cut from separated vocals per segment** | 🟡 (speaker_clone refs 5–15 s/speaker) | ❌ | ✅ per-subtitle-line refs | ❌ | Their per-line granularity beats our per-speaker. Action 4 |
| Speaker diarization → multi-voice dub | B+ (pyannote) | ❌ | ✅ (4 backends incl. CAM++) | ❌ | Parity; their backend choice is wider |
| **Second-pass ASR on dubbed audio** (regenerate exact subtitle timings) | ❌ | ❌ | ✅ | ❌ | **Gap** — clever QC step. Action 5 |
| Subtitle styling / burn-in / dual-language | A– (#309 fixed) | ❌ | ✅ | ❌ | Parity |
| Batch processing (N videos) | B (50-job queue) | ❌ | ✅ (wave control, multi-GPU scaling) | ❌ | Their `batch_nums` waves + per-GPU thread scaling is ahead |
| Translation channel breadth | B (LLM 3-step chain + glossary) | ❌ | ✅ **~25 channels** | ❌ | Breadth vs depth: our reflect/adapt chain is deeper, their coverage wider |
| Translation caching + line-count validation | 🟡 (fingerprints #281) | ❌ | ✅ MD5 cache + timeline re-match | ❌ | Worth studying |
| **Dictation** |
| Global-hotkey dictation pill | B+ (#323 fixed) | ✅ (v0.5.0, auto-paste **macOS-only**) | ❌ | ❌ | We're ahead on cross-platform (their gap violates our parity rule) |
| **LLM transcript refinement (filler-word removal)** | ❌ | ✅ local Qwen3 0.6B–4B | ❌ | ❌ | **Gap.** Action 3 |
| **Captures library (replay / re-transcribe / refine)** | 🟡 (transcription history page) | ✅ richer (v0.5.0) | ❌ | ❌ | Partial gap — we store, they iterate |
| Dictation while audio plays (echo cancel) | ❌ | ❌ | ❌ | ✅ NLMS AEC | Patter's AEC is portable. Action 8 |
| **Engines & platform** |
| TTS engine count | B (6) | ✅ 7 | ✅ **33 channels** (22 ASR, 25 translate) | ✅ 7 (cloud) | pyvideotrans = breadth king (incl. cloud); we + voicebox are local-only by design |
| Engine plugin protocol | B+ (ABC + registry) | ✅ Protocol + ModelConfig registry, **agent skill for adding engines** | ✅ lazy dataclass plugins | ✅ provider SDK | Everyone converged on the same pattern; their `requires_cuda`-gap lesson is free for us |
| **MLX runtime on Apple Silicon** | 🟡 (MLX-Audio engine only) | ✅ **MLX for TTS+STT, 4–5× claimed** | ❌ | ❌ | **Gap** — dual-runtime per engine. Action 6 |
| **CUDA binary auto-download (small installer)** | ❌ (venv on first run ships everything) | ✅ in-app CUDA swap incl. sm_120 | ❌ | ❌ | Different bootstrap philosophy; their #1 bug source too. Study only |
| Crash-isolated engine subprocesses | 🟡 (Demucs/ffmpeg subprocesses) | ❌ | ✅ (whisper.cpp etc. in child procs) | ❌ | Their JSON-log polling pattern is a cheap stability win. Action 7 |
| ROCm support | A– (with edge cases) | 🟡 (large breakage backlog) | 🟡 | n/a | We're ahead |
| **Integration surface** |
| OpenAI-compatible API | B+ | ✅ REST | ❌ | n/a | Parity |
| **MCP server (agent speaks in your voice)** | C+ (`docs/mcp.json` basic) | ✅ **FastMCP at `/mcp` + stdio shim, per-agent voice binding** | ❌ | ✅ (client + server) | **Gap** — theirs is a genuine UX novelty. Action 2 |
| Web/Docker deployment | B– (headless image exists) | ✅ (`docker compose up`) | ❌ (desktop only) | ✅ | Parity-ish; our :latest/:stable retag (PR #338) helps |
| CLI / headless batch | 🟡 (API only) | ❌ | ✅ `cli.py` (stt/tts/sts/vtv) | ✅ | Partial gap for power users |
| Streaming TTS (websocket, low TTFA) | C+ (`/ws/tts` experimental) | ❌ | ❌ | ✅ **sentence-chunked streaming, first-flush** | Patter's chunker + first-flush are portable. Action 8 |
| **Ops & quality discipline** |
| Eval harness for output quality | ❌ | ❌ | ❌ | ✅ LLM-judge evals + CLI | Portable as dub/TTS regression harness. Action 9 |
| **Docs-drift CI** | ❌ (smoke-test idea in CLAUDE.md) | ❌ | ❌ | ✅ daily inventory-vs-docs diff job | Directly solves our stated docs-drift concern. Action 9 |
| Model-evaluation decision log | 🟡 (ROADMAP phases) | ✅ `PROJECT_STATUS.md` accepted/abandoned log | ❌ | ❌ | Cheap practice to adopt |
| Telemetry design (consent-bounded) | n/a (opt-in GH Issues only) | ❌ | ❌ | ✅ consent module, bucketed values | Reference design if bug-reporting ever grows |

### Where we are unique (defend these)

- **Incremental re-dub** with fingerprint tracking — nobody else has it.
- **646-language claim** via OmniVoice model — voicebox tops out at 23, pyvideotrans is engine-dependent.
- **AudioSeal watermarking + detection** — unique among all three.
- **Cross-platform dictation as a default** (their auto-paste is macOS-only).
- **3-step LLM translation chain (translate → reflect → adapt) + glossary** — deeper than anyone's single-pass.

---

## Ranked actions

Effort: S < 1 day · M = 1–3 days · L = 1–2 weeks. "Port" = copy + adapt MIT code
with attribution header. "Reimplement" = clean-room from the description above /
their docs — **do not open pyvideotrans source files while writing ours**.

| # | Action | From | Mode | Effort | Why now |
|---|---|---|---|---|---|
| 1 | **Dub-length fitting v2**: extend each segment's end to the next segment's start (absorb silence slack) → if speedup ≤ 1.2× stretch audio only (pitch-preserving, rubberband) → else split burden ~50/50 with video `setpts` slowdown per segment → regenerate subtitle timeline from actual dub durations → pad/freeze last frame for ms drift | pyvideotrans `_rate.py` design | **Reimplement** | L | Our #280 onset-snapping is a band-aid; this is the algorithm that makes dubs *fit*. Highest user-visible quality win available |
| 2 | **MCP server v1**: FastMCP mounted on the existing FastAPI at `/mcp` + stdio shim; tools `speak`, `transcribe`, `list_profiles`; per-agent voice binding | voicebox `backend/mcp_server/`, `mcp_shim/` | **Port** | M | Our MCP grade is C+; theirs is the headline feature of v0.5.0. Agents-speak-in-your-voice is organic marketing |
| 3 | **Dictation refinement**: optional local small-LLM pass removing filler words/stutters before paste (we already have an LLM adapter layer — wire it to capture finals) | voicebox `services/refinement.py` | **Port** (adapt to our `llm_backend.py`) | M | Biggest dictation quality jump per line of code; WisprFlow's whole pitch |
| 4 | **Per-segment clone refs**: cut the voice-clone reference for each dub segment from the separated vocal track at that segment's timestamps (threadpool), instead of one 5–15 s ref per speaker | pyvideotrans `_create_ref_from_vocal()` idea | **Reimplement** | S–M | Prosody of each line matches its source line; cheap because Demucs stems + segment times already exist |
| 5 | **Second-pass ASR QC**: after dub generation, re-run ASR on the synthetic audio to regenerate exactly-timed subtitles (and flag segments whose recognized text drifts from the target text) | pyvideotrans pipeline stage | **Reimplement** | M | Turns subtitle timing from "trusted math" into "measured truth"; doubles as an automatic dub-quality check |
| 6 | **MLX runtime pass**: route Whisper + at least one TTS engine through MLX on Apple Silicon (we have MLX-Audio precedent; extend the pattern engine-by-engine) | voicebox `mlx_backend.py` pattern | **Port** pattern | L | M-series Macs are a huge slice of local-AI users; 4–5× claimed speedup |
| 7 | **Crash-isolated ASR subprocess**: run native-crashy engines (whisper.cpp class) in a child process reporting progress via polled JSON log file, so a segfault never kills the backend | pyvideotrans `BaseCon._new_process()` idea | **Reimplement** | M | Directly serves "first-run that actually works"; engine crashes become per-job failures |
| 8 | **Streaming polish kit**: sentence-aware chunker (abbreviation + multilingual punctuation) for `/ws/tts`, aggressive first-flush for TTFA, NLMS AEC so dictation works during playback | Patter `sentence_chunker.py`, `aec.py` | **Port** | M | Moves `/ws/tts` from C+ experiment toward production; AEC unlocks dictate-over-playback |
| 9 | **Quality rails**: (a) docs-drift CI — daily job diffing a canonical feature inventory against docs, auto-files an issue; (b) LLM-judge eval harness as a dub-regression suite | Patter `docs-feature-drift.yml`, `evals/` | **Port** | S + M | (a) solves CLAUDE.md Capability 5 verbatim; (b) gives the dub pipeline what CI gives the code |
| 10 | **Practice adoptions** (no code): `PROJECT_STATUS.md`-style engine decision log; `requires_cuda`-style platform-gating flag in our engine registry (pre-empt voicebox's top bug class); add Chatterbox Turbo to the engine roster for paralinguistic tags | voicebox | n/a | S each | Cheap, compounding |
| 11 | **Verify pyvideotrans's OmniVoice integration** (`videotrans/tts/_omnivoice.py`) still matches our current API; if it broke, file a friendly PR upstream | pyvideotrans | n/a | S | 17.9k★ project routing users to us — keep that bridge healthy |

### Explicitly not recommended

- **Copying any pyvideotrans code** — GPL-3.0 files would stay GPL under their
  author's copyright inside our AGPL tree and break the commercial dual-license.
  Ideas are fair game; code is not.
- **Cloud TTS/ASR/translate channel breadth** (pyvideotrans's 33/22/25) — violates
  the local-first constraint. Our breadth play is local engines only.
- **voicebox's CUDA-binary-swap bootstrap** — their own top bug category
  (stale-binary detection); our uv-venv bootstrap is healthier. Study the failure
  mode, don't adopt.
- **Patter's telephony stack** — different product. Only the audio/streaming/ops
  pieces above are relevant.

---

## Appendix: engine evaluation — ResembleAI Chatterbox (2026-06-11)

**Verdict: integrate later — not now.** Full facts verified against the HF cards,
GitHub pyproject, and PyPI (0.1.7, 2026-03-26).

- **License: clean.** MIT on code *and* all three weight variants (original 0.5B EN,
  Multilingual 23-lang, Turbo 350M) — compatible with our AGPL + commercial
  dual-license. The "Resemble uses special weight terms" worry did not materialize.
- **What it would add:** Turbo's inline paralinguistic tags (`[laugh]`, `[cough]`,
  `[chuckle]`) and the single-knob `exaggeration` expressiveness control — genuinely
  unique in our roster. Fast English cloning (cloning + speed is a gap; KittenTTS is
  fast but can't clone). The 23-lang multilingual cloning is **not** differentiating
  for us (OmniVoice 646, VoxCPM2 30 @ 48 kHz).
- **Why not now:**
  1. `chatterbox-tts` hard-pins `torch==2.6.0` + `transformers==5.2.0`; we constrain
     `torch==2.8.0` and require `transformers>=5.3.0` — **unresolvable in the parent
     venv**, forcing a dedicated-venv sidecar (IndexTTS2 pattern, ~800–1000 LOC) that
     downloads a *second multi-GB torch*. The disk/download cost is the price, not
     the code.
  2. `resemble-perth` (its built-in PerTh watermarker) is a **git-URL dependency** —
     unmirrorable on restricted networks, against our bootstrap story. Also untested
     interaction: PerTh + our AudioSeal = double watermarking.
  3. MPS is buggy upstream (float64 conversion crash on Turbo; placeholder-storage
     errors); honest Apple-Silicon support means carrying community patches. Mac-ARM
     users already get Chatterbox today via our MLX-Audio curated list
     (`mlx-community/Chatterbox-TTS-4bit`).
- **Cheapest path / re-eval triggers:** ResembleAI publishes official
  [chatterbox-turbo-ONNX](https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX)
  exports. If a 1-day spike proves it runs on plain `onnxruntime`, Turbo slots into
  the lightweight supertonic3-style sidecar (~700 LOC, **no second torch**) and we
  get the paralinguistic tags cheaply. Also re-evaluate if upstream relaxes the
  torch/transformers pins or publishes `resemble-perth` to PyPI.
