# TTS Engine Selection — Decision Tree

When to pick OmniVoice vs other engines available in this workspace. Match the user's constraint to the right column.

## Decision tree

```
Is voice cloning required?
├─ yes → OmniVoice (3-sec ref clip, zero-shot, 646 langs)
└─ no →
   Is the language non-English?
   ├─ yes → OmniVoice (646 langs) or Edge TTS (subset, cloud)
   └─ no (English) →
      Is privacy required (no cloud)?
      ├─ yes →
      │  Is GPU available?
      │  ├─ yes (CUDA/MPS) → OmniVoice (best quality) or Voicebox
      │  └─ no (CPU only) → kokoro-tts (2× realtime CPU) or OmniVoice on CPU (slow)
      └─ no (cloud OK) →
         Is cost-no-object?
         ├─ yes → ElevenLabs (best polish), then OpenAI TTS
         └─ no → Edge TTS (free, unofficial, MS Azure neural)
```

## Full comparison

| Engine | Quality | Clone | Multilingual | Cost | Privacy | Setup | Best for |
|---|---|---|---|---|---|---|---|
| **OmniVoice** | 8-9/10 | ✅ 3-sec ref | 646 langs | Free | Local | Bun + uv install | Multilingual, cloning, privacy-critical |
| ElevenLabs | 9-10/10 | ✅ 3-sec ref | 32 langs | $5-330/mo | Cloud | API key | Best English polish, fastest cloud TTS |
| Voicebox (Qwen3-TTS) | 8-9/10 | ✅ | Multi | Free | Local | Docker | Self-hosted alternative to OmniVoice |
| Voicebox (LuxTTS) | 7/10 | ❌ | Multi | Free | Local | Docker | CPU at 150× realtime |
| kokoro-tts | 7-8/10 | ❌ | Multi (limited) | Free | Local | pip | Fast English narration on CPU |
| mlx-audio | 7-8/10 | varies | Multi | Free | Local | pip | Apple Silicon native, 14+ sub-engines |
| Edge TTS | 7-8/10 | ❌ | 50+ | Free* | Cloud | pip | Zero-friction one-off |
| OpenAI TTS | 8/10 | ❌ | Multi | $0.015/1k chars | Cloud | API key | Convenient, cheap-ish, good quality |
| Google Cloud TTS | 8/10 | ❌ | Multi | $4/1M chars (WaveNet) | Cloud | GCP project | Large free tier (1M chars/mo) |

*Edge TTS is unofficial. Microsoft could block it at any time.

## When OmniVoice wins decisively

1. **Voice cloning** — 3-sec reference clip, zero-shot, no fine-tuning. ElevenLabs is the only competitor; OmniVoice is free and local.
2. **Long-tail languages** — 646 supported. ElevenLabs covers 32; everything else fewer.
3. **Privacy / regulatory** — Nothing leaves the machine. ElevenLabs and OpenAI ship audio to their servers.
4. **No-API-key constraint** — Local-first. No accounts.
5. **Bulk generation without metered cost** — ElevenLabs bills per character. OmniVoice is free at any volume.

## When OmniVoice loses

1. **Lowest-friction one-off TTS** — Backend install + ~3 GB model + uvicorn boot. Edge TTS or OpenAI TTS is one command.
2. **Fast English narration on weak hardware** — kokoro-tts is ~30 MB vs OmniVoice's 2.4 GB and runs 2× realtime on CPU. Use kokoro for blog-narration batch jobs unless you need cloning.
3. **Streaming real-time TTS** — OmniVoice is diffusion-based and not streaming. Use Edge TTS or cloud APIs for true streaming.
4. **Apple Silicon-only specialized voices** — `mlx-audio` ships 14 engines (Kokoro, CSM, Dia, Qwen3-TTS, etc.) that may match a specific voice better.

## Composition with content pipelines

OmniVoice fits between visual asset generation and video assembly:

```
research → narrative → visual assets → AUDIO (OmniVoice) → video assembly → distribution
```

Default for blog-post audio narration:

- **English, no cloning needed, fast** → kokoro-tts (cheap CPU)
- **English, want a specific cloned voice** → OmniVoice with a saved profile
- **Non-English** → OmniVoice
- **One-time, no install** → Edge TTS

For Remotion-based video pipelines that previously required ElevenLabs, OmniVoice closes the last cloud dependency — pair it with any local image/video generator for a fully self-hosted multimedia stack.
