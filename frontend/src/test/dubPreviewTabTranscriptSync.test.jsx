import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../i18n';

// Preview-tab ↔ transcript sync: clicking a dubbed-language pill on the
// Export step must ALSO switch the segment texts to that language (the P1.2
// per-language translations store) — previously the tabs only swapped the
// video, so previewing German played German audio over Bengali segment text.

vi.mock('../components/WaveformTimeline', () => ({ default: () => <div data-testid="wf" /> }));
vi.mock('../components/MultiLangPicker', () => ({ default: () => <div data-testid="mlp" /> }));
vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), loading: vi.fn() },
}));
const dubListTracks = vi.hoisted(() => vi.fn());
vi.mock('../api/dub', () => ({ dubListTracks: (...a) => dubListTracks(...a) }));

import DubLeftColumn from '../components/dub/DubLeftColumn';
import { useAppStore } from '../store';

const t = i18n.t.bind(i18n);

function makeProps(over = {}) {
  return {
    hasDubbedTrack: true,
    t,
    i18n,
    previewMode: 'bn',
    setPreviewMode: vi.fn(),
    dubTracks: ['bn', 'de'],
    videoSrc: '',
    waveformRef: createRef(),
    dubJobId: 'job1',
    dubSegments: [{ id: '1', text: 'hi' }],
    timelineOnsets: [],
    timelineSelSegId: null,
    setTimelineSelSegId: vi.fn(),
    incrementalPlan: null,
    segmentMoveResize: vi.fn(),
    segmentDelete: vi.fn(),
    onTimelinePreviewSegment: vi.fn(),
    dubStep: 'done',
    dubProgress: { current: 0, total: 0, text: '' },
    fmtDur: (s) => `${s}s`,
    genElapsed: 0,
    genRemaining: null,
    speakerClones: {},
    setDubSegments: vi.fn(),
    profiles: [],
    settingsOpen: false,
    setSettingsOpen: vi.fn(),
    dubLang: 'Bengali',
    dubLangCode: 'bn',
    translateQuality: 'fast',
    activeEngineUnavailable: false,
    translateProvider: 'google',
    dubInstruct: '',
    setDubInstruct: vi.fn(),
    handleTranslateAll: vi.fn(),
    isTranslating: false,
    editSegments: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  dubListTracks.mockResolvedValue({ tracks: {} });
  useAppStore.setState({
    dubLangCode: 'bn',
    dubLang: 'Bengali',
    dubSegments: [
      {
        id: '1',
        text: 'বাংলা লাইন',
        text_original: 'the original line',
        translations: { bn: 'বাংলা লাইন', de: 'die deutsche Zeile' },
      },
    ],
  });
});

describe('preview tab → transcript language sync', () => {
  it('clicking a language pill swaps segment text to that language', () => {
    render(<DubLeftColumn {...makeProps()} />);
    fireEvent.click(screen.getByRole('radio', { name: /german|deutsch/i }));
    const st = useAppStore.getState();
    expect(st.dubLangCode).toBe('de');
    expect(st.dubSegments[0].text).toBe('die deutsche Zeile');
    // Outgoing language snapshotted, not lost.
    expect(st.dubSegments[0].translations.bn).toBe('বাংলা লাইন');
  });

  it('the Original pill leaves the editing language untouched', () => {
    render(<DubLeftColumn {...makeProps()} />);
    fireEvent.click(screen.getByRole('radio', { name: /original/i }));
    expect(useAppStore.getState().dubLangCode).toBe('bn');
  });
});
