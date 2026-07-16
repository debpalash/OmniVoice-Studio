<div align="center">
  <img src="docs/logo.png" alt="OmniVoice Logo" width="120" />
  <h1>OmniVoice Studio</h1>
  <h3>The open-source ElevenLabs alternative.</h3>
  <p>Real-time dictation, zero-shot voice cloning, and cinematic video dubbing — all on your desktop.<br/><b>No accounts. No API keys. No cloud.</b> Everything runs on your machine. Open-source, <b>646 languages.</b></p>

  <p>
    <a href="#quickstart">Quickstart</a> ·
    <a href="#features">Features</a> ·
    <a href="#why-ovs">Why OVS</a> ·
    <a href="#tts-engines">Engines</a> ·
    <a href="#openai-api">API</a> ·
    <a href="#sponsor--donate">Donate</a> ·
    <a href="#contributing">Contributing</a> ·
    <a href="https://discord.gg/bzQavDfVV9">Discord</a> ·
    <a href="README_CN.md"><strong>简体中文</strong></a>
  </p>

  <p>
    <a href="https://github.com/debpalash/OmniVoice-Studio/stargazers"><img src="https://img.shields.io/github/stars/debpalash/OmniVoice-Studio?style=flat-square&color=f59e0b" alt="Stars" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases"><img src="https://img.shields.io/github/downloads/debpalash/OmniVoice-Studio/total?style=flat-square&color=8b5cf6&label=downloads" alt="Total downloads" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/github/v/release/debpalash/OmniVoice-Studio?style=flat-square&color=10b981" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/issues"><img src="https://img.shields.io/github/issues/debpalash/OmniVoice-Studio?style=flat-square&color=ef4444" alt="Issues" /></a>
    <a href="https://discord.gg/bzQavDfVV9"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://ko-fi.com/debpalash"><img src="https://img.shields.io/badge/Ko--fi-Support_Us-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>
    <a href="https://paypal.me/palashCoder"><img src="https://img.shields.io/badge/PayPal-Donate-00457C?style=flat-square&logo=paypal&logoColor=white" alt="PayPal" /></a>
  </p>

  <p>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/badge/⬇_Download-macOS_·_Windows_·_Linux-10b981?style=for-the-badge" alt="Download the latest release" /></a>
  </p>

  <p>
    <a href="https://trendshift.io/repositories/28176?utm_source=trendshift-badge&utm_medium=badge&utm_campaign=badge-trendshift-28176" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/28176/daily?language=Python" alt="debpalash%2FOmniVoice-Studio | Trendshift" width="250" height="55"/></a>
  </p>
</div>

<br/>

<div align="center">
  <img src="docs/screenshot-launchpad.png" alt="OmniVoice Studio — Launchpad" width="100%"/>
</div>

> **Your voice is the most personal data you have. So why rent it back from a cloud?** Every mainstream voice tool ships your audio to someone else's server and bills you monthly for the privilege. OmniVoice Studio flips that: clone, design, dub, and dictate on your own hardware — 646 languages, no meter running, nothing leaving your machine.

> [!WARNING]
> **Active beta.** Things may break between releases — for the newest fixes, run from source. Bug reports and PRs are very welcome: [open an issue](https://github.com/debpalash/OmniVoice-Studio/issues) or [join Discord](https://discord.gg/bzQavDfVV9).

<a id="screenshots"></a>

## 📸 See it in action

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshot-studio.png" alt="Studio" width="100%"/>
      <br/><b>Studio</b><br/>
      <sub>Generate &amp; clone in one workspace — a 3-second clip mirrors any voice, 646 languages, zero-shot.</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshot-design.png" alt="Voice Design" width="100%"/>
      <br/><b>Voice Design</b><br/>
      <sub>Build new voices from scratch — gender, age, accent, pitch, emotion, dialect.</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/screenshot-gallery.png" alt="Voice Gallery" width="100%"/>
      <br/><b>Voice Gallery</b><br/>
      <sub>Browse ready-made archetype voices with language filters — or build your own library.</sub>
    </td>
    <td align="center">
      <img src="docs/screenshot-dub.png" alt="Video Dubbing" width="100%"/>
      <br/><b>Video Dubbing</b><br/>
      <sub>A real dub, end to end: 37 segments transcribed, translated to Bengali, re-voiced, and timed — ready to export as MP4.</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/screenshot-engines.png" alt="Settings — Engines" width="100%"/>
      <br/><b>Settings → Engines</b><br/>
      <sub>The engine compatibility matrix — 14 TTS engines with per-engine GPU preflight, no silent CPU fallback.</sub>
    </td>
    <td align="center">
      <img src="docs/screenshot-settings.png" alt="Settings — Models" width="100%"/>
      <br/><b>Settings → Models</b><br/>
      <sub>One-click model store — auto-detects your platform (CUDA / MPS / CPU) and recommends the right models.</sub>
    </td>
  </tr>
</table>

---

<a id="features"></a>

## ✨ Features

The eight headliners — and twelve more waiting under the fold.

<table>
<tr>
  <td align="center" width="25%">
    <h3>🎙️ Voice Cloning</h3>
    <p>3-second clip → mirror any voice.<br/><b>646 languages</b>, zero-shot.</p>
  </td>
  <td align="center" width="25%">
    <h3>🎨 Voice Design</h3>
    <p>Gender, age, accent, pitch, speed,<br/>emotion, dialect — <b>dial it in</b>.</p>
  </td>
  <td align="center" width="25%">
    <h3>🎬 Video Dubbing</h3>
    <p>YouTube URL or file → transcribe →<br/>translate → re-voice → <b>MP4</b>.</p>
  </td>
  <td align="center" width="25%">
    <h3>📖 Audiobook Editor</h3>
    <p>Import text, EPUB, or PDF. Auto-chapter,<br/>loudnorm, metadata. Export <b>.m4b</b>.</p>
  </td>
</tr>
<tr>
  <td align="center" valign="top">
    <h3>🎭 Stories</h3>
    <p>Multi-voice editor. Assign voices<br/>per-line, preview, <b>export full cast</b>.</p>
  </td>
  <td align="center" valign="top">
    <h3>⌨️ Dictation Widget</h3>
    <p><kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>Space</kbd> from <b>any app</b>.<br/>Transcribes, auto-pastes, disappears.</p>
  </td>
  <td align="center" valign="top">
    <h3>🔐 100% Local</h3>
    <p>No keys, no cloud, no accounts.<br/><b>Your machine only</b>.</p>
  </td>
  <td align="center" valign="top">
    <h3>🤖 MCP Server</h3>
    <p>Use OmniVoice from <b>Claude</b>,<br/>Cursor, or any MCP client.</p>
  </td>
</tr>
</table>

<details>
<summary><b>…and 12 more</b> — isolation, diarization, batch, watermarking, diagnostics, and friends</summary>

<br/>

- 🔊 **Vocal Isolation** — Demucs-powered: splits speech from music and keeps the background bed.
- 👥 **Speaker Diarization** — Pyannote + WhisperX auto-identify who said what.
- 📦 **Batch Queue** — drop 50 videos, walk away; per-job progress bars.
- 🛡️ **AI Watermark** — AudioSeal (Meta): invisible, survives compression.
- 🔬 **Diagnostics** — self-check suite, error journal, scrubbed diagnostic bundles.
- ⚡ **GPU Auto-Detect** — CUDA · MPS · ROCm (Linux, opt-in) · CPU; ≤8 GB VRAM auto-offloads.
- 🧭 **Engine routing** — preflight GPU check per engine; no silent CPU fallback.
- 🧩 **Extensible** — subclass `TTSBackend`, add any engine in ~50 lines.
- 🎒 **Portable personas** — export voices as `.ovsvoice` bundles: identity + watermark.
- ♾️ **Unlimited TTS** — sentence-chunked generation, no length cap, streaming via WebSocket.
- 🌐 **Remote backend** — point the UI at a remote server; Tailscale-friendly, bearer auth.
- 🧠 **Dictation + LLM** — local-LLM cleanup of transcripts, optional echo cancellation.

</details>

---

<a id="quickstart"></a>

## ⚡ Quickstart

<div align="center">
  <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/badge/macOS-DMG_(Apple_Silicon)-000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS DMG" /></a>
  <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/badge/Windows-MSI_(x64)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows MSI" /></a>
  <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/badge/Linux-AppImage_(x64)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download Linux AppImage" /></a>
  <br/>
  <sub><b>macOS:</b> first launch needs a one-time approval — right-click → <b>Open</b> (or System Settings → Privacy &amp; Security → <b>"Open Anyway"</b> on macOS 15). No Terminal needed. <a href="docs/install/macos.md#gatekeeper-quarantine">Why?</a> · <b>Intel Macs:</b> local backend unsupported (<a href="https://github.com/debpalash/OmniVoice-Studio/issues/889">#889</a>) — <a href="docs/install/macos.md">details</a>.</sub>
</div>

Pick your OS and follow the guide end-to-end:

- 🍎 **macOS** — [docs/install/macos.md](docs/install/macos.md)
- 🪟 **Windows** — [docs/install/windows.md](docs/install/windows.md)
- 🐧 **Linux** — [docs/install/linux.md](docs/install/linux.md)
- 🐳 **Docker** — [docs/install/docker.md](docs/install/docker.md) · [Docker Hub: `palashdeb/omnivoice-studio`](https://hub.docker.com/r/palashdeb/omnivoice-studio)

Feels slow? [docs/performance.md](docs/performance.md) covers where generation time actually goes, the tuning knobs, and the three classic causes of "it got slow".

> Coming from **[CorentinJ/Real-Time-Voice-Cloning](https://github.com/CorentinJ/Real-Time-Voice-Cloning)** (now archived)? There's a dedicated migration guide: [docs/migration/real-time-voice-cloning.md](docs/migration/real-time-voice-cloning.md).

<details>
<summary><b>🧰 Stuck? Self-checks, tokens &amp; restricted networks</b></summary>

<br/>

Run the built-in self-check first — **Settings → About → "Run
self-check"** in the app, or `uv run python backend/main.py --diagnose` from
a checkout (`--deep` also test-loads the active engine). Then see
[docs/install/troubleshooting.md](docs/install/troubleshooting.md) for the
top 10 install errors. The in-app error UI deeplinks to those entries when
something breaks at runtime, and **Settings → About → "Save diagnostic
bundle"** packages scrubbed logs + the self-check report for bug reports.

For Hugging Face token setup, see
[docs/setup/huggingface-token.md](docs/setup/huggingface-token.md). For
diarization-specific gating, see
[docs/features/diarization.md](docs/features/diarization.md). For download
speed, the ⚡ fast-download (Xet) status, and restricted-network / mirror
options, see [docs/downloading-models.md](docs/downloading-models.md).

</details>

---

<a id="why-ovs"></a>

## 💡 Why OmniVoice?

ElevenLabs charges **$5–$330/mo** and processes your audio on their servers. OmniVoice Studio runs **on your hardware, with no usage limits.**

| | **ElevenLabs** | **OmniVoice Studio** |
|---|---|---|
| **Pricing** | $5–$330/mo, per-character billing | Free & open-source (AGPL-3.0) · [Commercial license](#license) for proprietary use |
| **Voice Cloning** | ✅ 3s clip | ✅ 3s clip, zero-shot |
| **Voice Design** | ✅ Gender, age | ✅ Gender, age, accent, pitch, style, dialect |
| **Audiobook / Stories** | ❌ | ✅ Full audiobook editor + multi-voice stories (EPUB/PDF import, .m4b export) |
| **Languages** | 32 | **646** |
| **Video Dubbing** | ✅ Cloud-only | ✅ Fully local |
| **Data Privacy** | Audio sent to cloud | **Nothing leaves your machine** |
| **API Keys** | Required | Not needed |
| **GPU Support** | N/A (cloud) | CUDA · Apple Silicon · ROCm (Linux) · CPU |
| **Desktop App** | ❌ | ✅ macOS · Windows · Linux |
| **TTS Engines** | 1 | **14** — [full matrix](#tts-engines) |
| **ASR Engines** | 1 | **10** — [full lineup](#asr-engines) |
| **MCP Server** | ❌ | ✅ Use from Claude, Cursor, any MCP client |
| **Self-check** | ❌ | ✅ Diagnostics suite, error journal, scrubbed debug bundles |
| **Customizable** | ❌ Closed | ✅ Fork it, extend it, ship it |

Professional-grade voice AI, minus the subscription and the cloud.

<div align="center">
  <br/>
  <b>Convinced? Come build with us.</b><br/>
  <a href="https://discord.gg/bzQavDfVV9"><img src="https://img.shields.io/badge/Join_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord" /></a>
  <br/><br/>
</div>

---

## 🖥️ System Requirements

| | **Minimum** | **Recommended** |
|---|---|---|
| **OS** | Windows 10, macOS 12+ (Apple Silicon), Ubuntu 24.04+ (glibc 2.39+) | Any modern 64-bit OS |
| **RAM** | 8 GB | 16 GB+ |
| **VRAM (GPU)** | 4 GB (auto-offloads TTS to CPU) | 8 GB+ (NVIDIA RTX 3060+) |
| **Disk** | 10 GB free (models + cache) | 20 GB+ SSD |
| **Python** | 3.10+ (managed by `uv`) | 3.11–3.12 |
| **GPU** | Optional — CPU works | NVIDIA CUDA · Apple Silicon MPS · AMD ROCm (Linux only) |

> [!TIP]
> On GPUs with **≤8 GB VRAM**, OmniVoice automatically offloads TTS to CPU during transcription — no config needed. A dedicated GPU is not required; the entire pipeline runs on CPU (just slower).

> [!NOTE]
> **AMD GPUs:** ROCm acceleration is **Linux-only and opt-in** — pick **"AMD GPU (ROCm)"** on the first-run setup screen or set `OMNIVOICE_TORCH_VARIANT=rocm` ([docs/install/linux.md](docs/install/linux.md#amd-gpu-rocm)). In **Docker/Podman**, pull the dedicated ROCm image instead: `ghcr.io/debpalash/omnivoice-studio:rocm` ([docs/install/docker.md](docs/install/docker.md#pull-and-run-amd-gpu--rocm)). **On Windows, AMD GPUs (incl. Ryzen AI iGPUs) run CPU-only**: PyTorch has no Windows ROCm wheels, so Windows GPU acceleration is NVIDIA/CUDA-only ([docs/install/windows.md](docs/install/windows.md#gpu-support)).

> [!IMPORTANT]
> **macOS Intel (x86_64) is unsupported for the local backend:** the app UI installs, but the Python backend cannot run because PyTorch no longer ships Intel-Mac wheels ([#889](https://github.com/debpalash/OmniVoice-Studio/issues/889)). Intel-Mac users can still point the UI at a remote backend on another machine — see [docs/install/macos.md](docs/install/macos.md).

<a id="tts-engines"></a>

### 🗣️ TTS Engines

**14 engines, one picker.** OmniVoice (default, 600+ languages) is always available; seven more are opt-in and auto-detected (CosyVoice 3, GPT-SoVITS, VoxCPM2, MOSS-TTS-Nano, KittenTTS, MLX-Audio, Sherpa-ONNX), plus six lazy-installed heavyweights (IndexTTS 2, OmniVoice GGUF, Supertonic 3, MOSS-TTS-v1.5, dots.tts, Confucius4-TTS). Switch in **Settings → TTS Engine**; the choice applies everywhere synthesis happens.

<details>
<summary><b>📊 The full matrix</b> — 14 engines × platform × clone/instruct × license</summary>

<br/>

| Engine | Languages | Clone | Instruct | Linux | macOS ARM | Windows | License |
|--------|:---------:|:-----:|:--------:|:-----:|:---------:|:-------:|:-------:|
| **OmniVoice** (default) | 600+ | ✅ | ✅ | ✅ CUDA/CPU | ✅ MPS | ✅ CUDA/CPU | Built-in |
| **CosyVoice 3** | 9 + 18 dialects | ✅ | ✅ | ✅ CUDA/CPU | ✅ MPS | ✅ CUDA/CPU | Apache-2.0 |
| **GPT-SoVITS** | 5 | ✅ | — | ✅ CUDA/CPU | — | ✅ CUDA/CPU | MIT |
| **VoxCPM2** | 30 | ✅ | ✅ | ✅ CUDA/CPU | ✅ MPS | ✅ CUDA/CPU | Apache-2.0 |
| **MOSS-TTS-Nano** | 20 | ✅ | — | ✅ CUDA/CPU | ✅ CPU | ✅ CUDA/CPU | Apache-2.0 |
| **KittenTTS** | English | — | — | ✅ CPU | ✅ CPU | ✅ CPU | MIT |
| **MLX-Audio** (Kokoro, Qwen3-TTS, CSM, Dia, …) | Multi | Varies | Varies | ❌ | ✅ Native | ❌ | Varies |
| **Sherpa-ONNX** | 20+ | — | — | ✅ CUDA/CPU | ✅ CPU | ✅ CUDA/CPU | Apache-2.0 |
| **IndexTTS 2** ⚡ | Multi | ✅ | — | ✅ CUDA | — | ✅ CUDA | Apache-2.0 |
| **OmniVoice GGUF** ⚡ | 600+ | ✅ | ✅ | ✅ CPU | ✅ CPU | ✅ CPU | Built-in |
| **Supertonic 3** ⚡ | 31 | — | — | ✅ CPU | ✅ CPU | ✅ CPU | OpenRAIL-M |
| **MOSS-TTS-v1.5** ⚡ (8B) | 31 | ✅ | — | ✅ CUDA/CPU | ✅ CPU | ✅ CUDA/CPU | Apache-2.0 |
| **dots.tts** ⚡ (2B) | 24 | ✅ | — | ✅ CUDA/CPU | ✅ CPU | ❌ | Apache-2.0 |
| **Confucius4-TTS** ⚡ | 14 | ✅ | — | ✅ CUDA/CPU | ✅ CPU | ✅ CUDA/CPU | Apache-2.0 |

> **CUDA** = GPU-accelerated · **MPS** = Apple Silicon Metal · **CPU** = runs everywhere, slower for large models · KittenTTS and MOSS-TTS-Nano run realtime on CPU · MLX-Audio is Apple Silicon only · ⚡ = lazy-registered (installed on first use)
>
> **Clone** matters beyond single-clip generation: Video Dubbing (and any Batch job with a pinned voice) needs reference-audio cloning to preserve speaker identity, so picking a Clone-less engine (KittenTTS, Sherpa-ONNX, Supertonic 3) as the active engine fails those jobs up front with an actionable message instead of silently falling back to OmniVoice.
>
> **MOSS-TTS-v1.5** (8B, ~16 GB), **dots.tts** (2B, ~9 GB), and **Confucius4-TTS** are heavyweight opt-ins that run in their own isolated venv from a local clone. None claims Apple-Silicon MPS (CPU on Macs); dots.tts has no Windows path; Confucius4 wants CUDA (CPU works, ~17× realtime). Details: [MOSS-TTS-v1.5](docs/engines/moss-tts-v15.md) · [dots.tts](docs/engines/dots-tts.md) · [Confucius4-TTS](docs/engines/confucius4-tts.md).

</details>

<a id="asr-engines"></a>

### 🎧 ASR Engines

**10 engines** — they power dictation, video dubbing, and subtitles. **WhisperX** is the cross-platform default (~100 languages, word-level timing); the rest are opt-in and auto-detected. Switch in **Settings → Engines**. Nine run fully on-device; the tenth (OpenAI-compatible) is an optional remote client for Qwen3-ASR or any compatible server.

<details>
<summary><b>📊 The full lineup</b> — 10 engines, what each is best at, and compute-type notes</summary>

<br/>

| Engine | `OMNIVOICE_ASR_BACKEND` | Languages | Best for |
|--------|-------------------------|:---------:|----------|
| **WhisperX** (default) | `whisperx` | ~100 | Dubbing & subtitles — word-level timing via wav2vec2 forced alignment |
| **Faster-Whisper** | `faster-whisper` | ~100 | Fast transcription on Linux / macOS / Windows (CTranslate2) |
| **Faster-Whisper (isolated)** | `faster-whisper-isolated` | ~100 | Same as Faster-Whisper but crash-isolated in a subprocess — an ASR crash won't take down the app |
| **MLX Whisper** | `mlx-whisper` | ~100 | Native Apple Silicon speed (Apple MLX / Metal) |
| **PyTorch Whisper** | `pytorch-whisper` | ~100 | CUDA / CPU fallback via 🤗 Transformers (no cuDNN 8 needed) |
| **Parakeet TDT** | `nemo-parakeet` | English + 25 EU | SOTA accuracy at ~10× realtime even on CPU, auto language detection (NVIDIA NeMo, CUDA/CPU) |
| **Moonshine** | `moonshine` | English | Edge / low-latency, ONNX |
| **FunASR** | `funasr` | 50+ | All-in-one multilingual — built-in VAD + inline speaker diarization (SenseVoice) |
| **sherpa-onnx** (live dictation) | `sherpa-onnx-asr` | 25 EU + 90+ | Live, faster-than-real-time dictation — small streaming/offline ONNX models (Parakeet TDT v3/v2, streaming Zipformer & Paraformer, Whisper Tiny), CPU, identical on macOS / Windows / Linux. Picked per-model in **Settings → Voice**. |
| **OpenAI-compatible** ⚠️ remote | `openai-compat-asr` | Server-dependent | A path to **Qwen3-ASR** today (self-hosted server, no transformers wait), any OpenAI-compatible transcription endpoint, or OpenAI's own API — no install, configure + test the connection in **Settings → Engines** (ASR tab). Audio leaves your machine to whatever server you point it at; see [docs/engines/openai-compatible-asr.md](docs/engines/openai-compatible-asr.md). |

> Whisper-family engines cover ~100 languages; **FunASR / SenseVoice** adds an all-in-one multilingual path with built-in voice-activity detection and inline speaker diarization. **sherpa-onnx** powers the live dictation model picker — you talk and text appears as you speak. Every engine runs on-device — no API keys, no cloud.

> **GPU without efficient float16?** On older NVIDIA GPUs (Maxwell/Pascal, GTX 16xx) or after a CTranslate2/cuDNN mismatch, the CTranslate2 ASR engines (WhisperX, Faster-Whisper) can't run `float16` and OmniVoice automatically retries on `int8` — no config needed. If transcription still fails, pin the compute type with the `ASR_COMPUTE_TYPE` env var (escape hatch): `ASR_COMPUTE_TYPE=int8` (or `float32` for CPU). Set it to `int8` and restart the backend.

</details>

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React)                          │
│  DubTab · VoiceConsole · Stories · Audiobook · Gallery     │
│  Dictation · BatchQueue · Diagnostics · MCP Client          │
├─────────────────────────────────────────────────────────────┤
│                  Backend (FastAPI)                           │
│  100+ API endpoints · SSE+WSS streaming · SQLite            │
├──────────┬──────────┬──────────┬──────────┬────────────────┤
│ WhisperX │  Demucs  │OmniVoice │ Pyannote │ Engine Routing  │
│  (+7 ASR │  Source  │  (+10    │ Diariz-  │ ↳ GPU preflight │
│ engines) │  Sep.    │  TTS)    │ ation    │ ↳ No silent CPU │
└──────────┴──────────┴──────────┴──────────┴────────────────┘
         CUDA / MPS / ROCm / CPU (auto-detected + routed)
```

<a id="openai-api"></a>

## 🔌 OpenAI-compatible API

Already have a script, agent, or tool that speaks OpenAI's audio API? Point it at `http://localhost:3900/v1` — no key needed, no code changes. The backend ships a drop-in surface for the audio endpoints, wired to whichever TTS/ASR engine you have active (and yes, `voice` accepts your cloned voice-profile IDs).

| Endpoint | What it does |
|---|---|
| `POST /v1/audio/speech` | TTS — text in; `mp3` / `wav` / `flac` / `opus` / `pcm` out. `tts-1` / `tts-1-hd` map to your active engine; OpenAI voice names (`alloy`, …) are accepted. |
| `POST /v1/audio/transcriptions` | STT — audio file in; `json`, `text`, `verbose_json`, `srt`, or `vtt` out. `whisper-1` maps to your active ASR engine. |
| `GET /v1/audio/voices` | OmniVoice extension — lists every voice profile and engine, so clients can discover your clones. |

```sh
curl http://localhost:3900/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "tts-1", "voice": "alloy", "input": "Generated on my own hardware.", "response_format": "wav"}' \
  --output speech.wav
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3900/v1", api_key="none")  # any string works — nothing checks it

result = client.audio.transcriptions.create(model="whisper-1", file=open("clip.wav", "rb"))
print(result.text)
```

Want the whole surface (100+ endpoints)? The full REST API reference is embedded in the app — **Settings → OpenAPI Reference** (Scalar-powered), or the `{}` button in the footer.

### 📓 Run on Google Colab

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/debpalash/OmniVoice-Studio/blob/main/notebooks/OmniVoice_Studio_Colab.ipynb)

No local GPU? The official notebook ([notebooks/OmniVoice_Studio_Colab.ipynb](notebooks/OmniVoice_Studio_Colab.ipynb)) boots the full app — web UI included — on a free Colab T4: it builds the frontend in-notebook, installs the backend with uv (reusing Colab's preinstalled CUDA PyTorch), and opens the UI through Colab's built-in port proxy. No third-party tunnels, no API keys. It then walks the whole feature surface as a guided API tour with inline playback: multilingual TTS, voice cloning and design, saved voice profiles, transcription, AI-watermark detection, the OpenAI-compatible API, a multi-voice story, a chaptered m4b audiobook, and a miniature video dub with vocal-isolation stems.

### 🤝 Agent Skills

Teach your AI agent (Claude Code, Cursor, Codex, …) to use OmniVoice with one command:

```sh
npx skills add debpalash/omnivoice-studio
```

Ships two [skills](https://skills.sh): **`omnivoice`** — speak and transcribe through your local install (including your cloned voices) from any agent, free and offline; and **`oss-maintainer`** — the maintainer methodology this project is run with, for anyone running their own OSS project with an agent.

---

## 🗺️ Roadmap

### 🔜 Up Next

- 🎬 **Lip-sync v2** — visual speech timing with wav2lip
- 🌐 **Hosted Demo** — try OmniVoice without installing anything
- 🔌 **Plugin Marketplace** — community-contributed TTS engines and effects
- 🎵 **Real-time Voice Changer** — live microphone transformation during calls

<details>
<summary><b>✅ Everything shipped so far</b> — the receipts, by category</summary>

<br/>

| Category | Features |
|----------|----------|
| **Longform** | Audiobook editor (text/EPUB/PDF → chaptered .m4b), Stories multi-voice editor, two-pass loudnorm mastering, crash-resume for interrupted renders, pronunciation control + SSML-lite prosody |
| **Dubbing** | Full pipeline (transcribe→translate→synthesize→mux), scene-aware splitting, lip-sync scoring, streaming TTS, per-speaker voice assignment, Smart Fit timing + second-pass QC, dedicated Dub home |
| **Voice** | Zero-shot cloning, voice design, A/B comparison, voice preview widget, gallery with favorites/tags, portable persona bundles (`.ovsvoice`), voice console workspace |
| **Audio** | Demucs vocal isolation, per-segment gain, selective track export, stem/SRT/VTT/MP3 export, unlimited-length TTS via sentence-chunked generation |
| **Multi-Lang** | Multi-language batch picker, batch dubbing queue with sequential GPU execution |
| **Diarization** | Pyannote ML diarization, auto speaker clone extraction, per-speaker voice assignment |
| **ASR** | 9 engines (WhisperX, Faster-Whisper, isolated Faster-Whisper, MLX Whisper, PyTorch Whisper, Parakeet TDT, Moonshine, FunASR/SenseVoice, sherpa-onnx live dictation), crash-isolated subprocess backend |
| **TTS** | 14 engines (OmniVoice, CosyVoice 3, GPT-SoVITS, VoxCPM2, MOSS-TTS-Nano, KittenTTS, MLX-Audio, Sherpa-ONNX, + lazy: IndexTTS 2, OmniVoice GGUF, Supertonic 3, MOSS-TTS-v1.5, dots.tts, Confucius4-TTS), engine routing with GPU preflight |
| **Infra** | Docker deployment, CUDA/MPS/ROCm auto-detect, cuDNN 8 compat, VRAM-aware model offloading, engine routing (no silent CPU fallback), diagnostics suite & error journal, restricted-network mirror support |
| **AI Provenance** | AudioSeal invisible watermarking (SynthID-like), video logo overlay, watermark detection API |
| **UX** | Undo/redo, keyboard shortcuts, drag-and-drop, session persistence, glassmorphism design system, UI scale fix for Linux/WebKitGTK |
| **Real-time Events** | WebSocket event bus — instant sidebar refresh on data mutations, exponential backoff reconnect |
| **State Management** | Zustand store migration — `uiSlice`, `pillSlice`, `dubSlice`, `generateSlice`, `prefsSlice`, `glossarySlice` |
| **Desktop** | Cross-platform Tauri installers (macOS DMG — Apple Silicon; Intel unsupported for the local backend, #889 — Windows MSI, Linux deb/AppImage), auto-update infrastructure, single-instance enforcement, close-to-tray, macOS Gatekeeper fix |
| **Dictation** | Global system-wide hotkey (`⌘+⇧+Space`), frameless floating widget, streaming ASR via WebSocket, auto-paste, customizable hotkey, local-LLM transcript refinement |
| **Batch Pipeline** | Full batch TTS: extract → transcribe → translate → generate → mix → export, with live progress tracking |
| **MCP Server** | OmniVoice as a local TTS/STT provider for Claude, Cursor, and any MCP client |
| **Remote Backend** | Point the desktop UI at a remote backend URL with bearer auth (Tailscale-documented) |
| **Reliability** | Stall watchdog on bootstrap splash, per-engine GPU compatibility matrix, actionable errors for non-executable engine binaries, setuptools auto-repair |

</details>

---

<a id="sponsor--donate"></a>

## 💜 Sponsor / Donate

OmniVoice Studio is built by one developer using Claude Code and AI agents — and the agent bills are real (thousands of dollars over the last three months). If OmniVoice has created value for you, covering a slice of those bills keeps development full-time.

<div align="center">

**This month's agent bill fund**

<img src="https://img.shields.io/badge/raised_%2410_of_%24200-5%25-EAB308?style=for-the-badge" alt="$10 / $200 raised" />

<br/><br/>

<a href="https://ko-fi.com/debpalash"><img src="https://img.shields.io/badge/Ko--fi-Support_❤️-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>
&nbsp;&nbsp;
<a href="https://paypal.me/palashCoder"><img src="https://img.shields.io/badge/PayPal-Donate-00457C?style=for-the-badge&logo=paypal&logoColor=white" alt="PayPal" /></a>

<br/>
<sub>Every dollar goes directly to agent bills — keeping OmniVoice development continuous.</sub>

<br/><br/>

<sub><b>More apps from the creator of OmniVoice Studio</b> — same local-first philosophy:
<a href="https://github.com/debpalash/Opal"><b>Opal</b> 💠</a> (play everything — the media player for the AI era) ·
<a href="https://github.com/debpalash/memxt"><b>memxt</b> 🧠</a> (local memory for Claude Code & coding agents).
A ⭐ on those helps too → <a href="#more-from-the-maker">details below</a>.</sub>

</div>

<a id="sponsors"></a>

### 🌟 Sponsors

OmniVoice is **free** and **AGPL-3.0** — no paid tier, no SaaS revenue. Sponsors keep development going, and in return get a logo slot here, in the app, and (for top tiers) on the project website. It's a thank-you, never a paywall. **[See tiers & become a sponsor →](SPONSORS.md)**

<div align="center">

<!-- SPONSORS:START — logo slots are filled here as sponsors come aboard; see SPONSORS.md -->

**Your logo here** — [become a sponsor](SPONSORS.md)

<!-- SPONSORS:END -->

</div>

<sub>💡 GitHub also shows a **Sponsor** button at the top of this repo, wired to the same links via <a href=".github/FUNDING.yml"><code>.github/FUNDING.yml</code></a>.</sub>

---

## 💬 Community

<div align="center">
  <a href="https://discord.gg/bzQavDfVV9"><img src="https://img.shields.io/badge/💬_Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord" /></a>
  <br/>
  <sub>We respond to setup questions within hours, not days.</sub>
</div>

<details>
<summary><b>What happens in there</b></summary>

<br/>

| Channel | What happens there |
|---------|--------------------|
| `#announcements` | Release news and the big moments — new versions land here first |
| `#releases` + `#changelog` | Every build and exactly what's inside it |
| `#issues` | Bug reports as forum posts — triaged straight into GitHub issues |
| `#ideas` | Feature requests, discussed and voted on |
| `#discuss-ideas` | Design talk before things get built |
| `#general` | Setup help, GPU troubleshooting, and showing off your dubs |

</details>

---

<a id="contributing"></a>

## 🤝 Contributing

Yes please — bug fixes, new TTS engine adapters, UI improvements, docs, translations. All of it.

- 📖 Read the **[Contributing Guide](CONTRIBUTING.md)** for setup, code style, and PR workflow
- 🐛 Browse [good first issues](https://github.com/debpalash/OmniVoice-Studio/labels/good%20first%20issue)
- 💬 Join our [Discord](https://discord.gg/bzQavDfVV9) to discuss ideas or ask for help

---

## ❓ FAQ

<details>
<summary><b>Is this really as good as ElevenLabs?</b></summary>
<br/>
Honest answer: <b>it depends on what you're doing.</b>

<b>Where OmniVoice is genuinely competitive:</b> voice cloning from a clean reference clip (state-of-the-art open diffusion TTS), language coverage (646 languages vs. their 32), and everything structural — no per-character billing, no usage caps, no audio leaving your machine, full pipeline customizability (14 TTS engines, 10 ASR engines, your choice of translation).

<b>Where ElevenLabs still wins:</b> out-of-the-box consistency and polish, especially for English TTS. Their one model is heavily tuned; our quality depends on which engine you pick, your hardware, and — for cloning — the reference audio (a dry, close-mic clip clones dramatically better than a noisy or echoey one).

<b>For dubbing specifically:</b> a dub is a chain — transcription → translation → cloning → synthesis — only as good as its weakest link on <i>your</i> source material. If parts come out incoherent, check the segment table's <i>original</i> text first: when the transcription is already wrong, switch the ASR engine or use cleaner source audio — that's usually the fix, not the voice.

Try it on your real material — it's free and takes one download. Many users replace ElevenLabs outright; some keep both. Both outcomes are fine with us.
</details>

<details>
<summary><b>Does it work on Apple Silicon (M1/M2/M3/M4)?</b></summary>
<br/>
Yes. MPS acceleration is auto-detected. MLX-optimized Whisper models are available for faster transcription on Apple hardware. <b>Intel Macs are not supported</b>: the app UI installs, but the local Python backend cannot run because PyTorch no longer ships Intel-Mac wheels (<a href="https://github.com/debpalash/OmniVoice-Studio/issues/889">#889</a>) — an Intel Mac can only be used with a remote backend.
</details>

<details>
<summary><b>How much VRAM do I need?</b></summary>
<br/>
<b>4 GB minimum.</b> With ≤8 GB, the TTS model is automatically offloaded to CPU during transcription. With 8+ GB, everything runs on GPU simultaneously. No GPU at all? CPU mode works — just slower (~3× for TTS).
</details>

<details>
<summary><b>Can I use this commercially?</b></summary>
<br/>
<b>Yes — commercial use is free</b> under the <a href="https://www.gnu.org/licenses/agpl-3.0.html">AGPL-3.0</a>: run it, sell the audio you make, dub client videos, deploy it across your team. One obligation: if you <b>modify</b> OmniVoice and offer the modified version to others over a network, you must share that modified source under the same terms. Embedding it in a closed-source product instead? A commercial license is available — see <a href="#license">License</a>.
</details>

<details>
<summary><b>What languages are supported?</b></summary>
<br/>
646 languages for TTS via the OmniVoice model. Transcription (WhisperX) supports 99 languages. Translation coverage depends on the target language pair.
</details>

<details>
<summary><b>Can I add my own TTS engine?</b></summary>
<br/>
Yes. Subclass <code>TTSBackend</code> in <code>backend/services/tts_backend.py</code> and add it to the <code>_REGISTRY</code> dictionary — ~50 lines. The fourteen built-in engines all work this way; see <a href="#tts-engines">TTS Engines</a>.
</details>

<details>
<summary><b>Does OmniVoice collect any data about me?</b></summary>
<br/>
<b>Not unless you explicitly say yes.</b> On first run the app <i>asks</i> — one screen, two equal-weight buttons, no pre-ticked box — and until you answer yes, OmniVoice sends nothing: no analytics, no telemetry, no accounts, no phone-home. Skipping the question means no. Your text, audio, voices, and projects never leave your machine either way.

If you do opt in (also togglable anytime under <b>Settings → Privacy → "Help improve OmniVoice"</b>), what's sent is anonymous, content-free usage stats: generations (engine, language, generation time, character <i>count</i>, error <i>type</i>), plus app lifecycle — an install ping, updates (version-to-version), crashes (error class and a <i>bucketed</i> uptime, never logs), error <i>types</i> (capped, deduplicated), and a single uninstall ping if you remove it. Never your text, audio, file names, or anything identifying — enforced in code by a property allowlist (<code>backend/core/analytics.py</code>), not just a promise. Source builds have no analytics destination at all, so they never even ask. Your own numbers live in <b>Settings → Usage</b>, computed locally, sent nowhere.
</details>

<details>
<summary><b>How do I uninstall it / remove all its data?</b></summary>
<br/>
OmniVoice is fully local — uninstalling is just deleting the app plus the folders it wrote (model cache, Python env, your voices/projects, config). Run <code>scripts/uninstall.sh</code> (macOS/Linux) or <code>scripts\uninstall.ps1</code> (Windows) — it prints every folder with its size as a dry-run first, then deletes on <code>--yes</code>. The full per-platform path list and app-removal steps are in <a href="docs/install/uninstall.md"><b>docs/install/uninstall.md</b></a>.
</details>

---

<a id="license"></a>

## 📜 License

OmniVoice Studio is free and open-source software under the [**GNU Affero General Public License v3.0 (AGPL-3.0)**](https://www.gnu.org/licenses/agpl-3.0.html).

**Free for any use — including commercial and internal business use.** Run it, sell the audio you produce with it, dub your own or clients' videos, roll it out across your team — all free, no license needed. As a **network copyleft** license, AGPL adds one obligation: if you **modify** OmniVoice Studio and offer that modified version to others over a network, you must make the complete corresponding source of your modified version available to them under the same AGPL-3.0 terms.

A **commercial license** is available for organizations that want to embed OmniVoice Studio in a **closed-source or proprietary** product or service without the AGPL-3.0 copyleft obligations. **Pricing tiers coming soon.** Inquiries: **OmniVoice@palash.dev**.

The bundled `omnivoice/` TTS model by Han Zhu remains Apache-2.0 upstream. See [`LICENSE`](LICENSE) for the full, binding terms, and [`LICENSE-NOTICE.md`](LICENSE-NOTICE.md) for the plain-language summary and scope.

---

## 🙏 Acknowledgments

OmniVoice Studio is built on the shoulders of exceptional open-source work:

| Project | Role |
|---------|------|
| [**OmniVoice (k2-fsa)**](https://github.com/k2-fsa/OmniVoice) | Zero-shot diffusion TTS engine — the core voice synthesis model |
| [**WhisperX**](https://github.com/m-bain/whisperX) | Word-level speech recognition and alignment |
| [**Demucs (Meta)**](https://github.com/facebookresearch/demucs) | Music source separation for vocal isolation |
| [**Pyannote**](https://github.com/pyannote/pyannote-audio) | Speaker diarization — who said what |
| [**CTranslate2**](https://github.com/OpenNMT/CTranslate2) | Optimized Transformer inference on CPU and GPU |
| [**AudioSeal (Meta)**](https://github.com/facebookresearch/audioseal) | Invisible neural audio watermarking for AI provenance |
| [**Tauri**](https://tauri.app) | Native desktop app framework |
| [**Supertone / Supertonic 3**](https://huggingface.co/Supertone/supertonic-3) | ONNX TTS engine — 31 languages, CPU-efficient |
| [**Sherpa-ONNX**](https://github.com/k2-fsa/sherpa-onnx) | WASM-ready universal TTS/ASR runtime |
| [**GPT-SoVITS**](https://github.com/RVC-Boss/GPT-SoVITS) | Zero-shot TTS engine — 5 languages, RTF 0.014 |

---

<a id="more-from-the-maker"></a>

## 🧰 More local open-source from the maker

Like the local-first philosophy? It runs in the family — same maker, same rule: **your data stays on your machine.**

<table>
<tr>
<td align="center" width="50%" valign="top">
  <br/>
  <a href="https://github.com/debpalash/Opal"><img src="https://raw.githubusercontent.com/debpalash/Opal/main/assets/opal_logo.png" width="96" alt="Opal logo"/></a>
  <h3><a href="https://github.com/debpalash/Opal">Opal 💠</a></h3>
  <p><b>Play everything.</b> The media player for the AI era.</p>
  <p><sub>Video, anime, comics, torrents, Jellyfin & Plex — one player for all of it, with local AI memory and context built in. Written in Zig, runs on macOS & Windows.</sub></p>
  <p>
    <a href="https://github.com/debpalash/Opal/stargazers"><img src="https://img.shields.io/github/stars/debpalash/Opal?style=flat-square&color=f59e0b" alt="Opal stars"/></a>
    <a href="https://palash.dev/opal"><img src="https://img.shields.io/badge/site-palash.dev%2Fopal-8b5cf6?style=flat-square" alt="Opal website"/></a>
  </p>
</td>
<td align="center" width="50%" valign="top">
  <br/>
  <a href="https://github.com/debpalash/memxt"><img src="https://raw.githubusercontent.com/debpalash/memxt/main/assets/logo-mark.svg" width="96" alt="memxt logo"/></a>
  <h3><a href="https://github.com/debpalash/memxt">memxt 🧠</a></h3>
  <p><b>The fastest benchmarked open-source AI memory system.</b></p>
  <p><sub>Local long-term memory for Claude Code and coding agents — an MCP server on SQLite + embeddings, 100% on your machine. Your agent finally remembers yesterday.</sub></p>
  <p>
    <a href="https://github.com/debpalash/memxt/stargazers"><img src="https://img.shields.io/github/stars/debpalash/memxt?style=flat-square&color=f59e0b" alt="memxt stars"/></a>
    <a href="https://github.com/debpalash/memxt#readme"><img src="https://img.shields.io/badge/docs-README-10b981?style=flat-square" alt="memxt docs"/></a>
  </p>
</td>
</tr>
</table>

---

<div align="center">

<br/>

If you read this far, you're our kind of person.<br/>
**[⭐ Star this repo](https://github.com/debpalash/OmniVoice-Studio)** so others can find it too.<br/>
**[💬 Join the Discord](https://discord.gg/bzQavDfVV9)** to share what you build.<br/>
**[❤️ Support development](https://ko-fi.com/debpalash)** — fund the AI agent bills that keep OmniVoice shipping.

<br/>

  <a href="https://star-history.com/#debpalash/OmniVoice-Studio&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date" />
      <img alt="Star History" src="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" width="600" />
    </picture>
  </a>
</div>
