import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useTTS from '../hooks/useTTS';
import { useAppStore } from '../store';
import { playBlobAudio } from '../utils/media';

// #1032: Settings → Appearance "Auto-play preview" ("play the output as soon
// as a render finishes", #666/#667) only gated the WaveformPlayer preview
// sites — the main generate path (useTTS → playBlobAudio) kept auto-playing
// unconditionally, with no visible way to stop it outside the Voice
// workspace. The pref must gate the generate auto-play too; default ON keeps
// the long-standing behavior.

vi.mock('../utils/media', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    playBlobAudio: vi.fn().mockResolvedValue(undefined),
    playPing: vi.fn(),
  };
});

vi.mock('../api/generate', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateSpeech: vi.fn().mockImplementation(async () => {
      let served = false;
      return {
        body: {
          getReader: () => ({
            read: async () => {
              if (served) return { done: true, value: undefined };
              served = true;
              return { done: false, value: new Uint8Array([0, 1, 2]) };
            },
          }),
        },
        headers: { get: () => null },
      };
    }),
  };
});

const hookProps = () => ({
  selectedProfile: null,
  setSelectedProfile: vi.fn(),
  loadHistory: vi.fn().mockResolvedValue(undefined),
  profiles: [],
});

async function runGenerate() {
  const { result } = renderHook(() => useTTS(hookProps()));
  await act(async () => {
    await result.current.handleGenerate();
  });
}

beforeEach(() => {
  vi.mocked(playBlobAudio).mockClear();
  // Design path needs no reference audio; non-empty text passes validation.
  useAppStore.setState({ text: 'Hello there', defineMethod: 'design' });
});

describe('useTTS auto-play pref (#1032)', () => {
  it('auto-plays the finished render when autoPlayPreview is ON (default)', async () => {
    useAppStore.setState({ autoPlayPreview: true });
    await runGenerate();
    expect(playBlobAudio).toHaveBeenCalledTimes(1);
    expect(playBlobAudio.mock.calls[0][0]).toBeInstanceOf(Blob);
  });

  it('does NOT auto-play when autoPlayPreview is OFF', async () => {
    useAppStore.setState({ autoPlayPreview: false });
    await runGenerate();
    expect(playBlobAudio).not.toHaveBeenCalled();
  });
});
