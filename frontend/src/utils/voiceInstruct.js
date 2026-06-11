// Explicit .js extension so this module also loads under plain node ESM
// (tests/frontend/describeVoice.test.mjs runs via `node --test`).
import { CATEGORIES } from './constants.js';

// Lowercased tag -> its category name. The engine validator
// (omnivoice/models/omnivoice.py::_resolve_instruct) accepts ONLY these
// whitelist tags, one per category — so the Voice Design payload must be built
// from them, not raw free text.
const TAG_TO_CATEGORY = (() => {
  const map = {};
  for (const [cat, values] of Object.entries(CATEGORIES)) {
    for (const v of values) {
      if (v !== 'Auto') map[v.toLowerCase()] = cat;
    }
  }
  return map;
})();

/**
 * Build a validator-safe Voice Design instruct from the category dropdown
 * selections (`vdStates`) plus the optional free-text field.
 *
 * - Dropdowns contribute one valid tag per category (they win their category).
 * - Free-text items are accepted only if they're a known tag whose category is
 *   still open. The rest are returned split into two buckets so the caller can
 *   show an accurate message:
 *     - `unsupported`: not a known tag (free-text prose) — the #115 case;
 *     - `duplicates`:  a valid tag whose category was already set (e.g. a
 *       dropdown's `low pitch` outranks a typed `high pitch`) — the #114 case.
 *
 * @returns {{ instruct: string, unsupported: string[], duplicates: string[] }}
 */
export function buildDesignInstruct(vdStates = {}, freeText = '') {
  const byCategory = {};
  const unsupported = [];
  const duplicates = [];

  // Dropdowns first — they win their category.
  for (const value of Object.values(vdStates || {})) {
    const item = String(value ?? '').trim();
    if (!item || item === 'Auto') continue;
    const cat = TAG_TO_CATEGORY[item.toLowerCase()];
    if (!cat) {
      // A dropdown value that isn't in CATEGORIES means the option list and the
      // whitelist have drifted — silently dropping it would hide a real bug.
      console.warn(`buildDesignInstruct: unknown dropdown value "${item}" (not in CATEGORIES)`);
      continue;
    }
    if (!(cat in byCategory)) byCategory[cat] = item.toLowerCase();
  }

  // Free-text field — accept valid tags in open categories; bucket the rest.
  for (const raw of String(freeText || '').split(/[,，]/)) {
    const item = raw.trim();
    if (!item) continue;
    const cat = TAG_TO_CATEGORY[item.toLowerCase()];
    if (!cat) {
      unsupported.push(item);
    } else if (cat in byCategory) {
      duplicates.push(item);
    } else {
      byCategory[cat] = item.toLowerCase();
    }
  }

  return { instruct: Object.values(byCategory).join(', '), unsupported, duplicates };
}

/**
 * Project the backend's "describe your voice" result (#317) onto a fresh
 * vdStates object. The description drives the *whole* parameter set — matched
 * categories get their token, everything else resets to 'Auto' — so retyping
 * a description never leaves stale tokens from the previous one behind. The
 * user can still hand-tune any control afterwards.
 *
 * Tokens are validated against CATEGORIES so a drifted/older backend can
 * never inject a value the picker (and the instruct whitelist) doesn't know.
 *
 * @param {Record<string, string>} attrs  backend response `attrs`
 * @returns {Record<string, string>} complete vdStates (every category present)
 */
export function mergeDescribedAttrs(attrs = {}) {
  const out = {};
  for (const [cat, options] of Object.entries(CATEGORIES)) {
    const v = attrs?.[cat];
    out[cat] = v && v !== 'Auto' && options.includes(v) ? v : 'Auto';
  }
  return out;
}
