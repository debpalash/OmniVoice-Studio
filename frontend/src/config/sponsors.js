// Single source of truth for OmniVoice's sponsors + the "become a sponsor"
// contact links. Consumed by the Support page's Sponsors section and the
// footer's Sponsors link, so a logo or link change lands in exactly one place.
//
// Local-first / zero-token by design: "Become a sponsor" opens a PREFILLED
// GitHub issue (same pattern as the bug reporter, utils/bugReport.js) — the
// user reviews and submits it in their own browser; OmniVoice never POSTs or
// holds a credential.

import { KOFI_URL } from '../utils/donateLinks';

const REPO = 'https://github.com/debpalash/OmniVoice-Studio';

/**
 * Active sponsors. EMPTY until the first sponsor signs on — the Support page
 * renders a "be the first" placeholder while this is empty.
 *
 * To add a sponsor, append an entry here AND to SPONSORS.md (repo root) — the
 * two are kept in lockstep (in-app grid ⇄ README / project-site credit):
 *
 *   {
 *     name:    'Acme Corp',                      // display name + <img alt>
 *     logoUrl: 'https://acme.example/logo.svg',  // wide / transparent works best
 *     url:     'https://acme.example',           // where the logo links to
 *     tier:    'gold',                           // one of SPONSOR_TIERS
 *   }
 *
 * @type {{ name: string, logoUrl: string, url: string, tier: string }[]}
 */
export const SPONSORS = [];

/**
 * Tier display order (highest first). Sponsors are grouped by tier on the
 * Support page; any unrecognized tier sorts to the end.
 * @type {string[]}
 */
export const SPONSOR_TIERS = ['platinum', 'gold', 'silver', 'bronze'];

// Prefilled "become a sponsor" issue — labelled `sponsor`, with the title +
// body seeded so the maintainer gets a structured request and the user only
// has to click Submit. Mirrors the bug-report prefilled-URL flow so we never
// hold a token (CLAUDE.md Capability 2).
const SPONSOR_ISSUE_TITLE = 'Sponsorship: <your name / organization>';
const SPONSOR_ISSUE_BODY = [
  "I'd like to sponsor OmniVoice Studio. ❤️",
  '',
  '- **Name / organization:**',
  '- **Logo URL (SVG or wide PNG):**',
  '- **Link the logo should point to:**',
  '- **Tier (platinum / gold / silver / bronze):**',
  '- **Best way to reach me:**',
  '',
  '<!-- Sponsors get their logo in-app, in the README, and a slot on the project site. Thank you for keeping local AI alive! -->',
].join('\n');

/**
 * Where "Become a sponsor" and the tier docs point. Single source of truth for
 * both the Support page and the footer link.
 */
export const SPONSOR_CONTACT = {
  /** Prefilled, zero-auth GitHub issue (user reviews + submits in-browser). */
  githubIssue: `${REPO}/issues/new?labels=${encodeURIComponent(
    'sponsor',
  )}&title=${encodeURIComponent(SPONSOR_ISSUE_TITLE)}&body=${encodeURIComponent(
    SPONSOR_ISSUE_BODY,
  )}`,
  /** One-tap alternative for individuals who'd rather tip than sign a deal. */
  kofi: KOFI_URL,
  /** SPONSORS.md on GitHub — what sponsors get + the current roster. */
  docsUrl: `${REPO}/blob/main/SPONSORS.md`,
};
