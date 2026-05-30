import { describe, it, expect } from 'vitest';
import { createStoriesSlice, DEFAULT_CAST } from './storiesSlice';

function harness() {
  let state: any = {};
  const set = (fn: any) => { state = { ...state, ...(typeof fn === 'function' ? fn(state) : fn) }; };
  const get = () => state;
  state = createStoriesSlice(set as any, get as any, {} as any);
  return { get };
}

describe('storiesSlice', () => {
  it('starts with empty tracks and a Narrator cast', () => {
    const { get } = harness();
    expect(get().storyTracks).toEqual([]);
    expect(get().cast).toHaveLength(1);
    expect(get().cast[0].id).toBe('narrator');
  });

  it('setStoryTracks replaces the list', () => {
    const { get } = harness();
    get().setStoryTracks([{ id: 1, character: 'narrator', text: 'hi', profileId: null, emotion: null, speed: null }]);
    expect(get().storyTracks).toHaveLength(1);
  });

  it('upsertCastMember adds then updates by id', () => {
    const { get } = harness();
    get().upsertCastMember({ id: 'fox', name: 'Fox', color: '#d3869b', profileId: null });
    expect(get().cast).toHaveLength(2);
    get().upsertCastMember({ id: 'fox', name: 'Fox', color: '#d3869b', profileId: 'p1' });
    expect(get().cast).toHaveLength(2);
    expect(get().cast.find((c: any) => c.id === 'fox').profileId).toBe('p1');
  });

  it('setCharacterVoice maps a cast member to a profile (null clears)', () => {
    const { get } = harness();
    get().setCharacterVoice('narrator', 'p9');
    expect(get().cast[0].profileId).toBe('p9');
    get().setCharacterVoice('narrator', null);
    expect(get().cast[0].profileId).toBeNull();
  });

  it('removeCastMember drops by id', () => {
    const { get } = harness();
    get().upsertCastMember({ id: 'owl', name: 'Owl', color: '#83a598', profileId: null });
    get().removeCastMember('owl');
    expect(get().cast.find((c: any) => c.id === 'owl')).toBeUndefined();
  });

  it('DEFAULT_CAST is not shared by reference between slices', () => {
    const a = harness(); const b = harness();
    a.get().setCharacterVoice('narrator', 'x');
    expect(b.get().cast[0].profileId).toBeNull();
    expect(DEFAULT_CAST[0].profileId).toBeNull();
  });
});
