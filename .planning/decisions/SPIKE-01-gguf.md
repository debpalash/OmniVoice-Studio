# SPIKE-01: Adopt `Serveurperso/OmniVoice-GGUF` as hardware-adaptive default cloning engine

**Status:** Proposed (research-supported) — awaiting Phase 2 SubprocessBackend merge
**Date:** 2026-05-18
**Decision-makers:** [maintainer]
**Related:** ROADMAP Phase 4; REQUIREMENTS GGUF-01..06; `.planning/phases/04-adaptive-specialty-engines-spike-first/04-RESEARCH.md`

## Context

OmniVoice Studio v0.2.7 ships `k2-fsa/OmniVoice` (Apache-2.0, 0.6B Qwen3 backbone, Higgs Audio v2 codec at 24 kHz mono) as its default voice-cloning engine via `backend/services/tts_backend.py:OmniVoiceBackend`. The Python in-process path requires PyTorch + CUDA / MPS / CPU and on 4 GB-VRAM GPUs falls back to CPU inference.

`Serveurperso/OmniVoice-GGUF` (HuggingFace, 10,603 downloads/month, verified 2026-05-18) publishes 4 quantizations of the same upstream model — Q4_K_M (~659 MB VRAM), Q8_0 (~945 MB, recommended balance), BF16 (~1.6 GB), F32 (~3.2 GB) — consumable through the MIT-licensed `omnivoice.cpp` runtime (`github.com/ServeurpersoCom/omnivoice.cpp`, 38 stars, 59 commits, 6 open issues). The quants use a custom `omnivoice-lm` architecture and do **not** load in vanilla llama.cpp.

This decision is whether to integrate the GGUF engine as a hardware-adaptive default with overridable fallback to the existing in-process `OmniVoiceBackend`.

## Decision

**GO** — integrate per GGUF-01..06.

The integration shape is `OmniVoiceGGUFBackend(TTSBackend)` wrapping Phase 2's `SubprocessBackend`, which spawns a bundled per-platform `omnivoice-tts` binary built from a pinned `omnivoice.cpp` commit SHA. Quant selection is driven by a `detect_capabilities()` extension of `backend/services/gpu_sandbox.py` mapping `(compute_class) → quant filename` via shippable `quant_map.json`. On hardware where probe + load succeed, GGUF becomes the default cloning engine; on any failure the existing in-process `OmniVoiceBackend` is the fallback.

## Consequences

**Positive:**
- 4 GB-VRAM GPUs (currently falling back to CPU on the in-process path) get GPU-backed cloning via Q4_K_M.
- Smaller VRAM footprint = stays out of the way of other engines when users run multiple in one session.
- License chain unchanged (Apache-2.0 model + MIT runtime).
- Same underlying model as what already ships — worst case it ties the in-process path on a given hardware class and we keep that path as the fallback.

**Negative / risk:**
- Adds a maintained-by-others C++ runtime to the dependency graph (`omnivoice.cpp`, 38 stars at decision time).
- Adds ~12-16 MB of platform binaries to the installer (must verify against Phase 3 mirror-timing baseline per Pitfall 6).
- macOS code signing scope expands by 4 binaries (track via REL-05; same `xattr -cr` workaround as #54 applies in v0.3.x).
- `omnivoice.cpp` README does not publish a macOS Metal build script — only `buildcpu.sh`, `buildcuda.sh`, `buildvulkan.sh`, `buildall.sh`. Apple Silicon Metal must be verified in Wave 1.

**Mitigations:**
- Pin `omnivoice.cpp` by commit SHA; rebuild from pinned SHA in CI for all 4 target platforms.
- Pin every quant file by commit SHA in `quant_map.json` (shippable JSON so the table can update without an app release).
- In-process `OmniVoiceBackend` remains as fallback if any GGUF step fails (probe, download, load, generate).
- macOS Apple Silicon Metal build is verified in Wave 1 with explicit acceptance criteria; if blocked, downgrade SPIKE-01 default on macOS to in-process path and document in this ADR's "Status" line.
- SHA-256 checksums on bundled binaries (per GATE-05); verify at first launch and on every quant load.
- Subprocess arg composition uses typed `Path` objects rooted in app directories; quant override UI is a dropdown over `quant_map.json` entries only (no freeform path input — supply-chain control analogous to INST-09).

## Sources

- `.planning/phases/04-adaptive-specialty-engines-spike-first/04-RESEARCH.md` (this milestone's research)
- https://huggingface.co/Serveurperso/OmniVoice-GGUF (verified 2026-05-18)
- https://github.com/ServeurpersoCom/omnivoice.cpp (verified 2026-05-18)
- https://huggingface.co/k2-fsa/OmniVoice (upstream, Apache-2.0)
- `backend/services/tts_backend.py` (existing `OmniVoiceBackend` reference)
