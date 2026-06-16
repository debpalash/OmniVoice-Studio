# Implementation Plan: Dubbing Singing / Music Mode (plan-06)

**Branch**: `006-dubbing-singing-mode` | **Date**: 2026-06-14 | **Spec**: [spec.md](./spec.md)
**Decision**: **v1 = Option A (SVS-only)** — integrate **Soul-AILab/SoulX-Singer
(SVS, PyTorch)** as a `SubprocessBackend` sidecar; reuse Demucs stems for
F0-conditioned, melody-matched cross-language dub vocals. **SVC = Phase 5
fast-follow** (same sidecar, `--component svc`). Per-segment auto-routing deferred.
See spec "v1 scope decision" for the pros/cons/goals matrix.

## Summary

Singing dubbing needs melody preservation, which requires F0/MIDI conditioning —
only SoulX-Singer provides it. The pipeline already produces the inputs we need
(Demucs `vocals.wav` + `no_vocals.wav`) and throws them away. The work is: (1)
de-risk SoulX inference quality + VRAM in a spike, (2) wrap it as a sidecar, (3)
extract F0 from the existing vocal stem and mix output over the existing
instrumental stem, (4) expose an opt-in `tts_mode: "singing"` and route to it
(closing the hard-coded-`_model` TODO #312).

## Constitution Check

| Principle | Status |
|-----------|--------|
| I. Local-First | ✅ weights from HF, runs locally, no telemetry; license-gated download (SING-R5) |
| II. First-Run Works | ✅ default speech dub unchanged; singing is additive opt-in |
| III. Cross-Platform Parity | ✅ PyTorch CUDA/MPS/CPU; F0 extraction stdlib/torch — identical on all 3 OSes (SING-R6). EN/CN-only coverage is an explicit gated mode, not a divergent default (SING-R3) |
| IV. Backward-Compatible | ✅ new sidecar engine; no change to existing engines, models, or `omnivoice_data/`; no schema change |
| V. Root-Cause + Regression Tests | ✅ F0-extraction + mix-back + mode-routing unit tests; sidecar smoke test |
| Versioning | ✅ ships under v0.3.x rolling main |
| Docs-sync | ✅ `docs/dubbing.md` + engine card copy updated in the same PR that ships the mode |

## Architecture — reuse the stems we already pay for

```
dub_pipeline.py:798  Demucs ─┬─ vocals.wav  ──► F0 extract (SoulX Preprocess) ──┐
                             │                                                   ▼
                             │                 translated lyrics ──► SoulX-Singer SVS sidecar ──► vocal.wav
                             └─ no_vocals.wav ──────────────────────────────────────────────────┐
                                                                                          mix ◄──┘
                                                                                           │
                                                                                  dubbed sung track
```

Today both stems are produced and discarded. Singing mode keeps them: F0 from the
vocal stem conditions the synth; the instrumental stem is the bed.

## Phases

### Phase 1 — Spike (GATING; do before any integration)
De-risk the model before writing engine code.
- Pull SVS weights (`model.pt`, 2.7 GB) + `SoulX-Singer-Preprocess` repo.
- Run `example/infer.sh` on one clip: translated lyrics + an F0 contour extracted
  from a real dub `vocals.wav`. Confirm: output follows the melody, intelligible,
  acceptable artifacts.
- **Answer the alignment question (SING-R7):** does SVS auto-align free lyric text
  to the F0 contour, or does it require per-note aligned lyrics? This determines
  whether Phase 3 needs the syllable-budget pass — it is the single highest-risk
  unknown in the whole feature.
- Record **VRAM headroom** + latency on CUDA / MPS / CPU.
- **Flip spec Status → Accepted (or descope) based on the result.** A poor F0-match
  here kills the feature cheaply.

### Phase 2 — Sidecar scaffold
- New `backend/engines/soulx/` — `__init__.py` (`SoulXSingerBackend(SubprocessBackend)`,
  implements `venv_python()` + `sidecar_script()`) + `main.py` (stdlib-only at
  import; length-prefixed JSON IPC; lazy model load on first `synthesize` to stay
  inside the 30 s spawn window — per `subprocess_backend.py:59-150`).
- **Inference wrapper:** call SoulX's own inference modules using the param shape
  documented by `ailuntx/SoulX-Singer-MLX`'s `scripts/inference_mlx_bridge.py`
  (`--component svs|svc`, `--control melody`, `--device`, F0 `.npy` I/O) — that
  CLI is the reference contract; we do **not** depend on the `mlx` pip package
  (Apple-only). Device resolves to MPS on Apple, CUDA/CPU elsewhere (SING-R6).
- Own py3.10 venv (SoulX pins conda py3.10); zero parent-dep leakage (SING-R4).
- Register in `_LAZY_REGISTRY` (`tts_backend.py:1065`) + install hint
  (`tts_backend.py:1159`). Set `sample_rate=24000`, `supported_languages=["en","zh"]`,
  `gpu_compat=("cuda","mps","cpu")`.
- Model manifest: add SoulX-Singer (+ Preprocess) to `config/models.yaml`
  (`required: false`, license-gated per SING-R5).

### Phase 3 — F0 + singable lyrics + mix-back in the dub pipeline
- In `dub_pipeline.py`, surface `vocals.wav`/`no_vocals.wav` paths to the generator
  (currently dropped after Demucs, ~L823).
- Extract F0 from `vocals.wav` via the SoulX Preprocess models; pass as a sidecar
  `synthesize` param (SING-R1).
- **Singable-lyrics step (SING-R7 — the make-or-break):** the translated lyrics
  must align to the source melody's syllable/note count, or words won't slot onto
  notes. v1 approach depends on what Phase 1 finds:
  - **If SoulX-SVS auto-aligns** free lyric text to the F0 contour → feed
    translated text directly; no extra work.
  - **If SoulX needs per-note aligned lyrics** → v1 ships a **best-effort
    syllable-budget pass** (constrain/pad the MT output toward the source syllable
    count) and labels output "experimental"; full singable-translation (rhyme,
    meter) is explicitly deferred. **Do not ship pretending generic MT is singable.**
- Mix synthesized vocal over `no_vocals.wav` instead of discarding it (SING-R2).
- **Video:** no new work — the resulting audio track flows through the existing
  dub video remux (`dub_export.py`); singing mode only swaps the audio.

### Phase 4 — Opt-in mode + routing (closes TODO #312)
- `schemas/requests.py`: add `tts_mode: Optional[str] = "speech"` to `DubRequest`.
- `dub_generate.py:198-260`: when `tts_mode=="singing"`, route to the SoulX sidecar
  via `get_active_tts_backend()`-style selection instead of the hard-coded `_model`
  singleton (this is exactly the TODO #312 cleanup).
- `frontend/src/pages/DubTab.jsx`: add a mode toggle (mirror the existing
  translation-engine picker at ~L232-259). Gate visibility / show EN-CN-only +
  license note. All strings via i18n (`locales/*.json`).

### Phase 5 — SVC fast-follow (post-v1, no rework)
- Same sidecar, `synthesize(component="svc")`; download `model-svc.pt` (2.7 GB,
  opt-in). Adds: same-language "convert the singer's voice" for all 646 langs
  (G2/G4/G5) and an optional SVS→SVC polish pass. No engine/architecture change —
  only a `component` param + a second gated weight in `config/models.yaml`.

## Cost / effort

| Item | Cost |
|---|---|
| User disk (opt-in) | ~5.3 GB SVS + Preprocess repo |
| Parent deps added | 0 (sidecar-isolated) |
| VRAM | measured in Phase 1; budget ~4–6 GB w/ CPU fallback |
| Dev surface | 1 new engine dir, `config/models.yaml` entry, `dub_pipeline.py` stem-reuse, `DubRequest` field, `dub_generate.py` route, DubTab toggle + i18n keys, `docs/dubbing.md` |
| Risk concentration | Phase 1 (F0-match quality) and Demucs vocal-stem cleanliness |

## Tests

- `tests/test_soulx_sidecar.py` (top-level — avoids the `tests/backend/`
  sys.modules-isolation collection leak): sidecar handshake (ready/ping/synthesize/
  shutdown), F0-param passthrough, EN/CN language gating, `unload()` idempotency.
  Use `asyncio.run()` per test, not `get_event_loop()`.
- F0-extraction + mix-back unit tests (deterministic fixture vocal stem).
- Mode-routing test: `tts_mode="speech"` unchanged; `"singing"` hits the sidecar.
- Frontend vitest: DubTab mode toggle gating + i18n.
- Gate is `typecheck:ci` (`tsc --noEmit --checkJs false`), full backend + frontend
  suites green before merge.

## Open questions (resolve in Phase 1)

1. Does SoulX accept an externally-extracted F0 directly, or does its Preprocess
   pipeline require the *source* audio (forcing us to feed it the vocal stem)?
2. VRAM ceiling on 4–6 GB GPUs — is CPU fallback latency tolerable for a dub job?
3. ~~SVC scope~~ **RESOLVED** — v1 = SVS-only (Option A); SVC is Phase 5. See spec
   "v1 scope decision".

## Out of scope (carried from spec)

Per-segment singing/speech auto-routing; MLX Mac accelerator; `omnivoice-singing`
`[singing]`-tag expressive-TTS toggle. (SVC is **not** out of scope — it's Phase 5.)
