# Playbook — Setting up sponsorship for an open-source project

> A portable, copy-to-another-repo guide for adding a tasteful sponsorship
> system to a free/local-first OSS project. This is the exact setup shipped
> in OmniVoice Studio (PRs #923 + #924); lift the files, swap the names, and
> you have the same system in an afternoon.

## Philosophy (decide this first — it shapes everything)

1. **Sponsorship is a thank-you, not a paywall.** The software stays fully
   free and the same license. Tiers buy *visibility and gratitude*
   (logo placement), never gated features. Say this out loud in `SPONSORS.md`
   — it's what keeps the community's trust and separates you from a freemium
   bait-and-switch.
2. **Tell the honest funding story.** People sponsor a *reason*, not a tip
   jar. OmniVoice's is "one developer, in the open, and the AI-agent bills
   are real." Whatever yours is (server costs, your time, signing certs),
   state it plainly and specifically. Vague "support us" underperforms a
   concrete "here's what the money pays for."
3. **Local-first / no-infra.** No sponsor-management SaaS, no token held by
   the app, no third-party embed. The contact flow is a prefilled GitHub
   issue the user submits from their own browser — the same zero-credential
   pattern good OSS bug-reporters use. It survives forks (change one URL).
4. **Ask at value moments, rarely.** (This is the *prompting* half — see the
   donation-moments system, a separate piece: after a successful export,
   ≥N lifetime successes, long cooldown, permanent opt-out. Never nag.)

The two failure modes to avoid: **core-js** (console-spam nagging → community
backlash) and **blocking modals**. The two that work: **value-moment timing**
+ **enforced rarity** with an instant, respected exit.

## The pieces (what to create)

A complete system is six files. Placements form a natural ladder — each tier
adds one more surface:

```
SPONSORS.md                          ← the home: why, tiers, how-to, roster, asset rules
README.md  (## Sponsors subsection)  ← logo slots + "your logo here" + link to SPONSORS.md
.github/FUNDING.yml                  ← GitHub's native "Sponsor" button (Ko-fi / custom links)
.github/ISSUE_TEMPLATE/sponsor.yml   ← the "Sponsorship inquiry" issue FORM (structured fields)
frontend/.../config/sponsors.js      ← in-app single source of truth (empty array + contact URLs)
frontend/.../SupportPage + footer    ← in-app logo grid, "Become a sponsor" CTA, footer link
```

### 1. `SPONSORS.md` — the home

Sections, in order: **Why sponsor** (the honest funding story + "where your
money goes"), **Tiers** (a table — placements as benefits, cumulative),
**How to become a sponsor**, **Logo/asset guidelines**, **Current sponsors**
(a "be the first" placeholder with empty tier tables ready to fill), and a
**Not a paywall** note.

Tier ladder that maps to real surfaces:

| Tier | Placement added |
|------|-----------------|
| Backer | name/handle in `SPONSORS.md` |
| Bronze | + small logo in `SPONSORS.md` and the README Sponsors section |
| Silver | + logo in the README and the in-app Sponsors page |
| Gold | + prominent logo slot on the project website/landing |

**Leave prices as owner-input placeholders.** Use an HTML-comment marker so
they're obvious in source and never accidentally invented by an automated
edit: `_set by owner_ <!-- OWNER: set amounts -->`. Same for a public contact
email — don't publish a personal address without the owner's explicit call;
default the contact to the GitHub issue form.

### 2. README `## Sponsors` subsection

A short pitch, a logo-slot placeholder (`**Your logo here** — [become a
sponsor](SPONSORS.md)`), and a link to `SPONSORS.md`. Wrap the logo area in
`<!-- SPONSORS:START -->` / `<!-- SPONSORS:END -->` markers so a future script
can auto-render logos from the config. Add a `Sponsors` entry to the top nav.

### 3. `.github/FUNDING.yml`

Turns on GitHub's native "Sponsor" button. Only list platforms you're
actually on — don't add `github: [you]` unless GitHub Sponsors is set up.
Ko-fi + a `custom:` list (PayPal, the SPONSORS.md link) is a fine start:

```yaml
ko_fi: yourhandle
custom:
  - "https://paypal.me/you"
  - "https://github.com/you/repo/blob/main/SPONSORS.md"
```

### 4. `.github/ISSUE_TEMPLATE/sponsor.yml` — the inquiry form

A structured issue **form** (name/org, website, logo URL, tier interest,
contact, acknowledgements), `labels: ["sponsor"]`. **Gotcha we hit:** if
`config.yml` has `blank_issues_enabled: false`, a bare
`issues/new?title=…&body=…` prefill redirects to the template chooser and
*drops the body*. So point "Become a sponsor" at the **template route**
instead: `issues/new?template=sponsor.yml`. That carries the form's fields
reliably.

### 5. In-app config — single source of truth

One module the whole app reads (`config/sponsors.js` in our case):

```js
export const SPONSORS = [];          // { name, logoUrl, url, tier } — empty until you have sponsors
export const SPONSOR_TIERS = ['platinum', 'gold', 'silver', 'bronze'];  // display order
export const SPONSOR_CONTACT = {
  githubIssue: `${REPO}/issues/new?template=sponsor.yml`,  // the template route (see gotcha)
  kofi: KOFI_URL,
  docsUrl: `${REPO}/blob/main/SPONSORS.md`,
};
```

Adding a sponsor = one PR touching this array **and** `SPONSORS.md` (keep them
in lockstep; a test can assert they match).

### 6. In-app surface — Support page section + footer link

- A **Sponsors section** on the Support/About page: a logo grid grouped by
  tier that renders from `SPONSORS`, with a **tasteful empty state** ("Be the
  first to sponsor — your logo here" + an outlined slot) while the array is
  empty, a **"Become a sponsor"** button opening `SPONSOR_CONTACT.githubIssue`
  via the app's external-open helper (Tauri-safe), and a one-line explainer of
  what sponsors get, linking to `SPONSORS.md`.
- A **compact footer link/icon** that opens that section. Keep it small and
  uniform with the other footer icons.
- Logos: lazy-loaded, max-height capped, `aria-label`ed, `rel="noreferrer"`.

## How to replicate on another project (checklist)

1. Copy `SPONSORS.md`, `.github/FUNDING.yml`, `.github/ISSUE_TEMPLATE/sponsor.yml`.
   Find-and-replace the repo slug, handle, and funding URLs. Write your own
   honest funding story + "where your money goes".
2. Add the README `## Sponsors` subsection with the `SPONSORS:START/END`
   markers and a nav entry.
3. If the project has an app UI: add the `sponsors.js` config (empty array),
   a Sponsors section on your support/about screen, and a footer link. Wire
   the CTA to the issue-template route. If it's a library/CLI with no UI,
   skip this — the docs + FUNDING.yml carry it.
4. Leave prices and any public contact as `<!-- OWNER: … -->` placeholders for
   the maintainer to fill. Don't invent amounts or publish a personal email.
5. (Optional, recommended) Add the **value-moment donation prompt** — a
   throttled, opt-out-able "support us" nudge shown only after a real success,
   never more than rarely. That's a separate component; see the donation-
   moments implementation.
6. Add a test that `sponsors.js` and `SPONSORS.md` list the same sponsors, so
   they can't drift.

## What NOT to do

- ❌ A sponsor-management SaaS or a third-party embed (breaks local-first,
  adds a dependency, holds credentials).
- ❌ Bare `issues/new?body=…` prefill when blank issues are disabled (body is
  dropped — use `?template=`).
- ❌ Inventing tier prices or publishing a personal contact email in an
  automated edit — leave `OWNER:` markers.
- ❌ Gating features behind tiers, or nagging. The software stays free; the
  ask stays a rare, respected thank-you moment.

---

*Provenance: this is the system shipped in OmniVoice Studio — `SPONSORS.md`,
the README Sponsors section, `.github/FUNDING.yml`, `.github/ISSUE_TEMPLATE/
sponsor.yml`, `frontend/src/config/sponsors.js`, the Support-page Sponsors
section, and the footer link. Copy them and adapt.*
