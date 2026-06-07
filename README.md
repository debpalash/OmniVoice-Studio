<div align="center">
  <img src="docs/logo.png" alt="OmniVoice Logo" width="120" />
  <h1>OmniVoice Studio</h1>
  <h3>The open-source ElevenLabs alternative.</h3>
  <p>Real-time dictation, zero-shot voice cloning, and cinematic video dubbing — all on your desktop.<br/>Open-source, no API keys, fully local. <b>646 languages.</b></p>

  <p>
    <a href="https://github.com/debpalash/OmniVoice-Studio/stargazers"><img src="https://img.shields.io/github/stars/debpalash/OmniVoice-Studio?style=flat-square&color=f59e0b" alt="Stars" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/github/v/release/debpalash/OmniVoice-Studio?style=flat-square&color=10b981" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/issues"><img src="https://img.shields.io/github/issues/debpalash/OmniVoice-Studio?style=flat-square&color=ef4444" alt="Issues" /></a>
    <a href="https://discord.gg/bzQavDfVV9"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
  </p>

  <p>
    <a href="#quickstart">Quickstart</a> ·
    <a href="#features">Features</a> ·
    <a href="#why-omnivoice-studio">Why OmniVoice Studio?</a> ·
    <a href="#tts-engines">TTS Engines</a> ·
    <a href="#asr-engines">ASR Engines</a> ·
    <a href="#contributing">Contributing</a> ·
    <a href="https://discord.gg/bzQavDfVV9">Discord</a> ·
    <a href="README_CN.md"><strong>简体中文</strong></a>
  </p>

  <p>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.7/OmniVoice.Studio_0.2.7_aarch64.dmg"><img src="https://img.shields.io/badge/macOS-DMG_(Apple_Silicon)-000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS DMG" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.7/OmniVoice.Studio_0.2.7_x64_en-US.msi"><img src="https://img.shields.io/badge/Windows-MSI_(x64)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows MSI" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.7/OmniVoice.Studio_0.2.7_amd64.AppImage"><img src="https://img.shields.io/badge/Linux-AppImage_(x64)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download Linux AppImage" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.7/OmniVoice.Studio_0.2.7_amd64.deb"><img src="https://img.shields.io/badge/Debian-.deb-A81D33?style=for-the-badge&logo=debian&logoColor=white" alt="Download Debian .deb" /></a>
  </p>
  <p>
    <sub><b>macOS:</b> first launch needs a one-time approval — right-click → <b>Open</b> (or System Settings → Privacy &amp; Security → <b>"Open Anyway"</b> on macOS 15). No Terminal needed. <a href="docs/install/macos.md#gatekeeper-quarantine">Why?</a></sub>
  </p>
</div>

<br/>

<div align="center">
  <img src=".github/assets/social-preview.png" alt="OmniVoice Studio — The open-source ElevenLabs alternative" width="100%"/>
</div>

> [!WARNING]
> **OmniVoice Studio is in active beta.** Things may break between releases. For the latest features and fixes, clone the repo and run from source rather than using pre-built installers. Bug reports and PRs are very welcome — [open an issue](https://github.com/debpalash/OmniVoice-Studio/issues) or [join Discord](https://discord.gg/bzQavDfVV9).

<div align="center">
  <br/>
  <a href="https://discord.gg/bzQavDfVV9"><img src="https://img.shields.io/badge/💬_Join_the_Community-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord" /></a>
  <br/>
  <sub>Get setup help · Share your dubs · Vote on the roadmap · Early access to new engines</sub>
  <br/>
</div>

<br/>

## Features

<table>
<tr>
  <td align="center" width="33%">
    <h3>🎙️ Voice Cloning</h3>
    <p>3-second clip → mirror any voice.<br/><b>646 languages</b>, zero-shot.</p>
  </td>
  <td align="center" width="33%">
    <h3>🎨 Voice Design</h3>
    <p>Gender, age, accent, pitch, speed,<br/>emotion, dialect — <b>dial it in</b>.</p>
  </td>
  <td align="center" width="33%">
    <h3>🎬 Video Dubbing</h3>
    <p>YouTube URL or file → transcribe →<br/>translate → re-voice → <b>MP4</b>.</p>
  </td>
</tr>
<tr>
  <td align="center" valign="top">
    <h3>⌨️ Dictation Widget</h3>
    <p><code>⌘+⇧+Space</code> from <b>any app</b>.<br/>Transcribes, auto-pastes, disappears.</p>
  </td>
  <td align="center" valign="top">
    <h3>🔊 Vocal Isolation</h3>
    <p>Demucs-powered. Splits speech<br/>from music, <b>keeps the background</b>.</p>
  </td>
  <td align="center" valign="top">
    <h3>👥 Speaker Diarization</h3>
    <p>Pyannote + WhisperX.<br/><b>Auto-identifies</b> who said what.</p>
  </td>
</tr>
<tr>
  <td align="center" valign="top">
    <h3>📦 Batch Queue</h3>
    <p>Drop <b>50 videos</b>, walk away.<br/>Progress bars per job.</p>
  </td>
  <td align="center" valign="top">
    <h3>🤖 MCP Server</h3>
    <p>Use OmniVoice from <b>Claude</b>,<br/>Cursor, or any MCP client.</p>
  </td>
  <td align="center" valign="top">
    <h3>🛡️ AI Watermark</h3>
    <p>AudioSeal (Meta). <b>Invisible</b>,<br/>survives compression.</p>
  </td>
</tr>
<tr>
  <td align="center" valign="top">
    <h3>🔐 100% Local</h3>
    <p>No keys, no cloud, no accounts.<br/><b>Your machine only</b>.</p>
  </td>
  <td align="center" valign="top">
    <h3>⚡ GPU Auto-Detect</h3>
    <p>CUDA · MPS · ROCm · CPU.<br/>≤8 GB? <b>Auto-offloads</b>.</p>
  </td>
  <td align="center" valign="top">
    <h3>🧩 Extensible</h3>
    <p>Subclass <code>TTSBackend</code>,<br/>add any engine in <b>~50 lines</b>.</p>
  </td>
</tr>
</table>

---

## Quickstart

Per-OS install guides — pick yours and follow it end-to-end:

- **macOS** — [docs/install/macos.md](docs/install/macos.md)
- **Windows** — [docs/install/windows.md](docs/install/windows.md)
- **Linux** — [docs/install/linux.md](docs/install/linux.md)
- **Docker** — [docs/install/docker.md](docs/install/docker.md)

Stuck? See [docs/install/troubleshooting.md](docs/install/troubleshooting.md)
for the top 10 install errors. The in-app error UI deeplinks to those entries
when something breaks at runtime.

For Hugging Face token setup, see
[docs/setup/huggingface-token.md](docs/setup/huggingface-token.md). For
diarization-specific gating, see
[docs/features/diarization.md](docs/features/diarization.md).

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshot-clone.png" alt="Voice Clone" width="100%"/>
      <br/><b>Voice Clone</b><br/>
      <sub>Drop a 3-second clip → mirror any voice. 646 languages, zero-shot.</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshot-design.png" alt="Voice Design" width="100%"/>
      <br/><b>Voice Design</b><br/>
      <sub>Build new voices from scratch — gender, age, accent, pitch, style.</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/screenshot-dub.png" alt="Video Dubbing" width="100%"/>
      <br/><b>Video Dubbing</b><br/>
      <sub>Upload or paste a YouTube URL. Transcribe, translate, re-voice, export.</sub>
    </td>
    <td align="center">
      <img src="docs/screenshot-gallery.png" alt="Voice Gallery" width="100%"/>
      <br/><b>Voice Gallery</b><br/>
      <sub>Search YouTube, browse categories, download clips, build your library.</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/screenshot-settings.png" alt="Settings — Models" width="100%"/>
      <br/><b>Settings → Models</b><br/>
      <sub>15 models. One-click install. Auto-detects your platform (CUDA / MPS / CPU).</sub>
    </td>
    <td align="center">
      <img src="docs/screenshot-libraryprojects.png" alt="Projects" width="100%"/>
      <br/><b>Projects</b><br/>
      <sub>Dub projects, voice profiles, generation history, exports — all searchable.</sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="docs/screenshot-logs.png" alt="Settings — Logs" width="100%"/>
      <br/><b>Settings → Logs</b><br/>
      <sub>Live backend, frontend, and Tauri runtime logs. Filter, refresh, clear.</sub>
    </td>
  </tr>
</table>

---

## Why OmniVoice Studio?

ElevenLabs charges **$5–$330/mo** and processes your audio on their servers. OmniVoice Studio runs **on your hardware, with no usage limits.**

| | **ElevenLabs** | **OmniVoice Studio** |
|---|---|---|
| **Pricing** | $5–$330/mo, per-character billing | Free & open-source (AGPL-3.0) · [Commercial license](#license) for proprietary use |
| **Voice Cloning** | ✅ 3s clip | ✅ 3s clip, zero-shot |
| **Voice Design** | ✅ Gender, age | ✅ Gender, age, accent, pitch, style, dialect |
| **Languages** | 32 | **646** |
| **Video Dubbing** | ✅ Cloud-only | ✅ Fully local |
| **Data Privacy** | Audio sent to cloud | **Nothing leaves your machine** |
| **API Keys** | Required | Not needed |
| **GPU Support** | N/A (cloud) | CUDA · Apple Silicon · ROCm · CPU |
| **Desktop App** | ❌ | ✅ macOS · Windows · Linux |
| **Customizable** | ❌ Closed | ✅ Fork it, extend it, ship it |

OmniVoice Studio gives you professional-grade AI tools without the subscription or the cloud.

<div align="center">
  <br/>
  <b>Convinced? Come build with us.</b><br/>
  <a href="https://discord.gg/bzQavDfVV9"><img src="https://img.shields.io/badge/Join_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord" /></a>
  <br/><br/>
</div>

---

## System Requirements

| | **Minimum** | **Recommended** |
|---|---|---|
| **OS** | Windows 10, macOS 12+, Ubuntu 20.04+ | Any modern 64-bit OS |
| **RAM** | 8 GB | 16 GB+ |
| **VRAM (GPU)** | 4 GB (auto-offloads TTS to CPU) | 8 GB+ (NVIDIA RTX 3060+) |
| **Disk** | 10 GB free (models + cache) | 20 GB+ SSD |
| **Python** | 3.10+ (managed by `uv`) | 3.11–3.12 |
| **GPU** | Optional — CPU works | NVIDIA CUDA · Apple Silicon MPS · AMD ROCm |

> [!TIP]
> On GPUs with **≤8 GB VRAM**, OmniVoice automatically offloads TTS to CPU during transcription — no config needed. A dedicated GPU is not required; the entire pipeline runs on CPU (just slower).

### TTS Engines

OmniVoice ships a multi-engine TTS backend. The default engine (OmniVoice) is always available; additional engines are opt-in and auto-detected. Switch engines in **Settings → TTS Engine** or via the `OMNIVOICE_TTS_BACKEND` env var.

| Engine | Languages | Clone | Instruct | Linux | macOS ARM | Windows | License |
|--------|:---------:|:-----:|:--------:|:-----:|:---------:|:-------:|:-------:|
| **OmniVoice** (default) | 600+ | ✅ | ✅ | ✅ CUDA/CPU | ✅ MPS | ✅ CUDA/CPU | Built-in |
| **CosyVoice 3** | 9 + 18 dialects | ✅ | ✅ | ✅ CUDA/CPU | ✅ MPS | ✅ CUDA/CPU | Apache-2.0 |
| **MLX-Audio** (Kokoro, Qwen3-TTS, CSM, Dia, …) | Multi | Varies | Varies | ❌ | ✅ Native | ❌ | Varies |
| **VoxCPM2** | 30 | ✅ | ✅ | ✅ CUDA/CPU | ✅ MPS | ✅ CUDA/CPU | Apache-2.0 |
| **MOSS-TTS-Nano** | 20 | ✅ | ❌ | ✅ CUDA/CPU | ✅ CPU | ✅ CUDA/CPU | Apache-2.0 |
| **KittenTTS** | English | ❌ | ❌ | ✅ CPU | ✅ CPU | ✅ CPU | MIT |

> **CUDA** = GPU-accelerated · **MPS** = Apple Silicon Metal · **CPU** = runs everywhere, slower for large models · KittenTTS and MOSS-TTS-Nano run realtime on CPU · MLX-Audio is Apple Silicon only.

### ASR Engines

OmniVoice ships a multi-engine ASR (speech-to-text) backend that powers dictation, video dubbing, and subtitle generation — all fully local. **WhisperX** is the cross-platform default; the rest are opt-in and auto-detected. Switch in **Settings → ASR Engine** or via the `OMNIVOICE_ASR_BACKEND` env var.

| Engine | `OMNIVOICE_ASR_BACKEND` | Languages | Best for |
|--------|-------------------------|:---------:|----------|
| **WhisperX** (default) | `whisperx` | ~100 | Dubbing & subtitles — word-level timing via wav2vec2 forced alignment |
| **Faster-Whisper** | `faster-whisper` | ~100 | Fast transcription on Linux / macOS / Windows (CTranslate2) |
| **MLX Whisper** | `mlx-whisper` | ~100 | Native Apple Silicon speed (Apple MLX / Metal) |
| **PyTorch Whisper** | `pytorch-whisper` | ~100 | CUDA / CPU fallback via 🤗 Transformers |
| **Parakeet TDT** | `nemo-parakeet` | English + 25 EU | SOTA English accuracy, auto language detection (NVIDIA NeMo, GPU only) |
| **Moonshine** | `moonshine` | English | Edge / low-latency, ONNX |
| **FunASR** | `funasr` | 50+ | All-in-one multilingual — built-in VAD + inline speaker diarization (SenseVoice) |

> Whisper-family engines cover ~100 languages; **FunASR / SenseVoice** adds an all-in-one multilingual path with built-in voice-activity detection and inline speaker diarization. Every engine runs on-device — no API keys, no cloud.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Frontend (React)                │
│  DubTab · VoicePreview · BatchQueue · Gallery    │
├─────────────────────────────────────────────────┤
│                Backend (FastAPI)                  │
│  97 API endpoints · SSE streaming · SQLite       │
├──────────┬──────────┬──────────┬────────────────┤
│ WhisperX │  Demucs  │OmniVoice │   Pyannote     │
│   ASR    │  Source  │   TTS    │  Diarization   │
│          │  Sep.    │          │                │
└──────────┴──────────┴──────────┴────────────────┘
        CUDA / MPS / ROCm / CPU (auto-detected)
```

---

## Roadmap

### ✅ Shipped

| Category | Features |
|----------|----------|
| **Dubbing** | Full pipeline (transcribe→translate→synthesize→mux), scene-aware splitting, lip-sync scoring, streaming TTS |
| **Voice** | Zero-shot cloning, voice design, A/B comparison, voice preview widget, gallery with favorites/tags |
| **Audio** | Demucs vocal isolation, per-segment gain, selective track export, stem/SRT/VTT/MP3 export |
| **Multi-Lang** | Multi-language batch picker, batch dubbing queue with sequential GPU execution |
| **Diarization** | Pyannote ML diarization, auto speaker clone extraction, per-speaker voice assignment |
| **Infra** | Docker deployment, CUDA/MPS/ROCm auto-detect, cuDNN 8 compat, VRAM-aware model offloading |
| **AI Provenance** | AudioSeal invisible watermarking (SynthID-like), video logo overlay, watermark detection API |
| **UX** | Undo/redo, keyboard shortcuts, drag-and-drop, session persistence, glassmorphism design system |
| **Real-time Events** | WebSocket event bus — instant sidebar refresh on data mutations, exponential backoff reconnect |
| **State Management** | Zustand store migration — `uiSlice`, `pillSlice`, `dubSlice`, `generateSlice`, `prefsSlice`, `glossarySlice` |
| **Desktop** | Cross-platform Tauri installers (macOS DMG, Windows MSI, Linux deb/AppImage), auto-update infrastructure |
| **Windows Hardening** | Cross-platform log paths, Triton workaround, HF symlink bypass, 300s health check timeout |
| **Dictation** | Global system-wide hotkey (`⌘+⇧+Space`), frameless floating widget, streaming ASR via WebSocket, auto-paste |
| **Batch Pipeline** | Full batch TTS: extract → transcribe → translate → generate → mix → export, with live progress tracking |

### 🔜 Up Next

- 🎬 **Lip-sync v2** — visual speech timing with wav2lip
- 📖 **Audiobook Editor** — chapter-aware long-form narration
- 🌐 **Hosted Demo** — try OmniVoice without installing anything
- 🔌 **Plugin Marketplace** — community-contributed TTS engines and effects

---

## Community

<div align="center">
  <a href="https://discord.gg/bzQavDfVV9"><img src="https://img.shields.io/badge/💬_Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord" /></a>
</div>

<br/>

| Channel | What happens there |
|---------|--------------------|
| `#showcase` | Members share their dubs, clones, and voice designs |
| `#help` | Setup issues, GPU troubleshooting, model questions |
| `#feature-requests` | Vote on what gets built next |
| `#dev` | Architecture discussions, PR reviews, engine integrations |
| `#announcements` | Release notes, breaking changes, early access |

**[→ Join the Discord](https://discord.gg/bzQavDfVV9)** — we respond to setup questions within hours, not days.

---

## Contributing

We welcome contributions of all kinds — bug fixes, new TTS engine adapters, UI improvements, docs, and translations.

- 📖 Read the **[Contributing Guide](CONTRIBUTING.md)** for setup, code style, and PR workflow
- 🐛 Browse [good first issues](https://github.com/debpalash/OmniVoice-Studio/labels/good%20first%20issue)
- 💬 Join our [Discord](https://discord.gg/bzQavDfVV9) to discuss ideas or ask for help

---

## FAQ

<details>
<summary><b>Is this really as good as ElevenLabs?</b></summary>
<br/>
For voice cloning and dubbing, yes — OmniVoice uses a state-of-the-art diffusion TTS model with 646 languages (ElevenLabs supports 32). Quality is comparable for most use cases. Where ElevenLabs wins is in their polished cloud API and pre-made voice library. OmniVoice wins on privacy, cost, language coverage, and customizability.
</details>

<details>
<summary><b>Does it work on Apple Silicon (M1/M2/M3/M4)?</b></summary>
<br/>
Yes. MPS acceleration is auto-detected. MLX-optimized Whisper models are available for faster transcription on Apple hardware.
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
Yes. OmniVoice uses a <b>built-in backend registry</b>. To add an engine in ~50 lines, subclass <code>TTSBackend</code> in <code>backend/services/tts_backend.py</code> and add it to the <code>_REGISTRY</code> dictionary at the bottom. Six engines are built in: OmniVoice, CosyVoice, MLX-Audio (14+ sub-engines), VoxCPM2, MOSS-TTS-Nano, and KittenTTS. See the <a href="#tts-engines">TTS Engines</a> section for details.
</details>

---

## License

OmniVoice Studio is free and open-source software under the [**GNU Affero General Public License v3.0 (AGPL-3.0)**](https://www.gnu.org/licenses/agpl-3.0.html).

**Free for any use — including commercial and internal business use.** Run it, sell the audio you produce with it, dub your own or clients' videos, roll it out across your team — all free, no license needed. As a **network copyleft** license, AGPL adds one obligation: if you **modify** OmniVoice Studio and offer that modified version to others over a network, you must make the complete corresponding source of your modified version available to them under the same AGPL-3.0 terms.

A **commercial license** is available for organizations that want to embed OmniVoice Studio in a **closed-source or proprietary** product or service without the AGPL-3.0 copyleft obligations. **Pricing tiers coming soon.** Inquiries: **OmniVoice@palash.dev**.

The bundled `omnivoice/` TTS model by Han Zhu remains Apache-2.0 upstream. See [`LICENSE`](LICENSE) for the full, binding terms.

---

## Acknowledgments

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

---

<div align="center">

<br/>

If you read this far, you're our kind of person.<br/>
**[⭐ Star this repo](https://github.com/debpalash/OmniVoice-Studio)** so others can find it too.<br/>
**[💬 Join the Discord](https://discord.gg/bzQavDfVV9)** to share what you build.

<br/>

  <a href="https://star-history.com/#debpalash/OmniVoice-Studio&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date" />
      <img alt="Star History" src="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" width="600" />
    </picture>
  </a>
</div>
