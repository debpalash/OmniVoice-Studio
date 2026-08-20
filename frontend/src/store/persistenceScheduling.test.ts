import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configurePersistenceRole,
  discardPendingWrites,
  flushPendingWrites,
  installPersistenceLifecycleFlush,
  resetCoalescedJsonStorageForTests,
} from '../utils/coalescedJsonStorage';
import { APP_STORE_KEY, useAppStore } from './index';

describe('app-store persistence scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    useAppStore.setState(useAppStore.getInitialState(), true);
    discardPendingWrites((key) => key === APP_STORE_KEY);
  });

  afterEach(() => {
    discardPendingWrites((key) => key === APP_STORE_KEY);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('coalesces 100 rapid transient and persisted updates into the latest v8 envelope', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    let latestScale = 1;

    for (let index = 0; index < 100; index += 1) {
      latestScale = 1 + index / 1_000;
      useAppStore.setState({
        uiScale: latestScale,
        uiScalePreviewed: index % 2 === 0,
      });
    }

    expect(setItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(setItem).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const targetWrites = setItem.mock.calls.filter(([key]) => key === APP_STORE_KEY);
    expect(targetWrites).toHaveLength(1);

    const envelope = JSON.parse(targetWrites[0][1]);
    expect(envelope).toMatchObject({
      version: 8,
      state: { uiScale: latestScale },
    });
    expect(envelope.state).not.toHaveProperty('uiScalePreviewed');
  });

  it('cancels a pending write when persist.clearStorage removes the key', async () => {
    localStorage.setItem(APP_STORE_KEY, JSON.stringify({ state: { uiScale: 1 }, version: 7 }));
    const setItem = vi.spyOn(localStorage, 'setItem');

    useAppStore.setState({ uiScale: 1.25 });
    expect(setItem).not.toHaveBeenCalled();

    useAppStore.persist.clearStorage();
    expect(localStorage.getItem(APP_STORE_KEY)).toBeNull();
    const cleanupLifecycle = installPersistenceLifecycleFlush();
    window.dispatchEvent(new Event('pagehide'));
    expect(flushPendingWrites().attempted).toBe(0);

    await vi.runAllTimersAsync();
    expect(localStorage.getItem(APP_STORE_KEY)).toBeNull();
    expect(setItem.mock.calls.filter(([key]) => key === APP_STORE_KEY)).toHaveLength(0);
    cleanupLifecycle();
  });

  it('keeps store updates and persist.clearStorage read-only in the standalone widget role', () => {
    localStorage.setItem(APP_STORE_KEY, JSON.stringify({ state: { uiScale: 1 }, version: 7 }));
    resetCoalescedJsonStorageForTests();
    configurePersistenceRole('readonly');
    const setItem = vi.spyOn(localStorage, 'setItem');
    const removeItem = vi.spyOn(localStorage, 'removeItem');

    useAppStore.setState({ uiScale: 1.25 });
    useAppStore.persist.clearStorage();
    vi.runAllTimers();
    flushPendingWrites();

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(APP_STORE_KEY) ?? 'null')).toEqual({
      state: { uiScale: 1 },
      version: 7,
    });
  });

  it('round-trips the documented long-form projection without runtime track fields', async () => {
    const runtimeTrack = {
      id: 7,
      character: 'narrator',
      text: 'Chapter one',
      profileId: 'profile-narrator',
      emotion: 'calm',
      speed: 0.95,
      generating: true,
      audioUrl: 'blob:stale-preview',
    };

    const state = useAppStore.getState();
    state.setStoryTracks([runtimeTrack]);
    state.setCast([
      {
        id: 'narrator',
        name: 'Narrator',
        color: '#fabd2f',
        profileId: 'profile-narrator',
      },
    ]);
    state.setScript('# Chapter one\nLong-form body');
    state.setProjectMeta({ title: 'A Book', author: 'A Writer' });
    state.setLexicon({ OmniVoice: 'omni voice' });
    state.setVoiceCast('Narrator', 'profile-narrator');
    state.setCoverRef({ filename: 'cover.png', serverPath: '/covers/cover.png' });
    state.setOutputPrefs({
      outputFormat: 'mp3',
      loudness: 'podcast',
      defaultVoice: 'profile-narrator',
      language: 'English',
    });
    state.setLastOutput('a-book.mp3');
    state.convertMode('audiobook');

    await vi.advanceTimersByTimeAsync(250);
    const envelope = JSON.parse(localStorage.getItem(APP_STORE_KEY) ?? 'null');
    expect(envelope).toMatchObject({
      version: 8,
      state: {
        storyTracks: [
          {
            id: 7,
            character: 'narrator',
            text: 'Chapter one',
            profileId: 'profile-narrator',
            emotion: 'calm',
            speed: 0.95,
          },
        ],
        cast: [
          {
            id: 'narrator',
            name: 'Narrator',
            color: '#fabd2f',
            profileId: 'profile-narrator',
          },
        ],
        script: '# Chapter one\nLong-form body',
        meta: { title: 'A Book', author: 'A Writer' },
        lexicon: { OmniVoice: 'omni voice' },
        voiceCast: { Narrator: 'profile-narrator' },
        coverRef: { filename: 'cover.png', serverPath: '/covers/cover.png' },
        outputFormat: 'mp3',
        loudness: 'podcast',
        defaultVoice: 'profile-narrator',
        language: 'English',
        lastOutput: 'a-book.mp3',
        projectMode: 'audiobook',
      },
    });
    expect(envelope.state.storyTracks[0]).not.toHaveProperty('generating');
    expect(envelope.state.storyTracks[0]).not.toHaveProperty('audioUrl');

    useAppStore.setState({
      storyTracks: [],
      cast: [],
      script: '',
      meta: {},
      lexicon: {},
      voiceCast: {},
      coverRef: null,
      outputFormat: 'm4b',
      loudness: 'off',
      defaultVoice: null,
      language: 'Auto',
      lastOutput: '',
      projectMode: 'stories',
    });
    discardPendingWrites((key) => key === APP_STORE_KEY);

    await useAppStore.persist.rehydrate();
    expect(useAppStore.getState()).toMatchObject(envelope.state);
    expect(useAppStore.getState().storyTracks[0]).not.toHaveProperty('generating');
    expect(useAppStore.getState().storyTracks[0]).not.toHaveProperty('audioUrl');
  });
});
