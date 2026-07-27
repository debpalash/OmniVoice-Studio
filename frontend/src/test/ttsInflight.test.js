/**
 * Every synth path must register as "in flight" for as long as it runs, so the
 * updater can't relaunch the process and discard it.
 *
 * Two ways the earlier version of this got it wrong:
 *
 *   1. It was tracked in useTTS, so the Generate tab counted but voice
 *      previews, the compare modal, the stories editor and profile previews —
 *      all of which call generateSpeech directly — did not.
 *   2. It was a boolean, so two overlapping syntheses cleared each other:
 *      whichever settled first said "nothing is running" while the other was
 *      still going.
 *
 * Both are fixed by counting, at the one call they all share.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetch, state } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  state: { ttsInflight: 0 },
}));

vi.mock('../api/client', () => ({
  API: '',
  apiUrl: (p) => p,
  apiFetch: (...a) => apiFetch(...a),
  apiJson: vi.fn(),
}));

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => ({
      ...state,
      addTtsInflight: (d) => {
        state.ttsInflight = Math.max(0, state.ttsInflight + d);
      },
    }),
  },
}));

import { generateSpeech } from '../api/generate';
import { isAppBusy } from '../utils/appBusy';
import { createGenerateSlice } from '../store/generateSlice';

beforeEach(() => {
  state.ttsInflight = 0;
  apiFetch.mockReset();
});

describe('synth in-flight tracking', () => {
  it('counts a synth as busy for as long as the request runs', async () => {
    let release;
    apiFetch.mockReturnValue(
      new Promise((res) => {
        release = () => res({ ok: true });
      }),
    );

    const p = generateSpeech(new FormData());
    expect(isAppBusy(state)).toBe(true);

    release();
    await p;
    expect(isAppBusy(state)).toBe(false);
  });

  it('survives overlapping syntheses — the first to finish does not clear the rest', async () => {
    const releases = [];
    apiFetch.mockImplementation(() => new Promise((res) => releases.push(() => res({ ok: true }))));

    const a = generateSpeech(new FormData()); // Generate tab
    const b = generateSpeech(new FormData()); // a voice preview alongside it
    expect(state.ttsInflight).toBe(2);

    releases[0]();
    await a;
    // b is still synthesising — a relaunch here would discard it.
    expect(isAppBusy(state)).toBe(true);

    releases[1]();
    await b;
    expect(isAppBusy(state)).toBe(false);
  });

  it('releases on failure and on abort, not just on success', async () => {
    apiFetch.mockRejectedValueOnce(new Error('network died'));
    await expect(generateSpeech(new FormData())).rejects.toThrow('network died');
    expect(isAppBusy(state)).toBe(false);

    const abort = new DOMException('aborted', 'AbortError');
    apiFetch.mockRejectedValueOnce(abort);
    await expect(generateSpeech(new FormData())).rejects.toThrow();
    expect(isAppBusy(state)).toBe(false);
  });

  // Against the real slice, not a stand-in: an unbalanced release must not
  // drive the count below zero, or a later synth would start already "idle".
  it('never goes negative', () => {
    let s = { ttsInflight: 0 };
    const set = (fn) => {
      s = { ...s, ...fn(s) };
    };
    const slice = createGenerateSlice(set, () => s, {});

    slice.addTtsInflight(-1);
    slice.addTtsInflight(-5);
    expect(s.ttsInflight).toBe(0);

    slice.addTtsInflight(1);
    expect(s.ttsInflight).toBe(1);
    expect(isAppBusy(s)).toBe(true);
  });
});
