# Roadmap: OmniVoice Studio v0.3.x Stabilization

**Defined:** 2026-05-16
**Granularity:** standard (7 phases)
**Mode:** mvp (per phase)
**Coverage:** 62/62 v1 requirements mapped

---

## Core Value

A first-run that actually works — a user who downloads the installer (or clones the repo) reaches a working voice-cloning or dubbing output without hitting a wall, and when something does go wrong, the error or docs tell them exactly what to do.

## Closure Bar

All 11 open GitHub issues are closed or have a documented workaround surfaced in README + error UI, plus two surgical additions: Supertonic-3 engine and opt-in GitHub-Issues bug reporting.

---

## Phases

- [ ] **Phase 0: Gates** — Hard pre-condition gate: cross-platform CI, regression fixture, installer smoke test, two-RC cadence
- [ ] **Phase 1: Install + Token Persistence + Docs Scaffolding + Error UX** — Highest user-value density: closes #35, #54, #56, #58, partial #55 in one phase
- [ ] **Phase 2: Engine Isolation (SubprocessBackend → IndexTTS + WAV-export dubbing fix)** — Builds the durable subprocess primitive that Phase 3 plugs into
- [ ] **Phase 3: Supertonic-3 Engine + Installer Mirror Reliability** — New engine on the proven primitive, plus mirror-cascade fix for restricted networks
- [ ] **Phase 4: Adaptive & Specialty Engines (spike-first)** — Verify and conditionally integrate `Serveurperso/OmniVoice-GGUF` (hardware-adaptive default cloning) and `ModelsLab/omnivoice-singing` (singing variant for dubbing)
- [ ] **Phase 5: Opt-in Bug Reporting** — Default-deny payload, two-step consent, GitHub-Issues-URL submission path
- [ ] **Phase 6: Release, Verification, Retro** — Cut v0.3.0-rc1, clean-VM exercise, 48h soak, ship v0.3.0, publish retrospective

---

## Phase Details

### Phase 0: Gates
**Goal:** A frozen regression fixture and a cross-platform CI matrix prove every PR boots a real app on macOS, Windows, and Linux before any stability work opens.
**Mode:** mvp
**Depends on:** Nothing (first phase, hard gate)
**Hard gate:** Phase 0 must merge and prove green before any other phase opens PRs. Open PRs #51 (cross-platform bug bash), #53 (SRT import), #61 (lazy ASR) are merged before Phase 0 finalizes the CI matrix.
**Closes issues:** none directly (enables closure of every issue downstream); merges open PRs #51, #53, #61
**Requirements:** GATE-01, GATE-02, GATE-03, GATE-04, GATE-05, GATE-06
**Success Criteria** (what must be TRUE):
  1. CI matrix runs Python runtime smoke tests on macOS, Windows, and Linux on every PR — and is green on `main`
  2. A `omnivoice_data/` regression fixture exists, is checked in, and is loaded by the PR smoke test
  3. `release.yml` boots the bundled installer on each platform and pings a health endpoint as part of the release job
  4. Every GitHub Release body carries SHA-256 checksums for every published artifact
  5. PR template documents the two-RC release cadence and the regression-fixture requirement; PRs #51, #53, #61 are merged
**Plans:** TBD
**UI hint:** no

### Phase 1: Install + Token Persistence + Docs Scaffolding + Error UX
**Goal:** New users follow per-OS install docs to a working app, set their HF token once and have it persist, and when something breaks the error UI links them straight to the right docs page.
**Mode:** mvp
**Depends on:** Phase 0
**User-value density:** This phase closes the most issues in the milestone — #35 (HF token + diarization sub-issues), #54 (macOS quarantine via documented `xattr -cr` workaround surfaced in error UI), #56 (AppImage white-screen via documented `WEBKIT_DISABLE_COMPOSITING_MODE=1` workaround), #58 (`pkg_resources`), and partial #55 (CosyVoice docs).
**Closes issues:** #35, #54 (documented workaround), #55 (partial), #56 (documented workaround), #58
**Requirements:** INST-01, INST-02, INST-03, INST-04, INST-05, INST-06, DOCS-01, DOCS-02, DOCS-03, DOCS-04, DOCS-05, AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05
**Success Criteria** (what must be TRUE):
  1. A new user on macOS / Windows / Linux follows `docs/install/{macos,windows,linux,docker}.md` end-to-end and reaches a working app (validated by `scripts/validate-install-docs.py` against the actual install script)
  2. User enters an HF token in Settings → API Keys once; the token survives app restart, is forwarded to engine subprocesses, and never appears in any log file or error traceback
  3. When the app raises a known error class (quarantined `.app`, AppImage WebKit white-screen, missing `pkg_resources`, missing HF token, etc.), the error UI shows an "Open docs for this error" button that links to the right `docs/install/*.md` section
  4. README install section is split into per-OS files with templated version badges, no longer inlining 600 lines; `docs/install/troubleshooting.md` covers the top 10 install errors
  5. CosyVoice install guide (`docs/engines/cosyvoice.md`), diarization guide (`docs/features/diarization.md`), and HF token guide (`docs/setup/huggingface-token.md`) exist and are linked from README + error UI
**Plans:** TBD
**UI hint:** yes

### Phase 2: Engine Isolation (SubprocessBackend → IndexTTS + WAV-export dubbing fix)
**Goal:** IndexTTS runs in a dedicated subprocess + venv so it cannot break other engines, the dubbing pipeline exports valid WAV files, and the engine registry surfaces honest per-engine status — without forcing any existing user to reinstall.
**Mode:** mvp
**Depends on:** Phase 1
**Research recommended:** open questions on IndexTTS `transformers` clash shape, `mp.get_context("spawn")` on Apple Silicon, and `HF_HOME` inheritance for existing IndexTTS users (SUMMARY.md Open Questions table — Phase 2 rows).
**Closes issues:** #42 (real fix, not graceful-degradation wrap), #48 (WAV export corruption)
**Requirements:** ENGINE-01, ENGINE-02, ENGINE-03, ENGINE-04, ENGINE-05, ENGINE-06, ENGINE-07, BUG-01
**Success Criteria** (what must be TRUE):
  1. A regression test loads IndexTTS + at least one in-process engine in the same session, runs one generation on each, and passes with no AttributeError / module-clash exception (closes #42)
  2. A regression test exports a WAV via the video-dubbing pipeline; the file has a valid header and decodes without corruption (closes #48)
  3. Existing IndexTTS users upgrade and launch the app without being prompted to reinstall the engine; their cached weights under `$HF_HOME` are reused (no re-download)
  4. The frontend Engine Compatibility Matrix shows each engine's install state, GPU compatibility (CUDA/MPS/ROCm/CPU), isolation mode (in-process vs subprocess), and last error if any
  5. One engine in a broken state cannot prevent app boot — engine registry surfaces per-engine status and the app remains usable on remaining engines
**Plans:** TBD
**UI hint:** yes

### Phase 3: Supertonic-3 Engine + Installer Mirror Reliability
**Goal:** Users can opt into Supertonic-3 as a 7th TTS engine with honest hardware-capability reporting and pinned model revisions, and `bootstrap.rs` survives restricted-network conditions (Russia/CIS) via an allow-listed mirror cascade with hash-pinned `uv.lock`.
**Mode:** mvp
**Depends on:** Phase 2 (Supertonic-3 plugs into the `SubprocessBackend` primitive built in Phase 2 — do not parallelize)
**Research recommended:** open questions on `supertonic` 1.2.3 onnxruntime variant, opportunistic `transformers` import, mirror liveness (gh-proxy / ghfast / gitmirror, Yandex/Tsinghua/Aliyun), model-card recency, and Supertonic-3 MPS path (SUMMARY.md Open Questions table — Phase 3 rows).
**Closes issues:** #57, #60 (mirror fallback); ships Supertonic-3 addition
**Requirements:** TTS-01, TTS-02, TTS-03, TTS-04, TTS-05, TTS-06, INST-07, INST-08, INST-09, INST-10, INST-11
**Success Criteria** (what must be TRUE):
  1. User installs the `supertonic` optional dependency, selects the engine, and generates 3 seconds of audio in 3 languages with no onnxruntime double-install warning
  2. Supertonic-3 engine card surfaces the MIT / OpenRAIL-M license with link, gates first use on acceptance, and honestly reports CPU-only when CUDA is absent
  3. Supertonic-3 model revision is pinned by commit SHA in code (not just tag); pin survives a model-card update without behavior change
  4. On a network where the default `uv venv` Python download fails, `bootstrap.rs` cascades through allow-listed mirrors (external JSON list) and falls back to `UV_PYTHON_PREFERENCE=only-system` with a Python ≥3.11 check — install succeeds (closes #57, #60)
  5. `uv sync --frozen` is enforced and `uv.lock` is hash-pinned; `UV_HTTP_TIMEOUT=120` and `UV_HTTP_RETRIES=5` are set in the bootstrap environment
**Plans:** TBD
**UI hint:** no

### Phase 4: Adaptive & Specialty Engines (spike-first)
**Goal:** Investigate, and if validated, integrate two model additions that extend OmniVoice's capability surface — hardware-adaptive default cloning (via `Serveurperso/OmniVoice-GGUF`) and sung-vocal cloning in the dubbing pipeline (via `ModelsLab/omnivoice-singing`). Both are spike-first because both URLs need verification (the name "OmniVoice" is overloaded in the wild) and both add new runtime requirements (GGUF needs a llama.cpp-family runtime; singing's runtime is unconfirmed).
**Mode:** mvp
**Depends on:** Phase 2 (SubprocessBackend primitive — GGUF and Singing engines both build on it). Phase 3 ships in parallel; Phase 4 can open PRs once Phase 2's primitive is merged, but full Phase 4 integration code must not regress Phase 3's mirror reliability work.
**Research recommended:** YES — strongly. Both spikes require web-fetch of model cards, license review, runtime confirmation, and (for GGUF) quant-VRAM enumeration. Should run with full research dimension before any code work.
**Closes issues:** none directly (these are additions, not inbox items)
**Spike gates:** SPIKE-01 and SPIKE-02 each return GO or NO-GO with documented rationale in `.planning/decisions/{gguf,singing}-spike.md`. NO-GO outcomes move the corresponding integration requirements (GGUF-* / SING-*) to Out of Scope in REQUIREMENTS.md with the decision-doc link.
**Requirements:** SPIKE-01, SPIKE-02, GGUF-01, GGUF-02, GGUF-03, GGUF-04, GGUF-05, GGUF-06, SING-01, SING-02, SING-03, SING-04, SING-05
**Success Criteria** (what must be TRUE):
  1. SPIKE-01 returns GO or NO-GO with documented rationale in `.planning/decisions/gguf-spike.md` (model lineage confirmed or refuted, license, runtime, quant variants with VRAM footprints)
  2. SPIKE-02 returns GO or NO-GO with documented rationale in `.planning/decisions/singing-spike.md` (model identity confirmed or refuted, license, runtime, input/output formats, scope: sung-vocal cloning vs full-song generation)
  3. If SPIKE-01 = GO: the GGUF engine is the working default on hardware that passes the probe, with overridable fallback to the prior default — verified end-to-end on 3 hardware classes (CPU-only Linux, 8 GB VRAM macOS/Windows, 16+ GB VRAM Windows)
  4. If SPIKE-02 = GO: the dubbing pipeline can sing-route a 30-second mixed speech+singing clip end-to-end (Demucs vocal stem through the singing engine, instrumental preserved in the final mix, consistent voice identity across spoken and sung segments)
  5. Any NO-GO outcome moves the corresponding integration requirements to Out of Scope in REQUIREMENTS.md with the decision-doc link, and the phase still closes cleanly (spike-only deliverable is sufficient for that half of the phase)
**Plans:** TBD
**UI hint:** yes

### Phase 5: Opt-in Bug Reporting
**Goal:** A user who opts in via Settings → Privacy can submit a structured GitHub issue from inside the app — with full payload preview, default-deny field allow-list, HF-token/PII scrubbing, and rate / dedup / recursion safeguards — without violating the local-first promise.
**Mode:** mvp
**Depends on:** Phase 4
**Research recommended:** open questions on GitHub Issues URL encoded-length cap, Tauri 2 `shell.open` permission scope post-Sequoia, and `tauri-plugin-single-instance` + counter file racing (SUMMARY.md Open Questions table — Phase 4 rows, now Phase 5 in this roadmap).
**Closes issues:** none from inbox (this is the second explicit addition beyond the inbox)
**Requirements:** REPORT-01, REPORT-02, REPORT-03, REPORT-04, REPORT-05, REPORT-06, REPORT-07, REPORT-08, REPORT-09, REPORT-10, REPORT-11, REPORT-12
**Success Criteria** (what must be TRUE):
  1. Bug reporting is OFF by default; user must opt in via Settings → Privacy with explicit copy explaining what is and isn't sent
  2. Before any browser window opens, the user sees a formatted preview of the exact payload that will be submitted — and clicks "Open in GitHub" to proceed (two-step consent)
  3. Captured payload uses a default-deny allow-list (OS, app version, GPU info, engine list, redacted error summary only); HF tokens, file paths under `$HOME`, and email-like patterns are scrubbed before preview
  4. The reporter aggregates Python / Rust / React errors; per-day rate cap (3 / 24h), SHA-1 content dedup, recursion guard, and pre-submit GitHub-search-for-similar-issues all behave as specified in tests
  5. All auto-submitted reports carry an `auto-report` GitHub label and submit via prefilled URL with no PAT, no third-party telemetry endpoint, and payload trimmed under ~6 KB encoded with a "see attached log" link when too long
**Plans:** TBD
**UI hint:** yes

### Phase 6: Release, Verification, Retro
**Goal:** v0.3.0 ships from a verified rc1 after clean-VM exercise on the four target OSes, every closed issue has a verification line in the release notes, and a published retrospective measures weighted closure / net inbox / Discord-volume delta.
**Mode:** mvp
**Depends on:** Phase 5
**Closes issues:** the residual closure-and-verify pass — confirms all 11 originally-open issues land in the right end state (Closed via fix, Closed via documented workaround + UI, or moved to v0.4 tracking milestone with explicit user-facing communication)
**Requirements:** REL-01, REL-02, REL-03, REL-04, REL-05, REL-06
**Success Criteria** (what must be TRUE):
  1. `v0.3.0-rc1` is cut and a maintainer follows the install docs verbatim on UTM macOS Sequoia, Hyper-V Windows 11, Ubuntu 24.04, and Fedora 44 with no shortcuts — all four reach a working app
  2. 48-hour soak between rc1 and `v0.3.0` promotion completes with no regression report
  3. Release notes carry one verification line per closed issue pointing to the commit / PR (or docs change for documented-workaround closures); SHA-256 checksums are published per artifact
  4. Retrospective is published with three metrics: weighted closure count, net inbox change (closed minus opened during milestone), Discord support-volume delta on install / HF token / dubbing
  5. Tracking issues are filed for explicit deferrals (macOS code signing + notarization, Tauri/WebKit Fedora upstream fix, per-engine subprocess hardening beyond IndexTTS); all 11 originally-open issues are in a confirmed end state
**Plans:** TBD
**UI hint:** no

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Gates | 0/0 | Not started | - |
| 1. Install + Token + Docs + Error UX | 0/0 | Not started | - |
| 2. Engine Isolation | 0/0 | Not started | - |
| 3. Supertonic-3 + Mirror Reliability | 0/0 | Not started | - |
| 4. Adaptive & Specialty Engines (spike-first) | 0/0 | Not started | - |
| 5. Opt-in Bug Reporting | 0/0 | Not started | - |
| 6. Release, Verification, Retro | 0/0 | Not started | - |

---

## Coverage Summary

**v1 requirements mapped:** 62 / 62 ✓
**Orphaned requirements:** 0 ✓
**Duplicates:** 0 ✓

| Phase | Requirement Count | Requirement IDs |
|-------|-------------------|-----------------|
| Phase 0 | 6 | GATE-01 — GATE-06 |
| Phase 1 | 16 | INST-01 — INST-06, DOCS-01 — DOCS-05, AUTH-01 — AUTH-05 |
| Phase 2 | 8 | ENGINE-01 — ENGINE-07, BUG-01 |
| Phase 3 | 11 | TTS-01 — TTS-06, INST-07 — INST-11 |
| Phase 4 | 13 | SPIKE-01 — SPIKE-02, GGUF-01 — GGUF-06, SING-01 — SING-05 |
| Phase 5 | 12 | REPORT-01 — REPORT-12 |
| Phase 6 | 6 | REL-01 — REL-06 |
| **Total** | **62** | — |

---

## Dependency Graph

```
Phase 0 (gates — hard pre-condition)
   │
   ▼
Phase 1 (install + token + docs + error UX)
   │
   ▼
Phase 2 (engine isolation — IndexTTS on SubprocessBackend + WAV-export fix)
   │
   ├──────────────────────────────┐
   ▼                              ▼
Phase 3 (Supertonic-3 +       Phase 4 (Adaptive & Specialty Engines — spike-first)
   mirror reliability)          GGUF + Singing both build on the SubprocessBackend
                                primitive from Phase 2; integration is conditional
                                on SPIKE-01 / SPIKE-02 returning GO
   │                              │
   └──────────────┬───────────────┘
                  ▼
            Phase 5 (opt-in bug reporting)
                  │
                  ▼
            Phase 6 (release, verify, retro)
```

Phase 0 is a hard gate: must merge and prove green before any other phase opens PRs. Phase 2 must precede both Phase 3 and Phase 4 (both reuse the `SubprocessBackend` primitive built in Phase 2 — do not parallelize across that boundary). Phases 3 and 4 can run in parallel once Phase 2 lands; both must complete before Phase 5 opens.

---

*Roadmap defined: 2026-05-16*
*Last updated: 2026-05-16 after inserting Phase 4 (Adaptive & Specialty Engines) and renumbering subsequent phases*
