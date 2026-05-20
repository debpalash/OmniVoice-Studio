# Phase 6: Release, Verification, Retro - Research

**Researched:** 2026-05-18
**Domain:** Release engineering, multi-OS verification, milestone retrospective
**Confidence:** HIGH (release.yml is empirical; the unknowns are notarization cost authorization and PR #73 rebase outcome)

---

## Summary

Phase 6 owns the actual v0.3.0 release: cutting `v0.3.0-rc1`, exercising it on four clean VMs, soaking for 48 hours, promoting to `v0.3.0`, and publishing a retrospective. It is the **closure-and-verify** phase — every prior phase's work converges here.

The release pipeline (`release.yml`) was hardened in PR #84 (typecheck single-sourcing, default-loopback bind, system-router loopback middleware) and Phase 0 already established cross-platform installer smoke (`Installer smoke (macOS|Windows|Linux)` jobs against the bundled DMG / MSI / AppImage). The remaining release-engineering gaps from the Release Engineer's Phase 0 retro recommendations are:

- **B. Workflow-parity CI lint** — a grep-based job that flags `tsc --noEmit` / typecheck-flag drift between `ci.yml` and `release.yml`. Pending.
- **C. Tag-shaped dry-run trigger** — `workflow_dispatch` on `release.yml` for PRs touching `.github/workflows/**` or `frontend/src-tauri/**`, so we catch tag-time-only regressions on PR. Pending.

Three macro-questions dominate the phase:

1. **macOS notarization** — REL-05 explicitly defers real signing/notarization to a tracking issue. **The recommendation is to honor that deferral**: keep `xattr -cr` documented (Phase 1 INST-03), and only authorize the $99 Apple Developer enrollment if the user signals willingness during the rc soak. Otherwise the workaround already exists and signing is a v0.4 infrastructure milestone.

2. **PR #73 backend-split installer** — 93 commits behind main; the rebase touches `lib.rs` (pill-mode widget creation merged after this branch was cut) and `tauri.conf.json` (widget window config + bundle resources both touched). Auto-merges cleanly: `release.yml`, `Cargo.toml`. **The recommendation is reimplementation over rebase**: the conflict surface is small (~180 line PR, 4 files) and reimplementing on top of current main keeps the resolved diff reviewable. Reimplementation also lets us align the download-on-first-launch logic with the bootstrap-mirror cascade landing in Phase 3 (INST-07..11).

3. **Single-tag release vs. v0.3.x train** — CLAUDE.md is explicit: **one tag (`v0.3.0`), one Release, no incremental `v0.3.x` between v0.2.7 and v0.3.0**. The phase ships once when all 7 phases are done.

**Primary recommendation:** Treat Phase 6 as a fixed-form release runbook — one PLAN.md with two waves (rc1 cut + clean-VM exercise; soak + promote + retro) — keep notarization deferred behind a user-authorization gate, reimplement PR #73 rather than rebase, and produce the retro from real Discord/issue-tracker data, not vibes.

---

## User Constraints (from CLAUDE.md + ROADMAP.md Key Decision #7)

### Locked Decisions

- **One tag, one release.** Tag `v0.3.0` once when the milestone is complete and publish the GitHub Release with full notes. No incremental `v0.3.x` tags between `v0.2.7` and `v0.3.0`.
- **Documented-workaround closures count as closed.** `xattr -cr` (#54) and `WEBKIT_DISABLE_COMPOSITING_MODE=1` (#56) close their issues if documented in `docs/install/{macos,linux}.md` AND surfaced in the app's error UI (Phase 1 INST-03 / INST-04). Real fixes (Apple Dev cert, Tauri/WebKit upstream patch) are v0.4 infrastructure milestones.
- **Local-first preserved.** Release pipeline does not introduce any new cloud-required step. Notarization, if added, runs as a CI secret-gated job and produces a stapled DMG — it does not change any user-runtime cloud dependency.
- **`v0.3.0-rc1` must be exercised on clean VMs.** UTM macOS Sequoia, Hyper-V Windows 11, Ubuntu 24.04, Fedora 44 — all four follow `docs/install/*.md` verbatim, no shortcuts (REL-01).
- **48-hour soak between rc1 and `v0.3.0`** (REL-02). No regression report during the window or rc1 promotes; if a regression lands, cut `rc2`, restart the 48h clock.
- **Every closed issue gets a verification line in the release notes** pointing to commit/PR/docs-change (REL-03).
- **Retrospective publishes three metrics**: weighted closure count, net inbox change, Discord support-volume delta on top 3 topics (install / HF token / dubbing) (REL-04).

### Claude's Discretion

- Whether to reimplement PR #73 vs. rebase (recommendation: reimplement — see Section "PR #73 strategy").
- Release notes structure and section order (recommendation in this doc — see Section "Release notes generation").
- Retro doc location and structure (recommendation: `.planning/retros/v0.3.0-retro.md`).
- Whether to add tag-shaped dry-run (Release Engineer option C) in Phase 6 or defer to v0.4.

### Deferred Ideas (OUT OF SCOPE — explicit v0.4)

- **macOS code signing + notarization (real cert).** v2 requirement SIGN-V2-01. Tracking issue filed per REL-05.
- **Windows code signing certificate.** v2 requirement SIGN-V2-02. Tracking issue filed per REL-05.
- **Auto-update with user-consent prompt + signed payload verification.** v2 requirement DIST-V2-01.
- **Tauri/WebKit Fedora upstream fix.** Tracking issue filed per REL-05.
- **Per-engine subprocess hardening beyond IndexTTS.** Tracking issue filed per REL-05 (v2 ENGINE-V2-01).

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REL-01 | `v0.3.0-rc1` cut + clean-VM exercise on UTM macOS Sequoia, Hyper-V Windows 11, Ubuntu 24.04, Fedora 44, no shortcuts | "Cross-platform clean-VM smoke" section — manual checklist + automated GH-runner overlap |
| REL-02 | 48-hour soak between rc1 and `v0.3.0` promotion, no regression report | "Release flow" section — soak window mechanics |
| REL-03 | Every closed issue has a verification line in release notes pointing to commit/PR/docs change | "Release notes generation" section — table-format verification grid |
| REL-04 | Retrospective with weighted-closure count, net-inbox-change, Discord support-volume delta on install/HF-token/dubbing | "Retrospective" section — three-metric structure with data sources |
| REL-05 | Tracking issues filed for explicit deferrals: macOS signing + notarization, Tauri/WebKit Fedora upstream fix, per-engine subprocess hardening beyond IndexTTS | "Deferral tracking issues" section — 3-issue template list |
| REL-06 | All 11 originally-open issues in a confirmed end state (Closed via fix, Closed via documented-workaround + UI, or moved to v0.4 with explicit user-facing communication) | "Closure verification matrix" section — per-issue end-state recap |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Tag-push trigger + matrix build | CI (release.yml) | — | Already implemented; just gets a new tag input |
| Per-platform installer smoke | CI (release.yml jobs) | Manual VM exercise | CI catches build regressions; clean-VM catches install-docs drift |
| SHA-256 checksum publish | CI (release.yml — softprops/action-gh-release) | — | Already implemented Phase 0 GATE-05 |
| Updater manifest (latest.json) | CI (release.yml — tauri-action signs with TAURI_SIGNING_PRIVATE_KEY) | — | Already implemented; no Phase 6 changes |
| macOS notarization (DEFERRED) | CI (xcrun notarytool + stapler) | — | Not Phase 6 scope; tracking issue filed |
| Release notes assembly | Human (writes CHANGELOG.md section) | CI (release.yml extracts via `awk` and stuffs into release body) | CHANGELOG is the human-curated source of truth; release.yml already extracts the right section per tag |
| Version bump (0.2.7 → 0.3.0) | Human edit (4 files: pyproject.toml, frontend/package.json, frontend/src-tauri/Cargo.toml, frontend/src-tauri/tauri.conf.json) | + README badge URLs | Single PR; deliberate edit; checked into main before tagging |
| 48h soak gate | Human (calendar) | Discord/issue-tracker monitoring | No automation — the soak is a literal wait |
| Retrospective authoring | Human | CI (provides issue-closure data via `gh issue list --milestone`) | Inherently human work |
| Closure verification grid | Human (cross-reference each of 11 issues against its closing PR / docs page) | `gh issue view <n>` for state confirmation | One-time per release |

---

## Standard Stack

### Already in Repo (Phase 6 uses, does not add)

| Tool | Version | Purpose | Why Used |
|------|---------|---------|----------|
| `tauri-apps/tauri-action@v0` | `@v0` (current) | Builds + signs + uploads per-OS bundles | Already wired; release.yml line 340 |
| `softprops/action-gh-release@v2` | `@v2` (current) | Append checksums + attach SHA256SUMS-*.txt | Already wired; release.yml line 499 |
| `gh` CLI | already on GH runners + dev machines | Issue queries, release management, PR comments | Standard |
| `awk` / `sed` | POSIX, on every runner | CHANGELOG section extraction (release.yml:322) | Already wired |
| `tauri-plugin-updater` | Tauri 2.x | latest.json + signature verification | Already wired |

### New for Phase 6 (small additions)

| Tool | Version | Purpose | Why Needed |
|------|---------|---------|------------|
| `actionlint` (GitHub Action `rhysd/actionlint`) | latest pinned SHA | Workflow-parity lint (Release Engineer option B) — fails CI on `tsc --noEmit` flag drift between ci.yml and release.yml | Closes the Phase 0 retro gap that PR #84 fixed once but doesn't structurally prevent recurring |
| GitHub Milestone `v0.3.0` | n/a — gh-CLI created | Groups all v0.3.0 issues for `--milestone v0.3.0` queries during retro | Required for the "weighted closure count" metric (REL-04) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| CHANGELOG.md + `awk` extraction (current) | `release-please` (Google) auto-generated changelog from conventional-commits | Project doesn't enforce conventional commits; would need a 3-month commit-message-style migration. Defer. |
| Manual VM exercise on 4 OSes | Selenium/Playwright + cloud VM (BrowserStack, Sauce Labs) | $200-500/mo for occasional release runs; UTM/Hyper-V free + the rc soak is rare enough that human-time is cheaper than seat licenses. Defer. |
| `gh release create` with manual notes | `git-cliff` (Rust-based changelog generator) | Same conventional-commits dependency as release-please. Defer until commit-style migration. |
| `actionlint` for workflow-parity | Custom bash grep job in `ci.yml` | actionlint catches a broader class of YAML issues for free; one less custom script to maintain. **Pick actionlint.** |

**Installation (Phase 6 PLAN.md adds these to existing workflows):**
```yaml
# In ci.yml — new job
workflow-parity:
  name: Workflow parity (typecheck flag drift)
  runs-on: ubuntu-22.04
  steps:
    - uses: actions/checkout@v4
    - uses: rhysd/actionlint@v1.7.1   # pin to a SHA in actual PLAN.md
    - name: Grep both workflows for tsc --noEmit drift
      run: |
        # If either ci.yml or release.yml references `tsc --noEmit` without
        # going through `typecheck:ci`, fail.
        if grep -E "tsc --noEmit" .github/workflows/{ci,release}.yml | grep -v "typecheck:ci"; then
          echo "::error::tsc --noEmit invoked directly — use the typecheck:ci script for single-sourced flags"
          exit 1
        fi
```

**Version verification** (run before authoring PLAN.md tasks):
```bash
# rhysd/actionlint is the canonical lint; check latest at action time
gh release view --repo rhysd/actionlint --json tagName --jq .tagName
```

---

## Package Legitimacy Audit

> Phase 6 adds zero new runtime packages. The only additions are CI-side GitHub Actions, pinned by SHA.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `rhysd/actionlint` (GH Action) | GitHub Marketplace | ~6 yrs | 13M+ workflow runs/mo per marketplace stats | github.com/rhysd/actionlint | [ASSUMED OK — well-known maintainer] | Approved (pin to SHA in PLAN) |
| `tauri-apps/tauri-action@v0` (existing) | GitHub Marketplace | ~4 yrs | Standard for Tauri | github.com/tauri-apps/tauri-action | [ASSUMED OK — official Tauri org] | Already in use |
| `softprops/action-gh-release@v2` (existing) | GitHub Marketplace | ~5 yrs | 50M+ runs/mo | github.com/softprops/action-gh-release | [ASSUMED OK — battle-tested] | Already in use |

*slopcheck was not run as part of this research (no PyPI/npm installs in Phase 6 scope). Pin every new Action to a commit SHA, not a floating tag, when writing PLAN.md — per Phase 0 Pitfall #4 ("`awalsh128/cache-apt-pkgs-action@latest` floats the action SHA").*

---

## Architecture Patterns

### System Architecture Diagram

```
                       ┌───────────────────────────────────────────────────┐
                       │   Phase 6 Release Flow (calendar-aware)           │
                       │                                                   │
   Phase 5 lands       │   T-0       Cut v0.3.0-rc1                       │
   (REPORT-* green)    │   │         ├──► Tag push hits release.yml       │
        │              │   │         ├──► Build 3-OS matrix + smoke       │
        ▼              │   │         └──► GH Draft Release with rc1       │
   Version bump PR ───►│   │                                               │
   (0.2.7 → 0.3.0      │   │                                               │
    in 4 files)        │   T+0   Clean-VM exercise (4 OSes, parallel)     │
        │              │   ▼      ├── UTM macOS Sequoia ─┐                │
        ▼              │   │      ├── Hyper-V Windows 11  │                │
   PR #73 reimplemented│   │      ├── Ubuntu 24.04 VM     ├── all pass?   │
   on top of main      │   │      └── Fedora 44 VM       ─┘   (yes/no)    │
        │              │   │                                               │
        ▼              │   │       ┌─── NO ──► Fix → cut rc2 → restart    │
   Phases 0-5 merged   │   │       │                                       │
   to main; CI green   │   │       └─── YES                                │
        │              │   │              │                                │
        └──────────────│───┘              ▼                                │
                       │   T+1d   48h soak start                          │
                       │   │      ├── Discord monitoring                  │
                       │   │      ├── GH Issues monitoring                │
                       │   │      └── Auto-bug-report inbox check        │
                       │   │                                               │
                       │   T+3d   Soak ends                               │
                       │   │      └── regression reported? cut rc2       │
                       │   │            no? promote rc1 → v0.3.0          │
                       │   │                                               │
                       │   T+3d   Promote: push `v0.3.0` tag              │
                       │   │      ├── release.yml runs (publishes)        │
                       │   │      ├── Release body finalized              │
                       │   │      └── SHA256 checksums attached           │
                       │   │                                               │
                       │   T+4d   Author retrospective                    │
                       │   │      ├── Pull issue-closure data via `gh`    │
                       │   │      ├── Pull Discord delta (manual)         │
                       │   │      └── Publish .planning/retros/v0.3.0-retro.md │
                       │   │                                               │
                       │   T+4d   File 3 deferral tracking issues         │
                       │   │      ├── macOS sign + notarize (SIGN-V2-01)  │
                       │   │      ├── WebKit Fedora upstream              │
                       │   │      └── Engine subprocess hardening v2      │
                       └───────────────────────────────────────────────────┘
```

### Recommended Project Structure (Phase 6 additions only)

```
.github/workflows/
├── ci.yml                          # existing — add `workflow-parity` job
└── release.yml                     # existing — no changes (Phase 6 just consumes it)

.planning/
├── retros/                         # NEW directory
│   └── v0.3.0-retro.md             # NEW — the retrospective doc (REL-04)
├── release/                        # NEW directory (optional, see Section "Release runbook")
│   ├── v0.3.0-runbook.md           # NEW — per-release checklist (REL-01..03)
│   └── verification-matrix.md      # NEW — closure verification (REL-06)
└── decisions/
    └── pr-73-strategy.md           # NEW — reimplement vs rebase rationale

docs/releases/
└── two-rc-cadence.md               # ALREADY exists from Phase 0 (RESEARCH:718)

CHANGELOG.md                        # existing — add `## [0.3.0] — YYYY-MM-DD` section
                                    # (release.yml extracts this section into release body)
```

### Pattern 1: Reproducible version bump (single PR)

**What:** Update version from `0.2.7` to `0.3.0` in exactly 4 sources of truth, plus the README badge URLs.

**When to use:** Once, just before cutting `v0.3.0-rc1`.

**Example:**
```bash
# 4 version sources (verified by grep above)
#   pyproject.toml:7                 version = "0.2.7"
#   frontend/package.json:4          "version": "0.2.7"
#   frontend/src-tauri/Cargo.toml:3  version = "0.2.7"
#   frontend/src-tauri/tauri.conf.json:4  "version": "0.2.7"
# Plus README.md download badges at lines 25-28 (4 URLs)

# One-shot bump:
NEW=0.3.0
sed -i.bak 's/version = "0.2.7"/version = "0.3.0"/' pyproject.toml
sed -i.bak 's/"version": "0.2.7"/"version": "0.3.0"/' frontend/package.json
sed -i.bak 's/version = "0.2.7"/version = "0.3.0"/' frontend/src-tauri/Cargo.toml
sed -i.bak 's/"version": "0.2.7"/"version": "0.3.0"/' frontend/src-tauri/tauri.conf.json
sed -i.bak 's/v0.2.7\/OmniVoice.Studio_0.2.7/v0.3.0\/OmniVoice.Studio_0.3.0/g' README.md
find . -name "*.bak" -delete

# Also: bump frontend/src-tauri/Cargo.lock by running `cargo update -p omnivoice-studio-tauri`
```

Source: grep results above (pyproject.toml:7, frontend/package.json:4, Cargo.toml:3, tauri.conf.json:4, README.md:25-28).

### Pattern 2: Tag-push release flow (existing — Phase 6 just runs it)

**What:** Pushing `v0.3.0` tag triggers release.yml's full 3-OS matrix bundle + sign + publish.

**When to use:** After 48h soak passes and rc1 is promoted.

**Example:**
```bash
# Final sanity check
gh workflow list
gh run list --workflow=ci.yml --limit 3   # confirm main is green

# Tag + push
git tag -a v0.3.0 -m "v0.3.0: Stabilization milestone"
git push origin v0.3.0

# release.yml fires automatically on push of v* tag.
# Watch:
gh run watch
```

The release.yml workflow (already implemented Phase 0):
1. Runs `test` job (backend pytest + frontend typecheck + node:test) on Linux
2. On test pass, spawns 3-OS matrix (macos-14, windows-2022, ubuntu-22.04)
3. Each matrix leg: bundles `uv` + ffmpeg/ffprobe sidecars, builds Tauri bundle, smoke-tests the bundled backend with `--health-check`, computes SHA-256, appends to release body
4. Publishes draft release with `inputs.draft || 'true'` default — must be manually promoted to public via `gh release edit v0.3.0 --draft=false`

### Pattern 3: Manual 4-OS clean-VM exercise checklist

**What:** A documented runbook a maintainer (one person) follows verbatim, one OS at a time, on freshly-imaged VMs.

**When to use:** Once per rc cut. Pause everything else.

**Recommended runbook layout** (`.planning/release/v0.3.0-runbook.md`):

```markdown
# v0.3.0-rc1 Clean-VM Exercise Runbook

## Pre-flight
- [ ] rc1 tagged, release.yml green on all 3 matrix legs
- [ ] Draft release exists with DMG, MSI, AppImage, deb attached
- [ ] SHA256SUMS-*.txt published per matrix leg
- [ ] All 4 VMs reset to clean snapshot (no prior OmniVoice install)

## OS 1: UTM macOS Sequoia (15.x)
- [ ] Download DMG from rc1 draft release
- [ ] Verify SHA-256 against published SHA256SUMS-macOS Apple Silicon.txt
- [ ] Open docs/install/macos.md side-by-side
- [ ] Follow EVERY step verbatim — no shortcuts
- [ ] Hit the `xattr -cr` workaround (closes #54): IS the in-app error
      surface link working from Phase 1 INST-03?
- [ ] Reach a working voice-clone output (sample input → audio file)
- [ ] HF token: enter via Settings → API Keys (Phase 1 AUTH-03 flow)
- [ ] Verify token persists after app restart
- [ ] Sign-off: docs verbatim followed, output produced → ✓

## OS 2: Hyper-V Windows 11
- [ ] Download MSI from rc1 draft release
- [ ] Verify SHA-256
- [ ] Follow docs/install/windows.md verbatim
- [ ] Hit the Triton/torch.compile workaround (closes #65)
- [ ] Reach working clone output
- [ ] HF token via PowerShell flow (docs/setup/huggingface-token.md)
- [ ] Sign-off: ✓

## OS 3: Ubuntu 24.04 (Hyper-V or UTM)
- [ ] Download .deb + AppImage
- [ ] Verify SHA-256 for both
- [ ] Test .deb install path: `sudo dpkg -i ...` (closes #76 ffprobe path)
- [ ] Test AppImage path separately on a second VM revert
- [ ] Follow docs/install/linux.md verbatim
- [ ] Reach working clone output
- [ ] Sign-off: ✓

## OS 4: Fedora 44 (UTM)
- [ ] Download AppImage
- [ ] Verify SHA-256
- [ ] Hit WEBKIT_DISABLE_COMPOSITING_MODE=1 workaround (closes #56)
- [ ] Confirm the launcher's conditional kicks in (Phase 1 INST-04)
- [ ] Reach working clone output
- [ ] Sign-off: ✓

## Outcomes
- All four signed off → rc1 promotes to v0.3.0 after 48h soak
- Any one fails → cut rc2, fix, re-exercise that OS only, restart 48h
```

The runbook is intentionally not automated — REL-01 says "no shortcuts." The point is a human reads the docs while a human installs.

### Pattern 4: Release notes from CHANGELOG section (existing — Phase 6 fills it)

**What:** release.yml line 322 already extracts the `## [X.Y.Z]` section from CHANGELOG.md and uses it as the release body. Phase 6's job is to fill `## [0.3.0]` before tagging.

**When to use:** Before pushing `v0.3.0` tag — landed via a PR titled `chore(release): v0.3.0 changelog + version bump`.

**Section structure (recommended):**

```markdown
## [0.3.0] — 2026-MM-DD

> v0.3.0 Stabilization. Empty-the-inbox milestone: closes all 11 originally-open issues
> (8 via fix, 3 via documented workaround + UI surfacing) plus two surgical additions
> (Supertonic-3 engine, opt-in GitHub-Issues bug reporting) plus two spike outcomes
> (GGUF + Singing variant — see retro for GO/NO-GO).

### Added
- **Supertonic-3 TTS engine** (Phase 3 — TTS-01..06). 31 languages, ~99M params,
  ONNX runtime. Opt-in via `[supertonic]` optional dep. License acceptance gate
  on first use.
- **Opt-in bug reporting via GitHub Issues prefilled URL** (Phase 5 — REPORT-01..12).
  Default-deny payload, two-step consent, no PAT, no third-party telemetry endpoint.
- **HF token persistence** with 3-source cascade — App / Env / HF CLI (Phase 1 — AUTH-01..06)
- **Per-OS install docs** at `docs/install/{macos,windows,linux,docker}.md`
- **Error UX deeplinks** — error UI surfaces "Open docs for this error" buttons
- **Engine Compatibility Matrix UI** with per-engine isolation mode + last error
- *[GGUF / Singing entries — IF SPIKE-01 / SPIKE-02 returned GO]*

### Fixed
- **IndexTTS module clash** (#42) — real fix via SubprocessBackend isolation, not graceful-degrade
- **WAV export corruption** in video-dubbing pipeline (#48)
- **`setuptools` missing on Python 3.12+** breaking WhisperX (#58)
- **`uv venv` failure on restricted networks** (#57, #60) — mirror cascade + only-system fallback
- **`pkg_resources` import error** on dictation flow (#58)
- **Default backend bind to 127.0.0.1** (PR #84, security)
- **Loopback middleware on all `/system/*` routes** (PR #84, security)
- **Docker LAN access** (#80) via centralized `apiBase.ts`

### Documented Workaround (closed via docs + error UI)
- **macOS Sequoia quarantined .app** (#54) — `xattr -cr` documented + surfaced in
  first-launch-failure UI. Real fix (signing cert + notarization) tracked at #XXX.
- **AppImage white-screen on Fedora 44** (#56) — `WEBKIT_DISABLE_COMPOSITING_MODE=1`
  documented + applied conditionally by AppImage launcher. Tauri/WebKit upstream
  tracked at #YYY.
- **Windows Triton/torch.compile OOM** (#65) — workaround documented + Settings →
  Performance toggle.

### Deferred to v0.4 (tracking issues filed)
- Real macOS code signing + notarization (#ZZZ)
- Windows code signing certificate (#AAA)
- Per-engine subprocess hardening beyond IndexTTS (#BBB)
- WebKit Fedora upstream fix (#CCC)
- Per-segment audio effects DSP preset selector (#67 / PR #68) — community PR closed
  with thanks; defer to v0.4
- Custom model download directory (#64)
- Full zh-CN localization (PR #66)

### Closed without code change
- *[#63 — empty bug-report template, no repro, auto-closed]*

### Verification grid

| Issue | Closed by | Verified by | End state |
|-------|-----------|-------------|-----------|
| #35   | PR #XXX (Phase 1 AUTH-01..06) | Settings → API Keys, restart → token persists | Fixed |
| #42   | PR #XXX (Phase 2 ENGINE-03) | tests/regression/test_indextts_clash.py | Fixed |
| #48   | PR #XXX (Phase 2 BUG-01) | tests/regression/test_wav_export.py | Fixed |
| #54   | docs/install/macos.md + INST-03 UI | Manual clean-VM exercise | Documented workaround |
| #55   | docs/engines/cosyvoice.md (Phase 1 DOCS-03) | Manual read-through | Documented |
| #56   | docs/install/linux.md + INST-04 launcher | Fedora 44 clean-VM exercise | Documented workaround |
| #57   | PR #XXX (Phase 3 INST-07..11) | Manual restricted-network exercise | Fixed |
| #58   | PR #62 (already merged) | Smoke test on Python 3.12 | Fixed |
| #60   | PR #XXX (Phase 3 INST-07..11) | Manual restricted-network exercise | Fixed |
| #65   | docs/install/windows.md + Settings toggle | Manual Win 11 exercise | Documented workaround |
| #76   | PR #XXX (Phase 1 INST-04 / .deb postinst) | Ubuntu 24.04 .deb install | Fixed |
| #80   | PR #84 + Phase 1 INST-04 apiBase.ts | Manual Docker LAN test | Fixed |
| #72   | Phase 1 INST-03 UI surfacing | macOS Sequoia exercise | Documented workaround (same as #54) |

(Filled in at release-notes-authoring time from `gh issue list --milestone v0.3.0 --state closed`)

### SHA-256 checksums
*(Auto-appended by release.yml — see Phase 0 GATE-05)*
```

The pattern is: human-authored sections (Added/Fixed/Documented Workaround/Deferred) above the auto-appended SHA256 footer that release.yml stuffs in.

### Anti-Patterns to Avoid

- **Bumping the version in only some of the 4 sources of truth.** Past releases (per CHANGELOG.md showing `## [0.2.7] — Unreleased` and `## [0.2.6] — Unreleased`) demonstrate the failure mode — tagging without bumping is what produced the `Unreleased` markers. Pattern 1 lists all 4 files explicitly; PLAN.md must add a verification step.
- **Tagging from a non-main branch.** `release.yml` builds whatever ref the tag points at. Tag `v0.3.0` on `main` only, never on a feature branch.
- **Forgetting `gh release edit v0.3.0 --draft=false`.** `release.yml` defaults `releaseDraft: ${{ inputs.draft || 'true' }}` — tag pushes still produce drafts. The promotion is a manual `gh release edit` after the soak.
- **Mixing pre-release (`prerelease: true`) for rc1.** release.yml sets `prerelease: false`. For rc1, manually edit the release to mark it pre-release after publication — OR (cleaner) tag `v0.3.0-rc1` and let release.yml run; the tag itself implies pre-release in human parlance but GH still flags it as a stable release. Pick one convention and document it in `docs/releases/two-rc-cadence.md` (which already exists from Phase 0).
- **Skipping the 48h soak because the rc looks clean.** REL-02 is a deliberate stability gate, not a vibes check.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Multi-OS bundle + sign + publish | Custom `gh release upload` script per platform | `tauri-apps/tauri-action@v0` (already in release.yml) | Handles updater manifest signing, bundles per platform, attaches to GH Release in one step |
| SHA-256 checksum aggregation | Custom checksum collector | `softprops/action-gh-release@v2` `append_body: true` (already in release.yml) | Each matrix leg appends; no race because `action-gh-release` serializes via the GH API |
| CHANGELOG extraction | Custom changelog parser | `awk`/`sed` against `## [X.Y.Z]` headers (already in release.yml:322) | Stable, no dependency |
| Workflow drift detection | Custom bash script | `actionlint` + targeted grep | Battle-tested; ~1MB binary; pinnable |
| Issue closure tracking | Manual spreadsheet | GitHub Milestone `v0.3.0` + `gh issue list --milestone v0.3.0 --state closed --json number,title,closedAt,closedByPullRequestsReferences` | Single source of truth; queryable |
| Cross-platform clean-VM smoke | Cloud testing service (BrowserStack etc.) | UTM + Hyper-V locally per the REL-01 runbook | Run rarely enough that human time wins on cost; cleaner-VM reproducibility |
| macOS notarization (DEFERRED) | Custom `xcrun notarytool` invocation | `tauri-apps/tauri-action`'s built-in notarize support + `APPLE_*` secrets | When v0.4 lands signing, tauri-action takes the secrets. Don't roll a custom notarize step. |
| Retro authoring | Auto-generated markdown from issue activity | Human writes the lessons-learned; `gh` provides the data | Retros are inherently reflective; auto-generated retros are noise |

**Key insight:** Phase 6 adds ~zero new build infrastructure. Everything to ship `v0.3.0` already exists in `release.yml` from Phase 0. The Phase 6 work is **operational** — author CHANGELOG, bump version, run the 4-VM checklist, soak, push tag, publish retro — not infrastructural.

---

## Runtime State Inventory

> Phase 6 doesn't rename or migrate runtime state, but the version bump touches state in ways that look like a rename.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| **Stored data** | `omnivoice_data/` (user voices, projects, settings DB) — must keep working without manual migration after v0.3.0 install. Per CLAUDE.md constraint "Backward-compatible project data." Phase 1 alembic migrations (AUTH-02) handle schema. | Verify on clean-VM exercise: install v0.2.7, populate sample data, upgrade-install v0.3.0, confirm data intact. ADD THIS TO THE RUNBOOK. |
| **Live service config** | `tauri-plugin-updater` `latest.json` on the GH Release — once `v0.3.0` ships, existing v0.2.7 installs poll for it. **`updater.endpoints` in tauri.conf.json must already point at the v0.3.0-capable URL** (already does per existing config; verify). | Verify `latest.json` is published to the correct URL on `v0.3.0` Release; existing v0.2.7 users will get an updater prompt. |
| **OS-registered state** | Tray icon process, `tauri-plugin-single-instance` lock file, global dictation hotkey registrations. Upgrades inherit these — no Phase 6 action unless we change identifiers (we don't — `com.debpalash.omnivoice-studio` is stable). | Verify on clean-VM exercise: upgrade-install preserves tray + hotkey. |
| **Secrets/env vars** | `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (already in GH org secrets for release.yml). No new secrets in Phase 6. | None. |
| **Build artifacts** | `frontend/src-tauri/target/debug/bundle/` contains debug artifacts referencing `0.2.7` (per grep earlier). These are dev artifacts, not shipped. | None — debug bundles regenerate on next build. |

**Nothing found in category — explicit check:**
- No new database tables (Phase 1's alembic migrations are already shipped via Phase 1, not Phase 6).
- No new env-var keys or secret names.
- No new identifier strings (`com.debpalash.omnivoice-studio` stable; tray plist stable; updater endpoint stable).

---

## Common Pitfalls

### Pitfall 1: Tag pushed before CHANGELOG.md `## [0.3.0]` section exists

**What goes wrong:** `release.yml:322` extracts the CHANGELOG section matching the tag. If the section is missing or still says `## [0.3.0] — Unreleased`, the fallback fires: `"Auto-generated release for v0.3.0. See CHANGELOG.md..."`. The Release publishes with a useless body.

**Why it happens:** CHANGELOG already shows `## [0.2.7] — Unreleased` and `## [0.2.6] — Unreleased` markers — the project's prior tags shipped without finalized notes. The `Unreleased` marker is a documented past failure mode in this repo.

**How to avoid:** PLAN.md adds a pre-tag verification step: `grep -E "^## \[0\.3\.0\] — 2[0-9]{3}-[0-9]{2}-[0-9]{2}" CHANGELOG.md` must exit 0 (date filled in, no `Unreleased` marker) BEFORE the tag push.

**Warning signs:** Release body contains "Auto-generated release for" boilerplate.

### Pitfall 2: Version bumped in 3 of 4 sources

**What goes wrong:** `frontend/src-tauri/Cargo.toml` updates `version` but `tauri.conf.json` still says `0.2.7`. Build succeeds (Cargo doesn't validate against Tauri config), but the installer name + Updater manifest reflect the wrong version. Users see `OmniVoice.Studio_0.2.7.dmg` from the `v0.3.0` tag.

**Why it happens:** Four files (`pyproject.toml`, `frontend/package.json`, `frontend/src-tauri/Cargo.toml`, `frontend/src-tauri/tauri.conf.json`) hold the version. No single source.

**How to avoid:** PLAN.md adds a verification task: `bash scripts/verify-version-bump.sh 0.3.0` greps all 4 + the README badge URLs. Script returns non-zero if any mismatch.

**Warning signs:** Installer filename in the release artifacts doesn't match the tag.

### Pitfall 3: PR #73 rebase silently breaks pill-mode widget

**What goes wrong:** PR #73 was opened before `b479f9b` (pill-mode widget) merged. Naive rebase resolves the `lib.rs` conflict by keeping #73's version, dropping the `WebviewWindowBuilder` widget creation. The widget tray menu item exists (Phase 0 backend shipped) but launches nothing.

**Why it happens:** Git's auto-resolution picks one side of a non-overlapping conflict, but the widget code is *inside* the function that PR #73 also modifies.

**How to avoid:** **Reimplement on top of current main rather than rebase.** Open a fresh PR titled `feat(release): backend-split installer (reimplemented over current main)` with the same 4-file scope as #73 but written against post-#84 main. PLAN.md task: re-derive #73's `ensure_backend_ready` + tar.gz upload step using current `lib.rs` and current `release.yml` as starting points.

**Warning signs:** `bun desktop-prod:pill` opens the main window instead of the pill widget after the merge.

### Pitfall 4: Notarization gets re-litigated during the rc soak

**What goes wrong:** A user reports the #54-style "OmniVoice Studio is damaged" toast during the rc soak. Pressure builds to add real signing/notarization in Phase 6. Apple Developer enrollment is a 24-48h process, the $99/yr requires user authorization, and the notarize step has its own iteration cycle. Phase 6 slips by a week.

**Why it happens:** The `xattr -cr` workaround feels lower-quality than a real signed app.

**How to avoid:** Hold the line. REL-05 deliberately defers signing to a tracking issue. The clean-VM exercise verifies the documented workaround surfaces correctly in the error UI (Phase 1 INST-03). If a user is willing to authorize $99/yr Apple Developer enrollment AND a 24-48h delay AND the additional notarize step in `release.yml`, that becomes v0.4 work, not Phase 6 work. **The discuss-phase output should explicitly ask the user whether to authorize Apple enrollment for Phase 6** — if yes, scope it in; if no (recommended default), defer.

**Warning signs:** rc1 soak day 2 sees "let me just add notarize while I'm here" PR drift.

### Pitfall 5: 48h soak window monitored only on weekdays

**What goes wrong:** rc1 cut on a Thursday. Soak runs Thu 14:00 → Sat 14:00. The maintainer's not online on weekend Discord. A regression report lands at Fri 22:00, unread until Mon 09:00. rc1 promotes to `v0.3.0` Sat 14:00 because no one saw the report.

**Why it happens:** "48 hours" is wall-clock, not business-hours.

**How to avoid:** PLAN.md adds: "Soak monitoring must be explicit — calendar block 2x/day Discord + GH Issues + auto-bug-report inbox check during the 48h window. If any check is missed, the soak window restarts." OR: pick rc1 cut times that put the soak in working hours (e.g., Mon morning cut → soak ends Wed morning).

**Warning signs:** First regression report comes in *after* `v0.3.0` is tagged.

### Pitfall 6: Discord support-volume delta has no baseline

**What goes wrong:** REL-04 requires "Discord support-volume delta on top 3 topics — install, HF token, dubbing." But no baseline exists pre-milestone, so the "delta" is undefined.

**Why it happens:** The roadmap assumed someone counted Discord messages in mid-May. Nobody did.

**How to avoid:** Phase 6's retro PLAN.md adds a task: "Establish baseline before promotion." Pull a representative week (e.g., last 7 days of `#help` channel before `v0.3.0` tag) and count messages by topic. Then compare to first 7 days post-`v0.3.0`. If even that's not feasible, document the metric as "qualitative, not quantitative — Discord support-volume delta direction (up/down) only" and accept that REL-04 reports a directional finding, not a precise number.

**Warning signs:** Retro doc says "Discord support-volume delta: TBD" — that means REL-04 isn't actually closed.

### Pitfall 7: Release.yml builds the wrong commit when rc tags get force-recreated

**What goes wrong:** Maintainer cuts `v0.3.0-rc1`, finds a typo in CHANGELOG, deletes the tag, fixes, recreates. release.yml ran twice; the GH Release ends up with mixed artifacts from both runs (or, worse, the second run fails because the release already exists).

**Why it happens:** Tags are mutable; release.yml uses `tagName: ${{ github.ref_name }}` and `softprops/action-gh-release` will append/overwrite depending on flags.

**How to avoid:** Treat every tag as immutable. If rc1 has a typo, cut rc2 (the two-RC cadence at `docs/releases/two-rc-cadence.md` already says this). If `v0.3.0` itself has a typo, fix forward — never rewrite a published tag.

**Warning signs:** `gh release view v0.3.0` shows duplicate artifacts or missing checksums.

---

## Code Examples

Verified patterns referenced from existing files in the repo:

### Tag-push trigger (`.github/workflows/release.yml:21-23`)

```yaml
# Source: .github/workflows/release.yml (already in repo)
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      draft:
        description: "Create as draft release (tag push only)"
        required: false
        default: "true"
```

Phase 6 doesn't change this. `v0.3.0` tag-push fires the existing pipeline.

### CHANGELOG section extraction (`.github/workflows/release.yml:322-337`)

```yaml
# Source: .github/workflows/release.yml (already in repo, Phase 6 just consumes)
- name: Extract CHANGELOG section for tag
  id: changelog
  shell: bash
  run: |
    TAG="${GITHUB_REF_NAME#v}"
    BODY=""
    if [ -f CHANGELOG.md ]; then
      BODY=$(awk -v tag="$TAG" '
        /^## \[/ {
          if (in_section) exit
          if ($0 ~ "\\[" tag "\\]") { in_section = 1; next }
        }
        in_section { print }
      ' CHANGELOG.md | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
    fi
    if [ -z "$BODY" ]; then
      BODY="Auto-generated release for ${GITHUB_REF_NAME}. ..."
    fi
```

Phase 6 ensures `CHANGELOG.md` has a `## [0.3.0] — YYYY-MM-DD` section BEFORE the tag push, so the extracted body is real.

### SHA-256 checksum publish (`.github/workflows/release.yml:497-505`)

```yaml
# Source: .github/workflows/release.yml (already in repo)
- name: Append checksums to release + attach SHA256SUMS file
  if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
  uses: softprops/action-gh-release@v2
  with:
    tag_name: ${{ github.ref_name }}
    append_body: true
    body_path: ${{ steps.checksums.outputs.checksums_file }}
    files: ${{ steps.checksums.outputs.checksums_file }}
    fail_on_unmatched_files: true
```

Per matrix leg, the `SHA256SUMS-<label>.txt` file gets appended to the release body AND attached as a downloadable asset. This satisfies Phase 0 GATE-05 and is consumed by REL-03's verification grid.

### Workflow-parity lint pattern (NEW — Phase 6 adds to ci.yml)

```yaml
# Pattern recommended for ci.yml as new job
# Closes Release Engineer's Phase 0 retro option B
workflow-parity:
  name: Workflow parity (typecheck flag drift)
  runs-on: ubuntu-22.04
  needs: []   # independent of test job
  steps:
    - uses: actions/checkout@v4
    - name: Detect direct tsc invocations outside typecheck:ci
      run: |
        set -euo pipefail
        # Match `tsc --noEmit` anywhere in either workflow that's NOT inside
        # a `typecheck:ci` bun-run line. The script in package.json is the
        # only blessed entry point.
        OFFENDERS=$(grep -nE 'tsc --noEmit' .github/workflows/{ci,release}.yml \
          | grep -v 'bun run typecheck:ci' || true)
        if [ -n "$OFFENDERS" ]; then
          echo "::error::Direct tsc --noEmit invocations bypass package.json's typecheck:ci script."
          echo "Use 'bun run typecheck:ci' in both workflows to keep flags single-sourced."
          echo "$OFFENDERS"
          exit 1
        fi
        echo "ok — no tsc flag drift"
    - name: Lint workflow YAML
      uses: rhysd/actionlint@v1.7.1   # pin to SHA in actual PR
```

### Tag-shaped dry-run pattern (NEW — Phase 6 adds to release.yml)

```yaml
# Recommended addition to release.yml's `on:` block
# Closes Release Engineer's Phase 0 retro option C
on:
  push:
    tags: ['v*']
  pull_request:
    paths:
      - '.github/workflows/release.yml'
      - 'frontend/src-tauri/**'
      - 'frontend/package.json'
      - 'frontend/src-tauri/Cargo.toml'
      - 'pyproject.toml'
  workflow_dispatch:
    inputs:
      draft:
        description: "Create as draft release (tag push only)"
        required: false
        default: "true"
```

Plus a guard at top of `build` job: `if: github.event_name != 'pull_request' || startsWith(github.head_ref, 'release/')` (or any other naming convention to keep the matrix build off normal feature PRs but on for release-touching PRs). The job exits before the publishing steps for PR-event runs.

### Issue closure query (NEW — used during retro authoring)

```bash
# Source: standard gh-CLI usage
# Run during retro authoring to populate the verification grid

# 1. Create milestone if not exists
gh api -X POST /repos/debpalash/OmniVoice-Studio/milestones -f title=v0.3.0 -f state=open || true

# 2. Assign all 11 originally-open issues to the v0.3.0 milestone
for n in 35 42 48 54 55 56 57 58 60 65 72 76 80; do
  gh issue edit $n --milestone v0.3.0
done

# 3. At retro time — pull closure data
gh issue list --milestone v0.3.0 --state closed --limit 100 \
  --json number,title,closedAt,closedByPullRequestsReferences,labels \
  > .planning/retros/v0.3.0-closure-data.json

# 4. Count opened-during-milestone (net inbox delta)
MILESTONE_START="2026-05-16"   # roadmap-defined date
gh issue list --search "is:issue created:>=$MILESTONE_START" \
  --state all --limit 200 \
  --json number,title,createdAt,state \
  > .planning/retros/v0.3.0-net-inbox.json
```

### Deferral tracking issue template (NEW — REL-05)

```bash
# Source: standard gh-CLI; Phase 6 PLAN.md creates 3 issues from this template

gh issue create --title "v0.4: macOS code signing + notarization (real Apple Developer cert)" \
  --label "v0.4,infrastructure,deferred-from-v0.3" \
  --milestone v0.4 \
  --body "Deferred from v0.3.0 stabilization per REL-05.

## Context
v0.3.0 closed #54 (and #72) via the documented \`xattr -cr\` workaround surfaced in the
first-launch-failure UI (Phase 1 INST-03). The real fix is an Apple Developer Program
enrollment (\$99/yr individual or organization) + Developer ID Application certificate
+ \`xcrun notarytool\` step in release.yml + stapler step to embed the notarization
ticket on the DMG.

## Acceptance criteria
- [ ] Apple Developer Program enrollment authorized by maintainer
- [ ] Developer ID Application cert generated + uploaded to GH org secret as APPLE_CERTIFICATE
- [ ] APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID secrets configured
- [ ] release.yml's tauri-action passes APPLE_* secrets — tauri-action handles notarize + staple automatically
- [ ] Hardened-runtime entitlements verified (microphone, network in/out at minimum)
- [ ] Test: a freshly-downloaded DMG opens on macOS Sequoia without the 'damaged' toast
- [ ] Close #54 (and #72) properly; remove the \`xattr -cr\` error-UI surfacing once
      the documented workaround is no longer needed (or leave for offline-install scenarios)

## Out of scope
- Windows code signing — separate tracking issue
- Auto-update with consent prompt — separate tracking issue
"

gh issue create --title "v0.4: Tauri/WebKit Fedora 44 white-screen upstream fix" \
  --label "v0.4,upstream,deferred-from-v0.3" \
  --milestone v0.4 \
  --body "Deferred from v0.3.0 stabilization per REL-05. ..."

gh issue create --title "v0.4: per-engine subprocess hardening beyond IndexTTS" \
  --label "v0.4,engine,deferred-from-v0.3" \
  --milestone v0.4 \
  --body "Deferred from v0.3.0 stabilization per REL-05. ..."
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual `Stop-Process` cleanup in CI smoke | `taskkill //F //T //PID` on Windows (release.yml:421) | Phase 0 RESEARCH Pitfall #2 | Reliable cleanup on GH ephemeral runners |
| Tauri builds running 4 matrix legs (incl. macos-13 Intel) | 3 matrix legs (macos-14 ARM only) | release.yml:127 comment "macOS Intel dropped" | ~10 min faster releases; Rosetta 2 handles Intel |
| Inline `## [X.Y.Z]` block fallback to commit log | `awk`-driven section extraction with explicit fallback | release.yml:315-337 | Real release notes, not "see commit log" |
| Direct `tsc --noEmit` invocation in both ci.yml and release.yml | Single-sourced `bun run typecheck:ci` script | PR #84 (merged 2026-05-18) | Drift becomes structurally impossible (still need Phase 6 actionlint to enforce) |
| Hard-coded `${{ matrix.bundles }}` per platform | Driven by matrix `include` block | release.yml:122-145 | Easy to add bundle formats per platform |
| `0.0.0.0` default bind | `127.0.0.1` default + opt-in via `OMNIVOICE_BIND_HOST=0.0.0.0` for Docker | PR #84 | Closes the LAN-exposure security gap |

**Deprecated / outdated:**
- **`hf_transfer` for downloads** — superseded by `hf-xet`, per CLAUDE.md "What NOT to Use" (and Phase 1 RESEARCH). No Phase 6 impact.
- **`HfFolder.save_token()`** — replaced by `huggingface_hub.login()` since `huggingface_hub` 1.x. Phase 1 AUTH-03 uses the new API.

---

## Assumptions Log

> Claims tagged `[ASSUMED]` in this research that need user confirmation in discuss-phase.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | User declines to authorize Apple Developer enrollment ($99/yr) for Phase 6 | "Locked Decisions" + Pitfall #4 | If user actually wants notarization in v0.3.0, Phase 6 scope expands; ~2-5 days added (enrollment delay + tauri-action APPLE_* secrets setup + notarize iteration). |
| A2 | PR #73 should be reimplemented over rebased | "Locked Decisions" + Pitfall #3 | If rebase strategy is preferred, `lib.rs` conflict resolution is the load-bearing step — review carefully, don't accept auto-merge. |
| A3 | `v0.3.0` milestone target is "after Phase 5 completes," not a calendar date | "Release flow" diagram | If a calendar deadline (e.g., "ship by end of June") is in play, soak/rc strategy may compress; rc2 becomes likely. |
| A4 | Project-wide `gh issue list --milestone v0.3.0` baseline can be established at Phase 6 start by adding the milestone retroactively | "Issue closure query" code example | If milestone is created mid-phase, issues closed before that may need manual milestone-attribution. |
| A5 | Discord support-volume baseline is feasibly measurable retroactively from channel history | Pitfall #6 | If no Discord history access or the channel is too noisy to count, REL-04's "Discord delta" becomes qualitative; PLAN.md should acknowledge this. |
| A6 | release.yml's `draft: ${{ inputs.draft || 'true' }}` default applies to tag pushes too (publishes as draft) | Anti-Patterns: "Forgetting `gh release edit --draft=false`" | Need to verify by reading tauri-action's handling of `releaseDraft`; if tag-push actually publishes non-draft by default, the "promote step" in the runbook isn't needed. |
| A7 | The Critic's Phase 0 retrospective items (migration-roundtrip CI test, bind-address audit, sibling-endpoint loopback) are already closed by Phase 1 plans + PR #84 | Brief mention in Critic context | If migration-roundtrip is NOT in Phase 1 plans, Phase 6 PLAN.md needs to add it as a pre-tag verification step. **Need to grep Phase 1 plans during planning.** |

---

## Open Questions

1. **Is Apple Developer enrollment authorized for v0.3.0?**
   - What we know: $99/yr (individual) or $299/yr (organization). 24-48h enrollment. CLAUDE.md is explicit that real notarization is v0.4 (Out of Scope row "Real macOS code signing + notarization"). REL-05 reinforces deferral.
   - What's unclear: Whether the user has changed their mind given the "fat v0.3.0" direction.
   - Recommendation: Discuss-phase question. **Default to no** unless user explicitly authorizes.

2. **rc1 → v0.3.0 calendar target?**
   - What we know: 48h soak is fixed (REL-02).
   - What's unclear: Is there a calendar deadline (e.g., "before June 1") or is it "when Phase 5 lands"?
   - Recommendation: Discuss-phase question. Affects whether rc2 is likely (tight calendar = more likely).

3. **Discord support-volume baseline source?**
   - What we know: Discord has channel history.
   - What's unclear: Whether the maintainer has admin access to export channel data or pull message counts retroactively.
   - Recommendation: Discuss-phase question. If no admin access, retro accepts qualitative delta only.

4. **Is the spike-first outcome data for SPIKE-01 / SPIKE-02 available?**
   - What we know: Phase 4 runs SPIKE-01 (GGUF) and SPIKE-02 (Singing). NO-GO outcomes move requirements to Out of Scope.
   - What's unclear: Phase 6 runs after Phase 5; SPIKE outcomes inform CHANGELOG `## Added` section. If SPIKE-02 is NO-GO, the singing section gets omitted.
   - Recommendation: Phase 6 PLAN.md branches on SPIKE outcomes — author CHANGELOG conditionally.

5. **Migration-roundtrip CI test status (Critic's Phase 0 gap)?**
   - What we know: Critic flagged it as a Phase 0 gap. Phase 1 has alembic migrations (AUTH-02). Phase 0 plan exists but isn't executed yet per STATE.md.
   - What's unclear: Whether any Phase 0/1 plan includes a CI test that loads v0.2.7 omnivoice_data fixture and runs migration-to-current.
   - Recommendation: **Grep Phase 1 plans + Phase 0 RESEARCH during PLAN.md authoring.** If absent, add as a Phase 6 pre-tag verification task (one new test, ~20 lines of pytest).

6. **PR #73 reimplementation prerequisites?**
   - What we know: 4-file change. Conflicts in `lib.rs` and `tauri.conf.json`.
   - What's unclear: Whether the backend-split approach is compatible with the Phase 3 mirror cascade (INST-07..11). Both modify `ensure_venv_ready` / `bootstrap.rs` flow.
   - Recommendation: PLAN.md task: "Read Phase 3 plans + verify reimplementation doesn't regress mirror cascade."

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `gh` CLI | All Phase 6 work (issue queries, release management, milestone, tags) | ✓ (verified in this research) | gh-CLI present | — |
| `git` | Tag operations | ✓ | git ≥ 2.x | — |
| `awk` / `sed` | release.yml CHANGELOG extraction (already runs in CI) | ✓ on all runners | POSIX | — |
| `gh api` access to milestones, issues, releases | Retro data + release management | ✓ (assumed — maintainer has admin) | — | — |
| UTM (macOS VM host) | macOS Sequoia clean-VM exercise | ASSUMED ✓ | — | Use a physical macOS machine reset to fresh user profile |
| Hyper-V (Windows VM host) | Windows 11 clean-VM exercise | ASSUMED ✓ | — | Use a physical Windows machine reset |
| Ubuntu 24.04 ISO + VM host | Linux clean-VM exercise | ASSUMED ✓ | — | Live USB or container reset |
| Fedora 44 ISO + VM host | Fedora clean-VM exercise | ASSUMED ✓ | — | Live USB |
| `actionlint` (added in Phase 6) | Workflow-parity job (Release Engineer option B) | Added in PLAN.md | v1.7.1 (verify before pinning) | — |
| Discord admin access for channel history | REL-04 Discord delta metric | ASSUMED ✗ | — | Qualitative delta only (per Pitfall #6) |
| Apple Developer cert (DEFERRED) | macOS notarization (v0.4) | ✗ | — | Phase 1 INST-03 `xattr -cr` workaround already documented + surfaced |

**Missing dependencies with no fallback:**
- None. All Phase 6 work can proceed with stated assumptions.

**Missing dependencies with fallback:**
- Discord admin access (qualitative-only delta).
- Apple Developer cert (workaround already in place; deferred to v0.4).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (backend) + node:test + Vitest (frontend) — already wired in ci.yml |
| Config file | `pyproject.toml` (pytest section) + `frontend/vitest.config.*` |
| Quick run command | `uv run pytest tests/smoke/ -q --tb=short` |
| Full suite command | `uv run pytest tests/ && uv run pytest backend/tests/ && cd frontend && bun run typecheck:ci && bunx vitest run` |
| Phase 6-specific | Manual 4-VM exercise runbook (no automation; REL-01 says "no shortcuts") + new `tests/test_version_bump.py` (Phase 6 adds) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| REL-01 | rc1 exercised on 4 OSes verbatim per docs | manual-only | `.planning/release/v0.3.0-runbook.md` (NEW) | ❌ Phase 6 adds |
| REL-02 | 48h soak with no regression | manual-only (calendar gate) | n/a — wall-clock | n/a |
| REL-03 | Every closed issue has verification line | unit | `pytest tests/test_release_notes.py::test_all_closed_issues_have_verification_line` (NEW) | ❌ Phase 6 adds |
| REL-04 | Retrospective published with 3 metrics | manual + scripted data pull | `gh issue list --milestone v0.3.0` + manual authoring | ❌ Phase 6 adds doc |
| REL-05 | 3 deferral tracking issues filed | smoke | `gh issue list --label "deferred-from-v0.3" --state open` returns 3 | n/a — verified manually |
| REL-06 | All 11 originally-open issues in confirmed end state | smoke | `gh issue list --milestone v0.3.0 --state all` shows 11/11 in end state | n/a — verified manually |
| Cross-cutting | Version bumped in all 4 sources | unit | `pytest tests/test_version_consistency.py` (NEW — 4 grep assertions) | ❌ Phase 6 adds |
| Cross-cutting | CHANGELOG `## [0.3.0]` section has dated header | unit | `pytest tests/test_changelog.py::test_release_section_has_date` (NEW) | ❌ Phase 6 adds |
| Cross-cutting | Workflow-parity (Phase 0 retro option B) | unit | new `workflow-parity` job in ci.yml | ❌ Phase 6 adds |

### Sampling Rate
- **Per task commit:** `uv run pytest tests/smoke/ tests/test_version_consistency.py tests/test_changelog.py -q`
- **Per wave merge:** `uv run pytest tests/ -q --tb=short && cd frontend && bunx vitest run`
- **Phase gate:** Full suite green + 4-VM runbook signed off + 48h soak clean before `v0.3.0` tag push

### Wave 0 Gaps (test files Phase 6 needs to create)

- [ ] `tests/test_version_consistency.py` — asserts `pyproject.toml`, `frontend/package.json`, `frontend/src-tauri/Cargo.toml`, `frontend/src-tauri/tauri.conf.json` all share the same `version` string
- [ ] `tests/test_changelog.py` — asserts the most-recent `## [X.Y.Z]` section has a date in `YYYY-MM-DD` format (not `— Unreleased`)
- [ ] `tests/test_release_notes.py` — placeholder for the verification-line check (run only at release-authoring time; greps CHANGELOG for issue numbers and confirms each links to a PR/commit/docs path)
- [ ] `.planning/release/v0.3.0-runbook.md` — the manual checklist
- [ ] `.planning/retros/v0.3.0-retro.md` — authored at end of phase
- [ ] `.github/workflows/ci.yml` — add `workflow-parity` job
- [ ] (OPTIONAL) `.github/workflows/release.yml` — add `pull_request` paths trigger for tag-shaped dry-run

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no — release flow is human-driven, secrets in GH org | n/a |
| V3 Session Management | no | n/a |
| V4 Access Control | yes — TAURI_SIGNING_PRIVATE_KEY + future APPLE_* secrets must be GH org-secret-scoped, not repo-secret-scoped | GH org secret + branch-protection on release.yml edits |
| V5 Input Validation | yes — release.yml's awk parsing of CHANGELOG.md (untrusted file in repo, but maintainer-curated); CHANGELOG.md content is reviewed via PR | PR review + actionlint |
| V6 Cryptography | yes — updater manifest signing key, SHA-256 checksums, future Apple Developer cert | tauri-action handles signing; never hand-roll |
| V14 Configuration | yes — workflow secrets, env vars, version-source single-sourcing | `OMNIVOICE_BIND_HOST` default-loopback + single-source version + actionlint |

### Known Threat Patterns for the Release Pipeline

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Tag-spoofing (someone pushes `v0.3.0` tag with malicious commit) | Tampering | Branch protection on `main`; tag pushes require write access; release.yml only builds tagged refs |
| Secret exfiltration via malicious PR | Information Disclosure | GH disables secrets on `pull_request` runs of forked repos by default; verify tag-shaped dry-run does NOT enable secrets on PR-event runs |
| Workflow drift between ci.yml and release.yml | Repudiation | actionlint + workflow-parity job (Phase 6 adds) |
| Notarization key leak (future Apple Developer cert) | Information Disclosure | GH org secret scope + rotation; never log secret contents; tauri-action handles redaction |
| Updater manifest spoofing | Tampering | TAURI_SIGNING_PRIVATE_KEY signs latest.json; client verifies signature — already in place |
| Supply-chain attack on GH Actions | Tampering | Pin every action to a SHA, not a floating tag (Phase 0 Pitfall #4 reinforces this) |

---

## Sources

### Primary (HIGH confidence) — files in repo, verified directly

- `.github/workflows/release.yml` (read in full) — existing pipeline
- `.github/workflows/ci.yml` (read in full) — existing CI; the typecheck single-sourcing PR #84 merged into it
- `.planning/ROADMAP.md` — Phase 6 definition, Key Decision #7
- `.planning/REQUIREMENTS.md` — REL-01..06, Out of Scope rows
- `.planning/STATE.md` — current position + Key Decisions
- `.planning/phases/00-gates/RESEARCH.md` (outline only — Phase 0 patterns reused: smoke matrix, fixture, installer smoke, SHA-256, two-RC cadence)
- `.planning/phases/00-gates/PLAN.md` (`grep` confirmed `rc1` references at line 806 — two-RC cadence already drafted)
- `CLAUDE.md` — single-tag release directive, constraints
- `CHANGELOG.md` — current `Unreleased` markers, history pattern
- `pyproject.toml`, `frontend/package.json`, `frontend/src-tauri/Cargo.toml`, `frontend/src-tauri/tauri.conf.json` — version source locations
- `README.md:25-28` — version badge URLs
- `gh pr view 84` — PR #84 body, confirmed merged 2026-05-18T16:30:59Z
- `gh pr view 73` — PR #73 body + conflict surface
- `gh issue list --state open --limit 20` — current 16-issue inbox (Phase 6 closure targets)
- `gh release list --limit 5` — release history pattern (v0.2.7, v0.2.6, v0.2.5...)

### Secondary (MEDIUM confidence) — referenced training knowledge, verified by file content

- Tauri 2 + tauri-action release flow — verified via release.yml configuration (lines 339-358)
- GitHub Milestones API — standard `gh api milestones` usage
- `softprops/action-gh-release@v2` `append_body` semantics — verified by existing workflow runs (Phase 0 GATE-05 already lands checksums)

### Tertiary (LOW confidence) — not verified in this session, flagged for plan-phase

- `rhysd/actionlint` latest pinned version — should be re-checked at PLAN.md authoring time
- Apple Developer Program 2026 pricing ($99 individual, $299 organization) — training-data figure; verify via apple.com/developer at the time it's actually needed (DEFERRED, so this isn't blocking)
- macOS Sequoia (15.x) Gatekeeper behavior under unsigned DMG — Phase 1 INST-03 should already exercise this; Phase 6 confirms in the 4-VM runbook

---

## Metadata

**Confidence breakdown:**
- Release pipeline (release.yml) — HIGH — read in full, PR #84 just landed
- Single-tag directive — HIGH — CLAUDE.md explicit, line 18
- REL-01..06 mapping to test plan — HIGH — REQUIREMENTS.md explicit
- macOS notarization deferral — HIGH — confirmed by REL-05 + Out of Scope row + CLAUDE.md
- PR #73 reimplementation recommendation — MEDIUM — based on conflict surface from PR body; needs Phase 3 cross-check
- Discord delta methodology — LOW — depends on admin access not verified
- Workflow-parity / tag-shaped dry-run patterns — MEDIUM — Release Engineer's Phase 0 recommendations carried forward; standard patterns

**Research date:** 2026-05-18
**Valid until:** 2026-06-18 (30 days for stable release-engineering domain) OR until any of the following events, whichever first:
- Phase 5 (REPORT-*) completion changes the closure picture
- Phase 4 SPIKE-01/02 outcomes are documented (changes CHANGELOG Added section)
- A new high-priority issue lands that changes the v0.3.0 closure bar
- Apple Developer enrollment authorization status flips
