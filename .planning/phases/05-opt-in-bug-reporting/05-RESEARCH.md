# Phase 5: Opt-in Bug Reporting — Research

**Researched:** 2026-05-18
**Domain:** In-app diagnostics, structured GitHub-Issues reporting, PII redaction, multi-runtime error aggregation
**Confidence:** HIGH (all 12 requirements grounded against CLAUDE.md Capability 2 pre-vetted stack, real Phase 1 deeplink infrastructure already in-tree, and Tauri 2 plugin surface already installed)

---

## Summary

Phase 5 is the **support-scaling lever** for the v0.3.x milestone. The Maintainer council member called it "the highest-leverage support-load investment" because every future bug arrives with full repro context (OS / Python / OmniVoice version, CPU / GPU / VRAM, active engine, last error + stack). Strategic value comes not from the feature itself but from the **compounding effect** on every other phase's bug-reproduction time: a v0.3.1 patch landing in 2 weeks instead of 2 months is downstream of this phase.

The architecture is forced into a single lane by PROJECT.md's local-first constraint: **prefilled GitHub Issues URL only**. No PAT, no GitHub App, no third-party telemetry endpoint, no Sentry DSN. This eliminates ~80% of the decision space the engineering literature would normally consider, leaves us with a small but well-understood pattern (`sindresorhus/new-github-issue-url` is the reference implementation), and converts what would have been a multi-week "credential storage + token exchange + rate-limit management" project into a **payload + preview + opener** pattern.

Phase 5 layers on top of Phase 1's already-shipped deeplink infrastructure: `backend/core/links.py` (Phase 1 Wave 2 Task 2) resolves `github.com/debpalash/OmniVoice-Studio` from `tauri.conf.json`, and `@tauri-apps/plugin-opener` is already in `frontend/package.json` (`^2.5.4`) and `frontend/src-tauri/Cargo.toml` (`tauri-plugin-opener = "2"`). Phase 5 only needs `bug_report.py` + `<BugReportDialog />` + a Settings → Privacy toggle. The technical complexity is concentrated in **redaction** (REPORT-05) and **two-step consent UX** (REPORT-04), not in transport.

**Primary recommendation:** Ship in three internal waves:

1. **Wave 1 — Payload + redactor.** `backend/services/bug_report.py` (collector + URL builder), `backend/services/redactor.py` (HOME paths, env vars matching `*TOKEN*|*KEY*|*SECRET*`, HF token, email-like patterns, audio file contents). 100% unit-testable, no UI dependency. Includes recursion guard (REPORT-08), SHA-1 dedup (REPORT-07), rate cap (REPORT-06).

2. **Wave 2 — Two-step consent UI.** `<BugReportDialog />` shows the rendered Markdown payload preview, "Open in GitHub" button calls `tauri-plugin-opener.openUrl(prefilledUrl)`. Settings → Privacy → "Help improve OmniVoice" toggle (default OFF per REPORT-12). Adds a "Report a bug" button to `ErrorBoundary` alongside the existing "Open docs" deeplink.

3. **Wave 3 — Aggregation + pre-submit search.** Wire `global_exception_handler` (Python, already exists at `backend/main.py:347`), Rust `std::panic::set_hook` (no existing hook in `frontend/src-tauri/src/`), and the existing `consoleBuffer.js` ring buffer (`frontend/src/utils/consoleBuffer.js` — already installed in `main.jsx` per its own comment) into a single error-context channel. Pre-submit GitHub search opens `github.com/<repo>/issues?q=<hash>` before the "Open in GitHub" step (REPORT-09). `auto-report` label appended via the `labels=` URL param (REPORT-10).

---

## User Constraints (from CONTEXT.md)

> No CONTEXT.md was produced from a `/gsd:discuss-phase` for Phase 5. The constraints below are sourced from CLAUDE.md Capability 2 (the canonical spec for this phase), PROJECT.md's local-first constraint, ROADMAP.md Phase 5 success criteria, and council direction in the spawning message.

### Locked Decisions

1. **Prefilled GitHub Issues URL is the ONLY submit path.** No PAT, no GitHub App device flow, no Sentry / Bugsnag / Rollbar / Datadog. The URL is built locally and handed to the user's browser via `tauri-plugin-opener.openUrl()`. The user reviews the prefilled form on github.com and clicks Submit themselves — they own the issue, not OmniVoice. (CLAUDE.md Capability 2; REPORT-02; PROJECT.md Constraints — Local-first guarantee preserved.)

2. **Default OFF.** Bug reporting is opt-in via Settings → Privacy → "Help improve OmniVoice" with explicit copy. App must remain fully functional with reporting disabled. (REPORT-12; PROJECT.md Constraints.)

3. **Two-step consent.** Before any browser window opens, user sees a formatted preview of the **exact** payload that will be submitted (rendered Markdown). User clicks "Open in GitHub" to proceed; no implicit submission. (REPORT-04; ROADMAP.md Phase 5 Success Criteria #2.)

4. **Default-deny payload allow-list.** Only explicitly approved fields are read into the payload — nothing else is even collected. Allow-listed fields: OS name+version, Python version, OmniVoice version, backend git SHA / installer build ID, CPU model + RAM, GPU vendor+model+VRAM, active TTS engine + list of installed engines, frontend bun version + OS shell, last error message + stack trace if launched from an error toast. (REPORT-03; CLAUDE.md Capability 2 "What we capture".)

5. **Redaction is non-negotiable.** HF tokens, OpenAI keys, ANY env var matching `*TOKEN*|*KEY*|*SECRET*`, paths under `$HOME` (strip `/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\` → `~/`), email-like patterns, and audio file contents are stripped or refused before preview is shown. The preview the user sees IS the payload. (REPORT-05; CLAUDE.md Capability 2 "What we DO NOT capture".)

6. **Rate / dedup / recursion safeguards.** Per-day cap (3 reports / 24h, default), SHA-1 content dedup within session, recursion guard so the reporter cannot self-report. (REPORT-06, REPORT-07, REPORT-08.)

7. **`auto-report` GitHub label** on every submission via the URL `labels=` parameter, so maintainers can triage them as a distinct class. (REPORT-10.)

8. **Payload size cap ~6 KB encoded.** GitHub issue URLs are technically bounded by browser URL length (Chrome/Safari ~2 MB, but GitHub's server-side cap is the binding constraint — see Pitfall #1). Trim and link to a local `bug-report-<sha>.log` path with "see attached log" instructions when the payload exceeds the cap. (REPORT-11.)

9. **Phase 1's `links.py` + `errorDocsMap.ts` infrastructure is the foundation.** Phase 5 extends, not replaces. The "Report a bug" button sits alongside "Open docs for this error" in the same `ErrorBoundary` fallback.

### Claude's Discretion

- **Wave ordering within Phase 5** (subject to: redactor before any UI; recursion guard before aggregation; rate cap before pre-submit search).
- **Exact module paths.** Recommended: `backend/services/bug_report.py` (matches existing `backend/services/` convention seen for `tts_backend.py`, `dub_pipeline.py`, etc.), `backend/services/redactor.py`, `frontend/src/components/BugReportDialog.jsx`, `frontend/src/components/settings/PrivacyPanel.jsx`.
- **First-launch consent flow.** Whether to prompt on first launch or wait for first error toast. Recommendation: **wait for first error toast**. First-launch consent dialogs are notorious for users blowing past them without reading. A "Report a bug" button in an actual error UI gets meaningful consent — the user sees the preview because they want to report.
- **Whether the preview is rendered Markdown (with a `marked` / `react-markdown` dep) or plain monospace code block.** Recommendation: **plain monospace `<pre>` block** showing the exact Markdown source that will be in the issue body. The user is about to send Markdown to GitHub; show them the source, not a fancy preview. Avoids adding a Markdown renderer dep.
- **Where the local log fallback lives.** Recommendation: `$OMNIVOICE_DATA/bug-reports/<sha1>.md` (next to existing `omnivoice_data/`). Opened with the OS file-explorer via `tauri-plugin-opener.openPath()` from the "see attached log" link.
- **Rate-cap state file format.** Recommendation: a single JSON file at `$OMNIVOICE_DATA/bug-reports/state.json` with `{"reports": [{"sha1": "...", "ts": 1234567890}, ...]}`. Filter to last 24h on read.

### Deferred Ideas (OUT OF SCOPE)

- **GitHub App device flow** for one-click in-app submission (`REPORT-V2-01` — v0.4+; CLAUDE.md "Alternatives Considered" — defer reason: needs registering a public GitHub App + hosting a token-exchange endpoint).
- **Optional crash-aggregation backend** (`REPORT-V2-02` — v0.4+, self-hosted, opt-in for trend analysis).
- **Sentry / `sentry-tauri` / Bugsnag / Rollbar / Datadog** — CLAUDE.md "What NOT to Use" + PROJECT.md anti-features. Never re-evaluate within v0.3.x.
- **Embedded PAT / OmniVoice-owned GitHub bot account** — REQUIREMENTS.md Out of Scope (anti-feature: "token in binary would be extracted; users should own their issues").
- **First-launch consent prompt with mandatory choice** — anti-feature ("local-first/no-surprise principle"). Wait for the user to invoke the feature themselves.
- **Auto-submission without user click on github.com.** Even with consent, every report passes through the user's manual click on the GitHub Submit button.
- **Empty-template bug reports without repro** (#63 — REQUIREMENTS.md Out of Scope; this phase produces _structured_ reports with full system context, not empty templates).

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REPORT-01 | `backend/services/bug_report.py` aggregates errors from 3 producers — Python global exception handler, Rust panic hook, React `ErrorBoundary` | Section: Error-Source Aggregation |
| REPORT-02 | Submit via prefilled GitHub Issues URL (`tauri-plugin-opener`); no PAT, no third-party endpoint, no Sentry DSN | Section: GitHub Issues Prefilled-URL Spec |
| REPORT-03 | Default-deny payload allow-list | Section: Allow-list Payload Schema |
| REPORT-04 | Two-step consent UX — user sees exact payload preview before browser opens | Section: Two-Step Consent UX |
| REPORT-05 | Redact HF tokens, `$HOME` paths, email-like patterns before preview | Section: Privacy / Redaction Layer |
| REPORT-06 | Per-day rate cap (3 / 24h, configurable) | Section: Rate / Dedup / Recursion Safeguards |
| REPORT-07 | SHA-1 content dedup within session | Section: Rate / Dedup / Recursion Safeguards |
| REPORT-08 | Recursion guard — reporter cannot self-report | Section: Rate / Dedup / Recursion Safeguards |
| REPORT-09 | Pre-submit GitHub search opens "similar issues" view | Section: Pre-Submit Issue Search |
| REPORT-10 | All auto-reports carry `auto-report` GitHub label | Section: GitHub Issues Prefilled-URL Spec |
| REPORT-11 | URL length capped ~6 KB encoded; "see attached log" fallback to local file when exceeded | Section: GitHub Issues Prefilled-URL Spec — Length Cap |
| REPORT-12 | OFF by default; opt-in via Settings → Privacy with explicit copy | Section: Two-Step Consent UX + Settings Wiring |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| System info collection (OS, CPU, RAM, GPU, Python version) | Backend service (`backend/services/bug_report.py`) | — | All info comes from Python stdlib (`platform`, `sys`), `psutil` (already pinned ≥7.2.2 in `pyproject.toml`), and `torch.cuda` (already a runtime dep). No native code needed. |
| Frontend system info (bun version, navigator.userAgent) | Frontend (collected via Tauri `app::get_version`, `process::current_arch`) | Backend (forwarded into payload) | Tauri exposes app version + OS via JS APIs; bun version not knowable from inside the app's webview — accept the gap, document it. |
| Active TTS engine + installed engines list | Backend (engine registry) | — | Read from in-memory engine registry (`backend/services/tts_backend.py` and per-engine modules under `backend/engines/`). Already centralized. |
| Last error context | Backend (Python `global_exception_handler` at `main.py:347`) + Frontend (`consoleBuffer.js` ring buffer, exists at `frontend/src/utils/consoleBuffer.js`) | Rust (`std::panic::set_hook` — new) | Three error producers, one collector. The aggregation tier owns the merge. |
| Redaction | Backend service (`backend/services/redactor.py`) | — | Pure Python; deterministic regex + string-replace. Runs at payload-build time AND on preview render time. 100% unit-testable. |
| Payload preview | Frontend (`BugReportDialog.jsx`) | Backend (assembles Markdown body, returns to frontend) | Backend assembles the exact Markdown that will go in the issue. Frontend shows it in a `<pre>` block. **The preview IS the payload.** |
| Two-step consent | Frontend (`BugReportDialog.jsx`) | — | Click 1 = "Open in GitHub" button after preview shown. Click 2 = user clicks GitHub's own Submit button. |
| URL construction (prefilled `?title=&body=&labels=`) | Backend (`bug_report.py:build_issue_url()`) | — | Pure URL encoding. Returns the full URL string to the frontend. |
| URL open action | Frontend (`@tauri-apps/plugin-opener.openUrl()`) | — | Already installed at `^2.5.4`. The opener plugin (not the older shell plugin) is the Tauri 2 path. |
| Settings → Privacy toggle | Frontend (`PrivacyPanel.jsx`) + Backend (`/api/settings/bug-reporting/state` endpoint) | SQLite settings store | Mirrors the Phase 1 `ApiKeysPanel.jsx` + `PerformancePanel.jsx` pattern: small panel, GET/PUT a non-encrypted text setting via `settings_store.get_text("bug_reporting.enabled", "0")`. |
| Rate cap state | Local file (`$OMNIVOICE_DATA/bug-reports/state.json`) | Backend | Flat JSON, last-24h window. Simpler than a DB table for ~3 entries. |
| Dedup state | In-memory `set[str]` on the `BugReporter` singleton | — | Session-scoped per REPORT-07 ("within one session"). Cleared on app restart. |
| Recursion guard | Backend (`threading.local` flag set in `bug_report.py`) | — | Set on enter, cleared on exit; if set on enter, return early. Trivial. |
| Pre-submit GitHub search | Frontend (`BugReportDialog.jsx` — second step) | — | Opens `github.com/<repo>/issues?q=<error_class>` via opener BEFORE the prefilled-new-issue URL. User can click an existing issue (preferred path) or proceed to new. |
| Local log fallback | Backend (writes `bug-reports/<sha1>.md`) + Frontend (`openPath()` for "see attached log" button) | — | Only triggered when payload > ~6 KB encoded. |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@tauri-apps/plugin-opener` | `^2.5.4` (already in `frontend/package.json`) [VERIFIED: present in lockfile] | Open prefilled URL + local log path in user's default browser / OS file explorer | Already installed. This is the Tauri 2 successor to `@tauri-apps/plugin-shell`; uses the same `open()` semantic but is the currently-supported plugin. |
| `tauri-plugin-opener` (Rust side) | `2` (already in `frontend/src-tauri/Cargo.toml` line 28) [VERIFIED: present in Cargo.toml] | Backing for `@tauri-apps/plugin-opener` JS API | Already wired. No new permission needed beyond what's already granted. |
| `platform` (Python stdlib) | stdlib | OS name + version, Python version, machine arch | `platform.platform()` + `platform.python_version()` + `platform.machine()`. Cross-platform, no extra dep. |
| `psutil` | `≥7.2.2` (already in `pyproject.toml`) [VERIFIED: present in pyproject.toml] | CPU model, RAM, optional process info | Already a runtime dep. `psutil.cpu_count()`, `psutil.virtual_memory()`, `psutil.cpu_freq()` cover the spec. |
| `torch.cuda` | from `torch>=2.4` (already pinned) [VERIFIED: present in pyproject.toml] | GPU vendor / model / VRAM | `torch.cuda.is_available()`, `torch.cuda.get_device_name(0)`, `torch.cuda.mem_get_info()`. MPS detection via `torch.backends.mps.is_available()`. ROCm via `torch.version.hip`. |
| `urllib.parse` (Python stdlib) | stdlib | URL-encode title/body/labels for prefilled issue URL | Standard. `urllib.parse.urlencode({...}, quote_via=urllib.parse.quote)` is the canonical pattern matching `sindresorhus/new-github-issue-url`. |
| `hashlib` (Python stdlib) | stdlib | SHA-1 content dedup | `hashlib.sha1(...).hexdigest()`. |
| `tomllib` (Python stdlib, 3.11+) | stdlib | Read OmniVoice version from `pyproject.toml` | Already used by `backend/core/links.py` per Phase 1 plan. |
| `backend.core.links` | already shipped by Phase 1 Wave 2 Task 2 [VERIFIED: file in 01-02-PLAN.md task] | Resolve `github.com/<owner>/<repo>` from `tauri.conf.json` updater endpoint | Reuse — do NOT re-implement repo resolution. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pytest` | already pinned | Redactor + URL builder + rate-cap + dedup unit tests | All new backend code. Redactor needs many deterministic test cases. |
| `vitest` + `@testing-library/react` | already configured per Phase 1 Wave 2 (vitest set up there if absent) | `BugReportDialog` + `PrivacyPanel` component tests | All new frontend components. |
| `react-hot-toast` | already in `frontend/package.json` (`^2.6.0`) | Toast for rate-limit hit / dedup hit feedback | Already installed; reuse pattern from existing toast usage. |
| FastAPI router | already pattern in `backend/api/routers/` | `/api/bug-report/preview`, `/api/bug-report/build-url`, `/api/settings/bug-reporting/state` endpoints | Mirrors Phase 1 `settings.py` router pattern (loopback guard, GET/PUT). |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Prefilled-URL pattern | GitHub App device flow + authenticated POST | Requires public GitHub App registration + token-exchange endpoint. CLAUDE.md "Alternatives Considered" defers to a later milestone. |
| Prefilled-URL pattern | Sentry / `sentry-tauri` | **Never** — CLAUDE.md "What NOT to Use" + PROJECT.md Constraints "no third-party telemetry endpoint". Violates the core local-first promise. |
| `tauri-plugin-opener` | `@tauri-apps/plugin-shell` `open()` | Older plugin; the **opener** plugin is the Tauri 2 supported path and is what's already installed. Phase 1 Wave 2 RESEARCH.md cites `@tauri-apps/plugin-shell` but the actual `package.json` has `@tauri-apps/plugin-opener` (`^2.5.4`) — **use the opener**. (Sources: package.json verified.) |
| In-memory rate cap | SQLite settings table row | A flat JSON file at `$OMNIVOICE_DATA/bug-reports/state.json` survives restarts (needed for "per 24h" semantics across sessions), is human-readable for debugging, and avoids an alembic migration. |
| Markdown preview renderer (`react-markdown`) | Plain monospace `<pre>` block | Pre-block shows the exact source the user is about to send. No new dep. Avoids the meta-debate "did the preview accurately render what GitHub will render". |
| `requests` to GET `github.com/<repo>/issues?q=...` from backend | Open the search URL in the user's browser via opener | Local-first: backend never hits github.com. User's browser does. |

**Installation:** No new Python dependencies. No new frontend dependencies. **All capabilities are deliverable from libraries already in `pyproject.toml`, `frontend/package.json`, and `frontend/src-tauri/Cargo.toml`.**

**Version verification:**
```bash
uv pip list | grep -i psutil           # expect >= 7.2.2
uv pip list | grep -i torch            # expect >= 2.4
grep -i tauri-plugin-opener frontend/package.json frontend/src-tauri/Cargo.toml
```

---

## Package Legitimacy Audit

| Package | Registry | Disposition |
|---------|----------|-------------|
| `@tauri-apps/plugin-opener` | npm — Tauri-owned (`tauri-apps/plugins-workspace`), already installed | Approved |
| `tauri-plugin-opener` | crates.io — Tauri-owned, already installed | Approved |
| `psutil`, `platform`, `tomllib`, `hashlib`, `urllib.parse` | PyPI / stdlib — battle-tested, already pinned | Approved |
| `torch` | PyPI — Meta-owned, already pinned `>=2.4` | Approved |
| `react-hot-toast` | npm — already installed (`^2.6.0`) | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

*No new packages are introduced in Phase 5. This phase is composition over existing primitives.*

---

## Architecture Patterns

### System Architecture Diagram

```
   ┌─────────────────────┐    ┌─────────────────────┐    ┌────────────────────────┐
   │ Python error        │    │ Rust panic          │    │ React error / console  │
   │ (FastAPI            │    │ (std::panic::       │    │ (ErrorBoundary +       │
   │  global_exception_  │    │  set_hook — NEW)    │    │  consoleBuffer.js      │
   │  handler at         │    │                     │    │  ring buffer, both     │
   │  main.py:347)       │    │                     │    │  already exist)        │
   └──────────┬──────────┘    └──────────┬──────────┘    └───────────┬────────────┘
              │                          │                            │
              └──────────────────────────┼────────────────────────────┘
                                         │  (last-error context channel — in-memory)
                                         ▼
                       ┌─────────────────────────────────────┐
                       │ backend/services/bug_report.py      │
                       │                                     │
                       │   BugReporter.collect(error_ctx):   │
                       │     1. recursion-guard check        │
                       │     2. assemble system_info dict    │
                       │     3. attach engine state          │
                       │     4. attach error context         │
                       │     5. redactor.redact(payload)     │
                       │     6. sha1(payload) → dedup        │
                       │     7. rate-cap check (last 24h)    │
                       │     8. render Markdown body         │
                       │     9. build prefilled URL          │
                       │  10. cap at ~6 KB; spill to local   │
                       └────────────────┬────────────────────┘
                                        │  GET /api/bug-report/preview
                                        ▼
                       ┌─────────────────────────────────────┐
                       │ frontend BugReportDialog.jsx        │
                       │                                     │
                       │   STEP 1: preview <pre>{markdown}   │
                       │   STEP 2: "Search similar issues"   │
                       │     → opener.openUrl(search_url)    │
                       │   STEP 3: "Open in GitHub"          │
                       │     → opener.openUrl(prefilled_url) │
                       └────────────────┬────────────────────┘
                                        │  user manually clicks Submit on github.com
                                        ▼
                                  GitHub Issue
                                  (auto-report label)

   ┌────────────────────── Privacy / consent control plane ──────────────────────┐
   │ Settings → Privacy → "Help improve OmniVoice" toggle (default OFF)          │
   │   → PUT /api/settings/bug-reporting/state {enabled: bool}                   │
   │   → settings_store.set_text("bug_reporting.enabled", "1"/"0")               │
   │                                                                              │
   │ ErrorBoundary fallback (frontend):                                          │
   │   - "Open docs for this error"   [Phase 1 deeplink — UNCHANGED]             │
   │   - "Report a bug"               [Phase 5 — only renders if toggle ON]      │
   └─────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
backend/
├── services/
│   ├── bug_report.py             # NEW — BugReporter, collector, URL builder, rate cap, dedup, recursion guard
│   ├── redactor.py               # NEW — redact() function, deterministic regex/string-replace
│   └── settings_store.py         # EXTEND — bug_reporting.enabled flag (reuse Phase 1 get_text/set_text)
├── api/
│   └── routers/
│       └── bug_report.py         # NEW — /api/bug-report/preview, /api/bug-report/build-url, /api/settings/bug-reporting/state
└── core/
    └── links.py                  # USE (Phase 1) — for github.com/<owner>/<repo> resolution

frontend/
├── src/
│   ├── components/
│   │   ├── BugReportDialog.jsx   # NEW — preview dialog, search-similar step, open-in-github step
│   │   ├── BugReportDialog.css   # NEW
│   │   ├── ErrorBoundary.jsx     # EXTEND — add "Report a bug" button next to Phase 1's "Open docs" button
│   │   └── settings/
│   │       ├── PrivacyPanel.jsx  # NEW — opt-in toggle + explainer copy
│   │       └── PrivacyPanel.css  # NEW
│   └── utils/
│       └── consoleBuffer.js      # USE — already captures frontend errors (REPORT-01 frontend producer)

frontend/src-tauri/src/
└── lib.rs                        # EXTEND — install std::panic::set_hook → write last panic to shared channel

$OMNIVOICE_DATA/
└── bug-reports/                  # NEW (created on first report)
    ├── state.json                # rate-cap window state
    └── <sha1>.md                 # local log fallback when payload > 6 KB
```

### Pattern 1: Prefilled GitHub Issues URL

**What:** Build a `https://github.com/<owner>/<repo>/issues/new?title=...&body=...&labels=...` URL with `urllib.parse.urlencode`. Open via Tauri opener. User reviews and submits on github.com.

**When to use:** The ONLY submission path for this phase. There is no Plan B.

**Example:**
```python
# backend/services/bug_report.py
from urllib.parse import urlencode
from backend.core.links import PROJECT_REPO_URL

def build_issue_url(title: str, body: str, labels: list[str]) -> str:
    # Per sindresorhus/new-github-issue-url: title, body, labels (comma-sep) are the supported params.
    # GitHub also supports: assignees, milestone, projects, template — we don't need them.
    params = {
        "title": title,
        "body": body,
        "labels": ",".join(labels),
    }
    return f"{PROJECT_REPO_URL}/issues/new?" + urlencode(params, quote_via=__import__("urllib.parse", fromlist=["quote"]).quote)
```

```javascript
// frontend/src/components/BugReportDialog.jsx
import { openUrl } from "@tauri-apps/plugin-opener";

async function submit(prefilledUrl) {
  await openUrl(prefilledUrl);
}
```

### Pattern 2: Default-Deny Allow-List Payload Assembly

**What:** The collector reads ONLY explicitly named fields. There is no "include everything except…" path; there is only "include these specific fields".

**When to use:** REPORT-03. Every field added to the payload must be a deliberate code change reviewable in a PR.

**Example:**
```python
# backend/services/bug_report.py
ALLOWED_FIELDS = {
    "os": lambda: platform.platform(),                              # e.g. "macOS-14.5-arm64"
    "python": lambda: platform.python_version(),                   # e.g. "3.12.7"
    "machine": lambda: platform.machine(),                          # e.g. "arm64"
    "omnivoice_version": lambda: _read_pyproject_version(),         # from pyproject.toml
    "backend_git_sha": lambda: _read_git_sha() or "unknown",        # if cloned from git
    "cpu_count": lambda: psutil.cpu_count(logical=True),
    "ram_mb": lambda: psutil.virtual_memory().total // (1024 * 1024),
    "gpu": lambda: _detect_gpu(),                                   # CUDA / MPS / ROCm / CPU + name + VRAM
    "active_engine": lambda: _engine_registry_active(),
    "installed_engines": lambda: _engine_registry_installed(),
    "last_error": lambda: _last_error_context(),                    # (error class, message, stack — REDACTED)
}

def collect() -> dict[str, Any]:
    return {k: f() for k, f in ALLOWED_FIELDS.items()}
```

### Pattern 3: Redaction Layer

**What:** Deterministic regex + string-replace that runs against the assembled payload BEFORE preview is shown. Pure function, 100% unit-testable.

**When to use:** REPORT-05. Every field passes through the redactor before any UI sees it.

**Example:**
```python
# backend/services/redactor.py
import os
import re
from pathlib import Path

_TOKEN_RE = re.compile(r"hf_[A-Za-z0-9]{20,}")
_SK_RE    = re.compile(r"sk-[A-Za-z0-9]{20,}")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_HOME_RE  = _build_home_re()    # /Users/<x>/, /home/<x>/, C:\Users\<x>\

# env-var name match: any var whose name contains TOKEN, KEY, or SECRET (case-insensitive)
_REDACTED_ENV_NAME_RE = re.compile(r".*(TOKEN|KEY|SECRET).*", re.IGNORECASE)

def redact(text: str) -> tuple[str, list[str]]:
    """Returns (redacted_text, list_of_redaction_kinds_applied) so caller can show
    'we redacted: $HOME paths, env vars matching *TOKEN*, …' confirmation copy."""
    applied = []
    if _TOKEN_RE.search(text):
        text = _TOKEN_RE.sub("hf_***REDACTED***", text); applied.append("hf-token")
    if _SK_RE.search(text):
        text = _SK_RE.sub("sk-***REDACTED***", text); applied.append("openai-key")
    if _EMAIL_RE.search(text):
        text = _EMAIL_RE.sub("***@***.***", text); applied.append("email")
    text, home_hit = _HOME_RE.subn("~/", text)
    if home_hit:
        applied.append(f"home-paths-x{home_hit}")
    return text, applied

def filter_env(env: dict[str, str]) -> dict[str, str]:
    """Apply to os.environ when including env info in the report (which we mostly don't)."""
    return {k: v for k, v in env.items() if not _REDACTED_ENV_NAME_RE.match(k)}
```

### Pattern 4: Recursion Guard + Dedup + Rate Cap

**What:** Three orthogonal safeguards layered on the entry point.

**When to use:** REPORT-06, REPORT-07, REPORT-08 — every report attempt.

**Example:**
```python
# backend/services/bug_report.py
import threading
import json
import time
import hashlib
from pathlib import Path

_recursion = threading.local()
_session_dedup: set[str] = set()
_STATE_PATH = Path(os.environ.get("OMNIVOICE_DATA", "omnivoice_data")) / "bug-reports" / "state.json"
_WINDOW_SEC = 24 * 60 * 60
_DAILY_CAP = 3

class BugReporter:
    def report(self, ctx: dict) -> dict:
        # Guard 1: recursion
        if getattr(_recursion, "in_progress", False):
            return {"ok": False, "reason": "recursion-guard"}
        _recursion.in_progress = True
        try:
            payload = self.collect_and_redact(ctx)
            sha = hashlib.sha1(payload["body"].encode()).hexdigest()
            # Guard 2: session dedup
            if sha in _session_dedup:
                return {"ok": False, "reason": "duplicate-this-session", "sha1": sha}
            # Guard 3: daily rate cap
            window = self._load_window()
            recent = [e for e in window if time.time() - e["ts"] < _WINDOW_SEC]
            if len(recent) >= _DAILY_CAP:
                return {"ok": False, "reason": "rate-cap", "next_allowed_at": recent[0]["ts"] + _WINDOW_SEC}
            # Update state
            _session_dedup.add(sha)
            recent.append({"sha1": sha, "ts": time.time()})
            self._save_window(recent)
            return {"ok": True, "payload": payload, "sha1": sha}
        finally:
            _recursion.in_progress = False
```

### Pattern 5: Last-Error Context Channel

**What:** Three error producers (Python `global_exception_handler`, Rust `panic::set_hook`, React `consoleBuffer.js`) push into a single shared "last error" channel. The bug reporter reads from that channel when the user clicks "Report a bug" from an error toast.

**When to use:** REPORT-01. Don't aggregate at report-time; aggregate at error-time.

**Example:**

Python — extend existing `backend/main.py:347` `global_exception_handler`:
```python
# inside the existing handler at backend/main.py:347
async def global_exception_handler(request: Request, exc: Exception):
    # ... existing logic ...
    _last_error.set({
        "source": "python",
        "class": exc.__class__.__name__,
        "message": str(exc),
        "stack": "".join(traceback.format_tb(exc.__traceback__)),
        "ts": time.time(),
    })
    # ... existing response building ...
```

Rust — install in `frontend/src-tauri/src/lib.rs` `run()` setup:
```rust
// Phase 5 — install panic hook BEFORE tauri::Builder::default().run()
std::panic::set_hook(Box::new(|info| {
    log::error!("[panic] {}", info);   // also reaches tauri-plugin-log
    // Write last panic to a known path for the Python backend to read:
    let payload = serde_json::json!({
        "source": "rust",
        "message": info.to_string(),
        "ts": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
    });
    let path = dirs::data_dir()
        .map(|p| p.join("omnivoice-studio").join("last-rust-panic.json"));
    if let Some(p) = path {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, payload.to_string());
    }
}));
```

React — `consoleBuffer.js` already exists at `frontend/src/utils/consoleBuffer.js` and already captures `window.error` + `unhandledrejection` + every `console.error` (confirmed by reading the file). REPORT-01's frontend producer is **already deployed**. The bug reporter just calls `getFrontendLogs()` (already exported) when building the payload.

### Anti-Patterns to Avoid

- **Auto-submit on error.** Even when the toggle is ON, the user must click "Open in GitHub". REPORT-04 (two-step consent) makes this explicit. Anti-pattern: silent submission after consent because "they already consented in Settings".
- **First-launch consent modal with mandatory choice.** Violates PROJECT.md "no-surprise principle". Users blow past mandatory modals without reading.
- **Embedding a PAT in the binary for "smoother UX".** REQUIREMENTS.md Out of Scope (anti-feature). Token would be extracted within hours of release; rate-limit DDoS vector.
- **Allow-listing fields by negation ("everything except…").** REPORT-03 requires positive enumeration. The first thing a maintainer asks a security reviewer is "what fields ship in the payload?" — that answer must be a static list, not a runtime computation.
- **Markdown preview that renders the payload differently from what GitHub renders.** Causes false confidence ("the preview looked fine, but the issue formatted my path as a link"). Use a plain `<pre>` block showing the exact Markdown source.
- **Reading `~/.cache/huggingface/token` to include "HF auth state" in the payload.** Even masked, this is a redaction-layer landmine. Don't read the token at all. Capture whether `huggingface_hub.get_token()` returns truthy (boolean only), nothing more.
- **`window.open()` to open the GitHub URL.** Tauri's WebKit sandboxes `window.open()`; some platforms silently no-op. Use `@tauri-apps/plugin-opener.openUrl()` exclusively.
- **Calling `gh issue create` from a bundled `gh` CLI.** That's a PAT-based path under a different name. Same anti-feature class.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Open external URL from a Tauri app | A Rust `Command::new("open" / "xdg-open" / "start")` shell-out | `@tauri-apps/plugin-opener.openUrl()` | Already installed, cross-platform, escapes argv correctly, fires via the OS opener — no shell injection surface. |
| GitHub issue URL construction | String concatenation with manual `?title=` + manual encoding | `urllib.parse.urlencode({...}, quote_via=urllib.parse.quote)` | `urlencode` handles spaces, newlines, `&`, `=`, multibyte characters correctly. Manual concat will silently break on the first multi-line stack trace. |
| OS/CPU/GPU info | Cross-platform shellouts to `system_profiler` (macOS), `wmic` (Windows), `lscpu` (Linux), with regex parsing | `platform.platform()`, `psutil`, `torch.cuda` | The cross-platform Python stdlib already handles this. `platform.platform()` returns `"macOS-14.5-arm64-arm-64bit"` on macOS, `"Windows-11-10.0.22631-SP0"` on Windows, `"Linux-6.5.0-1-amd64-x86_64-with-glibc2.38"` on Linux. `psutil` covers CPU+RAM. `torch.cuda` covers GPU. **No shellouts.** |
| Markdown rendering for the preview | `react-markdown` + `remark` + a CSS for tables | Plain `<pre>` block showing the Markdown source | The preview's purpose is fidelity to what will be submitted, not aesthetics. The user is about to send Markdown to GitHub which has its own renderer — second-guessing it locally adds risk + dep weight for zero user benefit. |
| Email-like pattern detection | Custom regex for every variant | `re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")` (RFC 5322 is the wrong target — we want anything that **looks** like an email so we redact aggressively) | Conservative regex over RFC compliance. False positives are fine here; false negatives leak email addresses. |
| `$HOME` path detection | OS-specific path checks | A single regex compiled at startup against the runtime-resolved home dir paths: `Path.home()`, `os.environ.get("USERPROFILE")` on Windows, fallback to literal `/Users/`, `/home/`, `C:\\Users\\` prefixes | `Path.home()` already resolves correctly per platform. Build the regex once at import time. |
| Rate-cap persistence | SQLite table with an alembic migration | Flat JSON file at `$OMNIVOICE_DATA/bug-reports/state.json` | Three entries per 24h. SQLite is overkill; the migration cost outweighs the value. JSON file is human-readable for debugging. |
| Recursion detection | Global flag with manual reset | `threading.local()` with try/finally | Thread-local guarantees correct behavior under FastAPI's async + threadpool execution model; manual flag risks leaking the "in progress" state across requests. |

**Key insight:** Phase 5 is composition over libraries we already have. The temptation to add `python-github` / `octokit` / `gh` / a Markdown renderer / a Sentry SDK should be resisted at every step. The prefilled-URL pattern's strategic advantage is that it requires **nothing**: no credential, no network, no library, no surface area.

---

## Common Pitfalls

### Pitfall 1: GitHub Issues URL Length Cap is Not Browser URL Length Cap

**What goes wrong:** The body parameter accepts thousands of characters, but **GitHub's server-side issue-create endpoint silently truncates or rejects URLs above a certain length**. The community consensus (sindresorhus/new-github-issue-url issues + GitHub Community threads) is that ~8 KB encoded is where reliability falls off; ~6 KB is the safe upper bound and matches CLAUDE.md's "~6 KB" recommendation.

**Why it happens:** GitHub uses URL-based prefilling as a convenience; it isn't a documented API surface, so there's no SLA on body length. Some browsers (Safari historically) also impose a 2 KB practical limit on URL bar paste; Tauri's opener may inherit that on macOS.

**How to avoid:** Hard-cap at 6 KB encoded. When the payload exceeds the cap, write the full Markdown to `$OMNIVOICE_DATA/bug-reports/<sha1>.md`, replace the body's "Logs" section with `> Full logs exceeded URL length cap. Saved to: ~/omnivoice_data/bug-reports/<sha1>.md — click to open file location and attach to this issue.`, and add a "Show me where the log file is" button to the dialog that opens the path via `openPath()`.

**Warning signs:** GitHub Issues that opened with a truncated body, or `openUrl()` opening to an empty github.com page instead of the prefilled form.

### Pitfall 2: `tauri-plugin-shell` vs `tauri-plugin-opener` Confusion

**What goes wrong:** CLAUDE.md and Phase 1's RESEARCH.md both reference `@tauri-apps/plugin-shell` `open()`. But the actual installed plugin in `frontend/package.json` is `@tauri-apps/plugin-opener` (`^2.5.4`) and in `frontend/src-tauri/Cargo.toml` is `tauri-plugin-opener = "2"`. If Phase 5 code imports `@tauri-apps/plugin-shell`, the import silently resolves to nothing because the package isn't installed.

**Why it happens:** Tauri 2 renamed/split the shell plugin. The `opener` plugin is the dedicated "open external URLs / paths" plugin; `shell` is now for running commands. Reference material that pre-dates the split still says "shell.open()".

**How to avoid:** Use `import { openUrl, openPath } from "@tauri-apps/plugin-opener"`. Confirm by reading `frontend/package.json` at planning time. Add a verification test that imports the function and asserts it's callable.

**Warning signs:** Tests pass in CI (imports stub out), but at runtime in a real Tauri build, clicking "Open in GitHub" does nothing and no error appears in the console.

### Pitfall 3: Redaction Runs Once Per Field, Not Once Per Payload

**What goes wrong:** Apply redaction per-field early in collection. A stack trace contains both a `$HOME` path AND an HF token in the env-var dump. If redaction runs only on the final concatenated string, a regex that matches "tokens that look like X" might miss a token formatted differently inside a particular field's escape sequence.

**Why it happens:** Convenience — one big `redact()` call at the end feels cleaner.

**How to avoid:** Run `redactor.redact()` at the **field** boundary, then again at the **final body** boundary. Idempotent — running twice on already-redacted text is a no-op. Add a test asserting `redact(redact(x)[0]) == redact(x)`.

**Warning signs:** A regression report from a user whose token leaked through despite redaction tests passing — usually because the token appeared in a field that was assembled AFTER the redactor ran.

### Pitfall 4: Recursion Guard Forgets the `finally` Clause

**What goes wrong:** Reporter catches an exception during collection (say, `psutil` throws on a sandboxed environment), bug reporter raises, recursion flag stays set, future reports are silently dropped as "recursion".

**Why it happens:** Programmer puts the guard set before the try block and the unset inside the try, not in `finally`.

**How to avoid:** Always `try / ... / finally: _recursion.in_progress = False`. Add a unit test that asserts the flag is False after a reporter call that raises.

**Warning signs:** Users report "I clicked Report a bug and nothing happened" — and you find the recursion flag still True in the running session.

### Pitfall 5: Pre-Submit Search URL Encoding Differs From Issue-New URL Encoding

**What goes wrong:** GitHub Issues search uses `q=` with its own query DSL (`is:issue`, `label:auto-report`, etc.). If you reuse the same URL builder as the issue-new path, the search query may be over-encoded (literal `%3A` instead of `:` in `is:issue`) and return zero results.

**Why it happens:** `urlencode` is correct for issue-new (where `:`/space need encoding inside titles), but search wants the DSL keywords readable.

**How to avoid:** Build the search URL with a different helper: `f"{repo}/issues?q={quote_plus('is:issue ' + sanitized_query)}"`. Test: search a known-existing label and assert the URL returns issues when opened manually.

**Warning signs:** "We found similar issues" step always returns zero results in dogfooding even when matches obviously exist.

### Pitfall 6: Rate-Cap Persistence File Is Inside `omnivoice_data/` Which Is Sometimes Volatile

**What goes wrong:** Some users (CI, sandboxed pip installs, Docker container) run with a non-default `$OMNIVOICE_DATA` that doesn't persist between sessions. Rate cap resets every launch; the user can spam reports.

**Why it happens:** "User data directory" semantics differ per platform; we don't have a "config" directory separate from "data" today.

**How to avoid:** Document the assumption explicitly. Accept the edge case — a user who deliberately wipes `omnivoice_data/` between launches is signaling "fresh start" and a reset rate-cap is consistent with that. The 24h window is a politeness layer, not a security boundary.

**Warning signs:** Test reports filed from CI environments. Add a daily-report log line so maintainers can spot patterns.

### Pitfall 7: Rust `panic::set_hook` Replaces the Default Hook

**What goes wrong:** `std::panic::set_hook` is **replacement**, not chain. If `tauri-plugin-log` already installed a hook, your set_hook drops its logging behavior. Suddenly Rust panics don't appear in backend.log.

**Why it happens:** Rust panic hooks are global singletons; the API doesn't chain.

**How to avoid:** Call `let prev = std::panic::take_hook();` first, then `std::panic::set_hook(Box::new(move |info| { /* our logic */; prev(info); }));`. This preserves the prior hook (probably the default + tauri-plugin-log's).

**Warning signs:** `tauri-plugin-log` users report missing panic entries in `backend.log` after Phase 5 ships.

### Pitfall 8: Phase 2 SubprocessBackend Engines May Crash in a Way the Parent Can't See

**What goes wrong:** A subprocess engine (e.g., IndexTTS in its own venv) segfaults or OOMs. The parent FastAPI process sees a closed IPC pipe and surfaces a generic "engine subprocess died" error. The user clicks "Report a bug" but the report has no detail about WHAT killed the subprocess — the actual stack lived in the child.

**Why it happens:** Cross-process error context is lossy by default.

**How to avoid:** When Phase 2's SubprocessBackend wires up the child, install a child-side `sys.excepthook` that writes the last error + stack to a known file (`$OMNIVOICE_DATA/subprocess-errors/<engine>-<pid>.json`) BEFORE the process dies. The parent reads from that file when assembling the bug report. Phase 5 ships the parent-side reader; Phase 2 wires the child-side writer if it isn't already (the SUMMARY.md Open Questions for Phase 2 should pick this up — flagged for handoff).

**Warning signs:** Bug reports for engine subprocess crashes contain only "process died" without a stack — and Discord users have to repro by hand.

---

## Runtime State Inventory

> Not applicable — Phase 5 is a pure addition (new files only), not a rename/refactor/migration. No existing on-disk state needs updating.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — Phase 5 introduces a new directory (`$OMNIVOICE_DATA/bug-reports/`) but does not modify existing data | None |
| Live service config | None | None |
| OS-registered state | None | None |
| Secrets/env vars | None — the redactor REMOVES references to tokens/keys; it does not introduce new env vars | None |
| Build artifacts | None — no new bundled binaries, no installed packages | None |

---

## Code Examples

### Common Operation 1: Build the prefilled URL (with size cap)

```python
# Source: sindresorhus/new-github-issue-url canonical pattern + CLAUDE.md Capability 2
# https://github.com/sindresorhus/new-github-issue-url
from urllib.parse import urlencode, quote
from backend.core.links import PROJECT_REPO_URL

_URL_BUDGET = 6 * 1024  # ~6 KB encoded, per REPORT-11 + Pitfall #1

def build_issue_url(title: str, body: str, labels: list[str]) -> tuple[str, bool]:
    """Returns (url, truncated). When truncated=True, caller should write full body to disk
    and substitute a 'see attached log' note before retrying."""
    params = {"title": title, "body": body, "labels": ",".join(labels)}
    url = f"{PROJECT_REPO_URL}/issues/new?" + urlencode(params, quote_via=quote)
    if len(url.encode("utf-8")) <= _URL_BUDGET:
        return url, False
    return url, True

def build_truncated_url(title: str, body: str, labels: list[str], local_log_path: str) -> str:
    """Replace the verbose sections with a pointer to the local log."""
    truncated_body = (
        body.split("## Logs")[0]
        + f"\n## Logs\n\n> Full logs exceeded URL length cap.\n> Saved locally to: `{local_log_path}`\n"
        f"> Open the file and paste its contents into this issue before submitting.\n"
    )
    url, still_too_long = build_issue_url(title, truncated_body, labels)
    if still_too_long:
        # Last-resort: drop the body entirely except for the local-log pointer.
        return build_issue_url(title, f"See `{local_log_path}` for the full report.", labels)[0]
    return url
```

### Common Operation 2: Issue Body Markdown Template

```python
# Source: CLAUDE.md Capability 2 "What we capture" + REPORT-03 allow-list
def render_body(info: dict, error_ctx: dict | None) -> str:
    return f"""\
## Description
<!-- Please describe what you were doing when this happened. -->

## System

- **OS:** {info['os']}
- **Python:** {info['python']}
- **Architecture:** {info['machine']}
- **OmniVoice version:** {info['omnivoice_version']}
- **Backend SHA:** `{info['backend_git_sha']}`

## Hardware

- **CPU:** {info['cpu_count']} cores
- **RAM:** {info['ram_mb']} MiB
- **GPU:** {info['gpu']}

## Engines

- **Active:** `{info['active_engine']}`
- **Installed:** {', '.join(f'`{e}`' for e in info['installed_engines'])}

## Last error

{_format_error_block(error_ctx) if error_ctx else '_No error context — report initiated from Settings._'}

## Privacy attestation

- [x] No audio files attached (paths only, no contents).
- [x] No HF tokens, OpenAI keys, or env vars matching `*TOKEN*|*KEY*|*SECRET*` included.
- [x] Paths under `$HOME` redacted to `~/`.

<sub>Filed via OmniVoice Studio's in-app bug reporter — `auto-report` label.</sub>
"""
```

### Common Operation 3: ErrorBoundary integration (frontend)

```jsx
// Source: extends frontend/src/components/ErrorBoundary.jsx (already exists per Phase 1)
import { openDocsFor } from '../utils/errorDocsMap';   // Phase 1
import { startBugReport } from '../utils/bugReport';   // Phase 5 — NEW

// Inside ErrorBoundary's render() fallback path:
<div className="errbnd-actions">
  <button onClick={() => openDocsFor(matchedClass)}>
    Open docs for this error
  </button>

  {/* Only render if Settings → Privacy → "Help improve OmniVoice" is ON */}
  {bugReportingEnabled && (
    <button onClick={() => startBugReport({ source: 'error-boundary', errorClass: matchedClass, error: this.state.error })}>
      Report a bug
    </button>
  )}
</div>
```

```js
// frontend/src/utils/bugReport.js — NEW
import { openUrl, openPath } from "@tauri-apps/plugin-opener";

export async function startBugReport(ctx) {
  // Step 1: ask backend to build the payload + url, applying redaction + rate-cap + dedup.
  const res = await fetch('/api/bug-report/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ctx),
  }).then(r => r.json());

  if (!res.ok) {
    // Surface toast for rate-cap / dedup / recursion-guard hits per REPORT-06/07/08.
    return showReasonToast(res.reason);
  }
  // Step 2: render the BugReportDialog with res.body (Markdown source), res.search_url, res.issue_url.
  // The user clicks "Search similar issues" -> openUrl(res.search_url) -- REPORT-09.
  // Then clicks "Open in GitHub" -> openUrl(res.issue_url) -- REPORT-04.
  return openBugReportDialog(res);
}
```

### Common Operation 4: Settings → Privacy toggle (mirrors Phase 1 `PerformancePanel` pattern)

```jsx
// frontend/src/components/settings/PrivacyPanel.jsx — NEW
export default function PrivacyPanel() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    fetch('/api/settings/bug-reporting/state').then(r => r.json()).then(s => setEnabled(s.enabled));
  }, []);
  const toggle = async () => {
    const next = !enabled;
    await fetch('/api/settings/bug-reporting/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    setEnabled(next);
  };
  return (
    <section>
      <h3>Help improve OmniVoice</h3>
      <p>
        When enabled, errors get a "Report a bug" button that opens a prefilled
        GitHub issue in your browser. You review the exact payload before anything
        is submitted, and you click Submit on GitHub yourself.
      </p>
      <p>
        <strong>What gets sent:</strong> OS &amp; CPU/GPU info, OmniVoice version, the
        active engine, the last error message and stack trace.
        <br />
        <strong>What does NOT get sent:</strong> Audio files, HF tokens, OpenAI keys,
        env vars containing TOKEN/KEY/SECRET, paths under your home directory.
        <br />
        Nothing is ever submitted without your click on github.com.
      </p>
      <label>
        <input type="checkbox" checked={enabled} onChange={toggle} />
        Enable bug reporting
      </label>
    </section>
  );
}
```

### Common Operation 5: Pre-submit similar-issues search

```python
# Source: GitHub Issues search DSL — https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
from urllib.parse import quote_plus
from backend.core.links import PROJECT_REPO_URL

def build_search_url(error_class: str | None, error_message_first_line: str) -> str:
    # Search GitHub for open issues matching the error class + first line of the message.
    # Use `is:issue` (not just `state:open`) so closed issues with a documented workaround
    # ALSO surface — that's the highest-value pre-submit hit ("this is already known + fixed").
    q = "is:issue"
    if error_class:
        q += f" {error_class}"
    if error_message_first_line:
        q += f' "{error_message_first_line[:80]}"'   # 80-char cap to keep search useful
    return f"{PROJECT_REPO_URL}/issues?q={quote_plus(q)}"
```

---

## Subprocess-Engine Error Capture (Phase 2 Handoff)

Phase 2's `SubprocessBackend` runs engines in dedicated venvs. Phase 5 needs to capture errors from those subprocesses, but the parent's `global_exception_handler` won't see exceptions that originate in the child.

**Pattern:** Child-side `sys.excepthook` writes last error to a known location; parent reads at report-build time.

**Child (Phase 2 wires this — flag for handoff):**
```python
# In SubprocessBackend child boot:
import sys, json, time, traceback, os
from pathlib import Path

_LAST_ERROR_PATH = Path(os.environ["OMNIVOICE_DATA"]) / "subprocess-errors" / f"{ENGINE_NAME}-{os.getpid()}.json"

def _child_excepthook(exc_type, exc_value, exc_tb):
    _LAST_ERROR_PATH.parent.mkdir(parents=True, exist_ok=True)
    _LAST_ERROR_PATH.write_text(json.dumps({
        "source": f"subprocess:{ENGINE_NAME}",
        "class": exc_type.__name__,
        "message": str(exc_value),
        "stack": "".join(traceback.format_tb(exc_tb)),
        "ts": time.time(),
        "pid": os.getpid(),
    }))
    sys.__excepthook__(exc_type, exc_value, exc_tb)   # chain to default

sys.excepthook = _child_excepthook
```

**Parent (Phase 5 owns this):**
```python
# backend/services/bug_report.py
def _read_subprocess_errors() -> list[dict]:
    base = Path(os.environ.get("OMNIVOICE_DATA", "omnivoice_data")) / "subprocess-errors"
    if not base.exists():
        return []
    # Most recent files first; cap at 5 entries to keep the URL small.
    entries = sorted(base.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:5]
    out = []
    for p in entries:
        try:
            out.append(json.loads(p.read_text()))
        except Exception:
            continue
    return out
```

**Handoff note for Phase 2 planner:** Add a checkbox to Phase 2's Done criteria — "child-side `sys.excepthook` writes to `$OMNIVOICE_DATA/subprocess-errors/<engine>-<pid>.json`". If Phase 2 ships without this, Phase 5 still works for in-process errors, but subprocess crashes lose context.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@tauri-apps/plugin-shell` `open()` | `@tauri-apps/plugin-opener` `openUrl()` / `openPath()` | Tauri 2.x — opener plugin split out as the dedicated path | Phase 5 MUST use opener, not shell. CLAUDE.md and Phase 1 RESEARCH.md both reference shell — those references are stale; the installed plugin is opener. |
| `HfFolder.save_token()` direct read of the HF token file to know "is the user logged in" | `huggingface_hub.get_token()` returning bool truthiness only | huggingface_hub 1.x | Phase 5 should NEVER read the token value itself; check truthiness only. |
| `setx HF_TOKEN ...` Windows persistence | `[Environment]::SetEnvironmentVariable(...,"User")` | Documented in CLAUDE.md | Not directly relevant to Phase 5, but the redactor must still mask the value if it appears in an env-var dump. |

**Deprecated/outdated:**
- `tauri-plugin-shell` for opening URLs — superseded by `tauri-plugin-opener` in Tauri 2.x.
- Sentry / `sentry-tauri` — rejected by PROJECT.md; do not re-evaluate within v0.3.x.
- PAT-based posting — anti-feature, never appropriate for this app.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | GitHub Issues prefilled URL has a practical ~6 KB body cap | Pitfall #1, REPORT-11 | If the real cap is higher, we under-utilize the URL and spill to local log unnecessarily. If lower, the user clicks "Open in GitHub" and lands on an empty form — observable in QA. **Mitigation:** Hard-cap at 6 KB matches CLAUDE.md guidance + community consensus. |
| A2 | `tauri-plugin-opener` works identically on macOS / Windows / Linux for `https://` URLs | Pattern 1, REPORT-02 | Cross-platform regression. **Mitigation:** Verify via the Phase 0 cross-platform CI smoke test — extend it to assert `openUrl("https://example.com")` returns OK on all three platforms. |
| A3 | Phase 1's `backend/core/links.py` resolves to the desktop-app fork (`github.com/debpalash/OmniVoice-Studio`), not the upstream model repo (`github.com/k2-fsa/OmniVoice`) | Pattern 1 + multiple references | Bug reports filed against the wrong repo. **Mitigation:** Phase 1's plan explicitly tests this (`test_prefers_tauri_config_when_present` in `01-02-PLAN.md` Task 2). Phase 5 reuses the constant. |
| A4 | `frontend/src/utils/consoleBuffer.js` is already installed (via `installConsoleCapture()` in `main.jsx`) and captures React errors | Pattern 5, REPORT-01 | If not installed, the frontend producer of REPORT-01 silently captures nothing. **Mitigation:** The file's own comment says "Installed once in main.jsx" — verify with `grep installConsoleCapture frontend/src/main.jsx` before planning. |
| A5 | The current Rust panic hook is the default (no custom hook) | Pitfall #7 | If `tauri-plugin-log` or another plugin already installed a hook, we must chain via `take_hook()`. **Mitigation:** Grep `frontend/src-tauri/src/` for `set_hook` — confirmed nothing in `src/` (only build-artifact references in `target/`). Still chain defensively. |
| A6 | `$OMNIVOICE_DATA` is a persistent user-data directory in real installs | Pitfall #6, rate-cap state | CI / Docker / temp installs reset state every launch. Accepted edge case. |
| A7 | Phase 2's SubprocessBackend will install child-side `sys.excepthook` | Subprocess-Engine Error Capture | If not, subprocess crashes report with no stack. **Mitigation:** Add to Phase 2's Done criteria via handoff note. Phase 5 ships with graceful degradation (empty `subprocess-errors/` directory just means no entries). |
| A8 | `psutil>=7.2.2` is currently in `pyproject.toml` | Standard Stack | Confirmed via direct read of `pyproject.toml`. |
| A9 | The desktop app fork URL is `github.com/debpalash/OmniVoice-Studio` per Phase 1 Wave 2 Task 2 | Pattern 1 | Cross-checked against `01-02-PLAN.md` line 229 + 374. |
| A10 | The 4-error-class taxonomy from Phase 1 is the complete set of "known error classes" Phase 5 will pre-tag at report time | Pre-Submit Search | Phase 5 may discover new error classes (e.g., engine-subprocess-died, OOM, model-download-failed) that should be added. **Mitigation:** Treat the taxonomy as extensible — Phase 5 adds new classes to `error_docs_map.py` as it identifies them, then Phase 1's mirror test fails until the TS side adds them too. |

---

## Open Questions

1. **Should the prefilled URL include the OmniVoice version in the title (e.g., `[v0.3.0-rc1][bug] AttributeError ...`) or only in the body?**
   - What we know: GitHub's title is the most-scanned field by maintainers; version-in-title helps triage. But title-length cap is ~256 chars; a long error class + version eats budget.
   - What's unclear: Maintainer preference.
   - Recommendation: Version + 1-line error summary in title, full detail in body. Cap title to 200 chars to leave room for GitHub's UI ellipsis.

2. **Should "Search similar issues" be MANDATORY (block "Open in GitHub" until clicked) or OPTIONAL (just a button)?**
   - What we know: Mandatory raises friction but improves dedup. Optional preserves UX flow.
   - What's unclear: Empirically which gets more dedup hits.
   - Recommendation: **Optional but prominent** — make the "Search similar issues" button the same visual weight as "Open in GitHub", placed first. Friction at the cost of dedup is worse than missed dedup for v0.3.x; we can revisit if maintainers report 80% of `auto-report`-labeled issues are duplicates.

3. **Should Rust panics auto-trigger the bug-report dialog, or just log to disk for next-launch review?**
   - What we know: A Rust panic typically takes the whole app down. We can't show a React dialog after that — the WebView is gone.
   - What's unclear: Whether to show a recovery dialog on NEXT launch ("we noticed OmniVoice crashed last time — report?").
   - Recommendation: **Defer to v0.4**. v0.3.x scope: write panics to disk; the bug reporter reads them when invoked from a future error toast. Cross-restart recovery UX is its own design problem.

4. **Where does the "Privacy" tab live in Settings?**
   - What we know: Phase 1 adds `ApiKeysPanel` and `PerformancePanel` to a Settings page. Phase 5 adds `PrivacyPanel`.
   - What's unclear: Whether the Settings page already has tabs (Radix-UI `@radix-ui/react-tabs` is in `frontend/package.json`) or is a single-page panel.
   - Recommendation: Planner reads the current Settings root component (search `frontend/src/components/` for a `SettingsPage`/`SettingsView`/`PreferencesPage` file) during planning, fits the panel into the existing pattern.

5. **Should pre-submit search include closed issues?**
   - What we know: Closed issues with `documented workaround` label are HIGH-value hits (user can resolve without filing).
   - What's unclear: Whether to also include closed-without-fix (might confuse users).
   - Recommendation: Use `is:issue` (all states) but pre-sort by interaction count. GitHub's default sort handles this reasonably.

6. **What's the right title for `auto-report` label?**
   - What we know: REPORT-10 mandates the label. The label string is `auto-report`.
   - What's unclear: Should the label exist in the repo's labels list before first report? GitHub Issues prefilled-URL `labels=` param will auto-create labels that don't exist YET when the user submits, but the issue gets created without the label if the user lacks write access (which most non-maintainer users do).
   - Recommendation: Maintainer ensures the `auto-report` label exists in the repo's label set BEFORE v0.3.0 ships (one-time setup). If a user lacks repo write access and the label gets stripped, that's an acceptable degraded path — the body still says "Filed via OmniVoice Studio's in-app bug reporter".

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| `psutil` | System info collection | ✓ | `>=7.2.2` (pyproject.toml) | — |
| `platform` | OS / Python info | ✓ | stdlib | — |
| `torch.cuda` | GPU detection | ✓ | from `torch>=2.4` | Report "no torch" gracefully when uninstalled |
| `@tauri-apps/plugin-opener` | Open URL + path | ✓ | `^2.5.4` (package.json) | — |
| `tauri-plugin-opener` (Rust) | Backing for opener | ✓ | `"2"` (Cargo.toml line 28) | — |
| `huggingface_hub` | `get_token()` truthiness check | ✓ | `>=1.12.x` (transitive) | — |
| `react-hot-toast` | Rate-limit / dedup feedback | ✓ | `^2.6.0` (package.json) | — |
| `vitest` + `@testing-library/react` | Frontend component tests | ✓ (set up by Phase 1 Wave 2 if not previously) | — | — |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework (backend) | `pytest` (already in dev-deps, used throughout `tests/`) |
| Framework (frontend) | `vitest` (configured by Phase 1 Wave 2) |
| Config file | `pyproject.toml` `[tool.pytest.ini_options]` + `frontend/vitest.config.ts` |
| Quick run command | `uv run pytest tests/backend/services/test_bug_report.py tests/backend/services/test_redactor.py -x` |
| Full suite command | `uv run pytest -x` (backend) + `(cd frontend && bun test)` (frontend) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REPORT-01 | Aggregates errors from Python, Rust, React | unit + integration | `uv run pytest tests/backend/services/test_bug_report.py::test_aggregates_three_sources -x` | ❌ Wave 0 |
| REPORT-02 | Prefilled URL has correct `github.com/<owner>/<repo>/issues/new?…` shape | unit | `uv run pytest tests/backend/services/test_bug_report.py::test_url_shape -x` | ❌ Wave 0 |
| REPORT-03 | Allow-list — assert no field outside the list is present | unit | `uv run pytest tests/backend/services/test_bug_report.py::test_allow_list -x` | ❌ Wave 0 |
| REPORT-04 | Two-step consent — dialog renders preview before opening URL | component | `(cd frontend && bun test BugReportDialog)` | ❌ Wave 0 |
| REPORT-05 | Redact tokens, paths, emails | unit | `uv run pytest tests/backend/services/test_redactor.py -x` | ❌ Wave 0 |
| REPORT-06 | Rate cap blocks 4th report in 24h | unit | `uv run pytest tests/backend/services/test_bug_report.py::test_rate_cap -x` | ❌ Wave 0 |
| REPORT-07 | SHA-1 dedup blocks identical second report | unit | `uv run pytest tests/backend/services/test_bug_report.py::test_dedup -x` | ❌ Wave 0 |
| REPORT-08 | Recursion guard blocks reporter-from-reporter | unit | `uv run pytest tests/backend/services/test_bug_report.py::test_recursion_guard -x` | ❌ Wave 0 |
| REPORT-09 | Pre-submit search URL matches GitHub search DSL | unit + manual | `uv run pytest tests/backend/services/test_bug_report.py::test_search_url -x` + manual click-through | ❌ Wave 0 |
| REPORT-10 | URL contains `labels=auto-report` | unit | `uv run pytest tests/backend/services/test_bug_report.py::test_label -x` | ❌ Wave 0 |
| REPORT-11 | URL > 6 KB triggers local log spill + truncated URL | unit | `uv run pytest tests/backend/services/test_bug_report.py::test_url_length_cap -x` | ❌ Wave 0 |
| REPORT-12 | Default state: bug_reporting.enabled = "0" | unit | `uv run pytest tests/backend/services/test_settings_store.py::test_bug_reporting_default_off -x` | ❌ Wave 0 (extend existing) |

### Sampling Rate

- **Per task commit:** `uv run pytest tests/backend/services/test_bug_report.py tests/backend/services/test_redactor.py -x` (~2 sec)
- **Per wave merge:** `uv run pytest -x` + `(cd frontend && bun test)` (full suite)
- **Phase gate:** Full suite green + manual click-through on macOS / Windows / Linux (verify `openUrl()` actually opens GitHub on each platform per A2)

### Wave 0 Gaps

- [ ] `tests/backend/services/test_bug_report.py` — covers REPORT-01..03, 06..11
- [ ] `tests/backend/services/test_redactor.py` — covers REPORT-05
- [ ] `frontend/src/components/BugReportDialog.test.jsx` — covers REPORT-04
- [ ] `frontend/src/components/settings/PrivacyPanel.test.jsx` — covers REPORT-12
- [ ] Cross-platform smoke test extension — assert `openUrl()` opens an HTTP URL on each platform (A2 mitigation)
- [ ] Manual rc1 checklist line: "click Report a bug from an error toast on macOS / Windows / Linux — landing page is the prefilled github.com issue form with the expected title + body"

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | No credential is stored, transmitted, or validated by Phase 5. The user authenticates to GitHub themselves in their browser. |
| V3 Session Management | no | No session. The reporter is stateless per-invocation; rate-cap state is local and non-authoritative. |
| V4 Access Control | yes | Settings → Privacy endpoints (GET/PUT `/api/settings/bug-reporting/state`) reuse the **loopback Host header guard** from Phase 1's settings router (T-02-04 in Phase 1 plan). PUT from non-loopback Host returns 403. |
| V5 Input Validation | yes | Two paths: (1) URL encoding via `urlencode(..., quote_via=quote)` — all user-content fields are encoded before becoming part of the URL; (2) all collected fields are typed-validated at the allow-list boundary (e.g., `psutil.virtual_memory().total` must be `int`). |
| V6 Cryptography | no (none added) | Phase 5 introduces no cryptographic primitives. The SHA-1 used for dedup is a content fingerprint, not a security boundary. |
| V7 Error Handling & Logging | yes | The reporter explicitly redacts before logging. The recursion guard ensures errors in the reporter do not flood logs. |
| V8 Data Protection | yes | Redaction layer (REPORT-05) is the primary data-protection control. Allow-list (REPORT-03) is the secondary control. |
| V9 Communication | yes (passively) | All "communication" happens in the user's browser, not from OmniVoice. We send no telemetry. We open one URL — the user is in charge from there. |

### Known Threat Patterns for {Tauri 2 + FastAPI + React}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| User-controlled content injected into the URL escapes encoding and breaks the prefilled form | Tampering | `urlencode(..., quote_via=quote)` — Python's stdlib handles encoding correctly for all titles/bodies/labels. Unit test asserts encoded output round-trips. |
| Token / key / path leaks via the payload despite the redactor | Information Disclosure | Redactor runs at field-collection time AND at final-body time (idempotent). Allow-list ensures no field outside the approved set is ever READ in the first place. Unit tests cover every redaction pattern. |
| Attacker-controlled malicious URL substituted into the "Open in GitHub" button | Tampering | URL is constructed locally from `links.PROJECT_REPO_URL` (Phase 1's resolver — pinned to the desktop app fork). No user input influences the host or path. |
| Non-loopback request flips Settings → Privacy → enabled | Elevation of Privilege | PUT endpoint reuses Phase 1's loopback Host header check (T-02-04). Test asserts a 403 from non-loopback. |
| Reporter loops itself via a Rust panic during URL build, spamming an infinite report chain | Denial of Service | Recursion guard via `threading.local()` (REPORT-08). Daily rate cap as outer bound (REPORT-06). |
| Audio file path inferred from the `last_error` stack contains sensitive content | Information Disclosure | `$HOME`-path redaction strips identifying parent dirs. Filename portion remains for debug value but no longer identifies the user. Audio file CONTENTS are never read by the reporter. |
| User clicks a phishing link claiming to be a GitHub issue URL | Tampering | The dialog displays the FULL URL in a copy-and-readable form before "Open in GitHub" is clicked. The URL is also visible in the user's browser address bar. Pattern matches Phase 1 Wave 2 Task 2 deeplink mitigation. |
| Malicious env var (e.g., `LD_PRELOAD` pointing to an attacker SO) appears in the payload | Information Disclosure | Env vars are NOT in the allow-list. The reporter never reads `os.environ` into the payload at all. |

### Local-first Invariant Check

- ✓ No required cloud calls. Reporter does NOT hit github.com from Python; only the user's browser does, only when the user clicks.
- ✓ App functional with reporting disabled (REPORT-12 default-OFF). The toggle controls whether the UI surfaces the button.
- ✓ No analytics ping, no telemetry endpoint, no third-party SDK.
- ✓ User owns the resulting issue on github.com — OmniVoice never holds a credential.

---

## Compounding Effect (Why This Phase Matters)

Phase 5 is the **support-scaling investment**. The Maintainer council member's framing was correct: every future bug arrives with full repro context. That converts maintainer-side debugging from a multi-message Discord thread ("what OS are you on?" "can you paste the error?") into a single look at a structured issue.

To validate the template before v0.3.0 ships, **dry-run it against at least 3 existing open issues** from the inbox. Pick 3 from different domains:

- A platform-specific install bug (e.g., #54 macOS Gatekeeper, #56 AppImage WebKit, #58 `pkg_resources`)
- An engine-specific bug (#42 IndexTTS clash, #48 WAV-export corruption)
- An auth/network bug (#35 HF token, #57/#60 mirror failure)

For each, ask: "if a user had filed THIS issue via the Phase 5 reporter, would the body have contained what we needed?" Add fields to the allow-list iteratively until the answer is yes for all three. Stop expanding the allow-list once incremental fields stop adding repro value — every field costs a redaction-layer audit and a privacy review.

This dry-run is itself a Wave 3 task; include it explicitly in the plan.

---

## CLAUDE.md Project Constraints

Extracted from `./CLAUDE.md` Capability 2 + PROJECT.md — must be honored by the plan:

- **Opt-in by definition.** Bug reporting OFF by default; user toggles ON in Settings → Privacy. (REPORT-12.)
- **Submit only to GitHub Issues** — no third-party telemetry endpoint, no Sentry DSN. (REPORT-02.)
- **App fully functional with reporting disabled.** No code path treats reporting as required. (REPORT-12.)
- **No required cloud calls.** Phase 5 introduces zero network calls from Python; the user's browser is the only network agent. (REPORT-02.)
- **No accounts, no API keys.** No PAT, no GitHub App, no OAuth flow. (REPORT-02, REQUIREMENTS.md Out of Scope.)
- **Captures only the listed fields.** OS name+version, Python version, OmniVoice version, backend git SHA, CPU/RAM, GPU vendor/model/VRAM, active TTS engine + list, frontend bun version + OS shell, last error + stack. (REPORT-03.)
- **Does NOT capture:** Audio file contents, paths containing `/Users/<name>/`, HF token, OpenAI keys, env vars matching `*TOKEN*|*KEY*|*SECRET*`. (REPORT-05.)
- **Opens via Tauri opener (not shell).** Phase 1 reference material says `shell.open()` — installed plugin is **`@tauri-apps/plugin-opener` `^2.5.4`**, use it. (Pitfall #2.)
- **Cross-platform parity** required (PROJECT.md Constraints) — every platform must support `openUrl()` (Tauri 2 opener does). Cross-platform smoke test extension mandatory.
- **Backward-compatible** — Phase 5 is additive; no existing user data or config is modified.
- **Beta release cadence** — small, frequent v0.3.x drops; Phase 5 plan should be deliverable in three internal waves within a single v0.3.0 release.

---

## Sources

### Primary (HIGH confidence)

- **CLAUDE.md Capability 2 — In-App Structured Bug Reporting** (project file, this repo) — canonical spec for Phase 5; defines transport pattern, capture list, redaction list, and what NOT to use.
- **PROJECT.md — Local-first guarantee preserved** (project file, this repo) — defines the constraints that force prefilled-URL pattern.
- **REQUIREMENTS.md REPORT-01..12** (project file, this repo) — the 12 enforceable requirements.
- **ROADMAP.md Phase 5** (project file, this repo) — success criteria.
- **`.planning/phases/01-…/01-RESEARCH.md` + `01-02-PLAN.md`** (project files, this repo) — the deeplink/error-UX infrastructure Phase 5 builds on; `backend/core/links.py` is the resolver, `errorDocsMap.ts` is the mirror, `ErrorBoundary.jsx` is the integration site.
- **`frontend/package.json` + `frontend/src-tauri/Cargo.toml`** (project files, this repo) — verified `@tauri-apps/plugin-opener@^2.5.4` and `tauri-plugin-opener = "2"` are installed.
- **`pyproject.toml`** (project files, this repo) — verified `psutil>=7.2.2`, `torch>=2.4`, `transformers>=5.3.0`, `setuptools>=75.0` are pinned.
- **`backend/main.py:347`** (project file) — verified `global_exception_handler` exists; Phase 5 extends it for last-error context.
- **`frontend/src/utils/consoleBuffer.js`** (project file) — verified ring buffer + `installConsoleCapture()` already capture React errors.
- **`frontend/src/components/ErrorBoundary.jsx`** (project file) — verified the component exists; Phase 5 adds a button next to Phase 1's deeplink button.
- **GitHub Docs: Creating an issue from a URL query** (`docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue`) — HIGH (official). Documents the `title`, `body`, `labels` URL params.
- **sindresorhus/new-github-issue-url** (`github.com/sindresorhus/new-github-issue-url`) — HIGH (canonical reference impl widely used by OSS projects; the URL-building pattern is identical regardless of language).

### Secondary (MEDIUM confidence)

- **Tauri 2 opener plugin docs** — opener is the supported path for `openUrl()` in Tauri 2.x. Verified via `Cargo.toml` + `package.json` presence.
- **Python `urllib.parse.urlencode` docs** — stdlib reference, well-known behavior for `quote_via=quote`.
- **`psutil` docs** — `cpu_count`, `virtual_memory` are stable surface; used for years across OmniVoice's dependency graph.

### Tertiary (LOW confidence — flagged for validation)

- **GitHub Issues prefilled URL body length cap of ~6 KB** — community consensus (sindresorhus/new-github-issue-url issues + GitHub Community threads), not officially documented. **Mitigation:** Hard-cap at 6 KB matches CLAUDE.md guidance; manual QA in rc1 confirms.
- **`tauri-plugin-opener` behavior parity across macOS/Windows/Linux for `https://` URLs** — assumed; verify via Phase 0 cross-platform smoke test extension.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every library is already installed and pinned in this repo.
- Architecture: HIGH — composition over existing primitives (Phase 1's `links.py`, existing `global_exception_handler`, existing `consoleBuffer.js`).
- Pitfalls: HIGH for Pitfalls #1-#7 (well-trodden territory); MEDIUM for #8 (depends on Phase 2's implementation choices).
- Security: HIGH — pattern is intrinsically safer than alternatives because it stores no credentials and makes no outbound network calls from the app.
- Compounding-effect rationale: HIGH — aligns with Maintainer council framing and with industry pattern (every OSS project I can name with a "report a bug" button uses this exact pattern for the same reason).

**Research date:** 2026-05-18
**Valid until:** 2026-06-18 (30 days — GitHub Issues URL surface and Tauri 2 opener plugin are stable; revisit before Phase 6 release if any Tauri 2.x major release lands in the window)
