# ElevenLabs-Parity Program — Implementation Spec

**Date:** 2026-06-12
**Status:** Proposed — derived from [discussion #346](https://github.com/debpalash/OmniVoice-Studio/discussions/346) and the research in [docs/competitive-analysis.md](../competitive-analysis.md) (PR #345)
**Owner:** debpalash

## Goal

Execute the #346 roadmap — feature parity with ElevenLabs on quality and freedom,
fully local — as a program of small PRs. Every work item below is grounded in a
spec or research section of `docs/competitive-analysis.md` (cited as **Spec N** /
**§RN** / **Action N**); this document adds sequencing, dependencies, and
acceptance criteria. Continuous-to-main per the constitution: no RC, no ceremony,
no version chatter.

## Shape: waves of independent PRs, dependency-aware

Same shape as the stabilization sweep: each item is one PR through the automated
review + security gate, bisectable, with its tests in the same PR. Waves order by
(a) prerequisite edges, (b) user-visible value per effort, (c) what the sentiment
research says users judge us on (install reliability, dub fit, dictation quality).

**Already shipped while this was being researched** (no PR needed):
Smart Fit Phase A — planner, fingerprints, generate path (#347, = Spec 1 first
half); timeline segment editor (#348); Scalar at `/docs` (#307).

## Wave 0 — rails and prerequisites

| PR | Item | Source | Effort | Why first |
|----|------|--------|--------|-----------|
| 0.1 | Docs-drift CI: daily inventory-vs-docs job, rolling single issue, auto-close on green. In-repo `docs/features.yaml` seeded from README feature grid + engine tables; checker self-test per `tests/scripts/test_validate_install_docs.py` pattern | Spec 9a | S | The program adds many docs; drift protection must precede them |
| 0.2 | **Consent-locked voice profiles**: `verified_own_voice` flag on profiles — set by a recorded consent-phrase flow; additive alembic migration; Settings + profile UI surface | Action 22, §R1 guardrail 2 | M | Hard prerequisite for agentic v2/v3 (1.6, later) and gallery sharing (3.4). Also the counter-story to voicebox's "no consent lock" press |
| 0.3 | LLM-judge eval tier in `tests/evals/` — Patter port (case/runner/assertions), judge via `llm_backend.py`, **non-gating** scheduled job, verdict recomputed locally | Spec 9b | M | Gives waves 1–2 (dictation refinement, dub QC) a semantic regression net as they land |

## Wave 1 — quick wins (independent; parallelizable)

| PR | Item | Source | Effort | Acceptance |
|----|------|--------|--------|------------|
| 1.1 | **Whisper-loop collapse pre-pass** in new `backend/services/refinement.py`, applied to finals in `capture_ws.py` (never partials) | Spec 3 phase 1 (voicebox port, MIT) | S | Hallucination-loop fixtures collapse; rhetorical repeats <6 survive; works with no LLM configured |
| 1.2 | **Chunked long-form TTS**: `backend/utils/chunked_tts.py` port; `max_chunk_chars`/`crossfade_ms` in request models; fix the known first-chunk-sample-rate bug at port time | voicebox deep dive 1 (MIT) | S | 10k-char input renders without ceiling; chunk seams pass probe DSP judges (not-clipping, no discontinuity); single-shot path unchanged |
| 1.3 | **pyvideotrans bridge**: file their integration bug, upstream a REST/OpenAI-style `_omnivoice.py` PR; add a contract test pinning whatever surface they consume | Spec 11 (Option A) | S–M | Contract test green; upstream PR open and linked |
| 1.4 | **Sentence chunker** for `/ws/tts`: `backend/services/sentence_chunker.py` (Patter port, MIT) + aggressive first-flush; golden parity scenarios as pytest fixtures | Spec 8a | S | TTFA measurably drops on multi-sentence input; Italian comma-guard cases pass |

## Wave 2 — dictation, agents, remote (the #346 headline surface)

| PR | Item | Source | Effort | Depends on |
|----|------|--------|--------|------------|
| 2.1 | **Dictation LLM refinement** phase 2: prompt builder + toggles via `llm_backend.py`; raw+refined persisted (alembic, additive); WS `{type:"final", refined_text?}`; auto-refine default ON only when an LLM backend is active (identical pass-through everywhere otherwise — parity rule) | Spec 3 | M | 1.1 |
| 2.2 | **MCP server v1**: mount existing FastMCP at `/mcp` (lifespan composition), `transcribe` tool with loopback gate, `X-OmniVoice-Client-Id` middleware + `mcp_client_bindings` table (alembic), stdio shim, Settings bindings UI | Spec 2 | M | — |
| 2.3 | **Remote backend rungs 1–3**: Backend URL setting + `/health` handshake; `OMNIVOICE_API_KEY` bearer on all non-loopback HTTP+WS (extend `NetworkAccessMiddleware`; token still required behind Tailscale Serve); `docs/remote-gpu.md` Tailscale page (MagicDNS + Serve + headscale note + "never Funnel without the key") | §R2 rungs 1–3 | M | — |
| 2.4 | **Remote LLM endpoint UI**: Settings fields (base URL, model, optional API key) feeding `llm_backend.py`; verified drop-in for Ollama/vLLM/LM Studio | §R2 rung 4 | S–M | — |
| 2.5 | **Agentic v1**: `docs/agentic-voice.md` (pipecat + LiveKit recipes against `:3900/v1`) + a pipecat smoke test in CI-optional lane; fix param/streaming mismatches it exposes | Action 15, §R1 v1 | S–M | 2.3 (remote auth story referenced by the docs) |

## Wave 3 — dubbing completion (what dub users judge us on)

| PR | Item | Source | Effort | Depends on |
|----|------|--------|--------|------------|
| 3.1 | **Smart Fit Phase B**: export-side video retime — per-segment cuts/slowdown via `ffmpeg_utils.py` (respect semaphore + `register_proc`), measured-duration subtitle regeneration before `dub_export.py`, last-frame freeze; thresholds (1.2× / 50-50) exposed in dub settings and added to fit fingerprints | Spec 1 remainder (Phase A shipped in #347) | M–L | — |
| 3.2 | **Per-segment clone refs**: `extract_segment_refs()` in `speaker_clone.py`, per-speaker fallback below the duration floor; mode in `_GEN_INPUT_FIELDS` | Spec 4 | S–M | — |
| 3.3 | **Second-pass ASR QC**: post-assembly stage — re-time cues from recognized boundaries, per-segment drift score (WER via `omnivoice/eval/wer/`), flags into job events + DubTab markers feeding incremental re-dub; opt-out, never fatal | Spec 5 | M | 3.1 (final timeline must exist first) |

## Wave 4 — platform robustness (the "first-run that actually works" dividend)

| PR | Item | Source | Effort |
|----|------|--------|--------|
| 4.1 | **Engine preflight compat gate**: capability (torch) + driver (NVML) detection → (engine × wheel-variant) table → specific pre-install errors; **loud persistent CPU-fallback banner** — never silent. Builds on `engine_env.py` probe + `hardware_probe.py` | Action 19, §R4(b) | M |
| 4.2 | **Crash-isolated ASR**: `SubprocessBackend` ASR subclass with respawn-on-death semantics; SIGKILL-mid-transcription test | Spec 7 | M |
| 4.3 | **Model manager UI**: `scan_cache_dir()`-backed page — per-model disk usage, evict, `hf cache verify`, mirror (`HF_ENDPOINT`) setting; handle Windows degraded-symlink mode and delete-vs-reader races | Action 20, §R4(c) | M |
| 4.4 | **MLX dictation routing**: route dictation/dub ASR through existing `MLXWhisperBackend` behind the hardened `import mlx.core` probe; backend-aware model-repo mapping in the registry | Spec 6 first slice | M |
| 4.5 | **uv dedupe + pin policy**: link-mode audit, `UV_LINK_MODE=hardlink` on Linux ext4, documented sidecar torch-pin-alignment policy | §R4(a) | S |

## Wave 5 — new verticals (audiobooks, personas, persona bot)

| PR | Item | Source | Effort | Depends on |
|----|------|--------|--------|------------|
| 5.1 | **Audiobook A1**: EPUB ingest (`zipfile`+`lxml` — **no ebooklib, it's AGPL**) + TOC chapterization + per-chapter resumable TTS queue | §R3 A1 | M | 1.2 |
| 5.2 | **Audiobook A2+A3**: chapterized m4b (FFMETADATA1 + cover) + ACX-spec mastering (two-pass loudnorm + astats verifier; "masters to ACX technical spec" framing only) | §R3 A2–A3 | S + S–M | 5.1 |
| 5.3 | **`.ovsvoice` export/import**: zip manifest + design params + `consent.json` + license tag + watermarked preview | Action 18, §R3 G1 | S–M | — |
| 5.4 | **Persona gallery**: community `gallery.json` index repo (PR-curated) + VoiceGallery "Community" tab + in-app submission via prefilled GitHub PR/issue; gates: designed/self-recorded only, consent attestation, AudioSeal preview watermark enforced at package time, takedown template | §R3 G2–G3 | M + M | 0.2, 5.3 |
| 5.5 | **Agentic v2 — Discord persona bot**: opt-in by construction (user's own bot token); text replies via LLM adapter + voice replies via `/v1/audio/speech`; persona bound to a consent-locked profile; live voice-channel as stretch (Pycord sinks / discord-ext-voice-recv, both MIT, maintenance risk flagged) | §R1 v2 | M–L | 0.2, 2.2 |
| 5.6 | **AEC for dictate-over-playback**: Patter NLMS port; far-end fed from `/ws/tts` (resampled), playout-time staleness clock; **Settings opt-in until probe-verified on all three platforms** (parity rule) | Spec 8b | M | 1.4 |

## Deferred (explicitly, not dropped)

- **Telephony (§R1 v3)** — gated on: guardrails 1–5 shipped (0.2 is only one of
  them), TTFA spike vs the ~600 ms p95 budget, AudioSeal-through-G.711 spike.
  Opt-in carrier credentials by design; never a default.
- **Stories multi-track frontend** (voicebox deep dive 5) — data model is S, the
  timeline UI is the real cost; #348's segment editor is the seed. Revisit after
  5.1–5.2 prove the long-form vertical.
- **Weighted voice mixing (Action 12), dynamic engine lifecycle (Action 13),
  LM-Studio-style runtime packs (§R4 d)** — valuable, not load-bearing for #346.
- **OpenAPI hygiene (Action 21)** — incremental background work; `/v1` + TTS
  routes first, no dedicated wave.
- **Positioning kit (Action 14)** — no-code; execute opportunistically
  (comparison page pairs well with 3.1's demo GIF; Show HN after wave 1 lands).

## Cross-cutting rules

- Constitution: continuous-to-main, no RC, no version chatter; backward-compat
  (no engine reinstall; alembic for every schema change — 0.2, 2.1, 2.2 all carry
  migrations; `omnivoice_data/` untouched).
- **Default-feature parity**: anything default-on behaves identically on
  macOS/Windows/Linux. Items that can't yet (5.6 AEC) ship behind explicit
  opt-in. Implementation-level divergence (4.4 MLX) is allowed.
- **License discipline**: MIT/Apache ports carry attribution headers
  (voicebox, Patter, ebook2audiobook, Kokoro-FastAPI). **Never copy** GPL
  (pyvideotrans, KrillinAI, voice-pro, ComfyUI, `mobi`) or third-party AGPL
  (alltalk_tts, StabilityMatrix, **ebooklib**, PyMuPDF) — clean-room from the
  specs in competitive-analysis.md; implementers do not open those sources.
- **Local-first**: no required cloud calls; Patter code embedded anywhere must
  have its telemetry hard-disabled; bug reporter stays opt-in prefilled-URL.
- i18n: all new UI strings through `t('...')`; no hardcoded CJK (CI gate).
- Each PR ships its tests (unit + probe-judge additions where audio is
  produced); green CI before merge.
- **Regulatory clock**: EU AI Act Art 50 applies 2026-08-02 — agentic output
  marking (AudioSeal always-on for agentic paths) and AI-disclosure land *with*
  the features that trigger them (5.5), not as follow-ups.

## Per-item workflow

speckit per PR (specify → plan → tasks → implement), seeded from the item's
Spec/§R section in `docs/competitive-analysis.md` — those sections already
contain integration points, design deltas, constants, and test plans.
