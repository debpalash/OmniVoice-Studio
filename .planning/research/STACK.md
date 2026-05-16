# Stack Research

**Domain:** OmniVoice Studio v0.2.7 → v0.3.x stabilization milestone (brownfield Tauri + FastAPI + multi-engine TTS desktop app)
**Researched:** 2026-05-16
**Confidence:** HIGH for HF token, uv mirror, GitHub Issues API, Supertonic-3. MEDIUM for docs tooling (multiple valid choices).

> **Scope note.** This is **not** a stack overhaul. The existing stack (`torch`, `whisperx`, `pyannote`, `demucs`, `audioseal`, `kittentts`, `pyinstaller`, Tauri, React, `uv`) is correct and out of scope. This document specifies new libraries/patterns required by the 5 capabilities the milestone adds on top.

---

## Recommended Stack — Per Capability

### Capability 1 — HuggingFace Token Persistence (issue #35)

**Verdict: 1-line fix at the Python layer, plus a docs/UI surface.** No new library needed; use what `huggingface_hub` already ships.

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `huggingface_hub` (already pinned transitively by `transformers>=5.3.0`) | `≥1.12.x` (latest 2026) | Auth + cache + token storage | Canonical, used by every HF library already in the stack. `HfFolder` is **superseded** in v1.x by the higher-level `login()` / `auth_list()` / `auth_switch()` API. |
| `keyring` (Python) | `≥25.x` | Optional OS-keychain backing | Only adopt if a future hardening pass wants Keychain/Credential-Manager/SecretService. **Not recommended for this milestone** — adds a native dep (`dbus`, `pywin32`) per platform with no real security win over `0600` file storage in `HF_HOME`. |

**Canonical 2026 approach (per the official docs at `huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables`):**

Token resolution order at import time:
1. `HF_TOKEN` env var (highest priority — overwrites everything)
2. `$HF_TOKEN_PATH` file contents
3. `$HF_HOME/token` file contents (default `~/.cache/huggingface/token`)
4. Legacy `~/.huggingface/token` (auto-migrated to new path)

**Why "1-line fix":** `huggingface_hub.login(token=...)` already writes to `$HF_HOME/token`, which already survives reboots. The user-reported "doesn't persist across shell sessions" bug in #35 is almost certainly **not** about the file (the file is persistent) — it's about users who set `export HF_TOKEN=...` in a shell, and that env var dies with the shell. The fix is:

1. In OmniVoice's Settings panel, add a "HuggingFace token" input that calls `huggingface_hub.login(token=val, add_to_git_credential=False)`. That writes the file. Done.
2. The backend reads token via `HfFolder.get_token()` (still present in v1.x for backward compat) **or** `huggingface_hub.get_token()` (preferred new name).
3. **Do not** rely on `HF_TOKEN` env var as the persistence mechanism. Document env var as an *override*, not as the storage path.

**Shell env-var persistence (only needed for power-user docs, not the in-app fix):**

| Shell | One-liner to persist `HF_TOKEN` |
|-------|---------------------------------|
| macOS zsh (default since 10.15) | `echo 'export HF_TOKEN=hf_xxx' >> ~/.zshrc && source ~/.zshrc` |
| Linux bash | `echo 'export HF_TOKEN=hf_xxx' >> ~/.bashrc && source ~/.bashrc` |
| Windows PowerShell (user scope) | `[Environment]::SetEnvironmentVariable("HF_TOKEN","hf_xxx","User")` (new shells only) |
| Windows cmd | `setx HF_TOKEN "hf_xxx"` (user scope, new shells only) |

**Per the Microsoft `setx` docs:** "Variables set with setx are available in future command windows only, not in the current command window." That's the entire bug surface for Windows users — they `setx` and then check in the same terminal and see "not persisted."

**Recommendation:** Skip the env-var ceremony entirely. Write the token to `$HF_HOME/token` via the in-app Settings field; this works identically on all three OSes without touching shell config.

**Sources:**
- [HF environment variables docs](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables) — HIGH confidence (official, current)
- [HF authentication API docs](https://huggingface.co/docs/huggingface_hub/en/package_reference/authentication) — HIGH confidence
- [Microsoft `setx` docs](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/setx) — HIGH confidence

---

### Capability 2 — In-App Structured Bug Reporting (opt-in, GitHub Issues)

**Verdict: Build, don't buy.** Sentry/`sentry-tauri` are excellent but violate the "no third-party telemetry endpoint" constraint in PROJECT.md. Build a minimal reporter that targets `api.github.com` directly.

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| GitHub REST API `POST /repos/{owner}/{repo}/issues` | `2026-03-10` API version | Server-side issue creation | Official, stable. Requires auth. |
| **Prefilled-URL pattern** (`github.com/{owner}/{repo}/issues/new?title=…&body=…&labels=…`) | n/a | Zero-auth fallback | **This is the recommended primary path for v0.3.x.** No token needed, no GitHub App registration needed, user's browser opens with a prefilled form, they review and click Submit. They own the issue, the OSS project gets the report, and OmniVoice never holds a credential. |
| `gh-app-jwt` + GitHub App (Rust crate `octocrab` or Python `pygithub`) | only if we later want fully-automated submission | Programmatic posting under an app identity | **Defer to a later milestone.** Requires registering a public GitHub App, hosting a token-exchange endpoint, and managing rate-limit quotas — disproportionate for stabilization scope. |
| `platform`, `psutil`, `torch.cuda` (already in deps) | already pinned | Capture OS, CPU/GPU/VRAM info | No new deps. |
| `httpx` (already in `dev-dependencies`, promote to runtime if needed) | `≥0.28.1` | HTTP for the API call path (if/when we add auth) | Modern async-first, already used in test suite. |

**Recommended UX pattern (matches the local-first constraint):**

```
User clicks "Report a bug" in Settings
  ↓
Modal pops up:
  - Free-text "what happened" field
  - Checkboxes (all default ON, all toggleable):
    [✓] Include last 200 lines of backend log
    [✓] Include OS / Python / GPU / VRAM info
    [✓] Include OmniVoice version + git SHA
    [✓] Include list of installed TTS engines
    [ ] Include reproduction file (off by default — privacy)
  - Preview rendered Markdown of the issue body
  ↓
User clicks "Open in GitHub" → tauri::shell::open() launches
  https://github.com/debpalash/OmniVoice-Studio/issues/new?
    title=URI-encoded-title
    &body=URI-encoded-body
    &labels=auto-reported,bug
  ↓
User signs in to their own GitHub, clicks Submit. Done.
```

**Why this pattern wins:**
- ✓ No token storage in OmniVoice → no security surface
- ✓ Opt-in by definition (user has to click Submit on github.com)
- ✓ User owns the issue → can be replied to, edited, closed by them
- ✓ Zero infra cost — no proxy, no app, no rate-limit management
- ✓ Works identically on macOS / Windows / Linux via Tauri's `shell.open`
- ✓ Survives our project being forked (just change the URL)

**Per `sindresorhus/new-github-issue-url`:** This pattern is widely used (VS Code, Hyper, Insomnia all use it). URL length cap is ~8 KB after encoding — fine for log snippets, but log files >2 KB should be presented as a `<details>` block or trimmed.

**System-info capture (what to include in the prefilled body):**
- OS name + version (`platform.platform()`)
- Python version (`sys.version`)
- OmniVoice version (`pyproject.toml`)
- Backend git SHA (if installed from source) or installer build ID
- CPU model, RAM (`psutil.cpu_count()`, `psutil.virtual_memory()`)
- GPU vendor/model/VRAM (`torch.cuda.get_device_name()`, `torch.cuda.mem_get_info()`, MPS detect)
- Active TTS engine + list of installed engines
- Frontend: bun version, OS shell
- Last error message + stack trace if launched from an error toast

**What NOT to capture:**
- Audio file contents (privacy — reference samples may contain user's voice)
- File paths containing `/Users/<name>/` (strip home dir → `~/`)
- HF token, OpenAI keys, any env var matching `*TOKEN*|*KEY*|*SECRET*`

**Sources:**
- [GitHub URL query parameters for issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue#creating-an-issue-from-a-url-query) — HIGH confidence
- [sindresorhus/new-github-issue-url](https://github.com/sindresorhus/new-github-issue-url) — HIGH (widely used reference impl)
- [GitHub REST API: Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue) — HIGH confidence (for the future auto-submit path)
- [sentry-tauri](https://github.com/timfish/sentry-tauri) — reviewed, **rejected for milestone** due to local-first constraint

---

### Capability 3 — `uv venv` Mirror Fallback for Restricted Networks (issues #57, #60)

**Verdict: Real implementation — needs both env-var plumbing and `--python-preference` logic.** `uv` has no built-in fallback; we have to layer it ourselves in the desktop bootstrap.

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `uv` (already used) | `≥0.5.x` | Python+venv bootstrap | Existing dep. |
| `UV_PYTHON_INSTALL_MIRROR` env var | uv `0.4.x`+ | Override python-build-standalone download URL | **Official, current.** Replaces `https://github.com/astral-sh/python-build-standalone/releases/download/...` in download URL construction. No built-in fallback if mirror fails. |
| `UV_PYTHON_PREFERENCE=only-system` (or CLI flag `--python-preference only-system`) | uv `0.4.x`+ | Skip the python-build-standalone download entirely; use the user's system Python | **The reliable escape hatch** when no mirror works. Requires a compatible Python `>=3.11` to already be on PATH. |
| `UV_HTTP_TIMEOUT`, `UV_HTTP_CONNECT_TIMEOUT`, `UV_HTTP_RETRIES` | uv `0.4.x`+ | Tune retry behavior for flaky links | Defaults are 30s / 10s / 3 — bump to 120s / 30s / 5 for restricted networks. |

**Recommended fallback chain (implement in `scripts/desktop-prod.sh` and the Tauri bootstrap):**

```python
# Pseudocode for the bootstrap
MIRRORS = [
    None,  # try default GitHub CDN first (fastest for most users)
    "https://gh-proxy.com/https://github.com/astral-sh/python-build-standalone/releases/download",
    "https://ghfast.top/https://github.com/astral-sh/python-build-standalone/releases/download",
    "https://hub.gitmirror.com/https://github.com/astral-sh/python-build-standalone/releases/download",
]
for mirror in MIRRORS:
    env = os.environ.copy()
    if mirror:
        env["UV_PYTHON_INSTALL_MIRROR"] = mirror
    if try_uv_venv(env, timeout=120):
        return SUCCESS
# Final fallback: don't download Python at all
env["UV_PYTHON_PREFERENCE"] = "only-system"
return try_uv_venv(env, timeout=120)  # requires system Python ≥3.11
```

**Mirror URL pattern (from uv source):** `${UV_PYTHON_INSTALL_MIRROR}/20240713/cpython-3.12.4+20240713-aarch64-apple-darwin-install_only.tar.gz`. Any URL that can re-route a GitHub release path works — the gh-proxy / ghfast / gitmirror services all do exactly this URL rewriting.

**For PyPI itself** (separate concern — Russia and CIS users also hit slow PyPI):
- `UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple` (Tsinghua — fastest in China)
- `UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple` (Aliyun fallback)
- Russia: no major government-blessed PyPI mirror; users typically tunnel via VPN. Document this honestly rather than ship a broken default.

**RISK FLAG — engine compatibility:** Switching to `--python-preference only-system` means the user's *system* Python runs the backend. If their system Python is 3.10 or 3.13, our `requires-python = ">=3.11"` will fail with a confusing message. The bootstrap MUST check `python --version` before invoking `uv venv` with `only-system`, and surface a friendly error like "Please install Python 3.11 or 3.12 from python.org" with a link.

**Sources:**
- [uv environment variables reference](https://docs.astral.sh/uv/reference/environment/) — HIGH (official)
- [uv issue #5224 — python-build-standalone mirror support](https://github.com/astral-sh/uv/issues/5224) — HIGH (the feature was added)
- [uv issue #14187 — venv on Chinese network](https://github.com/astral-sh/uv/issues/14187) — HIGH (confirms real user pain, no built-in fallback)
- [uv python-versions concepts](https://github.com/astral-sh/uv/blob/main/docs/concepts/python-versions.md) — HIGH (documents `python-preference` semantics)
- [dautovri/mirrors-china](https://github.com/dautovri/mirrors-china) — MEDIUM (community-maintained mirror list; verify each URL still works before shipping)

---

### Capability 4 — Supertonic-3 TTS Engine

**Verdict: Real implementation but low-risk.** The `supertonic` PyPI package is small, MIT-licensed, and its deps are a strict subset of what OmniVoice already pulls in. No version clashes expected.

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `supertonic` (PyPI) | `1.2.3` (latest, May 15 2026) | Official Supertonic-3 inference SDK | Authoritative wrapper from Supertone Inc. Wraps the ONNX session orchestration so we don't have to. |
| `onnxruntime` | `≥1.17.x` (any recent) | ONNX inference runtime | Already a transitive dep of WhisperX (via CTranslate2 path is separate, but `onnxruntime` itself ships for kittentts and audioseal). Verify with `uv tree` after adding — should resolve cleanly. |
| `huggingface_hub` (already pinned) | `≥1.12.x` | Model weight download (~400 MB on first use) | Reuses existing HF token + cache infrastructure. The user's existing `HF_TOKEN` (Capability 1) works for the Supertonic model download too. |
| `numpy`, `soundfile` (already pinned) | already pinned | Audio I/O + array math | No new deps. |

**Inference API (per https://github.com/supertone-inc/supertonic):**

```python
from supertonic import TTS

tts = TTS(auto_download=True)  # downloads from HF on first call, uses HF_TOKEN if set
style = tts.get_voice_style(voice_name="M1")  # 10 voices: M1-M5, F1-F5
wav, duration = tts.synthesize(
    text="Hello world",
    lang="en",       # 31 languages + "na" for language-agnostic
    voice_style=style,
    total_steps=8,   # quality vs speed (5-12)
    speed=1.05,      # 0.7-2.0
)
tts.save_audio(wav, "out.wav")
```

**ONNX file structure (per `onnx-community/Supertonic-TTS-ONNX` model card):**
- `text_encoder.onnx`
- `latent_denoiser.onnx`
- `voice_decoder.onnx`
- 44.1 kHz sample rate, 24-dim latent, 128-dim style
- ~99M parameters total
- Tokenizer: `AutoTokenizer.from_pretrained(model_path)` — loads from `tokenizer.json` shipped with model

**TTSBackend subclass shape (matches existing pattern in `backend/services/tts_backend.py`):**

```python
class SupertonicBackend(TTSBackend):
    name = "supertonic-3"
    languages = ["en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es",
                 "et", "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv",
                 "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi"]
    supports_clone = True   # custom voice cloning is supported per model card
    supports_instruct = False  # no instruct/style prompting

    def __init__(self):
        from supertonic import TTS
        self._tts = TTS(auto_download=True)

    def synthesize(self, text, voice, lang="en", **kwargs):
        style = self._tts.get_voice_style(voice_name=voice or "M1")
        wav, _ = self._tts.synthesize(text=text, lang=lang, voice_style=style,
                                      total_steps=kwargs.get("steps", 8),
                                      speed=kwargs.get("speed", 1.0))
        return wav, 44100
```

**RISK FLAGS — engine compatibility:**

1. **`onnxruntime` GPU vs CPU duplication.** If a user has installed `onnxruntime-gpu` for a different engine, adding `supertonic` (which depends on the CPU `onnxruntime` wheel) will create a duplicate-installed-package warning. Mitigation: declare `onnxruntime` as an optional/marker-gated dep, or document the conflict and let users pick one.
2. **`transformers` not declared.** The PyPI deps list only `onnxruntime`, `numpy`, `soundfile`, `huggingface-hub`. **But** the model card's reference code uses `AutoTokenizer` (transformers). Either `supertonic` ships a vendored tokenizer or it imports `transformers` opportunistically. We already have `transformers>=5.3.0` pinned, so no risk for us — but flag this for the implementation phase so we don't accidentally remove transformers thinking it's only for WhisperX.
3. **OpenRAIL-M model license.** Model weights are OpenRAIL-M (not Apache/MIT). Same license posture as IndexTTS and CosyVoice — well within OmniVoice's "varies" engine license column. Just needs a row in the TTS Engines README table.
4. **Model download size.** ~400 MB on first use. Larger than KittenTTS (25-80 MB) but small vs OmniVoice's 2.4 GB. No special UI work needed beyond existing progress UI.

**Sources:**
- [Supertone/supertonic-3 model card](https://huggingface.co/Supertone/supertonic-3) — HIGH (official)
- [supertone-inc/supertonic GitHub](https://github.com/supertone-inc/supertonic) — HIGH (official)
- [supertonic PyPI page](https://pypi.org/project/supertonic/) — HIGH (`1.2.3` confirmed 2026-05-15)
- [onnx-community/Supertonic-TTS-ONNX](https://huggingface.co/onnx-community/Supertonic-TTS-ONNX) — HIGH (ONNX file structure details)

---

### Capability 5 — Cross-Platform Documentation Tooling

**Verdict: Stay in-repo with Markdown; defer a separate docs site.** The current state (`README.md` + `docs/*.md`) is *correct for v0.3.x*. The "stay-in-sync" problem is solved by **automated tests** of the installer paths, not by a fancier docs generator.

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Plain Markdown in `docs/` + GitHub-rendered (current state) | n/a | Install tutorial, troubleshooting | Zero new infra. Renders inline on GitHub for issue-replies. No build step to break. |
| Existing `scripts/smoke-test.sh` + Playwright `tests/` (already in `package.json`) | already pinned | Verify install paths actually work | **This is the real solution to "docs drift."** If smoke-test exercises the install path described in docs, docs that drift will break CI. |
| **Future** (defer): Astro Starlight | `≥0.30` | Standalone docs site at `docs.omnivoice.studio` | Adopt only when docs exceed ~20 markdown files and need search/versioning. Tauri, the framework OmniVoice already depends on, uses Starlight — well-traveled choice. Material for MkDocs entered maintenance mode in November 2025 per Docsio's 2026 review — **avoid** for new docs. |

**The actual "stay-in-sync" pattern (this is what other OSS desktop apps do):**

| Project | What they do |
|---------|--------------|
| **OBS Studio** | Docs at `obsproject.com/docs` (Sphinx, separate repo). Install paths in README, wiki for community-contributed. CI doesn't gate on docs drift. |
| **Audacity** | Manual at `manual.audacityteam.org` (MediaWiki). README is minimal. Install path = "use the installer." No automated sync. |
| **Tauri** | Docs at `v2.tauri.app` (Astro Starlight, separate repo `tauri-apps/tauri-docs`). README is minimal. Heavy reliance on community contributions and PR review. |
| **VS Code** | Docs at `code.visualstudio.com/docs` (separate repo, Markdown). README is minimal. Manual sync; docs team is staffed. |

**None of them** solve docs-drift with tooling — they solve it with **automated install-path tests** + **a clear docs ownership chain** (one person reviews docs PRs). For OmniVoice at this stage, the smoke-test-as-truth pattern is the right fit.

**Concrete recommendation for the milestone:**

1. **Single-source-of-truth: `docs/install/`** with three files: `macos.md`, `windows.md`, `linux.md`. README links to them.
2. **Each install doc starts with the exact command sequence** that the smoke-test runs.
3. **Smoke-test asserts that the command sequence in the doc matches the runnable script.** Use a small script in `scripts/validate-install-docs.py` that extracts code blocks from `docs/install/*.md` and diffs them against `scripts/desktop-prod.sh`. Fail CI if they diverge.
4. **Surface workarounds in the error UI** (already a milestone constraint for #54 and #56) — the error message should link to the doc page anchor, not just print a stack trace.

**Sources:**
- [Tauri docs (Astro Starlight)](https://github.com/tauri-apps/tauri-docs) — HIGH (reference for "if we ever move off README")
- [OBS Studio docs](https://docs.obsproject.com/) — HIGH (Sphinx, separate site reference)
- [Audacity Manual](https://manual.audacityteam.org/) — HIGH (MediaWiki reference)
- [Docsio: Material for MkDocs 2026 review (maintenance mode)](https://docsio.co/blog/mkdocs-material) — MEDIUM (third-party review, but signal aligns with project's own GitHub activity)
- [Docsio: Starlight 2026 review](https://docsio.co/blog/starlight-docs) — MEDIUM

---

## Installation

```bash
# No new Python dependencies needed for Capabilities 1, 2, 3, 5.
# Only Capability 4 adds a runtime dep:

uv add supertonic  # 1.2.3 as of 2026-05-15

# Verify no regressions:
uv tree | grep -E "(onnxruntime|transformers|huggingface)"
# Should show single versions of each; no duplicates.
```

No new JS/Tauri deps required. The bug-reporter modal is plain React + `@tauri-apps/api/shell` (already imported).

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| HF token via in-app Settings → `huggingface_hub.login()` | OS keyring via `keyring` package | Only if a security hardening milestone later demands OS-native credential storage. Not worth the cross-platform native-dep cost for v0.3.x. |
| Prefilled-URL GitHub Issues | GitHub App + device flow + authenticated POST | When milestone budget can afford registering a public GitHub App and hosting a token-exchange function. Defer. |
| Prefilled-URL GitHub Issues | Sentry / `sentry-tauri` | Never — violates the "no third-party telemetry endpoint" constraint in PROJECT.md. |
| `UV_PYTHON_INSTALL_MIRROR` chain + `only-system` fallback | Bundle Python in the Tauri installer | Adds ~30 MB to every installer for ~5% of users. Revisit if the bootstrap is still a top complaint in v0.4. |
| In-repo Markdown docs | Astro Starlight standalone site | When docs grow past ~20 pages and need full-text search. Tauri provides a precedent if/when we get there. |
| In-repo Markdown docs | MkDocs / Material for MkDocs | **Avoid** for new sites — Material for MkDocs is in maintenance mode as of Nov 2025. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `HfFolder.save_token()` directly | Older API; v1.x `login()` does the same plus git-credential integration and is the documented path | `huggingface_hub.login(token=val, add_to_git_credential=False)` |
| Setting `HF_TOKEN` via shell rc files as the *only* persistence mechanism | Different per OS, fragile, opaque to the user, breaks in installer-launched processes that don't source shell rc | Write to `$HF_HOME/token` via `login()`. Document env var as override only. |
| `setx` for HF token persistence | Doesn't propagate to current shell; common source of "I set it but it's empty" bug reports | `[Environment]::SetEnvironmentVariable(...,"User")` in PowerShell, or the in-app Settings field |
| PAT-based GitHub Issues posting from OmniVoice | Would require shipping or asking for a token; breaks local-first promise | Prefilled-URL pattern (user submits from their browser) |
| `sentry-tauri` for OmniVoice | Third-party telemetry endpoint — violates PROJECT.md constraint | Local-only `backend.log` rotation + opt-in prefilled-URL reporter |
| `hf_transfer` for downloads | Deprecated in favor of `hf-xet` per HF docs | Default `huggingface_hub` (uses `hf-xet` automatically when available) |
| `--python-preference managed` (default) without mirror config in restricted-network installers | Hits GitHub CDN, times out, user sees raw `uv` error | Configure `UV_PYTHON_INSTALL_MIRROR` + retry chain + `only-system` final fallback |
| Material for MkDocs as a *new* docs choice | Entered maintenance mode November 2025 | If docs site is eventually needed, use Astro Starlight (Tauri precedent) |

---

## Stack Patterns by Variant

**If user is on a restricted network (China/Russia/CIS):**
- Set `UV_PYTHON_INSTALL_MIRROR` to one of the gh-proxy URLs at install time
- Set `UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple` (China) or document VPN requirement (Russia)
- Fall back to `UV_PYTHON_PREFERENCE=only-system` if all mirrors fail
- Increase `UV_HTTP_TIMEOUT=120`, `UV_HTTP_RETRIES=5`

**If user wants to authenticate to HuggingFace:**
- Default path: in-app Settings field → `login()` → file at `$HF_HOME/token`
- Power-user path: `export HF_TOKEN=...` in shell rc (documented but not promoted)
- Both paths are read at HF library import time; env var wins on conflict

**If user wants to report a bug:**
- Default path: in-app "Report a bug" → prefilled GitHub Issues URL → user reviews + submits in browser
- All optional capture toggles default ON except "include reproduction file" (privacy)
- No path posts to any URL except `github.com/{owner}/{repo}/issues/new` (rendered locally as a URL, opened via `shell.open`)

**If user adds Supertonic-3 as an engine:**
- `uv add supertonic` → new TTSBackend subclass in `backend/services/tts_backend.py`
- Auto-detected and added to the engine picker in Settings
- ~400 MB model download on first synthesize call, cached in `$HF_HUB_CACHE`
- Existing IndexTTS/CosyVoice/etc. installs are untouched (no shared model weights)

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `supertonic@1.2.3` | `onnxruntime>=1.17`, `numpy>=1.24`, `huggingface_hub>=0.20` | All deps already satisfied transitively by current `pyproject.toml`. |
| `huggingface_hub>=1.12` | `transformers>=5.3.0` (current pin) | `HfFolder` retained as deprecated alias; `login()`/`get_token()` are the canonical APIs. |
| `uv>=0.5` | `UV_PYTHON_INSTALL_MIRROR`, `UV_PYTHON_PREFERENCE` | Both env vars stable since uv 0.4.x. |
| Tauri v2 + `@tauri-apps/api/shell` | `shell.open()` for the prefilled-URL pattern | Already in the desktop app; no new permission needed beyond what the existing "open external link" plugin grants. |

---

## Sources

- [Hugging Face Hub environment variables](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables) — HIGH (verified against v1.12.1 docs, current 2026)
- [Hugging Face Hub authentication API](https://huggingface.co/docs/huggingface_hub/en/package_reference/authentication) — HIGH (verified `login()` is the canonical 1.x API)
- [Microsoft `setx` reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/setx) — HIGH (confirms "current shell" gotcha)
- [PowerShell `about_Environment_Variables`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables) — HIGH
- [uv environment variables reference](https://docs.astral.sh/uv/reference/environment/) — HIGH (verified all mirror + retry env vars)
- [uv issue #5224 — python-build-standalone mirror](https://github.com/astral-sh/uv/issues/5224) — HIGH (feature shipped)
- [uv issue #14187 — venv on Chinese network](https://github.com/astral-sh/uv/issues/14187) — HIGH (confirms user pain, justifies fallback chain)
- [uv `python-preference` semantics](https://github.com/astral-sh/uv/blob/main/docs/concepts/python-versions.md) — HIGH
- [Supertone/supertonic-3 model card](https://huggingface.co/Supertone/supertonic-3) — HIGH (official, 99M params, 31 languages, OpenRAIL-M)
- [supertone-inc/supertonic GitHub](https://github.com/supertone-inc/supertonic) — HIGH (official inference API)
- [supertonic 1.2.3 on PyPI](https://pypi.org/project/supertonic/) — HIGH (released 2026-05-15, MIT code license)
- [onnx-community/Supertonic-TTS-ONNX](https://huggingface.co/onnx-community/Supertonic-TTS-ONNX) — HIGH (ONNX file structure)
- [GitHub Docs: Authenticating to the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api) — HIGH
- [GitHub Docs: Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) — HIGH (device flow reference)
- [sindresorhus/new-github-issue-url](https://github.com/sindresorhus/new-github-issue-url) — HIGH (canonical prefilled-URL reference impl)
- [sentry-tauri](https://github.com/timfish/sentry-tauri) — MEDIUM (reviewed, rejected on PROJECT.md constraint, not on quality)
- [dautovri/mirrors-china](https://github.com/dautovri/mirrors-china) — MEDIUM (community-maintained, verify URLs are still live before pinning in production)
- [Tauri 2 docs (Astro Starlight reference)](https://v2.tauri.app/) — HIGH (precedent for docs framework if we ever migrate)
- [Docsio: Material for MkDocs entered maintenance mode Nov 2025](https://docsio.co/blog/mkdocs-material) — MEDIUM (third-party review, but signal aligns with the project's own GitHub commit activity)

---
*Stack research for: OmniVoice Studio v0.3.x stabilization milestone*
*Researched: 2026-05-16*
