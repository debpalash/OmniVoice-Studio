# Benchmarks

Measured numbers per engine and device — how long a generation actually
takes on real hardware. Every number here is produced by the in-repo
harness, on named hardware, at a named version; nothing is estimated.

## How numbers are measured

```bash
# stop the app first — a running backend holds a model and skews numbers
uv run python scripts/bench_pipeline.py            # everything
uv run python scripts/bench_pipeline.py tts        # just the TTS stage
```

`scripts/bench_pipeline.py` profiles each pipeline stage one at a time,
memory-safely: it refuses to start a stage without enough free RAM and
unloads models between stages. See [performance.md](performance.md) for
what each stage spends its time on.

The `tts` stage emits the two values this table collects:

- **RTF** (real-time factor) — seconds of compute per second of generated
  audio, printed next to each warm measurement. RTF < 1 means faster than
  real time. Use the **short line (warm)** RTF for the table.
- **Peak VRAM** — printed on CUDA only. MPS is unified memory and CPU has
  no VRAM; subprocess-isolated engines allocate outside the harness's view
  (it prints `n/a` for them). Leave the column blank in all those cases.

## Results

No verified rows yet — this table fills from maintainer runs and community
submissions.

| Engine | Device | RTF (warm) | Peak VRAM (GB) | App version | Source |
|---|---|---|---|---|---|
| _none yet — contribute yours below_ | | | | | |

Column meanings: **Engine** — the TTS engine the harness resolved (printed
at stage start). **Device** — one string naming what ran the model, e.g.
`RTX 3060 12 GB`, `Apple M2 Pro`, `Ryzen 7 5800X (CPU)`. **RTF (warm)** —
the short-line warm RTF from the harness. **Peak VRAM** — the harness's
CUDA peak, blank on MPS/CPU. **App version** — from `Settings → About`.
**Source** — a link to the PR that added the row.

## Contributing a row

1. Run the harness on an otherwise-idle machine (app stopped) and copy its
   summary table.
2. Open a PR adding one row using the column meanings above, and paste the
   raw harness output into the PR description — that PR link becomes the
   row's **Source**.
3. One row per engine+device pair; a newer app version replaces the old row.

Numbers from different machines aren't directly comparable — that's fine.
The point is honest expectations ("this engine on this class of GPU ≈ this
fast"), not a leaderboard.
