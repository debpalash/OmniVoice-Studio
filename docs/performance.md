# Performance guide

Where the time goes when OmniVoice feels slow, what you can tune, and what you
should leave alone. Everything here applies to the current release; numbers
marked "measured" come from `scripts/bench_pipeline.py` on a 16 GB Apple
Silicon M2 — your hardware will differ, but the *ratios* hold.

## First: the three classic causes of "it got slow"

Before touching any knob, check these — they account for most slowness reports:

1. **A voice profile with an empty Transcript field.** Cloning needs the
   reference clip's transcript. If the profile doesn't have one, the app
   transcribes the clip — since v0.3.15 that happens **once** and is saved onto
   the profile, but a profile that somehow keeps an empty transcript (e.g.
   imported data) pays an ASR pass per generation. Open the voice's editor and
   confirm the Transcript box shows text.
2. **The first generation after a (re)start is always the slowest.** Model
   weights load lazily (~8 s), CUDA builds torch.compile kernels, Apple Silicon
   warms Metal kernels. Judge speed from the *second* generation onward.
3. **Memory pressure.** On a 16 GB unified-memory machine, a browser with 40
   tabs next to a dub means the OS pages the model in and out — or kills the
   backend outright ("Can't reach the local backend"). Check Settings →
   Models for what's resident, and Settings → Performance for free RAM.

## What a generation actually spends time on

For a cloned voice, one generation is: encode the reference clip (~0.4 s,
measured; cached after the first use for the voices you reuse — a dub's
per-line clips are each used once, so there's nothing for a cache to save
there) → synthesize (the bulk; scales with output length) → post-process
(mastering, watermark; fractions of a second). Long texts are split into
chunks synthesized sequentially — time scales roughly linearly with text
length.

For a dub, the stages are: audio extraction + vocal separation (one-time,
minutes for long videos) → transcription (on the best accelerator available —
Apple Silicon uses MLX since v0.3.21, NVIDIA uses CUDA; CPU-only installs fall
back to the processor) → translation (parallel, 6 concurrent requests for LLM
providers) → per-segment synthesis (sequential, the bulk of the time) →
mixing and export (mostly stream-copied, fast).

## Knobs you can actually turn

All of these are environment variables read by the backend at start. Set them
in `~/.config/omnivoice/env` (created by the installer) or your shell profile.
None of them are required — the defaults are chosen for the common case.

| Variable | Default | What it does |
|---|---|---|
| `OMNIVOICE_IDLE_TIMEOUT_S` | `900` | Seconds of idle before the TTS model unloads to free memory. Raise it (e.g. `3600`) if you generate in bursts and dislike the ~8 s reload; lower it on tight-memory machines. |
| `OMNIVOICE_SIDECAR_IDLE_TIMEOUT_S` | `300` | Same idea for sidecar engines (IndexTTS-2 etc.). |
| `OMNIVOICE_LLM_CONCURRENCY` | `6` | Parallel LLM translation calls during a dub. Raise for a fast API endpoint, lower if your provider rate-limits. |
| `OMNIVOICE_GPU_WORKERS` | auto | Concurrent generations on the GPU. Auto-sized from free VRAM (1 worker per 5 GB, max 4); MPS and CPU always get 1. **Do not raise this on ≤10 GB cards or Apple Silicon** — two concurrent jobs over-committing VRAM is exactly the crash class (#567) the auto-sizing exists to prevent. |
| `OMNIVOICE_CPU_POOL` | `min(8, cores)` | Thread pool for CPU-side work (translation dispatch, audio I/O). |
| `OMNIVOICE_SINGLE_ENGINE_RESIDENT` | `1` | Keep only one TTS engine in memory at a time. Set `0` on 32 GB+ machines to keep several engines warm across switches. |
| `OMNIVOICE_UNIFIED_OFFLOAD_HEADROOM_GB` | `6` | On unified memory (Apple Silicon): if free RAM is below this when a dub needs the transcription model, the TTS model is fully released first (it reloads on the next generation). Raise to be more aggressive about freeing, lower on 32 GB+ machines to avoid the reload. |
| `OMNIVOICE_INDEXTTS_FP16` | `1` | IndexTTS half-precision. Leave on. |
| `OMNIVOICE_ASR_VRAM_PREFLIGHT` | `1` | Downgrade transcription precision instead of crashing when VRAM is short (CUDA). Leave on. |
| `OMNIVOICE_GENERATE_TIMEOUT_S` | `300` | Abandon a generation after this many seconds. Raise for very long single generations on slow hardware. |

**torch.compile** is probe-based, not platform-based: it's attempted only
where the runtime check says it can work (a CUDA device with Triton importable
and a supported GPU architecture) and skipped automatically everywhere else —
MPS, CPU, and the typical Windows install (Triton ships no Windows wheel).
The one user-facing control is Settings → Performance → "Disable
torch.compile" (shown on Windows), for the rare setup where a partial Triton
install makes the probe pass but the compile attempt itself crash — see
[Windows install notes](install/windows.md).

## Platform notes

- **Apple Silicon**: everything runs on the GPU via MPS/MLX. One generation at
  a time by design — unified memory means TTS and ASR compete for the same
  RAM, and the app actively unloads one to make room for the other on 16 GB
  machines. More RAM directly improves dub throughput (fewer unload/reload
  cycles).
- **NVIDIA**: fp16 + torch.compile on by default. ≥16 GB VRAM parallelizes up
  to 3-4 concurrent generations (API/batch workloads); ≤10 GB deliberately
  serializes.
- **CPU-only**: expect ~2x slower than MPS, more against CUDA. Prefer the
  smaller/faster engines (see Settings → Engines) and short reference clips.

## Measuring instead of guessing

`scripts/bench_pipeline.py` (repo checkouts) profiles each stage one at a
time, memory-safely — it refuses to start a stage without enough free RAM,
and unloads models between stages:

```bash
# stop the app first — a running backend holds a model and skews numbers
uv run python scripts/bench_pipeline.py            # everything
uv run python scripts/bench_pipeline.py tts clone  # just these stages
```

If you report a performance issue, pasting its table (plus your platform and
RAM/VRAM) turns a guessing game into a bisect.

## Things that look like knobs but aren't

- **Deleting and re-adding a voice** doesn't speed anything up; the reference
  encode is cached per file for voices you reuse. (A dub's per-line reference
  clips are the deliberate exception — each is a distinct clip used once, so
  there's nothing for a cache to save.)
- **Killing the backend between generations** makes everything slower — you
  pay the model load every time. The idle timeout already frees memory when
  it's genuinely idle.
- **`OMNIVOICE_PRELOAD_TTS_ASR`** exists for a legacy in-process Whisper
  fallback; enabling it costs memory on every start and speeds up nothing on
  a default install.
