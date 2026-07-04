import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store';

// P1.1 — the multi-language generate loop must TRANSLATE each pick before it
// generates it. Pre-fix the loop only called handleDubGenerate per language,
// so "Generate 3 dubs" synthesized the same (untranslated) text three times —
// at most one track was actually in its language.
//
// Contract under test (call order, per pick):
//   translate(code) → generate({ langOverride: { language, language_code } })
// and on a failed translate: skip that pick's generate, keep going, report
// the skipped languages in a final toast.

const captured = vi.hoisted(() => ({ header: [] }));
vi.mock('../components/dub/DubHeader', () => ({
  default: (props) => {
    captured.header.push(props);
    return null;
  },
}));
vi.mock('../components/dub/DubLeftColumn', () => ({ default: () => null }));
vi.mock('../components/dub/DubRightColumn', () => ({ default: () => null }));
vi.mock('../components/dub/DubFooter', () => ({ default: () => null }));
vi.mock('../components/dub/DubPipelineStepper', () => ({ default: () => null }));
vi.mock('../components/dub/IdleSkeleton', () => ({ default: () => null }));
vi.mock('../components/ExportModal', () => ({ default: () => null }));
vi.mock('../hooks/useTimelineOnsets', () => ({ default: () => ({ onsets: [] }) }));
vi.mock('../api/dub', () => ({ dubQc: vi.fn() }));
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
function makeProps(over = {}) {
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
    ...over,
  };
}

const baseState = useAppStore.getState();
const PICKS = [
  { lang: 'Bengali', code: 'bn' },
  { lang: 'Spanish', code: 'es' },
];

/** Render DubTab in multi-lang mode and return { onGenerateClick, calls, mocks }. */
function setup({ translateOk = () => true, langCode = 'en', segments } = {}) {
  const calls = [];
  const handleTranslateAll = vi.fn(async (code) => {
    calls.push(`translate:${code}`);
    return translateOk(code);
  });
  const handleDubGenerate = vi.fn(async (opts) => {
    calls.push(`generate:${opts?.langOverride?.language_code ?? 'default'}`);
  });
  useAppStore.setState({
    dubJobId: 'job1',
    dubStep: 'editing',
    dubLangCode: langCode,
    dubLang: 'English',
    multiLangMode: true,
    multiLangs: PICKS,
    dubSegments: segments ?? [{ id: '1', text: 'hello', text_original: 'hello' }],
  });
  render(<DubTab {...makeProps({ handleTranslateAll, handleDubGenerate })} />);
  return {
    onGenerateClick: captured.header.at(-1).onGenerateClick,
    calls,
    handleTranslateAll,
    handleDubGenerate,
  };
}

describe('DubTab — multi-language generate translates each language first (P1.1)', () => {
  beforeEach(() => {
    useAppStore.setState(baseState, true);
    captured.header.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks ['bn','es']: each language's translate runs BEFORE its generate, in order", async () => {
    const { onGenerateClick, calls, handleDubGenerate } = setup();
    await act(async () => {
      await onGenerateClick();
    });
    // Pre-fix this was ['generate:bn', 'generate:es'] — translate never ran.
    expect(calls).toEqual(['translate:bn', 'generate:bn', 'translate:es', 'generate:es']);
    // langOverride keeps the existing handleDubGenerate call shape.
    expect(handleDubGenerate).toHaveBeenNthCalledWith(1, {
      langOverride: { language: 'Bengali', language_code: 'bn' },
    });
    expect(handleDubGenerate).toHaveBeenNthCalledWith(2, {
      langOverride: { language: 'Spanish', language_code: 'es' },
    });
  });

  it('a failed translate skips ONLY that language’s generate, continues, and reports it', async () => {
    const errorSpy = vi.spyOn(toast, 'error');
    const { onGenerateClick, calls } = setup({ translateOk: (code) => code !== 'bn' });
    await act(async () => {
      await onGenerateClick();
    });
    expect(calls).toEqual(['translate:bn', 'translate:es', 'generate:es']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('Bengali');
  });

  it('skips the redundant translate only when the FIRST pick already matches freshly-translated editor text', async () => {
    const { onGenerateClick, calls } = setup({
      langCode: 'bn',
      // text differs from text_original on every segment = a translation into
      // dubLangCode ('bn') is already applied — pick 1 can go straight to generate.
      segments: [{ id: '1', text: 'ওহে', text_original: 'hello' }],
    });
    await act(async () => {
      await onGenerateClick();
    });
    expect(calls).toEqual(['generate:bn', 'translate:es', 'generate:es']);
  });

  it('untranslated editor text is ALWAYS translated, even when the first pick matches dubLangCode', async () => {
    const { onGenerateClick, calls } = setup({
      langCode: 'bn',
      segments: [{ id: '1', text: 'hello', text_original: 'hello' }],
    });
    await act(async () => {
      await onGenerateClick();
    });
    expect(calls).toEqual(['translate:bn', 'generate:bn', 'translate:es', 'generate:es']);
  });

  it('single-language mode is untouched: generate only, no translate, no override', async () => {
    const { onGenerateClick, calls, handleDubGenerate, handleTranslateAll } = setup();
    act(() => {
      useAppStore.setState({ multiLangMode: false });
    });
    void onGenerateClick; // stale capture — re-read after the mode flip
    const fresh = captured.header.at(-1).onGenerateClick;
    await act(async () => {
      await fresh();
    });
    expect(handleTranslateAll).not.toHaveBeenCalled();
    expect(handleDubGenerate).toHaveBeenCalledWith();
    expect(calls).toEqual(['generate:default']);
  });
});
