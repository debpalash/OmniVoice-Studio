# Implementation Plan: Donate CTA — "Fund Claude Max" (plan-07)

**Branch**: `007-donate-cta` | **Date**: 2026-06-16 | **Spec**: [spec.md](./spec.md)
**Decision pending**: goal-number source A/B/C (rec **B** — committed `donation_progress.json` + best-effort fetch).

## Constitution check
| Principle | Status |
|---|---|
| Local-first | ✅ no telemetry; progress JSON is read-only fetch w/ bundled offline fallback |
| First-run works | ✅ additive; postcard suppressed for first 3 successes + setup/errors |
| Cross-platform parity | ✅ pure React/CSS/emoji/inline-SVG, no native deps; identical mac/Win/Linux |
| Backward-compatible | ✅ extends `SupportPage`; zustand `persist` version bump + safe-default `migrate` |
| i18n hard rule | ✅ every string a `t()` key in `i18n/locales/*.json` (26 locales) |
| Docs-sync | ✅ FUNDING/README funding copy updated in the same PR if it changes |

## Phasing (risk-ordered — ship Phase 1 alone first)
1. **Goal bar + `donation_progress.json`** (self-contained, zero-risk) — the honest dated bar on `SupportPage`. Delivers value immediately, no triggers/state.
2. **PIP mascot + postcard + `donationSlice`** — the mascot component, the `react-hot-toast` postcard, the frequency state machine, wired to the **success** branch of `completePill` + clone-save.
3. **Milestones + nav-rail "Support" pill** — 1st clone / 10th dub / sustained; the quiet pill.
4. **Discord** — `/donate` + `/donate top` + the one pinned #announcements post.

## Phase 1 — goal bar (do first)
- New `frontend/public/donation_progress.json` (or `config/`): `{ "raised": <real>, "goal": 200, "currency": "USD", "sponsorCount": <real>, "updated": "2026-06-16" }`. Owner edits this when sponsorship moves. **Open the bar at the real baseline (endowed progress), never a faked seed.**
- `SupportPage.jsx`: add a `DonationGoal` section above the payment cards — reads the bundled JSON, optionally `fetch()`es a fresher public copy (graceful catch → bundled). `--goal-pct = raised/goal`. Mini variant accepts a prop for the postcard.
- CSS (reuse `.dub-prep-bar` fill + existing `shimmer`/tokens; from the art spec):
```css
.goal__track{position:relative;height:8px;border-radius:999px;background:var(--color-bg-elev-2);overflow:visible}
.goal__fill{height:100%;border-radius:999px;width:var(--goal-pct,0%);
  background:linear-gradient(90deg,rgba(211,134,155,.75),rgba(211,134,155,1));
  box-shadow:0 0 10px -1px var(--color-brand-glow);transition:width 1.1s var(--ease-spring);position:relative}
.goal__pip{position:absolute;right:-10px;top:50%;transform:translateY(-60%);width:22px;height:22px}
.goal__fill::after{content:"";position:absolute;inset:0;border-radius:inherit;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);background-size:200% 100%;
  animation:shimmer 1.4s var(--ease-out) .6s 1 both}
@media (prefers-reduced-motion:reduce){.goal__fill{transition:none}.goal__fill::after{display:none}}
```

## Phase 2 — PIP, postcard, state machine
**`Pip.jsx`** (inline SVG, `currentColor` → `--chrome-accent`; idle `pipBob`/`pipWave`, reduced-motion off):
```jsx
<svg viewBox="0 0 24 24" className="pip" aria-hidden="true">
  <ellipse cx="12" cy="13" rx="8.5" ry="8" fill="currentColor" opacity="0.9"/>
  <path d="M18 6 q3 -2 4 1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="pip__wave"/>
  <circle cx="8" cy="14.5" r="1.4" fill="#fb4934" opacity="0.18"/><circle cx="16" cy="14.5" r="1.4" fill="#fb4934" opacity="0.18"/>
  <circle cx="9.3" cy="12" r="1.15" fill="#0f1011"/><circle cx="14.7" cy="12" r="1.15" fill="#0f1011"/>
  <circle cx="9.0" cy="11.6" r="0.35" fill="#fff" opacity="0.9"/>  {/* the one sparkle */}
  <path d="M10.6 14.6 q1.4 1.4 2.8 0" fill="none" stroke="#0f1011" strokeWidth="0.9" strokeLinecap="round"/>
</svg>
```
**`donationSlice.ts`** (composed in `store/index.ts`, added to `partialize` — persist all **except** `shownThisSession`):
```ts
interface DonationState { optedOut:boolean; successCount:number; lastShownAt:number|null;
  lastDismissedAt:number|null; lastClickThroughAt:number|null; donatedAt:number|null;
  milestonesFired:string[]; shownThisSession:boolean }
const D={d:864e5}; // ms/day
shouldShow = s => !s.optedOut && !s.shownThisSession && s.successCount>=3
  && now-(s.lastShownAt??0)>=7*D.d && now-(s.lastDismissedAt??0)>=14*D.d
  && now-(s.lastClickThroughAt??0)>=30*D.d && now-(s.donatedAt??0)>=75*D.d;
```
Transitions: each success → `successCount++` then evaluate; show → `lastShownAt=now,shownThisSession=true`; dismiss → `lastDismissedAt=now`; CTA → `lastClickThroughAt=now`; "don't ask again" → `optedOut=true` (terminal, re-enable only in Settings); "I've donated" → `donatedAt=now`.

**Trigger**: one shared `evaluateDonationPrompt(ctx)` called right after each **success** `completePill(...)` (`pillSlice.ts`; sites `useDubWorkflow.js:497/232/263`, longform `done`, clone-save resolve in `useProfiles.js`). **Never** off `toastErrorWithReport`/error paths.

**`Postcard.jsx`** — rendered via `react-hot-toast` custom toast (non-blocking, no backdrop). Key CSS from the art spec: `.postcard` fixed `bottom:calc(var(--logs-footer-height,28px)+12px) right:16px; z-index:var(--z-toast)`, dashed-perforation `::before`, dot-grain `::after`, vertical dashed split, stamp corner with `stampThunk`, `postcardIn` spring entrance, `.is-leaving` exit, all under a `prefers-reduced-motion` guard. Mini goal bar inside reuses `--goal-pct` so it fills on slide-in.

## Phase 3 — milestones + pill
Milestone eval in the same evaluator (id ∉ `milestonesFired`, passes `shouldShow`). Nav-rail `.donate-pill` (`🩷 Support`, warms to accent on hover) → `setMode('donate')`.

## Phase 4 — Discord (bot at `~/.config/omnivoice-bot/`)
- **`/donate` command** — add to the bot's command set (TRIAGE.md / daemon command map + `discord.sh`): replies with one embed — goal bar (text: `$X/$200 ▓▓▓▓░░ 42% → Claude Max`), the Sponsors/Ko-fi/PayPal links, a warm line. Reads the same `donation_progress.json`.
- **`/donate top`** — top supporters leaderboard from GitHub Sponsors (names + tier, opt-in/public only).
- **#announcements** — ONE crafted pinned post calling for support to fund the Claude subscription; edit-in-place refresh only on milestones (quality over quantity — never re-post). Respect the `discord.sh postjson` guard (this is a normal post, not a draft/digest).

## Copy → i18n keys
`donate.postcard.{title,body,cta,dismiss,never}`, `donate.goal.{label,funds,met,updated}`, `donate.button.{label,tip}`, `donate.milestone.{first_clone,tenth_dub,sustained}`, `donate.page.{hero,body,thanks}`. English source from the copy deck (A/B/C variants captured in the spec; lead variants chosen there).

## Tests
- `donationSlice` unit (vitest): `shouldShow` truth table — first-3 grace, all cooldowns, opted-out terminal, success-only; transitions. Top-level placement, no real timers (inject `now`).
- Postcard never renders on the error path (gate test).
- `DonationGoal` renders bar from JSON + offline fallback + `goal met` state.
- typecheck:ci clean; vitest green. **Verify the full CI matrix incl. Docker `--frozen-lockfile`** (new files don't touch package.json, so bun.lock unaffected — but confirm, per the "keep main green" rule).

## Open decision before build
Goal-number source: **A / B / C** (rec **B**). Then start Phase 1.
