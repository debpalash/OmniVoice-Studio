import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PlaybackStopPill from '../components/PlaybackStopPill';
import { claimPlayback, stopActivePlayback } from '../utils/playback';

// #1032: playBlobAudio plays through a bare Audio()/AudioContext with no
// on-screen player (source 'output') — the generate auto-play and profile /
// segment previews. Outside the Voice workspace's ActionBar there was no way
// to stop it. The global pill must appear for 'output' playback on any page,
// stop it on click, and stay out of the way for playback that already has a
// visible player (WaveformPlayer sources, demos).

afterEach(() => {
  stopActivePlayback(); // never leak an active claim into the next test
});

describe('PlaybackStopPill (#1032)', () => {
  it('renders nothing when idle', () => {
    render(<PlaybackStopPill />);
    expect(screen.queryByRole('button', { name: /stop playback/i })).toBeNull();
  });

  it('appears for an "output" playback and stops it on click', () => {
    const stop = vi.fn();
    render(<PlaybackStopPill />);
    act(() => {
      claimPlayback(stop, 'output');
    });
    const btn = screen.getByRole('button', { name: /stop playback/i });
    fireEvent.click(btn);
    expect(stop).toHaveBeenCalledTimes(1);
    // Manager cleared → the pill unmounts.
    expect(screen.queryByRole('button', { name: /stop playback/i })).toBeNull();
  });

  it('disappears when playback ends on its own (release)', () => {
    render(<PlaybackStopPill />);
    let release;
    act(() => {
      release = claimPlayback(vi.fn(), 'output');
    });
    expect(screen.getByRole('button', { name: /stop playback/i })).toBeInTheDocument();
    act(() => {
      release();
    });
    expect(screen.queryByRole('button', { name: /stop playback/i })).toBeNull();
  });

  it('ignores sources that already have visible player UI', () => {
    render(<PlaybackStopPill />);
    act(() => {
      claimPlayback(vi.fn(), 'design-preview');
    });
    expect(screen.queryByRole('button', { name: /stop playback/i })).toBeNull();
  });
});
