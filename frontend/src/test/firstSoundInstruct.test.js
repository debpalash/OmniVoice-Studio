/**
 * The first-sound request (App.jsx, fired once right after onboarding) used
 * to send `instruct: 'A warm, friendly narrator voice, medium pace'`. Every
 * engine's `instruct` is a controlled vocabulary, not free text — OmniVoice's
 * `_resolve_instruct` (omnivoice/models/omnivoice.py) rejects anything
 * outside a fixed token list, so that prose 400ed on every single first run.
 * The catch block around the request is deliberately silent (a first
 * impression must never surface an error), so the user just got no audio and
 * no explanation (#1853).
 *
 * Omitting `instruct` entirely isn't safe either: the mlx-audio Qwen3
 * VoiceDesign backend (`backend/services/tts_backend.py`, `_is_voice_design`)
 * *requires* a truthy instruct and raises `ValueError` without one, so a user
 * who picked that engine during onboarding would still get silence — the
 * same failure class, just a different engine. The fix instead sends the
 * same taxonomy-token instruct the built-in "Narrator" personality uses:
 * valid vocabulary for OmniVoice, and a non-empty description for any
 * voice-design engine.
 *
 * Exercised through the source text rather than a full App render: App.jsx
 * pulls in the whole shell (Header, NavRail, a dozen lazy pages, Tauri APIs,
 * the audio player, …), none of which this regression depends on — only the
 * literal FormData built for this one request.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = fs.readFileSync(
  path.resolve(__dirname, '..', 'App.jsx'),
  'utf8'
);

const firstSoundBlock = (() => {
  const start = appSrc.indexOf('── First sound ──');
  const end = appSrc.indexOf('── Tauri auto-updater ──', start);
  expect(start, 'First sound section marker moved or was removed').toBeGreaterThan(-1);
  expect(end, 'Tauri auto-updater section marker moved or was removed').toBeGreaterThan(start);
  return appSrc.slice(start, end);
})();

// The exact instruct string the first-sound request appends.
const instructMatch = firstSoundBlock.match(
  /fd\.append\(\s*['"]instruct['"]\s*,\s*['"]([^'"]*)['"]\s*\)/,
);

// Cross-check against the backend's own "Narrator" personality preset so the
// two can never silently drift apart — the whole point is reusing a value
// the backend has already vetted as valid taxonomy vocabulary.
const personalitiesSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', 'backend', 'core', 'personalities.py'),
  'utf8',
);
const narratorMatch = personalitiesSrc.match(
  /"id":\s*"narrator"[\s\S]*?"instruct":\s*"([^"]*)"/,
);

describe('the first-sound request sends an engine-safe instruct', () => {
  it('never reintroduces the old hardcoded narrator prose anywhere in App.jsx', () => {
    expect(appSrc).not.toMatch(/warm,\s*friendly narrator voice/i);
  });

  it('appends a non-empty `instruct` field to the first-sound FormData', () => {
    // Must be present (not omitted) and non-empty: a voice-design engine
    // (mlx-audio's Qwen3 VoiceDesign) raises on a missing/empty instruct
    // (`_is_voice_design()` in tts_backend.py), so omitting it just trades
    // one silent failure for another.
    expect(instructMatch, 'expected fd.append("instruct", "...") in the first-sound block').not.toBeNull();
    expect(instructMatch[1].trim().length).toBeGreaterThan(0);
  });

  it('only sends comma-separated taxonomy tokens, never free-text prose', () => {
    // OmniVoice's `_resolve_instruct` splits on commas and validates each
    // item against a fixed vocabulary — sentence-shaped text (articles,
    // "voice"/"pace"/"like a ...") can never pass. A taxonomy string is
    // short, lowercase-ish, comma-separated tokens only.
    const value = instructMatch[1];
    expect(value).not.toMatch(/\b(a|voice|pace|like)\b/i);
    for (const token of value.split(',')) {
      expect(token.trim()).toMatch(/^[a-z-]+(?: [a-z-]+)*$/);
    }
  });

  it('matches the backend\'s own "Narrator" personality instruct exactly', () => {
    expect(narratorMatch, 'expected a "narrator" personality with an instruct in personalities.py').not.toBeNull();
    expect(instructMatch[1]).toBe(narratorMatch[1]);
  });

  it('still builds the rest of the first-sound request (text + num_step)', () => {
    // Sanity check that the slice targets the right block and the fix didn't
    // collaterally remove anything else the request needs.
    expect(firstSoundBlock).toMatch(/fd\.append\(\s*['"]text['"]/);
    expect(firstSoundBlock).toMatch(/fd\.append\(\s*['"]num_step['"]/);
  });
});
