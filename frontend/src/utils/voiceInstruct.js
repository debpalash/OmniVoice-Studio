import { CATEGORIES } from './constants';

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
 *   still open; unknown/prose items and category-duplicates are dropped and
 *   returned in `dropped` so the caller can warn the user.
 *
 * This closes #114 (≤1 item per category — no "conflicting" error) and #115
 * (no unsupported free-text reaches the whitelist validator).
 *
 * @returns {{ instruct: string, dropped: string[] }}
 */
export function buildDesignInstruct(vdStates = {}, freeText = '') {
  const byCategory = {};

  const add = (value, dropped) => {
    const item = String(value ?? '').trim();
    if (!item || item === 'Auto') return;
    const key = item.toLowerCase();
    const cat = TAG_TO_CATEGORY[key];
    if (!cat) {
      if (dropped) dropped.push(item); // unknown / free-text prose
      return;
    }
    if (cat in byCategory) {
      if (dropped) dropped.push(item); // category already filled
      return;
    }
    byCategory[cat] = key; // canonical (CATEGORIES values are lowercase)
  };

  // Dropdowns first — they win their category (not tracked as "dropped").
  for (const v of Object.values(vdStates || {})) add(v, null);

  // Free-text field — accept valid tags in open categories; collect the rest.
  const dropped = [];
  for (const raw of String(freeText || '').split(/[,，]/)) add(raw, dropped);

  return { instruct: Object.values(byCategory).join(', '), dropped };
}
