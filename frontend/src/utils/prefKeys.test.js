/**
 * Guard for the factory-reset preference registry (utils/prefKeys.js).
 *
 * Scans the whole src tree for localStorage keys — direct string literals in
 * localStorage.*Item(...) calls plus the LS_* / *_KEY constant convention —
 * and fails when a key is neither a resettable preference (covered by the
 * registry, so Settings → Factory reset clears it) nor an explicitly
 * PRESERVED key. This makes "add a pref key but forget factory reset"
 * impossible to reintroduce silently.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPrefKey,
  PRESERVED_KEYS,
  PREF_KEYS,
  PREF_KEY_PREFIXES,
  clearLocalPreferences,
} from './prefKeys';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx']);

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      yield* sourceFiles(p);
    } else if (SOURCE_EXT.has(path.extname(entry.name)) && !/\.test\.[jt]sx?$/.test(entry.name)) {
      yield p;
    }
  }
}

function collectLocalStorageKeys() {
  const found = new Map(); // key → first file seen
  const record = (key, file) => {
    if (!found.has(key)) found.set(key, path.relative(SRC_ROOT, file));
  };
  // 1. Literal keys passed straight to localStorage.
  const directRe = /localStorage\.(?:getItem|setItem|removeItem)\(\s*['"]([^'"]+)['"]/g;
  // 2. The storage-key constant convention (LS_FOO / FOO_KEY / zustand `name:`).
  const constRe = /(?:const|let|var)\s+(?:LS_[A-Z0-9_]+|[A-Z0-9_]*_KEY)\s*=\s*['"]([^'"]+)['"]/g;
  const zustandRe = /name:\s*['"](omnivoice\.[^'"]+)['"]\s*,?\s*\n\s*storage:\s*createJSONStorage/g;
  for (const file of sourceFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of [directRe, constRe, zustandRe]) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(text)); ) record(m[1], file);
    }
  }
  return found;
}

describe('prefKeys registry', () => {
  it('categorizes every localStorage key in src as pref (resettable) or preserved', () => {
    const found = collectLocalStorageKeys();
    expect(found.size).toBeGreaterThanOrEqual(15); // sanity: the scan actually finds keys
    const uncategorized = [...found.entries()].filter(
      ([key]) => !isPrefKey(key) && !PRESERVED_KEYS.includes(key),
    );
    expect(
      uncategorized,
      `localStorage keys not covered by the factory-reset registry (utils/prefKeys.js).\n` +
        `Either use a registered prefix (${PREF_KEY_PREFIXES.join(', ')}), add the key to ` +
        `PREF_KEYS, or — if it is user data / connection state — to PRESERVED_KEYS with a reason:\n` +
        uncategorized.map(([k, f]) => `  '${k}' (${f})`).join('\n'),
    ).toEqual([]);
  });

  it('never classifies preserved keys as resettable', () => {
    for (const k of PRESERVED_KEYS) expect(isPrefKey(k)).toBe(false);
    for (const k of PREF_KEYS) expect(isPrefKey(k)).toBe(true);
  });

  describe('clearLocalPreferences', () => {
    beforeEach(() => localStorage.clear());

    it('removes every pref key and keeps data/connection keys', () => {
      localStorage.setItem('omnivoice.app', '{"state":{}}');
      localStorage.setItem('omnivoice.navRailSide', 'right');
      localStorage.setItem('omnivoice.logs.collapsed', '1');
      localStorage.setItem('omnivoice.settings.category', 'storage');
      localStorage.setItem('omni_capture_live_typing', '1');
      localStorage.setItem('ov_stories_global_speed', '1.2');
      localStorage.setItem('omni_ui', '{"uiScale":1.1}');
      localStorage.setItem('dismissed_lang_suggestion', 'true');
      // Must survive:
      localStorage.setItem('ov_backend_url', 'http://192.168.1.10:7842');
      localStorage.setItem('ov_api_key', 'k');
      localStorage.setItem('omni_transcriptions', '[{"text":"hi"}]');

      const removed = clearLocalPreferences();

      expect(removed).toHaveLength(8);
      expect(localStorage.getItem('omnivoice.app')).toBeNull();
      expect(localStorage.getItem('omnivoice.navRailSide')).toBeNull();
      expect(localStorage.getItem('omnivoice.logs.collapsed')).toBeNull();
      expect(localStorage.getItem('omnivoice.settings.category')).toBeNull();
      expect(localStorage.getItem('omni_capture_live_typing')).toBeNull();
      expect(localStorage.getItem('ov_stories_global_speed')).toBeNull();
      expect(localStorage.getItem('omni_ui')).toBeNull();
      expect(localStorage.getItem('dismissed_lang_suggestion')).toBeNull();
      expect(localStorage.getItem('ov_backend_url')).toBe('http://192.168.1.10:7842');
      expect(localStorage.getItem('ov_api_key')).toBe('k');
      expect(localStorage.getItem('omni_transcriptions')).toBe('[{"text":"hi"}]');
    });
  });
});
