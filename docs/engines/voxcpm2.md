# VoiceStudio — VoxCPM2 Engine

VoxCPM2 (OpenBMB) is the studio-quality option: native 48 kHz output,
zero-shot voice cloning, and — uniquely among VoiceStudio's engines —
**voice design**: creating a synthetic voice from a text description
("young female, warm tone, British accent") with no reference audio at all.

## When to pick it

- You want voice design without a reference clip.
- You want the highest output sample rate (48 kHz vs OmniVoice's 24 kHz).
- Your language is among its 30 supported languages: Arabic, Burmese,
  Chinese, Danish, Dutch, English, Finnish, French, German, Greek, Hebrew,
  Hindi, Indonesian, Italian, Japanese, Khmer, Korean, Lao, Malay,
  Norwegian, Polish, Portuguese, Russian, Spanish, Swahili, Swedish,
  Tagalog, Thai, Turkish, Vietnamese.

## Requirements

- Python ≥ 3.10, PyTorch ≥ 2.5.
- CUDA ≥ 12 recommended for full speed; MPS (Apple Silicon) and CPU also
  work.

## Setup

Install the package into VoiceStudio's Python environment:

```bash
pip install "voxcpm>=2.0.3"
```

That is a version **floor**, not a pin — an older install still works, but
the engine logs an upgrade hint at load time. Then select the engine via
**Model Catalogue → Engines** or `OMNIVOICE_TTS_BACKEND=voxcpm2`.

## Model selection

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMNIVOICE_VOXCPM_MODEL` | `openbmb/VoxCPM2` | HuggingFace checkpoint to load |

The first use downloads a multi-GB checkpoint from HuggingFace. A download
interrupted near the end used to abort the load outright
([#1224](https://github.com/debpalash/VoiceStudio/issues/1224)); the load is
now retried once with a fresh client. See
[downloading-models.md](../downloading-models.md).

## Behaviour notes

- **Voice design:** provide a description and no reference audio.
- **Cloning:** the reference clip is prepared before use (edge-silence trim
  and length cap) so dead air in a raw clip doesn't condition the output; on
  any prep problem the raw clip is used as-is.
- **Style instructions** are passed as an inline prefix to the text.
- VoxCPM2 emits mastered, studio-grade audio, so VoiceStudio **skips its
  shared mastering chain** (which is tuned for 24 kHz engines) — only benign
  loudness normalization applies.
- A trailing-silence guard trims long near-silent tails from generations,
  keeping a short natural tail.

## Known limits

- Slower than the lightweight CPU engines — see
  [benchmarks.md](../benchmarks.md) and [performance.md](../performance.md).
- Language coverage is 30 languages; for anything else use the default
  [OmniVoice](omnivoice.md) engine ([languages.md](../languages.md)).

## Troubleshooting

- Engine shows unavailable: the `voxcpm` package isn't installed — run the
  `pip install` above and restart VoiceStudio.
- Repeated first-download failures: check connectivity/HF access, then see
  [install/troubleshooting.md](../install/troubleshooting.md).

See also: [expressive-speech.md](../expressive-speech.md),
[disk usage](disk-usage.md).
