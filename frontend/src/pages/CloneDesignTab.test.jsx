// #1771 follow-up regressions (coordinator-verified in a real browser run):
// the test suite passed while both of these were live, because DesignMethodPanel's
// own unit tests take identityOpen/chipPersonalities as PROPS rather than
// exercising CloneDesignTab's real initial-state computation and its real
// "personalities + PRESETS share one lane" data flow. These tests mount the
// actual CloneDesignTab so both bugs would fail here.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CloneDesignTab from './CloneDesignTab';
import { useAppStore } from '../store';
import { CATEGORIES } from '../utils/constants';

vi.mock('../api/hooks', () => ({
  useEngines: () => ({ data: { tts: { backends: [] }, asr: { backends: [] } } }),
  useSelectEngine: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Real personality ids/names — matches the six clone.personality_* locale
// keys, so the component's real t() lookups render the exact chip labels
// the coordinator saw in the browser repro (Narrator, Casual, News Anchor,
// Storyteller, Corporate, Energetic).
const PERSONALITIES = [
  { id: 'narrator', name: 'Narrator', is_demo: false },
  { id: 'casual', name: 'Casual', is_demo: false },
  { id: 'news_anchor', name: 'News Anchor', is_demo: false },
  { id: 'storyteller', name: 'Storyteller', is_demo: false },
  { id: 'corporate', name: 'Corporate', is_demo: false },
  { id: 'energetic', name: 'Energetic', is_demo: false },
];

vi.mock('../api/client', () => ({
  API: '',
  apiFetch: vi.fn(() => Promise.resolve({ json: () => Promise.resolve(PERSONALITIES) })),
  apiPost: vi.fn(() => Promise.resolve({})),
}));

const NOOP = () => {};

function renderDesignTab() {
  // Default defineMethod is 'audio' — jump straight to the Design method so
  // DesignMethodPanel (not AudioMethodPanel) mounts.
  useAppStore.getState().setDefineMethod('design');
  const queryClient = new QueryClient();
  const vdStates = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 'Auto']));
  return render(
    <QueryClientProvider client={queryClient}>
      <CloneDesignTab
        textAreaRef={{ current: null }}
        text=""
        setText={NOOP}
        language="en"
        setLanguage={NOOP}
        steps={16}
        setSteps={NOOP}
        cfg={2}
        setCfg={NOOP}
        speed={1}
        setSpeed={NOOP}
        tShift={0}
        setTShift={NOOP}
        posTemp={0}
        setPosTemp={NOOP}
        classTemp={0}
        setClassTemp={NOOP}
        layerPenalty={0}
        setLayerPenalty={NOOP}
        duration=""
        setDuration={NOOP}
        denoise={false}
        setDenoise={NOOP}
        postprocess={false}
        setPostprocess={NOOP}
        showOverrides={false}
        setShowOverrides={NOOP}
        profiles={[]}
        selectedProfile=""
        setSelectedProfile={NOOP}
        refAudio={null}
        refText=""
        setRefText={NOOP}
        instruct=""
        setInstruct={NOOP}
        profileName=""
        setProfileName={NOOP}
        showSaveProfile={false}
        setShowSaveProfile={NOOP}
        isRecording={false}
        isCleaning={false}
        recordingTime={0}
        audioInputs={[]}
        selectedAudioInputId=""
        setSelectedAudioInputId={NOOP}
        channelMode="mono"
        setChannelMode={NOOP}
        inputLevelStore={undefined}
        vdStates={vdStates}
        setVdStates={NOOP}
        isGenerating={false}
        generationTime={0}
        applyPreset={NOOP}
        insertTag={NOOP}
        handleSaveProfile={NOOP}
        handleSaveDesignProfile={NOOP}
        handleGenerate={NOOP}
        startRecording={NOOP}
        stopRecording={NOOP}
        ingestRefAudio={NOOP}
      />
    </QueryClientProvider>,
  );
}

describe('CloneDesignTab — Voice Design panel redesign regressions', () => {
  it('starts the Details summary collapsed, not expanded', () => {
    renderDesignTab();
    const summary = screen.getByRole('button', { name: /details/i });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('design-details-fields')).toBeNull();
  });

  it('shows exactly 5 combined starting-point chips, with the overflow count covering BOTH personalities and PRESETS', async () => {
    renderDesignTab();
    await screen.findByText('Narrator');
    expect(screen.getByText('Casual')).toBeInTheDocument();
    expect(screen.getByText('News Anchor')).toBeInTheDocument();
    expect(screen.getByText('Storyteller')).toBeInTheDocument();
    expect(screen.getByText('Corporate')).toBeInTheDocument();

    // Hidden behind the toggle: the 6th personality (Energetic) + all 6
    // hardcoded PRESETS (12 total - 5 visible = 7).
    expect(screen.queryByText('Energetic')).toBeNull();
    expect(screen.queryByText(/Authoritative/)).toBeNull();
    const more = screen.getByText('7 more…');

    fireEvent.click(more);
    expect(screen.getByText('Energetic')).toBeInTheDocument();
    expect(screen.getByText(/Authoritative/)).toBeInTheDocument();
    expect(screen.queryByText(/more…/)).toBeNull();
  });
});
