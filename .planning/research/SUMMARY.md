# Research Synthesis — OmniVoice Studio v0.3.x Stabilization Milestone

> Synthesized from STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md (2026-05-16)
> Confidence: **HIGH** for build order, phase shape, and risk callouts. **MEDIUM-with-named-gaps** for implementation-time specifics (all gaps enumerated below).

---

## Executive Summary

This milestone is **stabilization plus two surgical additions** on a working v0.2.7 codebase — not greenfield. The existing stack is correct and untouched; the work is closing 11 GitHub issues, adding **Supertonic-3** as the 7th TTS engine, and shipping **opt-in GitHub-Issues bug reporting** — all without breaking already-installed users on macOS/Windows/Linux.

Research converged sharply on one architectural call: **subprocess-per-engine isolation is the only durable fix for the IndexTTS dependency clash (#42), and that primitive must land before Supertonic-3 plugs into it.** Every other addition reuses patterns already in the codebase (`core/prefs.py`, `gpu_sandbox.py`, `bootstrap.rs` region handling, `TTSBackend` ABC).

The dominant risks are **regression** (a "stabilization" milestone that destabilizes), **PII leakage** through the new bug reporter (would kill the local-first brand promise), and **cross-platform test theater** (CI runs Python only on Linux today). Two non-negotiable pre-conditions emerged: a frozen `omnivoice_data/` fixture loaded by smoke tests, and macOS + Windows runtime smoke tests added to CI **before** stability work begins. Treat these as **Phase 0**.

---

## Build-Order Convergence

All four researchers agree on this spine:

```
Phase 0 (gates) → Phase 1 (token+docs+UI) → Phase 2 (engine isolation, IndexTTS)
                                                  → Phase 3 (Supertonic-3 + installer mirror)
                                                            → Phase 4 (bug reporter)
                                                                      → Phase 5 (release & verify)
```

**Verdict:** IndexTTS-on-SubprocessBackend goes in **Phase 2**; Supertonic-3 plugs into the proven primitive in **Phase 3**. Do not parallelize these two.

---

## MVP-Cut Granularity

FEATURES' "9 P1 items in one MVP phase" is correct as a **success-bar definition**, wrong as a **build phase**. The 9 items split cleanly along architectural seams (token, docs, engine, installer, bug-reporter); lumping them hides regression risk.

**Verdict:** Standard granularity (5–8 phases). **6 phases total** = Phase 0 + ARCHITECTURE's A/B/C/D + release/verify.

---

## Pre-Milestone Gates

PITFALLS #1 (fixture) and #10 (cross-platform CI) are cross-cutting, must-precede-Wave-2, severity `blocks-milestone`.

**Verdict:** **Dedicated Phase 0.** Small phase (CI YAML edits + fixture seed + smoke test) but must merge and prove green before any other phase opens its PRs. Non-negotiable hard gate.

---

## Keyring Decision

FEATURES floated P2; STACK said skip; ARCHITECTURE designed `env_store` around `~/.config/omnivoice/env` mode 0600 with no keyring; PITFALLS mentioned only as "prefer where possible" with file fallback.

**Verdict:** **Defer to a later milestone.** Ship `env_store` + `$HF_HOME/token` path; document keyring as v0.4+ upgrade path.

---

## Shared Infrastructure → Phase Mapping

| FEATURES shared infra | Lives in | Built during |
|---|---|---|
| Error-capture infrastructure (sysinfo + redacted-logs serializer) | `backend/services/bug_report.py` (NEW) | **Phase 4** — redaction primitive first, submission UI after |
| Engine-status registry (each engine's `is_available` + last error) | extend `tts_backend.py:_REGISTRY` + `is_available()` wrap | **Phase 2** — graceful-degradation wrap is table-stakes; SubprocessBackend is the architectural step |
| Error → docs URL map | `backend/core/error_docs_map.py` + frontend `errorDocsMap.ts` | **Phase 1** — built alongside doc skeleton so contextual links work day-1 |
| HF token abstraction (env > file > default) | `backend/services/env_store.py` (NEW) | **Phase 1** — small, well-bounded, and Phase 2's SubprocessBackend needs token forwarding |

---

## Convergent Risk Callouts (flagged by ≥2 researchers)

| Risk | Flagged by |
|---|---|
| IndexTTS subprocess isolation must precede Supertonic-3 | STACK, FEATURES, ARCHITECTURE, PITFALLS |
| Default-deny payload in bug reporter (allow-list, not redaction-after-the-fact) | STACK, FEATURES, ARCHITECTURE, PITFALLS |
| HF token must NOT leak through bug reporter or logs | STACK, FEATURES, ARCHITECTURE, PITFALLS |
| Mirror fallback needs hash-pinned `uv.lock` + allow-list (no freeform URL) | STACK, ARCHITECTURE, PITFALLS |
| Existing engine compat: do not force users to reinstall | STACK, FEATURES, ARCHITECTURE, PITFALLS |
| Cross-platform CI gap (macOS + Windows runtime untested) | ARCHITECTURE, PITFALLS |
| `tauri-plugin-opener` + prefilled URL is the right submit path (no PAT, no Sentry) | STACK, FEATURES, ARCHITECTURE |

---

## Suggested Phase Structure (one-liner each)

1. **Phase 0 — Gates.** Frozen `omnivoice_data/` fixture + smoke test, macOS+Windows runtime CI, installer smoke test in `release.yml`, PR template + two-RC cadence. (Avoids Pitfalls #1, #10.)

2. **Phase 1 — Token persistence + docs scaffolding + error UX.** `env_store.py`, Settings → API Keys, `docs/install/{macos,windows,linux,docker,troubleshooting}.md` skeleton, error→docs map with #54/#56 contextual links, Wave 1 quick wins (`setuptools` #58, templated README badges), per-platform HF token guide. (Closes #35, #54, #56, #58, partial #55. Standard research, no flag.)

3. **Phase 2 — Engine isolation (SubprocessBackend → IndexTTS first).** `engine_subprocess.py`, `backend/engines/indextts/main.py`, per-engine venv bootstrap, `is_available()` graceful-degradation wrap, #42 regression test, compat matrix UI. (Closes #42 real fix. **RESEARCH RECOMMENDED.**)

4. **Phase 3 — Supertonic-3 + installer mirror reliability.** `engines/supertonic3/main.py` on the proven primitive, `[optional-dependencies] supertonic`, model revision SHA pin, license surfacing, mirror cascade in `bootstrap.rs` (`UV_PYTHON_INSTALL_MIRROR` + `only-system` fallback + allow-list dropdown), `uv sync --frozen` enforced. (Closes Supertonic-3 addition, #57, #60. **RESEARCH RECOMMENDED.**)

5. **Phase 4 — Bug reporting.** `bug_report.py` + `feedback.py` router, Rust panic hook, React ErrorBoundary tap, two-step consent UX, default-deny allow-list, path sanitizer, token regex scrub, recursion guard, per-day rate cap, SHA-1 dedup, GitHub-search-before-open, `auto-report` label, logger-level HF redaction, full test suite (redaction, recursion, dedup, rate-limit). (Closes the bug-reporting addition. **RESEARCH RECOMMENDED.**)

6. **Phase 5 — Release, verify, retro.** `v0.3.0-rc1` → clean-VM follow-the-docs exercise (UTM/Hyper-V on Sequoia/Win11/Ubuntu24/Fedora44) → 48h sit → promote → SHA-256 checksums → per-issue close-verification → published retrospective with weighted-closure + net-inbox + Discord-volume metrics + tracking issues for explicit deferrals. (Avoids Pitfall #11. Standard.)

---

## Open Questions for Phase-Specific Research

| Phase | Question | Source |
|---|---|---|
| Phase 1 | Does `huggingface_hub` v1.12+ still embed tokens in 401 error URLs? | STACK, PITFALLS #5 |
| Phase 1 | `~/.config/omnivoice/env` path resolution on Windows (XDG fallback) | ARCHITECTURE §2.2 |
| Phase 2 | What does IndexTTS's actual `transformers` clash in #42 look like — install-time, import-time, or runtime? Determines whether per-engine venv alone is enough | FEATURES, ARCHITECTURE §2.3 |
| Phase 2 | Verify `mp.get_context("spawn")` works on macOS Apple Silicon (libs that assume fork) | ARCHITECTURE §2.3 |
| Phase 2 | Existing IndexTTS users: confirm subprocess inherits `HF_HOME` so cached weights aren't re-downloaded | ARCHITECTURE §2.3 backward-compat |
| Phase 3 | Does `supertonic` 1.2.3 use `onnxruntime` (CPU) or `onnxruntime-gpu`? Conflict with engines bundling GPU ONNX | STACK §Cap 4 risk flags |
| Phase 3 | `supertonic` opportunistic `transformers` import — don't remove `transformers>=5.3.0` thinking it's WhisperX-only | STACK §Cap 4 |
| Phase 3 | Verify `gh-proxy.com`, `ghfast.top`, `hub.gitmirror.com` are still live | STACK §Cap 3 |
| Phase 3 | Verify Yandex/Tsinghua/Aliyun PyPI mirror URLs are still active | PITFALLS #6 |
| Phase 3 | Supertonic-3 model card commit date — if updated within 30 days, revision pinning is critical | PITFALLS #7 |
| Phase 3 | Does Supertonic-3 have an MPS path? If CUDA-only, surface honestly in `is_available()` | PITFALLS #7 |
| Phase 4 | GitHub Issues URL length cap (~8 KB after encoding) vs our payload size | STACK §Cap 2, FEATURES |
| Phase 4 | Tauri 2 `shell.open` permission scope post-Sequoia | STACK, ARCHITECTURE §2.1 |
| Phase 4 | `tauri-plugin-single-instance` + `bug-report-counter.json` racing | ARCHITECTURE §1 |
| Cross-cutting | Verify open PRs #51, #53, #61 are merged before Phase 0 finalizes CI matrix | PROJECT.md Wave 1 |
| Cross-cutting | If `pkg_resources` fix bundles `setuptools`, check `backend.spec:excludes` for double-include | ARCHITECTURE §4 |
| Cross-cutting | Does `tauri-action` already publish per-artifact SHA-256 in release body (for #54)? If not, add in Phase 0 | PITFALLS #8 |

---

## Files Synthesized

- `.planning/research/STACK.md` — Per-capability prescriptive stack with versions, rationale, risk flags
- `.planning/research/FEATURES.md` — Table-stakes / differentiators / anti-features for 5 stabilization capabilities
- `.planning/research/ARCHITECTURE.md` — Subsystem integration design with component boundaries and build order
- `.planning/research/PITFALLS.md` — 11 critical pitfalls with phase mapping and recovery strategies
