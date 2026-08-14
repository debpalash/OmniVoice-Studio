# Benchmarks

Measured numbers per engine and device — how long a generation actually
takes on real hardware. Every number here is produced by the in-repo
harness, on named hardware, at a named version; nothing is estimated.

## How numbers are measured

```bash
# stop the app first — a running backend holds a model and skews numbers
uv run python scripts/bench_pipeline.py            # everything
uv run python scripts/bench_pipeline.py tts clone  # just these stages
```

`scripts/bench_pipeline.py` profiles each pipeline stage one at a time,
memory-safely: it refuses to start a stage without enough free RAM and
unloads models between stages. See [performance.md](performance.md) for
what each stage spends its time on.

The metric that matters for TTS is the **real-time factor (RTF)** — seconds
of compute per second of generated audio. RTF < 1 means faster than
real time.

## Results

No verified rows yet — this table launches with the harness and fills from
maintainer runs and community submissions.

| Engine | Device | RTF (TTS) | Peak VRAM | App version | Hardware | Source |
|---|---|---|---|---|---|---|
| _none yet — contribute yours below_ | | | | | | |

## Contributing a row

1. Run the harness on an otherwise-idle machine (app stopped) and copy its
   table output.
2. Open a PR adding a row with: engine, device (e.g. `RTX 3060 12 GB`,
   `M2 Pro`, `Ryzen 7 CPU`), the RTF, peak VRAM if shown, the app version
   you ran (`Settings → About`), and paste the raw harness output in the
   PR description.
3. One row per engine+device pair; a newer app version replaces the old row.

Numbers from different machines aren't directly comparable — that's fine.
The point is honest expectations ("this engine on this class of GPU ≈ this
fast"), not a leaderboard.
