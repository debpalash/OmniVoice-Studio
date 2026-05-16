# Requirements: OmniVoice Studio v0.3.x Stabilization

**Defined:** 2026-05-16
**Core Value:** A first-run that actually works — a user who downloads the installer (or clones the repo) reaches a working voice-cloning or dubbing output without hitting a wall, and when something does go wrong, the error or docs tell them exactly what to do.

**Closure bar:** All 11 open GitHub issues are closed or have a documented workaround surfaced in README + error UI. Plus 2 explicit additions (Supertonic-3 engine, opt-in auto bug reporting).

---

## v1 Requirements

Requirements for the v0.3.x release. Each maps to roadmap phases.

### Gates (Phase 0 — non-negotiable pre-conditions)

- [ ] **GATE-01**: A frozen `omnivoice_data/` regression fixture exists and is loaded by a smoke test that runs on every PR
- [ ] **GATE-02**: CI (`ci.yml`) runs Python runtime smoke tests on macOS, Windows, and Linux — not just `cargo check` on macOS/Windows
- [ ] **GATE-03**: `release.yml` runs at least one post-build installer smoke test per platform (boot the bundled app, hit a health endpoint)
- [ ] **GATE-04**: PR template documents the two-RC release cadence and the regression-fixture requirement
- [ ] **GATE-05**: SHA-256 checksums are published in every GitHub Release body (defends the `xattr -cr` workaround context for #54)
- [ ] **GATE-06**: Open PRs #51 (cross-platform bug bash), #53 (SRT import), #61 (lazy ASR) are merged before Phase 0 finalizes the CI matrix

### Install — Quick Wins (Phase 1, Wave 1)

- [ ] **INST-01**: `setuptools` is added to `pyproject.toml` `[project.dependencies]` so WhisperX can import `pkg_resources` on Python 3.12+ (closes #58)
- [ ] **INST-02**: README install section is split into `docs/install/{macos,windows,linux,docker}.md` with per-OS instructions, and README links there instead of inlining 600 lines
- [ ] **INST-03**: macOS `xattr -cr /Applications/OmniVoice\ Studio.app` workaround is documented in `docs/install/macos.md` AND surfaced in the app's first-run-failure UI when the app detects it was quarantined (closes #54 via documented workaround)
- [ ] **INST-04**: `WEBKIT_DISABLE_COMPOSITING_MODE=1` workaround for AppImage white-screen on Fedora 44 / Ubuntu 24.04 is documented in `docs/install/linux.md` and applied conditionally by the AppImage launcher when WebKit version matches the broken range (closes #56 via documented workaround)
- [ ] **INST-05**: README download badges use templated version refs (read latest release at render time or via release script), so they don't go stale between releases
- [ ] **INST-06**: A `scripts/validate-install-docs.py` test extracts code blocks from `docs/install/*.md` and diffs them against `scripts/desktop-prod.sh` — fails CI if docs drift from the actual install script

### Docs — Onboarding (Phase 1)

- [ ] **DOCS-01**: `docs/install/troubleshooting.md` covers the top 10 install errors with cause + fix + link to the relevant GitHub issue
- [ ] **DOCS-02**: An `error → docs URL` map (`backend/core/error_docs_map.py` + frontend `errorDocsMap.ts`) renders contextual "Open docs for this error" buttons in error UI
- [ ] **DOCS-03**: CosyVoice install + troubleshooting guide exists at `docs/engines/cosyvoice.md` (closes #55, partial #44)
- [ ] **DOCS-04**: Speaker diarization setup + troubleshooting guide exists at `docs/features/diarization.md`, covering HF gating (pyannote model accept), token requirement, common failures (closes #35 sub-issue)
- [ ] **DOCS-05**: HF token guide at `docs/setup/huggingface-token.md` documents persistent token setup for macOS zsh, Windows PowerShell, Linux bash — including the in-app Settings → API Keys path

### Token & Settings (Phase 1)

- [ ] **AUTH-01**: `backend/services/env_store.py` exists and provides read/write of persistent env vars to `~/.config/omnivoice/env` (POSIX) / `%APPDATA%\OmniVoice\env` (Windows), mode 0600
- [ ] **AUTH-02**: HF token persistence uses `huggingface_hub.login(token=…)` to write to `$HF_HOME/token` — the canonical location — so engines requesting HF resources pick it up without further configuration
- [ ] **AUTH-03**: Frontend Settings → API Keys panel lets the user enter, save, and clear an HF token; clears any in-memory + on-disk copy on logout
- [ ] **AUTH-04**: Token persists across app restarts AND across spawned engine subprocesses (forwarded via env on subprocess spawn)
- [ ] **AUTH-05**: HF token is excluded from any log line via a logging filter — never written to log files, never embedded in error tracebacks (closes #35 sub-issue: leak prevention)

### Engine Isolation (Phase 2)

- [ ] **ENGINE-01**: `backend/engines/_subprocess.py` (or equivalent `SubprocessBackend`) implements per-engine subprocess + dedicated venv with `mp.get_context("spawn")` IPC; verified to work on macOS Apple Silicon
- [ ] **ENGINE-02**: Per-engine venv bootstrap reuses `gpu_sandbox.py` patterns and inherits `HF_HOME` so existing cached weights are not re-downloaded
- [ ] **ENGINE-03**: IndexTTS is migrated to `SubprocessBackend` and isolated from in-process engines (closes #42 — real fix, not just graceful-degradation wrap)
- [ ] **ENGINE-04**: A regression test loads IndexTTS + at least one in-process engine in the same session, runs one generation each, and asserts no AttributeError / no module-clash exception
- [ ] **ENGINE-05**: `TTSBackend.is_available()` is wrapped so one engine's broken state can't prevent app boot — engine registry surfaces per-engine status + last error
- [ ] **ENGINE-06**: Frontend Engine Compatibility Matrix UI shows each engine's: install state, GPU compatibility (CUDA/MPS/ROCm/CPU), and any current isolation mode (in-process vs subprocess)
- [ ] **ENGINE-07**: Existing IndexTTS users do NOT need to reinstall — first launch after upgrade migrates them transparently

### New TTS Engine — Supertonic-3 (Phase 3)

- [ ] **TTS-01**: `backend/engines/supertonic3/` implements `TTSBackend` on top of `SubprocessBackend` for Supertonic-3 (https://huggingface.co/Supertone/supertonic-3)
- [ ] **TTS-02**: `[project.optional-dependencies] supertonic = ["supertonic==1.2.3"]` is declared so users opt-in to the engine (no forced install)
- [ ] **TTS-03**: Supertonic-3 model revision SHA is pinned in code (not just the tag) so a model-card update can't silently change behavior
- [ ] **TTS-04**: Engine `is_available()` honestly reports CPU-only when CUDA is absent and Supertonic-3 has no MPS path
- [ ] **TTS-05**: Supertonic-3 license (MIT code / OpenRAIL-M model) is surfaced in the engine card UI with a link, and acceptance gates first use
- [ ] **TTS-06**: Smoke test: install via optional dep, generate 3 seconds of audio in 3 languages, assert no warnings about onnxruntime / onnxruntime-gpu double-install

### Installer Reliability — Mirror Fallback (Phase 3)

- [ ] **INST-07**: `bootstrap.rs` implements a failure-cascade mirror fallback for `uv venv` Python downloads — try GitHub → `gh-proxy` → `ghfast` → `gitmirror` → fall back to `UV_PYTHON_PREFERENCE=only-system` with a Python ≥3.11 check (closes #57, #60)
- [ ] **INST-08**: Mirror list is read from an external JSON file shipped with the installer (not hard-coded), so we can rotate mirrors without a release
- [ ] **INST-09**: Mirror configuration is allow-list only — user can pick from the shipped list but cannot enter arbitrary URLs (supply-chain risk control)
- [ ] **INST-10**: `uv sync --frozen` is enforced in bootstrap, and `uv.lock` is hash-pinned and committed (no unverified resolutions even via a mirror)
- [ ] **INST-11**: `UV_HTTP_TIMEOUT=120` and `UV_HTTP_RETRIES=5` are set in the bootstrap environment

### Stability — Dubbing Pipeline (Phase 2, runs alongside engine isolation)

- [ ] **BUG-01**: WAV export corruption in video-dubbing pipeline is reproduced, root-caused, and fixed; regression test exports a WAV via the dubbing pipeline and validates header + decode (closes #48)

### Bug Reporting (Phase 4)

- [ ] **REPORT-01**: `backend/services/bug_report.py` aggregates errors from 3 producers — Python (`global_exception_handler`), Rust (`std::panic::set_hook`), React (`ErrorBoundary` already tapping `console.error`)
- [ ] **REPORT-02**: Bug reports submit via prefilled GitHub Issues URL (`tauri-plugin-opener`) — no PAT, no third-party telemetry endpoint, no Sentry DSN
- [ ] **REPORT-03**: Default-deny payload allow-list — only explicitly approved fields (OS, app version, GPU info, engine list, redacted error summary) are included; nothing else is even read
- [ ] **REPORT-04**: Two-step consent UX — user sees the exact payload (formatted preview) and clicks "Open in GitHub" before any browser window opens
- [ ] **REPORT-05**: HF tokens, file paths under `$HOME`, and email-like patterns are scrubbed before payload preview is shown
- [ ] **REPORT-06**: Per-day rate cap (default 3 reports / 24h) prevents inbox flooding from a stuck app
- [ ] **REPORT-07**: SHA-1 content dedup prevents the same crash submitting twice in one session
- [ ] **REPORT-08**: Recursion guard — if the bug reporter itself throws, it does NOT recursively report itself (would self-DDoS)
- [ ] **REPORT-09**: Pre-submit GitHub search opens a "we found similar issues" view before allowing a new submission, with link-to-existing as a primary action
- [ ] **REPORT-10**: All auto-reports carry an `auto-report` GitHub label so maintainers can triage them as a distinct class
- [ ] **REPORT-11**: GitHub Issues URL length is capped at ~6 KB encoded; payload trimming + "see attached log" link to a pastebin-style local file path when too long
- [ ] **REPORT-12**: Bug reporting is OFF by default; user must opt in via Settings → Privacy → "Help improve OmniVoice" with explicit copy explaining what is and isn't sent

### Release & Verification (Phase 5)

- [ ] **REL-01**: `v0.3.0-rc1` is cut and exercised on clean VMs (UTM macOS Sequoia, Hyper-V Windows 11, Ubuntu 24.04, Fedora 44) by following the install docs verbatim — no shortcuts
- [ ] **REL-02**: 48-hour soak period between rc1 and promotion to `v0.3.0`
- [ ] **REL-03**: Every closed issue has a verification line in the release notes pointing to the commit + PR that closed it (or the docs change for documented-workaround closures)
- [ ] **REL-04**: Retrospective is published with three metrics: (a) weighted closure count, (b) net inbox change (closed minus opened during milestone), (c) Discord support-volume delta on top 3 topics — install, HF token, dubbing
- [ ] **REL-05**: Explicit tracking issues are filed for: macOS code signing (real cert + notarization), Tauri/WebKit Fedora upstream fix, per-engine subprocess hardening beyond IndexTTS
- [ ] **REL-06**: All 11 originally-open issues are either Closed via fix, Closed via documented-workaround + UI surfacing, or moved to a v0.4 tracking milestone with explicit user-facing communication

---

## v2 Requirements

Acknowledged for v0.4+, not in this milestone.

### Engine Plugins

- **TTS-V2-01**: Qwen3-TTS engine integration (per #44 request beyond Supertonic-3)
- **TTS-V2-02**: VoiceBox engine integration (per #44 request)
- **ENGINE-V2-01**: All engines migrated to `SubprocessBackend` (not just IndexTTS)

### Identity & Distribution

- **SIGN-V2-01**: macOS code signing with real Apple Developer cert + notarization (eliminates the `xattr -cr` workaround for #54)
- **SIGN-V2-02**: Windows code signing certificate
- **DIST-V2-01**: Auto-update with user consent prompt + signed payload verification

### Secrets

- **AUTH-V2-01**: OS keyring (Python `keyring`) for HF token + future API keys, with `~/.config/omnivoice/env` as fallback

### Bug Reporting Upgrades

- **REPORT-V2-01**: GitHub App device flow for users who want one-click submission without leaving the app
- **REPORT-V2-02**: Optional crash-aggregation backend (self-hosted, opt-in) for users who want trend analysis

---

## Out of Scope

Explicitly excluded for v0.3.x. Anti-features that would violate constraints are flagged.

| Feature | Reason |
|---------|--------|
| New TTS engines beyond Supertonic-3 (Qwen3, VoiceBox) | Stabilization focus; track in v2 |
| Real macOS code signing + notarization | Infrastructure project — needs Apple Developer account + signing pipeline; documented `xattr -cr` workaround is this milestone's answer |
| Windows code signing certificate | Same — separate infrastructure milestone |
| Major UI/UX redesign | Fix what's broken; don't redesign screens |
| Auto-update without explicit consent | **Anti-feature** — violates local-first/no-surprise principle |
| Third-party crash-reporting SaaS (Sentry, Bugsnag, Rollbar, Datadog) | **Anti-feature** — violates "no required cloud calls" constraint; GitHub Issues URL is the chosen primary path |
| Mandatory user accounts / login | **Anti-feature** — violates "no accounts, no API keys" Core Value |
| OmniVoice-owned GitHub bot token for auto-filing issues on behalf of users | **Anti-feature** — token in binary would be extracted; users should own their issues |
| Embedded HF token in binary | **Anti-feature** — token theft + rate-limit DDoS vector |
| Freeform mirror URL input | Supply-chain attack surface; allow-list only (INST-09) |
| OS keyring integration | Defer to v0.4 — `$HF_HOME/token` + `~/.config/omnivoice/env` is sufficient; keyring adds a native dep without clear v0.3 user-pull |
| Full subprocess migration for all engines | Risk-bounded to IndexTTS this milestone; other engines stay in-process pending evidence of clashes |
| Material for MkDocs / heavyweight docs framework | Material for MkDocs entered maintenance Nov 2025; markdown-in-repo is the durable choice |

---

## Traceability

Filled by roadmap during Step 8. Coverage check happens after roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| GATE-01 — GATE-06 | TBD | Pending |
| INST-01 — INST-06 | TBD | Pending |
| DOCS-01 — DOCS-05 | TBD | Pending |
| AUTH-01 — AUTH-05 | TBD | Pending |
| ENGINE-01 — ENGINE-07 | TBD | Pending |
| TTS-01 — TTS-06 | TBD | Pending |
| INST-07 — INST-11 | TBD | Pending |
| BUG-01 | TBD | Pending |
| REPORT-01 — REPORT-12 | TBD | Pending |
| REL-01 — REL-06 | TBD | Pending |

**Coverage (filled by roadmapper):**
- v1 requirements: 49 total
- Mapped to phases: 0 (pending roadmap)
- Unmapped: 49 ⚠️ (expected before roadmap runs)

---
*Requirements defined: 2026-05-16*
*Last updated: 2026-05-16 after initial definition*
