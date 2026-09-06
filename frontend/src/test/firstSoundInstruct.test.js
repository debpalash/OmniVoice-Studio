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

describe('the first-sound request cannot send free-text instruct prose', () => {
  it('never reintroduces the old hardcoded narrator prose anywhere in App.jsx', () => {
    expect(appSrc).not.toMatch(/warm,\s*friendly narrator voice/i);
  });

  it('does not append an `instruct` field to the first-sound FormData at all', () => {
    // Omitting it entirely — not swapping in a vocabulary string — matches
    // every other call site in the app (`if (instruct) fd.append('instruct', ...)`
    // in useTTS.js, useProfiles.js, VoicePreview.jsx, CompareModal.jsx,
    // VoiceProfile.jsx) and is proven safe: the backend's per-engine instruct
    // resolvers all treat a missing/empty instruct as "no styling", never as
    // a required field, so this degrades identically no matter which TTS
    // engine is active.
    expect(firstSoundBlock).not.toMatch(/fd\.append\(\s*['"]instruct['"]/);
  });

  it('still builds the rest of the first-sound request (text + num_step)', () => {
    // Sanity check that the slice targets the right block and the fix didn't
    // collaterally remove anything else the request needs.
    expect(firstSoundBlock).toMatch(/fd\.append\(\s*['"]text['"]/);
    expect(firstSoundBlock).toMatch(/fd\.append\(\s*['"]num_step['"]/);
  });
});
