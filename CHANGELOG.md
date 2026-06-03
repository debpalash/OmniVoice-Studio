# Changelog

All notable changes to OmniVoice Studio.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Versions track the desktop app (`tauri.conf.json` + `frontend/src-tauri/Cargo.toml`).
The bundled TTS model package (`pyproject.toml`) is versioned independently.

## [0.3.5] — 2026-06-03

### Fixed
- **Speaker diarization failed on PyTorch ≥ 2.6** (`Weights only load failed …
  Unsupported global: torch.torch_version.TorchVersion`) even with the pyannote
  license accepted. PyTorch 2.6 made `torch.load` default to
  `weights_only=True`, whose secure unpickler rejects the pyannote checkpoint's
  metadata globals. The diarization loader now registers the same safe-globals
  allowlist the WhisperX VAD load already uses, so the secure load succeeds.
  (#270)

## [0.3.4] — 2026-06-03

### Fixed
- **Transcription on Windows + NVIDIA failed with `Could not locate
  cudnn_ops_infer64_8.dll`.** WhisperX/faster-whisper need cuDNN 8 (via
  CTranslate2); when the side-loaded `cudnn8_compat` libs are missing, the
  **PyTorch Whisper** backend (Settings → Models) now works as a drop-in
  fallback — it builds its own transformers pipeline on PyTorch's cuDNN-9
  stack, with no CTranslate2/cuDNN-8 dependency and no
  `OMNIVOICE_PRELOAD_TTS_ASR=1` required. (#255)

## [0.3.3] — 2026-06-03

### Fixed
- **Settings → About showed the wrong architecture in the Docker/web build.**
  The "Architecture" row rendered the *client browser's* platform
  (`navigator.platform` → e.g. "Win32"); it now reports the **server's** CPU
  architecture from the backend (`platform.machine()`), correct for both the
  desktop app and Docker. The blank version/GPU/RAM/VRAM in the same report
  were the loopback-gate 403s already fixed in v0.3.2. (#262)

### CI
- The release SHA-256 checksum step no longer uses `mapfile` (a bash 4+
  builtin) — it broke on the macOS runner's bash 3.2 and dropped the macOS
  `SHA256SUMS` for v0.3.1/v0.3.2. Now portable to bash 3.2.

## [0.3.2] — 2026-06-03

### Fixed
- **"Loopback origin required" all over the Docker UI** (and a blank version).
  The `/system/*` and `/api/settings/*` routes are restricted to a loopback
  origin, but Docker's NAT makes every request look non-loopback, so the gate
  403'd the operator out of the admin UI — including `/system/info` (blanking
  the version) and HF-token entry. The Docker image now runs with
  `OMNIVOICE_SERVER_MODE=1`, which relaxes the gate for the headless
  deployment; exposure is governed by the `-p` port mapping plus the optional
  share PIN. Desktop builds are unaffected — their loopback boundary (and the
  denial of admin routes to LAN share guests) is unchanged. (#261)

## [0.3.1] — 2026-06-03

First tagged build of the 0.3 line off `main` — it ships the accumulated
`[0.3.0]` work below plus the fixes here. (The `[0.3.0]` milestone heading is
kept for the qualitative "actually useful" release.)

### Fixed
- **Voice-clone / export download crashed in the Docker & browser build** with
  `TypeError: Cannot read properties of undefined (reading 'invoke')`. The
  export button called the Tauri save dialog unconditionally; outside the
  desktop shell it now falls back to a standard browser download of the file
  served at `/audio/<path>`. (#256)
- **Docker container showed no version** (a dash) in Settings → About, and the
  desktop-only update-channel toggle appeared in the web build. The running
  version is now read from the backend (`/system/info` `app_version`, `/health`
  `version`); the updater UI is hidden outside Tauri. Also corrected the
  version-check command in the Docker docs (`omnivoice`, not
  `omnivoice-studio`). (#249)
- **Transcription failures were masked** by a generic "Transcribe stream
  dropped" message. The transcribe SSE stream now surfaces the real, sanitized
  cause (with an actionable hint) instead of silently dropping when model load
  or VRAM offload fails. (#255)

## [0.3.0] — Unreleased

### Added
- **Frameless dictation widget.** Global dictation upgraded from an in-app FAB to a true OS-level floating widget that hovers over any application. Transparent, decorations-free, always-on-top secondary Tauri window activated by `⌘+⇧+Space`. Auto-hides 2.5 s after a successful paste.
- **Standalone `CaptureWidget` component.** Refactored `CaptureButton` into `CaptureWidget`, running on an isolated route (`/?window=widget`).
- **Social preview image.** Added `social-preview.png` for GitHub SEO.

### Changed
- **README overhaul.** Compact 3-column feature grid, reorganized Quickstart (one-command install, Docker, Desktop App tips), updated comparison table, roadmap, and footer CTA.
- **Docker Compose profiles are mutually exclusive.** CPU service now requires `--profile cpu` (was the implicit default). Prevents port 3900 conflict when running `--profile gpu`. Usage: `docker compose --profile cpu up` or `docker compose --profile gpu up`.

### Fixed
- **Docker GPU detection false negative.** Preflight reported "No compatible GPU detected" inside Docker containers because `nvidia-smi` isn't present in the PyTorch base image. The GPU probe now falls back to `torch.cuda.is_available()` and `torch.cuda.get_device_name()`, correctly showing CUDA as available in containerized deployments.

---

## [0.2.6] — Unreleased

### License
- **Relicensed Studio under [Functional Source License (FSL-1.1-ALv2)](https://fsl.software/).** Free for personal, educational, internal-team, and non-commercial use. Each release converts automatically to Apache License, Version 2.0 on the second anniversary of its publication.
- The bundled `omnivoice/` Python TTS model package remains separately licensed under Apache 2.0 by its upstream authors — not relicensed here.
- In-app **Commercial License** page no longer publishes pricing tiers. Pricing is being finalized; the page now invites quote requests and links the FSL terms.

### Added
- **Single-instance enforcement.** Launching a second copy now focuses the existing window instead of starting a second backend that races for port 3900. Powered by `tauri-plugin-single-instance`.
- **Close-to-tray.** Clicking the window X (or `Cmd+W` on macOS) now hides the window and keeps the backend + tray menu alive. The tray "Quit" item is the only path that fully exits and shuts down the Python backend (cleanup moved to `RunEvent::ExitRequested`).
- **Recording-state tray icon.** Tray icon flips to a red-dot variant while a dictation recording is active and reverts when it stops or errors out.
- **Customizable global dictation hotkey.** New **Settings → Capture** tab. Record any modifier-plus-key combo, save it, and it's persisted in `config.json` and re-registered on every launch. Failed registrations (combo already taken by the OS) roll back to the previously-working binding instead of leaving the user with no shortcut.
- **WebSocket-final dictation path.** Capture now treats the streaming `final` message as the source of truth and skips the duplicate HTTP `POST /transcribe` that used to run on every dictation. Audio is transcribed once instead of twice — typical dictation latency roughly halved. New EOF text-frame protocol (server also accepts an empty binary frame as EOF). HTTP POST kept as fallback for WS error / timeout / WS-never-opened.
- **Chunk queueing during WS handshake.** The first 250 ms of audio is no longer dropped from the server's `final` transcript. `MediaRecorder` chunks captured while the WebSocket is still in `CONNECTING` state are queued and drained in `ws.onopen`.

### Changed
- **Docker default bind is loopback.** `docker-compose.yml` now publishes `127.0.0.1:3900:3900` instead of `3900:3900` — the API is no longer reachable from the LAN out of the box. To expose it deliberately, change the mapping to `0.0.0.0:3900:3900`. README documents the trade-off and recommends a reverse proxy with auth (Caddy `basic_auth`, nginx + htpasswd, Tailscale) for any non-loopback exposure.
- **Donate page trimmed.** Removed Patreon and the Bitcoin / Ethereum / Solana cryptocurrency cards. Removed the bundled `qrcode.react` dependency. The "Commercial License" CTA moves from the bottom of the page to the top-right of the page header.
- **WS dictation hostname** now derived from the configured `API_BASE` instead of a hardcoded `localhost:3900`, so deployments behind reverse proxies route correctly.
- **HTTP POST fallback timeout** scales with recording length (`max(15s, recordedMs + 10s)`) so long-form dictations don't trip the fallback and run the model twice.

### Fixed
- **Backend was killed on every window close** even if the user only intended to dismiss the window. Backend shutdown now fires only on real-quit (`RunEvent::ExitRequested`), not on the close-to-hide path.
- **Hotkey rollback.** `set_dictation_shortcut` previously left the user with no global shortcut if `register(new)` failed after `unregister(old)` succeeded. The previous binding is now restored on failure.
- **WebSocket dictation pipeline lost the first audio chunk.** `MediaRecorder` was started before the WebSocket finished its handshake, so the first 250 ms chunk — which carries the WebM EBML header — was dropped from the WS stream. Every subsequent server-side ffmpeg conversion then failed with `exit status 183` ("Invalid data found when processing input"), partials never appeared, and the HTTP fallback only fired after the full timeout. The WebSocket is now constructed before the recorder, every chunk is queued through `wsPendingRef` until `ws.onopen` drains it, and a server `error` message (or unexpected `onclose` after the recorder has stopped) fires the HTTP fallback immediately instead of waiting out the timeout.
- **Microphone access prompt on macOS.** Added an `Info.plist` with `NSMicrophoneUsageDescription` (and `NSCameraUsageDescription` for forward-compat) so getUserMedia no longer fails silently on macOS 10.14+ TCC. Tauri's bundler auto-merges the file at bundle time. Mic-denial toasts now also include platform-specific recovery hints (Settings paths for macOS/Windows, audio-group check for Linux).

### Infrastructure
- **uv bundled per-platform.** Release installers now ship the `uv` binary as a Tauri sidecar (`bundle.externalBin`). First launch no longer requires network access for the uv-download step — bootstrap uses the bundled binary directly. Adds ~12-15 MB per platform installer; falls back to PATH lookup, then standalone download, when the bundled file isn't present (dev builds, future targets). Pinned at `UV_VERSION = "0.11.7"`; bump the constant in [lib.rs](frontend/src-tauri/src/lib.rs) and the matching env var in [release.yml](.github/workflows/release.yml) together to refresh.
- **ffmpeg fetch removed from Tauri bootstrap.** The redundant download from `eugeneware/ffmpeg-static` (saved to `app_data/bin/`) was never used by the backend, which already resolves ffmpeg via `imageio_ffmpeg.get_ffmpeg_exe()` from the pip wheel pulled by `uv sync`. Net effect: one fewer first-run network round-trip, one fewer splash-screen stage, and the splash no longer shows the misleading "Downloading ffmpeg…" line.
- **CI cross-platform check.** PRs now run `cargo check` against the Tauri shell on macOS (Apple Silicon), Windows, and Linux in parallel — surfaces platform-specific Rust regressions before tag push without paying the full ~15 min/platform tauri-bundle cost (full bundling stays in `release.yml` on tag push).
- **Release notes from CHANGELOG.** `release.yml` now extracts the matching `## [X.Y.Z]` section from `CHANGELOG.md` and uses it as the GitHub Release body, replacing the prior placeholder "Auto-generated release. See commit log for changes."
- **Tests:** `tests/test_capture_ws.py` (3 cases) covers the EOF text-frame, empty-binary-frame, and legacy disconnect-finalize paths for `/ws/transcribe`.

### Internal
- New Tauri commands: `quit_app`, `set_tray_recording`, `get_dictation_shortcut`, `set_dictation_shortcut`.
- New Tauri state: `AppFlags { quitting }`, `TrayHandle { tray }`, `DictationShortcutState { current }`.
- New deps: `tauri-plugin-single-instance` 2.x, `tauri/image-png` feature flag (enables `Image::from_bytes` for in-memory tray-icon swap).

---

## [0.2.5] — 2026-04-29

Region selector, realtime download speed, retry buttons, recheck top-right, HF mirror support, splash bootstrap-log backfill. See git log `v0.2.4..v0.2.5` for the full set.

## Earlier releases

See [GitHub Releases](https://github.com/debpalash/OmniVoice-Studio/releases) for prior versions.
