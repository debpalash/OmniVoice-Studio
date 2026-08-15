# VoiceStudio — MOSS-TTS-Nano Engine

MOSS-TTS-Nano (OpenMOSS) is the low-resource, broad-language pick: a
100M-parameter autoregressive codec LM that runs realtime on a 4-core CPU —
no GPU required — with native 48 kHz output and 20 languages under an
Apache-2.0 license. It fills the "runs on a fanless laptop" tier while still
covering languages like Arabic, Hebrew, Persian, Korean, and Turkish.

## When to pick it

- CPU-only or low-power hardware, but you still need cloning and non-English
  coverage.
- Your language is among: Chinese, English, German, Spanish, French,
  Japanese, Italian, Hebrew, Korean, Russian, Persian, Arabic, Polish,
  Portuguese, Czech, Danish, Swedish, Hungarian, Greek, Turkish.

## Setup

The package is **not on PyPI** — install it from the upstream repo into
VoiceStudio's Python environment:

```bash
git clone https://github.com/OpenMOSS/MOSS-TTS-Nano.git
cd MOSS-TTS-Nano
uv pip install -e .
```

Then select the engine via **Model Catalogue → Engines** or
`OMNIVOICE_TTS_BACKEND=moss-tts-nano`.

## Model selection

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMNIVOICE_MOSS_TTS_MODEL` | `OpenMOSS-Team/MOSS-TTS-Nano` | HuggingFace checkpoint to load |

The first use downloads the weights (retried once on a truncated download).
See [downloading-models.md](../downloading-models.md).

## Behaviour notes

- **Cloning is reference-only**: pass a reference clip. Style instructions,
  preset speakers, and speed control are not supported and are silently
  ignored, so mixed-engine call sites keep working.
- The model emits 48 kHz stereo; VoiceStudio downmixes to mono, matching the
  rest of the pipeline (the dub mixer treats TTS output as mono per
  segment).
- Runs on CPU or CUDA.

## Upstream is unpinned

The upstream repo is installed straight from git with no pinned release, and
the model class it exports has changed before
([#1287](https://github.com/debpalash/VoiceStudio/issues/1287)). VoiceStudio
therefore verifies that a usable model class actually exists — not just that
the package imports — before reporting the engine as ready. If the engine
shows unavailable with a "does not expose a usable model class" message,
pull the latest upstream and re-run `uv pip install -e .`, or open an issue
with the version you have.

## Known limits

- No voice design, no instruct, no speed control — cloning from a reference
  clip only.
- Quality sits below the large engines; see
  [benchmarks.md](../benchmarks.md).

## Troubleshooting

- "moss_tts_nano package not installed": run the clone + `uv pip install -e .`
  steps above.
- Entry-point errors after an upstream update: see "Upstream is unpinned"
  above.
- General issues: [install/troubleshooting.md](../install/troubleshooting.md).

See also: [languages.md](../languages.md),
[expressive-speech.md](../expressive-speech.md),
[disk usage](disk-usage.md).
