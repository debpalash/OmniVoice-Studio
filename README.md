<div align="center">
  <img src="docs/logo.png" alt="OmniVoice Logo" width="120" />
  <h1>OmniVoice Studio</h1>
  <h3>The open-source ElevenLabs alternative.</h3>
  <p>Real-time dictation, zero-shot voice cloning, and cinematic video dubbing — all on your desktop.<br/>Open-source, no API keys, fully local. <b>646 languages.</b></p>

  <p>
    <a href="#quickstart">Quickstart</a> ·
    <a href="#features">Features</a> ·
    <a href="#why-ovs">Why OVS</a> ·
    <a href="#tts-engines">TTS Engines</a> ·
    <a href="#asr-engines">ASR Engines</a> ·
    <a href="#openai-api">API</a> ·
    <a href="#sponsors">Sponsors</a> ·
    <a href="#sponsor--donate">Donate</a> ·
    <a href="#contributing">Contributing</a> ·
    <a href="https://discord.gg/bzQavDfVV9">Discord</a> ·
    <a href="README_CN.md"><strong>简体中文</strong></a>
  </p>

  <p>
    <a href="https://github.com/debpalash/OmniVoice-Studio/stargazers"><img src="https://img.shields.io/github/stars/debpalash/OmniVoice-Studio?style=flat-square&color=f59e0b" alt="Stars" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/github/v/release/debpalash/OmniVoice-Studio?style=flat-square&color=10b981" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/issues"><img src="https://img.shields.io/github/issues/debpalash/OmniVoice-Studio?style=flat-square&color=ef4444" alt="Issues" /></a>
    <a href="https://discord.gg/bzQavDfVV9"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://ko-fi.com/debpalash"><img src="https://img.shields.io/badge/Ko--fi-Support_Us-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>
    <a href="https://paypal.me/palashCoder"><img src="https://img.shields.io/badge/PayPal-Donate-00457C?style=flat-square&logo=paypal&logoColor=white" alt="PayPal" /></a>
  </p>
</div>

<br/>

<div align="center">
  <img src="docs/screenshot-launchpad.png" alt="OmniVoice Studio — Launchpad" width="100%"/>
</div>

> **Your voice is the most personal data you have. So why rent it back from a cloud?** Every mainstream voice tool ships your audio to someone else's server and bills you monthly for the privilege. OmniVoice Studio flips that: clone, design, dub, and dictate on your own hardware — 646 languages, no meter running, nothing leaving your machine.

<div align="center">

| 🔑 No API keys | 🙅 No accounts | ☁️ No cloud | 💳 No subscription |
|:---:|:---:|:---:|:---:|
| nothing to paste in | nothing to sign up for | your audio stays home | it's your computer |

</div>

> [!WARNING]
> **OmniVoice Studio is in active beta.** Things may break between releases — for the latest features and fixes, clone the repo and run from source rather than the pre-built installers. Bug reports and PRs are very welcome: [open an issue](https://github.com/debpalash/OmniVoice-Studio/issues) or [join Discord](https://discord.gg/bzQavDfVV9).

<div align="center">
  <br/>
  <a href="https://discord.gg/bzQavDfVV9"><img src="https://img.shields.io/badge/💬_Join_the_Community-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord" /></a>
  <br/>
  <sub>Get setup help · Share your dubs · Vote on the roadmap · Early access to new engines</sub>
  <br/>
</div>

<br/>

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
  <tr>
    <td align="center">
      <img src="docs/screenshot-openapi.png" alt="Settings — API Reference" width="100%"/>
      <br/><b>API Reference</b><br/>
      <sub>The full local REST API, embedded — every endpoint documented with copy-paste client snippets.</sub>
    </td>
    <td align="center">
      <img src="docs/screenshot-updates.png" alt="Settings — What's New" width="100%"/>
      <br/><b>What's New</b><br/>
      <sub>In-app changelog reader — see exactly what shipped in each release without leaving the app.</sub>
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
- ⚡ **GPU Auto-Detect** — CUDA · MPS · ROCm · CPU; ≤8 GB VRAM auto-offloads.
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
  <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/badge/Debian-.deb-A81D33?style=for-the-badge&logo=debian&logoColor=white" alt="Download Debian .deb" /></a>
  <br/>
  <sub><b>macOS:</b> first launch needs a one-time approval — right-click → <b>Open</b> (or System Settings → Privacy &amp; Security → <b>"Open Anyway"</b> on macOS 15). No Terminal needed. <a href="docs/install/macos.md#gatekeeper-quarantine">Why?</a></sub>
  <br/>
  <sub><b>Intel Macs are not supported for the local backend:</b> the app UI installs, but the Python backend cannot run because PyTorch no longer ships Intel-Mac (x86_64) wheels (<a href="https://github.com/debpalash/OmniVoice-Studio/issues/889">#889</a>) — see <a href="docs/install/macos.md">docs/install/macos.md</a>.</sub>
</div>

Pick your OS and follow the guide end-to-end:

- 🍎 **macOS** — [docs/install/macos.md](docs/install/macos.md)
- 🪟 **Windows** — [docs/install/windows.md](docs/install/windows.md)
- 🐧 **Linux** — [docs/install/linux.md](docs/install/linux.md)
- 🐳 **Docker** — [docs/install/docker.md](docs/install/docker.md) · [Docker Hub: `palashdeb/omnivoice-studio`](https://hub.docker.com/r/palashdeb/omnivoice-studio)

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
| **GPU Support** | N/A (cloud) | CUDA · Apple Silicon · ROCm · CPU |
| **Desktop App** | ❌ | ✅ macOS · Windows · Linux |
| **TTS Engines** | 1 | **14** (OmniVoice, CosyVoice 3, GPT-SoVITS, VoxCPM2, MOSS-TTS-Nano, KittenTTS, MLX-Audio, Sherpa-ONNX, IndexTTS 2, OmniVoice GGUF, Supertonic 3, MOSS-TTS-v1.5, dots.tts, Confucius4-TTS) |
| **ASR Engines** | 1 | **9** (WhisperX, Faster-Whisper, MLX Whisper, PyTorch Whisper, Parakeet, Moonshine, FunASR, isolated Faster-Whisper, sherpa-onnx live dictation) |
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
| **OS** | Windows 10, macOS 12+ (Apple Silicon), Ubuntu 20.04+ | Any modern 64-bit OS |
| **RAM** | 8 GB | 16 GB+ |
| **VRAM (GPU)** | 4 GB (auto-offloads TTS to CPU) | 8 GB+ (NVIDIA RTX 3060+) |
| **Disk** | 10 GB free (models + cache) | 20 GB+ SSD |
| **Python** | 3.10+ (managed by `uv`) | 3.11–3.12 |
| **GPU** | Optional — CPU works | NVIDIA CUDA · Apple Silicon MPS · AMD ROCm |

> [!TIP]
> On GPUs with **≤8 GB VRAM**, OmniVoice automatically offloads TTS to CPU during transcription — no config needed. A dedicated GPU is not required; the entire pipeline runs on CPU (just slower).

> [!IMPORTANT]
> **macOS Intel (x86_64) is unsupported for the local backend:** the app UI installs, but the Python backend cannot run because PyTorch no longer ships Intel-Mac wheels ([#889](https://github.com/debpalash/OmniVoice-Studio/issues/889)). Intel-Mac users can still point the UI at a remote backend on another machine — see [docs/install/macos.md](docs/install/macos.md).

<a id="tts-engines"></a>

### 🗣️ TTS Engines

**14 engines, one picker.** OmniVoice (default, 600+ languages) is always available; CosyVoice 3, GPT-SoVITS, VoxCPM2, MOSS-TTS-Nano, KittenTTS, MLX-Audio, and Sherpa-ONNX are opt-in and auto-detected — plus six lazy-installed heavyweights (IndexTTS 2, OmniVoice GGUF, Supertonic 3, MOSS-TTS-v1.5, dots.tts, Confucius4-TTS). Switch in **Settings → TTS Engine** or via the `OMNIVOICE_TTS_BACKEND` env var.

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
> **MOSS-TTS-v1.5** (8B, ~16 GB weights) and **dots.tts** (2B, ~9 GB weights) are heavyweight opt-in engines that run in their own isolated venv from a local clone — see [MOSS-TTS-v1.5](docs/engines/moss-tts-v15.md) and [dots.tts](docs/engines/dots-tts.md). Neither claims Apple-Silicon **MPS** (upstream is CUDA/CPU only; on a Mac they run on CPU). dots.tts upstream is Linux/macOS only — no Windows path. **Confucius4-TTS** (14-language cross-lingual zero-shot cloning) is similar — its own Python 3.10 venv from a clone; CUDA recommended, CPU validated end-to-end (slow, ~17× realtime; no MPS — tested slower than CPU); see [Confucius4-TTS](docs/engines/confucius4-tts.md).

</details>

<a id="asr-engines"></a>

### 🎧 ASR Engines

**9 engines, all fully local** — they power dictation, video dubbing, and subtitles. **WhisperX** is the cross-platform default (~100 languages, word-level timing); the rest are opt-in and auto-detected. Switch in **Settings → ASR Engine** or via the `OMNIVOICE_ASR_BACKEND` env var.

<details>
<summary><b>📊 The full lineup</b> — 9 engines, what each is best at, and compute-type notes</summary>

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

OmniVoice Studio is built by one developer using Claude Code and AI agents — and the agent bills are real. Over the last three months I've spent thousands of dollars on Claude subscriptions to keep the features shipping, the bugs fixed, and your issues answered. If OmniVoice has created value for you, helping cover those bills means I can keep developing full-time.

<div align="center">

**This month's agent bill fund**

<img src="https://img.shields.io/badge/raised_%2410_of_%24200-5%25-EAB308?style=for-the-badge" alt="$10 / $200 raised" />

<br/><br/>

<a href="https://ko-fi.com/debpalash"><img src="https://img.shields.io/badge/Ko--fi-Support_❤️-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>
&nbsp;&nbsp;
<a href="https://paypal.me/palashCoder"><img src="https://img.shields.io/badge/PayPal-Donate-00457C?style=for-the-badge&logo=paypal&logoColor=white" alt="PayPal" /></a>

<br/>
<sub>Every dollar goes directly to agent bills — keeping OmniVoice development continuous.</sub>

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
| `#showcase` | Members share their dubs, clones, and voice designs |
| `#help` | Setup issues, GPU troubleshooting, model questions |
| `#feature-requests` | Vote on what gets built next |
| `#dev` | Architecture discussions, PR reviews, engine integrations |
| `#announcements` | Release notes, breaking changes, early access |

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
For voice cloning and dubbing, yes — OmniVoice uses a state-of-the-art diffusion TTS model with 646 languages (ElevenLabs supports 32). Quality is comparable for most use cases. Where ElevenLabs wins is in their polished cloud API and pre-made voice library. OmniVoice wins on privacy, cost, language coverage, and customizability.
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
<b>Yes — commercial use is free.</b> OmniVoice Studio is free and open-source under the <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU AGPL-3.0</a>. So personal, educational, research, <b>and commercial / business use are all free</b>: run it, sell the audio you make with it, dub your own or a client's videos, deploy it across your team. Because AGPL is a <b>network copyleft</b> license, if you <b>modify</b> OmniVoice Studio and make that modified version available to others over a network, you must offer those users the source of your modified version under the same AGPL terms. Want to embed OmniVoice in a <b>closed-source or proprietary</b> product without those obligations? A <b>commercial license</b> is available — see <a href="#license">License</a>.
</details>

<details>
<summary><b>What languages are supported?</b></summary>
<br/>
646 languages for TTS via the OmniVoice model. Transcription (WhisperX) supports 99 languages. Translation coverage depends on the target language pair.
</details>

<details>
<summary><b>Can I add my own TTS engine?</b></summary>
<br/>
Yes. OmniVoice uses a <b>built-in backend registry</b>. To add an engine in ~50 lines, subclass <code>TTSBackend</code> in <code>backend/services/tts_backend.py</code> and add it to the <code>_REGISTRY</code> dictionary. Fourteen engines are built in: OmniVoice, CosyVoice 3, GPT-SoVITS, MLX-Audio (14+ sub-engines), VoxCPM2, MOSS-TTS-Nano, KittenTTS, Sherpa-ONNX, plus lazy-registered IndexTTS 2, OmniVoice GGUF, Supertonic 3, MOSS-TTS-v1.5, dots.tts, and Confucius4-TTS. See the <a href="#tts-engines">TTS Engines</a> section for details.
</details>

---

<a id="license"></a>

## 📜 License

OmniVoice Studio is free and open-source software under the [**GNU Affero General Public License v3.0 (AGPL-3.0)**](https://www.gnu.org/licenses/agpl-3.0.html).

**Free for any use — including commercial and internal business use.** Run it, sell the audio you produce with it, dub your own or clients' videos, roll it out across your team — all free, no license needed. As a **network copyleft** license, AGPL adds one obligation: if you **modify** OmniVoice Studio and offer that modified version to others over a network, you must make the complete corresponding source of your modified version available to them under the same AGPL-3.0 terms.

A **commercial license** is available for organizations that want to embed OmniVoice Studio in a **closed-source or proprietary** product or service without the AGPL-3.0 copyleft obligations. **Pricing tiers coming soon.** Inquiries: **OmniVoice@palash.dev**.

The bundled `omnivoice/` TTS model by Han Zhu remains Apache-2.0 upstream. See [`LICENSE`](LICENSE) for the full, binding terms.

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

## 🧰 More local open-source from the maker

Like the local-first philosophy? It runs in the family:

| Project | What it is |
|---------|------------|
| [**Opal**](https://github.com/debpalash/Opal) 💠 | **Play everything.** The evolved media player for the next decades of entertainment — video, anime, comics, torrents, Jellyfin/Plex, with local AI built in. |
| [**memxt**](https://github.com/debpalash/memxt) 🧠 | **The fastest benchmarked open-source AI memory system.** 100% local memory for AI agents, with MCP support. |

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
