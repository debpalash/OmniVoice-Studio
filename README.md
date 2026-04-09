# OmniVoice Studio 🎙️🌍

<p align="center">
  <img src="pics/omnivoice_studio_1.png" alt="OmniVoice Studio Interface" width="1000"/>
</p>

OmniVoice Studio is a massive, production-ready cinematic audio dubbing and voice generation engine. By leveraging the state-of-the-art zero-shot OmniVoice TTS diffusion model at its core—which natively supports high-fidelity audio synthesis across over 600 distinct languages and dialects—OmniVoice Studio equips content creators with a robust local engine capable of professional-grade vocal operations.

## 🎬 Studio Features

<p align="center">
  <img src="pics/omnivoice_studio_2.png" alt="OmniVoice Studio Dubbing feature" width="1000"/>
</p>

* **Cinematic Video Dubbing**: Upload any MP4 video; the Studio will intelligently transcribe it using Whisper, automatically translate segments via Google deep-translation concurrently into over 85 supported target languages, and seamlessly multiplex the newly dubbed voice layers back into an exported video.
* **Background Noise Preservation**: Designed exclusively for cinematic workloads, the engine inherently connects with `demucs` to automatically isolate speech from background noise. When exporting dubbed media, the original environmental audio and track music are mixed flawlessly underneath your new vocals.
* **Zero-Shot Voice Cloning**: Save, structure, and manage an infinitely scalable library of local custom Voice Profiles by simply dragging and dropping a raw 3-second reference audio snippet.
* **Granular Voice Design**: Want to synthesize a brand new voice entirely? OmniVoice lets you procedurally construct custom vocal identities directly from string tags (e.g., `female`, `elderly`, `low pitch`, `british accent`). You can even inject non-verbal acoustic markers directly into the text, like `[laughter]` or `[sigh]`.
* **Hardware Orchestrated**: The entire architecture auto-detects and orchestrates optimally against Apple Silicon (MPS), NVIDIA/AMD (CUDA/ROCm), and safely falls back gracefully onto generic CPU allocation. Includes a native asynchronous server routing, background thread pools, and auto-purging GPU garbage collection timeouts to leave the UI utterly unblocked.

---

## 🚀 Quick Start (Launch the Studio)

OmniVoice Studio has been structurally optimized using Turborepo and Bun for immediate uncompromised launching straight into the dashboard.

1. **System Prerequisite:** Ensure standard `ffmpeg` is available on your local system path.
2. Install [Bun](https://bun.sh/) (`curl -fsSL https://bun.sh/install | bash`).
3. Clone the repository and install the dependencies:
```bash
git clone https://github.com/k2-fsa/OmniVoice.git
cd OmniVoice
bun install
```
4. Fire up both the FastAPI AI Backend and the React Frontend simultaneously:
```bash
bun run dev
```

> **First Run**: The backend (`http://localhost:8000`) will download the necessary model weights locally to your `huggingface` cache during the first inference trigger. The frontend design suite is instantly available running on `http://localhost:5173` (or `5174`).
  
---

## Directory Architecture
* `/frontend` — React/Vite frontend housing the complete Glassmorphic Gruvbox design system, UI logic, custom components, and concurrent fetching architectures.
* `api.py` — The core massive ASGI FastAPI backend which processes routes, manages the heavy PyTorch state matrices natively in memory, unloads inactive workers, accesses device caches, and spins Python thread-pools.
* `omnivoice/` — The foundational model architecture pipelines handling the complex transformer tensors and text diffusion properties.

---

## Technical Acknowledgment

The underlying `OmniVoice` TTS framework operates on a novel diffusion language model-style architecture that acts as the heavy lifter. The framework is derived directly from the official research implementation by Zhu et al. Please see the [original core documentation](https://zhu-han.github.io/omnivoice) or the corresponding [HuggingFace repo](https://huggingface.co/k2-fsa/OmniVoice).
