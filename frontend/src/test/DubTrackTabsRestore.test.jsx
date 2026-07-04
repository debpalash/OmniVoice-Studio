import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { useAppStore } from '../store';

// Regression guard for the "completed dub tracks' tabs hidden until the
// language is re-selected" P0:
//  - `hasDubbedTrack` must key off the persisted tracks ONLY. The old
//    expression required `dubLangCode !== 'und'` and ended in a tautology
//    (`dubTracks?.length > 0 || !!dubTracks`), so a restored project with
//    finished tracks but a frozen language_code ('und') hid the track
//    switcher — and a job with NO tracks showed it.
//  - The done-state auto-jump must be membership-guarded: jumping the preview
//    to a dubLangCode that has no track (restores fall back to 'en' with
//    tracks ['bn']) pointed the player at /dub/preview-video?lang=en → 404.

// Heavy children are stubbed; DubLeftColumn is the probe — DubTab owns both
// `hasDubbedTrack` and the previewMode auto-jump, and hands them down as props.
const captured = vi.hoisted(() => ({ left: [] }));
vi.mock('../components/dub/DubLeftColumn', () => ({
  default: (props) => {
    captured.left.push(props);
    return <div data-testid="left-col" />;
  },
}));
vi.mock('../components/dub/DubHeader', () => ({ default: () => null }));
vi.mock('../components/dub/DubRightColumn', () => ({ default: () => null }));
vi.mock('../components/dub/DubFooter', () => ({ default: () => null }));
vi.mock('../components/dub/DubPipelineStepper', () => ({ default: () => null }));
vi.mock('../components/dub/IdleSkeleton', () => ({ default: () => null }));
vi.mock('../components/ExportModal', () => ({ default: () => null }));
vi.mock('../hooks/useTimelineOnsets', () => ({ default: () => ({ onsets: [] }) }));
vi.mock('../api/dub', () => ({ dubQc: vi.fn(), dubListTracks: vi.fn(() => new Promise(() => {})) }));
// Never-resolving async deps keep the render synchronous (no post-test act noise).
vi.mock('../api/engines', () => ({
  listTranslationEngines: vi.fn(() => new Promise(() => {})),
  installTranslationEngine: vi.fn(),
}));
vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, apiJson: vi.fn(() => new Promise(() => {})) };
});

import DubTab from '../pages/DubTab';

const noop = () => {};
function makeProps() {
  return {
    dubVideoFile: null,
    dubLocalBlobUrl: null,
    transcribeElapsed: 0,
    translateProvider: 'google',
    setTranslateProvider: noop,
    showTranscript: false,
    setShowTranscript: noop,
    onGlossaryChange: noop,
    profiles: [],
    segmentPreviewLoading: null,
    selectedSegIds: new Set(),
    setDubVideoFile: noop,
    setDubLocalBlobUrl: noop,
    handleDubAbort: noop,
    handleDubUpload: noop,
    handleDubIngestUrl: noop,
    handleDubRetryTranscribe: noop,
    handleDubStop: noop,
    handleDubGenerate: noop,
    handleDubImportSrt: noop,
    handleDubDownload: noop,
    handleDubAudioDownload: noop,
    handleAudioExport: noop,
    handleSegmentPreview: noop,
    onDirectSegment: noop,
    handleTranslateAll: noop,
    handleCleanupSegments: noop,
    incrementalPlan: null,
    triggerDownload: noop,
    fileToMediaUrl: noop,
    editSegments: noop,
    saveProject: noop,
    resetDub: noop,
    segmentEditField: noop,
    segmentDelete: noop,
    segmentRestoreOriginal: noop,
    segmentSplit: noop,
    segmentMerge: noop,
    segmentMoveResize: noop,
    timelineSelSegId: null,
    setTimelineSelSegId: noop,
    toggleSegSelect: noop,
    selectAllSegs: noop,
    clearSegSelection: noop,
    bulkApplyToSelected: noop,
    bulkDeleteSelected: noop,
  };
}

const baseState = useAppStore.getState();

function renderDone({ tracks, langCode, lang = 'Auto' }) {
  useAppStore.setState({
    dubJobId: 'job1',
    dubStep: 'done',
    dubTracks: tracks,
    dubLangCode: langCode,
    dubLang: lang,
  });
  render(<DubTab {...makeProps()} />);
  return captured.left.at(-1);
}

describe('DubTab — completed tracks always show their tabs (restore P0)', () => {
  beforeEach(() => {
    useAppStore.setState(baseState, true);
    captured.left.length = 0;
  });

  it("restored project (tracks ['bn'], language_code frozen at 'und'): switcher shows and preview jumps to the track", () => {
    const left = renderDone({ tracks: ['bn'], langCode: 'und' });
    // Pre-fix: `dubLangCode !== 'und'` hid the finished tracks' tabs.
    expect(left.hasDubbedTrack).toBe(true);
    // Auto-jump falls back to the only real track — never a lang without one.
    expect(left.previewMode).toBe('bn');
  });

  it("membership guard: dubLangCode 'en' with tracks ['bn'] previews tracks[0], not the 404 lang", () => {
    const left = renderDone({ tracks: ['bn'], langCode: 'en', lang: 'English' });
    expect(left.hasDubbedTrack).toBe(true);
    // Pre-fix the auto-jump previewed 'en' → /dub/preview-video?lang=en → 404.
    expect(left.previewMode).toBe('bn');
  });

  it('dubLangCode that has a track previews that track (fresh-generate path unchanged)', () => {
    const left = renderDone({ tracks: ['bn', 'es'], langCode: 'es', lang: 'Spanish' });
    expect(left.hasDubbedTrack).toBe(true);
    expect(left.previewMode).toBe('es');
  });

  it('done with NO persisted tracks hides the switcher and stays on Original (tautology guard)', () => {
    const left = renderDone({ tracks: [], langCode: 'es', lang: 'Spanish' });
    // Pre-fix `(dubTracks?.length > 0 || !!dubTracks)` was always true, so the
    // switcher appeared trackless and the auto-jump 404'd the preview.
    expect(left.hasDubbedTrack).toBe(false);
    expect(left.previewMode).toBe('original');
  });
});
