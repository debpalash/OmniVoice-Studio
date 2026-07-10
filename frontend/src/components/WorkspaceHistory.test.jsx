// Generation takes: the Studio history rail's star / load-as-output actions.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import WorkspaceHistory from './WorkspaceHistory';

beforeAll(() => {
  // LazyWaveform defers the real <WaveformPlayer> behind an IntersectionObserver;
  // a no-op stub keeps rows rendered without ever mounting the audio fetch.
  global.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
});

const takes = [
  {
    id: 'aa1',
    mode: 'clone',
    text: 'first take',
    audio_path: 'aa1.wav',
    starred: 0,
    created_at: 2,
  },
  {
    id: 'bb2',
    mode: 'design',
    text: 'second take',
    audio_path: 'bb2.wav',
    starred: 1,
    created_at: 1,
  },
];

const noop = () => {};

function renderRail(overrides = {}) {
  return render(
    <WorkspaceHistory
      history={takes}
      handleSaveHistoryAsProfile={noop}
      handleLockProfile={noop}
      handleNativeExport={noop}
      restoreHistory={noop}
      deleteHistory={noop}
      toggleStarHistory={noop}
      playTakeAsOutput={noop}
      {...overrides}
    />,
  );
}

describe('WorkspaceHistory takes actions', () => {
  it('star button reflects the starred state and calls the handler', () => {
    const toggleStarHistory = vi.fn();
    renderRail({ toggleStarHistory });

    const unstarred = screen.getByTestId('take-star-aa1');
    const starred = screen.getByTestId('take-star-bb2');
    expect(unstarred).toHaveAttribute('aria-pressed', 'false');
    expect(starred).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(unstarred);
    expect(toggleStarHistory).toHaveBeenCalledTimes(1);
    expect(toggleStarHistory.mock.calls[0][0].id).toBe('aa1');
  });

  it('load-as-output button hands the take to the player handler', () => {
    const playTakeAsOutput = vi.fn();
    renderRail({ playTakeAsOutput });

    fireEvent.click(screen.getByTestId('take-play-bb2'));
    expect(playTakeAsOutput).toHaveBeenCalledTimes(1);
    expect(playTakeAsOutput.mock.calls[0][0].id).toBe('bb2');
  });

  it('starred filter narrows the rail to starred takes only', () => {
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'Starred' }));
    expect(screen.queryByTestId('take-star-aa1')).toBeNull();
    expect(screen.getByTestId('take-star-bb2')).toBeInTheDocument();
  });

  it('omits the takes actions when no handlers are passed (dub rail safety)', () => {
    renderRail({ toggleStarHistory: undefined, playTakeAsOutput: undefined });
    expect(screen.queryByTestId('take-star-aa1')).toBeNull();
    expect(screen.queryByTestId('take-play-aa1')).toBeNull();
  });
});
