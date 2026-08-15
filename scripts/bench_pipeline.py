#!/usr/bin/env python
"""Profile the hot paths of VoiceStudio's major features — once, safely.

This exists because "make it faster" kept turning into guesswork. Every claim in
the dub-performance work (#1127, #1129) is supposed to come from a number, and a
number needs a repeatable way to get it.

**It is deliberately gentle with memory.** VoiceStudio's worst bug class is the
out-of-memory kill on a 16 GB unified-memory Mac (#1119), so a profiler that
loads every model at once — or loops a benchmark until RAM runs out — would
reproduce the very crash it is meant to help fix. Therefore:

  * stages run **one at a time**, never concurrently;
  * every model is **unloaded between stages** (`free_vram()`), so peak RSS is
    one model, not the sum of them;
  * before each stage we check **actually-free RAM** and **skip the stage** if it
    is under the floor, rather than starting a load that the OS would kill;
  * each measurement is a small fixed number of passes — **no loops to
    convergence**, no "run until stable".

Usage:
    uv run python scripts/bench_pipeline.py              # everything
    uv run python scripts/bench_pipeline.py tts clone    # only these stages
    OMNIVOICE_BENCH_FLOOR_GB=4 uv run python scripts/bench_pipeline.py

Stop the backend first — it holds a TTS model and will skew every number.
"""
from __future__ import annotations

import os
import sys
import time
from contextlib import contextmanager

os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

#: Don't start a stage with less than this much RAM free. A whisper/TTS load
#: wants ~3 GB; starting one at 2 GB free is how the backend gets OOM-killed.
FLOOR_GB = float(os.environ.get("OMNIVOICE_BENCH_FLOOR_GB", "3.5"))

RESULTS: list[tuple[str, str, float, str]] = []


def free_gb() -> float:
    from services.memory_budget import available_memory

    v = available_memory().get("ram_available_gb")
    return float(v) if v is not None else float("nan")


def release_everything() -> None:
    """Drop every resident model. Between stages this is the difference between
    a 3 GB peak and a 9 GB peak."""
    try:
        from services import model_manager as mm

        mm.model = None
        mm.free_vram()
    except Exception as e:
        print(f"  ! release failed (non-fatal): {e}")
    try:
        from services.tts_backend import clear_clone_prompt_cache

        clear_clone_prompt_cache()
    except Exception:
        pass
    import gc

    gc.collect()


@contextmanager
def stage(name: str):
    """Run a stage only if there's room, and always leave the machine clean."""
    release_everything()
    have = free_gb()
    # `not (have >= FLOOR_GB)` instead of `have < FLOOR_GB`: NaN (RAM
    # unmeasurable) fails every comparison, and an unmeasurable machine should
    # refuse the stage rather than risk the OOM the floor exists to prevent.
    # OMNIVOICE_BENCH_FLOOR_GB=0 disables the guard entirely.
    if FLOOR_GB > 0 and not (have >= FLOOR_GB):
        print(f"\n=== {name}: SKIPPED — only {have:.1f} GB free (floor {FLOOR_GB} GB; "
              f"OMNIVOICE_BENCH_FLOOR_GB=0 to force)", flush=True)
        RESULTS.append((name, "skipped", 0.0, f"only {have:.1f} GB free"))
        yield None
        return
    print(f"\n=== {name}  (free before: {have:.1f} GB)", flush=True)
    try:
        yield True
    except Exception as e:
        print(f"  ! {name} FAILED: {type(e).__name__}: {e}", flush=True)
        RESULTS.append((name, "failed", 0.0, f"{type(e).__name__}: {e}"))
    finally:
        print(f"    free after: {free_gb():.1f} GB", flush=True)
        release_everything()


def record(stage_name: str, what: str, seconds: float, note: str = "") -> None:
    RESULTS.append((stage_name, what, seconds, note))
    print(f"    {what:<38} {seconds:7.2f}s  {note}", flush=True)


def timed(fn, *a, **kw) -> float:
    t = time.perf_counter()
    fn(*a, **kw)
    return time.perf_counter() - t


# ── stages ──────────────────────────────────────────────────────────────────

SHORT = "So the steel body is machined right here in the factory."
LONG = (
    "So the steel body is machined right here in the factory, and if we don't want to import "
    "it, we have to build the whole thing ourselves, step by step, right from the raw material."
)


def _cuda_vram_tracking_start() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        # No torch / broken CUDA runtime: VRAM tracking is a bonus metric,
        # never a reason to abort the timing run.
        pass


def _cuda_vram_peak_gb() -> "float | None":
    """CUDA only. MPS is unified memory (the free-RAM lines already show it)
    and exposes no peak counter; CPU has no VRAM. Returning None keeps the
    report honest instead of printing a made-up zero."""
    try:
        import torch

        if torch.cuda.is_available():
            # Reserved, not allocated: the allocator holds more from the
            # device than live tensors occupy, and reserved is the capacity
            # a card actually needs to run the engine.
            return torch.cuda.max_memory_reserved() / 1e9
    except Exception:
        # Same as tracking start: an unreadable counter degrades to "no VRAM
        # row", it must not fail the stage.
        pass
    return None


def _engine_runs_out_of_process(backend) -> bool:
    """Duck-typed on purpose: `isinstance(SubprocessBackend)` misses engines
    that spawn a binary per generate (omnivoice-gguf inherits TTSBackend
    directly), and class identity breaks under test-fixture module purges.
    The backends declare `runs_out_of_process` themselves."""
    return bool(getattr(backend, "runs_out_of_process", False))


def bench_tts():
    """Synthesis alone — no cloning, no reference. The floor for any dub.
    Warm measurements also report RTF (compute seconds per second of generated
    audio — the number docs/benchmarks.md collects; < 1 is faster than real
    time), and on CUDA the stage's peak VRAM."""
    import asyncio

    from services.tts_backend import active_backend_id, resolve_generation_backend

    # Tracking starts BEFORE resolution so any allocation the resolver makes
    # is inside the peak, and the engine is printed so a benchmarks.md row
    # can never attribute numbers to the wrong backend.
    _cuda_vram_tracking_start()
    b = asyncio.run(resolve_generation_backend(require_cloning=False))
    # Adapter engines host several very different models behind one backend
    # id — name the model too, or rows are unattributable. The backends
    # report it themselves (TTSBackend.model_identity), so this never needs
    # per-engine attribute knowledge again.
    try:
        model_id = b.model_identity()
    except Exception:
        model_id = None
    print(
        f"    engine: {active_backend_id()}"
        + (f" [{model_id}]" if model_id else "")
        + f" ({type(b).__name__})",
        flush=True,
    )
    sr = getattr(b, "sample_rate", 0) or 0
    last: dict = {}

    def gen(t):
        last["wav"] = b.generate(text=t, language="en", denoise=True, postprocess_output=True)

    def rtf_note(secs: float) -> str:
        wav = last.get("wav")
        n = getattr(wav, "shape", [0])[-1] if wav is not None else 0
        if not (sr and n):
            return ""
        audio_s = n / sr
        return f"RTF {secs / audio_s:.2f} ({audio_s:.1f}s of audio)"

    record("tts", "model load + first synth (cold)", timed(gen, SHORT))
    secs = timed(gen, SHORT)
    record("tts", "short line (warm)", secs, rtf_note(secs))
    secs = timed(gen, LONG)
    record("tts", "long line (warm)", secs, rtf_note(secs) or "~2.5x the text")
    if _engine_runs_out_of_process(b):
        # Subprocess-isolated engines (IndexTTS2, MOSS, PocketTTS, …) allocate
        # in their own process — the parent's CUDA counters read ~0, which
        # would publish a convincing lie. Say n/a instead.
        print("    peak VRAM: n/a — engine runs in a subprocess, invisible to "
              "the parent's CUDA counters", flush=True)
    else:
        peak = _cuda_vram_peak_gb()
        if peak is not None:
            record("tts", "peak VRAM (GB)", peak, "CUDA only — value column is GB")


def bench_clone():
    """The suspect (#1129): a dub writes ONE reference per segment, so the
    clone-prompt cache — keyed by (ref_audio, ref_text) — misses on every single
    segment. If the encode is expensive, that is the dub's real cost, and it is
    paid 177 times for a video with 2 speakers."""
    import glob

    import asyncio

    from services.model_manager import get_model
    from services.tts_backend import _get_clone_prompt, resolve_generation_backend

    refs = sorted(glob.glob(os.path.expanduser(
        "~/Library/Application Support/OmniVoice/dub_jobs/*/seg_ref_*.wav")))
    if not refs:
        print("    (no dub segment refs on disk — run a dub first)", flush=True)
        return

    b = asyncio.run(resolve_generation_backend(require_cloning=True))
    # get_model() is a COROUTINE — awaiting it matters, or every encode below
    # silently takes the "precompute failed, use inline ref" path and measures
    # the exception handler instead of the encoder.
    m = getattr(b, "_model", None) or asyncio.run(get_model())
    assert hasattr(m, "create_voice_clone_prompt"), f"not a model: {type(m).__name__}"
    print(f"    {len(refs)} per-segment refs on disk", flush=True)

    _get_clone_prompt(m, refs[0], "warm")  # warm the code path, not the cache key

    n = 3
    t = time.perf_counter()
    for r in refs[1 : 1 + n]:
        _get_clone_prompt(m, r, "x")
    miss = (time.perf_counter() - t) / n
    record("clone", "prompt encode — CACHE MISS", miss, "<-- paid once PER SEGMENT")

    t = time.perf_counter()
    for _ in range(n):
        _get_clone_prompt(m, refs[1], "x")
    hit = (time.perf_counter() - t) / n
    record("clone", "prompt encode — cache hit", hit, "what a per-SPEAKER ref would cost")

    if miss > 0.05:
        saved = miss * (len(refs) - 2)
        record("clone", f"cost of {len(refs)} misses vs 2 speakers", saved,
               f"~{saved/60:.1f} min of pure waste per dub")


def bench_asr():
    """Transcription — the #1127 fix in place. Confirms the engine picked here."""
    import glob

    from services.asr_backend import _auto_detect, get_active_asr_backend

    picked = _auto_detect()
    print(f"    auto-detected engine: {picked}", flush=True)

    refs = sorted(glob.glob(os.path.expanduser(
        "~/Library/Application Support/OmniVoice/dub_jobs/*/seg_ref_*.wav")))
    audio = refs[0] if refs else None
    if not audio:
        print("    (no audio sample on disk — skipping)", flush=True)
        return

    b = get_active_asr_backend()
    b.transcribe(audio, word_timestamps=True)  # warm
    record("asr", f"transcribe ({picked}, warm)", timed(b.transcribe, audio, word_timestamps=True))


STAGES = {"tts": bench_tts, "clone": bench_clone, "asr": bench_asr}


def main() -> None:
    want = [a for a in sys.argv[1:] if not a.startswith("-")] or list(STAGES)
    print(f"VoiceStudio pipeline profile — floor {FLOOR_GB} GB, stages: {', '.join(want)}")
    print(f"free RAM at start: {free_gb():.1f} GB", flush=True)

    for name in want:
        fn = STAGES.get(name)
        if not fn:
            print(f"unknown stage {name!r} (have: {', '.join(STAGES)})")
            continue
        with stage(name) as ok:
            if ok:
                fn()

    print("\n" + "=" * 68)
    print(f"{'stage':<8} {'measurement':<40} {'value':>8}")
    print("-" * 68)
    for st, what, secs, note in RESULTS:
        print(f"{st:<8} {what:<40} {secs:>8.2f}  {note}")
    print(f"\nfree RAM at end: {free_gb():.1f} GB")


if __name__ == "__main__":
    main()
