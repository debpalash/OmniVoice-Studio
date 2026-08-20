import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../DubSegmentTable', () => ({ default: () => null }));

import DubRightColumn from './DubRightColumn';

const noop = () => {};

function column(multiBatchBusy, setDubLang = noop, setDubLangCode = noop, overrides = {}) {
  return (
    <DubRightColumn
      t={(key) => key}
      preserveBg={false}
      setPreserveBg={noop}
      dualSubs={false}
      setDualSubs={noop}
      burnSubs={false}
      setBurnSubs={noop}
      defaultTrack="original"
      setDefaultTrack={noop}
      dubLangCode="bn"
      multiLangMode
      batchTargets={[
        { lang: 'Bengali', code: 'bn' },
        { lang: 'Spanish', code: 'es' },
      ]}
      multiBatchBusy={multiBatchBusy}
      setDubLang={setDubLang}
      setDubLangCode={setDubLangCode}
      dubTracks={[]}
      timingStrategy="concise"
      setTimingStrategy={noop}
      voiceMatch="per_line"
      setVoiceMatch={noop}
      dubTranscript=""
      showTranscript={false}
      setShowTranscript={noop}
      dubJobId={null}
      glossaryVisible={false}
      selectedSegIds={new Set()}
      speakerClones={{}}
      profiles={[]}
      showCheckpoint={false}
      isTranslating={false}
      dubSegments={[]}
      dubStep="editing"
      {...overrides}
    />
  );
}

describe('DubRightColumn language targets', () => {
  it('localizes the lip-sync timing option', async () => {
    await act(async () => {
      render(column(false));
      await Promise.resolve();
    });

    expect(screen.getByRole('radio', { name: 'dub.timing_lip_sync' })).toBeInTheDocument();
  });

  it('disables language switches for the full shared batch lock', async () => {
    const setDubLang = vi.fn();
    const setDubLangCode = vi.fn();
    let rerender;
    await act(async () => {
      ({ rerender } = render(column(true, setDubLang, setDubLangCode)));
      await Promise.resolve();
    });
    const language = screen.getByRole('combobox', { name: 'dub.language' });

    expect(language).toBeDisabled();
    expect(setDubLangCode).not.toHaveBeenCalled();

    await act(async () => {
      rerender(column(false, setDubLang, setDubLangCode));
      await Promise.resolve();
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'dub.language' }), {
      target: { value: 'es' },
    });
    expect(setDubLang).toHaveBeenCalledWith('Spanish');
    expect(setDubLangCode).toHaveBeenCalledWith('es');
  });

  it('renders the first available dub when the saved default is stale', () => {
    render(
      column(false, noop, noop, {
        defaultTrack: 'fr',
        dubLangCode: 'bn',
        dubTracks: ['es'],
      }),
    );

    expect(screen.getByRole('combobox', { name: 'dub.default_track' })).toHaveValue('es');
  });
});
