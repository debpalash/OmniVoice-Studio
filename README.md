<div align="center">
  <img src="docs/logo.png" alt="OmniVoice Logo" width="120" />
  <h1>OmniVoice Studio</h1>
  <h3>The open-source ElevenLabs alternative.</h3>
  <p>Real-time dictation, zero-shot voice cloning, and cinematic video dubbing — all on your desktop.<br/>Open-source, no API keys, fully local. <b>646 languages.</b></p>

  <p>
    <a href="https://github.com/debpalash/OmniVoice-Studio/stargazers"><img src="https://img.shields.io/github/stars/debpalash/OmniVoice-Studio?style=flat-square&color=f59e0b" alt="Stars" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/github/v/release/debpalash/OmniVoice-Studio?style=flat-square&color=10b981" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue?style=flat-square" alt="License" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/issues"><img src="https://img.shields.io/github/issues/debpalash/OmniVoice-Studio?style=flat-square&color=ef4444" alt="Issues" /></a>
    <a href="https://discord.gg/aRRdVj3de7"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
  </p>

  <p>
    <a href="#quickstart">Quickstart</a> ·
    <a href="#features">Features</a> ·
    <a href="#why-omnivoice-studio">Why OmniVoice Studio?</a> ·
    <a href="#tts-engines">TTS Engines</a> ·
    <a href="#contributing">Contributing</a> ·
    <a href="https://discord.gg/aRRdVj3de7">Discord</a>
  </p>

  <p>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.7/OmniVoice.Studio_0.2.7_aarch64.dmg"><img src="https://img.shields.io/badge/macOS-DMG_(Apple_Silicon)-000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS DMG" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.7/OmniVoice.Studio_0.2.7_x64_en-US.msi"><img src="https://img.shields.io/badge/Windows-MSI_(x64)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows MSI" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.7/OmniVoice.Studio_0.2.7_amd64.AppImage"><img src="https://img.shields.io/badge/Linux-AppImage_(x64)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download Linux AppImage" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.7/OmniVoice.Studio_0.2.7_amd64.deb"><img src="https://img.shields.io/badge/Debian-.deb-A81D33?style=for-the-badge&logo=debian&logoColor=white" alt="Download Debian .deb" /></a>
  </p>
</div>

<br/>

<div align="center">
  <img src=".github/assets/social-preview.png" alt="OmniVoice Studio — The open-source ElevenLabs alternative" width="100%"/>
</div>

> [!WARNING]
> **OmniVoice Studio is in active beta.** Things may break between releases. For the latest features and fixes, clone the repo and run from source rather than using pre-built installers. Bug reports and PRs are very welcome — [open an issue](https://github.com/debpalash/OmniVoice-Studio/issues) or [join Discord](https://discord.gg/aRRdVj3de7).

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

Pick your path — from zero-install to full developer setup:

<table>
<tr>
<td width="33%" align="center">
<h3>🖥️ Desktop App</h3>
<sub><b>Easiest</b> · ~2 min · No dependencies</sub>
<br/><br/>
<a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/badge/Download-Installer-10b981?style=for-the-badge&logo=github&logoColor=white" alt="Download"/></a>
<br/><br/>
<sub>macOS DMG · Windows MSI · Linux AppImage/deb<br/>Auto-bootstraps Python + models on first launch.</sub>
</td>
<td width="33%" align="center">
<h3>🐳 Docker</h3>
<sub><b>One command</b> · ~3 min · Needs Docker</sub>
<br/><br/>
<code>docker pull ghcr.io/debpalash/omnivoice-studio</code>
<br/><br/>
<sub>Pre-built image from GHCR.<br/>CPU + NVIDIA GPU supported.</sub>
</td>
<td width="33%" align="center">
<h3>⚡ From Source</h3>
<sub><b>Full control</b> · ~5 min · Needs Bun + Python</sub>
<br/><br/>
<code>git clone → bun install → bun run dev</code>
<br/><br/>
<sub>Hot reload, full codebase access.<br/>Best for contributors.</sub>
</td>
</tr>
</table>

---

### 🖥️ Option 1 — Desktop App

Pre-built installers (~6–8 MB) are on the [**Releases**](https://github.com/debpalash/OmniVoice-Studio/releases/latest) page. Download, install, launch. The app bootstraps a Python environment and downloads model weights automatically — the splash screen shows progress.

<details>
<summary><b>macOS — "app is damaged and can't be opened"</b></summary>
<br/>

macOS quarantines apps downloaded outside the App Store. After dragging to `/Applications`:

```bash
xattr -cr /Applications/OmniVoice\ Studio.app
```

Open normally after. One-time fix.
</details>

<details>
<summary><b>Windows — first launch takes 5–10 minutes</b></summary>
<br/>

The app bootstraps a Python virtual environment, installs dependencies, and downloads ffmpeg on first run. The splash screen shows each step. Subsequent launches start in seconds.
</details>

<details>
<summary><b>Linux — AppImage needs FUSE</b></summary>
<br/>

If FUSE isn't available, use the `.deb` package or extract-and-run:

```bash
chmod +x OmniVoice.Studio_*.AppImage
./OmniVoice.Studio_*.AppImage --appimage-extract-and-run
```
</details>

---

### 🐳 Option 2 — Docker

Pull the pre-built image from **GitHub Container Registry**:

```bash
docker pull ghcr.io/debpalash/omnivoice-studio:latest
```

**Run it:**

```bash
# CPU mode
docker run -d --name omnivoice \
  -p 127.0.0.1:3900:3900 \
  -v omnivoice-data:/app/omnivoice_data \
  ghcr.io/debpalash/omnivoice-studio:latest

# NVIDIA GPU mode
docker run -d --name omnivoice --gpus all \
  -p 127.0.0.1:3900:3900 \
  -v omnivoice-data:/app/omnivoice_data \
  ghcr.io/debpalash/omnivoice-studio:latest
```

**Or use Docker Compose:**

```bash
# CPU
docker compose -f deploy/docker-compose.yml up -d

# GPU
docker compose -f deploy/docker-compose.yml --profile gpu up -d
```

Open [localhost:3900](http://localhost:3900) once the health check passes. First run downloads ~4 GB of model weights — progress in `docker compose logs -f`.

<details>
<summary><b>Build from source instead of pulling</b></summary>
<br/>

```bash
docker compose -f deploy/docker-compose.yml up --build -d
```

</details>

> **Network access:** the container binds to `127.0.0.1` only. To expose on your LAN, change the port mapping to `"0.0.0.0:3900:3900"`. OmniVoice ships no authentication — put it behind a reverse proxy with auth (Caddy `basic_auth`, nginx + htpasswd, Tailscale, etc.).

---

### ⚡ Option 3 — From Source

```bash
git clone https://github.com/debpalash/OmniVoice-Studio.git && cd OmniVoice-Studio
bun install && bun run dev
```

Open [localhost:3901](http://localhost:3901) and start cloning voices. Hot-reload enabled for both frontend and backend.

```bash
bun run desktop    # Build the native desktop app from source
```

| Service | URL | Stack |
|---------|-----|-------|
| **Backend** | `localhost:3900` | FastAPI · 97 endpoints · WhisperX · Demucs · OmniVoice |
| **Frontend** | `localhost:3901` | React · Vite · Waveform timeline · Glassmorphism UI |
| **API Docs** | [`localhost:3900/docs`](http://localhost:3900/docs) | Scalar — interactive API reference |

> [!NOTE]
> First run downloads model weights (~2.4 GB). No account needed. For faster downloads, optionally set `HF_TOKEN=hf_...` in your environment ([get a free token here](https://huggingface.co/settings/tokens)).
>
> **Having issues?** Join our [Discord](https://discord.gg/aRRdVj3de7) for setup help and troubleshooting.

---

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
| **Pricing** | $5–$330/mo, per-character billing | Free for personal use · [Commercial license](#license) for business |
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

## Contributing

We welcome contributions of all kinds — bug fixes, new TTS engine adapters, UI improvements, docs, and translations.

- 📖 Read the **[Contributing Guide](CONTRIBUTING.md)** for setup, code style, and PR workflow
- 🐛 Browse [good first issues](https://github.com/debpalash/OmniVoice-Studio/labels/good%20first%20issue)
- 💬 Join our [Discord](https://discord.gg/aRRdVj3de7) to discuss ideas or ask for help

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
Personal, educational, internal-team, and non-commercial use is free under <a href="https://fsl.software/">FSL-1.1-ALv2</a>. Building a competing product or service on top of OmniVoice Studio requires a commercial license — see <a href="#license">License</a>. Pricing tiers coming soon. Each release converts to Apache 2.0 two years after publication.
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

OmniVoice Studio is source-available under the [**Functional Source License (FSL-1.1-ALv2)**](https://fsl.software/).

**Free** for personal, educational, research, internal team, and non-commercial use. Each release **converts to Apache 2.0 automatically two years after publication**.

**Business / enterprise** users building a competing product or service on top of OmniVoice Studio need a commercial license. **Pricing tiers coming soon.** For inquiries in the meantime, reach out at **OmniVoice@palash.dev**.

See [`LICENSE`](LICENSE) for the full terms.

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
**[⭐ Star this repo](https://github.com/debpalash/OmniVoice-Studio)** so others can find it too.

<br/>

  <a href="https://star-history.com/#debpalash/OmniVoice-Studio&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date" />
      <img alt="Star History" src="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" width="600" />
    </picture>
  </a>
</div>
