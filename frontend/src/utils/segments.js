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

/** The `auto:<safe>` profile id for a diarized speaker. Mirrors the backend's
 *  clone-resolution key (`speaker_id.lower().replace(" ", "_")`) and the
 *  Voice-dropdown option value in DubTab, so the three always agree. */
export function autoProfileId(speakerId) {
  return `auto:${(speakerId || '').toLowerCase().replace(/\s+/g, '_')}`;
}

/**
 * #486: auto-assign each diarized segment to its detected speaker's cloned
 * voice instead of leaving it on "Default". When the backend cloned a speaker
 * from the video (`speakerClones[speaker_id]` present) and the segment has no
 * voice chosen yet, default its `profile_id` to that speaker's `auto:` clone.
 * The user can still override per-speaker or per-segment afterwards — we only
 * fill an *empty* profile_id, never clobber an explicit choice.
 */
export function applySpeakerCloneDefaults(segments, speakerClones) {
  const clones = (speakerClones && typeof speakerClones === 'object') ? speakerClones : {};
  if (!Array.isArray(segments) || !Object.keys(clones).length) return segments || [];
  return segments.map((s) => {
    if (!s || s.profile_id || !s.speaker_id || !clones[s.speaker_id]) return s;
    return { ...s, profile_id: autoProfileId(s.speaker_id) };
  });
}
