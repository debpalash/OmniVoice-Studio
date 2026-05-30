import { describe, it, expect } from 'vitest';
import { createStoriesSlice, DEFAULT_CAST } from './storiesSlice';

function harness() {
  let state: any = {};
  const set = (fn: any) => { state = { ...state, ...(typeof fn === 'function' ? fn(state) : fn) }; };
  const get = () => state;
  state = createStoriesSlice(set as any, get as any, {} as any);
  return { get };
}

function track(id: number, character = 'narrator', text = 'hi') {
  return { id, character, text, profileId: null, emotion: null, speed: null };
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

describe('storiesSlice — projects', () => {
  it('saveProject snapshots current tracks/cast and sets currentProjectId', () => {
    const { get } = harness();
    get().setStoryTracks([track(1)]);
    get().saveProject('My Book');
    expect(get().storyProjects).toHaveLength(1);
    expect(get().storyProjects[0].name).toBe('My Book');
    expect(get().storyProjects[0].tracks).toHaveLength(1);
    expect(get().currentProjectId).toBe(get().storyProjects[0].id);
  });

  it('saving again with a currentProjectId updates in place (no duplicate)', () => {
    const { get } = harness();
    get().setStoryTracks([track(1)]);
    get().saveProject('A');
    get().setStoryTracks([track(1), track(2)]);
    get().saveProject('A');
    expect(get().storyProjects).toHaveLength(1);
    expect(get().storyProjects[0].tracks).toHaveLength(2);
  });

  it('loadProject restores tracks/cast and newProject clears', () => {
    const { get } = harness();
    get().setStoryTracks([track(1), track(2)]);
    get().saveProject('A');
    const id = get().currentProjectId;
    get().newProject();
    expect(get().storyTracks).toEqual([]);
    expect(get().currentProjectId).toBeNull();
    get().loadProject(id);
    expect(get().storyTracks).toHaveLength(2);
    expect(get().currentProjectId).toBe(id);
  });

  it('deleteProject removes it and clears current; renameProject renames', () => {
    const { get } = harness();
    get().saveProject('A');
    const id = get().currentProjectId;
    get().renameProject(id, 'Renamed');
    expect(get().storyProjects[0].name).toBe('Renamed');
    get().deleteProject(id);
    expect(get().storyProjects).toHaveLength(0);
    expect(get().currentProjectId).toBeNull();
  });

  it('saved project tracks are stripped of transient fields', () => {
    const { get } = harness();
    get().setStoryTracks([{ ...track(1), generating: true, audioUrl: 'blob:x' } as any]);
    get().saveProject('A');
    expect('generating' in get().storyProjects[0].tracks[0]).toBe(false);
    expect('audioUrl' in get().storyProjects[0].tracks[0]).toBe(false);
  });
});
