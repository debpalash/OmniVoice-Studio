# Feature Research

**Domain:** Local-first OSS desktop AI app — stabilization & onboarding milestone
**Researched:** 2026-05-16
**Confidence:** HIGH (verified against official docs for HF / Sentry / GitHub; concrete IndexTTS issue inspected; pattern claims cross-verified across 2+ sources)

> Scope reminder: this milestone is **stabilization + onboarding** for a brownfield app (OmniVoice Studio v0.2.7). The five capabilities below are scoped against the project's hard constraints: **fully local-first, opt-in only telemetry, no required accounts, no mandatory cloud calls, cross-platform (macOS/Windows/Linux) parity**. Anything that violates those constraints is automatically an anti-feature regardless of how common it is in commercial apps.

## Capabilities In Scope

1. In-app crash / bug reporting (opt-in, GitHub Issues backend)
2. First-run installation + error-handling UX
3. Engine isolation / plugin compatibility (IndexTTS clash, #42)
4. Persistent secret / token UX (HF token, #35)
5. Docs-as-code patterns for cross-platform install instructions

---

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these = users complain in Discord / Issues. These are the "must ship or the milestone fails its own success bar."

| # | Capability | Feature | Why Expected | Complexity | Notes |
|---|-----------|---------|--------------|------------|-------|
| 1 | Bug reporting | **Off by default with explicit opt-in toggle in Settings** | Sentry's own desktop crash-reporter docs treat opt-in-unchecked as the default for stable builds; local-first audience is allergic to surprise reporters | LOW (hour) | One bool in prefs slice; one checkbox in Settings → Privacy |
| 1 | Bug reporting | **"Open prefilled GitHub issue" button (no token, no API)** as the v1 path | Zero-credential path: opens browser to `https://github.com/.../issues/new?template=bug_report.yml&body=...` with logs/system info URL-encoded. Pattern used by `new-github-issue-url` lib + many OSS apps | LOW (1-line config + hour) | Already have `tauri-plugin-opener`; just need URL builder. Cap body at ~6 KB (GitHub URL limit ~8 KB) |
| 1 | Bug reporting | **Pre-flight scrub of logs**: redact `HF_TOKEN`, file paths under `$HOME`, machine name | Users will paste logs publicly; we own the redaction. Sentry mobile docs explicitly warn that augmented context "may constitute PII" | MEDIUM (day) | Regex pass + path normalization; testable in isolation |
| 1 | Bug reporting | **"Last error" capture with system info** (OS, GPU, Python, app version, last 200 log lines) | Matches the existing CONTRIBUTING.md ask ("OS, GPU, and Python version… Error logs"). Right now users do this by hand; automating closes the Discord-support loop | LOW (hour) | Already exposed in Settings → Logs; just need a serializer |
| 2 | First-run UX | **Determinate progress indicator for model downloads** with step labels ("Downloading Whisper… 1.2 GB / 2.4 GB") | UX research: any task >10 s needs a determinate bar; uncertainty amplifies wait pain. 5-10 min Windows first-run is already the #1 confusion source | LOW (hour) — splash already exists | Splash today shows steps; just needs accurate byte progress per HF download |
| 2 | First-run UX | **Actionable error screens with copy-paste fix command** (e.g. `xattr -cr /Applications/OmniVoice\ Studio.app` for #54, `WEBKIT_DISABLE_COMPOSITING_MODE=1` for #56) | Discord traffic shows users will run commands when given exact strings. "Generic error → google it" loses users | LOW (hour each) | Map known error signatures → fix templates. Show "Copy command" + "Open docs" buttons |
| 2 | First-run UX | **"Skip / retry / continue without this" on optional step failures** | Audacity / OBS forums are full of "installer stopped, now what?" threads. Hard fail on optional engine ≠ hard fail on app | MEDIUM (day) | Splash bootstrap needs to distinguish required (Python, ffmpeg) from optional (engine X, HF token) |
| 3 | Engine isolation | **At minimum: graceful degradation when an engine's `is_available()` raises** | `tts_backend.py` already has `is_available()` per engine; #42 shows it fails on `ImportError` from a *different* engine's bad install. Existing engines must keep working even if one engine's deps clash | LOW (hour) | Wrap each `is_available()` call in try/except, log + mark engine "broken", continue boot |
| 3 | Engine isolation | **Per-engine install isolation docs** that survive `uv sync --all-extras` | #42: `uv sync --all-extras` clobbered the omnivoice lock with IndexTTS-only deps. Users following docs hit this. Docs must steer them to non-destructive install paths | LOW (hour) | Update engines page; recommend `uv pip install -e .` over `--all-extras`. Future: per-engine venv (see Differentiators) |
| 4 | Token UX | **Honor `HF_TOKEN` env var on every backend code path** | HF library already does this (`HF_TOKEN` overrides `$HF_TOKEN_PATH` file). We just need to never override it ourselves | LOW (config) | Audit backend for any hard-coded `huggingface_hub.login(...)` that ignores env |
| 4 | Token UX | **Settings UI field that writes through to HF cache file** (`~/.cache/huggingface/token`) — same place `huggingface-cli login` writes | This is the HF library's default; matches what every other HF-based tool expects. No new storage location to learn. Defaults to `$HF_HOME/token`; respects `HF_HOME` and `XDG_CACHE_HOME` | LOW (hour) | `huggingface_hub.login(token=...)` does this for you. Show last-4-chars only in UI |
| 4 | Token UX | **Per-platform shell snippet for permanent env var** in docs (zsh / bash / PowerShell / Windows GUI) | The #35 "Setup failed" thread shows users don't know how to set env vars permanently. Docs must give exact lines for `~/.zshrc`, `~/.bashrc`, `setx HF_TOKEN ...`, Linux `/etc/environment` | LOW (hour) | One docs page, four code blocks |
| 5 | Install docs | **Single canonical install page per platform** (macOS / Windows / Linux) covering happy path + 3 most common errors each | OBS install wiki and Audacity manual both follow this pattern; users want one URL per problem | LOW (hour each) | Move from README inline `<details>` to `docs/install/{mac,win,linux}.md` |
| 5 | Install docs | **Error message → docs URL mapping in the app itself** | Closes the loop: user hits error → app shows "Open troubleshooting" → docs page already exists. Anything else loses users to Discord | LOW (hour) | Map a handful of known error strings → URL slugs |

### Differentiators (Where OmniVoice Wins as the Local-First Option)

These are not required, but they directly reinforce the Core Value ("a first-run that actually works… everything is downstream of the thing installs and runs reliably") and the local-first brand promise. Each one would meaningfully differentiate OmniVoice from cloud TTS competitors *and* from other OSS desktop apps that didn't think about it.

| # | Capability | Feature | Value Proposition | Complexity | Notes |
|---|-----------|---------|-------------------|------------|-------|
| 1 | Bug reporting | **Local-only "diagnostic bundle" download** (.zip of redacted logs + system info) as an alternative to GitHub-issue submission | True local-first: user can inspect what would be sent before submitting *anywhere*. No competitor I found offers this. Solves GDPR-style "show me my data" without a backend | MEDIUM (day) | Re-uses the redaction + system-info code from table-stakes. Just write to disk instead of URL-encoding |
| 1 | Bug reporting | **"Authenticated submit"** via the user's *own* GitHub PAT, stored in OS keyring, posts to issues API with their identity (not ours) | Avoids OmniVoice ever holding a token that can write on user's behalf. Users own the issue, get notifications. Python `keyring` does macOS Keychain / Windows Credential Locker / SecretService transparently | MEDIUM (day) | Optional power-user path; default path stays the prefilled-URL one |
| 2 | First-run UX | **Bundled mirror fallback list for `uv venv` / model downloads** (try PyPI mirror → HF mirror → cn mirror) so #57/#60 (Russia/CIS network restrictions) work out of the box | This is rare among OSS desktop AI apps. Picks up an underserved user base (CIS, Iran, behind corporate proxy) | MEDIUM (day) | Config list in `pyproject.toml` extra; bootstrapper iterates on `uv venv --index-url …` failure |
| 2 | First-run UX | **"Health check" screen on every launch** that shows engine status, model status, disk space, GPU presence — and offers one-click fixes | Inspired by JetBrains "Recovery Mode" and VSCode's diagnostic walkthroughs. Turns Discord support into self-service | MEDIUM (day) | Builds on existing Settings → Logs; surfaces it at boot, not buried |
| 3 | Engine isolation | **Per-engine subprocess isolation** (each engine runs in its own venv, IPC over HTTP/grpc/stdio) | Validated pattern: see `isolated-environment` PyPI lib and Unsloth "studio backend" pattern. **Permanently solves #42-class issues** for IndexTTS / CosyVoice / future engines that need different `transformers` versions. Spawn via `mp.get_context("spawn")` for clean state | HIGH (multi-day) | Marked HIGH because it's an arch change to `TTSBackend`. Not table-stakes for this milestone — but the *direction*. Tag for next milestone if too big now |
| 3 | Engine isolation | **Engine "compatibility matrix" surfaced in Settings → TTS Engine** showing which engines coexist on the user's platform | Closes the "I installed engine X and Y stopped working" support loop. Reads directly from each engine's known-conflicts metadata | LOW (hour) | Static table in TTSBackend metadata; rendered in UI |
| 4 | Token UX | **OS keyring storage as the *primary* path** (Keychain / WinCred / SecretService), with env-var and file fallbacks | More secure than the HF default `~/.cache/huggingface/token` plaintext file. Other HF tools don't do this — would be a real differentiator. Python `keyring` lib handles all three OSes | MEDIUM (day) | Wrap so missing keyring backend (some Linux servers) falls back to HF default cleanly |
| 4 | Token UX | **Token-needed banner in the affected feature** ("Speaker diarization needs a HF token + license acceptance — [Set up now]") rather than a generic startup failure | Today: #35 users get cryptic failures. With this, the failing feature explains itself in context | LOW (hour) | Check token presence at feature entry, render an inline upsell |
| 5 | Install docs | **Single "diagnostic" doc page indexed by error string** — user pastes the error, lands on the fix | Doesn't exist in OBS / Audacity / most OSS apps; they organize by feature, not by symptom. SEO win + Discord-deflection win | MEDIUM (day) | Markdown table; can be generated from the error → URL mapping above |
| 5 | Install docs | **In-app docs viewer** (no browser round-trip) for the install / troubleshooting docs that ship with the app | Local-first ethos: docs work offline. Avoids stale-version mismatch between app and online docs | MEDIUM (day) | Render `docs/install/*.md` in a Tauri webview pane |

### Anti-Features (Do Not Build)

These are commonly requested or commercially common, but each one violates a constraint from PROJECT.md (local-first guarantee, no required cloud, no mandatory accounts, no scope creep into UI redesign).

| # | Capability | Anti-Feature | Why Requested | Why Problematic | Alternative |
|---|-----------|--------------|---------------|-----------------|-------------|
| 1 | Bug reporting | **Automatic, silent telemetry endpoint** (any third-party SaaS — Sentry, Bugsnag, PostHog, etc.) — even "anonymous" | "We need to know what's breaking in the wild" | Violates `## Constraints → Local-first guarantee preserved` explicitly ("submit only to GitHub Issues; no third-party telemetry endpoint"). Erodes the entire local-first brand promise the README markets. Sentry's own docs say opt-in-unchecked is best practice for stable builds | Opt-in **manual** submission to GitHub Issues only; users own the issue |
| 1 | Bug reporting | **A backend service that proxies / aggregates crash reports** for OmniVoice | "We can dedupe / triage server-side" | Same constraint violation + ongoing infra cost + a new attack surface storing user logs. Plus: the user base is small enough that raw GitHub Issues is fine for now | Use GitHub Issues directly; dedupe via labels & templates |
| 1 | Bug reporting | **OmniVoice-owned GitHub bot token** that posts issues on behalf of users | "Make submit one-click without users needing a PAT" | Creates spam vector (anyone can spam your tracker), needs rate-limiting + abuse handling, and links every issue to a single bot account so reporters can't be replied to | Prefilled-URL approach (browser-mediated, user submits with their own account, no token leaves the app) |
| 2 | First-run UX | **Mandatory account creation, login, or "welcome tour" before app is usable** | "We need to know who our users are" | Hard violation of "no accounts" constraint. JetBrains/VSCode both let you use the IDE without logging in; we should too | Settings → Privacy → opt-in "Tell us you exist (anonymous)" — *if* ever wanted, in a future milestone, behind a clear toggle |
| 2 | First-run UX | **Auto-update without consent** (silent background update, then restart) | "Users don't update; we need to push fixes" | PROJECT.md constraint matrix doesn't list auto-update as accepted; OSS-desktop norm is "notify, let user choose." Beta cadence (`v0.3.x` small frequent drops) means surprise restarts during a long dub job would lose work | "Update available" notification + manual click; never restart during an active job |
| 2 | First-run UX | **Full onboarding tour / first-run wizard with 5+ screens** | "Educate users on every feature" | PROJECT.md `## Out of Scope → Major UI/UX redesign` says no. Also: feature surface is large; a tour is stale immediately. Onboarding effort should go into making first-launch *just work*, not into explaining it | One actionable splash + Settings → Health Check (Differentiator above) |
| 3 | Engine isolation | **Force-uninstall conflicting engines** ("Installing IndexTTS detected, removing CosyVoice") | "Avoid the conflict by picking one" | Hard violation of `## Constraints → Existing engine compatibility` ("must not have to reinstall"). Punishes power users who want both | Subprocess isolation (Differentiator) or, as a stopgap, surface the conflict + recommend which to keep |
| 3 | Engine isolation | **Drop support for an engine to fix a conflict** (e.g. remove IndexTTS in 0.3.0 because #42 is hard) | "Reduce surface area, ship faster" | Direct breakage of installed users; OSS reputational hit. Also, the issue is genuinely fixable | Fix `is_available()` to fail safely (table stakes) + roadmap subprocess isolation (Differentiator) for next milestone |
| 4 | Token UX | **Ship the app with an embedded HF token** ("works out of the box, no signup") | "Save users a Discord question" | Violates HF ToS (token is per-user), token gets revoked, app silently breaks for everyone, no per-user rate limiting, security disaster if extracted from binary | Make optional features that require the token *explicitly call out* "requires HF token + free signup at huggingface.co" with a one-click setup flow |
| 4 | Token UX | **Store the token in `omnivoice_data/settings.json` as plaintext** | "Easier than keyring; no dependency" | Plaintext secret in a user's project folder; backed up to iCloud / OneDrive / Dropbox unintentionally. HF's own default (`~/.cache/huggingface/token`) is at least outside user-visible project trees | Use `huggingface_hub`'s default (the cache file) — table stakes — and add OS keyring as the primary path (differentiator) |
| 4 | Token UX | **In-app OAuth flow against huggingface.co** | "Slicker than copy-paste PAT" | HF doesn't offer a stable OAuth flow for arbitrary desktop clients; adds web-redirect complexity. PAT copy-paste is the industry norm (matches `huggingface-cli login`) | Keep the PAT copy-paste path; just make where to set it obvious and where to get one a one-click "Open token page" link |
| 5 | Install docs | **Auto-generated docs from code comments** (Sphinx / API-doc style) for the install guide | "Single source of truth, auto-updates" | Install docs are user-facing prose, not API reference; auto-gen produces unreadable wall-of-text and bury the actionable fix. README → markdown by hand is the OBS / Audacity standard | Hand-write `docs/install/{mac,win,linux}.md`; lint links in CI; that's it |
| 5 | Install docs | **A documentation site framework** (Docusaurus, MkDocs, Astro Starlight) for this milestone | "Looks more professional" | Scope creep — PROJECT.md `## Out of Scope → no new features beyond the issue list + the two explicit additions`. Plain Markdown in the repo renders fine on GitHub and ships with the app | Three install docs in `docs/install/`; defer doc-site to a later milestone if at all |

---

## Feature Dependencies

```
┌─ Error-capture infrastructure (system-info + redacted-logs serializer)
│       │
│       ├──used-by──> Auto-fill GitHub issue body (table-stakes)
│       ├──used-by──> Local diagnostic bundle (differentiator)
│       └──used-by──> Health Check screen (differentiator)
│
├─ Engine-status registry (each engine's is_available + last error)
│       │
│       ├──used-by──> Graceful degradation on engine import (table-stakes)
│       ├──used-by──> Compatibility matrix in Settings (differentiator)
│       └──used-by──> Health Check screen (differentiator)
│
├─ Error → docs URL map
│       │
│       ├──used-by──> Actionable error screens with fix commands (table-stakes)
│       ├──used-by──> Diagnostic-by-error-string docs page (differentiator)
│       └──used-by──> In-app docs viewer (differentiator)
│
├─ HF token storage abstraction (env > keyring > HF cache file)
│       │
│       ├──used-by──> Settings token field (table-stakes)
│       ├──used-by──> Token-needed banners in features (differentiator)
│       └──used-by──> Speaker-diarization setup fix (#35 sub)
│
└─ Subprocess engine runner (HIGH cost; defer if scope-tight)
        │
        └──unlocks──> Per-engine venvs that permanently fix #42-class conflicts
```

### Dependency Notes

- **Error-capture infrastructure is the foundational shared piece**. Build it once; three different surfaces (bug submit, local bundle, Health Check) read from it. Skipping it means duplicating system-info collection in three places.
- **Engine-status registry must come before any UI that lists engines.** Today `tts_backend.py` calls `is_available()` at boot; one bad engine taking down the boot path is the root cause of #42's UI silence. Fix the registry first; surface in UI second.
- **Error → docs URL map is the bridge** between in-app error UX (capability 2) and docs (capability 5). Both consume the same map; build it as a single config file, not two parallel structures.
- **HF token abstraction unblocks #35.** Diarization setup needs a token *and* a license-acceptance click on HF. Both need the same UX entry point (the token field), so don't ship them as two separate flows.
- **Subprocess engine isolation is the only *permanent* fix for #42.** The table-stakes graceful-degradation step is a workaround; the differentiator is the real fix. PROJECT.md scopes #42 as a stabilization issue, so the workaround alone counts as closed — but flag for next milestone explicitly.

---

## MVP Definition for This Milestone

The milestone's success bar (from PROJECT.md) is **close all 11 open issues + add Supertonic-3 + add opt-in bug reporting**. MVP = table-stakes only, plus the two explicit additions. Differentiators are stretch goals for the same milestone or seed for the next one.

### Must Ship (closes the issue list + the two additions)

- [ ] **Opt-in toggle + prefilled-GitHub-issue button** — closes the "add bug reporting" addition; LOW-MEDIUM, ~1 day
- [ ] **Log redaction pass** — prerequisite for safe bug-report submission; MEDIUM, ~1 day
- [ ] **Graceful engine-loading degradation** — closes #42 (workaround) and prevents future #42-class regressions; LOW, hours
- [ ] **HF token Settings field that writes the HF cache file** + per-platform env-var docs — closes #35 sub-issue; LOW, ~half day
- [ ] **Actionable error screens for #54 / #56** with copy-paste fix commands — closes those two via documented workarounds per PROJECT.md decision matrix; LOW, hours
- [ ] **`docs/install/{mac,win,linux}.md`** with happy path + top 3 errors each — closes the "installation tutorial" item; LOW-MEDIUM, ~1 day
- [ ] **HF token setup docs page** with zsh / bash / PowerShell / setx snippets — closes the "HF token setup guide" item; LOW, hours
- [ ] **CosyVoice install + troubleshooting doc** — closes #55 (and partial #35, #44); LOW-MEDIUM, ~half day
- [ ] **Determinate progress with byte counts in splash** — UX upgrade to existing splash; LOW, hours
- [ ] **Supertonic-3 engine adapter** — the other explicit addition, validated via the existing `TTSBackend` pattern (~50 lines per CONTRIBUTING.md)

### Stretch (in-milestone if time permits, otherwise next milestone)

- [ ] **Local diagnostic-bundle download** as alternative to GitHub submit — reinforces local-first brand, MEDIUM
- [ ] **Health Check screen at boot** — surfaces engine + model + token status, MEDIUM
- [ ] **Engine compatibility matrix in Settings** — reads from existing `is_available()`, LOW
- [ ] **Token-needed banner in diarization & gated-engine features** — better than cryptic startup failures, LOW
- [ ] **Mirror fallback for `uv venv`** — closes #57 / #60 properly (currently in PROJECT.md Wave 2), MEDIUM

### Defer to Next Milestone (Explicit)

- [ ] **Per-engine subprocess isolation** — the real fix for #42-class conflicts, HIGH (multi-day) arch change to `TTSBackend`. Tag as the next milestone's lead item.
- [ ] **OS keyring as primary token storage** — security upgrade, but HF cache file works fine for now; MEDIUM
- [ ] **In-app docs viewer** — nice, but offline-docs is a future-milestone aesthetic; MEDIUM
- [ ] **Diagnostic-by-error-string docs page** — needs ~10 errors documented before it's worth indexing; MEDIUM
- [ ] **Authenticated PAT-based submit** — only if users ask for it; MVP path is prefilled URL

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Opt-in toggle + prefilled-issue button | HIGH (delivers the explicit addition) | LOW | P1 |
| Log redaction | HIGH (privacy table-stakes for the addition) | MEDIUM | P1 |
| Graceful engine-loading degradation (#42) | HIGH (closes high-visibility bug) | LOW | P1 |
| HF token Settings field + env-var docs (#35) | HIGH (gates diarization + some engines) | LOW | P1 |
| Actionable error screens (#54 / #56) | HIGH (closes 2 issues via documented workaround) | LOW | P1 |
| `docs/install/{mac,win,linux}.md` | HIGH (drops Discord install volume — the stated goal) | LOW-MED | P1 |
| Determinate splash progress | MEDIUM (reduces confusion, not blocking) | LOW | P1 |
| Supertonic-3 engine | HIGH (explicit user request) | LOW (50-line adapter per CONTRIBUTING) | P1 |
| CosyVoice install / troubleshoot doc (#55) | HIGH (active issue) | LOW-MED | P1 |
| Local diagnostic-bundle download | MEDIUM (brand-reinforcing, not asked-for) | MEDIUM | P2 |
| Health Check screen | HIGH (long-term Discord deflection) | MEDIUM | P2 |
| Engine compatibility matrix in Settings | MEDIUM | LOW | P2 |
| Token-needed banner in features | MEDIUM | LOW | P2 |
| Mirror fallback for `uv venv` (#57/#60) | HIGH (unblocks geo-restricted users) | MEDIUM | P2 |
| Per-engine subprocess isolation | HIGH (permanent fix) | HIGH | P3 (defer) |
| OS keyring storage primary | LOW-MED (HF default works) | MEDIUM | P3 (defer) |
| Authenticated PAT-based submit | LOW (prefilled URL is fine) | MEDIUM | P3 (defer) |
| In-app docs viewer | LOW-MED | MEDIUM | P3 (defer) |

**Priority key:** P1 = must ship to meet milestone success bar; P2 = ship if time, otherwise next milestone; P3 = explicit defer, document the seam.

---

## Competitor / Reference App Analysis

| Capability | Reference Apps | What They Do | Our Approach |
|------------|---------------|--------------|--------------|
| Crash reporting | Sentry (`sentry-desktop-crash-reporter`), Mozilla / VSCode | Sentry's own desktop reporter takes consent before submitting; checkbox unchecked by default in stable builds. VSCode shows OS-level crash, then offers a "Send report" dialog | Opt-in checkbox in Settings; "Open prefilled GitHub issue" button on error screens; no SaaS endpoint |
| First-run UX | JetBrains Toolbox, VSCode, OBS | JetBrains: install via Toolbox handles env; first-launch wizard skippable. VSCode: minimal — opens to welcome tab, no blocking. OBS: post-install auto-configuration wizard with skip option | Skippable splash with determinate progress; actionable errors; defer multi-screen tour |
| Cross-platform install docs | OBS (wiki + flatpak/ubuntu official + community), Audacity (manual + support site) | Per-platform pages; clear "official vs community" distinction; FAQ-style install errors | One `docs/install/{platform}.md` each + error → docs URL map |
| Token persistence | huggingface-cli, gh CLI, npm | `huggingface-cli login` writes to `~/.cache/huggingface/token`; respects `HF_TOKEN` env var override. `gh auth login` uses OS keyring on macOS/Win, file fallback on Linux. npm: `~/.npmrc` plaintext (criticized) | Follow `huggingface-cli` convention for table-stakes; add keyring as differentiator |
| Plugin isolation | Blender, Krita-AI-Diffusion, Unsloth Studio | Blender 4.2+: subprocess-installed packages may be inaccessible (known issue). Krita-AI-Diffusion: ships its own venv to dodge Krita's bundled Python conflicts. Unsloth Studio backend: subprocess orchestration with spawn-method for clean state | Table-stakes: graceful degradation. Differentiator (defer): per-engine subprocess workers (Unsloth pattern) |

---

## Sources

### Bug reporting & crash UX
- [sentry-desktop-crash-reporter (GitHub)](https://github.com/getsentry/sentry-desktop-crash-reporter) — Sentry's own opt-in consent pattern for desktop
- [Self-Hosted Sentry — Sentry Developer Documentation](https://develop.sentry.dev/self-hosted/) — opt-in to remote beacon, settings to change at any time
- [GDPR Best Practices — Sentry](https://sentry.io/trust/privacy/gdpr-best-practices/) — opt-in consent for crash SDKs
- [Data Privacy for Mobile — Sentry](https://docs.sentry.io/security-legal-pii/security/mobile-privacy/) — PII warnings when augmenting context
- [new-github-issue-url (sindresorhus)](https://github.com/sindresorhus/new-github-issue-url) — pattern for prefilled GitHub issue URLs
- [Pre-populate issue forms HTTP supplied values — GitHub Community Discussion #15477](https://github.com/orgs/community/discussions/15477) — GitHub form prefill URL params
- [REST API endpoints for issues — GitHub Docs](https://docs.github.com/en/rest/issues) — authenticated submit path (PAT differentiator)

### First-run & installation UX
- [Desktop UX: A Few Software Installer Best Practices (Medium)](https://medium.com/@renfei1992/desktop-ux-software-installer-best-practices-6d6d7383dc98) — installation should be invisible/skippable
- [Designing Better Loading and Progress UX — Smart Interface Design Patterns](https://smart-interface-design-patterns.com/articles/designing-better-loading-progress-ux/) — uncertainty amplifies wait pain; determinate bars
- [Progress Tracker Design — UXPin](https://www.uxpin.com/studio/blog/design-progress-trackers/) — determinate indicators for >10 s tasks
- [JetBrains Remote Development Troubleshooting](https://www.jetbrains.com/help/idea/remote-development-troubleshooting.html) — recovery / diagnostic patterns
- [OBS Install Instructions (Wiki)](https://github.com/obsproject/obs-studio/wiki/install-instructions) — per-platform install doc structure

### Token / secret UX
- [Hugging Face Environment variables](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables) — `HF_HOME`, `HF_TOKEN`, `HF_TOKEN_PATH` semantics
- [huggingface_hub Login docs](https://huggingface.co/docs/huggingface_hub/main/en/package_reference/login) — file persistence at `$HF_HOME/token`
- [huggingface_hub constants.py (source)](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/constants.py) — verified defaults
- [keyring (PyPI)](https://pypi.org/project/keyring/) — cross-platform OS credential storage in Python
- [keyring docs](https://keyring.readthedocs.io/) — Keychain / WinCred / SecretService backends

### Engine isolation
- [Issue #42 — index-tts not compatible with omnivoice](https://github.com/debpalash/OmniVoice-Studio/issues/42) — concrete `transformers 5.3` vs `transformers <5` conflict
- [isolated-environment (GitHub)](https://github.com/zackees/isolated-environment) — "internal venv management to fix AI dependency hell"
- [Blender devtalk: 3rd party modules](https://devtalk.blender.org/t/can-3rd-party-modules-ex-scipy-be-installed-when-an-add-on-is-installed/9709) — subprocess install pattern in Blender
- [Krita AI venv discussion](https://krita-artists.org/t/venv-required-dependencies-to-run-krita-with-python-3-11-in-isolated-environment/83955) — isolated env to dodge bundled-Python conflicts
- [Python multiprocessing — Real Python](https://realpython.com/ref/stdlib/multiprocessing/) — `mp.get_context("spawn")` for clean process state

### Local-first principles
- [Local-first software (Ink & Switch essay)](https://www.inkandswitch.com/essay/local-first/) — canonical principles
- [Local-First Software (PDF) — Kleppmann](https://martin.kleppmann.com/papers/local-first.pdf) — formal version

### Project context (read at task start)
- `/Users/user4/Desktop/voice-design/OmniVoice/.planning/PROJECT.md` — Core Value, Constraints, milestone scope
- `/Users/user4/Desktop/voice-design/OmniVoice/README.md` — current feature surface, current install UX, known workaround details
- `/Users/user4/Desktop/voice-design/OmniVoice/CONTRIBUTING.md` — current contributor / bug-report flow

---
*Feature research for: OmniVoice Studio stabilization & onboarding milestone (v0.3.x)*
*Researched: 2026-05-16*
