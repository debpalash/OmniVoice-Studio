# OmniVoice Studio

## What This Is

OmniVoice Studio is an open-source, fully-local ElevenLabs alternative — a desktop app for voice cloning, voice design, video dubbing, and real-time dictation across 646 languages. It runs entirely on the user's machine (CUDA/MPS/ROCm/CPU auto-detect), with no API keys, no accounts, and no cloud dependencies. Today it's a v0.2.7 active beta with a growing user base who hit it with real workloads (50-video batches, multi-engine setups, edge-OS platforms) and report friction in GitHub Issues and Discord.

## Core Value

**A first-run that actually works.** A user who downloads the installer (or clones the repo) should reach a working voice-cloning or dubbing output without hitting a wall — and when something does go wrong, the error or docs should tell them exactly what to do.

Everything else (new engines, fancy features) is downstream of "the thing installs and runs reliably across platforms, with the engines and pipelines users already depend on staying compatible."

## Requirements

### Validated

<!-- Shipped and confirmed valuable in prior milestones. -->

- ✓ Voice cloning (zero-shot, 3-second clip) — existing
- ✓ Voice design (gender/age/accent/pitch/speed/emotion) — existing
- ✓ Video dubbing (YouTube/file → transcribe → translate → re-voice → MP4) — existing
- ✓ Dictation widget (global hotkey, auto-paste) — existing
- ✓ Vocal isolation (Demucs) — existing
- ✓ Speaker diarization (Pyannote + WhisperX) — existing
- ✓ Batch queue (drop N videos, per-job progress) — existing
- ✓ MCP server (use OmniVoice from Claude/Cursor/etc.) — existing
- ✓ AI watermark (AudioSeal) — existing
- ✓ GPU auto-detect + low-VRAM offloading — existing
- ✓ Native desktop bundles (macOS DMG, Windows MSI, Linux AppImage/deb) — existing
- ✓ Multi-engine TTS backend (IndexTTS, CosyVoice, etc.) — existing
- ✓ SRT subtitle import (bypass Whisper) — existing (PR #52)

### Active

<!-- This milestone's scope: stabilization + onboarding + targeted additions. -->

**Wave 1 — Quick wins (install/launch unblocks):**
- [ ] Fix `No module named 'pkg_resources'` — add `setuptools` to `pyproject.toml` (closes #58)
- [ ] Document `xattr -cr` workaround for macOS Sequoia "damaged" dmg in README + surface in error UI (closes #54 via documented workaround)
- [ ] Document `WEBKIT_DISABLE_COMPOSITING_MODE=1` for AppImage white screen on Fedora 44 / Ubuntu 24.04 (closes #56 via documented workaround)
- [ ] Verify open PRs #51 / #53 / #61 are merged (SRT import, lazy ASR, cross-platform bug bash)

**Wave 2 — Stability pass (degraded experiences):**
- [ ] Add Python mirror fallback for `uv venv` in restricted networks (Russia/CIS) (closes #60, #57)
- [ ] Fix HF token persistence — env-var workflow that survives shell sessions and is documented (closes #35 sub-issue)
- [ ] Investigate + fix WAV export corruption in video dubbing pipeline (closes #48)
- [ ] IndexTTS engine isolation so it doesn't clash with other engines (closes #42)
- [ ] Fix speaker diarization setup failure (closes #35 sub-issue)

**Wave 3 — Onboarding & docs (drop Discord support volume):**
- [ ] Installation tutorial covering macOS/Windows/Linux happy paths + common errors
- [ ] CosyVoice install + troubleshooting documentation (closes #55, partially #35, #44)
- [ ] Speaker diarization troubleshooting guide (closes #35 sub-issue)
- [ ] HF token setup guide (persistent env-var on macOS/Windows/Linux shells)

**Additions beyond the inbox:**
- [ ] Add Supertonic-3 as a new TTS engine (https://huggingface.co/Supertone/supertonic-3) — explicit user request
- [ ] In-app bug reporting that auto-files structured GitHub issues for product quality (opt-in, captures logs/system info)
- [ ] **Spike + conditional integration**: Evaluate `Serveurperso/OmniVoice-GGUF` as a hardware-adaptive default cloning engine — auto-pick GGUF quant from detected VRAM/compute class so low-VRAM users get a working cloning experience out of the box
- [ ] **Spike + conditional integration**: Evaluate `ModelsLab/omnivoice-singing` to extend the dubbing pipeline with sung-vocal cloning (route Demucs vocal stem through the singing engine when source contains singing; preserve instrumental)

### Out of Scope

<!-- Explicit boundaries. -->

- **New TTS engines beyond Supertonic-3, OmniVoice-GGUF, and the singing variant** (Qwen3, VoiceBox from #44) — keep this milestone focused on stabilization; revisit in a future milestone
- **Real macOS code signing + notarization** — infrastructure project (Apple Developer account, signing pipeline); documented `xattr -cr` workaround is the milestone's answer for #54
- **Major UI/UX redesign** — fix what's broken in existing screens; do not redesign
- **New features beyond the issue list + the two explicit additions above** — no scope creep into novel capabilities
- **100% cloud-free guarantee revision** — auto bug reporting must be **opt-in** and submit to GitHub Issues only; never replace the local-first brand promise

## Context

**Project state:**
- Currently v0.2.7, in active beta. Branch `ai-gsd-setup` was prepared for setting up GSD-driven planning before this milestone.
- 11 open GitHub issues, 3 open PRs, 22 merged PRs to date. Status report at `/Users/user4/.gemini/antigravity/brain/e3728e0c-f094-418d-b349-ae8db3ae132d/project_status.md.resolved` was the source-of-truth for milestone scoping.

**User feedback themes (real Discord/GitHub quotes from triage):**
- "Hello guys any installation tutorial" → installation is the most common entry-point pain
- "How do I set HF token persistently?" → users get stuck before they can use HF-gated models (diarization, some engines)
- "Problem with video dubbing" → dubbing pipeline has visible bugs (#48 WAV corruption, #42 IndexTTS clash, #35 diarization)

**Tech stack (inferred from repo):**
- Python backend (`backend/`, `omnivoice/`), `pyproject.toml`, `uv venv` bootstrap, `alembic` migrations
- React/JS frontend (`frontend/`, `bun.lock`, `package.json`), `App.jsx` recently refactored
- Tauri desktop wrapper (DMG/MSI/AppImage/deb bundles, `deploy/`, `backend.spec` for PyInstaller)
- ML stack: WhisperX, Pyannote, Demucs, AudioSeal, multiple TTS engines pluggable via `TTSBackend` subclass

**Recent context (last 5 commits):**
- `feat: import .srt subtitles to bypass Whisper (#52)`
- `Post-refactor cleanup: wire fingerprints, drop dead code, scope pytest (#50)`
- `Stability pass: DB leaks, App.jsx hooks refactor, desktop bootstrap (#49)`
- `fix: resolve open issues — Discord link, Docker crash, IndexTTS compat, engine tooltips (#47)`
- `feat: Scalar API docs, community health files, Quickstart cards (#41)`

The trajectory is already stabilization-oriented; this milestone formalizes and finishes that arc.

## Constraints

- **Existing engine compatibility**: Users with already-installed engines (IndexTTS, CosyVoice, etc.) must not have to reinstall. Fixes touching engine code must be backward-compatible with on-disk model state.
- **Cross-platform parity**: Every fix must work on macOS (Apple Silicon + Intel), Windows (x64), and Linux (AppImage + deb). No platform-only regressions; the cross-platform bug bash (PR #51) is the baseline.
- **Backward-compatible project data**: Existing `omnivoice_data/` (user voices, projects, settings) must keep working without manual migration. Any DB schema change goes through alembic with a tested upgrade path.
- **Local-first guarantee preserved**: Auto bug reporting (new addition) must be **opt-in**, must submit only to GitHub Issues (no third-party telemetry endpoint), and the app must remain fully functional with reporting disabled. No required cloud calls, accounts, or API keys.
- **Beta release cadence**: Ship as `v0.3.x` minor releases — small, frequent, low-risk drops. Don't gate a v1.0 on this milestone (per the "Empty the inbox" outcome — version is secondary to issue closure).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Milestone framing = "Empty the inbox" (close all 11 open issues) | User chose this over "trustworthy v0.3.0 release" or "drop Discord support volume" — concrete, measurable closure bar | — Pending |
| Hard issues (#54 code signing, #56 Tauri/WebKit) count as closed if a workaround is documented in README + surfaced in error UI | Real fixes are infrastructure-level (signing cert, upstream Tauri bug) — don't block milestone on them | — Pending |
| Add Supertonic-3 + spike-and-conditionally-add OmniVoice-GGUF and OmniVoice-Singing; defer Qwen3/VoiceBox | All three model additions came from explicit user requests by URL; GGUF and Singing are spike-first because both names are plausibly ambiguous and need verification before code work | — Pending |
| Add opt-in auto bug reporting that files GitHub issues | User flagged "we need to add bug issues auto reported for product quality" — but local-first promise constrains it to opt-in + GitHub-only target | — Pending |
| Treat video dubbing fixes as part of general stability (not a dedicated phase) | User chose "Roll into stability" over carving dubbing out separately | — Pending |
| Run milestone in YOLO/autonomous mode (auto-approve gates) | User said "do actions to fix improve and feature building on auto, test with cli/code" | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-16 after initialization*
