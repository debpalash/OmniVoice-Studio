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
- [ ] **GATE-06**: Open PRs #51 (cross-platform bug bash), ~~#53 (SRT import)~~ ✓ merged 2026-05-16, ~~#61 (lazy ASR)~~ ✓ merged 2026-05-16, and #62 (Wave 1 quick wins — setuptools/Linux/Russia) are merged before Phase 0 finalizes the CI matrix

### Install — Quick Wins (Phase 1, Wave 1)

- [ ] **INST-01**: `setuptools` is added to `pyproject.toml` `[project.dependencies]` so WhisperX can import `pkg_resources` on Python 3.12+ (closes #58) — **DONE in PR #62 (pending merge)**
- [ ] **INST-02**: README install section is split into `docs/install/{macos,windows,linux,docker}.md` with per-OS instructions, and README links there instead of inlining 600 lines
- [ ] **INST-03**: macOS `xattr -cr /Applications/OmniVoice\ Studio.app` workaround is documented in `docs/install/macos.md` AND surfaced in the app's first-run-failure UI when the app detects it was quarantined (closes #54 via documented workaround)
- [ ] **INST-04**: `WEBKIT_DISABLE_COMPOSITING_MODE=1` workaround for AppImage white-screen on Fedora 44 / Ubuntu 24.04 is documented in `docs/install/linux.md` and applied conditionally by the AppImage launcher when WebKit version matches the broken range (closes #56 via documented workaround) — **README docs landed in PR #62; launcher conditional still pending**
- [ ] **INST-12**: Windows Triton/torch.compile OOM workaround documented in `docs/install/windows.md` + surfaced via "Disable torch.compile on Windows" toggle in Settings → Performance (closes #65 — NEW issue, filed post-planning)
- [ ] **INST-13**: Dictation-widget mode is discoverable via UI: tray menu item "Switch to Dictation Widget" (studio mode → restarts in `--pill`) AND a Settings → Launch options checkbox "Launch as dictation widget on startup" persisting `launch_as_widget` to `config.json`. Backend Rust + scripts shipped in Phase 0 (`bun desktop-prod:pill`); frontend Settings checkbox is the Phase 2 finish-line (closes the existing UX gap where the widget was unreachable from the GUI).
- [ ] **INST-05**: README download badges use templated version refs (read latest release at render time or via release script), so they don't go stale between releases
- [ ] **INST-06**: A `scripts/validate-install-docs.py` test extracts code blocks from `docs/install/*.md` and diffs them against `scripts/desktop-prod.sh` — fails CI if docs drift from the actual install script

### Docs — Onboarding (Phase 1)

- [ ] **DOCS-01**: `docs/install/troubleshooting.md` covers the top 10 install errors with cause + fix + link to the relevant GitHub issue
- [ ] **DOCS-02**: An `error → docs URL` map (`backend/core/error_docs_map.py` + frontend `errorDocsMap.ts`) renders contextual "Open docs for this error" buttons in error UI
- [ ] **DOCS-03**: CosyVoice install + troubleshooting guide exists at `docs/engines/cosyvoice.md` (closes #55, partial #44)
- [ ] **DOCS-04**: Speaker diarization setup + troubleshooting guide exists at `docs/features/diarization.md`, covering HF gating (pyannote model accept), token requirement, common failures (closes #35 sub-issue)
- [ ] **DOCS-05**: HF token guide at `docs/setup/huggingface-token.md` documents persistent token setup for macOS zsh, Windows PowerShell, Linux bash — including the in-app Settings → API Keys path

### Token & Settings (Phase 1)

**Design: three sources, cascading priority, automatic fallback.** OmniVoice supports HF tokens from three locations simultaneously. The active token is the first one in priority order that exists AND validates (`whoami` returns 200). If the active token returns 401 during use, the resolver automatically retries with the next source and updates the active marker.

**Resolution priority (highest → lowest):**

| # | Source | Storage | Set via |
|---|--------|---------|---------|
| 1 | **App** | SQLite `settings` table, column-encrypted (AES-GCM, key derived from machine ID) | Settings → API Keys panel |
| 2 | **Env var** | `$HF_TOKEN` in the launching shell's environment | `export HF_TOKEN=hf_…` in `~/.zshrc` / `.env` / Windows env |
| 3 | **Global HF CLI** | `~/.cache/huggingface/token` (mode 0600) | `huggingface-cli login` |

The Settings panel shows ALL three sources with their state (set/unset, masked preview, `whoami` result) and a clear "Active: <source>" badge. User can clear any source independently; clearing the active source falls back to the next in cascade.

- [ ] **AUTH-01**: `backend/services/token_resolver.py` exists and implements the 3-source cascade with on-failure fallback. Returns `(token, source: "app"|"env"|"hf-cli", username)` so callers can surface attribution.
- [ ] **AUTH-02**: App-stored tokens persist to SQLite `settings` table (encrypted column, AES-GCM, machine-ID-derived key). NOT a separate file. Schema migration handled via the project's `init_db()` (or alembic when adopted). Read/write via `backend/services/settings_store.py`.
- [ ] **AUTH-03**: Frontend Settings → API Keys panel:
  - Renders 3 source rows (App / Env / HF CLI), each with: token status (set/unset), masked preview (`hf_…3jw`), `whoami` result, "Test now" button, "Clear" button (for App only; Env and HF CLI are read-only display).
  - Shows "Active: <source>" badge based on resolver result.
  - Save action calls `huggingface_hub.login(token=…, add_to_git_credential=False)` AS WELL AS writing to App store — so power users get the canonical file populated too (defensive — never makes app-store-only a single point of failure).
  - Logout/Clear action removes from App store; offers "Also clear ~/.cache/huggingface/token?" checkbox (default off — respect global state).
- [ ] **AUTH-04**: Token persists across app restarts AND across spawned engine subprocesses. Subprocess spawn injects the resolved token as `$HF_TOKEN` in the child env so subprocess engines (IndexTTS, CosyVoice, etc.) see it without re-reading SQLite.
- [ ] **AUTH-05**: HF token is excluded from any log line via a logging filter — never written to log files, never embedded in error tracebacks, never surfaced in the bug-report payload (Phase 5). Closes #35 sub-issue.
- [ ] **AUTH-06**: On HTTP 401 from `huggingface_hub` during a download, the resolver auto-retries with the next source in cascade. If all sources fail, surfaces a single error toast: "HF auth failed across all configured sources — open Settings → API Keys to fix." (Prevents the current confusing UX where one bad token blocks downloads even though a working one exists at lower priority.)

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

### Adaptive & Specialty Engines — Spike (Phase 4, gates integration)

Both items below are **investigations first**. Integration requirements (GGUF-* / SING-*) only run if the corresponding spike returns GO. NO-GO outcomes are documented in `.planning/decisions/` and the corresponding integration requirements move to Out of Scope or v2.

- [ ] **SPIKE-01**: Verify `https://huggingface.co/Serveurperso/OmniVoice-GGUF` is the intended artifact — fetch model card, confirm relationship to OmniVoice Studio's voice-cloning model lineage (NOT a different "OmniVoice" project), document license, confirm runtime requirement (llama.cpp / candle / custom), enumerate available quant variants with their VRAM footprints. Output: `.planning/decisions/gguf-spike.md` with GO/NO-GO + rationale. (Hardware-adaptive default cloning engine — user-requested.)
- [ ] **SPIKE-02**: Verify `https://huggingface.co/ModelsLab/omnivoice-singing` is the intended artifact — fetch model card, confirm license, confirm runtime (likely shares an OmniVoice runtime; need to check), document whether it's sung-vocal cloning, full-song generation, or both, and what input/output formats it expects. Output: `.planning/decisions/singing-spike.md` with GO/NO-GO + rationale. (Singing extension for the dubbing pipeline — user-requested.)

### Hardware-Adaptive Default Engine — GGUF (Phase 4, conditional on SPIKE-01=GO)

- [ ] **GGUF-01**: Hardware probe extends the existing GPU auto-detect to also report available VRAM in MB and a "compute class" bucket (CPU-only / low-VRAM / mid-VRAM / high-VRAM)
- [ ] **GGUF-02**: Quant-selection table maps (compute class) → recommended GGUF variant; shipped as `backend/engines/omnivoice_gguf/quant_map.json` so the table can be updated without an app release
- [ ] **GGUF-03**: `backend/engines/omnivoice_gguf/` implements `TTSBackend` on top of `SubprocessBackend`, runs the auto-selected quant via the runtime confirmed in SPIKE-01
- [ ] **GGUF-04**: First-run / Settings UI surfaces the auto-selected quant with a one-click "pick a different quant" override (lets advanced users force a higher- or lower-quality variant)
- [ ] **GGUF-05**: On hardware that passes the GGUF probe, the GGUF engine becomes the default for voice cloning. The pre-existing default engine is preserved as fallback when GGUF probe / load fails, and the choice is exposed (and overridable) in Settings → Engines → Default
- [ ] **GGUF-06**: Smoke test: probe → select → load → clone 3 seconds across 3 representative hardware classes (CPU-only Linux, 8 GB VRAM macOS/Windows, 16+ GB VRAM Windows) — assert quant matches the table and output is intelligible

### Singing Variant for Dubbing Pipeline (Phase 4, conditional on SPIKE-02=GO)

- [ ] **SING-01**: `backend/engines/omnivoice_singing/` implements singing voice cloning following the SubprocessBackend pattern; engine card declares it as "singing/musical content" rather than a general-purpose TTS
- [ ] **SING-02**: Dubbing pipeline gains a "singing mode" toggle in the dub-job UI — when enabled, vocal-isolation output (Demucs vocals stem) routes through the singing engine while the instrumental stem is preserved untouched in the final mix
- [ ] **SING-03**: Auto-detect singing vs spoken segments in source audio (start with a simple pitch-stability + energy heuristic; defer model-based classifier to v2) and route segment-by-segment — power-user override available per segment in the dubbing job UI
- [ ] **SING-04**: License + model-card link surfaced in the singing engine card; first-use acceptance flow gates download
- [ ] **SING-05**: Smoke test: dub a 30-second source mixing speech + singing — verify both segments produce intelligible target output with consistent voice identity and the instrumental remains in the final mix

### Bug Reporting (Phase 5)

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

### Release & Verification (Phase 6)

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
| New TTS engines beyond Supertonic-3, OmniVoice-GGUF, and the singing variant (Qwen3, VoiceBox) | Stabilization focus; track in v2 |
| Model-based singing-vs-speech classifier (vs heuristic) | Heuristic in SING-03 is sufficient for v0.3; train/integrate a real classifier in v0.4 |
| Custom GGUF quants we produce ourselves | Defer to v0.4 — use upstream `Serveurperso` quants only this milestone |
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
| Per-segment audio effects DSP preset selector (#67 / PR #68) | Feature, not stability — defer to v0.4; thank contributor + close PR with kind note |
| Custom model download directory (#64) | Feature, not stability — defer to v0.4; `HF_HUB_CACHE` env var is the v0.3 workaround |
| Full zh-CN frontend localization (PR #66) | UI redesign-adjacent + 23-file diff — defer to a dedicated i18n milestone; cherry-pick Windows/backend fixes only if they don't conflict with our engine isolation work |
| Empty-template bug reports without repro (#63) | Reporter must fill template; auto-close after 14 days no-response |

---

## Traceability

Filled by roadmap on 2026-05-16; updated 2026-05-16 after inserting Phase 4 (Adaptive & Specialty Engines). Coverage = 62 / 62 v1 requirements (100%). No orphans, no duplicates.

| Requirement | Phase | Status |
|-------------|-------|--------|
| GATE-01 | Phase 0 | Pending |
| GATE-02 | Phase 0 | Pending |
| GATE-03 | Phase 0 | Pending |
| GATE-04 | Phase 0 | Pending |
| GATE-05 | Phase 0 | Pending |
| GATE-06 | Phase 0 | Pending |
| INST-01 | Phase 1 | Pending |
| INST-02 | Phase 1 | Pending |
| INST-03 | Phase 1 | Pending |
| INST-04 | Phase 1 | Pending |
| INST-05 | Phase 1 | Pending |
| INST-06 | Phase 1 | Pending |
| DOCS-01 | Phase 1 | Pending |
| DOCS-02 | Phase 1 | Pending |
| DOCS-03 | Phase 1 | Pending |
| DOCS-04 | Phase 1 | Pending |
| DOCS-05 | Phase 1 | Pending |
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 1 | Pending |
| AUTH-04 | Phase 1 | Pending |
| AUTH-05 | Phase 1 | Pending |
| AUTH-06 | Phase 1 | Pending |
| ENGINE-01 | Phase 2 | Pending |
| ENGINE-02 | Phase 2 | Pending |
| ENGINE-03 | Phase 2 | Pending |
| ENGINE-04 | Phase 2 | Pending |
| ENGINE-05 | Phase 2 | Pending |
| ENGINE-06 | Phase 2 | Pending |
| ENGINE-07 | Phase 2 | Pending |
| BUG-01 | Phase 2 | Pending |
| TTS-01 | Phase 3 | Pending |
| TTS-02 | Phase 3 | Pending |
| TTS-03 | Phase 3 | Pending |
| TTS-04 | Phase 3 | Pending |
| TTS-05 | Phase 3 | Pending |
| TTS-06 | Phase 3 | Pending |
| INST-07 | Phase 3 | Pending |
| INST-08 | Phase 3 | Pending |
| INST-09 | Phase 3 | Pending |
| INST-10 | Phase 3 | Pending |
| INST-11 | Phase 3 | Pending |
| INST-12 | Phase 1 | Pending |
| INST-13 | Phase 0 (backend) + Phase 2 (UI) | In progress (backend shipped) |
| SPIKE-01 | Phase 4 | Pending |
| SPIKE-02 | Phase 4 | Pending |
| GGUF-01 | Phase 4 | Pending (conditional on SPIKE-01=GO) |
| GGUF-02 | Phase 4 | Pending (conditional on SPIKE-01=GO) |
| GGUF-03 | Phase 4 | Pending (conditional on SPIKE-01=GO) |
| GGUF-04 | Phase 4 | Pending (conditional on SPIKE-01=GO) |
| GGUF-05 | Phase 4 | Pending (conditional on SPIKE-01=GO) |
| GGUF-06 | Phase 4 | Pending (conditional on SPIKE-01=GO) |
| SING-01 | Phase 4 | Pending (conditional on SPIKE-02=GO) |
| SING-02 | Phase 4 | Pending (conditional on SPIKE-02=GO) |
| SING-03 | Phase 4 | Pending (conditional on SPIKE-02=GO) |
| SING-04 | Phase 4 | Pending (conditional on SPIKE-02=GO) |
| SING-05 | Phase 4 | Pending (conditional on SPIKE-02=GO) |
| REPORT-01 | Phase 5 | Pending |
| REPORT-02 | Phase 5 | Pending |
| REPORT-03 | Phase 5 | Pending |
| REPORT-04 | Phase 5 | Pending |
| REPORT-05 | Phase 5 | Pending |
| REPORT-06 | Phase 5 | Pending |
| REPORT-07 | Phase 5 | Pending |
| REPORT-08 | Phase 5 | Pending |
| REPORT-09 | Phase 5 | Pending |
| REPORT-10 | Phase 5 | Pending |
| REPORT-11 | Phase 5 | Pending |
| REPORT-12 | Phase 5 | Pending |
| REL-01 | Phase 6 | Pending |
| REL-02 | Phase 6 | Pending |
| REL-03 | Phase 6 | Pending |
| REL-04 | Phase 6 | Pending |
| REL-05 | Phase 6 | Pending |
| REL-06 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 74 total (was 62 at planning; +12 post-triage: INST-12, AUTH-06, GATE-06 expansion, plus original undercount)
- Mapped to phases: 74 ✓
- Unmapped: 0 ✓
- Duplicates: 0 ✓

| Phase | Requirement Count |
|-------|-------------------|
| Phase 0 — Gates | 6 |
| Phase 1 — Install + Token + Docs + Error UX | 16 |
| Phase 2 — Engine Isolation + WAV-export fix | 8 |
| Phase 3 — Supertonic-3 + Mirror Reliability | 11 |
| Phase 4 — Adaptive & Specialty Engines (spike-first) | 13 |
| Phase 5 — Opt-in Bug Reporting | 12 |
| Phase 6 — Release, Verification, Retro | 6 |
| **Total** | **62** |

---
*Requirements defined: 2026-05-16*
*Last updated: 2026-05-16 after inserting Phase 4 (Adaptive & Specialty Engines — SPIKE/GGUF/SING) and renumbering REPORT-* → Phase 5, REL-* → Phase 6*
