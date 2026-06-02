# OmniVoice Studio — Monetization & Licensing Strategy (draft)

> Internal strategy note. Pairs with the dual-license draft (`LICENSE` +
> `LICENSE-COMMERCIAL.md`). Not legal advice — finalize commercial terms with a
> lawyer before offering them.

## Goal

Make money **while keeping a credible open-source story**. The hard constraint:
"open source" (OSI definition) forbids restricting *commercial use* or *fields of
endeavor*. So a license that says "businesses must pay" is **source-available, not
open source**. You can't have both on the same code — you choose the lever.

## The chosen direction: AGPL-3.0 core + commercial dual-license + open-core

A hybrid that keeps OmniVoice genuinely open source AND gives three revenue paths.

### 1. Core app — AGPL-3.0-or-later (open source)
- Real OSI open source: keeps community trust, contributions, and the
  "local-first, no API keys" story.
- AGPL's network/distribution copyleft is the **lever**: anyone who redistributes,
  embeds, or hosts OmniVoice must open their stack — or buy a commercial license.

### 2. Commercial dual-license (B2B lever)
- Sell exemptions from AGPL copyleft to companies that **embed / redistribute /
  white-label / SaaS-ify** OmniVoice. See `LICENSE-COMMERCIAL.md`.
- Captures the high-value integrators and competitors. Does **not** capture a
  company merely running the desktop app internally (no AGPL trigger) — that's an
  inherent limit of the open-source lever.

### 3. Open-core "Pro" (broad, enforceable revenue)
The most reliable income for a **local desktop app**, because it's gated by
*features you withhold*, not by a license users could ignore. Candidate Pro features:
- Premium / curated voice library and higher-fidelity cloned-voice models
- Large-batch / queue pipelines and project-scale dubbing
- Team features: shared profiles, seats, SSO, audit
- Priority model hosting / faster downloads / mirror access
- Commercial-use rights bundle + priority support SLA

> Open-core implementation note: keep the Pro code in a **separate proprietary
> module/repo** so the AGPL core stays clean and the boundary is unambiguous.

### 4. (Later) Hosted API / cloud
A managed voice-gen endpoint for users who don't want to run it locally — the only
model that yields recurring cloud revenue. Weak today (OmniVoice is local-first),
but a natural future SKU.

## Why not pure source-available (BUSL/PolyForm)?
It *would* let you charge every commercial user (incl. internal) — but it is **not
OSI open source**, costs you the label/community, and on a public-source **local**
app it's barely enforceable beyond risk-averse enterprises. Only choose it if
"charge everyone" outranks the open-source positioning.

## Decision checklist before flipping the license
- [ ] **Contributor consent / CLA** — relicensing existing contributions from
      FSL-1.1 to AGPL needs sign-off from non-trivial contributors (or proof you
      hold the rights). Enumerate contributors first.
- [ ] **Confirm the lever** — AGPL+commercial (open source, monetize
      redistributors/SaaS) vs source-available (charge all commercial, not OSI).
- [ ] **Draft the actual commercial agreement + pricing** (lawyer-reviewed).
- [ ] **Define the Pro/Enterprise feature split** and where that code lives.
- [ ] Update README, license badge, `pyproject.toml` SPDX, and reply to #237.
