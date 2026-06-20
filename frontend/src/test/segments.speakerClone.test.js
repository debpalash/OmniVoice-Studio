import { describe, it, expect } from 'vitest';
import { applySpeakerCloneDefaults, autoProfileId } from '../utils/segments';

// #486: multi-speaker dub must auto-bind each segment to its detected
// speaker's cloned voice instead of leaving every row on "Default".
describe('applySpeakerCloneDefaults (#486)', () => {
  const clones = { 'Speaker 1': { duration: 4.2 }, 'Speaker 2': { duration: 3.1 } };

  it('assigns the auto: clone id to segments whose speaker was cloned', () => {
    const segs = [
      { id: '0', speaker_id: 'Speaker 1', profile_id: '' },
      { id: '1', speaker_id: 'Speaker 2', profile_id: '' },
    ];
    const out = applySpeakerCloneDefaults(segs, clones);
    expect(out[0].profile_id).toBe('auto:speaker_1');
    expect(out[1].profile_id).toBe('auto:speaker_2');
    expect(autoProfileId('Speaker 2')).toBe('auto:speaker_2');
  });

  it('never clobbers a profile_id the user already chose', () => {
    const segs = [{ id: '0', speaker_id: 'Speaker 1', profile_id: 'preset:narrator' }];
    expect(applySpeakerCloneDefaults(segs, clones)[0].profile_id).toBe('preset:narrator');
  });

  it('leaves a segment on Default when its speaker has no clone', () => {
    const segs = [{ id: '0', speaker_id: 'Speaker 9', profile_id: '' }];
    expect(applySpeakerCloneDefaults(segs, clones)[0].profile_id).toBe('');
  });

  it('is a no-op when there are no clones', () => {
    const segs = [{ id: '0', speaker_id: 'Speaker 1', profile_id: '' }];
    expect(applySpeakerCloneDefaults(segs, {})[0].profile_id).toBe('');
    expect(applySpeakerCloneDefaults(segs, null)).toEqual(segs);
  });
});
