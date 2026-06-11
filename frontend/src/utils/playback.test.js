// Unit tests for the global single-playback manager (issue #316).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  claimPlayback,
  stopActivePlayback,
  activePlaybackSource,
  subscribePlayback,
} from './playback';

afterEach(() => {
  // Leave the singleton idle between tests.
  stopActivePlayback();
});

describe('playback manager', () => {
  it('is idle by default', () => {
    expect(activePlaybackSource()).toBeNull();
  });

  it('tracks the source of the active playback', () => {
    claimPlayback(vi.fn(), 'design-preview');
    expect(activePlaybackSource()).toBe('design-preview');
  });

  it('claiming stops the previous playback (no overlap)', () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    claimPlayback(stopA, 'a');
    claimPlayback(stopB, 'b');
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).not.toHaveBeenCalled();
    expect(activePlaybackSource()).toBe('b');
  });

  it('stopActivePlayback halts the current playback and goes idle', () => {
    const stop = vi.fn();
    claimPlayback(stop, 'output');
    stopActivePlayback();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(activePlaybackSource()).toBeNull();
    // Idempotent: a second stop is a no-op.
    stopActivePlayback();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('release() clears only its own claim', () => {
    const releaseA = claimPlayback(vi.fn(), 'a');
    const stopB = vi.fn();
    claimPlayback(stopB, 'b');
    // Stale release from A must not clear (or stop) B.
    releaseA();
    expect(activePlaybackSource()).toBe('b');
    expect(stopB).not.toHaveBeenCalled();
  });

  it('release() after natural end goes idle without calling stop', () => {
    const stop = vi.fn();
    const release = claimPlayback(stop, 'output');
    release();
    expect(activePlaybackSource()).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    // Safe to call twice.
    release();
    expect(activePlaybackSource()).toBeNull();
  });

  it('survives a stop callback that throws', () => {
    claimPlayback(() => { throw new Error('already closed'); }, 'a');
    expect(() => stopActivePlayback()).not.toThrow();
    expect(activePlaybackSource()).toBeNull();
  });

  it('notifies subscribers on claim, stop, and release', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePlayback(listener);

    const release = claimPlayback(vi.fn(), 'a');
    expect(listener).toHaveBeenCalledTimes(1);

    release();
    expect(listener).toHaveBeenCalledTimes(2);

    claimPlayback(vi.fn(), 'b');
    stopActivePlayback();
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    claimPlayback(vi.fn(), 'c');
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
