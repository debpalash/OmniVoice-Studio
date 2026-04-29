# Changelog

All notable changes to OmniVoice Studio.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Versions track the desktop app (`tauri.conf.json` + `frontend/src-tauri/Cargo.toml`).
The bundled TTS model package (`pyproject.toml`) is versioned independently.

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
- **CI cross-platform check.** PRs now run `cargo check` against the Tauri shell on macOS (Apple Silicon), Windows, and Linux in parallel — surfaces platform-specific Rust regressions before tag push without paying the full ~15 min/platform tauri-bundle cost (full bundling stays in `release.yml` on tag push).
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
