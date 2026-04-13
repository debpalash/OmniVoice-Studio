<div align="center">
  <img src="frontend/public/favicon.svg" alt="OmniVoice Logo" width="120" />
  <h1>OmniVoice Studio</h1>
  <p><b>Your Local Cinematic AI Dubbing Studio</b></p>
  <p>
    <a href="#-features">Features</a> •
    <a href="#-getting-started">Getting Started</a> •
    <a href="#%EF%B8%8F-roadmap">Roadmap</a> •
    <a href="#-changelog">Changelog</a>
  </p>
</div>

<br/>

<div align="center">
  <img src="pics/omnivoice_studio_1.png" alt="OmniVoice Studio Design Interface" width="100%"/>
  <br/>
  <i>High-density Voice Design & Cloning workspace.</i>
</div>

---

Local, full-stack voice generation and cinematic dubbing. **No API keys. No cloud. Just run it.** Built on the open-source [OmniVoice](https://github.com/k2-fsa/OmniVoice) 600-language zero-shot diffusion model.

## ✨ Features

- 🎬 **Video Dubbing** — transcribe, translate, re-voice, and mux back into MP4 dynamically.
- 🎧 **Vocal Isolation** — built-in `demucs` automatically splits speech from music, keeping original background audio perfectly preserved.
- 🧬 **Voice Cloning & Design** — Clone specific voices from just a 3-second audio clip, or design completely new studio profiles with tags like `female, british accent, excited`.
- ⚡ **Cross-Platform Native Execution** — Auto-detects and accelerates inference using Apple Silicon (MPS), NVIDIA (CUDA), AMD (ROCm), or standard CPU.

<br/>

<div align="center">
  <img src="pics/omnivoice_studio_2.png" alt="OmniVoice Studio Dubbing Interface" width="100%"/>
  <br/>
  <i>The timeline-based cinematic dubbing studio.</i>
</div>

## 🚀 Getting Started

Quickly get OmniVoice Studio running locally on your hardware.

**Prerequisites:** Ensure `ffmpeg` is installed on your system.
Install standard web tooling: [Bun](https://bun.sh/) and [uv](https://docs.astral.sh/uv/getting-started/installation/).

```bash
git clone https://github.com/debpalash/OmniVoice-Studio.git
cd OmniVoice-Studio

# Backend
uv sync

# Frontend
bun install
bun dev
```

OmniVoice Studio launches exactly two micro-services:

| Service | Protocol | Details |
|---|---|---|
| **Frontend** | `http://localhost:5173` | The real-time React UI — spanning cloning, design, and audio workspace. |
| **Backend** | `http://localhost:8000` | The FastAPI server handling model inference, translation pipelines, transcriber tasks. |

> [!NOTE]
> **First run optimization:** Model weights (approx. 1.2 GB) automatically download from HuggingFace the first time you execute a generation sequence. Subsequent launches trigger instantly from cache. *(Tip: Set `HF_TOKEN` in your environment for faster, authenticated downloads!)*

---

## 🗺️ Roadmap

The studio is highly functional today, but we are aggressively expanding. Watch the roadmap to see what's shipping next:

### 🌟 Completed Milestones
- [x] Zero-shot voice cloning & complex voice design.
- [x] Full video cinematic dubbing pipeline (transcribe → translate → synthesize → mux).
- [x] Vocal isolation utilizing demucs alongside background audio retention.
- [x] Embedded waveform timeline editor for micro-segment-level audio manipulation.
- [x] Live system telemetry tracking (CPU, RAM, GPU VRAM usage).
- [x] Targeted multi-speaker diarization — auto-assign unique voice profiles per active speaker.
- [x] Studio project persistence — save, load, and cache multi-track projects seamlessly via local SQLite.
- [x] Production SRT/VTT subtitle export packaged alongside the dubbed `.mp4` video output.

### 🔨 Upcoming Features
- [ ] **Native Desktop Applications** — Dedicated client apps for **macOS, Windows, and Linux** to entirely bypass CLI execution requirements.
- [ ] **Batch Processing** — Queue folders full of media to be processed seamlessly overnight.
- [ ] **Micro-Tuning Interface** — Rapidly fine-tune models to capture micro-expressions with minimal extra reference data.
- [ ] **Frame-Perfect Lip-Sync Generation** — Align dynamic phoneme synthesis directly to detected on-screen human mouth movement.
- [ ] **Universal Voice Plugin System** — Decouple the backend to allow bringing your own TTS engines (like XTTS, Bark, etc.).
- [ ] **One-Click Deployment** — Docker image packages engineered for zero-config GPU passthrough.

---

## 📝 Changelog

### v1.1.0 — The Cinematic Studio Update

- **The Cinematic Studio Interface:** Exhaustively re-engineered the UI to prioritize a high-density, real-estate optimized workflow featuring a dynamic UI zoom scalar (`Small`, `Normal`, `Max`). We minimized dead space and overhauled the widget layout keeping crucial tuning metrics immediately accessible.
- **Multi-Track Timeline:** Deeply integrated a multi-layered waveform sequence interface supporting precision audio segment positioning, unmuted live preview playback, localized track timing, and unconstrained draggable positioning manipulation.
- **Persistent Local Projects:** Put a complete stop to ephemeral state loss. All workspace metrics are successfully wrapped into `Projects` logged directly within a native embedded `SQLite` database. Workflows reliably survive browser shutdowns or server API reboots.
- **AI Cast Diarization:** Dropped in an offline `Pyannote` + `WhisperX` fusion pipeline evaluating multi-speaker metadata and categorizing overlapping, distinct speakers. Rapidly "cast" clone overrides seamlessly over complex dialogue tracks.
- **Polishing & Asset Control:** Cleaned cross-stack filename parsing and exported media rendering via `ffmpeg`, stabilizing codec dependencies, and deployed a unified custom `OmniVoice Studio` scalable aesthetic asset system.

<br/>

<div align="center">
  Contributions and conceptual ideas are greatly appreciated — open an issue or submit a PR.
</div>
