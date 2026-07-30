#!/usr/bin/env python
"""CPU latency benchmark for PocketTTS vs the OmniVoice incumbent TTS engines.

DATA + METHODOLOGY ONLY. This measures each engine's raw synthesis speed on
CPU (time-to-first-chunk and real-time factor), the numbers the OmniVoice
maintainer asked for in #1306 before evaluating PocketTTS as an engine. It is
NOT an integration: it builds no PocketTTS adapter, sidecar, or CI smoke. Each
engine is driven through its OWN raw synthesis path, so no engine is penalised
or flattered by OmniVoice's subprocess plumbing, and the same script reproduces
the numbers on the maintainer's machine.

Mirrors scripts/bench_pipeline.py's memory discipline:
  * engines run one at a time, never concurrently;
  * each model is dropped + gc'd between engines, so peak RSS is one model;
  * before each engine we check free RAM and SKIP (not crash) below the floor
    (and SKIP loudly when free RAM cannot be measured, rather than run blind);
  * a small fixed number of warm passes, median reported, no loops to convergence.

Metrics (all on CPU):
  * cold  = model load + first synthesize (paid once, at startup);
  * warm  = median of N synthesize passes with the model resident;
  * TTFC  = time to first playable audio. Reported ONLY for the streaming engine
            (PocketTTS, via generate_audio_stream). Batch engines (supertonic3,
            omnivoice-gguf) emit nothing incrementally, so they are marked N/A
            rather than re-running a warm synth and labelling it TTFC;
  * RTF   = audio_seconds / synth_wallclock_seconds (>1 = faster than real time).

Residency caveat: pockettts and supertonic3 keep the model resident between
calls, so their warm rows are pure synthesis. omnivoice-gguf spawns its native
binary fresh on EVERY generate(), so its warm rows include the binary load each
call (its design, not a measurement artefact).

Usage:
    uv run python scripts/bench_engines_latency.py                  # all available
    uv run python scripts/bench_engines_latency.py pockettts supertonic3
    OMNIVOICE_BENCH_FLOOR_GB=4 uv run python scripts/bench_engines_latency.py

Engines not set up in the running environment SKIP with the reason printed, so
the same script runs cleanly wherever each engine is available. Stop the
OmniVoice backend first; it holds a model and skews every number.
"""
from __future__ import annotations

import gc
import math
import os
import platform
import statistics
import sys
import time
from contextlib import contextmanager

os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")
sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"),
)

#: Don't start an engine with less than this much RAM free.
FLOOR_GB = float(os.environ.get("OMNIVOICE_BENCH_FLOOR_GB", "3.5"))

#: Warm passes per measurement; median is robust to a single GC blip. At least
#: one, or statistics.median() would have nothing to median.
WARM_PASSES = max(1, int(os.environ.get("OMNIVOICE_BENCH_WARM_PASSES", "3")))

# engine, measurement, seconds, audio_seconds, rtf, note
RESULTS: list[tuple[str, str, float, float, float, str]] = []


# -- environment / memory hygiene -------------------------------------------


def free_gb() -> float:
    try:
        from services.memory_budget import available_memory

        v = available_memory().get("ram_available_gb")
        return float(v) if v is not None else float("nan")
    except Exception:
        return float("nan")


def release_everything() -> None:
    """Drop every resident model so peak RSS between engines is one model.
    model_manager cleanup is best-effort: on failure we log rather than silently
    no-op, so a leaked model (e.g. after an API drift) stays diagnosable."""
    gc.collect()
    try:
        from services import model_manager as mm

        mm.model = None
        mm.free_vram()
    except Exception as e:
        print(
            f"    (release_everything: model_manager cleanup skipped: "
            f"{type(e).__name__}: {e})",
            flush=True,
        )
    gc.collect()


@contextmanager
def stage(name: str):
    release_everything()
    have = free_gb()
    if not math.isfinite(have):
        print(f"\n=== {name}: SKIPPED (free RAM unmeasurable)", flush=True)
        RESULTS.append((name, "skipped", 0.0, 0.0, 0.0, "free RAM unmeasurable"))
        yield None
        return
    if have < FLOOR_GB:
        print(f"\n=== {name}: SKIPPED (only {have:.1f} GB free, floor {FLOOR_GB} GB)", flush=True)
        RESULTS.append((name, "skipped", 0.0, 0.0, 0.0, f"only {have:.1f} GB free"))
        yield None
        return
    print(f"\n=== {name}  (free before: {have:.1f} GB)", flush=True)
    try:
        yield True
    except Exception as e:
        print(f"  ! {name} FAILED: {type(e).__name__}: {e}", flush=True)
        RESULTS.append((name, "failed", 0.0, 0.0, 0.0, f"{type(e).__name__}: {e}"))
    finally:
        print(f"    free after: {free_gb():.1f} GB", flush=True)
        release_everything()


def record(engine: str, what: str, secs: float, audio_s: float, note: str = "") -> None:
    rtf = (audio_s / secs) if secs > 0 else 0.0
    RESULTS.append((engine, what, secs, audio_s, rtf, note))
    print(
        f"    {what:<42} {secs:7.3f}s  audio {audio_s:6.2f}s  RTF {rtf:5.2f}  {note}",
        flush=True,
    )


def skip(engine: str, reason: str) -> None:
    print(f"    SKIP: {reason}", flush=True)
    RESULTS.append((engine, "skipped", 0.0, 0.0, 0.0, reason))


def timed(fn, *a, **kw):
    """Run fn(*a, **kw); return (elapsed_seconds, result)."""
    t = time.perf_counter()
    out = fn(*a, **kw)
    return time.perf_counter() - t, out


def measure_warm(engine: str, synth, to_samples, sr: int) -> None:
    """Run SHORT and LONG WARM_PASSES times each; record median synth time and
    RTF. ``synth(text) -> audio`` and ``to_samples(audio) -> int``."""
    for label, text in (("short (warm)", SHORT), ("long (warm)", LONG)):
        secs, samples = [], []
        for _ in range(WARM_PASSES):
            dt, audio = timed(synth, text)
            secs.append(dt)
            samples.append(to_samples(audio))
        record(engine, f"{label} batch", statistics.median(secs), statistics.median(samples) / sr)


# -- fixed corpus (same texts as scripts/bench_pipeline.py) -------------------

SHORT = "So the steel body is machined right here in the factory."
LONG = (
    "So the steel body is machined right here in the factory, and if we don't want to import "
    "it, we have to build the whole thing ourselves, step by step, right from the raw material."
)

#: Batch engines emit nothing incrementally; TTFC is a streaming-only metric.
TTFC_NA = "no incremental output; see warm-short time (batch engine)"


# -- hardware banner ---------------------------------------------------------


def print_hardware() -> None:
    cpu = platform.processor() or platform.machine() or "?"
    if sys.platform == "darwin":
        try:
            import subprocess

            cpu = (
                subprocess.check_output(
                    ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
                ).strip()
                or cpu
            )
        except Exception:
            # sysctl unavailable on non-darwin or where sysctl is absent; keep
            # the platform.processor() / platform.machine() fallback above.
            pass
    cores = os.cpu_count()
    print("=" * 80)
    print(f"CPU: {cpu} | cores: {cores} | Python {platform.python_version()}")
    print(platform.platform())
    print(f"free RAM at start: {free_gb():.1f} GB | warm passes: {WARM_PASSES} (median)")
    print("Each engine runs at its own default thread/core usage; that difference is")
    print("reported here, not normalised away. Run twice and compare for reproducibility.")
    print("=" * 80)


# -- PocketTTS (kyutai-labs/pocket-tts) --------------------------------------


def bench_pockettts() -> None:
    """Streaming CPU TTS with zero-shot cloning, driven via its Python library
    (the raw synthesis path). Voice is the public preset 'alba' so the run has
    no local-file dependency; voice source does not affect synthesis RTF/TTFC."""
    try:
        from pocket_tts import TTSModel
    except ImportError as e:
        skip("pockettts", f"pocket_tts not importable ({e})")
        return

    t0 = time.perf_counter()
    model = TTSModel.load_model()
    sr = model.sample_rate
    voice_state = model.get_state_for_audio_prompt("alba")
    cold_audio = model.generate_audio(voice_state, SHORT)  # first synth is part of cold
    record("pockettts", "cold (load + first synth)", time.perf_counter() - t0, cold_audio.shape[-1] / sr, "paid once")

    measure_warm(
        "pockettts",
        lambda t: model.generate_audio(voice_state, t),
        lambda a: int(a.shape[-1]),
        sr,
    )

    # TTFC: time to the first streamed chunk. PocketTTS streams, so this is its
    # headline latency metric (~200 ms to first audio per its model card).
    ttfc, first = timed(lambda: next(model.generate_audio_stream(voice_state, SHORT)))
    record("pockettts", "TTFC (first chunk, streaming)", ttfc, first.shape[-1] / sr)


# -- supertonic3 (Supertone, ONNX, CPU-only) --------------------------------


def bench_supertonic3() -> None:
    """31-language ONNX TTS, CPU-only. Mirrors the raw SDK path in
    backend/engines/supertonic3/sidecar.py: snapshot_download -> TTS() ->
    tts.synthesize(). Preset voice M1; supertonic3 has no cloning mode."""
    try:
        import numpy as np

        from huggingface_hub import snapshot_download
        from supertonic import TTS

        from engines.supertonic3.constants import PINNED_REVISION_SHA
    except ImportError as e:
        skip("supertonic3", f"supertonic deps not importable ({e})")
        return

    t0 = time.perf_counter()
    model_path = snapshot_download(repo_id="Supertone/supertonic-3", revision=PINNED_REVISION_SHA)
    tts = TTS(model="supertonic-3", model_dir=model_path, auto_download=False)
    style = tts.get_voice_style(voice_name="M1")
    sr = getattr(tts, "sample_rate", 44100)
    cold_wav, _dur = tts.synthesize(text=SHORT, voice_style=style, total_steps=8, speed=1.0, lang="na")
    record(
        "supertonic3",
        "cold (download + TTS() + first synth)",
        time.perf_counter() - t0,
        float(np.asarray(cold_wav).squeeze().shape[-1]) / sr,
        "paid once; ~400MB first run",
    )

    measure_warm(
        "supertonic3",
        lambda t: tts.synthesize(
            text=t, voice_style=style, total_steps=8, speed=1.0, lang="na"
        )[0],
        lambda w: int(np.asarray(w).squeeze().shape[-1]),
        sr,
    )
    record("supertonic3", "TTFC (N/A, batch engine)", 0.0, 0.0, TTFC_NA)


# -- omnivoice-gguf (Serveurperso/OmniVoice-GGUF, native binary) ------------


def bench_omnivoice_gguf() -> None:
    """Hardware-adaptive GGUF engine driven by a native omnivoice-tts binary.
    In a source checkout the binary is absent until scripts/build-omnivoice-tts.sh
    builds it, so this driver SKIPs there and runs where the binary exists.

    Note: the binary is spawned fresh on every generate(), so unlike the other
    two engines the warm rows include the binary load each call."""
    try:
        from engines.omnivoice_gguf.backend import OmniVoiceGGUFBackend
    except ImportError as e:
        skip("omnivoice-gguf", f"backend not importable ({type(e).__name__}: {e})")
        return

    ok, why = OmniVoiceGGUFBackend.is_available()
    if not ok:
        skip("omnivoice-gguf", why)
        return

    b = OmniVoiceGGUFBackend()
    sr = b.sample_rate
    residency = "binary spawns per generate(); warm includes binary load"

    cold, audio = timed(b.generate, text=SHORT, language="en")
    record("omnivoice-gguf", "cold (binary load + first synth)", cold, audio.shape[-1] / sr, residency)

    measure_warm(
        "omnivoice-gguf",
        lambda t: b.generate(text=t, language="en"),
        lambda a: int(a.shape[-1]),
        sr,
    )
    record("omnivoice-gguf", "TTFC (N/A, batch engine)", 0.0, 0.0, TTFC_NA)


ENGINES = {
    "pockettts": bench_pockettts,
    "supertonic3": bench_supertonic3,
    "omnivoice-gguf": bench_omnivoice_gguf,
}


def main() -> None:
    want = [a for a in sys.argv[1:] if not a.startswith("-")] or list(ENGINES)
    print_hardware()
    for name in want:
        fn = ENGINES.get(name)
        if not fn:
            print(f"\nunknown engine {name!r} (have: {', '.join(ENGINES)})")
            continue
        with stage(name) as ok:
            if ok:
                fn()

    print("\n" + "=" * 80)
    print(f"{'engine':<16}{'measurement':<44}{'seconds':>8}{'audio_s':>9}{'RTF':>7}  note")
    print("-" * 80)
    for eng, what, secs, audio_s, rtf, note in RESULTS:
        print(f"{eng:<16}{what:<44}{secs:>8.3f}{audio_s:>9.2f}{rtf:>7.2f}  {note}")
    print(f"\nfree RAM at end: {free_gb():.1f} GB")


if __name__ == "__main__":
    main()
