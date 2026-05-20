# STATE: OmniVoice Studio v0.3.x Stabilization

**Last updated:** 2026-05-20 — Phase 1 Wave 1 (Plan 01-01) complete; ready for Wave 2 (Plan 01-02)

---

## Project Reference

**Core value:** A first-run that actually works — a user who downloads the installer (or clones the repo) reaches a working voice-cloning or dubbing output without hitting a wall, and when something does go wrong, the error or docs tell them exactly what to do.

**Milestone:** v0.3.x stabilization — "Empty the inbox" (close all 11 open GitHub issues) plus two surgical additions (Supertonic-3 engine, opt-in bug reporting) plus two spike-first model additions (`Serveurperso/OmniVoice-GGUF` hardware-adaptive default, `ModelsLab/omnivoice-singing` for the dubbing pipeline).

**Current focus:** Phase 1 planned. Three plans cover all 16 official Phase 1 requirements plus accepted scope additions (#76 .deb ffprobe, #80 Docker LAN). Ready for `/gsd:execute-phase 1`.

---

## Current Position

| Field | Value |
|-------|-------|
| Phase | 1 — Install + Token Persistence + Docs Scaffolding + Error UX |
| Plan | 01-01 (executed, PR open), 01-02 + 01-03 awaiting execute |
| Status | Wave 1 shipped (HF token persistence + redactor + 5 read sites); Wave 2 + 3 pending |
| Mode | yolo (autonomous) |
| Granularity | standard |
| Project mode | mvp (per phase) |

**Progress:** ░░░░░░░░░░ 0 / 7 phases

```
[ ] Phase 0  Gates (hard gate — must merge and be green before any other phase)
[~] Phase 1  Install + Token Persistence + Docs Scaffolding + Error UX  ← Wave 1 shipped (1/3 plans)
[ ] Phase 2  Engine Isolation (SubprocessBackend → IndexTTS + WAV-export fix)
[ ] Phase 3  Supertonic-3 Engine + Installer Mirror Reliability
[ ] Phase 4  Adaptive & Specialty Engines (spike-first: GGUF + Singing)
[ ] Phase 5  Opt-in Bug Reporting
[ ] Phase 6  Release, Verification, Retro
```

---

## Performance Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Open GitHub issues closed (fix or documented workaround) | 11 / 11 | 0 / 11 |
| v1 requirements mapped to phases | 62 / 62 | 62 / 62 ✓ |
| Phases complete | 7 / 7 | 0 / 7 |
| CI runtime smoke tests passing (macOS, Windows, Linux) | 3 / 3 | TBD (set up in Phase 0) |
| Spike outcomes documented (GGUF, Singing) | 2 / 2 | 0 / 2 (run in Phase 4) |
| Discord support-volume delta (install / HF token / dubbing) | Net negative | Baseline pending |

---

## Accumulated Context

### Key Decisions Logged

1. **7 phases, standard granularity.** Phase 0 + ARCHITECTURE's A/B/C/D + spike-first Adaptive & Specialty Engines phase + release/verify. Originally 6 phases; Phase 4 inserted on 2026-05-16 to own the GGUF + Singing additions.
2. **Phase 0 is a hard gate.** CI cross-platform + regression fixture + installer smoke test must merge and prove green before any other phase opens PRs. Non-negotiable.
3. **Phase 2 must precede Phase 3 AND Phase 4.** Supertonic-3, OmniVoice-GGUF, and OmniVoice-Singing all plug into the `SubprocessBackend` primitive built in Phase 2. Phases 3 and 4 can run in parallel once Phase 2 lands.
4. **Phase 4 is spike-first.** SPIKE-01 (GGUF) and SPIKE-02 (Singing) gate their respective integration requirements. NO-GO outcomes move GGUF-*/SING-* to Out of Scope with decision-doc link in `.planning/decisions/`.
5. **Keyring deferred to v0.4.** `$HF_HOME/token` + `~/.config/omnivoice/env` (mode 0600) is sufficient for v0.3.x.
6. **Bug reporting is opt-in only.** Default-deny allow-list payload, GitHub-Issues prefilled URL only, no PAT / no third-party telemetry endpoint.
7. **`xattr -cr` (#54) and `WEBKIT_DISABLE_COMPOSITING_MODE=1` (#56) count as closed if documented + surfaced in error UI.** Real fixes are infrastructure-level (signing cert, upstream Tauri bug).
8. **Mode is `yolo` (autonomous), per-phase mode is `mvp`.** Auto-approve gates as user directed.
9. **Phase 1 scope locked (2026-05-18):** Three plans cover 17 requirements (INST-01..06, DOCS-01..05, AUTH-01..06) plus two accepted scope additions (#76 .deb ffprobe conflict, #80 Docker LAN frontend). v0.3.0 ships as a single fat release bundling all 7 phases — no incremental v0.3.x tags.
10. **Phase 1 wave structure (2026-05-18):**
    - **Wave 1 (Plan 01-01):** Token resolver (3-source cascade) + encrypted SQLite settings store + logging redactor + subprocess env injection + patch all 5 bare `os.environ.get("HF_TOKEN")` call sites. Closes #35 read-side bug.
    - **Wave 2 (Plan 01-02):** Split README into per-OS docs + 5 new docs + `scripts/validate-install-docs.py` CI gate + error→docs deeplink map (Python + TS halves) + ErrorBoundary deeplink wiring + Settings → API Keys panel UI (consumes Wave 1 resolver state endpoint).
    - **Wave 3 (Plan 01-03):** AppRun strategy spike + AppImage WebKit conditional launcher (#56) + .deb ffprobe relocation + postinst cleanup (#76) + centralized `apiBase.ts` + Docker LAN frontend fix (#80) + macOS Gatekeeper detection probe + INST-01 no-regression assertion.
11. **Open Question resolutions for Phase 1 (2026-05-18):**
    - AppRun location: spike-first (Task 01-03-1) — outcome documented in `.planning/decisions/apprun-strategy.md`
    - Settings table: AUTH-02 adds via real alembic migration (project already has `alembic.ini` + `backend/migrations/`), not `init_db()` patch
    - Project repo URL: `backend/core/links.py` reads from `pyproject.toml [project.urls]` + `tauri.conf.json` updater endpoint (single source of truth)
    - localhost hardcodes: `frontend/src/utils/media.js:20` confirmed as only site; centralized via `apiBase.ts`
    - First-launch failure UI: backend startup probe emits `GATEKEEPER_QUARANTINE` error class → React ErrorBoundary renders docs deeplink (Tauri itself launches; backend detects)

### Open TODOs

- Run `/gsd:execute-phase 1` for Wave 2 (Plan 01-02: docs scaffolding + error UX deeplinks + Settings → API Keys React panel). Plan 01-02 depends on Plan 01-01's resolver state endpoint (`GET /system/hf-token/state` AND `GET /api/settings/hf-token/state`) which is now live.
- Run `/gsd:execute-phase 1` for Wave 3 (Plan 01-03: AppRun spike + AppImage WebKit launcher + .deb ffprobe + apiBase.ts + Docker LAN frontend + macOS Gatekeeper probe).
- Run `/gsd:plan-phase 0` to decompose Phase 0 (Gates) into executable plans (Phase 0 is the hard gate; technically should land first, but Phase 1 plans don't block on its execution).
- Confirm open PRs #51 / #53 / #61 land before Phase 0 finalizes the CI matrix.
- Resolve Phase 2 / 3 / 5 research questions enumerated in `.planning/research/SUMMARY.md` Open Questions table.
- Schedule Phase 4 research dimension (web-fetch model cards for `Serveurperso/OmniVoice-GGUF` and `ModelsLab/omnivoice-singing`, license + runtime confirmation) before any GGUF/SING code work.

### Blockers

None. Phase 1 plans are independent of Phase 0 plan creation (though Phase 0 execution must merge before Phase 1 PRs per Key Decision #2).

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260518-ivy | Add loopback origin check to /system/set-env (security fix from PR #66 review) | 2026-05-18 | e1f08a6 | [260518-ivy-add-loopback-origin-check-to-system-set-](./quick/260518-ivy-add-loopback-origin-check-to-system-set-/) |
| 260518-lp7 | Hide dictation pill widget when idle, show only when activated | 2026-05-18 | 001d975 | [260518-lp7-hide-dictation-pill-widget-when-idle-sho](./quick/260518-lp7-hide-dictation-pill-widget-when-idle-sho/) |

---

## Session Continuity

**Last session ended after:** Phase 1 Wave 1 execution (Plan 01-01). Commits landed: `aa06754` (encrypted settings store + alembic migration), `f254e00` (resolver + redactor + 5 read sites), `e4e2398` (Settings API endpoints + subprocess env injection tests). 35 new tests, all green. Phase 0 smoke tests still green. PR opened against `main` from worktree branch.

**Previous session:** Phase 1 planning. Files written:
- `.planning/phases/01-install-token-persistence-docs-scaffolding-error-ux/01-01-PLAN.md` (Wave 1 — token persistence + read-side fix)
- `.planning/phases/01-install-token-persistence-docs-scaffolding-error-ux/01-02-PLAN.md` (Wave 2 — docs scaffolding + error UX)
- `.planning/phases/01-install-token-persistence-docs-scaffolding-error-ux/01-03-PLAN.md` (Wave 3 — installer/bundler fixes)
- `.planning/ROADMAP.md` (Phase 1 plan list populated, progress 0/3)
- `.planning/STATE.md` (this file — Phase 1 planned, ready for execute)

**Resume with:** `/gsd:execute-phase 1` (or `/gsd:plan-phase 0` to decompose Phase 0 in parallel).

---

*State initialized: 2026-05-16 after roadmap creation*
*Last updated: 2026-05-18 after Phase 1 planning (3 plans across 3 waves)*
