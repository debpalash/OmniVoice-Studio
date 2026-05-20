# Phase 1: Install + Token Persistence + Docs Scaffolding + Error UX — Research

**Researched:** 2026-05-18
**Domain:** Cross-platform installer, secrets persistence, docs tooling, error UX
**Confidence:** HIGH (all 8 dimensions backed by official docs and concrete code hooks in-tree)

---

## Summary

Phase 1 closes the highest-volume issues in the v0.3.x inbox (#35 HF token, #54 Gatekeeper, #56 AppImage, #58 `pkg_resources`, partial #55 CosyVoice docs, plus #76 .deb ffprobe and #80 Docker LAN) by combining four concerns into one phase: install (per-OS docs + bundler fixes), token persistence (3-source cascade with `huggingface_hub.login()` as the canonical write), docs scaffolding (split README + drift CI), and error UX (taxonomy → deeplink). The phase intentionally avoids two adjacent rabbit-holes — real macOS notarization (deferred to Phase 6 / v2 `SIGN-V2-01`) and OS keyring (deferred to v0.4 per STATE.md Key Decision #5) — and ships documented workarounds wired into the error UI instead.

The pre-vetted stack in CLAUDE.md (Capabilities 1, 3, 5) already approves `huggingface_hub>=1.12.x`, `uv>=0.5.x` env-var mirror chain, and in-repo Markdown docs. No new Python runtime dependencies are needed for this phase. The dominant risk is **drift**: the README is currently 600 lines and inlines install steps that have already diverged from `scripts/desktop-prod.sh` — `scripts/validate-install-docs.py` (INST-06) is the durable solution and must land in Wave 1, not Wave 2, or the new docs will rot before v0.3.0 ships.

**Primary recommendation:** Ship in three waves:
1. **Wave 1 — Token resolver + read-side fix.** Land `backend/services/token_resolver.py` (3-source cascade), patch `backend/api/routers/dub_core.py:540` to call `huggingface_hub.get_token()` (not bare `os.environ`), and add the logging filter (AUTH-05). Unblocks #35.
2. **Wave 2 — Docs split + drift CI + error-doc map.** Split README → `docs/install/{macos,windows,linux,docker}.md`, add `scripts/validate-install-docs.py`, ship `backend/core/error_docs_map.py` + frontend `errorDocsMap.ts`. Wire 4 documented-workaround classes (Gatekeeper, AppImage WebKit, missing `pkg_resources`, missing HF token) to deeplink buttons.
3. **Wave 3 — Bundler fixes.** AppImage `WEBKIT_DISABLE_COMPOSITING_MODE=1` in launcher, .deb ffprobe relocation to `/usr/lib/omnivoice-studio/bin/`, Docker LAN `window.location.host` fix.

---

## User Constraints (from CONTEXT.md)

> No CONTEXT.md was produced from a `/gsd:discuss-phase` for Phase 1. Treat the following as effective constraints, sourced from CLAUDE.md, STATE.md Key Decisions, and ROADMAP.md Phase 1 success criteria.

### Locked Decisions
1. **Three-source token cascade** (AUTH-01..06): App SQLite (encrypted) → `$HF_TOKEN` env → `~/.cache/huggingface/token`. NOT a separate file; NOT OS keyring (keyring deferred to v0.4 per STATE.md Key Decision #5).
2. **Documented-workaround closures count.** STATE.md Key Decision #7: `xattr -cr` (#54) and `WEBKIT_DISABLE_COMPOSITING_MODE=1` (#56) close their issues if surfaced in docs + error UI. Real fixes (notarization, upstream Tauri/WebKit) are out of scope for v0.3.x.
3. **No telemetry, no PAT, no third-party endpoint.** Error UX deeplinks open the user's browser to `docs/install/*.md` URLs only — no analytics ping.
4. **In-repo Markdown for docs.** Not MkDocs/Material (CLAUDE.md "What NOT to Use" — Material entered maintenance Nov 2025). Astro Starlight deferred past v0.3.
5. **Backward-compat with `omnivoice_data/`.** Token migration MUST NOT break users with an existing `~/.cache/huggingface/token` — read-only fallback is required.
6. **Cross-platform parity.** Every fix runs on macOS (Apple Silicon + Intel), Windows x64, Linux AppImage + .deb. No platform-only regressions.

### Claude's Discretion
- Wave ordering within the phase (subject to dependency: token resolver before logging filter; docs split before drift CI; error-doc map before deeplink buttons).
- Exact file paths for `backend/services/token_resolver.py` and `backend/services/settings_store.py` (proposed paths align with existing `backend/services/` convention).
- Whether AUTH-02's "encrypted column" uses AES-GCM via `cryptography` (already a transitive dep of `huggingface_hub`) or a simpler approach. Recommendation: `cryptography.fernet` with machine-ID-derived key — proven, no new dep.
- The exact list of 4 error classes wired to deeplinks (recommended: Gatekeeper / AppImage WebKit / missing pkg_resources / HF 401). Other known errors get a generic "Open troubleshooting docs" link.

### Deferred Ideas (OUT OF SCOPE)
- Real macOS code signing + notarization (v2 `SIGN-V2-01`, Phase 6 tracker)
- Windows code signing certificate (v2 `SIGN-V2-02`)
- OS keyring integration (v2 `AUTH-V2-01`)
- Auto-update (anti-feature)
- Custom HF download directory UI (#64 — deferred to v0.4; `HF_HUB_CACHE` env var is the v0.3 workaround)
- Astro Starlight / docs site migration
- Mirror cascade for `uv venv` Python downloads (that lives in **Phase 3** — INST-07..11). This phase only handles the documentation-side of restricted-network onboarding.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INST-01 | Add `setuptools` to `[project.dependencies]` for WhisperX `pkg_resources` on Py 3.12+ | DONE in PR #62 (pending merge). Verify after merge — no further research needed. |
| INST-02 | Split README install into `docs/install/{macos,windows,linux,docker}.md` | Section: Docs Scaffolding |
| INST-03 | macOS `xattr -cr` workaround in docs + surfaced in first-run-failure UI (closes #54) | Section: macOS Gatekeeper Interim |
| INST-04 | `WEBKIT_DISABLE_COMPOSITING_MODE=1` in docs + AppImage launcher (closes #56) | Section: AppImage WebKit |
| INST-05 | README badges use templated/dynamic version refs | Section: Docs Scaffolding |
| INST-06 | `scripts/validate-install-docs.py` — docs drift → CI red | Section: Docs Scaffolding |
| DOCS-01 | `docs/install/troubleshooting.md` covers top 10 install errors | Section: Docs Scaffolding |
| DOCS-02 | `backend/core/error_docs_map.py` + frontend `errorDocsMap.ts` → contextual deeplinks | Section: Error UX |
| DOCS-03 | `docs/engines/cosyvoice.md` (closes #55, partial #44) | Section: Docs Scaffolding |
| DOCS-04 | `docs/features/diarization.md` (closes #35 sub-issue) | Section: HF Token Persistence + Docs |
| DOCS-05 | `docs/setup/huggingface-token.md` | Section: HF Token Persistence |
| AUTH-01 | `backend/services/token_resolver.py` — 3-source cascade | Section: HF Token Persistence |
| AUTH-02 | App-stored tokens persist to SQLite, encrypted column | Section: HF Token Persistence |
| AUTH-03 | Settings → API Keys panel — 3 source rows + Active badge | Section: HF Token Persistence |
| AUTH-04 | Subprocess env-var injection of resolved token | Section: HF Token Persistence |
| AUTH-05 | Logging filter excludes HF token from logs / tracebacks | Section: HF Token Persistence |

> **Out-of-phase but in this brief:** Docker LAN (#80) and Ubuntu .deb ffprobe (#76) appear in the research brief but are not in the official 16-req list. Treating them as **scope bumps within Phase 1** since they are install-friction bugs that fit the phase theme. The planner should explicitly accept or reject these additions before scheduling.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HF token storage (App source) | Database (SQLite `settings`) | Backend service | App-source token is a per-user secret persisted across restarts; SQLite is already the project's settings store. |
| HF token storage (Env source) | OS shell environment | Backend (read-only) | `$HF_TOKEN` lives in user's shell; backend only reads. |
| HF token storage (HF CLI source) | OS filesystem (`~/.cache/huggingface/token`) | Backend (read-only) | Written by `huggingface-cli` outside OmniVoice. |
| Token resolution + 401 fallback | Backend service (`token_resolver.py`) | — | Pure Python; no UI logic. Consumed by any backend caller that needs a token. |
| Token attribution UI (Active badge) | Frontend (Settings panel) | Backend (resolver returns source) | Display-only; backend tells frontend which source won. |
| Subprocess env injection | Backend (engine launcher) | — | Engines run as Python subprocesses; parent injects `HF_TOKEN` into child env at spawn. |
| Logging filter | Backend (logging config) | — | Python `logging.Filter` subclass installed at app startup. |
| Error → docs URL map | Backend (`error_docs_map.py`) + Frontend (`errorDocsMap.ts`) | — | Both Python errors and React errors need the map; duplicate the lookup table in both languages (small, hand-maintained). |
| Deeplink open action | Frontend (Tauri shell plugin) | — | `@tauri-apps/plugin-shell` `open()` opens user's default browser. |
| Docs files | Repo (`docs/install/*.md`, `docs/engines/*.md`, etc.) | — | Pure Markdown, rendered on GitHub. |
| Docs drift CI | Repo (`scripts/validate-install-docs.py` + CI workflow) | — | Python script run as a GitHub Action; fails PR if `desktop-prod.sh` blocks diverge from `docs/install/*.md`. |
| Gatekeeper detection | Backend (startup probe via `xattr -p`) | Frontend (error toast + deeplink) | Backend detects quarantine attribute; frontend renders the workaround link. |
| AppImage WebKit conditional | Repo (AppImage `AppRun` shell script) | — | Shell wrapper sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` before exec. No Python involved. |
| .deb ffprobe path | Tauri bundler (`tauri.conf.json` `resources` / `externalBin`) | Backend (resolve path via `tauri::path::resource_dir()`) | Bundle artifact relocation; resolution at runtime. |
| Docker LAN URL | Frontend (`frontend/src/utils/media.js`) | — | Pure JS — replace hardcoded `localhost:3900` with `window.location.host`-derived URL. |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `huggingface_hub` | `≥1.12.x` (already pinned transitively by `transformers>=5.3.0`) [VERIFIED: CLAUDE.md pre-vetted, official docs] | Auth + token storage + cache | Canonical 1.x API: `login()`, `get_token()`, `logout()`. `HfFolder.save_token()` is the deprecated path. |
| `cryptography` (transitive) | `≥41` [ASSUMED — verify in lockfile] | AES-GCM / Fernet for SQLite column encryption (AUTH-02) | Already transitively pinned by `huggingface_hub` / `requests` chain. `cryptography.fernet.Fernet` is the simplest correct API. |
| SQLite (built-in via `sqlite3` stdlib) | Py stdlib | Settings store | Already used by the project (`init_db()`, alembic). No new dep. |
| `@tauri-apps/plugin-shell` | `^2.x` (Tauri 2 — already on stack) [CITED: tauri docs] | `open()` external URLs from error UI | Already installed for "open external link" elsewhere; no new permission required. |
| GitHub-Flavored Markdown | n/a | All docs files | Renders on GitHub inline for issue replies; zero build step. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pytest` + `pytest-asyncio` | already pinned | Token-resolver + log-filter unit tests | All new backend code in this phase. |
| GitHub Actions `actions/setup-python` | `v5` [CITED: actions docs] | Run `scripts/validate-install-docs.py` in CI | Wave 2 — wired into existing `ci.yml`. |
| `python-frontmatter` or hand-parse | n/a | If docs need YAML frontmatter for version templating | INST-05 — likely a 5-line regex; no new dep needed. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `huggingface_hub.login()` writing to `$HF_HOME/token` | `keyring` package | Adds native deps per OS (`dbus`/`pywin32`); v0.4 work per STATE.md Key Decision #5. |
| `cryptography.fernet` | `cryptography.hazmat.primitives.AEAD` (raw AES-GCM) | Fernet is opinionated/safe; raw AES-GCM is more flexible but easy to misuse. Pick Fernet for v0.3. |
| `errorDocsMap.ts` duplicated in TS + Py | Generate TS from Py at build time | Build-step complexity > the cost of maintaining a 10-entry map in two places. Defer codegen. |
| Tauri shell plugin | `window.open()` directly | Tauri's WebKit sandboxes `window.open()`; the shell plugin is the supported path. |

**Installation:** No new Python dependencies. All capabilities reuse existing transitive deps.

**Version verification:**
```bash
# Confirm huggingface_hub version available in the locked env:
uv pip list | grep -i huggingface_hub        # expect >= 1.12.x
uv pip list | grep -i cryptography           # expect >= 41
```

---

## Package Legitimacy Audit

| Package | Registry | Disposition |
|---------|----------|-------------|
| `huggingface_hub` | PyPI — 12+ yrs, billions of downloads, github.com/huggingface/huggingface_hub | Approved (pre-vetted in CLAUDE.md Capability 1) |
| `cryptography` | PyPI — PyCA, defacto-standard, pyca/cryptography | Approved (already transitive) |
| `@tauri-apps/plugin-shell` | npm — Tauri-owned, tauri-apps/plugins-workspace | Approved (already in `package.json`) |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

*No new packages are introduced in Phase 1. slopcheck run on the existing transitive set is the responsibility of Phase 0's CI matrix, not this phase.*

---

## Architecture Patterns

### System Architecture Diagram

```
                                ┌─────────────────────────────┐
                                │   User shell environment    │
                                │   ($HF_TOKEN, ~/.cache/...) │
                                └──────────────┬──────────────┘
                                               │ read-only
                ┌──────────────────────────────▼──────────────────────────────┐
                │           backend/services/token_resolver.py                 │
                │   resolve() → (token, source, username)                      │
                │   sources: 1) SQLite settings (encrypted)                    │
                │            2) os.environ["HF_TOKEN"]                         │
                │            3) huggingface_hub.get_token()                    │
                │   on_401(): retry next source, update active marker          │
                └──┬───────────────────────────────────────────────┬──────────┘
                   │ (token, source)                                │ writes via
                   │                                                │ login()
   ┌───────────────▼───────────────┐              ┌─────────────────▼───────────────┐
   │   dub_core.py:540 (FIXED)     │              │   Settings → API Keys panel    │
   │   diarization gate            │              │   (frontend)                    │
   │   uses resolver, not          │              │   shows 3 rows + Active badge   │
   │   bare os.environ             │              │   Save calls resolver + login() │
   └───────────────────────────────┘              └─────────────────────────────────┘
                   │                                                │
                   │ token injected into                            │
                   │ engine subprocess env                          │
   ┌───────────────▼───────────────┐                                │
   │   IndexTTS / pyannote /       │                                │
   │   any HF-aware engine         │                                │
   └───────────────────────────────┘                                │
                                                                    │
   ┌────────────────────────────────────────────────────────────────▼──────────┐
   │                       Logging filter (AUTH-05)                            │
   │   intercepts every LogRecord; redacts any string matching `hf_[A-Za-z…]`  │
   └───────────────────────────────────────────────────────────────────────────┘

                                ─── Error UX path ───

   ┌────────────────────┐    classify    ┌─────────────────────────┐    open    ┌──────────────────────────┐
   │ Python / Rust /    ├───────────────►│ error_docs_map.py       ├───────────►│ Tauri shell.open()       │
   │ React error event  │   error class  │ + frontend errorDocsMap │   docs URL │ → user's default browser │
   │                    │                │                         │            │ → docs/install/*.md      │
   └────────────────────┘                └─────────────────────────┘            └──────────────────────────┘
```

### Recommended Project Structure
```
backend/
├── services/
│   ├── token_resolver.py        # AUTH-01 (NEW)
│   └── settings_store.py        # AUTH-02 (NEW) — SQLite + encrypted column
├── core/
│   ├── error_docs_map.py        # DOCS-02 (NEW) — error class → docs URL
│   └── logging_filter.py        # AUTH-05 (NEW) — strip hf_* tokens from log records
└── api/routers/
    └── dub_core.py              # PATCH line 540 — use resolver, not os.environ

frontend/src/
├── utils/
│   ├── errorDocsMap.ts          # DOCS-02 mirror (NEW)
│   └── media.js                 # PATCH line 20 — window.location.host
└── components/
    ├── ErrorToast.tsx            # Wire "Open docs for this error" button
    └── settings/
        └── ApiKeysPanel.tsx     # AUTH-03 (NEW)

docs/
├── install/
│   ├── macos.md                 # INST-02 (NEW) — split from README
│   ├── windows.md               # INST-02 (NEW)
│   ├── linux.md                 # INST-02 (NEW)
│   ├── docker.md                # INST-02 (NEW)
│   └── troubleshooting.md       # DOCS-01 (NEW)
├── engines/
│   └── cosyvoice.md             # DOCS-03 (NEW)
├── features/
│   └── diarization.md           # DOCS-04 (NEW)
└── setup/
    └── huggingface-token.md     # DOCS-05 (NEW)

scripts/
└── validate-install-docs.py     # INST-06 (NEW)

frontend/src-tauri/
└── tauri.conf.json              # PATCH bundle.linux.deb — relocate ffprobe to /usr/lib/omnivoice-studio/bin/

# AppImage AppRun launcher
deploy/                          # or wherever the AppImage assets live — verify in tree
└── AppRun                       # PATCH — bake WEBKIT_DISABLE_COMPOSITING_MODE=1
```

### Pattern 1: 3-Source Token Cascade (AUTH-01)
**What:** Resolve token from App → Env → HF CLI, with on-401 fallback.
**When to use:** Every backend call that needs an HF token.
**Example:**
```python
# Source: huggingface_hub authentication docs — https://huggingface.co/docs/huggingface_hub/en/package_reference/authentication
# backend/services/token_resolver.py
from dataclasses import dataclass
from typing import Literal, Optional
import os
import huggingface_hub

from backend.services import settings_store

Source = Literal["app", "env", "hf-cli"]

@dataclass
class ResolvedToken:
    token: str
    source: Source
    username: Optional[str]   # whoami username, or None if not validated

def _sources_in_priority_order() -> list[tuple[Source, Optional[str]]]:
    return [
        ("app",    settings_store.get_hf_token()),                   # encrypted SQLite column
        ("env",    os.environ.get("HF_TOKEN")),
        ("hf-cli", huggingface_hub.get_token()),                     # reads ~/.cache/huggingface/token
    ]

def resolve(skip: set[Source] = frozenset()) -> Optional[ResolvedToken]:
    for source, tok in _sources_in_priority_order():
        if source in skip or not tok:
            continue
        try:
            user = huggingface_hub.whoami(token=tok)["name"]
            return ResolvedToken(token=tok, source=source, username=user)
        except huggingface_hub.errors.HfHubHTTPError:
            continue
    return None

def on_401(active_source: Source) -> Optional[ResolvedToken]:
    """Auto-retry with the next source after a 401 mid-download (AUTH-06)."""
    return resolve(skip={active_source})
```

### Pattern 2: Canonical Write via `login()` (AUTH-03)
**What:** Settings → API Keys "Save" writes to BOTH the SQLite App store AND `~/.cache/huggingface/token` via `login()`.
**Why:** Defensive — never let the App store be the single point of failure. Power users running `huggingface-cli` from a terminal continue to see their token. Per CLAUDE.md "What NOT to Use": avoid `HfFolder.save_token()`; use `login()`.
**Example:**
```python
# backend/services/token_resolver.py (continued)
def save_app_token(token: str) -> None:
    """Save to App store AND populate ~/.cache/huggingface/token defensively."""
    settings_store.set_hf_token(token)
    huggingface_hub.login(token=token, add_to_git_credential=False, new_session=False)
```

### Pattern 3: Subprocess Token Injection (AUTH-04)
**What:** Engines that run as Python subprocesses inherit `HF_TOKEN` in their env, populated by the resolver — they never re-read SQLite.
**Example:**
```python
# In whatever spawns engine subprocesses (Phase 2 will formalize as SubprocessBackend):
import subprocess
from backend.services.token_resolver import resolve

resolved = resolve()
env = os.environ.copy()
if resolved:
    env["HF_TOKEN"] = resolved.token
subprocess.Popen(["python", "-m", "engine.indextts"], env=env)
```

### Pattern 4: Logging Filter (AUTH-05)
**What:** A `logging.Filter` subclass installed at app startup. Redacts any string matching `hf_[A-Za-z0-9]{30,}` in record `msg` and `args`.
**Example:**
```python
# backend/core/logging_filter.py
import logging
import re

_HF_TOKEN_RE = re.compile(r"hf_[A-Za-z0-9]{30,}")

class HFTokenRedactor(logging.Filter):
    REDACTED = "hf_***REDACTED***"
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = _HF_TOKEN_RE.sub(self.REDACTED, record.msg)
        if record.args:
            record.args = tuple(
                _HF_TOKEN_RE.sub(self.REDACTED, a) if isinstance(a, str) else a
                for a in record.args
            )
        return True
```
Install once at backend startup: `logging.getLogger().addFilter(HFTokenRedactor())`. Same filter is applied to any custom traceback formatter — exception text is funneled through `format_exception` then through the redactor before bug-report payloads are built (Phase 5 reuses this).

### Pattern 5: Error → Docs Deeplink (DOCS-02)
**What:** Each backend exception that maps to a documented workaround carries an `error_class` attribute (or is matched by exception type). Frontend renders a button that opens the docs URL via Tauri shell plugin.
**Example:**
```python
# backend/core/error_docs_map.py
ERROR_DOCS = {
    "GATEKEEPER_QUARANTINE":     "https://github.com/<owner>/<repo>/blob/main/docs/install/macos.md#gatekeeper-quarantine",
    "APPIMAGE_WEBKIT_WHITESCREEN":"https://github.com/<owner>/<repo>/blob/main/docs/install/linux.md#appimage-white-screen-on-fedora-44--ubuntu-2404",
    "PKG_RESOURCES_MISSING":      "https://github.com/<owner>/<repo>/blob/main/docs/install/troubleshooting.md#pkg_resources-missing",
    "HF_AUTH_FAILED":             "https://github.com/<owner>/<repo>/blob/main/docs/setup/huggingface-token.md",
}
DEFAULT_DOCS = "https://github.com/<owner>/<repo>/blob/main/docs/install/troubleshooting.md"
```
```typescript
// frontend/src/utils/errorDocsMap.ts — mirror of the Python map; small enough to hand-maintain
import { open } from "@tauri-apps/plugin-shell";

export const ERROR_DOCS: Record<string, string> = {
  GATEKEEPER_QUARANTINE: "https://github.com/<owner>/<repo>/blob/main/docs/install/macos.md#gatekeeper-quarantine",
  // ...
};
export function openDocsFor(errorClass: string) {
  return open(ERROR_DOCS[errorClass] ?? "https://github.com/<owner>/<repo>/blob/main/docs/install/troubleshooting.md");
}
```

### Anti-Patterns to Avoid
- **`HfFolder.save_token()`** — deprecated in `huggingface_hub` 1.x. Use `login()`.
- **`setx HF_TOKEN ...` as the recommended Windows path** — value doesn't propagate to the current shell; biggest source of "I set it but it's empty" support tickets per CLAUDE.md.
- **Storing the token plaintext in SQLite** — must be encrypted (AUTH-02).
- **Embedding `<owner>/<repo>` URLs as a string template in code** — read once from `pyproject.toml` (or a small `backend/core/links.py` constant) so a fork can change it in one place.
- **Bundling a Python `keyring` dep** — STATE.md Key Decision #5 defers to v0.4; the native dep cost is real per CLAUDE.md.
- **Auto-running `xattr -cr` from within the app** — won't work; the app is itself quarantined. The workaround must be a Terminal command the user runs OR documented in the first-launch failure UI before Tauri ever starts. INST-03's "surfaced in the app's first-run-failure UI" is the install-time failure page rendered by `bootstrap.rs` (Rust) when Tauri itself fails to start — not a React component. Verify implementation site in `frontend/src-tauri/src/bootstrap.rs` during planning.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Reading `~/.cache/huggingface/token` | `open(Path.home() / ".cache" / "huggingface" / "token")` | `huggingface_hub.get_token()` | Handles `HF_HOME` override, Windows path, file-mode checks, future schema changes. |
| Writing token to disk | hand-roll `open(..., "w", 0o600)` | `huggingface_hub.login(token=…, add_to_git_credential=False)` | Sets correct mode, handles git-credential helper, posts a `whoami` validation. |
| `whoami` HTTP call | `requests.get("https://huggingface.co/api/whoami-v2", headers=…)` | `huggingface_hub.whoami(token=…)` | Cached, error-typed, retries baked in. |
| AES-GCM/Fernet token encryption | manual `cryptography.hazmat.primitives.AEAD` | `cryptography.fernet.Fernet` | Fernet is the safe-by-default opinionated API. Key derivation via `cryptography.hazmat.primitives.kdf.scrypt` from a machine-ID. |
| Markdown rendering for docs | Sphinx / MkDocs / Docusaurus | GitHub-rendered Markdown | Zero build step, renders inline on GitHub for issue replies. CLAUDE.md "Avoid Material for MkDocs" (maintenance mode Nov 2025). |
| Docs drift detection | Eyeballing READMEs at release time | `scripts/validate-install-docs.py` — extract `bash` code blocks from `docs/install/*.md`, diff against `scripts/desktop-prod.sh` | CI catches regression at PR time. |
| `xattr -p com.apple.quarantine` parsing | `subprocess.run(["xattr", "-p", …])` and parsing | `xattr -l` exit code check (0 = has attr) | The boolean "is the .app quarantined?" is all the workaround logic needs. |
| Tauri external URL open | window.open / fetch | `@tauri-apps/plugin-shell` `open()` | Tauri's WebKit sandboxes window.open; the plugin is the supported path. |

**Key insight:** Every "deceptively complex" problem in this phase (token storage, encryption, whoami validation, Markdown rendering, AppImage white-screen) has a one-line correct answer using an existing dep. The risk is reinventing them. Lean hard on `huggingface_hub.login()` / `get_token()` / `whoami()` / `logout()` as the single seam.

---

## Runtime State Inventory

> Phase 1 is largely greenfield + bundler tweaks, but the token-resolver refactor touches users who have already set `$HF_TOKEN` or run `huggingface-cli login`. Inventory below.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | (a) Existing `~/.cache/huggingface/token` files for users who ran `huggingface-cli login`. (b) Pre-existing `omnivoice_data/` SQLite from v0.2.x — may or may not have a `settings` table. | (a) **None** — `huggingface_hub.get_token()` reads it as source #3. Read-only. (b) Add SQLite migration via `init_db()` or alembic to add `settings` table + encrypted `hf_token` column. Existing rows untouched. |
| Live service config | None. Phase 1 introduces no external services. | None. |
| OS-registered state | (a) macOS quarantine xattr on the .app — set by Gatekeeper. (b) `HF_TOKEN` in user shell rc — set by user. | (a) Detect via `xattr -l` at install-time failure UI; surface `xattr -cr` workaround. Do NOT auto-remove. (b) **None** — env var is source #2; we read it, never write it. |
| Secrets/env vars | `HF_TOKEN`. Code rename impact: existing references to `os.environ.get("HF_TOKEN")` (e.g., `dub_core.py:540`) must be replaced with `token_resolver.resolve()` calls. Env-var name itself unchanged. | Audit all `os.environ.get("HF_TOKEN")` call sites; replace with resolver. Grep target: `os.environ.*HF_TOKEN` and `os.getenv.*HF_TOKEN` across `backend/`. |
| Build artifacts | Tauri `.deb` from prior releases bundles `ffprobe` at `/usr/bin/ffprobe` — overwrites the user's system ffprobe. Per #76 we relocate to `/usr/lib/omnivoice-studio/bin/ffprobe`. Older `.deb` installs leave the file in `/usr/bin/`; new install should clean up via `postrm` script OR conflict file path. | Add `dpkg`/`debian` preinst or postinst script that removes the old `/usr/bin/ffprobe` only if its `dpkg --search` shows OmniVoice ownership (don't blow away unrelated ffprobe binaries). Document in CHANGELOG. |

**Nothing found in category — Live service config:** verified by code review (no external services consumed in Phase 1; HF Hub is HTTP-only, not a project-registered service).

---

## Common Pitfalls

### Pitfall 1: `dub_core.py:540` uses bare `os.environ` (the original #35 bug)
**What goes wrong:** A user runs `huggingface-cli login`, sees their token in `~/.cache/huggingface/token`, but OmniVoice's diarization gate still says "no HF_TOKEN is set" because it only checks `os.environ.get("HF_TOKEN")`.
**Why it happens:** `huggingface_hub` library calls (e.g., `pipeline.from_pretrained(...)`) auto-read the token from any source; bare `os.environ` checks do not.
**How to avoid:** Replace the line with a `token_resolver.resolve()` call. If `resolve()` returns None, the original "no token set" message stands. If it returns a token, the diarization path should never have been gated.
**Warning signs:** Any future code that wants to *check whether* a token exists must use `token_resolver.resolve()`, never `os.environ.get("HF_TOKEN")`.
**Code hook:** `/Users/user4/Desktop/voice-design/OmniVoice/backend/api/routers/dub_core.py:540`.

### Pitfall 2: `huggingface_hub.login()` overwrites cache without warning
**What goes wrong:** User runs `huggingface-cli login` with Token A, then enters Token B in OmniVoice Settings → Save. Without `add_to_git_credential=False`, `login()` ALSO calls `git credential approve` for `huggingface.co` — surprising for users on shared machines.
**Why it happens:** `login()`'s default is `add_to_git_credential=True`.
**How to avoid:** Always pass `add_to_git_credential=False` from OmniVoice — already in CLAUDE.md Capability 1.
**Warning signs:** Code review on `Settings → Save` action.

### Pitfall 3: AppImage `WEBKIT_DISABLE_COMPOSITING_MODE=1` applied unconditionally degrades good systems
**What goes wrong:** The workaround works around a specific WebKit version range. Setting it on systems with a fixed WebKit hurts rendering performance.
**Why it happens:** Issue #56's workaround was a blanket "always set it."
**How to avoid:** Detect WebKit version via `pkg-config --modversion webkit2gtk-4.1` (or `pkg-config --modversion javascriptcoregtk-4.1`) inside the AppRun script before launching the binary; only export when version is in the broken range. Per CLAUDE.md and INST-04: "applied conditionally by the AppImage launcher when WebKit version matches the broken range."
**Warning signs:** No new issues filed about black-screen flicker after we ship the launcher fix.
**Implementation hook:** AppImage `AppRun` shell script (a Bash launcher). Confirm path during planning — likely `deploy/` or generated by `cargo-tauri` bundler.

### Pitfall 4: Validate-install-docs flake on `>` shell prompts or trailing whitespace
**What goes wrong:** The validator extracts code blocks; one of them differs from `desktop-prod.sh` by a trailing newline or a `$` prompt prefix in the docs. CI goes red on docs PRs that have no functional change.
**How to avoid:** Strip leading `$ ` / `>>> ` from docs blocks, normalize trailing whitespace, normalize CRLF→LF before diff. Tag blocks with a fenced-info comment (`<!-- validate: skip -->`) for examples that intentionally diverge (e.g., illustrative output).
**Warning signs:** Docs-only PRs that fail the validator with no obvious diff.

### Pitfall 5: `cryptography.fernet` key derivation from machine ID
**What goes wrong:** If the machine ID is naive (`socket.gethostname()`), the key is reproducible across machines for users named "MacBook-Pro" or "DESKTOP-XXX". A stolen `omnivoice_data/` SQLite is decryptable.
**How to avoid:** Derive from a stable machine identifier — on macOS `ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/...'`; on Linux `/etc/machine-id`; on Windows `reg query "HKLM\SOFTWARE\Microsoft\Cryptography" /v MachineGuid`. Combine with a per-install random salt stored in the same SQLite (separate row, also via `cryptography.fernet` but with key-derivation function `scrypt`).
**Warning signs:** Pen-test review at Phase 6.
**Limitations to flag in docs:** Anyone with **read access to the same user account on the same machine** can decrypt — this is local-secrecy-at-rest, not theft-resistant. Document this honestly in `docs/setup/huggingface-token.md`. STATE.md Key Decision #5 explicitly defers OS keyring for proper key isolation to v0.4.

### Pitfall 6: Docker LAN — replacing `localhost:3900` everywhere
**What goes wrong:** `frontend/src/utils/media.js:20` has `_PREVIEW_API = import.meta.env.VITE_OMNIVOICE_API || 'http://localhost:3900'`. Replacing with `window.location.host` fixes LAN access — but other call sites (WebSocket URLs, health check pings, engine status polls) may have the same hardcoded `localhost`.
**How to avoid:** Grep for `localhost:3900` and `127.0.0.1:3900` across `frontend/src/`. Centralize the API base in `frontend/src/utils/apiBase.ts` returning `window.location.protocol + "//" + window.location.host` when running in browser context, `http://localhost:3900` when running inside Tauri (because Tauri serves the React bundle from a `tauri://localhost` origin that can't be reached by a LAN browser). Behavior depends on context.
**Warning signs:** Docker container reachable from LAN, but media preview still 404s.
**Code hook:** `/Users/user4/Desktop/voice-design/OmniVoice/frontend/src/utils/media.js:20`.

### Pitfall 7: `.deb` ffprobe relocation breaks PATH-dependent invocations
**What goes wrong:** Relocating from `/usr/bin/ffprobe` to `/usr/lib/omnivoice-studio/bin/ffprobe` means anything that called `ffprobe` via PATH (assuming OmniVoice's bundled one) now silently uses the system ffprobe — which may be a different version.
**How to avoid:** Inside OmniVoice's Python code, always invoke ffprobe via an explicit path resolved from `tauri::path::resource_dir()` (Rust side) passed to the backend at spawn time as `OMNIVOICE_FFPROBE_PATH` env var. The relocation itself is the right move (avoids overwriting the user's system binary, which is the original #76 bug). Document in `docs/install/linux.md`.
**Warning signs:** Audio probe errors only on Linux after the .deb update.
**Code hook:** `/Users/user4/Desktop/voice-design/OmniVoice/frontend/src-tauri/tauri.conf.json` — `bundle.linux.deb.files` / `externalBin`.

### Pitfall 8: Documented-workaround closures regress
**What goes wrong:** We "close" #54 via docs + UI, then a Tauri update changes the error path and the deeplink button never appears.
**How to avoid:** Add a smoke test (or extend `scripts/validate-install-docs.py`) that confirms the `error_docs_map.py` keys are referenced from at least one backend exception and one frontend toast. CI fails if a documented workaround's button is unreachable from code.
**Warning signs:** None until users start reporting "the error message has no link."

---

## Code Examples

### Reading the resolver result in `dub_core.py:540`
```python
# backend/api/routers/dub_core.py — REPLACE the bare os.environ check
# Before:
#     if not os.environ.get("HF_TOKEN"):
# After:
from backend.services import token_resolver

resolved = token_resolver.resolve()
if not resolved:
    reason = (
        "Speaker diarization is disabled because no HuggingFace token is available. "
        "Set one in Settings → API Keys (App), or export HF_TOKEN in your shell, "
        "or run `huggingface-cli login`. Then accept the "
        "pyannote/speaker-diarization-3.1 license at huggingface.co. "
        "Falling back to a silence-gap heuristic."
    )
else:
    # token-found path — pipeline returned None for a different reason
    reason = (
        f"Speaker diarization model failed to load (HF token source: {resolved.source}, "
        f"user: {resolved.username}) — see backend logs for details. "
        "Falling back to the silence-gap heuristic."
    )
```

### Settings → API Keys panel (frontend skeleton)
```typescript
// frontend/src/components/settings/ApiKeysPanel.tsx
// Sources: huggingface_hub authentication docs — three-source cascade per AUTH-01/-03
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SourceState = {
  source: "app" | "env" | "hf-cli";
  set: boolean;
  masked: string | null;   // e.g., "hf_…3jw"
  whoami_user: string | null;
  whoami_ok: boolean;
};

export function ApiKeysPanel() {
  const [sources, setSources] = useState<SourceState[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ sources: SourceState[]; active: string }>("hf_token_state").then(s => {
      setSources(s.sources);
      setActive(s.active);
    });
  }, []);

  return (
    <section>
      {sources.map(s => (
        <Row key={s.source} state={s} isActive={active === s.source} />
      ))}
      {/* Save button calls invoke("save_hf_token", { token }) — backend writes to App store + login() */}
    </section>
  );
}
```

### AppRun launcher conditional (INST-04)
```bash
#!/usr/bin/env bash
# AppImage AppRun — bake WEBKIT_DISABLE_COMPOSITING_MODE=1 conditionally
set -euo pipefail
HERE="$(dirname -- "$(readlink -f -- "$0")")"

# Detect WebKit version (best-effort; default to enabling workaround on Fedora 44/Ubuntu 24.04)
if command -v pkg-config >/dev/null 2>&1; then
  WK_VERSION="$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || echo "0.0")"
else
  WK_VERSION="0.0"
fi

# Apply workaround for broken-range or unknown WebKit (safer to apply on Fedora 44/Ubuntu 24.04)
case "$WK_VERSION" in
  2.44.*|2.46.*|0.0)
    export WEBKIT_DISABLE_COMPOSITING_MODE=1
    ;;
esac

exec "${HERE}/usr/bin/omnivoice-studio" "$@"
```

### validate-install-docs.py skeleton (INST-06)
```python
#!/usr/bin/env python3
"""Extract code blocks from docs/install/*.md and diff against scripts/desktop-prod.sh.
Fails CI if a block tagged <!-- validate --> diverges from the canonical script."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs" / "install"
CANONICAL = (ROOT / "scripts" / "desktop-prod.sh").read_text().splitlines()

BLOCK_RE = re.compile(r"<!--\s*validate\s*-->\s*```(?:bash|sh)\n(.*?)```", re.DOTALL)

def normalize(line: str) -> str:
    return line.removeprefix("$ ").rstrip()

def check(md_file: Path) -> list[str]:
    errors = []
    text = md_file.read_text()
    for block in BLOCK_RE.findall(text):
        block_lines = [normalize(ln) for ln in block.strip().splitlines()]
        canonical_set = {normalize(ln) for ln in CANONICAL}
        for bl in block_lines:
            if bl and not bl.startswith("#") and bl not in canonical_set:
                errors.append(f"{md_file.name}: '{bl}' not found in desktop-prod.sh")
    return errors

if __name__ == "__main__":
    all_errors = [e for f in DOCS.glob("*.md") for e in check(f)]
    if all_errors:
        print("\n".join(all_errors), file=sys.stderr)
        sys.exit(1)
    print(f"OK — {len(list(DOCS.glob('*.md')))} install docs validated")
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `HfFolder.save_token(tok)` | `huggingface_hub.login(token=tok, add_to_git_credential=False)` | `huggingface_hub` 1.0 (2025) | Use new API; old name still works as deprecated alias. |
| `hf_transfer` for accelerated downloads | `hf-xet` (now default in `huggingface_hub` when available) | huggingface_hub 1.x | No code change needed in this phase; just don't add `hf_transfer` to deps. |
| Material for MkDocs | Astro Starlight (for future docs site) or in-repo Markdown (for now) | Material entered maintenance Nov 2025 | Stay on in-repo Markdown for v0.3; revisit Starlight at v0.4 if docs exceed ~20 files. |
| `setx HF_TOKEN` for Windows persistence | `[Environment]::SetEnvironmentVariable("HF_TOKEN", "...", "User")` in PowerShell | Long-standing; surfaced in CLAUDE.md as a gotcha | `setx` doesn't propagate to current shell — common support ticket. |

**Deprecated/outdated:**
- `HfFolder.save_token()`: deprecated alias for `login()`.
- `hf_transfer`: superseded by `hf-xet`.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `cryptography` is already in the locked dep set transitively via `huggingface_hub`/`requests` | Standard Stack | If not transitively pinned, add to `[project.dependencies]`. Verify with `uv pip list \| grep cryptography` before merging AUTH-02. |
| A2 | The 4-class taxonomy (Gatekeeper / AppImage WebKit / pkg_resources / HF 401) covers the bulk of in-app errors users see | Error UX | If a 5th high-frequency class emerges in Discord/issue triage, add it to the map. Map is data-driven — adding entries is cheap. |
| A3 | `init_db()` is the project's current schema-bootstrap path; alembic adoption is post-v0.3 | Runtime State Inventory | If alembic already manages settings table, write a real migration instead of an `init_db()` patch. |
| A4 | `frontend/src/utils/media.js` is the ONLY hardcoded-localhost site that breaks Docker LAN | Pitfall 6 | Likely false. Plan must include a `git grep -nE '(localhost\|127\.0\.0\.1):3900' frontend/src` step to surface all sites. |
| A5 | The .app's first-launch-failure UI is a Tauri-rendered Rust failure page (not a React component, since Tauri itself has failed to start under quarantine) | Anti-Patterns | If Tauri starts but with a degraded surface, the deeplink could be a React toast. Confirm in `frontend/src-tauri/src/bootstrap.rs` during planning. |
| A6 | Existing `huggingface-cli login` users' tokens stored at `~/.cache/huggingface/token` will be read transparently by `huggingface_hub.get_token()` | Runtime State Inventory | If a user has `HF_HOME` set to a non-default path, `get_token()` honors it correctly per docs. No action. |
| A7 | The `<owner>/<repo>` GitHub URL referenced in error_docs_map should be `OmniVoice/OmniVoice-Studio` or similar — the planner must confirm the canonical org+repo string before encoding | Code Examples | If hardcoded wrong, all deeplinks 404. Read from `pyproject.toml.project.urls.Repository` at startup. |
| A8 | AppImage assets live in `deploy/` or are generated by `cargo-tauri` bundler at build time — exact `AppRun` location TBD | Code Examples | If AppRun is auto-generated by Tauri bundler, the conditional must be injected via `tauri.conf.json` `bundle.linux.appimage.bundleMediaFramework` or a post-build script. Verify with `cargo-tauri` docs during planning. |

---

## Open Questions (RESOLVED)

> All 5 open questions from initial research were resolved during planning. RESOLVED annotations added 2026-05-18 in revision pass 1 (checker W-6). Each points to the plan + task that locked the decision.

1. **Where does `AppRun` actually live in this tree?** I couldn't find a `deploy/AppRun` or `frontend/src-tauri/*.AppImage*` artifact. The Tauri AppImage bundler typically generates AppRun at build time; conditional logic may need to be injected via `tauri.conf.json` `bundle.linux.appimage` or a `before-bundle` hook.
   - Recommendation: planner verifies via `cargo tauri build --bundles appimage --verbose` once, inspects generated artifact, decides between "patch generated AppRun" vs "use a custom AppRun template."
   - **RESOLVED:** Plan 01-03 Task 1 owns this — a 30-minute spike runs `cargo tauri build --bundles appimage --verbose`, inspects the generated AppRun, and records the chosen strategy in `.planning/decisions/apprun-strategy.md`. Then ships `frontend/src-tauri/appimage/AppRun` with a sourceable `_detect_webkit_workaround` function and a shell unit test (`AppRun.test.sh`) covering 4 cases per checker W-1.

2. **Does the project already have a `settings` SQLite table?** `backend/core/job_store.py` exists; not clear if a separate `settings` table is in scope or if we add it via `init_db()`.
   - Recommendation: planner reads `backend/core/job_store.py` and confirms schema. If `settings` exists, AUTH-02 is a column addition. If not, it's a table addition.
   - **RESOLVED:** Plan 01-01 Task 1 — confirmed no `settings` table exists today. Adds the table via alembic migration `0001_phase1_settings_table.py` (real migration, not `init_db()` patch, because `alembic.ini` + `backend/migrations/` are already in the tree). `_BASE_SCHEMA` in `backend/core/db.py` ALSO defines the table guarded by `CREATE TABLE IF NOT EXISTS` for fresh-install convergence. Tests cover upgrade-on-v0.2.7-fixture-DB.

3. **What is the canonical GitHub org+repo for docs URLs?** Code examples placeholder `<owner>/<repo>` — needs concrete value.
   - Recommendation: read from `pyproject.toml` `[project.urls]` at runtime in `error_docs_map.py`, fall back to hardcoded value.
   - **RESOLVED:** Plan 01-02 Task 2 (per checker B-6 reassignment from Plan 01-01) — `backend/core/links.py` reads `frontend/src-tauri/tauri.conf.json` `plugins.updater.endpoints[0]` FIRST (preferred — points to the desktop app fork `github.com/debpalash/OmniVoice-Studio`), falls back to `pyproject.toml [project.urls].Repository` (which currently points to the upstream model repo `k2-fsa/OmniVoice` — wrong target for docs deeplinks, hence the precedence inversion). Tested via `tests/backend/core/test_links.py`.

4. **Is `huggingface_hub.whoami()` synchronous or do we need an async wrapper?** Resolver `resolve()` calls it once per source; on app startup with 3 sources set, that's up to 3 network calls.
   - Recommendation: cache the resolver result for 5 minutes; expose `invalidate()` for "Test now" button. Don't call `whoami()` synchronously on every backend request.
   - **RESOLVED:** Plan 01-01 Task 2 — `token_resolver.resolve()` caches result for 300 seconds keyed by `(source, sha256(token))`. `invalidate()` exposed for the Settings → API Keys "Test now" button. `save_app_token()` and `clear_app_token()` invalidate the cache on every write. The 3 network calls on first cold-start are accepted (one-time cost).

5. **Does the AUTH-02 encryption need to survive an `omnivoice_data/` migration to a different machine?** A user backing up `omnivoice_data/` and restoring on a new machine would lose the App token if the key is machine-derived.
   - Recommendation: document that App tokens don't migrate across machines — user re-enters once. Env-var and HF-CLI sources cover the power-user migration path.
   - **RESOLVED:** Plan 01-01 Task 1 + Plan 01-02 Task 1 Step 9 — `settings_store.get_hf_token()` catches `InvalidToken` from Fernet (the symptom of a machine-id mismatch after cross-machine restore), logs a warning, returns `None`. Caller falls through to env-var / HF-CLI sources naturally. Limitation documented in `docs/setup/huggingface-token.md` under "Setting via the app (recommended)" subsection. Power users use the env-var or HF-CLI source for cross-machine portability.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `huggingface_hub` Python | Token resolver + `login()` + `whoami()` | ✓ (transitive via `transformers`) | ≥1.12.x [VERIFIED: CLAUDE.md] | None needed — required. |
| `cryptography` Python | SQLite token encryption (AUTH-02) | ✓ (transitive — A1) | ≥41 [ASSUMED A1] | Add to `[project.dependencies]` if not transitively present. |
| `@tauri-apps/plugin-shell` | Open docs URLs from error UI | ✓ (already in `package.json` per CLAUDE.md "shell.open" reference) | ^2.x | None needed. |
| `xattr` CLI (macOS) | Detect Gatekeeper quarantine | ✓ (macOS stdlib since 10.4) | — | Use Python `xattr` package as cross-version fallback. |
| `pkg-config` (Linux, build host) | Detect WebKit version in AppRun | ✓ on most distros | — | If absent at AppImage build time, AppRun defaults to "enable workaround." |
| `dpkg` (Linux, install host) | .deb postrm cleanup of old ffprobe path | ✓ on Debian-family | — | — |
| Python ≥ 3.11 (target) | Token resolver + log filter | ✓ (project min) | 3.11+ | None — already the project floor. |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.

---

## Validation Architecture

> `.planning/config.json` was not inspected for this research. Treat `workflow.nyquist_validation` as enabled (default). Phase 0 (Gates) establishes the actual CI matrix; this section enumerates Phase 1's contribution to it.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `pytest` (already pinned in `pyproject.toml` dev deps) + `vitest` for frontend (verify in `package.json`) |
| Config file | `pyproject.toml` `[tool.pytest.ini_options]` + `vitest.config.ts` (if frontend tests exist; otherwise Wave 0) |
| Quick run command | `uv run pytest tests/backend/services/test_token_resolver.py -x` |
| Full suite command | `uv run pytest -x` (backend) + `bun test --filter="errorDocsMap"` (frontend, scope TBD) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-01 | Resolver returns highest-priority valid source | unit | `uv run pytest tests/backend/services/test_token_resolver.py::test_resolve_priority -x` | ❌ Wave 0 (new test file) |
| AUTH-01 | Resolver skips invalid (401) source, returns next | unit | `…::test_resolve_skips_401 -x` | ❌ Wave 0 |
| AUTH-02 | App-stored token round-trips through SQLite encryption | unit | `…/test_settings_store.py::test_token_roundtrip -x` | ❌ Wave 0 |
| AUTH-03 | Save action writes to both App store AND `huggingface_hub.login()` | unit | `…/test_token_resolver.py::test_save_writes_both -x` | ❌ Wave 0 |
| AUTH-04 | Subprocess spawn receives `HF_TOKEN` in env | integration | `tests/backend/test_engine_spawn.py::test_hf_token_injected -x` | ❌ Wave 0 |
| AUTH-05 | Logging filter redacts `hf_*` from records | unit | `tests/backend/core/test_logging_filter.py -x` | ❌ Wave 0 |
| AUTH-06 | On 401 during use, resolver falls back to next source | integration | `…/test_token_resolver.py::test_on_401_cascade -x` | ❌ Wave 0 |
| INST-03 | `xattr -l` detection function returns True on quarantined file | unit | `tests/backend/test_gatekeeper_detect.py -x` | ❌ Wave 0 |
| INST-06 | `validate-install-docs.py` returns non-zero on drift | unit | `python scripts/validate-install-docs.py` (runs as its own CI step) | ❌ Wave 0 |
| INST-04 | AppRun launcher sets env var when WebKit in broken range | manual / smoke | Wave 3 — exercised via Phase 0 release.yml AppImage smoke test | manual-only |
| INST-03 (UI) | First-launch-failure UI deeplink opens correct URL | manual | Manual click-through on each platform during rc1 (Phase 6) | manual-only |
| DOCS-02 | Frontend error toast renders deeplink button when error class is in map | component | `bun test errorDocsMap` (or Storybook equivalent) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** Quick run command for the touched module (e.g., `pytest tests/backend/services/test_token_resolver.py -x`).
- **Per wave merge:** Full backend suite + frontend lint + `python scripts/validate-install-docs.py`.
- **Phase gate:** Full suite green + manual click-through on 3 platforms (macOS, Windows, Linux AppImage) before `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] `tests/backend/services/test_token_resolver.py` — covers AUTH-01, AUTH-03, AUTH-06
- [ ] `tests/backend/services/test_settings_store.py` — covers AUTH-02
- [ ] `tests/backend/core/test_logging_filter.py` — covers AUTH-05
- [ ] `tests/backend/test_engine_spawn.py` (or extend existing) — covers AUTH-04
- [ ] `tests/backend/test_gatekeeper_detect.py` — covers INST-03 (backend half)
- [ ] `tests/frontend/utils/errorDocsMap.test.ts` (or vitest-equivalent) — covers DOCS-02
- [ ] CI step in `ci.yml`: `python scripts/validate-install-docs.py` — covers INST-06
- [ ] Shared fixture: a "mock HF API server" or `respx`-based `whoami` stub for resolver tests
- [ ] Framework install (if frontend test infra missing): verify `vitest` or equivalent is configured

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | HF token stored encrypted (AUTH-02); never logged (AUTH-05); not embedded in binary or bug reports (per project constraints). |
| V3 Session Management | no | No app sessions — single-user local app. |
| V4 Access Control | partial | Loopback origin check on `/system/set-env` already shipped (quick task 260518-ivy, commit `e1f08a6`). Any new backend endpoint for `save_hf_token` MUST enforce the same loopback check. |
| V5 Input Validation | yes | Token format validated (`hf_` prefix, length ≥ 30); HF API URL pinned; mirror cascade is allow-list only (Phase 3 — out of scope for Phase 1). |
| V6 Cryptography | yes | `cryptography.fernet` for column encryption; machine-ID-derived key with per-install salt; never hand-roll AES-GCM. |
| V7 Errors & Logging | yes | Logging filter strips `hf_*` from records (AUTH-05); same filter feeds the Phase 5 bug-report payload. |
| V8 Data Protection | partial | Token at rest is encrypted in SQLite; in memory it's plain Python `str` (acceptable for local-only single-user app); never transmitted except over HTTPS to `huggingface.co`. |
| V10 Malicious Code | yes | Documented `xattr -cr` workaround is the user-side mitigation for "anti-malware blocked the unsigned .app"; real notarization deferred. |
| V14 Configuration | yes | All HF token sources are user-controlled; default-deny (no token = no diarization, no IndexTTS gating). |

### Known Threat Patterns for OmniVoice (Phase 1 scope)

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| HF token leakage via log file | Information Disclosure | `HFTokenRedactor` logging filter (AUTH-05); CI test asserts `hf_*` never appears in `caplog`. |
| HF token leakage via stack trace in error toast | Information Disclosure | Same filter applied to `traceback.format_exception` output before any UI display. |
| HF token theft via `omnivoice_data/` SQLite copy | Information Disclosure | Column encryption (AUTH-02). Honestly documented as "same-user-on-same-machine attacker can still decrypt" — OS keyring v0.4. |
| Phishing via error deeplink to attacker-controlled docs | Tampering | All deeplinks point to `github.com/<owner>/<repo>/...` — pinned in `error_docs_map.py`; user can audit by reading the source. |
| Loopback `/system/set-env` bypass | Spoofing | Loopback origin check (already shipped — quick task 260518-ivy). Phase 1 must apply the same check to any new endpoint (`save_hf_token`, `clear_hf_token`, etc.). |
| AppImage `WEBKIT_DISABLE_COMPOSITING_MODE=1` env-injection from a malicious sidecar | Tampering | AppRun is sealed inside the AppImage; user mounts read-only. Not a Phase 1 concern. |
| Unsigned macOS .app substitution attack | Tampering | Documented `xattr -cr` workaround is itself a tradeoff: removes quarantine, also removes provenance check. SHA-256 checksum in release notes (GATE-05, Phase 0) is the user-side verification. Documented honestly in `docs/install/macos.md`. |

---

## Project Constraints (from CLAUDE.md)

> CLAUDE.md directives that constrain Phase 1 implementation. Treat with the same authority as locked decisions.

1. **HF token persistence:** Use `huggingface_hub.login(token=val, add_to_git_credential=False)` — NOT `HfFolder.save_token()` directly. Document env-var path as override only, not as primary persistence mechanism.
2. **Bug reporting (out of scope for Phase 1, in scope for Phase 5):** No PAT in OmniVoice. No `sentry-tauri`. No third-party telemetry endpoint. Prefilled GitHub Issues URL only. **Listed here because the AUTH-05 logging filter feeds Phase 5's payload builder — get the filter right now.**
3. **Mirror cascade (Phase 3, out of scope for Phase 1):** `UV_PYTHON_INSTALL_MIRROR` + `UV_PYTHON_PREFERENCE=only-system` fallback + `UV_HTTP_TIMEOUT=120` + `UV_HTTP_RETRIES=5`. Not a Phase 1 implementation concern, but Phase 1's `docs/install/linux.md` and `docs/install/windows.md` must reference these env vars correctly when describing the restricted-network user path.
4. **Docs framework:** In-repo Markdown only. Do NOT introduce Material for MkDocs (maintenance mode Nov 2025). Astro Starlight deferred past v0.3.
5. **Local-first invariant:** No required cloud calls. Deeplinks open `github.com/<owner>/<repo>` URLs; no analytics ping on deeplink click.
6. **Cross-platform parity:** All fixes work on macOS (Apple Silicon + Intel), Windows x64, Linux (AppImage + .deb). The .deb ffprobe relocation and AppImage AppRun conditional are both Linux-only — verify they don't regress on macOS/Windows by being properly gated behind OS detection.
7. **Backward-compat:** Existing `omnivoice_data/` keeps working. Token migration is additive — App-stored tokens are a new source; existing users' env-var or HF-CLI tokens continue to work via the cascade.

---

## Sources

### Primary (HIGH confidence)
- [Hugging Face Hub authentication API](https://huggingface.co/docs/huggingface_hub/en/package_reference/authentication) — `login()`, `get_token()`, `whoami()`, `logout()` are canonical 1.x API
- [Hugging Face Hub environment variables](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables) — `HF_HOME`, `HF_TOKEN`, `HF_HUB_CACHE` semantics
- [Microsoft `setx` reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/setx) — confirms "current shell" gotcha for Windows users
- [PowerShell `about_Environment_Variables`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables) — `[Environment]::SetEnvironmentVariable(..., "User")`
- [Tauri 2 shell plugin docs](https://v2.tauri.app/plugin/shell/) — `open()` permission scope
- [PyCA `cryptography` Fernet reference](https://cryptography.io/en/latest/fernet/) — safe symmetric encryption API
- CLAUDE.md (this repo) — pre-vetted stack for Capabilities 1, 3, 5
- `/Users/user4/Desktop/voice-design/OmniVoice/backend/api/routers/dub_core.py:540` — current `os.environ.get("HF_TOKEN")` site (confirmed by grep this session)
- `/Users/user4/Desktop/voice-design/OmniVoice/frontend/src/utils/media.js:20` — current `localhost:3900` hardcode (confirmed by grep this session)
- `/Users/user4/Desktop/voice-design/OmniVoice/frontend/src-tauri/tauri.conf.json` — Tauri bundler config (confirmed exists)
- `/Users/user4/Desktop/voice-design/OmniVoice/frontend/src-tauri/src/bootstrap.rs` — Rust app bootstrap (confirmed exists)

### Secondary (MEDIUM confidence)
- [sindresorhus/new-github-issue-url](https://github.com/sindresorhus/new-github-issue-url) — prefilled GitHub issue URL pattern (used by Phase 5; included here because error-UX deeplinks may eventually layer onto it)
- [GitHub URL query parameters for issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue#creating-an-issue-from-a-url-query) — Phase 5 reference

### Tertiary (LOW confidence)
- Tauri AppImage bundler internals — `AppRun` generation specifics need verification via `cargo tauri build --bundles appimage --verbose`. Listed as Open Question #1.
- Exact `omnivoice_data/` SQLite schema — needs in-tree verification of `backend/core/job_store.py` and any `migrations/` directory. Listed as Open Question #2.

---

## Metadata

**Confidence breakdown:**
- HF token persistence (AUTH-01..06): HIGH — `huggingface_hub.login()` / `get_token()` / `whoami()` are canonical, documented, already a transitive dep. The `dub_core.py:540` bug is confirmed by grep this session.
- Docs scaffolding (INST-02, INST-05, INST-06, DOCS-01..05): HIGH — pure in-repo Markdown, CLAUDE.md pre-vets the choice, `scripts/validate-install-docs.py` is a 50-line Python script with no external risk.
- macOS Gatekeeper (INST-03): HIGH — `xattr -cr` is the well-known workaround; detection via `xattr -l` is standard. Real notarization explicitly out of scope per STATE.md Key Decision #7.
- AppImage WebKit (INST-04): MEDIUM — `WEBKIT_DISABLE_COMPOSITING_MODE=1` is widely-cited; the conditional version detection in AppRun is the open detail (Pitfall #3, Open Question #1).
- .deb ffprobe relocation (#76): MEDIUM — Tauri's `tauri.conf.json` `bundle.linux.deb` schema supports it; needs verification of exact JSON path and postrm hook.
- Docker LAN (#80): HIGH — `frontend/src/utils/media.js:20` confirmed; `window.location.host` is the standard answer.
- Error UX (DOCS-02): HIGH — small data structure + Tauri shell plugin `open()`.
- Common pitfalls: HIGH — drawn from CLAUDE.md "What NOT to Use" and verified code in this tree.

**Research date:** 2026-05-18
**Valid until:** 2026-06-18 (30 days — HF Hub APIs and Tauri 2 plugin surface are stable; revisit before Phase 6 release if any HF Hub major release lands in the window)
