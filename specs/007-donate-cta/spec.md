# Feature Specification: Donate CTA — "Fund Claude Max" (kawaii postcard)

**Feature Branch**: `007-donate-cta` | **Created**: 2026-06-16
**Status**: Designed (3-agent synthesis: copy + art + conversion) — awaiting goal-number-source decision, then build
**Input**: Owner request — cute/arthouse, effective, non-annoying donate experience with a $200/mo goal; Discord surface
**Extends**: the existing donate page (`SupportPage.jsx`, `mode==='donate'`), `LogsFooter` `DonateHeart`, `.github/FUNDING.yml`

## Goal & framing
**$200/mo — "Fund Claude Max."** Transparent on purpose: *OmniVoice is built with Claude; $200/month covers the Max subscription that writes the releases. 100% local, no investors, no ads — just this.* Donations are **optional; the app is free-forever, full-featured, never degraded** (the ask is reciprocity, never ransom).

## North star
**Maximally effective, never annoying** — for a technical, privacy-minded, anti-dark-pattern audience. **Quality over quantity:** one perfectly-timed, beautiful, dismissible ask beats a dozen. Every surface gets depth, not spam.

## Mascot — PIP
A single **sound-sprite**: a sound-wave droplet with two dot eyes, one ‿ smile, one wave-arc "sprout," and *one* eye-sparkle (not the two-sparkle kawaii cliché). Inline SVG, `currentColor` → `--chrome-accent`; one slow idle (`pipBob`/`pipWave`, ~4.2s), frozen under `prefers-reduced-motion`. PIP is a **mark** (like the existing `.hq-view-dot`), not a chatty assistant. PIP "mails" the postcard and "surfs" the goal bar. One creature, one accent, one slow motion = arthouse restraint.

## Surfaces (6)
1. **Export-finished postcard** ⭐ *primary* — a real postcard (stamp corner, dashed perforation, paper-grain, PIP) that **slides up bottom-right above the LogsFooter**. A **non-blocking toast** (`react-hot-toast`, **never** `Dialog.jsx` — a modal over a fresh export is itself a dark pattern), auto-dismiss ~12 s (pause on hover). Fires **only on success completion** — `completePill(...)` success branch (`pillSlice.ts`, from `useDubWorkflow.js:497/232/263` + the longform SSE `done`) and the clone-save resolve. Shows artifact context ("Your dub's ready 🎉"), the **mini goal bar** (fills *in front of you* on slide-in — the single most delightful beat), `Chip in ❤️`, `Maybe later`, and a quiet `Don't ask again`. Free secondary micro-ask: `⭐ Star on GitHub`.
2. **Goal progress bar** — page (in `SupportPage`) + mini (postcard), same `--goal-pct` data. `$X of $200 · Claude Max`, %, **`updated {date}`**. PIP perched at the fill edge, `.dub-prep-bar` fill gradient, **one** shimmer pass (a payoff, not a casino), faint ruler ticks. At/over goal → celebrate and **retire the ask** ("🎉 funded this month — thank you"). Monthly reset re-opens the gradient (no invented urgency).
3. **Persistent pull surfaces** — keep the footer `DonateHeart` (seasonal); optionally add one quiet `Support` pill in the nav-rail. **Never suppressed** (opting out of *nags* ≠ losing the *ability* to give).
4. **Milestone nudges** — 1st clone, 10th dub, 30-day sustained use — each **once ever**, celebratory copy variant, same cooldowns/opt-out.
5. **Donate page (`SupportPage`)** — add the goal bar + **social proof** ("Join N supporters" — count, not amounts) + **suggested amounts** ($3/$5/$10/Custom, middle marked "most common", **none pre-selected**) above the existing Sponsors / Ko-fi / PayPal cards.
6. **Discord** — a `/donate` command (one goal card: bar + links + warm line), `/donate top` (a **top-supporters leaderboard**, social proof from GitHub Sponsors), and **one** crafted, pinned **#announcements** post — refreshed only on real milestones, **never a recurring nag**.

## The non-annoyance contract (frequency state machine)
A new persisted `donationSlice` (zustand `persist` `partialize` allowlist, `version` bump + pass-through `migrate`). The postcard shows **only if ALL hold**:
- `!optedOut` · `!shownThisSession` · `successCount ≥ 3` (grace for new users)
- `now − lastShownAt ≥ 7d` · `now − lastDismissedAt ≥ 14d` · `now − lastClickThroughAt ≥ 30d` · `now − donatedAt ≥ 75d`
- artifact `status === success` (**never** on error / in-progress / setup / first-run)

Effect: a heavy daily user sees the postcard **≤ ~once/week**, always after a win, mutable forever in one click. Milestones respect the same cooldown + opt-out.

## Anti-pattern checklist (each avoided = a trust deposit)
No guilt/confirm-shaming (dismiss is neutral) · non-blocking (toast, never steals focus/covers the artifact) · no fake urgency/countdowns · nothing pre-selected/pre-checked · **no fabricated numbers** (real, dated `raised`/`sponsorCount`) · dismiss as legible as the CTA · symmetric opt-out (one click off; re-enable in Settings) · **zero telemetry** (progress JSON is a read-only fetch with offline fallback; nothing about the user is sent — upholds the local-first constraint).

## Goal-number source — the ONE open decision
| | Live? | Local-first? | Effort |
|---|---|---|---|
| A. Baked value (bump per release) | stale | ✅ offline | trivial |
| **B. Best-effort fetch of committed `donation_progress.json`** ⭐ | live-ish | ✅ optional + degrades | small |
| C. GitHub Sponsors GraphQL API | real-time | ❌ token; amounts often private | high |

**Recommend B:** ship a committed `donation_progress.json` `{ raised, goal: 200, currency, sponsorCount, updated }`; `SupportPage` reads it, optionally fetches a fresher copy at runtime, falls back to the bundled value offline. **Honest + dated; never fabricate motion.** Endowed-progress = open the bar at the *real* current baseline (recurring sponsors), not a faked head-start.

## Copy direction
Warm, lightly kawaii, **honest**, never needy. One ❤️ per surface. Recommended leads (full A/B/C deck → i18n keys): postcard *"Your {artifact}'s ready. ❤️ / OmniVoice is built with Claude — if it saved you a trip to the cloud, a tip toward the Claude Max fund means a lot."*; goal *"$X of $200 — Claude Max fund"*; button *"Donate ❤️"*. Free-forever, never "unlock/premium/pro," never "support us or lose features."

## Success metrics
Effective: postcard click-through ≥ 8–12%; donate-page→Sponsors ≥ 25–30%; bar funded ≥ 80–100%/mo; star micro-ask ≥ 15%; **"don't ask again" < 5%**. Annoying-alarm: opt-out > ~10%, "nag/begging" mentions on Discord/issues, uninstall correlated with exposure → soften/roll back to footer-heart-only. Measure locally + via the owner's GitHub Sponsors dashboard (no per-user tracking).

## Constraints
Local-first (no telemetry, offline-safe) · i18n hard rule (every string `t()`, 26 locales) · cross-platform · docs-sync (update FUNDING/README if funding text changes, same PR) · backward-compatible (extends `SupportPage` + a persist version bump with safe-default migrate).

## Out of scope (v1)
Automated over-goal stretch-goal rotation; real A/B infra; per-amount/per-user tracking (telemetry-free by design); the dub-toolbar redesign (separate, already diagnosed).
