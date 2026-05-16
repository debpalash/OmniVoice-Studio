# STATE: OmniVoice Studio v0.3.x Stabilization

**Last updated:** 2026-05-16

---

## Project Reference

**Core value:** A first-run that actually works — a user who downloads the installer (or clones the repo) reaches a working voice-cloning or dubbing output without hitting a wall, and when something does go wrong, the error or docs tell them exactly what to do.

**Milestone:** v0.3.x stabilization — "Empty the inbox" (close all 11 open GitHub issues) plus two surgical additions (Supertonic-3 engine, opt-in bug reporting) plus two spike-first model additions (`Serveurperso/OmniVoice-GGUF` hardware-adaptive default, `ModelsLab/omnivoice-singing` for the dubbing pipeline).

**Current focus:** Roadmap defined (7 phases, 62 v1 requirements). Awaiting `/gsd:plan-phase 0` to decompose Phase 0 (Gates) into executable plans.

---

## Current Position

| Field | Value |
|-------|-------|
| Phase | 0 — Gates |
| Plan | none yet |
| Status | Roadmap complete (revised to insert Phase 4), planning not started |
| Mode | yolo (autonomous) |
| Granularity | standard |
| Project mode | mvp (per phase) |

**Progress:** ░░░░░░░░░░ 0 / 7 phases

```
[ ] Phase 0  Gates (hard gate — must merge and be green before any other phase)
[ ] Phase 1  Install + Token Persistence + Docs Scaffolding + Error UX
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

### Open TODOs

- Run `/gsd:plan-phase 0` to decompose Phase 0 (Gates) into executable plans.
- Confirm open PRs #51 / #53 / #61 land before Phase 0 finalizes the CI matrix.
- Resolve Phase 2 / 3 / 5 research questions enumerated in `.planning/research/SUMMARY.md` Open Questions table (note: SUMMARY.md "Phase 4" rows now correspond to this roadmap's Phase 5 — bug reporting — after the insertion).
- Schedule Phase 4 research dimension (web-fetch model cards for `Serveurperso/OmniVoice-GGUF` and `ModelsLab/omnivoice-singing`, license + runtime confirmation) before any GGUF/SING code work.

### Blockers

None.

---

## Session Continuity

**Last session ended after:** Roadmap revision to insert Phase 4 (Adaptive & Specialty Engines). Files written:
- `.planning/ROADMAP.md` (revised: 7 phases, new Phase 4 inserted between Supertonic-3 and Bug Reporting)
- `.planning/REQUIREMENTS.md` (revised: 13 new requirements added, traceability table extended to 62 rows, REPORT-* renumbered to Phase 5, REL-* to Phase 6)
- `.planning/STATE.md` (this file — updated to 7 phases / 62 requirements)

**Resume with:** `/gsd:plan-phase 0`

---

*State initialized: 2026-05-16 after roadmap creation*
*Last updated: 2026-05-16 after Phase 4 insertion (Adaptive & Specialty Engines)*
