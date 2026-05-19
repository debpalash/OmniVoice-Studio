# OmniVoice Studio — Speaker Diarization

Diarization splits a single audio stream into per-speaker tracks: who said
what, and when. OmniVoice uses **pyannote** + **WhisperX** under the hood —
the same stack the original WhisperX paper used.

## What diarization buys you

- Multi-speaker dubbing: each detected speaker gets its own voice clone in
  the target language.
- Subtitle styling: speaker labels (`SPEAKER_00:`, `SPEAKER_01:`, …) on the
  exported SRT/VTT files.
- Audio editing: per-speaker tracks in the timeline view.

## License acceptance flow

The diarization model — `pyannote/speaker-diarization-3.1` — is **gated** on
HuggingFace. A valid HF token alone is not enough: you also need to accept
the model's license once.

1. Get a HF token if you don't have one — see
   [docs/setup/huggingface-token.md](../setup/huggingface-token.md).
2. Set the token via **Settings → API Keys** (or any of the other supported
   paths).
3. While signed in to HuggingFace with the same account, visit:
   - https://huggingface.co/pyannote/speaker-diarization-3.1 → **"Agree and
     access repository"**.
   - https://huggingface.co/pyannote/segmentation-3.0 → same.
4. Restart the dub job. The first run downloads ~600 MB of model weights.

If you skip the license acceptance, the HF API returns `401 Unauthorized` for
the download — the same error class the in-app **"Open docs for this error"**
button deeplinks to.

## Fallback behaviour

When diarization is unavailable (no HF token, license not accepted, model
download failed mid-run), OmniVoice's dub pipeline falls back to a
**silence-gap heuristic** that splits speakers on long quiet stretches.
You'll see a warning toast and the `dub_core.py` reason string surfaces in
the job log:

- `"diarization_skipped:no_token"` — no token resolved from the cascade.
- `"diarization_skipped:401"` — token present but unauthorised on the gated
  model (license not accepted).
- `"diarization_skipped:network"` — model download interrupted.

The heuristic is not as accurate as pyannote — speakers with similar pitch
or rapid turn-taking conversation get merged — but it lets the dub finish
end-to-end instead of erroring.

## HF token requirement

Diarization is the one OmniVoice feature where a HF token is **required**, not
just recommended. See
[docs/setup/huggingface-token.md](../setup/huggingface-token.md) for the
three-source cascade and how the in-app **Settings → API Keys** panel works.

## Troubleshooting

- HF 401 → see [troubleshooting.md#2-hf-401--pyannote-license-not-accepted](../install/troubleshooting.md).
- Model download stuck → check `~/.cache/huggingface/hub/models--pyannote--*`
  size grows during the dub; if it stalls at 0 bytes, your token isn't being
  read — confirm in **Settings → API Keys** that the active source has a
  green checkmark.
