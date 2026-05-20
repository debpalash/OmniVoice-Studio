# Phase 3: Supertonic-3 Engine + Installer Mirror Reliability — Research

**Researched:** 2026-05-18
**Domain:** New TTS engine integration (Supertonic-3 ONNX) + installer reliability for restricted-network regions (China/Russia/CIS)
**Confidence:** HIGH (Supertonic-3 stack, uv mirror cascade, region plumbing all verified against current docs / current code in-tree). MEDIUM on a single point: the upstream `supertonic` PyPI release that CLAUDE.md pins to `1.2.3` is now `1.3.1` as of today — see Open Questions and Assumptions Log.

---

## Summary

Phase 3 ships two coordinated additions to v0.3.0: (a) **Supertonic-3** as a 7th opt-in TTS engine routed through the Phase 2 `SubprocessBackend` primitive, and (b) **a hardened `bootstrap.rs` mirror cascade** that closes `#57` (generic install fail) and `#60` (Russian install error) without giving up the local-first guarantee. Both touch the same surfaces (engine registry, settings UI, bootstrap env vars) and the same constraints (cross-platform parity, backward compat with installed engines, opt-in only) — so they belong in the same phase even though the user-visible features differ.

The Supertonic-3 integration is unusually clean. The engine is **CPU-only via `onnxruntime` 1.24.4** (already in `uv.lock` — see VERIFIED dep below), the SDK is `supertonic` (PyPI, MIT, official Supertone Inc. publisher), the model is ~99M params split across three ONNX files (~400 MB total) auto-downloaded from HuggingFace on first use, and the SDK exposes a single-call `TTS().synthesize(...)` API with built-in voice presets (M1/M3/M4/M5/F3/F4/F5). Because it has no torch/transformers dependency and no native CUDA path, the **same wheel works identically on macOS Apple Silicon, mac-Intel, Windows x64, Linux x64, and Linux aarch64** — no platform-only regressions, no MPS path to validate, no CUDA double-install warning to chase. The engine therefore does **not strictly need** `SubprocessBackend` isolation for safety; we run it inside the SubprocessBackend anyway because (i) Phase 2 established that as the standard pattern for opt-in engines so the engine registry/UI is uniform, and (ii) it lets us pin the optional `supertonic` dep in its own venv if a future version conflicts with a main-venv dep (graceful upgrade path). Honest IS-EQUAL hardware reporting (TTS-04) drops out for free because there is no CUDA path to claim.

The mirror cascade is the higher-risk half of the phase. The current `bootstrap.rs` already has region plumbing (`AppConfig.region` with values `auto`/`global`/`china`/`russia`/`restricted`, `set_region` Tauri command, `BootstrapSplash.jsx` region dropdown, `get_effective_region()` probe) but **only acts on one env var** — it sets `UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/` when `region == "china"` (bootstrap.rs:454). The Phase 3 work is therefore additive and well-bounded: (1) replace deprecated `UV_INDEX_URL` with `UV_DEFAULT_INDEX` (uv 0.4.23+); (2) add a **failure-cascade** for `UV_PYTHON_INSTALL_MIRROR` over an allow-list of github-proxy URLs read from `mirrors.json`; (3) set `UV_HTTP_TIMEOUT=120` and `UV_HTTP_RETRIES=5` in the bootstrap environment; (4) add an `only-system` final fallback that uses the user's pre-existing Python `>=3.11` if every mirror fails; (5) enforce `uv sync --frozen` and ship a hash-pinned `uv.lock`. For Russia, the honest documented answer remains "no government-blessed PyPI mirror — use VPN or system Python." We do not invent one.

**Primary recommendation — ship in two waves:**

1. **Wave 1 — Supertonic-3 engine on SubprocessBackend.** Add `supertonic` to `[project.optional-dependencies]`, scaffold `backend/engines/supertonic3/` with a `TTSBackend` subclass that delegates to the Phase 2 `SubprocessBackend`, register it in `_REGISTRY` (tts_backend.py:1115), add a UI license-acceptance gate (TTS-05), pin model SHA in code via `huggingface_hub.snapshot_download(..., revision=SHA)`, smoke test 3-langs × 3-seconds with `pytest -k supertonic`. Wait until SPIKE-CONFIRM (Open Question Q1) resolves before locking the `supertonic` version to 1.2.3 vs 1.3.1.

2. **Wave 2 — Mirror cascade hardening in `bootstrap.rs`.** Add `frontend/src-tauri/resources/mirrors.json` (allow-list), implement `try_mirrors_in_order()` helper returning the first mirror whose `UV_PYTHON_INSTALL_MIRROR`-prefixed download succeeds, set `UV_HTTP_TIMEOUT/RETRIES`, add `--python-preference only-system` fallback path that probes for `python3.11+ -c "import sys; print(sys.version_info)"` before retrying `uv sync`, replace deprecated `UV_INDEX_URL` with `UV_DEFAULT_INDEX`, enforce `--frozen`, ship the hash-pinned `uv.lock`. Smoke-test on Russia-VPN-off + China-VPN-off VM images via existing `release.yml` matrix (`GATE-03`).

---

## User Constraints (from CONTEXT.md)

> No formal CONTEXT.md exists for Phase 3 yet — this Phase has not been through `/gsd:discuss-phase`. Constraints below are extracted from CLAUDE.md (Capabilities 3 + 4), the project-level constraints in PROJECT.md / CLAUDE.md, ROADMAP.md Phase 3 success criteria, and REQUIREMENTS.md TTS-01..06 + INST-07..11. Treat all locked decisions as binding — they reflect already-published architectural choices.

### Locked Decisions

1. **Opt-in only.** `supertonic` lives in `[project.optional-dependencies]` (TTS-02). The default install does NOT pull Supertonic-3. Users must explicitly enable it.
2. **Model revision pinned by commit SHA, not tag** (TTS-03). The model card is being actively updated (5 commits in the last 12 days as of 2026-05-18). A tag pin is not strong enough — pin to a specific SHA. See Open Questions Q2.
3. **License acceptance gates first use** (TTS-05). The Supertonic-3 model ships under **OpenRAIL-M** (model weights, restricted-use clauses) while the SDK code is **MIT**. We surface both in the engine card with click-through links and require explicit acceptance before download/first generate.
4. **CPU-only honesty** (TTS-04). The engine MUST report CPU-only when CUDA is absent. Because Supertonic-3 has no CUDA path at all in the current SDK, `is_available()` reports `"cpu"` everywhere — no `"mps"` or `"cuda"` paths claimed.
5. **Mirror list is allow-list, JSON-shipped** (INST-08, INST-09). User cannot enter freeform URLs (supply-chain risk per Out of Scope table in REQUIREMENTS.md). The allow-list lives in `frontend/src-tauri/resources/mirrors.json` (or equivalent — see Architecture below) and is rotatable without a release.
6. **`uv sync --frozen` enforced + hash-pinned `uv.lock`** (INST-10). Mirror cascade does NOT loosen verification — every package gets a SHA-256 check against `uv.lock`. A mirror serving a tampered wheel fails the lock check.
7. **`UV_HTTP_TIMEOUT=120` and `UV_HTTP_RETRIES=5`** in the bootstrap environment (INST-11). Defaults of 30/3 are too tight for restricted networks.
8. **Honest documentation for Russia.** No government-blessed PyPI mirror exists (CLAUDE.md Capability 3 explicit decision). We document the VPN-or-system-Python path and do not ship a broken default.
9. **Phase 2 `SubprocessBackend` is the substrate.** Supertonic-3 plugs into the Phase 2 primitive. Do not invent a new isolation pattern. (ROADMAP.md Phase 3 "Depends on Phase 2 ... do not parallelize.")
10. **No reinstall pain.** Existing IndexTTS / CosyVoice / etc. installs continue working untouched. Supertonic-3 is purely additive.

### Claude's Discretion

- **Wave ordering.** Recommended above; planner may reorder if it preserves dependency (model SHA pinned before smoke test; mirror cascade before release smoke).
- **Exact API for the Supertonic-3 wrapper.** Whether `generate()` returns mono or stereo (Supertonic-3 docs are ambiguous; we recommend mono at 44.1 kHz to match the dub pipeline's mixer), how `voice` kwarg maps to preset names, whether `total_steps`/`speed` are surfaced in the Engines UI.
- **Whether Supertonic-3 honors `language=` kwarg** by passing through to SDK's `lang=` param vs auto-detecting. Recommendation: pass through when caller supplies it; default to `"na"` (language-agnostic) for OmniVoice's "Auto" sentinel.
- **Exact file path for the mirror allow-list.** Proposed `frontend/src-tauri/resources/mirrors.json`. Tauri bundles `resources/` into the installer; `tauri::path::resource_dir()` resolves at runtime.
- **Allow-list contents.** Proposed defaults: `ghproxy.net`, `ghfast.top`, `gitmirror.com`. These are external services with no SLA — document this clearly in docs/install/troubleshooting.md.
- **Whether to expose mirror picker in Settings UI or only via `region` dropdown.** Recommendation: keep region-driven (less surface area for misconfiguration); advanced users can edit `config.json` directly.

### Deferred Ideas (OUT OF SCOPE)

- **OS keyring for model weight storage** — not relevant; HF cache is the storage.
- **GPU/CUDA Supertonic-3 path** — not in upstream SDK; track when/if Supertone ships one.
- **Custom Supertonic-3 voice training** — handled by Voice Builder web app (Supertone-hosted); not in OmniVoice scope.
- **Freeform mirror URL input** — anti-feature per REQUIREMENTS.md Out of Scope table.
- **Bundling Supertonic-3 weights in the Tauri installer** — adds ~400 MB to a 1.8 GB installer for an opt-in engine; lazy download is the correct tradeoff.
- **Russian PyPI mirror** — no honest default exists; do not invent one.
- **Generic per-engine `optional-dependencies` UX for engines beyond Supertonic-3** — defer to v0.4 (ENGINE-V2-01: full subprocess migration).
- **Auto-update of `mirrors.json` from a remote source** — supply-chain risk; rotate via app updates only.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TTS-01 | `backend/engines/supertonic3/` implements `TTSBackend` on Phase 2 `SubprocessBackend` for Supertonic-3 | Section: Supertonic-3 Integration + Standard Stack |
| TTS-02 | `[project.optional-dependencies] supertonic = ["supertonic==X.Y.Z"]` opt-in install | Section: Standard Stack + Open Question Q1 (version selection) |
| TTS-03 | Supertonic-3 model revision pinned by commit SHA in code | Section: Code Examples (model revision pinning) + Open Question Q2 |
| TTS-04 | Engine `is_available()` honestly reports CPU-only when CUDA is absent and no MPS path | Section: Architectural Responsibility Map + Code Examples |
| TTS-05 | Supertonic-3 license (MIT code / OpenRAIL-M model) is surfaced in engine card UI; first-use acceptance gate | Section: License Acceptance Pattern |
| TTS-06 | Smoke test: install via optional dep, generate 3 sec × 3 languages, no onnxruntime double-install warning | Section: Validation Architecture |
| INST-07 | `bootstrap.rs` mirror cascade (GitHub → gh-proxy → ghfast → gitmirror → `only-system` fallback) | Section: Mirror Cascade Architecture |
| INST-08 | Mirror list shipped as external JSON file (rotatable without release) | Section: Mirror Cascade Architecture |
| INST-09 | Allow-list only — no freeform user input | Section: Mirror Cascade Architecture + Security Domain |
| INST-10 | `uv sync --frozen` enforced; `uv.lock` hash-pinned and committed | Section: Code Examples (bootstrap.rs delta) |
| INST-11 | `UV_HTTP_TIMEOUT=120` and `UV_HTTP_RETRIES=5` set in bootstrap env | Section: Standard Stack + Code Examples |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Supertonic-3 inference | Backend (Python subprocess venv) | — | ONNX runtime is Python-side; engine sits behind `SubprocessBackend` for isolation parity with other opt-in engines. |
| Supertonic-3 model weight download | Backend (`huggingface_hub.snapshot_download`) | OS filesystem (`$HF_HUB_CACHE`) | Reuses existing HF infrastructure + the Phase 1 token resolver. |
| Supertonic-3 voice preset selection | Backend (engine subclass) | Frontend (Settings → Engine card voice picker) | Backend exposes preset list; frontend renders dropdown. |
| Supertonic-3 license acceptance | Frontend (modal dialog on first enable) | Backend (`settings_store` AES-GCM column → `supertonic3_license_accepted: true`) | UI gate; persisted backend-side so subprocess can verify before download. |
| Supertonic-3 engine registry entry | Backend (`tts_backend.py:_REGISTRY`) | Frontend (engine picker) | Same pattern as the 9 existing engines. |
| Region selection (auto / global / china / russia / restricted) | Frontend (BootstrapSplash + Settings) | Backend (Tauri `config.rs::AppConfig.region`) | Already wired in-tree — Phase 3 extends behavior, does not invent UI. |
| Mirror allow-list | Repo (`frontend/src-tauri/resources/mirrors.json`) | Tauri bundler | Static JSON shipped via `tauri.conf.json` `bundle.resources`. |
| Mirror cascade execution | Tauri Rust (`bootstrap.rs::ensure_venv_ready`) | uv subprocess | Rust orchestrates retry loop, sets env vars per attempt, runs `uv venv` + `uv sync`. |
| `only-system` Python fallback | Tauri Rust (`bootstrap.rs`) | OS (user's pre-existing python3.11+) | Rust probes `python3 --version` / `py -3.11 --version`, then re-invokes uv with `--python-preference only-system`. |
| HF cache mirror (`HF_ENDPOINT=https://hf-mirror.com`) | Tauri Rust (`backend.rs::spawn_backend` env injection) | Python (huggingface_hub reads at import) | Already wired — backend.rs:168-173. Phase 3 does not change this; just documents it. |
| PyPI mirror for `uv sync` | Tauri Rust (`bootstrap.rs` env injection) | uv subprocess | bootstrap.rs:454 already sets `UV_INDEX_URL` for `region == "china"`; Phase 3 migrates to `UV_DEFAULT_INDEX` (uv 0.4.23 renamed) and extends to russia/restricted. |
| `uv.lock` hash verification | uv internal | — | Already done by uv when `--frozen` is passed; Phase 3 just enforces the flag and ships the lockfile. |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `supertonic` (PyPI) | **`1.3.1`** as of 2026-05-18 (CLAUDE.md pinned `1.2.3` — drift; see Open Q1) `[VERIFIED: pypi.org/pypi/supertonic/json, fetched today]` | Official Supertonic-3 inference SDK | Authoritative wrapper from Supertone Inc. `<contact@supertone.ai>`. MIT-licensed code. Declares only 4 deps: `onnxruntime`, `numpy`, `soundfile`, `huggingface-hub` — all already in OmniVoice's lock. |
| `onnxruntime` | `1.24.4` `[VERIFIED: uv.lock lines 3180-3213, confirmed in-tree]` | ONNX inference runtime for Supertonic-3 | Already a runtime dep via `kittentts`, `audioseal`, `sherpa-onnx`. No double-install risk if we let `supertonic` reuse the existing pin. |
| `huggingface_hub` | `≥1.12.x` (already pinned transitively by `transformers>=5.3.0`) `[VERIFIED: CLAUDE.md Capability 1 pre-vetted, pyproject.toml line 39]` | Model weight download + token reuse | Phase 1's token resolver feeds Supertonic-3's HF download path the same way it feeds pyannote. |
| `numpy`, `soundfile` | already pinned `[VERIFIED: pyproject.toml lines 35-36]` | Audio I/O + array math | No new deps. |
| `uv` (Tauri sidecar) | `0.11.7` `[VERIFIED: frontend/src-tauri/src/tools.rs:18 UV_VERSION]` — Phase 3 may bump to current latest when uv.lock is regenerated | Python venv bootstrap + dep resolution | Already pinned via `UV_VERSION` constant; Phase 3 does not change the binary but uses more of its env vars. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `UV_PYTHON_INSTALL_MIRROR` env var | uv `≥0.2.35` `[VERIFIED: docs.astral.sh/uv/reference/environment/]` | Override `python-build-standalone` download URL prefix | All Phase 3 mirror cascade attempts. URL replaces `https://github.com/astral-sh/python-build-standalone/releases/download` as a prefix. |
| `UV_PYTHON_PREFERENCE=only-system` | uv `≥0.3.2` `[VERIFIED: same source]` | Skip python-build-standalone download; use user's system Python | Final fallback when all mirrors fail. Requires user's `python3.11+` on PATH. |
| `UV_DEFAULT_INDEX` | uv `≥0.4.23` `[VERIFIED: same source — replaces deprecated UV_INDEX_URL]` | Primary PyPI index URL | Replaces the deprecated `UV_INDEX_URL` currently in bootstrap.rs:454. |
| `UV_HTTP_TIMEOUT` | uv `≥0.1.7`, default 30 s `[VERIFIED: same source]` | HTTP read timeout for uv operations | Bump to 120 (INST-11). |
| `UV_HTTP_RETRIES` | uv `≥0.7.21`, default 3 `[VERIFIED: same source]` | Retry count for failed HTTP requests | Bump to 5 (INST-11). |
| `HF_ENDPOINT=https://hf-mirror.com` | Already in tree `[VERIFIED: frontend/src-tauri/src/backend.rs:168-173]` | HuggingFace mirror for `region == "china"` (model downloads) | Already wired by `spawn_backend()`. Phase 3 references but does not change. |
| `pytest` + `pytest-asyncio` | already pinned | TTS-06 smoke test harness | Wave 1 verification step. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Lazy first-run model download (~400 MB) | Bundle Supertonic-3 weights in the Tauri installer | Adds ~400 MB to every installer (currently 1.8 GB → 2.2 GB) for an **opt-in** engine. Rejected. |
| Pre-shipped voice presets only | Voice Builder integration | Voice Builder is Supertone-hosted (web app, requires account) — violates local-first guarantee. Stay with the 7 preset voices. |
| `UV_PYTHON_INSTALL_MIRROR` cascade | Pre-bundle Python 3.11 in the Tauri installer | Adds ~30 MB to every installer for the ~5% restricted-network users. CLAUDE.md Alternatives table explicitly rejects this for v0.3 — revisit in v0.4 if the bootstrap is still a top complaint. |
| `mirrors.json` shipped in installer | Fetch `mirrors.json` from a known URL at startup | Supply-chain attack surface (the fetch URL itself becomes the vector). Stay with shipped-in-installer; rotate via app updates. |
| Three mirror layers (Python interpreter + PyPI + HF) wired separately | Single "use China mirrors" toggle | The three layers are independent — github releases (for python-build-standalone), pypi.org (for wheels), huggingface.co (for model weights). One toggle is the user-facing UX (the `region` dropdown), but three layers exist underneath. |
| Run Supertonic-3 in-process | Wrap in `SubprocessBackend` | Supertonic-3 has no torch/transformers dep, so it's "safe" in-process — but Phase 2's `SubprocessBackend` is now the standard pattern for opt-in engines. Use it for consistency, not for safety. Marginal latency cost (one subprocess spawn on first synthesize). |

**Installation:**

```bash
# Capability 4 (Supertonic-3) — Wave 1
# Add to pyproject.toml [project.optional-dependencies]:
#   supertonic = ["supertonic==1.3.1"]   # see Open Question Q1 before locking
uv lock --upgrade-package supertonic
uv sync --frozen --no-dev    # verify no regressions
uv pip list | grep -E "supertonic|onnxruntime|huggingface"
# Expect: supertonic 1.3.1, onnxruntime 1.24.4 (single pin), huggingface_hub >=1.12

# Capability 3 (mirror cascade) — Wave 2
# No new Python deps. All work in Rust (bootstrap.rs) + a static JSON resource.
```

**Version verification commands:**

```bash
# Supertonic SDK
uv pip show supertonic                      # expect 1.3.1 (or 1.2.3 if Open Q1 resolves "keep CLAUDE.md pin")
# ONNX runtime (NO double-install)
uv pip list | grep -i onnxruntime           # MUST show exactly one row (1.24.4)

# uv version (sets the minimum-supported env vars)
uv --version                                # expect >= 0.11.7 (already in tools.rs)

# Confirm HF endpoint env-var passthrough (region=china only)
# Open the Tauri app with region=china, then check backend logs for:
#   HF_ENDPOINT=https://hf-mirror.com
```

---

## Package Legitimacy Audit

> slopcheck was not run automatically in this research session (no slopcheck binary available in environment). All packages below are verified via authoritative sources (PyPI metadata, in-tree lockfile, official docs) — but the planner should run `slopcheck install supertonic --json` before locking the `[project.optional-dependencies]` entry and may need to gate behind a `checkpoint:human-verify` task if slopcheck flags anything.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `supertonic` | PyPI | Released 2026-05-15 (first), `1.3.1` 2026-05-18 | New — public for ~3 days `[VERIFIED: pypi.org/pypi/supertonic/json]` | `github.com/supertone-inc/supertonic` (official, MIT) `[VERIFIED]` | NOT RUN — slopcheck unavailable in research env | `[ASSUMED VERIFIED]` — re-run slopcheck before merge; the upstream publisher is `Supertone Inc. <contact@supertone.ai>` and the source repo is the official Supertone Inc. GitHub org. The 3-day age is unusual but expected for a v3 model release. Recommend `checkpoint:human-verify` task in the plan before `uv add supertonic`. |
| `onnxruntime` | PyPI | 6+ years `[VERIFIED: pypi.org]` | 50M+/week `[ASSUMED — typical for runtime]` | `github.com/microsoft/onnxruntime` (official Microsoft, MIT) `[VERIFIED]` | OK (Microsoft official) `[ASSUMED]` | Approved — already in tree, no change. |
| `huggingface_hub` | PyPI | 5+ years `[VERIFIED]` | billions of cumulative downloads `[ASSUMED]` | `github.com/huggingface/huggingface_hub` (official) `[VERIFIED]` | OK (HF official) `[ASSUMED]` | Approved — already in tree. |

**Packages removed due to slopcheck [SLOP] verdict:** none.

**Packages flagged as suspicious [SUS]:** `supertonic` is **new** (3 days on PyPI as of research date). Recommend the planner insert a `checkpoint:human-verify` task immediately before `uv add supertonic` so the user can:
1. Visit `https://pypi.org/project/supertonic/1.3.1/` and confirm publisher = `Supertone Inc.`
2. Visit `https://github.com/supertone-inc/supertonic` and confirm it is the official org
3. Run `pip download supertonic==1.3.1 --no-deps -d /tmp/sup` and inspect the wheel for unexpected postinstall scripts
4. Run `npm view supertonic` and confirm **no** npm package of the same name exists (cross-ecosystem confusion check — Supertonic ships only on PyPI)

This is a precautionary step proportional to the package being 3 days old.

---

## Architecture Patterns

### System Architecture Diagram

```
                  ┌──────────────────────────────────────────────────────────────┐
                  │                     Tauri Frontend                            │
                  │                                                               │
                  │   BootstrapSplash.jsx          Settings → Engines              │
                  │   ┌──────────────────────┐    ┌──────────────────────────┐    │
                  │   │ region dropdown      │    │ Supertonic-3 engine card │    │
                  │   │ auto/global/china/   │    │ - License: MIT / OpenRAIL│    │
                  │   │ russia/restricted    │    │ - Voice: M1/M3/.../F5     │    │
                  │   └──────────┬───────────┘    │ - [Accept license]        │    │
                  │              │ set_region     └────────┬──────────────────┘    │
                  │              ▼                         │ accept_supertonic_   │
                  │   ┌──────────────────────┐             │   license            │
                  │   │ Tauri commands       │◄────────────┘                      │
                  │   │ (config.rs)          │                                    │
                  │   └──────────┬───────────┘                                    │
                  └──────────────┼───────────────────────────────────────────────┘
                                 │
                  ┌──────────────▼───────────────────────────────────────────────┐
                  │                  Tauri Rust (src-tauri/src/)                  │
                  │                                                               │
                  │   bootstrap.rs::ensure_venv_ready  (Wave 2 changes)            │
                  │                                                               │
                  │   1. Read region from config.rs::get_effective_region()       │
                  │   2. Set UV_HTTP_TIMEOUT=120, UV_HTTP_RETRIES=5                │
                  │   3. Set UV_DEFAULT_INDEX per region                          │
                  │      (replaces deprecated UV_INDEX_URL at bootstrap.rs:454)   │
                  │   4. Load resources/mirrors.json (allow-list)                 │
                  │   5. for mirror in mirrors:                                   │
                  │        set UV_PYTHON_INSTALL_MIRROR=mirror                    │
                  │        try `uv venv --python 3.11 --managed-python`           │
                  │        if success → break                                     │
                  │   6. if all mirrors fail:                                     │
                  │        probe system python3.11+                               │
                  │        if found → `uv venv --python-preference only-system`   │
                  │        else → BootstrapStage::Failed with deeplink to         │
                  │                docs/install/restricted-networks.md            │
                  │   7. `uv sync --frozen --no-dev` (INST-10)                    │
                  │                                                               │
                  │   backend.rs::spawn_backend (UNCHANGED — already in tree)     │
                  │   - HF_ENDPOINT=https://hf-mirror.com when region=china        │
                  └──────────────┬───────────────────────────────────────────────┘
                                 │ spawns
                  ┌──────────────▼───────────────────────────────────────────────┐
                  │              Python Backend (uvicorn + engine subprocesses)   │
                  │                                                               │
                  │  backend/services/tts_backend.py::_REGISTRY                    │
                  │    + "supertonic3": Supertonic3Backend  (NEW — Wave 1)        │
                  │                                                               │
                  │  ┌────────────────────────────────────────────────────────┐  │
                  │  │  Supertonic3Backend(TTSBackend)                        │  │
                  │  │  ┌──────────────────────────────────────────────────┐  │  │
                  │  │  │ generate(text, voice, lang, …)                   │  │  │
                  │  │  │   → SubprocessBackend.invoke(payload)            │  │  │
                  │  │  └────────────────┬─────────────────────────────────┘  │  │
                  │  └────────────────────┼──────────────────────────────────┘  │
                  │                       │ spawn (Phase 2 primitive)            │
                  │  ┌────────────────────▼──────────────────────────────────┐  │
                  │  │ supertonic3 sidecar subprocess (own venv if needed)    │  │
                  │  │   from supertonic import TTS                            │  │
                  │  │   tts = TTS(auto_download=True, revision=PINNED_SHA)   │  │
                  │  │   style = tts.get_voice_style(voice_name="M1")          │  │
                  │  │   wav, _ = tts.synthesize(text=…, lang=…,               │  │
                  │  │       voice_style=style, total_steps=8, speed=1.0)     │  │
                  │  │                                                         │  │
                  │  │   reads HF_ENDPOINT, HF_TOKEN, HF_HUB_CACHE              │  │
                  │  │   from parent env (Phase 1 token resolver feeds these) │  │
                  │  └────────────────────┬──────────────────────────────────┘  │
                  │                       │                                       │
                  │  ┌────────────────────▼──────────────────────────────────┐  │
                  │  │ Hugging Face Hub                                       │  │
                  │  │ - Supertone/supertonic-3 (revision=PINNED_SHA)         │  │
                  │  │ - text_encoder.onnx, latent_denoiser.onnx,             │  │
                  │  │   voice_decoder.onnx, tokenizer.json (~400 MB total)    │  │
                  │  │ - cached to $HF_HUB_CACHE                              │  │
                  │  └────────────────────────────────────────────────────────┘  │
                  └───────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure (deltas only)

```
backend/
└── engines/
    └── supertonic3/                       # NEW — Wave 1
        ├── __init__.py                    # exports Supertonic3Backend
        ├── backend.py                     # TTSBackend subclass; SubprocessBackend wrapper
        ├── constants.py                   # PINNED_REVISION_SHA, VOICE_PRESETS, LICENSE_URLS
        └── sidecar.py                     # invoked inside the subprocess venv
                                            # (only imports `supertonic`; isolated)

frontend/
├── src/
│   └── components/
│       └── SupertonicLicenseDialog.jsx    # NEW — Wave 1 (TTS-05)
└── src-tauri/
    ├── resources/
    │   └── mirrors.json                   # NEW — Wave 2 (INST-08, INST-09)
    └── src/
        └── bootstrap.rs                   # MODIFIED — Wave 2
                                            # add: try_mirrors(), probe_system_python(),
                                            # rewrite ensure_venv_ready cascade

docs/install/
├── linux.md                               # MODIFIED — Wave 2: document UV_HTTP_TIMEOUT etc.
├── windows.md                             # MODIFIED — Wave 2
└── restricted-networks.md                 # NEW — Wave 2: China/Russia/CIS playbook
```

### Pattern 1: Wrap `supertonic` SDK behind the existing `TTSBackend` protocol

**What:** Subclass `TTSBackend` (backend/services/tts_backend.py:34) and delegate to the Phase 2 `SubprocessBackend` for actual inference.

**When to use:** Every opt-in engine added from this milestone onward. (Phase 2 sets the pattern with IndexTTS2; Phase 3 follows it for Supertonic-3.)

**Example:**

```python
# backend/engines/supertonic3/backend.py
# Source: derived from tts_backend.py patterns (KittenTTSBackend, IndexTTS2Backend)
# + supertonic SDK example: https://github.com/supertone-inc/supertonic README

from __future__ import annotations
import logging
import os
from typing import Optional
import torch
from services.tts_backend import TTSBackend
# Phase 2 primitive — assumed to exist by the time Phase 3 lands
from engines._subprocess import SubprocessBackend

logger = logging.getLogger("omnivoice.tts.supertonic3")

# Pinned model revision — TTS-03. Update via PR when intentionally rolling forward.
# See Open Question Q2 for current SHA discovery procedure.
PINNED_REVISION_SHA = "<RESOLVED_SHA_FROM_OPEN_Q2>"   # e.g. "3cadd1e..." (full 40-char)

VOICE_PRESETS = ["M1", "M3", "M4", "M5", "F3", "F4", "F5"]
DEFAULT_VOICE = "M1"


class Supertonic3Backend(TTSBackend):
    """Supertonic-3 — 31-language ONNX TTS, CPU-only, 99M params.

    License: MIT (SDK code) / OpenRAIL-M (model weights).
    First use is gated behind license acceptance (Settings → Engines).
    """

    id = "supertonic3"
    display_name = "Supertonic-3 (31 langs, CPU ONNX, 7 preset voices, OpenRAIL-M)"

    def __init__(self):
        self._sub: Optional[SubprocessBackend] = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        # 1. Optional-dep gate
        try:
            import supertonic  # noqa: F401
        except ImportError:
            return False, (
                "supertonic package not installed. Enable in Settings → Engines "
                "(installs `supertonic` via `uv add supertonic`)."
            )
        # 2. License acceptance gate (TTS-05)
        from services.settings_store import get_setting
        if not get_setting("supertonic3_license_accepted", default=False):
            return False, (
                "Supertonic-3 license not accepted. Open Settings → Engines → "
                "Supertonic-3 and click Accept to enable."
            )
        # 3. Honest hardware report (TTS-04) — CPU-only, no CUDA/MPS path in upstream SDK
        return True, "ready (CPU-only via onnxruntime)"

    @property
    def sample_rate(self) -> int:
        return 44100   # Supertonic-3 native rate per model card

    @property
    def supported_languages(self) -> list[str]:
        # 31 languages per model card — using "multi" for the supported_languages
        # protocol contract (same approach as OmniVoice/CosyVoice). Language is
        # passed through to the SDK at synthesize time.
        return ["multi"]

    supports_voice_design = False   # Supertonic-3 uses preset voices, not freeform

    def _ensure_loaded(self):
        if self._sub is not None:
            return
        ok, msg = self.is_available()
        if not ok:
            raise RuntimeError(f"Supertonic-3 unavailable: {msg}")
        # SubprocessBackend handles venv selection + IPC (Phase 2 primitive).
        # We pass the pinned model revision so the sidecar downloads the right SHA.
        self._sub = SubprocessBackend(
            engine_id=self.id,
            sidecar_module="engines.supertonic3.sidecar",
            sidecar_env={
                "SUPERTONIC3_REVISION": PINNED_REVISION_SHA,
                # HF_TOKEN, HF_ENDPOINT, HF_HUB_CACHE inherited from parent (Phase 1)
            },
        )
        self._sub.start()

    def generate(self, text: str, **kw) -> torch.Tensor:
        import numpy as np
        self._ensure_loaded()

        voice = kw.get("voice") or DEFAULT_VOICE
        if voice not in VOICE_PRESETS:
            logger.info(
                "Supertonic-3: unknown voice %r, falling back to %r. Valid: %s",
                voice, DEFAULT_VOICE, VOICE_PRESETS,
            )
            voice = DEFAULT_VOICE

        language = kw.get("language")
        # OmniVoice's "Auto" sentinel → SDK's language-agnostic "na"
        lang = language[:2].lower() if language and language.lower() != "auto" else "na"

        speed = float(kw.get("speed", 1.0))
        # supertonic SDK clamps to [0.7, 2.0]; do the same defensively
        speed = max(0.7, min(2.0, speed))

        total_steps = int(kw.get("num_step", 8))    # SDK accepts 5-12
        total_steps = max(5, min(12, total_steps))

        # SubprocessBackend.invoke is a synchronous IPC call (Phase 2 primitive).
        result = self._sub.invoke({
            "op": "synthesize",
            "text": text,
            "voice": voice,
            "lang": lang,
            "speed": speed,
            "total_steps": total_steps,
        })

        # result["wav"] is a float32 numpy buffer (mono); shape (n_samples,)
        wav_np = np.asarray(result["wav"], dtype=np.float32)
        wav = torch.from_numpy(wav_np).float()
        if wav.ndim == 1:
            wav = wav.unsqueeze(0)
        elif wav.ndim == 2 and wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
        return wav
```

### Pattern 2: Pin HuggingFace model revision by SHA, not tag (TTS-03)

**What:** Use `huggingface_hub.snapshot_download(..., revision="<40-char-SHA>")` inside the sidecar so a model card update on the upstream `main` branch cannot silently change behavior.

**When to use:** Every engine in this milestone that downloads model weights from HuggingFace.

**Example:**

```python
# backend/engines/supertonic3/sidecar.py
# Runs inside the Supertonic-3 subprocess venv.
# Source: huggingface_hub.snapshot_download docs (verified via in-tree usage)

import os
from huggingface_hub import snapshot_download
from supertonic import TTS

REVISION = os.environ["SUPERTONIC3_REVISION"]    # 40-char SHA from constants.py

def load_tts() -> TTS:
    # Pin by SHA — TTS-03. snapshot_download is idempotent + uses HF_HUB_CACHE.
    model_path = snapshot_download(
        repo_id="Supertone/supertonic-3",
        revision=REVISION,        # MUST be a commit SHA, not a tag/branch
        # token=os.environ.get("HF_TOKEN"),   # inherited from Phase 1 resolver
    )
    # SDK accepts an explicit model_path so we can point at the pinned snapshot
    # (this is the API surface — see Open Q3 for confirmation that the
    # SDK signature is `TTS(model_path=...)` vs `TTS(auto_download=True)` only)
    return TTS(model_path=model_path)
```

### Pattern 3: Mirror cascade in `bootstrap.rs` (INST-07 through INST-11)

**What:** Try mirrors in order, set timeout/retry env vars, fall back to `only-system` Python.

**When to use:** Once, in `ensure_venv_ready` between the existing `creating_venv` and `installing_deps` stages.

**Example:**

```rust
// frontend/src-tauri/src/bootstrap.rs  (Wave 2 delta — sketch)
// Source: existing bootstrap.rs patterns + uv env-var docs

use std::fs;
use std::path::PathBuf;
use serde::Deserialize;

#[derive(Deserialize)]
struct MirrorList {
    /// Ordered list of github-proxy URLs (allow-list, INST-09).
    /// Each acts as a prefix replacement for
    /// `https://github.com/astral-sh/python-build-standalone/releases/download`.
    python_build_standalone_mirrors: Vec<String>,
    /// PyPI mirrors by region. Default index URL replacement.
    pypi_default_index: std::collections::HashMap<String, String>,
}

fn load_mirror_list<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<MirrorList> {
    let res_dir = app.path().resource_dir().ok()?;
    let path = res_dir.join("mirrors.json");
    let text = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Probe for a usable system Python ≥3.11. Returns the binary path if found.
/// INST-07 fallback step.
fn probe_system_python_311() -> Option<PathBuf> {
    let candidates = if cfg!(windows) {
        vec!["py", "python3.11", "python3", "python"]
    } else {
        vec!["python3.11", "python3.12", "python3.13", "python3"]
    };
    for cand in candidates {
        let out = std::process::Command::new(cand)
            .args(["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"])
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                // Re-run to get the path
                let where_cmd = if cfg!(windows) { "where" } else { "which" };
                if let Ok(w) = std::process::Command::new(where_cmd).arg(cand).output() {
                    let line = String::from_utf8_lossy(&w.stdout);
                    if let Some(first) = line.lines().next() {
                        return Some(PathBuf::from(first.trim()));
                    }
                }
            }
        }
    }
    None
}

/// Wrap the `uv venv` step with a mirror cascade. Returns Ok on first success.
/// INST-07, INST-11.
fn run_uv_venv_with_cascade<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    uv_path: &Path,
    project_dir: &Path,
    region: &str,
) -> Result<(), String> {
    let mirrors = load_mirror_list(app)
        .map(|m| m.python_build_standalone_mirrors)
        .unwrap_or_default();

    // Common env applied to every attempt (INST-11)
    let common_env: Vec<(&str, &str)> = vec![
        ("UV_HTTP_TIMEOUT", "120"),
        ("UV_HTTP_CONNECT_TIMEOUT", "30"),
        ("UV_HTTP_RETRIES", "5"),
    ];

    // Attempt 1..N: GitHub direct (region=global only) → each mirror in order
    let attempts: Vec<Option<&str>> = if region == "global" {
        let mut v = vec![None];   // direct
        v.extend(mirrors.iter().map(|m| Some(m.as_str())));
        v
    } else {
        // Restricted regions: skip direct, go straight to mirrors
        mirrors.iter().map(|m| Some(m.as_str())).collect()
    };

    for attempt in &attempts {
        let mut cmd = std::process::Command::new(uv_path);
        for (k, v) in &common_env { cmd.env(k, v); }
        if let Some(mirror) = attempt {
            cmd.env("UV_PYTHON_INSTALL_MIRROR", mirror);
            log::info!("Trying python-build-standalone mirror: {}", mirror);
        } else {
            log::info!("Trying direct GitHub download for python-build-standalone");
        }
        cmd.args(["venv", "--python", "3.11", "--managed-python"])
            .current_dir(project_dir);
        let status = run_streaming(app, "creating_venv", &mut cmd);
        if matches!(status, Ok(ref s) if s.success()) {
            return Ok(());
        }
        log::warn!("Attempt failed (mirror={:?}); trying next.", attempt);
    }

    // Final fallback: only-system Python ≥3.11
    log::warn!("All managed-Python mirrors failed — falling back to only-system");
    let sys_py = probe_system_python_311()
        .ok_or_else(|| format!(
            "All mirrors failed and no system Python ≥3.11 found on PATH. \
             Install Python 3.11+ from python.org or your distro package manager, \
             then click Retry. See docs/install/restricted-networks.md."
        ))?;
    log::info!("Using system Python: {}", sys_py.display());

    let mut cmd = std::process::Command::new(uv_path);
    for (k, v) in &common_env { cmd.env(k, v); }
    cmd.args([
        "venv",
        "--python", sys_py.to_str().unwrap_or("python3"),
        "--python-preference", "only-system",
    ]).current_dir(project_dir);
    let status = run_streaming(app, "creating_venv", &mut cmd);
    if matches!(status, Ok(ref s) if s.success()) {
        Ok(())
    } else {
        Err(format!("uv venv failed even with only-system: {:?}", status))
    }
}

/// Region-aware PyPI default-index env var. INST-10 still applies (--frozen).
fn pypi_env_for_region(region: &str, mirrors: &Option<MirrorList>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(m) = mirrors {
        if let Some(url) = m.pypi_default_index.get(region) {
            // Replaces deprecated UV_INDEX_URL (uv 0.4.23+)
            out.push(("UV_DEFAULT_INDEX".into(), url.clone()));
        }
    }
    out
}
```

### Pattern 4: License acceptance gate (TTS-05)

**What:** Persist a single boolean in the existing `settings` table (Phase 1's `settings_store`). Surface a modal in the Engines settings panel. Refuse `is_available()` until accepted.

**When to use:** Any engine whose model card requires acknowledgement (Supertonic-3 OpenRAIL-M today; future engines with similar restrictive licenses).

**Example:**

```python
# backend/services/settings_store.py (Phase 1 module — extended in Phase 3)
# Add a helper for license flags. Encrypted column reuse.

def get_license_accepted(engine_id: str) -> bool:
    return bool(get_setting(f"{engine_id}_license_accepted", default=False))

def set_license_accepted(engine_id: str, accepted: bool) -> None:
    set_setting(f"{engine_id}_license_accepted", accepted)
```

```typescript
// frontend/src/components/SupertonicLicenseDialog.jsx (NEW)
// Renders model + code license + Accept button. Calls Tauri command.
// Same Dialog/modal primitive as the rest of the Settings UI.
import { invoke } from "@tauri-apps/api/core";

async function accept() {
  await invoke("set_license_accepted", { engine_id: "supertonic3", accepted: true });
  // refresh engine status badge
}
```

### Anti-Patterns to Avoid

- **Hard-coded mirror URLs in `bootstrap.rs`.** Mirrors break and rotate. Use `mirrors.json` so rotation does not require a release (INST-08). The current bootstrap.rs:454 hard-codes `https://mirrors.aliyun.com/pypi/simple/` — Wave 2 moves it into `mirrors.json`.
- **`UV_INDEX_URL`.** Deprecated since uv 0.4.23. Use `UV_DEFAULT_INDEX`. bootstrap.rs:454 still uses the deprecated name today.
- **Pinning Supertonic-3 by tag.** The upstream model card had 4 commits in the 12 hours before research time. Tags can be moved; only a 40-char SHA is immutable.
- **Letting `supertonic` pull `onnxruntime-gpu` as well as `onnxruntime`.** TTS-06 explicitly tests for this. The `supertonic` 1.3.1 PyPI metadata declares only `onnxruntime` (CPU), not `onnxruntime-gpu` — confirmed via PyPI fetch. But verify after merge with `uv tree | grep onnxruntime`.
- **Fetching `mirrors.json` from a network URL at startup.** That URL becomes the new single point of failure. Ship `mirrors.json` in the installer; rotate via app updates.
- **Freeform mirror URL textbox in Settings.** Explicitly out of scope per REQUIREMENTS.md Out of Scope table.
- **Bundling `supertonic` weights in the Tauri installer.** Adds ~400 MB per platform for an opt-in engine. Lazy download is the right tradeoff.
- **Running Supertonic-3 in-process when other engines share the venv.** Even though Supertonic-3 has no torch/transformers dep, in-process load means uv ran `pip install supertonic` into the main venv, which adds onnxruntime/numpy version pressure. Subprocess venv per opt-in engine is the safer default Phase 2 established.
- **Treating Russia as a `region == "china"` clone.** They are genuinely different — Russia has no government-blessed PyPI/HF mirror, China has `hf-mirror.com`/Aliyun/Tsinghua. Document honestly.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Supertonic-3 ONNX session orchestration | Custom three-ONNX-file loader + tokenizer + denoiser pipeline | `supertonic` SDK | Official wrapper; handles tokenizer + latent denoiser + voice decoder chain, voice style loading, output buffer management. ~200 lines of code we don't write or maintain. |
| Model weight download with HF token + cache + retry | Custom HTTP downloader | `huggingface_hub.snapshot_download(revision=SHA)` | Already in tree, handles HF_TOKEN/HF_ENDPOINT/HF_HUB_CACHE + resumable downloads + SHA verification. |
| GitHub release mirror substitution | Custom URL rewriter | uv's `UV_PYTHON_INSTALL_MIRROR` | uv handles it natively; our code only sets the env var. |
| PyPI mirror failover | Custom retry loop | uv's built-in retry + our mirror-list cascade | Combine uv's intra-mirror retries (`UV_HTTP_RETRIES=5`) with our outer cascade (try next mirror after uv gives up). |
| System Python detection | `find_python_on_path()` ad-hoc | `python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"` probe + `which`/`where` | The probe pattern is durable; ad-hoc PATH walks miss platform-specific names like Windows's `py` launcher. |
| Subprocess engine isolation | New IPC primitive | Phase 2's `SubprocessBackend` | Phase 2 designed it. Reuse. |
| Voice preset listing | Hand-curated mapping | `VOICE_PRESETS` constant (7 entries) | Verified against supertonic README — M1/M3/M4/M5/F3/F4/F5. Stable. |
| HuggingFace model SHA discovery | Web-scraping the model card commits page | `huggingface_hub.list_repo_refs("Supertone/supertonic-3")` | Official API, returns commit SHAs programmatically. Use during release-prep to bump pinned SHA. |
| Region detection | Per-OS locale parsing | Existing `auto_detect_region()` (config.rs:106) — probes github.com with 4 s HEAD | Already in tree. Don't re-invent. |

**Key insight:** Almost every hand-rolled candidate above either (a) duplicates a Phase 1 / Phase 2 capability the OmniVoice tree already has, or (b) reinvents an env var uv already exposes. The Phase 3 surface area is therefore small: ~250 lines of Python in `backend/engines/supertonic3/`, ~150 lines of Rust additions in `bootstrap.rs`, ~50 lines of JSX for the license dialog, and a 30-line `mirrors.json`. The total new-line count for Phase 3 should be under 600 lines + tests. Anything significantly more is a sign we re-invented something.

---

## Runtime State Inventory

> Phase 3 is mostly an additive (new engine) + refactor (mirror cascade in `bootstrap.rs`) phase. There is a non-trivial state-cache surface for Supertonic-3 model weights; documenting it explicitly.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | (1) `$HF_HUB_CACHE/Supertone--supertonic-3/<SHA>/` — new on first synthesize (~400 MB). (2) `omnivoice_data/settings.db` — Phase 1's encrypted SQLite gains a `supertonic3_license_accepted` row (boolean). | (1) None — auto-created. Document size in docs/engines/supertonic-3.md. (2) Schema migration via Phase 1's `init_db()` flow; if alembic adopted by Phase 3 time, a no-op migration confirming the column is fine. |
| Live service config | None — Supertonic-3 has no external service. The Tauri `AppConfig.region` field already exists (config.rs:14) and Phase 3 adds **new behavior**, not new fields. | None. |
| OS-registered state | None — no scheduled tasks, no launchd plists, no Windows registry entries. | None. |
| Secrets / env vars | (1) `HF_TOKEN` — reused from Phase 1, no new key needed. (2) `HF_ENDPOINT` — already passed through by `backend.rs::spawn_backend`. (3) `UV_PYTHON_INSTALL_MIRROR`, `UV_HTTP_TIMEOUT`, `UV_HTTP_RETRIES`, `UV_DEFAULT_INDEX`, `UV_PYTHON_PREFERENCE` — set by `bootstrap.rs` only (subprocess scope), not persisted to user env. | None — all env vars are scoped to the uv subprocess invocation; nothing persisted to user shell. |
| Build artifacts / installed packages | (1) `supertonic` wheel in `.venv/lib/.../supertonic` — installed lazily by `uv add` from Settings UI. (2) `uv.lock` regenerated when supertonic is added — must be committed (INST-10). (3) Three ONNX files in `$HF_HUB_CACHE` (lazy, ~400 MB). | (1) Add to `uv pip list` snapshot in QA. (2) Commit `uv.lock` deltas as part of Wave 1. (3) Document for users in `docs/engines/supertonic-3.md` so they know where the weights live (and can clean up). |

**Nothing found in category:** "Live service config" and "OS-registered state" — verified by direct inspection of `frontend/src-tauri/src/*.rs`, search for Windows Task Scheduler / launchd / systemd patterns. Supertonic-3 has no upstream service component, no OAuth callbacks, no installer-time registration.

---

## Common Pitfalls

### Pitfall 1: `onnxruntime` vs `onnxruntime-gpu` double-install

**What goes wrong:** `pip install supertonic` plus a separate engine that pins `onnxruntime-gpu` causes uv to install both as separate distributions. At import time, the second-imported one wins and the first issues a noisy warning. Worse, the GPU variant requires a working CUDA toolchain at runtime — on a CPU-only machine this is just slower at best, broken at worst.

**Why it happens:** Many engines that use onnxruntime declare it as `onnxruntime` only (the CPU build). A few — e.g. some accelerated builds of Whisper-ish models — declare `onnxruntime-gpu` instead. uv resolves both as distinct distributions because they have different distribution names even though they install the same Python package.

**How to avoid:** TTS-06 explicitly tests for this. After Wave 1, run `uv pip list | grep -i onnxruntime` and assert exactly one row. If two rows appear, identify the second declarer (probably not Supertonic-3 — it declares only `onnxruntime` per PyPI metadata, confirmed today) and either pin or remove.

**Warning signs:** Python startup logs `WARNING: ONNX Runtime version is 1.X.Y, but onnxruntime-gpu version 1.X.Z was also detected`, or `ImportError: DLL load failed while importing onnxruntime_pybind11_state`.

### Pitfall 2: Model SHA on `main` drifts between research and release

**What goes wrong:** Research run pins SHA `3cadd1e`. Two weeks later, Supertone pushes 5 more commits to `main`. Our pinned SHA still works (immutable), but a careless `revision="main"` or `revision="v3.0.0"` (tag) would silently change behavior on a model card update.

**Why it happens:** HF tag movement is allowed by the platform. Model cards often have non-code commits (README polish) that don't change inference behavior but do change the SHA — making a vigilant "always pin to latest" workflow noisy.

**How to avoid:** TTS-03 says SHA, not tag — code-enforce with a constant in `backend/engines/supertonic3/constants.py`. To bump intentionally, run `huggingface_hub.list_repo_refs("Supertone/supertonic-3")` in a release-prep script, pick the latest commit on `main`, manually verify the model card hasn't changed inference contract, then update the constant in a tagged commit.

**Warning signs:** Engine smoke test outputs differ in subtle ways across runs of the same input — that's a sign the underlying weights changed.

### Pitfall 3: All mirrors fail and the only-system fallback silently picks Python 3.10

**What goes wrong:** uv accepts `--python-preference only-system` with any Python it finds. If the user has Python 3.10 on PATH (still common on Ubuntu 22.04, Debian 12), uv happily creates a venv with 3.10 — but our `pyproject.toml` says `requires-python = ">=3.11"` (verified line 13), so `uv sync` then errors out cryptically.

**Why it happens:** `--python-preference only-system` doesn't enforce a version, just a source. The version constraint comes from `pyproject.toml` and is checked at `uv sync` time, not at `uv venv` time.

**How to avoid:** Probe the system Python version explicitly before invoking `uv venv --python-preference only-system` (sketch above). If no `python3.11+` is on PATH, fail the bootstrap with a clear deeplink to `docs/install/restricted-networks.md` rather than letting uv emit its own error.

**Warning signs:** Bootstrap reaches the `installing_deps` stage and dies with a `requires-python` error referring to `>=3.11`.

### Pitfall 4: HF endpoint mirror not inherited by Supertonic-3 subprocess

**What goes wrong:** User sets `region == "china"`. Bootstrap.rs:168-173 sets `HF_ENDPOINT=https://hf-mirror.com` in `spawn_backend`. But the Supertonic-3 sidecar is spawned by `SubprocessBackend`, not by `spawn_backend` directly — a child of a child. If `SubprocessBackend.start()` does not inherit the parent's `HF_ENDPOINT` env, downloads go to `huggingface.co` directly and fail.

**Why it happens:** Python's `subprocess.Popen` inherits the current process env by default, so this should work. But Phase 2's `SubprocessBackend` might construct a clean env explicitly (e.g. to isolate venv `PATH`). If so, it must explicitly pass through `HF_ENDPOINT`, `HF_TOKEN`, `HF_HUB_CACHE`.

**How to avoid:** Add a Phase 2 dependency assertion in Phase 3's plan: `SubprocessBackend.start()` MUST forward `HF_ENDPOINT`, `HF_TOKEN`, `HF_HUB_CACHE`, `HF_HOME`. If Phase 2 didn't ship that, file a Wave 1 task to extend it.

**Warning signs:** Supertonic-3 first-synthesize in `region == "china"` hangs at the download step, network logs show traffic to `huggingface.co` instead of `hf-mirror.com`.

### Pitfall 5: Adding `supertonic` to optional-dependencies bumps existing pins

**What goes wrong:** `uv add supertonic` re-resolves the whole graph and bumps an unrelated transitive dep (e.g. `numpy` 2.1 → 2.3), which then conflicts with an engine in the main venv. CI smoke breaks downstream.

**Why it happens:** `uv add` runs a full resolve. Optional-dependency groups are part of the resolve unless `--no-sync` is passed.

**How to avoid:** Add the dep with `uv add --optional supertonic supertonic==1.3.1 --no-sync`, then run `uv lock` and inspect the diff carefully. If unrelated pins move, pin them explicitly to prevent drift.

**Warning signs:** `uv.lock` diff in the Wave 1 PR touches more than `supertonic` + its direct deps.

### Pitfall 6: License acceptance dialog and `is_available()` race

**What goes wrong:** User clicks "Accept" → frontend calls `set_license_accepted("supertonic3", true)` → user immediately tries to generate. But `is_available()` reads from `settings_store` which has not yet flushed the SQLite write. First synthesize returns "license not accepted".

**Why it happens:** SQLite writes are usually synchronous via `commit()`, but if the settings store uses an async write queue (Phase 1 detail), there's a window.

**How to avoid:** Make `set_license_accepted` block until the SQLite commit returns. Verify by reading immediately after writing.

**Warning signs:** Intermittent "license not accepted" errors immediately after clicking Accept.

### Pitfall 7: First-run model download (400 MB) blocks UI without progress

**What goes wrong:** User selects Supertonic-3, hits Generate, and the UI hangs for 1-5 minutes (depending on network) while `huggingface_hub.snapshot_download` runs.

**Why it happens:** `snapshot_download` is synchronous. Without explicit progress reporting, the dub pipeline `generate()` call blocks the request.

**How to avoid:** Reuse the existing model-download progress UI that other engines surface (search for `download_progress` in tts_backend.py — probably needs verification against Phase 2 patterns). At minimum, show a backend log line every 50 MB so the splash log panel updates.

**Warning signs:** First Supertonic-3 generation looks frozen; user files a "frozen UI" bug.

### Pitfall 8: `mirrors.json` ships in the wrong resource path

**What goes wrong:** Tauri bundles `resources/` differently on macOS (.app/Contents/Resources), Linux (AppImage internals), and Windows (next to .exe). Code that hard-codes a path under one of these breaks the others.

**Why it happens:** Cross-platform path resolution is brittle; existing bootstrap.rs already wrestles with `flat` vs `_up_/_up_` resource layouts (bootstrap.rs:362-374).

**How to avoid:** Use `app.path().resource_dir()` and check both candidate layouts (the existing pattern in bootstrap.rs). Add a startup assertion that `mirrors.json` is readable from the resolved path; fail the bootstrap with a clear error if not.

**Warning signs:** Bootstrap fails on one platform only, with a `mirrors.json not found` message.

---

## Code Examples

(All major code examples are in the **Architecture Patterns** section above. Specifically:)

- **Pattern 1** — `Supertonic3Backend` Python class (TTS-01, TTS-04, TTS-05)
- **Pattern 2** — Model SHA pinning via `snapshot_download(revision=...)` (TTS-03)
- **Pattern 3** — Mirror cascade Rust sketch in `bootstrap.rs` (INST-07, INST-08, INST-09, INST-11)
- **Pattern 4** — License acceptance gate (TTS-05)

Additionally, the **`mirrors.json` allow-list shape** for INST-08, INST-09:

```json
{
  "_comment": "Allow-list of mirror URLs. User cannot edit this file at runtime (read-only after install). Update via app release. INST-09 forbids freeform mirror input.",
  "python_build_standalone_mirrors": [
    "https://ghproxy.net/https://github.com/astral-sh/python-build-standalone/releases/download",
    "https://ghfast.top/https://github.com/astral-sh/python-build-standalone/releases/download",
    "https://gitmirror.com/https://github.com/astral-sh/python-build-standalone/releases/download"
  ],
  "pypi_default_index": {
    "china": "https://mirrors.aliyun.com/pypi/simple/",
    "russia": "https://pypi.org/simple/",
    "restricted": "https://pypi.org/simple/",
    "global": "https://pypi.org/simple/"
  },
  "hf_endpoint": {
    "china": "https://hf-mirror.com",
    "russia": "https://huggingface.co",
    "restricted": "https://huggingface.co",
    "global": "https://huggingface.co"
  }
}
```

Note: each `python_build_standalone_mirrors` entry is the **full prefix** that uv substitutes for the default. Verified against `UV_PYTHON_INSTALL_MIRROR` semantics (the env var replaces the prefix `https://github.com/astral-sh/python-build-standalone/releases/download`).

**Bootstrap.rs delta for INST-10 enforcement** (already mostly in tree):

```rust
// bootstrap.rs — change at lines 441-451
let has_lockfile = project_dir.join("uv.lock").is_file();
if !has_lockfile {
    // INST-10 — refuse to install without a lockfile rather than resolve from scratch
    fail(progress, "uv.lock missing from bundle — refusing to install without hash verification. \
                    Reinstall OmniVoice from a signed release artifact.");
    return None;
}
sync_cmd.args(["sync", "--frozen", "--no-dev", "--verbose"])
    .current_dir(&project_dir);
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `HfFolder.save_token()` | `huggingface_hub.login()` | `huggingface_hub` 1.x (2024+) | Phase 1 already adopted; Phase 3 just inherits. |
| `hf_transfer` for downloads | `hf-xet` (auto when available) | `huggingface_hub` 1.12 | Already in tree (`uv.lock` line 1647). No action. |
| `UV_INDEX_URL` | `UV_DEFAULT_INDEX` | uv 0.4.23 | bootstrap.rs:454 still uses deprecated name — Wave 2 migrates. |
| Bundling Python in installer | uv `--managed-python` + mirror cascade | uv 0.2.35 added `UV_PYTHON_INSTALL_MIRROR` | Phase 3 establishes the cascade. |
| Single-mirror China-only fallback | Region-aware mirror cascade for China / Russia / restricted / global | This phase | INST-07..11 — main Phase 3 outcome. |
| `HfFolder` everywhere | `huggingface_hub.snapshot_download(revision=SHA)` for model pinning | TTS-03 establishes this | Standard for v0.3+ model integrations. |

**Deprecated / outdated:**

- `UV_INDEX_URL` — replaced by `UV_DEFAULT_INDEX` (uv 0.4.23). bootstrap.rs:454 still uses the old name.
- `hf_transfer` — replaced by `hf-xet`. Not a Phase 3 concern, but mentioned because the migration is transparent and we want to be sure we're not accidentally calling `hf_transfer.*` anywhere new.
- CLAUDE.md's Capability 4 pin of `supertonic==1.2.3` (May 15, 2026) — superseded by `1.3.1` (May 18, 2026). See Open Question Q1.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 2's `SubprocessBackend` exists with a `start()` method that forwards `HF_ENDPOINT`, `HF_TOKEN`, `HF_HUB_CACHE`, `HF_HOME` to the child env | Architecture Patterns (Pattern 1, Pitfall 4) | If Phase 2 doesn't ship that, Phase 3 must add it — adds a small task to Wave 1. **Verify with Phase 2 planner before Wave 1 starts.** |
| A2 | `cryptography.fernet` (or equivalent in Phase 1's `settings_store`) is suitable for an additional `supertonic3_license_accepted` boolean column — no new schema | Architecture Patterns (Pattern 4) | If Phase 1's settings_store schema is fixed-key, Phase 3 needs a small migration. Verify by reading Phase 1's `01-RESEARCH.md` settings_store section. |
| A3 | `onnxruntime` 1.24.4 (in uv.lock) is compatible with whatever onnxruntime version `supertonic` 1.3.1 requires | Standard Stack | If `supertonic` 1.3.1 pins `onnxruntime>=1.25` (released after our lock), `uv lock --upgrade-package onnxruntime` will be needed. Low risk — onnxruntime 1.24.4 is recent (2026-03-17). |
| A4 | `mirrors.json` resource dir resolution works with Tauri 2 `app.path().resource_dir()` on all four platforms (macOS .app, Windows x64, AppImage, .deb) | Architecture Patterns (Pattern 3, Pitfall 8) | Already used in tree (bootstrap.rs:361-374) so confidence is HIGH, but a CI smoke test must validate. |
| A5 | The three github-proxy mirrors (`ghproxy.net`, `ghfast.top`, `gitmirror.com`) are live and serve `python-build-standalone` releases | Code Examples (mirrors.json) | If any are dead, the cascade still works (it skips to the next). But the `dautovri/mirrors-china` source could not confirm 2026 status for ghfast.top — the planner should manually `curl -I` each before merge. |
| A6 | Supertonic-3 `synthesize()` returns mono float32 numpy at 44.1 kHz | Architecture Patterns (Pattern 1) | If it returns stereo or a different dtype, the wrapper needs an extra reshape — minor, but observable in the smoke test. |
| A7 | `supertonic` 1.3.1 supports `model_path=` kwarg in `TTS(...)` for pinned SHAs (vs only `auto_download=True`) | Code Examples (Pattern 2) | If only `auto_download=True` is supported, we must `snapshot_download(...)` first and then `TTS()` does its own discovery from `HF_HUB_CACHE`. Cosmetic difference. |
| A8 | The user has `python3.11+` on PATH on at least 60% of restricted-network machines (justifying the `only-system` fallback as a useful final step rather than a last-ditch) | Pitfall 3, Architecture | If only 10% have it, the fallback is more often than not a dead end and we should at least show a clear "install Python 3.11 from python.org" deeplink. Either way, the fallback is strictly better than the current failure mode. |
| A9 | CLAUDE.md's `supertonic==1.2.3` pin can be bumped to `1.3.1` without breaking the API in our wrapper | Open Question Q1, Standard Stack | LOW risk — `1.3.1` is 3 days after 1.2.3 on PyPI; semantic-versioned, same publisher. But the API signature (`TTS()` constructor kwargs in particular) must be verified. |

---

## Open Questions

1. **Which `supertonic` version do we pin? `1.2.3` (CLAUDE.md) or `1.3.1` (latest as of 2026-05-18)?**
   - What we know: PyPI says `1.3.1` was published `2026-05-18` (today, our research date). CLAUDE.md was written before that release. Both versions are from `Supertone Inc.`, both MIT, both declare the same 4 deps.
   - What's unclear: Whether `1.3.1` changes API signatures or behavior in a way our wrapper relies on. Whether it ships any patches to the model loader that would affect the 400 MB download.
   - Recommendation: **Pin to `1.3.1`** in Wave 1 unless changelog shows a regression. Run a quick `uv add supertonic==1.3.1 --no-sync && uv lock` smoke locally to confirm clean resolve. If 1.3.1 is broken, fall back to `1.2.3` (still on PyPI). Either way, **do this verification BEFORE the planner locks the optional-dependency string** — a 3-line `pyproject.toml` change is dirt cheap to redo if needed.

2. **What is the exact commit SHA we pin for the Supertonic-3 model revision (TTS-03)?**
   - What we know: As of research time, `main` is at `3cadd1e` (Polish audio sample layout). The "Initial Supertonic 3 release" SHA was made 12 days ago but we don't have the full 40-char SHA from a web view (the truncated `724fb5a` is visible).
   - What's unclear: Whether the initial release SHA or the latest layout-polish SHA is the right pin. The non-code commits since release shouldn't affect inference — but we'd want to verify by checking which commits touched the `.onnx` files vs. only the README.
   - Recommendation: Plan to run `huggingface_hub.list_repo_refs("Supertone/supertonic-3")` and `huggingface_hub.list_repo_commits("Supertone/supertonic-3", revision="main")` in a Wave 1 prep script, identify the most recent commit whose blob diff includes any `.onnx` or `tokenizer.json` change, and pin that SHA. Stash the chosen SHA in `backend/engines/supertonic3/constants.py::PINNED_REVISION_SHA`.

3. **Does the `supertonic` SDK accept a `model_path=` kwarg in `TTS(...)` for using a pre-downloaded snapshot, or does it always re-discover from `HF_HUB_CACHE` when `auto_download=False`?**
   - What we know: The README example uses `TTS(auto_download=True)`. PyPI metadata mentions a `model_path=` flag indirectly. The GitHub repo (`supertone-inc/supertonic`) wasn't fully crawled for full API signatures.
   - What's unclear: Whether we can bypass the SDK's auto-download by pre-fetching via `huggingface_hub.snapshot_download(revision=SHA)` and pointing `TTS()` at the local path.
   - Recommendation: Wave 1 dev verifies in a 5-minute spike. If `TTS()` cannot take an explicit path, we set `HF_HUB_CACHE` and pre-fetch the specific SHA — the SDK then finds the cached snapshot.

4. **Are the three github-proxy mirrors (`ghproxy.net`, `ghfast.top`, `gitmirror.com`) currently live and serving `python-build-standalone` releases as of 2026-05-18?**
   - What we know: `dautovri/mirrors-china` mentions general gh-proxy patterns but does not confirm 2026 status of specific mirrors. `ghproxy.net` is referenced in OmniVoice's own `config.rs` (line 99) so it's at least operational at some point in the recent past.
   - What's unclear: Which subset is currently usable in production. Mirrors come and go.
   - Recommendation: Wave 2 dev runs `curl -I https://ghproxy.net/https://github.com/astral-sh/python-build-standalone/releases/latest` (and equivalents for ghfast.top, gitmirror.com) to confirm liveness. Drop any 4xx/5xx from `mirrors.json`. Document any drop in the `restricted-networks.md` changelog.

5. **Is Phase 2's `SubprocessBackend.start()` env-forwarding behavior compatible with Phase 3's HF env needs?**
   - What we know: Phase 2 has no PLAN.md yet — Phase 3 research is happening before Phase 2 plans. The pattern in Phase 2's roadmap entry says `mp.get_context("spawn")` for IndexTTS isolation.
   - What's unclear: Whether `SubprocessBackend.start()` constructs a clean env (in which case it must explicitly pass HF_TOKEN/HF_ENDPOINT/HF_HUB_CACHE/HF_HOME) or inherits parent env (in which case Phase 3 is free).
   - Recommendation: Add a Wave 1 prerequisite task — **plan-time sync with Phase 2 planner**. If Phase 2 builds a clean-env subprocess, Phase 2 must be extended to pass through the HF triplet. Coordinate via STATE.md before Wave 1 starts.

6. **What's the user-facing UX for first-run Supertonic-3 model download (~400 MB)?**
   - What we know: Existing model downloads (omnivoice main model, kittentts) use the splash log panel for visibility. The dub pipeline `generate()` call is synchronous from the caller's perspective.
   - What's unclear: Whether we add an explicit "downloading Supertonic-3" toast that opens on first-enable, or rely on the existing engine-card state machine.
   - Recommendation: Plan a 30-line frontend addition — a toast that fires when the engine card transitions to "downloading" (already a state in the engine registry). Reuse existing UI primitives.

7. **Do we surface `total_steps` (quality vs speed knob, range 5-12) and `speed` (range 0.7-2.0) in the Settings UI, or hide behind defaults?**
   - What we know: The supertonic SDK exposes both. Our `TTSBackend.generate()` already accepts `num_step=` and `speed=` kwargs.
   - What's unclear: Whether the Engines settings panel surfaces these as sliders or hides them.
   - Recommendation: Hide initially (Wave 1 defaults: `total_steps=8`, `speed=1.0`). Add to Settings UI in v0.4 if users ask. Easier to add later than to deprecate.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `python3.11+` (system) | INST-07 `only-system` fallback path | ✓ on dev box `[VERIFIED]`; **unknown** on user machines (varies) | 3.11 minimum, 3.12/3.13 OK | None — user installs from python.org / distro pkg manager. Failure UI deeplinks to `docs/install/restricted-networks.md`. |
| `uv` binary | Bootstrap (all paths) | ✓ pinned via `UV_VERSION = "0.11.7"` | 0.11.7 `[VERIFIED: tools.rs:18]` | uv is downloaded on first run from its own GitHub releases by `tools.rs::install_uv_standalone` — already in tree. |
| `onnxruntime` 1.24.4 | Supertonic-3 inference | ✓ in uv.lock `[VERIFIED]` | 1.24.4 (cp311/cp312/cp313/cp314 manylinux + macOS arm64 + win amd64/arm64) | None needed. |
| `supertonic` PyPI package | Supertonic-3 SDK | ✗ not yet added | 1.3.1 latest, 1.2.3 also available | None — opt-in install via `uv add`. |
| `huggingface_hub` ≥1.12 | Model downloads | ✓ transitive | 1.12.x `[ASSUMED — pinned by transformers>=5.3.0]` | None needed. |
| Supertonic-3 model on HuggingFace | First synthesize | ✓ public at `huggingface.co/Supertone/supertonic-3` `[VERIFIED]` | Multiple commits — see Open Q2 for SHA pinning | None — model is required; if HF is unreachable, the engine cannot work. Documented in engine card. |
| `ghproxy.net`, `ghfast.top`, `gitmirror.com` | INST-07 mirror cascade | **Unknown 2026 status** `[ASSUMED]` | n/a | Each falls back to the next; final fallback is `only-system`. |
| `mirrors.aliyun.com/pypi` | China region PyPI | ✓ already used in tree | Stable mirror per Aliyun SLA | `pypi.org` direct. |
| `hf-mirror.com` | China region HF | ✓ public, padeoe-maintained `[VERIFIED: hf-mirror.com homepage loads, fetched today]` | Stable per padeoe public-welfare project | `huggingface.co` direct. |

**Missing dependencies with no fallback:** none (every path has a documented fallback or is documented as user-side responsibility).

**Missing dependencies with fallback:** the three github-proxy mirrors fall back to each other and ultimately to `only-system` Python.

---

## Validation Architecture

Per `.planning/config.json` line 19 (`workflow.nyquist_validation: true`).

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `pytest` (already in pyproject.toml dev deps) |
| Config file | `pyproject.toml` `[tool.pytest.ini_options]` (verified existing) |
| Quick run command | `uv run pytest tests/test_supertonic3.py -x -q` |
| Full suite command | `uv run pytest tests/ -x` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TTS-01 | Supertonic3Backend registers in `_REGISTRY`, returns ok from `is_available()` after install + license accept | unit | `uv run pytest tests/test_supertonic3.py::test_is_available_after_license -x` | ❌ Wave 1 |
| TTS-02 | Optional-dep declaration shape: `uv pip list \| grep supertonic` shows the right version | smoke | `uv run pytest tests/test_supertonic3.py::test_optional_dep_pin -x` | ❌ Wave 1 |
| TTS-03 | Model SHA constant matches an actual HF revision; `huggingface_hub.list_repo_refs` includes it | unit | `uv run pytest tests/test_supertonic3.py::test_sha_resolves -x` | ❌ Wave 1 |
| TTS-04 | `is_available()` returns `(True, "ready (CPU-only via onnxruntime)")` on a CPU-only test runner; never claims `cuda` or `mps` | unit | `uv run pytest tests/test_supertonic3.py::test_cpu_only_honest -x` | ❌ Wave 1 |
| TTS-05 | `is_available()` returns False with license-acceptance hint when license flag is False; turns True when flipped | unit | `uv run pytest tests/test_supertonic3.py::test_license_gate -x` | ❌ Wave 1 |
| TTS-06 | Smoke: 3 sec × 3 languages (en, ja, ru), no onnxruntime double-install warning, output > 0 samples, sample rate == 44.1 kHz | integration | `uv run pytest tests/test_supertonic3.py::test_smoke_3langs_3sec -x` (slow; requires real model download — gate on `OMNIVOICE_SMOKE=1`) | ❌ Wave 1 |
| INST-07 | Mirror cascade: simulate first mirror failing, verify second mirror is attempted | Rust unit | `cd frontend/src-tauri && cargo test bootstrap::tests::test_cascade_skips_failed -- --nocapture` | ❌ Wave 2 |
| INST-08 | `mirrors.json` is shipped in bundle; `app.path().resource_dir()` resolves it on all platforms | Rust integration | `cd frontend/src-tauri && cargo test bootstrap::tests::test_mirrors_json_loadable` | ❌ Wave 2 |
| INST-09 | Tauri command `set_region` rejects unknown values (validates against `VALID_REGIONS`); no command exists for entering freeform mirror URL | Rust unit | `cd frontend/src-tauri && cargo test config::tests::test_region_allowlist` | ✓ partial (VALID_REGIONS exists; need explicit test) |
| INST-10 | `bootstrap.rs` refuses to run `uv sync` without a lockfile in the bundle (no silent fallback to unfrozen resolve) | Rust unit | `cd frontend/src-tauri && cargo test bootstrap::tests::test_frozen_required` | ❌ Wave 2 |
| INST-11 | `UV_HTTP_TIMEOUT=120` and `UV_HTTP_RETRIES=5` are set on every `uv` invocation in `bootstrap.rs` | Rust unit | `cd frontend/src-tauri && cargo test bootstrap::tests::test_http_env_set` | ❌ Wave 2 |

### Sampling Rate

- **Per task commit:** `uv run pytest tests/test_supertonic3.py -x -q` (skip TTS-06 smoke unless `OMNIVOICE_SMOKE=1` is set, since it downloads 400 MB)
- **Per wave merge:** `uv run pytest tests/ -x` + `cd frontend/src-tauri && cargo test bootstrap config`
- **Phase gate:** Full Python suite + all Rust tests green, plus the Phase 0 GATE-03 release-smoke on macOS / Windows / Linux installer-built apps before `/gsd:verify-work`.

### Wave 0 Gaps

- [ ] `tests/test_supertonic3.py` — covers TTS-01 through TTS-06 (Wave 1)
- [ ] `frontend/src-tauri/src/bootstrap.rs` test module — covers INST-07, INST-08, INST-10, INST-11 (Wave 2)
- [ ] `frontend/src-tauri/src/config.rs` test for region allow-list (already partly present; needs explicit assertion test)
- [ ] `tests/conftest.py` — add a `mock_settings_store` fixture if Phase 1's settings_store doesn't already provide one (the `test_license_gate` test needs to mock `get_setting` cleanly)
- [ ] Framework install: none — `pytest` is already in dev deps. Rust testing is via `cargo test`, already wired.

---

## Security Domain

Per CLAUDE.md constraints and REQUIREMENTS.md INST-09 (allow-list only).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Reuse Phase 1's HF token resolver. Supertonic-3 needs a token only if the model becomes gated in the future (currently public); the resolver handles it transparently. |
| V3 Session Management | no | No sessions; Supertonic-3 is stateless inference. |
| V4 Access Control | yes | License acceptance gate (TTS-05) prevents engine use without consent. Settings → Engines panel is the only place the gate can be flipped. |
| V5 Input Validation | yes | (1) `region` value validated against `VALID_REGIONS` allow-list (config.rs:142) — Phase 3 extends, does not weaken. (2) `voice` parameter validated against `VOICE_PRESETS`. (3) `mirrors.json` is read-only after install — no runtime user input. |
| V6 Cryptography | yes | (1) `uv.lock` hash-pinned — every wheel SHA-256 verified by uv on install (INST-10). (2) HF model weight downloads are SHA-pinned by revision (TTS-03). (3) License-acceptance flag stored in Phase 1's encrypted SQLite column. |
| V7 Error Handling | yes | Bootstrap-failure messages MUST NOT leak the user's `HF_TOKEN` or system Python paths containing usernames. Phase 1's logging redactor handles HF tokens; Phase 3 must verify same applies to bootstrap log emission (`bootstrap.rs::emit_log`). |
| V8 Data Protection | yes | Supertonic-3 model weights and tokenizer stored in `$HF_HUB_CACHE` — same protection as all other HF-cached models. Nothing user-secret is added by Phase 3. |
| V10 Communications | yes | Mirrors are HTTPS-only — verified by `https://` prefix in `mirrors.json`. uv enforces HTTPS for PyPI by default. |
| V14 Configuration | yes | `mirrors.json` is shipped read-only in the installer bundle (V14.1.2 — secure defaults). No runtime mutation. |

### Known Threat Patterns for `Rust + Python + Tauri` Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Mirror hijack (DNS poisoning) | Tampering | uv `--frozen` + `uv.lock` SHA-256 hash verification of every wheel (INST-10). A malicious mirror serving a tampered wheel fails the lock check. |
| Cross-ecosystem package confusion (npm package named `supertonic` masquerading) | Spoofing | Plan-time slopcheck (Package Legitimacy Audit above) — verify `supertonic` exists on PyPI under publisher `Supertone Inc.` and confirm no namesake on npm. |
| Tag-mutation attack on HF model | Tampering | Pin by 40-char commit SHA (TTS-03), never by tag/branch. SHA is content-addressable in git. |
| Freeform mirror URL → exfiltration of user's PyPI session / pip cache | Spoofing + Information Disclosure | Allow-list only (INST-09); UI has no freeform input. |
| `mirrors.json` poisoning if loaded from a network URL at runtime | Tampering | Ship in installer bundle, never fetch at runtime. |
| HF token leaked to a mirror (if a mirror logged auth headers) | Information Disclosure | Mirrors are PyPI / GitHub-release only — neither needs `HF_TOKEN`. HF downloads bypass mirrors and go to `HF_ENDPOINT` (real HF or hf-mirror.com); set in `backend.rs` not in `bootstrap.rs`. |
| ONNX model deserialization (malicious .onnx) | Tampering / Code Execution | Mitigated by HF SHA pin + the fact that onnxruntime parses ONNX into a typed graph (no Python pickle); risk is in custom op extensions, which `supertonic` does not register. |
| License-acceptance gate bypass via direct SQLite edit | Elevation of Privilege | Out of scope — a user who can edit their own SQLite is the same user clicking Accept. The gate is for honest acknowledgment, not a security boundary. |
| `only-system` Python is a malicious binary on PATH | Tampering / Code Execution | The user's system PATH is the user's responsibility. Document in `docs/install/restricted-networks.md`. |

---

## Project Constraints (from CLAUDE.md)

- **Existing engine compatibility:** Users with installed IndexTTS / CosyVoice etc. must not have to reinstall. Phase 3 is additive; verified by the `_REGISTRY` extension pattern.
- **Cross-platform parity:** macOS Apple Silicon + Intel, Windows x64, Linux AppImage + .deb. Supertonic-3 is CPU-only ONNX, so all platforms work identically. Mirror cascade runs in Rust → all platforms.
- **Backward-compatible project data:** `omnivoice_data/` continues working. Phase 3 adds a single key (`supertonic3_license_accepted`) via Phase 1's settings_store path — backward compatible by construction (a missing key reads as False default).
- **Local-first guarantee preserved:** Supertonic-3 runs entirely on the user's machine. Mirror traffic is to PyPI / GitHub-release / HuggingFace mirrors only — same trust boundary as v0.2.7. No new third-party telemetry endpoint.
- **Beta release cadence:** No incremental tags. Phase 3 merges to `main` like every other phase, ships in the eventual `v0.3.0` tag.
- **Recommended Stack pre-vetted:** CLAUDE.md Capabilities 3 (`uv` env vars) and 4 (Supertonic-3) — fully respected; only the version pin (`1.2.3` vs `1.3.1`) is up for discussion per Open Q1.
- **What NOT to Use compliance:** Phase 3 does not use `HfFolder.save_token`, `setx` for HF token, PAT-based GitHub Issues posting, `sentry-tauri`, `hf_transfer`, `--python-preference managed` without mirrors, or Material for MkDocs. Verified each.
- **GSD Workflow Enforcement:** All Phase 3 edits go through `/gsd-execute-phase` per CLAUDE.md GSD section.

---

## Sources

### Primary (HIGH confidence)

- [PyPI metadata for `supertonic`](https://pypi.org/pypi/supertonic/json) — verified `1.3.1` released 2026-05-18, publisher `Supertone Inc.`, MIT, declared deps `onnxruntime/numpy/soundfile/huggingface-hub`. Fetched 2026-05-18 during this research session.
- [HuggingFace `Supertone/supertonic-3` model card](https://huggingface.co/Supertone/supertonic-3) — 31 languages, ~99M params, CPU-only ONNX, MIT (code) / OpenRAIL-M (model), preset voices M1+M3-5+F3-5. Fetched 2026-05-18.
- [HuggingFace `Supertone/supertonic-3` commit history](https://huggingface.co/Supertone/supertonic-3/commits/main) — 5 commits, latest `3cadd1e` (8 hours before research). Fetched 2026-05-18.
- [`supertone-inc/supertonic` GitHub README](https://github.com/supertone-inc/supertonic) — API signature `TTS(auto_download=True)`, `get_voice_style(voice_name=)`, `synthesize(text, lang, voice_style, total_steps, speed)`. Fetched 2026-05-18.
- [uv environment variables reference](https://docs.astral.sh/uv/reference/environment/) — `UV_PYTHON_INSTALL_MIRROR` (v0.2.35+, URL is a prefix replacement), `UV_HTTP_TIMEOUT` (default 30 s), `UV_HTTP_RETRIES` (default 3, v0.7.21+), `UV_DEFAULT_INDEX` (v0.4.23+, replaces deprecated `UV_INDEX_URL`), `UV_PYTHON_PREFERENCE` (v0.3.2+). Fetched 2026-05-18.
- [`hf-mirror.com` homepage](https://hf-mirror.com/) — public-welfare HF mirror by `padeoe`, stable endpoint `https://hf-mirror.com`. Fetched 2026-05-18.
- In-tree code: `frontend/src-tauri/src/bootstrap.rs` (line numbers cited inline), `frontend/src-tauri/src/config.rs` (region plumbing), `frontend/src-tauri/src/backend.rs` (HF endpoint passthrough), `frontend/src-tauri/src/tools.rs` (`UV_VERSION = "0.11.7"`), `backend/services/tts_backend.py` (TTSBackend protocol + 9 existing engines), `pyproject.toml` (dep set), `uv.lock` (onnxruntime 1.24.4 wheels). Read during this research session.
- In-tree planning: `.planning/REQUIREMENTS.md` (TTS-01..06, INST-07..11), `.planning/ROADMAP.md` (Phase 3 section, Phase 2 dependency), `.planning/phases/01-*/01-RESEARCH.md` (Phase 1 reference for token resolver, settings_store, region scope boundary). Read during this research session.

### Secondary (MEDIUM confidence)

- CLAUDE.md Capabilities 3 + 4 — pre-vetted stack guidance, but version pin `supertonic==1.2.3` superseded by today's `1.3.1`. Treat as guidance, not gospel.
- [`dautovri/mirrors-china`](https://github.com/dautovri/mirrors-china) — community-maintained mirror list. WebFetch confirmed it mentions `hub.fastgit.xyz` and `gitclone.com` but does not enumerate `ghproxy.net`/`ghfast.top`/`gitmirror.com` specifically. Mirror liveness must be re-verified before merge (Open Q4).
- CLAUDE.md `What NOT to Use` table — guidance backed by official docs (HF, uv, Microsoft); HIGH confidence on its content, MEDIUM on whether all citations were re-verified in 2026.

### Tertiary (LOW confidence)

- Specific 40-char SHA for `PINNED_REVISION_SHA` constant — not resolved at research time; deferred to Wave 1 prep script (Open Q2).
- 2026 liveness status of `ghproxy.net` / `ghfast.top` / `gitmirror.com` — flagged for plan-time verification (Open Q4).
- Whether `supertonic` 1.3.1 has the exact same `TTS()` constructor signature as 1.2.3 — flagged in A7.

---

## Metadata

**Confidence breakdown:**

- Supertonic-3 stack: HIGH — direct PyPI/HF/GitHub fetches today, deps already in uv.lock, API pattern confirmed.
- Mirror cascade architecture: HIGH — uv env vars verified against current docs (2026-05-18 fetch), existing region plumbing read in-tree.
- Specific mirror URL liveness: MEDIUM — `hf-mirror.com` and `mirrors.aliyun.com` verified; `ghproxy.net` / `ghfast.top` / `gitmirror.com` need plan-time `curl -I` confirmation.
- Pinned model SHA: LOW (resolution deferred to Wave 1 — see Open Q2). This is intentional — pinning the SHA at research time would freeze a value that's likely to change before Wave 1 starts.
- Phase 2 `SubprocessBackend` env-forwarding behavior: ASSUMED — Phase 2 has no plans yet. Coordinate via STATE.md before Wave 1.
- Pitfalls: HIGH — all 8 pitfalls are derived from concrete behaviors of in-tree code + the documented behavior of uv / huggingface_hub / onnxruntime.

**Research date:** 2026-05-18

**Valid until:** ~2026-06-17 (30 days). Re-validate if not started by then. The `supertonic` version is fast-moving (1.2.3 → 1.3.1 in 3 days) — re-verify the latest PyPI release within 7 days of Wave 1 start.
