/**
 * Single source of truth for a dub segment's *generation inputs* — the
 * fields that actually change the TTS output: text, voice, instruct,
 * speed, language, direction, effect preset.
 *
 * Both the `/dub/generate` request body and the `/tools/incremental`
 * fingerprint recompute MUST build their payloads through this helper.
 * Before #281 they diverged (the generate body expanded `preset:` voices
 * into instruct text; the recompute sent raw store fields), so the stored
 * fingerprints never matched the recomputed ones and every segment was
 * reported "changed" after every run — a 1-line edit re-dubbed all N lines.
 */
import { PRESETS } from './constants';

export function segmentGenInputs(s) {
  let profileId = s.profile_id || '';
  let instruct = s.instruct || '';
  if (profileId.startsWith('preset:')) {
    const pr = PRESETS.find(p => p.id === profileId.replace('preset:', ''));
    if (pr) {
      const parts = Object.values(pr.attrs).filter(v => v !== 'Auto');
      if (instruct.trim()) parts.push(instruct.trim());
      instruct = parts.join(', ');
    }
    profileId = '';
  }
  return {
    text: s.text,
    instruct,
    profile_id: profileId,
    speed: s.speed || undefined,
    target_lang: s.target_lang || undefined,
    direction: s.direction || undefined,
    effect_preset: s.effect_preset || undefined,
  };
}
