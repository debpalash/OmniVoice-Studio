<div align="center">
  <img src="frontend/public/favicon.svg" alt="OmniVoice Logo" width="100" />
  <h1>OmniVoice Studio</h1>
  <p><b>Local cinematic AI dubbing. No API keys. No cloud. Just run it.</b></p>
  <p>
    <a href="#features">Features</a> ·
    <a href="#quickstart">Quickstart</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="#roadmap">Roadmap</a>
  </p>
  <p>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.2/OmniVoice.Studio_0.2.2_aarch64.dmg"><img src="https://img.shields.io/badge/macOS-DMG_(Apple_Silicon)-000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS DMG" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.2/OmniVoice.Studio_0.2.2_x64_en-US.msi"><img src="https://img.shields.io/badge/Windows-MSI_(x64)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows MSI" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.2/OmniVoice.Studio_0.2.2_amd64.AppImage"><img src="https://img.shields.io/badge/Linux-AppImage_(x64)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download Linux AppImage" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/download/v0.2.2/OmniVoice.Studio_0.2.2_amd64.deb"><img src="https://img.shields.io/badge/Debian-.deb-A81D33?style=for-the-badge&logo=debian&logoColor=white" alt="Download Debian .deb" /></a>
  </p>
</div>

<br/>

<div align="center">
  <img src="preview.png" alt="OmniVoice Studio — Launchpad" width="100%"/>
  <br/>
  <sub>Launchpad — Voice Clone · Voice Design · Video Dubbing, all in one studio.</sub>
</div>

<details>
<summary><b>📸 More screenshots</b></summary>
<br/>
<table>
  <tr>
    <td align="center"><img src="docs/screenshot-clone.png" width="100%"/><br/><sub><b>Voice Clone</b> — Drop a 3s clip, mirror the voice</sub></td>
    <td align="center"><img src="docs/screenshot-design.png" width="100%"/><br/><sub><b>Voice Design</b> — Build voices by gender, age, accent, pitch</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/screenshot-dub.png" width="100%"/><br/><sub><b>Video Dubbing</b> — Upload or paste URL, transcribe, translate, re-voice</sub></td>
  </tr>
</table>
</details>

---

Full-stack video dubbing studio built on the open-source [OmniVoice](https://github.com/k2-fsa/OmniVoice) 600-language zero-shot diffusion TTS model. Upload a video, get broadcast-quality dubs in any language with the original speaker's voice preserved.

## Features

### Core Pipeline
- **Video Dubbing** — Transcribe → translate → synthesize → mux back to MP4. One-click end-to-end.
- **Vocal Isolation** — Demucs-powered speech/music separation. Background audio preserved automatically.
- **Voice Cloning** — Clone any voice from a 3-second clip. Zero-shot, 600+ languages.
- **Multi-Speaker Diarization** — Pyannote + WhisperX fusion auto-identifies speakers and assigns unique voice profiles.

### Studio Tools
- **Voice Preview** — Floating widget for instant 8-step TTS testing. Try voices without leaving the workspace.
- **Multi-Language Batch** — Select multiple target languages, dub to all in one pass.
- **Batch Queue** — Drag-and-drop bulk video processing with sequential GPU execution.
- **Voice Library** — Browse, favorite, tag, and convert gallery clips into permanent voice profiles.
- **A/B Comparison** — Side-by-side voice audition for casting decisions.

### Production Export
- **Selective Track Export** — Choose which language tracks to include in the final MP4.
- **Subtitle Export** — SRT and VTT generation alongside dubbed video.
- **Stem Export** — Separate vocals and background audio as individual files.
- **Per-Segment Mixing** — 0–200% gain control per segment for broadcast-quality balancing.

### Technical
- **Cross-Platform GPU** — Auto-detects CUDA, Apple Silicon (MPS), ROCm, or CPU. Includes automatic cuDNN 8/9 compatibility handling.
- **VRAM-Aware** — Automatically offloads TTS to CPU during transcription on ≤8 GB GPUs. Zero config.
- **Live Telemetry** — Real-time CPU/RAM/VRAM stats with model warm-up indicator.
- **Keyboard-First** — `⌘+Enter` generate, `⌘+S` save, `⌘+Z`/`⌘+⇧+Z` undo/redo.

---

## Quickstart

### Docker (recommended)

```bash
git clone https://github.com/debpalash/OmniVoice-Studio.git
cd OmniVoice-Studio
docker compose up --build -d
```

Open [http://localhost:8000](http://localhost:8000). GPU passthrough works automatically if `nvidia-container-toolkit` is installed.

### Local Development

**Prerequisites:** [ffmpeg](https://ffmpeg.org/), [Bun](https://bun.sh/), [uv](https://docs.astral.sh/uv/)

```bash
git clone https://github.com/debpalash/OmniVoice-Studio.git
cd OmniVoice-Studio
bun install
bun run dev
```

This boots both services:

| Service | URL | Stack |
|---------|-----|-------|
| **Backend** | `localhost:3900` | FastAPI · 97 endpoints · WhisperX · Demucs · OmniVoice |
| **Frontend** | `localhost:3901` | React · Vite · Waveform timeline · Glassmorphism UI |

> [!NOTE]
> First run downloads model weights (~2.4 GB) from HuggingFace. Set `HF_TOKEN` for faster authenticated downloads.

### Desktop App

```bash
bun run desktop    # Launches Tauri native app (macOS / Windows / Linux)
```

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
| **UX** | Undo/redo, keyboard shortcuts, drag-and-drop, session persistence, glassmorphism design system |

### 🔜 Next — by priority

**⚡ Performance** (highest user-visible impact)
- [ ] Batched TTS (8–16 segments per forward pass) — 3–5× throughput
- [ ] Eliminate per-segment disk round-trips in `dub_generate.py`
- [ ] Cold start ≤ 1.5s (currently ~4s on Apple Silicon)
- [ ] Crash-sandbox GPU engines (subprocess isolation)

**✨ Differentiators** (what no competitor has)
- [ ] Real-time dub preview — stream TTS as you edit, no full re-render
- [ ] Project-level casting view — drag voices to speakers
- [ ] Context-aware pipeline — video frames inform dubbing decisions
- [ ] Voice memory across projects

**🎨 Polish & Quality**
- [ ] Accessibility audit — WCAG AA, ARIA live regions, full keyboard nav
- [ ] Waveform timeline v2 — WaveSurfer continuous regions overlay
- [ ] Onboarding sample clip — pre-loaded project for first-run experience
- [ ] Zustand migration — extract App.jsx (94KB, 41 useState calls)

**📦 Productisation**
- [ ] Signed Tauri installers + auto-update (macOS / Windows / Linux)
- [ ] Plugin SDK for third-party TTS engines (ElevenLabs, XTTS, Bark)
- [ ] LLM-powered translation (GPT/Claude for nuanced localization)

---

## Contributing

Issues and PRs welcome. See the [roadmap](#roadmap) for areas where help is most needed.

<div align="center">

**[⭐ Star on GitHub](https://github.com/debpalash/OmniVoice-Studio)** to follow updates.

  <a href="https://star-history.com/#debpalash/OmniVoice-Studio&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date" />
      <img alt="Star History" src="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" width="600" />
    </picture>
  </a>
</div>
