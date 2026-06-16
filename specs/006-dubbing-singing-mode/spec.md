# Feature Specification: Dubbing Singing / Music Mode

**Feature Branch**: `006-dubbing-singing-mode` | **Created**: 2026-06-14
**Status**: Investigation complete — model selected, awaiting spike (Phase 1) sign-off
**Input**: User request "music/singing mode for dubbing"; supersedes [`.planning/decisions/SPIKE-02-singing.md`](../../.planning/decisions/SPIKE-02-singing.md)
**Related**: ROADMAP Phase 4 (specialty engines); TODO #312 (`dub_generate.py` engine-awareness)

## Problem

When OmniVoice dubs sung/musical source content, the pipeline routes the vocal
through a **speech** TTS engine — it produces flat spoken output over what was a
song. This is one of the loudest complaints on music-adjacent dubs. The pipeline
already runs Demucs (`backend/services/dub_pipeline.py:798`) and produces a
`vocals.wav` (sung performance) + `no_vocals.wav` (instrumental) — **then discards
both** and re-synthesizes from scratch, throwing away the melody the user wants
preserved.

The hard requirement for *singing dubbing* (vs. generic "expressive TTS") is
**melody preservation**: the translated lyrics must follow the original song's
pitch/rhythm. That requires an engine that accepts an **F0 contour or MIDI** as a
conditioning input. Generic singing-styled TTS that sings its *own* random melody
does not solve dubbing.

## Candidate evaluation

Three HuggingFace repos were cloned (metadata-only) and evaluated against the dub
pipeline on 2026-06-14.

| Criterion | **A. Soul-AILab/SoulX-Singer** | **B. mlx-community/SoulX-Singer** | **C. ModelsLab/omnivoice-singing** |
|---|---|---|---|
| Type | Zero-shot **SVS (synth) + SVC (conversion)** | MLX repack of A | Expressive **TTS** w/ `[singing]` tag |
| **Melody conditioning** | ✅ **F0 contour + MIDI** (required for dubbing) | ✅ same weights | ❌ **none** — style tag only |
| Architecture | Flow-matching DiT, 22 layers / 1024-hidden, 128-mel, 24 kHz (`config.yaml`) | bf16/8/4-bit safetensors, 11+11 shards | Qwen3-0.6B + HiggsAudioV2 codec, 24 kHz |
| Languages | EN + CN | EN + CN | 11 langs |
| License | **Apache-2.0, clean** (weights + code) | Apache-2.0 (inherits A) | Apache-2.0 code, **trained on CC BY-NC-SA / CC BY-NC data → non-commercial taint propagates** |
| Cross-platform | ✅ CUDA / MPS / CPU (PyTorch) | ❌ **Apple-Silicon only**; "not pure MLX" — still needs a PyTorch bridge | ✅ CUDA / MPS / CPU |
| Packaging | raw `model.pt` (2.7 GB) + `model-svc.pt` (2.7 GB) + separate `SoulX-Singer-Preprocess` repo; conda py3.10; inference is `bash example/infer.sh` (no pip pkg, no library API) | safetensors shards + external bridge repo | drop-in `OmniVoice.from_pretrained()`, 2.3 GB + 0.77 GB codec |
| Download | ~5.3 GB + Preprocess repo | ~2.6 GB (bf16) | ~3.1 GB |
| Sample rate | 24 kHz (matches our default) | 24 kHz | 24 kHz |

### Verdict

- **A. SoulX-Singer (PyTorch) — SELECTED.** The only candidate that can
  follow the source melody (F0/MIDI input), the only one with a clean Apache-2.0
  that is safe to ship default-eligible, cross-platform, 24 kHz = matches our
  pipeline. Inference is script-shaped with its own conda deps + a second
  Preprocess repo, so it must run as a **subprocess sidecar** (the
  `backend/engines/indextts` pattern), not in-process.
- **B. MLX repack — DECLINED as a runtime, ADOPTED as the reference CLI.** The
  weights pip-install `mlx` (Apple-only) and the repo is "not a pure MLX runtime"
  (compute still bridges to PyTorch), so it is no faster today and can't be our
  cross-platform engine. **But** its bridge entrypoint
  [`ailuntx/SoulX-Singer-MLX`](https://github.com/ailuntx/SoulX-Singer-MLX)
  `scripts/inference_mlx_bridge.py` is a clean argv CLI — `--component svs|svc`,
  `--control melody`, `--device mps|cpu|cuda`, explicit F0 `.npy` I/O, bundled
  Whisper for transcription-free prep — far better-shaped for a sidecar than the
  original repo's opaque `bash example/infer.sh`. **Plan-06 wraps SoulX's own
  inference modules using the param shape this bridge documents**, on Apple
  through MPS and on Win/Linux through PyTorch CUDA/CPU, with no hard `mlx`
  dependency.
- **C. omnivoice-singing — DECLINED** (deep-verified 2026-06-14, repo cloned).
  Disqualified for dubbing on four concrete points:
  1. **No melody control of any kind.** `[singing]` is plain text the LM reads —
     0 added/special tokens, and no pitch/F0/melody/note dimension anywhere in
     `config.json` or the codec config. It generates its *own* melody; it cannot
     follow the source song (fails SING-R1).
  2. **Codec can't do music by design.** Model card: HiggsAudioV2 tokenizer is
     "speech-domain tuned… Music / drum content is **not supported by design**."
  3. **Light EN-only nursery finetune.** `[singing]` = GTSinger English only,
     6,755 clips / ~8 h, eval loss ~4.74–4.88, "nursery-style melodic vocals."
  4. **Non-commercial taint on the singing capability itself.** Apache-2.0 code,
     but `[singing]` derives from GTSinger **CC BY-NC-SA 4.0 (research use)** and
     emotion tags from RAVDESS/Expresso (CC BY-NC) — "downstream users must
     comply." Shipping it into a commercially-used tool is a license landmine.

  Its one strength is being a true drop-in (`OmniVoice.from_pretrained`, same arch
  as our base, 0 new deps) — but that serves a *different* feature (an expressive
  + nursery-singing **standalone-TTS toggle**), not music dubbing. **This reverses
  SPIKE-02**, which chose C on 2026-05-18 before SoulX-Singer existed — see
  Supersession note below.

## SVS vs SVC — two capabilities, one model family

SoulX ships two checkpoints with different dub roles. They are **not**
interchangeable:

| | **SVS** (`model.pt`, synthesis) | **SVC** (`model-svc.pt`, conversion) |
|---|---|---|
| Operation | translated lyrics + source F0 → new sung vocal | source vocal → re-timbred vocal (audio→audio) |
| Translates language? | ✅ yes — the dubbing path | ❌ no — keeps source lyrics/language |
| Inputs | lyrics (transcribe→translate) + F0 + ref voice | source audio + F0 `.npy`; **transcription-free, no MIDI** |
| Language coverage | EN / CN only | **language-agnostic** (works for any of 646) |
| Dub role | **cross-language song dubbing** (the core ask) | restyle/clone the singer; same-language; polish SVS output |

**Implication:** only **SVS** satisfies "dub a song into another language"
(SING-R1). **SVC** is a distinct, adjacent capability — it removes the EN/CN limit
and the transcription brittleness, but it cannot change the lyrics' language. Two
ways it pays off: (1) a same-language "convert the singer's voice" feature, and
(2) an **SVS→SVC chain** where SVC unifies/cleans the SVS output timbre.

## v1 scope decision

Goals tracked: **G1** cross-language song dub (the literal ask) · **G2** all-646
language coverage · **G3** melody preserved · **G4** timbre/voice control · **G5**
robustness (transcription-free, no brittle ASR+MT) · **G6** small download/compute
· **G7** fast ship / small dev surface.

| Option | Pros | Cons | Goals achieved |
|---|---|---|---|
| **A. SVS-only** ✅ *recommended* | Matches the literal "dub a song into another language" ask; smallest scope; one checkpoint (~5.3 GB); SVC drops in later with **no rework** (sidecar already exposes `--component svc`) | EN/CN only; depends on transcribe→translate→F0 chain quality | **G1, G3, G7** (partial G6) |
| **B. SVS + SVC chain** | Best output quality (SVC timbre-unifies the SVS vocal); both capabilities in one release | ~2× download (~10 GB) + 2× compute; slowest; largest surface; gated on *both* models passing the spike | **G1, G3, G4** (fails G6, G7) |
| **C. SVC-first** | All-646 coverage now; transcription-free + robust; ships a usable "restyle the singer" feature fast | **Does not translate** → fails the core dub ask; "singing *dub* mode" that can't change language is self-contradictory | **G2, G3, G4, G5** (fails **G1**, G7) |

No option hits every goal; **G1 (cross-language dub) is the original request and only
A and B deliver it.** None of the three is foreclosed by another — the sidecar's
`--component` switch makes A→B→C additive, not mutually exclusive.

**Decision: ship Option A (SVS-only) as v1** — the smallest change that satisfies the
literal ask (G1). **SVC becomes Phase 5**, a fast-follow adding G2/G4/G5 with no
architecture change. Option C is rejected as v1 because a singing *dub* mode that
can't change language contradicts the feature's intent.

## Requirements

- **SING-R1 (melody preservation):** Dubbed sung segments MUST follow the source
  song's pitch/rhythm, derived from an F0 contour extracted from the Demucs
  `vocals.wav` stem.
- **SING-R2 (instrumental preservation):** The Demucs `no_vocals.wav` stem MUST
  be mixed back under the synthesized vocal, untouched.
- **SING-R3 (explicit opt-in mode):** Singing mode is a per-dub mode
  (`tts_mode: "singing"`), never a silent default. SoulX is EN/CN-only, so the
  language coverage diverges from the 646-lang speech default — it MUST be gated
  + labeled, satisfying the "platform/feature parity or opt-in" rule.
- **SING-R4 (sidecar isolation):** The engine runs as a `SubprocessBackend`
  sidecar in its own py3.10 venv; zero new deps leak into the parent env.
- **SING-R5 (license gating):** First-use download surfaces the SoulX Apache-2.0
  license + model-card link and gates the ~5.3 GB download behind acceptance.
- **SING-R6 (cross-platform):** Engine + F0 extraction work identically on
  macOS / Windows / Linux (PyTorch CUDA/MPS/CPU). No platform-only behavior in
  the default path.
- **SING-R7 (singable lyrics):** Translated lyrics MUST align to the source
  melody's syllable/note budget before synthesis. v1 ships at minimum a
  best-effort syllable-budget pass; if SoulX-SVS auto-aligns free text (Phase 1
  finding) this is a no-op. Output that relies on raw MT MUST be labeled
  experimental. Full singable translation (rhyme/meter) is deferred.

## Pros / Cons (selected approach)

**Pros**
- Solves the actual complaint: sung source → sung output that matches the tune.
- Reuses ~70% of existing infra — Demucs stems are already produced and discarded.
- Clean Apache-2.0; no commercial-use landmine.
- Sidecar isolation = no risk to the parent env or other engines.
- 24 kHz parity with the existing dub mixing path.

**Cons / risks**
- EN/CN only → mode is gated, not universal (acceptable; it's opt-in).
- No pip package — sidecar wraps the repo's `infer.sh`-shaped scripts; more glue
  than a library engine.
- Two model artifacts (SVS 2.7 GB + optional SVC 2.7 GB) + Preprocess repo =
  larger download than other engines.
- F0-extraction quality on noisy/poly vocals bounds output quality; Demucs
  bleed-through is the upstream risk.

## Cost summary

| | Estimate |
|---|---|
| Disk (user, first use) | ~5.3 GB SVS weights + Preprocess repo (gated, opt-in) |
| VRAM | TBD by Phase 1 spike (flow-matching DiT @ 1024-hidden; budget ~4–6 GB, CPU fallback expected) |
| New parent deps | **0** (isolated in sidecar venv) |
| Dev effort | ~Phases 1–4 below; spike is the gating de-risk |

## Out of scope

- Per-*segment* singing/speech auto-routing (defer; mode applies per-dub job in v1).
- SVC path is **deferred to Phase 5**, not cut — v1 ships SVS only.
- The MLX runtime (option B) as an engine; its bridge CLI is still used as the
  reference param shape.
- **Lip-sync to video.** The singer's mouth won't match the dubbed audio (standard
  dub limitation, more visible in close-ups). No visual re-sync in scope.
- Full singable translation (rhyme, meter, prosody) — v1 is syllable-budget only.
- A general "expressive TTS" `[singing]`-tag toggle (option C) — separate feature.

## Supersession note

This spec **supersedes `.planning/decisions/SPIKE-02-singing.md`** (Proposed,
2026-05-18), which selected `ModelsLab/omnivoice-singing`. That decision predated
SoulX-Singer (arXiv 2602.07803) and optimized for "zero new deps / ≤30-line
subclass" — but the chosen model has **no melody conditioning**, so it cannot
satisfy SING-R1 (the core of *dubbing* singing). SPIKE-02 remains valid only if
the goal is reframed as expressive-TTS styling rather than melody-matched dubbing.
